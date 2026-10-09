/**
 * План опроса: какие URL запрашивать в зависимости от выбранных категорий.
 *
 * Логика:
 *  - категории не выбраны  → один запрос на общий список (`/projects`), приходят все задания;
 *  - «все категории» (all) → то же: общий список и есть все задания;
 *  - выбраны категории     → запрос на каждую категорию (`/projects?c=<id>`).
 *
 * Каждый URL — отдельный одиночный GET со своей паузой, поэтому план напрямую
 * определяет число запросов за цикл. Категории берутся из полного каталога сайта,
 * поэтому жёсткого списка разрешённых URL больше нет: допустим любой положительный
 * числовой id, но только по пути `/projects` (проверяется в validateSourceUrl).
 */

/** Базовый путь страницы списка заданий. */
export const PROJECTS_PATH = '/projects';

/** URL общего списка (все задания). */
export function allProjectsUrl(base) {
  return `${String(base).replace(/\/+$/, '')}${PROJECTS_PATH}`;
}

/** URL категории: `?c=<id>`. */
export function categoryUrl(base, categoryId) {
  return `${allProjectsUrl(base)}?c=${Number(categoryId)}`;
}

/** Какие категории выбраны у набора получателей: объединение или 'all'. */
export function effectiveCategorySelection(selections = []) {
  const list = (Array.isArray(selections) ? selections : [selections]).filter(Boolean);
  if (list.length === 0) return { selection: [], source: 'none' };
  // Если хотя бы один получатель выбрал «все категории» — опрашиваем общий список.
  if (list.some((item) => item === 'all')) return { selection: 'all', source: 'all' };
  const ids = new Set();
  for (const item of list) {
    if (!Array.isArray(item)) continue;
    for (const id of item) {
      const numeric = Number(id);
      if (Number.isFinite(numeric) && numeric > 0) ids.add(numeric);
    }
  }
  return ids.size === 0
    ? { selection: [], source: 'none' }
    : { selection: [...ids].sort((a, b) => a - b), source: 'categories' };
}

/**
 * Построение плана опроса.
 *
 * @param {object} options
 * @param {string} options.base — базовый адрес («https://kwork.ru»)
 * @param {number[]|'all'|null} options.selection — выбранные категории
 * @returns {{
 *   urls: Array<{url: string, reason: string, categoryId: number|null}>,
 *   mode: 'all'|'categories'
 * }}
 */
export function buildPollPlan({ base = 'https://kwork.ru', selection = null } = {}) {
  const generalUrl = allProjectsUrl(base);
  const urls = [];

  // Категории не выбраны или «все категории» — один запрос на общий список.
  if (selection === null || selection === undefined || selection === 'all') {
    return {
      urls: [{ url: generalUrl, reason: selection === 'all' ? 'all-categories' : 'no-selection', categoryId: null }],
      mode: 'all'
    };
  }

  const ids = [...new Set((Array.isArray(selection) ? selection : [selection])
    .map(Number)
    .filter((id) => Number.isFinite(id) && id > 0))]
    .sort((a, b) => a - b);

  if (ids.length === 0) {
    return {
      urls: [{ url: generalUrl, reason: 'no-selection', categoryId: null }],
      mode: 'all'
    };
  }

  for (const id of ids) {
    urls.push({ url: categoryUrl(base, id), reason: 'category', categoryId: id });
  }
  return { urls, mode: 'categories' };
}

/** Категория из URL вида `?c=<id>` (или null для общего списка). */
export function categoryIdOfUrl(url) {
  if (!url) return null;
  try {
    const value = new URL(String(url)).searchParams.get('c');
    // Важно: Number(null) === 0, поэтому пустой параметр проверяем до приведения.
    if (value === null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  } catch {
    return null;
  }
}
