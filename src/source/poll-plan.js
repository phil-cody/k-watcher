/**
 * План опроса: какие URL запрашивать в зависимости от выбранных категорий.
 *
 * Логика:
 *  - категории не выбраны  → один запрос на общий список (`/projects`), приходят все задания;
 *  - выбраны категории     → запрос на каждую категорию (`/projects?c=<id>`);
 *  - «все категории» (all) → один запрос на общий список: он и есть все задания.
 *
 * Каждый URL — отдельный одиночный GET со своей паузой, поэтому план влияет на число
 * запросов за цикл. Чтобы не выйти за согласованный объём доступа, в план попадают
 * только URL, объявленные в `source.allowedUrls`; остальные отбрасываются с пометкой.
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
  return ids.size === 0 ? { selection: [], source: 'none' } : { selection: [...ids].sort((a, b) => a - b), source: 'categories' };
}

/**
 * Построение плана опроса.
 *
 * @param {object} options
 * @param {string} options.base — базовый адрес («https://kwork.ru»)
 * @param {Array} options.allowedUrls — объявленные URL из конфигурации
 * @param {number[]|'all'|null} options.selection — выбранные категории
 * @returns {{
 *   urls: Array<{url: string, reason: string, categoryId: number|null, allowed: boolean}>,
 *   skipped: Array<{url: string, reason: string}>,
 *   mode: 'all'|'categories'
 * }}
 */
export function buildPollPlan({ base = 'https://kwork.ru', allowedUrls = [], selection = null } = {}) {
  const declared = new Set(
    (allowedUrls ?? [])
      .filter((entry) => entry && entry.enabled !== false)
      .map((entry) => normalizedUrl(entry.url))
      .filter(Boolean)
  );
  // Настройки объявленных URL: их нужно перенести в план, иначе потеряется
  // глубина пагинации (`pages`) и признак `pagination`.
  const declaredEntries = new Map(
    (allowedUrls ?? [])
      .filter((entry) => entry && entry.enabled !== false)
      .map((entry) => [normalizedUrl(entry.url), entry])
  );

  const generalUrl = allProjectsUrl(base);
  const urls = [];
  const skipped = [];

  const push = (url, reason, categoryId) => {
    const normalized = normalizedUrl(url);
    if (!declared.has(normalized)) {
      skipped.push({ url, reason: 'url-not-declared' });
      return;
    }
    if (urls.some((entry) => normalizedUrl(entry.url) === normalized)) return;
    const declaredEntry = declaredEntries.get(normalized) ?? {};
    urls.push({
      url,
      reason,
      categoryId,
      allowed: true,
      label: declaredEntry.label ?? null,
      // Настройки берём из объявленного URL: иначе пагинация схлопнется до одной страницы.
      pages: declaredEntry.pages ?? 1,
      pagination: declaredEntry.pagination === true
    });
  };

  // Категории не выбраны — один запрос на общий список: приходят все задания.
  if (selection === null || selection === undefined || (Array.isArray(selection) && selection.length === 0)) {
    push(generalUrl, 'no-selection', null);
    // Общий список не объявлен в доступе: опрашиваем объявленные URL,
    // чтобы бот не остался совсем без запросов.
    if (urls.length === 0) {
      for (const entry of allowedUrls ?? []) {
        if (!entry?.url || entry.enabled === false) continue;
        push(entry.url, 'declared', categoryIdOfUrl(entry.url));
      }
    }
    return { urls, skipped, mode: 'all' };
  }

  // «Все категории» — один запрос на общий список.
  if (selection === 'all') {
    push(generalUrl, 'all-categories', null);
    // Общий список не объявлен — опрашиваем объявленные категории: это лучше, чем ничего.
    if (urls.length === 0) {
      for (const entry of allowedUrls ?? []) {
        if (!entry?.url || entry.enabled === false) continue;
        push(entry.url, 'declared', categoryIdOfUrl(entry.url));
      }
    }
    return { urls, skipped, mode: 'all' };
  }

  const ids = [...new Set(selection.map(Number).filter((id) => Number.isFinite(id) && id > 0))].sort((a, b) => a - b);
  for (const id of ids) {
    push(categoryUrl(base, id), 'category', id);
  }

  // Ни одна выбранная категория не объявлена в доступе: опрашиваем объявленное,
  // чтобы не остаться без заданий молча.
  if (urls.length === 0) {
    for (const entry of allowedUrls ?? []) {
      if (!entry?.url || entry.enabled === false) continue;
      push(entry.url, 'declared', categoryIdOfUrl(entry.url));
    }
    return { urls, skipped, mode: 'declared' };
  }
  return { urls, skipped, mode: 'categories' };
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

/** URL без query-части «page» и без хвостовых слешей: для сравнения объявленного и построенного. */
export function normalizedUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url));
    parsed.searchParams.delete('page');
    const query = parsed.searchParams.toString();
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ''}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Базовый адрес из конфигурации: берём origin первого объявленного URL. */
export function baseFromAllowedUrls(allowedUrls = []) {
  for (const entry of allowedUrls ?? []) {
    if (!entry?.url) continue;
    try {
      return new URL(entry.url).origin;
    } catch {
      // Пробуем следующий.
    }
  }
  return 'https://kwork.ru';
}
