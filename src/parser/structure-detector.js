/**
 * Определение структуры страницы списка заданий.
 *
 * Стратегии применяются по убыванию надёжности:
 *  1) JSON-LD (машиночитаемые данные, если сайт их отдаёт);
 *  2) явные data-* атрибуты карточки;
 *  3) классы вида *want-card*;
 *  4) ссылки на задания /projects/<id>/<slug> как последний «след».
 *
 * Если ни одна стратегия не сработала — это не повод выдумывать данные:
 * парсер сообщает structureError, а планировщик безопасно останавливается.
 */

import { findAll, classesOf, textOf } from '../util/html.js';
import { isProjectLink } from './normalize.js';

const TITLE_CLASS = /want[-_]?title|project[-_]?title|card[-_]?title|__title$|(^|[-_])title([-_]|$)/i;
const DESCRIPTION_CLASS = /want[-_]?description|project[-_]?description|card[-_]?description|(^|[-_])desc(ription)?([-_]|$)/i;

function hasClassMatching(node, pattern) {
  return classesOf(node).some((name) => pattern.test(name));
}

const DETAIL_CLASS = /want[-_]?description|project[-_]?description|card[-_]?description|__body$|[-_]body$|(^|[-_])desc(ription)?([-_]|$)|price|budget|cost|salary|date|time|created|published|categor/i;
const OWN_BUDGET_ATTRS = ['data-budget', 'data-budget-text', 'data-price', 'data-price-text'];

/**
 * Признак «это действительно карточка задания», а не обёртка вокруг неё.
 *
 * Требуется форма карточки: заголовок (класс *title*, <h1>-<h4> или текст
 * единственной ссылки на задание) и дополнительный признак — описание, бюджет,
 * дата, категория или соответствующий data-атрибут. Это отсекает обёртки
 * <div class="want-card">, из-за которых при фильтрации вложенности терялись
 * настоящие карточки.
 */
export function hasJobContent(node) {
  const projectLinks = findAll(node, isProjectLink);
  if (projectLinks.length === 0) return false;

  const hasTitle =
    findAll(node, (child) => hasClassMatching(child, TITLE_CLASS) || ['h1', 'h2', 'h3', 'h4'].includes(child.tag)).length > 0 ||
    (projectLinks.length === 1 && textOf(projectLinks[0]).length >= 10);
  if (!hasTitle) return false;
  return (
    findAll(node, (child) =>
      hasClassMatching(child, DETAIL_CLASS) ||
      OWN_BUDGET_ATTRS.some((attr) => Boolean(child.attrs?.[attr])) ||
      Boolean(child.attrs?.['data-created-at'] || child.attrs?.['datetime'])
    ).length > 0
  );
}

export const CARD_SELECTOR_SPECS = [
  {
    id: 'data-want-id',
    description: 'Карточки с атрибутом data-want-id',
    match: (node) => Boolean(node.attrs?.['data-want-id']) && hasJobContent(node)
  },
  {
    id: 'data-project-id',
    description: 'Карточки с атрибутом data-project-id',
    match: (node) => Boolean(node.attrs?.['data-project-id'] || node.attrs?.['data-job-id']) && hasJobContent(node)
  },
  {
    id: 'class-want-card',
    description: 'Элементы с классом want-card / js-want-card',
    match: (node) =>
      classesOf(node).some((name) => /^(js-)?want-card(\b|[-_])/.test(name) || name === 'want-card') && hasJobContent(node)
  },
  {
    id: 'class-project-card',
    description: 'Элементы с классом project-card / want-card-inline',
    match: (node) =>
      classesOf(node).some((name) => name === 'project-card' || name === 'want-card-inline' || name === 'js-project-card') &&
      hasJobContent(node)
  },
  {
    id: 'link-based',
    description: 'Контейнеры формы карточки, содержащие ровно одну ссылку на задание',
    match: (node) => {
      if (!['article', 'li', 'div', 'section'].includes(node.tag)) return false;
      const links = findAll(node, isProjectLink);
      if (links.length !== 1) return false;
      return hasJobContent(node);
    }
  }
];

/** Разбор JSON-LD блоков. */
export function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(String(html ?? ''))) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      blocks.push(parsed);
    } catch {
      blocks.push({ __parseError: 'Некорректный JSON-LD' });
    }
  }
  return blocks;
}

/** Достаёт из JSON-LD список заданий (JobPosting/ItemList/Offer). */
export function jobsFromJsonLd(blocks, baseUrl) {
  const jobs = [];
  const warnings = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const type = Array.isArray(node['@type']) ? node['@type'].join(',') : String(node['@type'] ?? '');
    if (/JobPosting|Offer|CreativeWork|Product/i.test(type) && (node.url || node.title || node.name)) {
      jobs.push({
        url: node.url ?? node['@id'] ?? null,
        title: node.title ?? node.name ?? null,
        description: node.description ?? null,
        budget: node.baseSalary?.value?.value ?? node.baseSalary?.value ?? node.price ?? null,
        datePosted: node.datePosted ?? null,
        category: node.occupationalCategory ?? null,
        categoryText: node.category ?? null,
        clientName: node.hiringOrganization?.name ?? node.author?.name ?? null,
        source: 'json-ld'
      });
      return;
    }
    if (node['@graph']) visit(node['@graph']);
    if (node.itemListElement) visit(node.itemListElement);
    if (node.item) visit(node.item);
  };
  const before = jobs.length;
  blocks.forEach(visit);
  if (jobs.length === before && blocks.length > 0) {
    warnings.push('JSON-LD найден, но карточек заданий в нём нет.');
  }
  if (baseUrl) {
    for (const job of jobs) {
      if (job.url && !/^https?:/i.test(job.url)) {
        try {
          job.url = new URL(job.url, baseUrl).toString();
        } catch {
          job.url = null;
        }
      }
    }
  }
  return { jobs, warnings };
}

/** Определение стратегии по DOM. */
/**
 * Определение стратегии по DOM.
 *
 * Кандидаты собираются по ВСЕМ стратегиям и объединяются: в одной выдаче могут
 * соседствовать карточки с data-* атрибутами и карточки, размеченные только
 * классами. Раньше возврат на первой сработавшей стратегии приводил к потере
 * части карточек, поэтому теперь список общий, а приоритет стратегии влияет
 * только на подпись и на выбор при полном дублировании.
 */
export function detectDomStructure(root) {
  const candidates = new Map();
  const matchedStrategies = [];

  CARD_SELECTOR_SPECS.forEach((spec, priority) => {
    const matches = findAll(root, spec.match);
    if (matches.length === 0) return;
    matchedStrategies.push({ id: spec.id, count: matches.length, description: spec.description });
    for (const node of matches) {
      const existing = candidates.get(node);
      if (!existing) {
        candidates.set(node, { node, strategy: spec.id, priority, description: spec.description });
      } else if (priority < existing.priority) {
        existing.strategy = spec.id;
        existing.priority = priority;
        existing.description = spec.description;
      }
    }
  });

  const entries = [...candidates.values()];
  // Оставляем только самые вложенные кандидаты: если кандидат содержит другого
  // кандидата, он является обёрткой (например, строка списка вокруг карточки).
  const filtered = entries.filter(
    (entry) => !entries.some((other) => other.node !== entry.node && isAncestor(entry.node, other.node))
  );
  filtered.sort((a, b) => a.node.order - b.node.order);

  if (filtered.length === 0) {
    return { strategy: null, description: null, nodes: [], matchedStrategies, primaryStrategy: null };
  }

  const primary = filtered.reduce((best, entry) => (entry.priority < best.priority ? entry : best), filtered[0]);
  return {
    strategy: primary.strategy,
    description: primary.description,
    nodes: filtered.map((entry) => entry.node),
    nodeStrategies: filtered.map((entry) => entry.strategy),
    matchedStrategies,
    primaryStrategy: primary.strategy
  };
}

function isAncestor(possibleAncestor, node) {
  let current = node.parent;
  while (current) {
    if (current === possibleAncestor) return true;
    current = current.parent;
  }
  return false;
}

/** Признаки блокировки/проверки: детектор вынесен в anomaly-detector.js. */
export { detectPageAnomalies, detectPageAnomaliesDetailed, hasHardAnomaly, describeAnomalyDiagnostics, ANOMALY } from './anomaly-detector.js';
