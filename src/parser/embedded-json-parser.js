/**
 * Разбор данных заданий, встроенных в HTML страницы списка.
 *
 * Наблюдаемая (живая) структура: в inline-скрипте страницы /projects лежит объект
 * с массивом `wants`, по одному элементу на задание:
 *
 *   { id, name, description, priceLimit, possiblePriceLimit, isHigherPrice,
 *     max_days, category_id, categoryLinksIdRu, status, lang,
 *     date_create, date_active, date_expire, wantUserGetProfileUrl, user: { USERID, username } }
 *
 * Значения берутся как есть: отсутствующее поле остаётся null и попадает в
 * missingFields. Ничего не додумывается, кроме явно помеченных производных
 * значений (год у даты без года, признак «цена от»).
 */

import { cleanText, matchTargetCategory } from './normalize.js';
import { zoneOffsetMinutes } from '../util/time.js';

/** Извлечение объекта с массивом wants из строки с балансировкой скобок и строк. */
export function extractEmbeddedWantsPayload(html) {
  const source = String(html ?? '');
  const results = [];
  const marker = /"wants"\s*:\s*\[/g;
  let match;
  while ((match = marker.exec(source)) !== null) {
    const arrayStart = source.indexOf('[', match.index);
    const slice = sliceBalanced(source, arrayStart);
    if (!slice) continue;
    try {
      const items = JSON.parse(slice);
      if (Array.isArray(items)) results.push({ items, strategy: 'embedded-json:wants', offset: match.index });
    } catch {
      // Нечитаемый фрагмент: пробуем следующий маркер, ничего не выдумываем.
    }
  }
  if (results.length === 0) return { items: [], strategy: null, candidates: 0 };
  // Выбираем самый крупный массив: обычно это полный список заданий страницы.
  results.sort((a, b) => b.items.length - a.items.length);
  return { items: results[0].items, strategy: results[0].strategy, candidates: results.length, offset: results[0].offset };
}

/**
 * Метаданные постраничной выдачи: {"current_page":1,"last_page":2,"total":17,"per_page":12}.
 * Нужны, чтобы понимать, сколько всего заданий в категории и есть ли следующая страница.
 */
export function extractEmbeddedPagination(html) {
  const source = String(html ?? '');
  const marker = /"pagination"\s*:\s*\{/g;
  let match;
  while ((match = marker.exec(source)) !== null) {
    const slice = sliceBalanced(source, source.indexOf('{', match.index));
    if (!slice) continue;
    try {
      const parsed = JSON.parse(slice);
      return {
        currentPage: Number(parsed.current_page) || null,
        lastPage: Number(parsed.last_page) || null,
        total: Number(parsed.total) || null,
        perPage: Number(parsed.per_page) || null,
        nextPageUrl: parsed.next_page_url ?? null
      };
    } catch {
      // Нечитаемый блок: пробуем следующий маркер, ничего не выдумываем.
    }
  }
  return null;
}

/** Вырезает сбалансированный JSON-массив/объект начиная с позиции start. */
export function sliceBalanced(text, start) {
  if (start < 0 || start >= text.length) return null;
  const open = text[start];
  if (open !== '[' && open !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Число из строки или числа; null, если значения нет. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseFloat(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Дата вида "2026-10-07 17:05:42" в часовом поясе сайта.
 * Возвращает { text, iso, origin, confidence, timezone } или null.
 */
export function parseEmbeddedDate(value, { timezone = 'Europe/Moscow' } = {}) {
  const text = cleanText(value);
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) {
    // Незнакомый формат: сохраняем текст, точное время не выдумываем.
    return { text, iso: null, origin: 'fact:text', confidence: 'unknown', timezone };
  }
  const [, y, m, d, hh, mm, ss = '00'] = match;
  const wallGuess = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)));
  const offset = zoneOffsetMinutes(wallGuess, timezone);
  const utcMs = wallGuess.getTime() - offset * 60000;
  return {
    text,
    iso: new Date(utcMs).toISOString(),
    origin: 'fact:embedded-datetime',
    confidence: 'exact',
    timezone
  };
}

/** Бюджет из полей priceLimit / possiblePriceLimit / isHigherPrice. */
export function buildEmbeddedBudget(item) {
  const priceLimit = toNumber(item?.priceLimit);
  const possiblePriceLimit = toNumber(item?.possiblePriceLimit);
  const isHigherPrice = item?.isHigherPrice === true;
  if (priceLimit === null && possiblePriceLimit === null) return null;

  const isFrom = isHigherPrice || (priceLimit !== null && possiblePriceLimit !== null && possiblePriceLimit > priceLimit);
  const max = isFrom ? possiblePriceLimit ?? priceLimit : priceLimit ?? possiblePriceLimit;
  const rawLimit = cleanText(item?.priceLimit);
  return {
    min: priceLimit,
    max,
    currency: 'RUB',
    text: rawLimit ? `${rawLimit.replace(/\.00$/, '')} ₽${isFrom ? ' (возможна цена выше)' : ''}` : null,
    isRange: false,
    isFrom,
    sourceField: 'priceLimit'
  };
}

/** Идентификаторы «линейки» категорий из элемента (categoryLinksIdRu может быть массивом). */
export function categoryLinkIdsOf(item) {
  const raw = item?.categoryLinksIdRu;
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  // Важно: Number(null) === 0, поэтому отбрасываем пустые значения до приведения.
  return list
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
}

/** Категория задания: сначала по category_id, затем по отображению categoryLinksIdRu. */
export function matchEmbeddedCategory(item, targetCategories = [], mapping = {}) {
  const kworkCategoryId = item?.category_id === undefined || item?.category_id === null ? null : Number(item.category_id);
  if (Number.isFinite(kworkCategoryId)) {
    const declared = targetCategories.find((category) => Number(category.kworkCategoryId) === kworkCategoryId);
    if (declared) {
      return {
        id: declared.id,
        label: declared.label,
        matchedBy: 'kwork-category-id',
        confidence: 'high',
        declared: declared.label
      };
    }
  }
  for (const linkId of categoryLinkIdsOf(item)) {
    const mapped = mapping[String(linkId)];
    if (!mapped) continue;
    const declared = targetCategories.find((category) => category.id === mapped);
    if (declared) {
      return {
        id: declared.id,
        label: declared.label,
        matchedBy: `category-link-id:${linkId}`,
        confidence: 'high',
        declared: declared.label
      };
    }
  }
  return null;
}

/** Нормализация одного элемента wants в задание. */
export function jobFromWant(item, context) {
  const {
    sourceUrl,
    targetCategories = [],
    categoryMapping = {},
    referenceDate = new Date(),
    timezone = 'Europe/Moscow',
    strategyId = 'embedded-json:wants'
  } = context;

  const warnings = [];
  const id = item?.id === undefined || item?.id === null ? null : String(item.id);
  if (!id) warnings.push('В элементе хоста нет идентификатора задания.');

  const title = cleanText(item?.name);
  const description = cleanText(item?.description);
  // Ссылка собирается из идентификатора (страница задания не запрашивается).
  const url = id ? `https://kwork.ru/projects/${id}` : null;

  const budget = buildEmbeddedBudget(item);
  const publishedAt = parseEmbeddedDate(item?.date_create, { timezone });
  if (!publishedAt) warnings.push('Поле date_create отсутствует или пустое.');

  const category = matchEmbeddedCategory(item, targetCategories, categoryMapping);
  const cardText = [title, description].filter(Boolean).join(' ');
  // Числовой id Kwork — первоисточник. Если он есть, но не сопоставлен, значит
  // задание лежит ВНЕ выбранных категорий: текстовые подсказки в этом случае не
  // применяются, иначе карточка «Дизайн в Figma» попадала бы в «Вёрстку».
  const hasKworkCategoryId = item?.category_id !== undefined && item?.category_id !== null;
  const categoryByText = hasKworkCategoryId
    ? category
    : matchTargetCategory(cardText, targetCategories, null);
  const categorySource = category ? 'kwork-id' : categoryByText ? 'text-hint' : null;

  const clientName = cleanText(item?.user?.username);
  const clientProfileUrl = cleanText(item?.wantUserGetProfileUrl);
  const client = clientName || clientProfileUrl ? { name: clientName, meta: clientProfileUrl } : null;

  const missingFields = [];
  if (!title) missingFields.push('title');
  if (!description) missingFields.push('description');
  if (!budget) missingFields.push('budget');
  if (!publishedAt) missingFields.push('publishedAt');
  if (!category) missingFields.push('declaredCategory');
  if (!clientName) missingFields.push('clientName');

  return {
    id,
    url,
    title,
    description,
    descriptionSource: description ? 'embedded-json' : 'absent-in-list',
    budget,
    publishedAt,
    category: categoryByText
      ? {
          id: categoryByText.id,
          label: categoryByText.label,
          matchedBy: categoryByText.matchedBy,
          confidence: categoryByText.confidence,
          declared: categoryByText.declared ?? null,
          source: categorySource
        }
      : null,
    declaredCategory: category ? category.label : null,
    kworkCategoryId: item?.category_id === undefined || item?.category_id === null ? null : Number(item.category_id),
    categoryLinkIds: categoryLinkIdsOf(item),
    client,
    extra: {
      status: cleanText(item?.status),
      maxDays: toNumber(item?.max_days),
      kworkCount: toNumber(item?.kwork_count),
      views: toNumber(item?.views_dirty),
      offersCount: toNumber(item?.getWantsActiveCount),
      timeLeft: cleanText(item?.timeLeft),
      dateExpire: parseEmbeddedDate(item?.date_expire, { timezone })
    },
    offersCount: toNumber(item?.getWantsActiveCount),
    cardText,
    dedupKey: id ? `id:${id}` : `composite:${Buffer.from(cardText).toString('base64url').slice(0, 24)}`,
    dedupKind: id ? 'stable-id' : 'composite-fallback',
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

/** Полный разбор встроенного JSON страницы. */
export function parseEmbeddedJobs(html, context = {}) {
  const payload = extractEmbeddedWantsPayload(html);
  const warnings = [];
  if (payload.items.length === 0) {
    return { jobs: [], strategy: null, warnings: ['Встроенный JSON с массивом wants не найден.'] };
  }
  const items = payload.items;
  const jobs = items.map((item) => jobFromWant(item, { ...context, strategyId: payload.strategy }));
  if (payload.candidates > 1) {
    warnings.push(`Найдено несколько массивов wants (${payload.candidates}); использован самый крупный.`);
  }
  return {
    jobs,
    strategy: payload.strategy,
    warnings,
    count: payload.items.length,
    filteredOut: payload.items.length - items.length
  };
}
