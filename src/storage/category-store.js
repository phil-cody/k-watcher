/**
 * Персональные категории заданий.
 *
 * Каждому пользователю нужны свои категории: один берёт вёрстку, другой — SEO.
 * Выбор хранится отдельно от профиля, в `data/categories/<userId>.json`:
 *
 *   { "selection": [37, 38, 79], "updatedAt": "…" }
 *   { "selection": "all" }        — любые категории, фильтр выключен
 *   файла нет                     — категории по умолчанию из конфигурации бота
 *
 * Фильтрация выполняется до анализа: задание из чужой категории не тратит
 * ни вычислений, ни квоту модели, ни место в индексе.
 */

import { readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import { normalizeCategoryName, searchCatalog } from './category-catalog.js';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

/** Приведение выбора к каноническому виду: 'all' или отсортированный массив id. */
export function normalizeSelection(selection) {
  if (selection === 'all') return 'all';
  if (!Array.isArray(selection)) return null;
  const ids = [...new Set(selection.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  return ids.sort((a, b) => a - b);
}

/**
 * Каталог категорий: id → название.
 *
 * Источники по приоритету:
 *  1. Полный каталог сайта (`config/categories.json`): все разделы, категории и подразделы.
 *  2. Краткая выжимка из конфигурации (`config.categoryCatalog.entries`).
 *
 * Любой id вне каталога тоже принимается: пользователь может указать категорию,
 * которой ещё нет в справочнике.
 */
export function createCategoryCatalog(config = {}, { fullCatalog = null } = {}) {
  const byId = new Map();
  const attributes = new Map();

  // 1. Полный каталог с сайта.
  for (const category of fullCatalog?.categories ?? []) {
    const numeric = Number(category.id);
    if (!Number.isFinite(numeric)) continue;
    byId.set(numeric, {
      id: numeric,
      // `name` — каноническое поле (так же называется в файле каталога сайта),
      // `label` — псевдоним для существующего кода.
      name: category.name ?? `Категория ${numeric}`,
      label: category.name ?? `Категория ${numeric}`,
      section: category.sectionName ?? null,
      sectionId: category.sectionId ?? null,
      url: category.url ?? `/projects?c=${numeric}`,
      inDefault: false,
      source: 'site'
    });
    for (const attribute of category.attributes ?? []) {
      const attributeId = Number(attribute.id);
      if (!Number.isFinite(attributeId)) continue;
      attributes.set(attributeId, {
        id: attributeId,
        title: attribute.title,
        categoryId: numeric,
        categoryName: category.name ?? null,
        url: attribute.url ?? `/projects?c=${numeric}&attr=${attributeId}`
      });
    }
  }

  // 2. Краткая выжимка из конфигурации: дополняет и помечает категории по умолчанию.
  const entries = config.categoryCatalog?.entries ?? {};
  for (const [id, entry] of Object.entries(entries)) {
    const numeric = Number(id);
    if (!Number.isFinite(numeric)) continue;
    const existing = byId.get(numeric);
    if (existing) {
      existing.inDefault = entry?.inDefault === true || existing.inDefault;
      continue;
    }
    byId.set(numeric, {
      id: numeric,
      name: entry?.label ?? `Категория ${id}`,
      label: entry?.label ?? `Категория ${id}`,
      section: entry?.section ?? null,
      sectionId: null,
      url: `/projects?c=${numeric}`,
      inDefault: entry?.inDefault === true,
      source: 'config'
    });
  }
  // Категории по умолчанию: то, что бот запрашивает без личного выбора.
  // Один числовой id может встречаться несколько раз (подразделы внутри категории),
  // поэтому список уникален.
  const defaultIds = [];
  for (const category of config.targetCategories ?? []) {
    const numeric = Number(category?.kworkCategoryId);
    if (Number.isFinite(numeric) && !defaultIds.includes(numeric)) defaultIds.push(numeric);
  }
  const sections = (fullCatalog?.sections ?? []).map((section) => ({
    id: Number(section.id),
    name: section.name,
    categoryIds: (section.categories ?? []).map(Number).filter((id) => Number.isFinite(id))
  }));

  return {
    byId,
    attributes,
    sections,
    defaultIds,
    /** Полное название категории (при наличии — с разделом). */
    labelOf(id, { withSection = true } = {}) {
      const entry = byId.get(Number(id));
      if (!entry) return `своя категория ${id}`;
      const name = entry.name ?? entry.label;
      return withSection && entry.section ? `${name} (${entry.section})` : name;
    },
    /** Ссылка на категорию для запроса. */
    urlOf(id) {
      return byId.get(Number(id))?.url ?? `/projects?c=${Number(id)}`;
    },
    entryOf(id) {
      return byId.get(Number(id)) ?? null;
    },
    /** Атрибуты категории: подразделы внутри неё (?c=..&attr=..). */
    attributesOf(id) {
      return [...attributes.values()].filter((attribute) => attribute.categoryId === Number(id));
    },
    /**
     * Поиск по названию категории, раздела или подраздела.
     * Реализация общая с поиском по файлу каталога — см. searchCatalog.
     */
    findByName(query) {
      return searchCatalog(
        {
          categories: [...byId.values()].map((entry) => ({
            ...entry,
            name: entry.name ?? entry.label,
            sectionName: entry.section,
            attributes: [...attributes.values()].filter((attribute) => attribute.categoryId === entry.id)
          })),
          attributes: [...attributes.values()],
          sections
        },
        query
      );
    },
    /** Категории раздела. */
    categoriesOfSection(sectionId) {
      const section = sections.find((entry) => entry.id === Number(sectionId));
      return section ? section.categoryIds.map((id) => byId.get(id)).filter(Boolean) : [];
    },
    has(id) {
      return byId.has(Number(id));
    },
    /** Список для показа пользователю: сначала категории по умолчанию, затем остальные. */
    list() {
      return [...byId.values()].sort((a, b) => {
        if (a.inDefault !== b.inDefault) return a.inDefault ? -1 : 1;
        return a.id - b.id;
      });
    }
  };
}

export class CategoryPreferences {
  constructor({ dataDir = 'data', dir = null, catalog = null, logger = null } = {}) {
    this.dir = dir ? resolve(dir) : resolve(dataDir, 'categories');
    this.catalog = catalog ?? createCategoryCatalog({});
    this.logger = logger;
  }

  pathFor(userId) {
    const id = Number(userId);
    if (!Number.isFinite(id)) return null;
    return join(this.dir, `${id}.json`);
  }

  /** Сохранённый выбор пользователя или null, если он ничего не выбирал. */
  async get(userId) {
    const path = this.pathFor(userId);
    if (!path || !existsSync(path)) return null;
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      return normalizeSelection(parsed?.selection ?? null);
    } catch (error) {
      this.logger?.warn('Файл категорий повреждён, использую значения по умолчанию', {
        userId: Number(userId),
        reason: error.message
      });
      return null;
    }
  }

  async set(userId, selection) {
    const normalized = normalizeSelection(selection);
    if (normalized === null) throw new Error(`Некорректный выбор категорий: ${JSON.stringify(selection)}`);
    const path = this.pathFor(userId);
    if (!path) throw new Error(`Некорректный id пользователя: ${userId}`);
    await mkdir(dirname(path), { recursive: true });
    const payload = { selection: normalized, updatedAt: new Date().toISOString() };
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
    return normalized;
  }

  async remove(userId) {
    const path = this.pathFor(userId);
    if (!path || !existsSync(path)) return false;
    await unlink(path);
    return true;
  }

  /**
   * Эффективные категории пользователя.
   *
   * Пока пользователь ничего не выбрал, действуют «все категории»: бот опрашивает общий
   * список заданий и присылает всё. Личный выбор сужает набор.
   *
   * @returns {{ selection: number[]|'all', source: 'personal'|'default' }}
   */
  async effective(userId) {
    const personal = await this.get(userId);
    if (personal === 'all') return { selection: 'all', source: 'personal' };
    if (Array.isArray(personal) && personal.length > 0) {
      return { selection: personal, source: 'personal' };
    }
    // Ничего не выбрано — все категории заданий.
    return { selection: 'all', source: 'default' };
  }

  /**
   * Подходит ли задание пользователю по категориям.
   * Если у задания нет числового id категории, не отбрасываем: лучше показать лишнее,
   * чем молча потерять задание.
   */
  async matches(userId, job) {
    const { selection } = await this.effective(userId);
    if (selection === 'all') return true;
    if (selection.length === 0) return true;
    // Важно: Number(null) === 0 и Number.isFinite(0) === true, поэтому проверяем
    // исходные значения, а не приведённые. Иначе задание без категории отбрасывалось.
    const rawIds = [job?.kworkCategoryId, ...(Array.isArray(job?.categoryLinkIds) ? job.categoryLinkIds : [])];
    const candidates = rawIds
      .filter((value) => value !== null && value !== undefined && value !== '')
      .map(Number)
      .filter((id) => Number.isFinite(id) && id > 0);
    if (candidates.length === 0) return true;
    return candidates.some((id) => selection.includes(id));
  }

  /** Кто из пользователей выбрал свои категории. */
  async listPersonal() {
    if (!existsSync(this.dir)) return [];
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(this.dir);
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => Number(name.replace(/\.json$/, '')))
      .filter((id) => Number.isFinite(id));
  }
}

/**
 * Разбор пользовательского ввода категорий.
 *
 * Принимает смесь чисел и названий: «37, Верстка, SEO аудиты».
 * @returns {{
 *   ids: number[], attributes: Array, unknown: string[], categories: Array, attributeEntries: Array
 * }}
 */
export function resolveCategoryInput(input, catalog) {
  const rawArgs = (Array.isArray(input) ? input : [input]).map((item) => String(item ?? '').trim()).filter(Boolean);
  const args = rawArgs
    .flatMap((item) => item.split(/[,;]+/))
    .map((item) => item.trim())
    .filter(Boolean);
  if (args.length === 0) return emptyResolution();

  // Запятая — явный разделитель элементов списка: «Верстка, Создание сайта».
  // Группируем слова в элементы по запятым.
  const chunks = [];
  let current = [];
  for (const raw of rawArgs) {
    current.push(raw.replace(/[,;]+$/, ''));
    if (/[,;]$/.test(raw)) {
      chunks.push(current.filter(Boolean).join(' '));
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current.filter(Boolean).join(' '));
  const hasSeparators = chunks.length > 1;

  // 1. Ввод без разделителей — одна фраза: «вёрстка по макету», «SEO аудиты», «Дизайн».
  if (!hasSeparators) {
    const single = resolvePhrase(rawArgs.join(' '), catalog);
    if (single.matched) return single;
  }

  // 2. Каждый элемент списка разбираем отдельно: «Верстка» и «Создание сайта».
  const perChunk = hasSeparators ? chunks.map((chunk) => resolvePhrase(chunk, catalog)) : [];
  const combinedChunks = hasSeparators ? mergeResolutions(perChunk) : null;
  if (combinedChunks && combinedChunks.ids.length + combinedChunks.attributes.length > 0) {
    return { ...combinedChunks, matched: true };
  }

  // 3. Разбор по частям, разделённым запятыми.
  const perPart = [];
  let matchedAny = false;
  for (const part of args) {
    const result = resolvePhrase(part, catalog);
    if (result.matched) matchedAny = true;
    perPart.push(result);
  }
  const combined = mergeResolutions(perPart);
  if (matchedAny) return { ...combined, matched: true };

  // 4. Совсем не распознали — сообщаем как есть.
  return { ...resolveWords(args.join(' '), catalog), matched: false };
}

function emptyResolution() {
  return { ids: [], attributes: [], unknown: [], categories: [], attributeEntries: [], matched: false };
}

/** Сопоставление одной фразы. `matched` показывает, что фраза распознана целиком. */
function resolvePhrase(phrase, catalog, { decompose = true } = {}) {
  const trimmed = String(phrase ?? '').trim();
  if (!trimmed) return emptyResolution();

  // Число: id категории, «37:224» — категория и подраздел.
  const withAttribute = /^(\d+)\s*[:/]\s*(\d+)$/.exec(trimmed);
  if (withAttribute) {
    return {
      ids: [Number(withAttribute[1])],
      attributes: [Number(withAttribute[2])],
      unknown: [],
      categories: [],
      attributeEntries: [],
      matched: true
    };
  }
  if (/^\d+$/.test(trimmed)) {
    return { ids: [Number(trimmed)], attributes: [], unknown: [], categories: [], attributeEntries: [], matched: true };
  }

  const found = catalog?.findByName ? catalog.findByName(trimmed) : null;
  if (!found) return { ...emptyResolution(), unknown: [trimmed] };

  // Точное название категории.
  if (found.exact) {
    return {
      ids: [found.exact.id],
      attributes: [],
      unknown: [],
      categories: [found.exact],
      attributeEntries: [],
      matched: true,
      exactMatched: true
    };
  }
  // Точное название подраздела.
  const exactAttribute = found.attributes.find(
    (attribute) => normalizeCategoryName(attribute.title) === normalizeCategoryName(trimmed)
  );
  if (exactAttribute) {
    return {
      ids: [exactAttribute.categoryId],
      attributes: [exactAttribute.id],
      unknown: [],
      categories: [],
      attributeEntries: [exactAttribute],
      matched: true,
      exactMatched: true
    };
  }
  // Название раздела: все его категории.
  const section = found.sections?.find(
    (item) => normalizeCategoryName(item.name) === normalizeCategoryName(trimmed)
  );
  if (section) {
    const ids = (section.categoryIds ?? []).map(Number);
    return {
      ids,
      attributes: [],
      unknown: [],
      categories: ids.map((id) => catalog.entryOf?.(id)).filter(Boolean),
      attributeEntries: [],
      matched: true,
      exactMatched: true
    };
  }
  // Ровно одна категория по фразе.
  if (found.categories.length === 1) {
    return {
      ids: [found.categories[0].id],
      attributes: [],
      unknown: [],
      categories: [found.categories[0]],
      attributeEntries: [],
      matched: true,
      exactMatched: true
    };
  }
  // Похоже на что-то известное, но без однозначности: разбираем по словам.
  // По одному слову дальше не разлагаем — это привело бы к бесконечной рекурсии.
  if (decompose && (found.categories.length > 1 || found.attributes.length > 0)) {
    return resolveWords(trimmed, catalog);
  }
  // Одно слово дало несколько совпадений: берём их все, но помечаем как частичное.
  if (found.categories.length > 1) {
    return {
      ids: found.categories.map((entry) => entry.id),
      attributes: [],
      unknown: [],
      categories: found.categories,
      attributeEntries: [],
      matched: true,
      ambiguous: true
    };
  }
  return { ...emptyResolution(), unknown: [trimmed] };
}

/**
 * Разбор по отдельным словам: «Верстка, Создание сайта» приходит тремя словами.
 * Каждое слово пробуем как самостоятельное название.
 */
function resolveWords(phrase, catalog) {
  const ids = new Set();
  const attributes = new Set();
  const categories = [];
  const attributeEntries = [];
  const unknown = [];

  for (const word of String(phrase ?? '').split(/\s+/).filter(Boolean)) {
    const result = resolvePhrase(word, catalog, { decompose: false });
    if (result.matched) {
      for (const id of result.ids) ids.add(id);
      for (const id of result.attributes) attributes.add(id);
      categories.push(...result.categories);
      attributeEntries.push(...result.attributeEntries);
      continue;
    }
    if (/^\d+$/.test(word)) {
      ids.add(Number(word));
      continue;
    }
    unknown.push(word);
  }
  return {
    ids: [...ids].sort((a, b) => a - b),
    attributes: [...attributes].sort((a, b) => a - b),
    unknown,
    categories,
    attributeEntries,
    matched: ids.size > 0 || attributes.size > 0
  };
}

/** Объединение нескольких результатов разбора. */
function mergeResolutions(results) {
  const ids = new Set();
  const attributes = new Set();
  const categories = [];
  const attributeEntries = [];
  const unknown = [];
  for (const result of results) {
    for (const id of result.ids) ids.add(id);
    for (const id of result.attributes) attributes.add(id);
    categories.push(...result.categories);
    attributeEntries.push(...result.attributeEntries);
    unknown.push(...result.unknown);
  }
  return {
    ids: [...ids].sort((a, b) => a - b),
    attributes: [...attributes].sort((a, b) => a - b),
    unknown,
    categories,
    attributeEntries
  };
}

/**
 * Подстановка человеческого названия категории в задание.
 *
 * В выдаче Kwork есть только числовой `category_id`, поэтому без каталога в сообщении
 * было бы «37». Здесь берём название из каталога сайта и подставляем его в
 * `declaredCategory` и `category.label`, чтобы в отчёте было читаемое название.
 *
 * Категория может содержать несколько подразделов (у 79 их два), поэтому в скобках
 * перечисляем их: так видно, что именно может прийти по этому запросу.
 */
export function applyCategoryName(job, catalog) {
  const categoryId = Number(job?.kworkCategoryId);
  if (!catalog || !Number.isFinite(categoryId)) return job;
  const entry = catalog.entryOf ? catalog.entryOf(categoryId) : catalog.byId?.get(categoryId);
  if (!entry) return job;

  const attributes = catalog.attributesOf ? catalog.attributesOf(categoryId) : [];
  const name = entry.section ? `${entry.label} (${entry.section})` : entry.label;
  const label = attributes.length > 0
    ? `${name}: ${attributes.map((attribute) => attribute.title).join(', ')}`
    : name;

  return {
    ...job,
    declaredCategory: job.declaredCategory ?? name,
    category: job.category ? { ...job.category, label } : job.category,
    categoryUrl: entry.url ?? `/projects?c=${categoryId}`
  };
}

/** Разбор аргументов команды /categories: «37,38 79» → [37, 38, 79]. */
export function parseCategoryIds(input = []) {
  const parts = (Array.isArray(input) ? input : [input])
    .flatMap((item) => String(item ?? '').split(/[,\s;]+/))
    .map((item) => item.trim())
    .filter(Boolean);
  const ids = [];
  const invalid = [];
  for (const part of parts) {
    const numeric = Number(part);
    if (Number.isFinite(numeric) && numeric > 0 && Number.isInteger(numeric)) ids.push(numeric);
    else invalid.push(part);
  }
  return { ids: [...new Set(ids)], invalid };
}
