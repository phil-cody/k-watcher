/**
 * Парсер страницы списка заданий Kwork.
 *
 * Работает только на переданном HTML (в тестах — сохранённые fixtures), не
 * ходит в сеть. Не додумывает отсутствующие поля: каждое поле либо нормализовано,
 * либо null + запись в missingFields. Никакой HTML не сохраняется вызывающим кодом.
 */

import { parseHtml, findAll, findElement, hasClass, textOf, classesOf, documentTitle, normalizeWhitespace } from '../util/html.js';
import { detectDomStructure, detectPageAnomaliesDetailed, extractJsonLd, jobsFromJsonLd } from './structure-detector.js';
import { parseEmbeddedJobs, extractEmbeddedPagination } from './embedded-json-parser.js';
import { createTexts } from '../texts/texts.js';
import {
  absolutizeUrl,
  buildBudget,
  buildPublishedAt,
  cleanText,
  extractJobId,
  isProjectLink,
  matchTargetCategory
} from './normalize.js';
import { createHash } from 'node:crypto';

const FIELD_KEY_HINTS = [
  // Порядок важен: бюджет проверяется до заголовка, иначе data-budget-text
  // классифицировался бы как заголовок по общему шаблону /^text$|name$/.
  { key: 'budgetText', patterns: [/^budget[-_]?text$/, /^price[-_]?text$/] },
  { key: 'budget', patterns: [/^budget/, /^price/, /^cost/, /salary/, /money/] },
  { key: 'priceRange', patterns: [/price[-_]?range/, /budget[-_]?range/] },
  { key: 'priceFrom', patterns: [/price[-_]?from/, /from[-_]?price/] },
  { key: 'category', patterns: [/categor/, /rubric/, /section/, /специализ/] },
  { key: 'title', patterns: [/^title$/, /want[-_]?title/, /project[-_]?title/, /card[-_]?title/, /__title$/, /^heading$/, /^head$/, /^name$/] },
  { key: 'description', patterns: [/description/, /^desc$/, /^text$/, /__body$/, /[-_]body$/, /^body$/, /preview/, /excerpt/, /annotation/] },
  { key: 'publishedAt', patterns: [/date/, /time/, /created/, /published/, /posted/, /^created[-_]?at$/] },
  { key: 'clientName', patterns: [/client/, /customer/, /user[-_]?name/, /author/, /employer/] },
  { key: 'clientMeta', patterns: [/client[-_]?(info|meta|stat)/, /rating/, /reviews/] },
  { key: 'offers', patterns: [/offers?/, /kwork/, /responses/, /bids/, /предложен/] }
];

function classifyKey(key) {
  const lower = String(key).toLowerCase();
  for (const hint of FIELD_KEY_HINTS) {
    if (hint.patterns.some((pattern) => pattern.test(lower))) return hint.key;
  }
  return null;
}

function isFieldContainer(node) {
  if (!['div', 'span', 'p', 'section', 'article', 'header', 'footer', 'a', 'strong', 'b', 'h1', 'h2', 'h3', 'time', 'li', 'ul'].includes(node.tag)) {
    return false;
  }
  let textLength = 0;
  let elementChildren = 0;
  for (const child of node.children ?? []) {
    if (child.type === 'text') textLength += child.text.length;
    else elementChildren += 1;
  }
  if (textLength === 0) return false;
  if (elementChildren > 3) return false;
  const own = normalizeWhitespace(textOf(node));
  if (own.length === 0) return false;
  return true;
}

function collectFields(card) {
  const fields = new Map();
  const push = (key, value) => {
    const clean = cleanText(value);
    if (!clean) return;
    if (!fields.has(key)) fields.set(key, []);
    fields.get(key).push(clean);
  };

  const visit = (node) => {
    if (!node) return;
    for (const [attr, value] of Object.entries(node.attrs ?? {})) {
      const name = attr.replace(/^data-/, '');
      // Ссылки и служебные атрибуты не являются полями-значениями карточки.
      if (/^(link|url|href|id|project[-_]?link)$/i.test(name)) continue;
      const key = classifyKey(name);
      if (key) push(key, value);
    }
    if (isFieldContainer(node)) {
      for (const name of classesOf(node)) {
        const key = classifyKey(name.replace(/^js-/, ''));
        if (key) push(key, textOf(node));
      }
    }
    if (node.tag === 'meta') {
      const key = classifyKey(node.attrs?.name ?? node.attrs?.property ?? '');
      if (key) push(key, node.attrs?.content);
    }
    for (const child of node.children ?? []) {
      if (child.type === 'element') visit(child);
    }
  };
  visit(card);
  return fields;
}

function pickField(fields, key) {
  const values = fields.get(key);
  if (!values || values.length === 0) return null;
  // Для описания выбираем самое длинное значение, для остальных — первое.
  if (key === 'description') return values.slice().sort((a, b) => b.length - a.length)[0];
  return values[0];
}

function findTimeNode(card) {
  const time = findElement(card, (node) => node.tag === 'time');
  if (!time) return { datetimeAttr: null, text: null };
  return { datetimeAttr: time.attrs?.datetime ?? null, text: textOf(time) };
}

function findPublishedTextFallback(card, fields) {
  const fromFields = pickField(fields, 'publishedAt');
  if (fromFields) return fromFields;
  const relative = findElement(card, (node) => {
    if (!isFieldContainer(node)) return false;
    const text = textOf(node);
    return /(назад|сегодня|вчера|только что|ago)/i.test(text);
  });
  return relative ? textOf(relative) : null;
}

/** Ключ дедупликации: стабильный id, иначе осторожный составной ключ. */
let defaultParserTexts = null;
function parserTexts(textsInput) {
  if (textsInput) return textsInput;
  if (!defaultParserTexts) defaultParserTexts = createTexts({ rootDir: process.cwd() });
  return defaultParserTexts;
}

export function buildDedupKey({ id, url, title, budgetText }) {
  if (id) return { key: `id:${id}`, kind: 'stable-id' };
  if (url) return { key: `url:${url.split('?')[0]}`, kind: 'url' };
  const basis = [title ?? '', budgetText ?? ''].join('|').toLowerCase();
  const hash = createHash('sha1').update(basis).digest('hex').slice(0, 16);
  return { key: `composite:${hash}`, kind: 'composite-fallback' };
}

/** Извлечение одной карточки в нормализованное задание. */
export function extractJobFromCard(card, context) {
  const {
    sourceUrl,
    targetCategories = [],
    referenceDate = new Date(),
    strategyId = null,
    urlBase = sourceUrl,
    texts: textsInput = null
  } = context;
  const textsObject = parserTexts(textsInput);
  const t = (path, params) => textsObject.t(path, params);
  const warnings = [];
  const fields = collectFields(card);

  // Ссылка на задание
  const anchors = findAll(card, isProjectLink);
  let jobUrl = null;
  if (anchors.length > 0) {
    anchors.sort((a, b) => textOf(b).length - textOf(a).length);
    jobUrl = absolutizeUrl(anchors[0].attrs?.href, urlBase);
  }
  if (anchors.length > 1) warnings.push(t('parser.multipleLinks', { count: anchors.length }));

  const idFromUrl = extractJobId(jobUrl);
  const idFromAttr =
    cleanText(card.attrs?.['data-want-id']) ??
    cleanText(card.attrs?.['data-project-id']) ??
    cleanText(card.attrs?.['data-job-id']) ??
    cleanText(card.attrs?.id)?.replace(/[^\d]/g, '') ??
    null;
  const id = idFromUrl ?? (idFromAttr && /^\d+$/.test(idFromAttr) ? idFromAttr : null);
  if (!id && idFromAttr) warnings.push(t('parser.nonNumericId', { value: idFromAttr }));

  // Заголовок
  let title = pickField(fields, 'title');
  if (!title && anchors.length > 0) {
    const anchorText = textOf(anchors[0]);
    if (anchorText.length >= 10) title = anchorText;
  }
  if (!title) {
    const heading = findElement(card, (node) => ['h1', 'h2', 'h3', 'h4'].includes(node.tag) && textOf(node).length >= 10);
    if (heading) title = textOf(heading);
  }
  if (!title) warnings.push(t('parser.noTitle'));

  let description = pickField(fields, 'description');
  if (description && title && description === title) description = null;

  // Бюджет: сначала текстовая цена из разметки (в ней есть валюта и формулировка
  // «от … до …»), и только если текста нет — числовой data-атрибут без валюты.
  const budgetRaw = {
    budgetText: pickField(fields, 'budgetText'),
    fixedText: pickField(fields, 'budget'),
    rangeText: pickField(fields, 'priceRange'),
    fromText: pickField(fields, 'priceFrom')
  };
  let budget = buildBudget(budgetRaw);
  const priceTexts = findAll(card, (node) => {
    const text = textOf(node);
    return /₽|руб/i.test(text) && /\d/.test(text) && !/отзыв|рейтинг|оценк/i.test(text);
  })
    .map((node) => textOf(node))
    .filter((text) => text.length <= 60)
    .sort((a, b) => a.length - b.length);
  if (priceTexts.length > 0) {
    const textBudget = buildBudget({ fixedText: priceTexts[0] });
    const attributeOnly = budget && !/₽|руб|₴|грн|\$|usd/i.test(budget.rawText ?? '');
    if (textBudget && attributeOnly) budget = textBudget;
    else if (!budget) budget = textBudget;
  }

  const timeNode = findTimeNode(card);
  const publishedAt = buildPublishedAt({
    datetimeAttr: timeNode.datetimeAttr,
    text: timeNode.text ?? findPublishedTextFallback(card, fields),
    referenceDate
  });

  const cardText = textOf(card);
  const declaredCategory = pickField(fields, 'category');
  const category = matchTargetCategory(cardText, targetCategories, declaredCategory);

  const clientName = pickField(fields, 'clientName');
  const clientMeta = pickField(fields, 'clientMeta');
  const offersText = pickField(fields, 'offers');
  const offersMatch = offersText ? /(\d+)/.exec(offersText) : null;

  const missingFields = [];
  if (!jobUrl) missingFields.push('url');
  if (!title) missingFields.push('title');
  if (!description) missingFields.push('description');
  if (!budget) missingFields.push('budget');
  if (!publishedAt?.text) missingFields.push('publishedAt');
  if (!declaredCategory) missingFields.push('declaredCategory');
  if (!clientName) missingFields.push('clientName');

  const dedup = buildDedupKey({ id, url: jobUrl, title, budgetText: budget?.rawText ?? null });

  return {
    id,
    url: jobUrl,
    title,
    description,
    descriptionSource: description ? 'card-list' : 'absent-in-list',
    budget: budget
      ? {
          min: budget.min,
          max: budget.max,
          currency: budget.currency,
          text: budget.text,
          isRange: budget.isRange,
          isFrom: budget.isFrom
        }
      : null,
    publishedAt: publishedAt
      ? { text: publishedAt.text, iso: publishedAt.iso, origin: publishedAt.origin, confidence: publishedAt.confidence }
      : null,
    category: category ? { id: category.id, label: category.label, matchedBy: category.matchedBy, confidence: category.confidence, declared: declaredCategory } : null,
    declaredCategory,
    client: clientName || clientMeta ? { name: clientName, meta: clientMeta } : null,
    offersCount: offersMatch ? Number(offersMatch[1]) : null,
    cardText,
    dedupKey: dedup.key,
    dedupKind: dedup.kind,
    missingFields,
    warnings,
    provenance: {
      sourceUrl,
      strategy: strategyId,
      extractedAt: referenceDate.toISOString(),
      rawHtmlStored: false
    }
  };
}

/** Приведение JSON-LD записи к тому же виду, что и DOM-карточка. */
export function extractJobFromJsonLd(entry, context) {
  const { sourceUrl, targetCategories = [], referenceDate = new Date(), texts: textsInput = null } = context;
  const textsObject = parserTexts(textsInput);
  const t = (path, params) => textsObject.t(path, params);
  const warnings = [];
  const url = entry.url ? absolutizeUrl(entry.url, sourceUrl) : null;
  const id = extractJobId(url);
  const title = cleanText(entry.title);
  const description = cleanText(entry.description);
  const budget = buildBudget({ fixedText: entry.budget });
  const publishedAt = buildPublishedAt({ datetimeAttr: entry.datePosted, text: entry.datePosted, referenceDate });
  const declaredCategory = cleanText(entry.category) ?? cleanText(entry.categoryText);
  const cardText = [title, description, declaredCategory].filter(Boolean).join(' ');
  const category = matchTargetCategory(cardText, targetCategories, declaredCategory);
  const clientName = cleanText(entry.clientName);
  const missingFields = [];
  if (!url) missingFields.push('url');
  if (!title) missingFields.push('title');
  if (!description) missingFields.push('description');
  if (!budget) missingFields.push('budget');
  if (!publishedAt?.text) missingFields.push('publishedAt');
  if (!declaredCategory) missingFields.push('declaredCategory');
  if (!clientName) missingFields.push('clientName');
  const dedup = buildDedupKey({ id, url, title, budgetText: budget?.rawText ?? null });

  return {
    id,
    url,
    title,
    description,
    descriptionSource: description ? 'json-ld' : 'absent-in-list',
    budget: budget
      ? { min: budget.min, max: budget.max, currency: budget.currency, text: budget.text, isRange: budget.isRange, isFrom: budget.isFrom }
      : null,
    publishedAt: publishedAt
      ? { text: publishedAt.text, iso: publishedAt.iso, origin: publishedAt.origin, confidence: publishedAt.confidence }
      : null,
    category: category ? { id: category.id, label: category.label, matchedBy: category.matchedBy, confidence: category.confidence, declared: declaredCategory } : null,
    declaredCategory,
    client: clientName ? { name: clientName, meta: null } : null,
    offersCount: null,
    cardText,
    dedupKey: dedup.key,
    dedupKind: dedup.kind,
    missingFields,
    warnings,
    provenance: {
      sourceUrl,
      strategy: 'json-ld',
      extractedAt: referenceDate.toISOString(),
      rawHtmlStored: false
    }
  };
}

/**
 * Разбор HTML страницы списка.
 *
 * Порядок стратегий по надёжности:
 *  1) встроенный JSON страницы (наблюдаемая структура Kwork: массив `wants`);
 *  2) JSON-LD;
 *  3) разметка DOM (data-* атрибуты, классы, ссылки) как запасной вариант.
 *
 * @returns {{jobs: object[], structure: object, anomalies: string[], softAnomalies: object[], warnings: string[], title: string|null}}
 */
export function parseListingHtml(
  html,
  {
    sourceUrl,
    targetCategories = [],
    categoryMapping = {},
    timezone = 'Europe/Moscow',
    referenceDate = new Date(),
    texts: textsInput = null
  } = {}
) {
  const textsObject = parserTexts(textsInput);
  const t = (path, params) => textsObject.t(path, params);
  const warnings = [];
  // Жёсткие признаки (показанная проверка, блокировка) отделены от безобидных
  // упоминаний слова «captcha» в скриптах: вторые не должны блокировать разбор.
  const anomalyReport = detectPageAnomaliesDetailed(html);
  const anomalies = anomalyReport.hard.map((entry) => entry.kind);
  const softAnomalies = anomalyReport.soft;

  const embedded = parseEmbeddedJobs(html, {
    sourceUrl,
    targetCategories,
    categoryMapping,
    timezone,
    referenceDate
  });
  warnings.push(...embedded.warnings);

  const doc = parseHtml(html);
  const structure = detectDomStructure(doc);
  // Метаданные выдачи: сколько всего заданий в категории и сколько страниц.
  const pageInfo = extractEmbeddedPagination(html);

  const jobs = [];
  let strategy = null;
  let description = null;

  if (embedded.jobs.length > 0) {
    strategy = embedded.strategy;
    description = t('parser.strategyEmbedded');
    jobs.push(...embedded.jobs);
    if (embedded.filteredOut > 0) {
      warnings.push(t('parser.embeddedFiltered', { count: embedded.filteredOut }));
    }
    if (structure.strategy) {
      warnings.push(t('parser.embeddedWon', { count: embedded.jobs.length, strategy: structure.strategy }));
    }
  } else {
    const blocks = extractJsonLd(html);
    const jsonLd = jobsFromJsonLd(blocks, sourceUrl);
    warnings.push(...jsonLd.warnings);

    if (jsonLd.jobs.length > 0) {
      strategy = 'json-ld';
      description = t('parser.strategyJsonLd');
      for (const entry of jsonLd.jobs) {
        jobs.push(extractJobFromJsonLd(entry, { sourceUrl, targetCategories, referenceDate, texts: textsObject }));
      }
      if (structure.strategy) {
        warnings.push(t('parser.jsonLdWon', { count: jsonLd.jobs.length, strategy: structure.strategy }));
      }
    } else if (structure.strategy) {
      strategy = structure.strategy;
      description = structure.description;
      structure.nodes.forEach((node, index) => {
        const nodeStrategy = structure.nodeStrategies?.[index] ?? structure.strategy;
        jobs.push(
          extractJobFromCard(node, { sourceUrl, targetCategories, referenceDate, strategyId: nodeStrategy, texts: textsObject })
        );
      });
    } else {
      warnings.push(t('parser.noStrategies'));
    }
  }

  return {
    jobs,
    pageInfo,
    structure: {
      strategy,
      matchedBy: strategy,
      pageInfo,
      matchedStrategies: structure.matchedStrategies ?? [],
      containerCount: jobs.length,
      description,
      pageTitle: documentTitle(html) || null
    },
    anomalies,
    softAnomalies,
    anomalyMarkers: anomalyReport.markers,
    warnings,
    title: documentTitle(html) || null
  };
}

/** Парсер как объект — удобно подменять в тестах и держать единый интерфейс. */
export class KworkListingParser {
  constructor({ targetCategories = [], categoryMapping = {}, timezone = 'Europe/Moscow', logger = null, texts = null } = {}) {
    this.targetCategories = targetCategories;
    this.categoryMapping = categoryMapping;
    this.timezone = timezone;
    this.logger = logger;
    this.texts = texts;
  }

  parse(html, { sourceUrl, referenceDate = new Date() } = {}) {
    return parseListingHtml(html, {
      sourceUrl,
      targetCategories: this.targetCategories,
      categoryMapping: this.categoryMapping,
      timezone: this.timezone,
      referenceDate,
      texts: this.texts
    });
  }
}
