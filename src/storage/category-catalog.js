/**
 * Каталог категорий Kwork: разделы, подкатегории и их атрибуты.
 *
 * Откуда берутся данные: на странице списка заданий Kwork в inline-JSON есть объект
 * `categoriesWithFavoritesList` — полное дерево категорий с числовыми id, названиями
 * и атрибутами (подразделами внутри категории).
 *
 * Связь с запросами:
 *   https://kwork.ru/projects?c=<id категории>                  — вся категория
 *   https://kwork.ru/projects?c=<id категории>&attr=<id атрибута> — конкретный подраздел
 *
 * Числовые id совпадают с полем `category_id` в выдаче заданий, поэтому по каталогу можно
 * показать название категории вместо числа.
 *
 * Каталог обновляется командой `node src/index.js categories-refresh`
 * (один GET на страницу списка заданий).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Маркеры, за которыми в inline-JSON начинается дерево категорий. */
const TREE_MARKERS = ['"categoriesWithFavoritesList":', '"categories":'];

/**
 * Достать JSON-объект, начинающийся после маркера, с балансировкой скобок и строк.
 * Регуляркой такое не разобрать: внутри строк встречаются и скобки, и кавычки.
 */
export function sliceJsonObject(text, marker) {
  const at = String(text ?? '').indexOf(marker);
  if (at === -1) return null;
  const start = String(text).indexOf('{', at + marker.length - 1);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** Нормализация названия для поиска: регистр, ё→е, й→и, дефисы, пробелы. */
export function normalizeCategoryName(value) {
  return String(value ?? '')
    .toLowerCase()
    // ё и й — самые частые расхождения при вводе названия вручную.
    .replace(/ё/g, 'е')
    .replace(/й/g, 'и')
    .replace(/[«»"'`]/g, '')
    .replace(/[–—-]/g, ' ')
    .replace(/[^a-zа-я0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Разбор дерева категорий из HTML страницы списка заданий.
 * @returns {{ sections: Array, categories: Array, updatedFrom: string|null }}
 */
export function parseCategoryCatalog(html, { source = null } = {}) {
  let tree = null;
  for (const marker of TREE_MARKERS) {
    const raw = sliceJsonObject(html, marker);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      // Первый маркер даёт дерево с атрибутами; второй — плоскую карту.
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        tree = parsed;
        break;
      }
    } catch {
      // Пробуем следующий маркер.
    }
  }
  if (!tree) return { sections: [], categories: [], updatedFrom: source, error: 'дерево категорий не найдено' };

  const categories = [];
  const sections = [];

  // Формат 1: { "<sectionId>": { id, name, cats: [ { id, name, attributes: {...} } ] } }
  // Формат 2: { "<id>": { CATID, name, parent, cats: [...] } } — как в карте 'categories'
  for (const entry of Object.values(tree)) {
    if (!entry || typeof entry !== 'object') continue;
    const sectionId = Number(entry.id ?? entry.CATID);
    if (!Number.isFinite(sectionId)) continue;
    const sectionName = entry.name ?? entry.short_name ?? `Раздел ${sectionId}`;
    const subs = Array.isArray(entry.cats) ? entry.cats : [];
    if (subs.length === 0) continue;

    sections.push({
      id: sectionId,
      name: sectionName,
      seo: entry.seo ?? null,
      categories: subs.map((sub) => Number(sub.id ?? sub.CATID)).filter((id) => Number.isFinite(id))
    });

    for (const sub of subs) {
      const categoryId = Number(sub.id ?? sub.CATID);
      if (!Number.isFinite(categoryId)) continue;
      const attributes = Object.values(sub.attributes ?? {})
        .map((attribute) => ({
          id: Number(attribute.id),
          title: attribute.title ?? '',
          url: `/projects?c=${categoryId}&attr=${Number(attribute.id)}`
        }))
        .filter((attribute) => Number.isFinite(attribute.id) && attribute.title);
      categories.push({
        id: categoryId,
        name: sub.name ?? `Категория ${categoryId}`,
        sectionId,
        sectionName,
        description: sub.mobile_description ?? '',
        url: `/projects?c=${categoryId}`,
        attributes
      });
    }
  }

  categories.sort((a, b) => a.sectionId - b.sectionId || a.id - b.id);
  sections.sort((a, b) => a.id - b.id);
  return { sections, categories, updatedFrom: source };
}

/**
 * Единый поиск по каталогу: категории, разделы и подразделы.
 *
 * Нормализация снимает различия регистра, ё/е, й/и и разделителей, поэтому
 * «вёрстка по макету», «ВЕРСТКА ПО МАКЕТУ» и «верстка макет» находят одно и то же.
 * Название раздела означает все его категории.
 *
 * @returns {{ categories: Array, attributes: Array, sections: Array, exact: object|null, ambiguous: boolean }}
 */
export function searchCatalog(catalog, query) {
  const needle = normalizeCategoryName(query);
  const categories = catalog?.categories ?? [];
  const sections = catalog?.sections ?? [];
  const attributes = catalog?.attributes ?? [];
  if (!needle) return { categories: [], attributes: [], sections: [], exact: null, ambiguous: false };

  const words = needle.split(' ').filter(Boolean);
  const matchAll = (text) => {
    const haystack = ` ${normalizeCategoryName(text)} `;
    // Совпадение по целым словам: иначе «по» находилось бы внутри «наполнение»,
    // а «ии» — внутри «ИИ-генерация» и «иллюстрации».
    const phrase = ` ${needle} `;
    if (haystack.includes(phrase)) return true;
    if (words.length > 1 && words.every((word) => haystack.includes(` ${word} `))) return true;
    // Основа слова: «саита» и «сайта» совпадают после нормализации й→и.
    return words.length === 1 && words[0].length >= 4 && haystack.includes(words[0]);
  };

  const matchedSections = sections.filter((section) => matchAll(section.name));
  const sectionCategoryIds = new Set(matchedSections.flatMap((section) => section.categories ?? []));

  const exactCategory = categories.filter((category) => normalizeCategoryName(category.name) === needle);
  const matchedCategories = categories.filter(
    (category) => sectionCategoryIds.has(category.id) || matchAll(`${category.name} ${category.sectionName ?? ''}`)
  );

  // Подразделы: у категорий из файла они вложены, у каталога приложения — плоский список.
  const matchedAttributes = [];
  for (const category of categories) {
    for (const attribute of category.attributes ?? []) {
      if (matchAll(`${attribute.title} ${category.name}`)) {
        matchedAttributes.push({ ...attribute, categoryId: category.id, categoryName: category.name });
      }
    }
  }
  for (const attribute of attributes) {
    if (matchAll(`${attribute.title} ${attribute.categoryName ?? ''}`)) {
      matchedAttributes.push(attribute);
    }
  }

  const matches = exactCategory.length > 0 ? exactCategory : matchedCategories;
  return {
    categories: matches,
    attributes: matchedAttributes,
    sections: matchedSections,
    exact: exactCategory[0] ?? null,
    ambiguous: matches.length > 1
  };
}

/** Поиск по каталогу-файлу: обёртка над общей функцией. */
export function findCategoriesByName(catalog, query) {
  return searchCatalog(catalog, query);
}

/** Поиск атрибута (подраздела) по названию внутри каталога. */
export function findAttributesByName(catalog, query) {
  const needle = normalizeCategoryName(query);
  if (!needle) return [];
  const found = [];
  for (const category of catalog?.categories ?? []) {
    for (const attribute of category.attributes ?? []) {
      const normalized = normalizeCategoryName(attribute.title);
      if (normalized === needle || normalized.includes(needle)) {
        found.push({ categoryId: category.id, categoryName: category.name, ...attribute });
      }
    }
  }
  return found;
}

/** Краткое название для показа: «Верстка (Разработка и IT)». */
export function labelOfCategory(category, { withSection = false } = {}) {
  if (!category) return null;
  return withSection && category.sectionName ? `${category.name} (${category.sectionName})` : category.name;
}

/** Загрузка сохранённого каталога из файла. */
export async function loadCategoryCatalogFile(path) {
  const file = resolve(path);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Сохранение каталога. */
export async function saveCategoryCatalogFile(path, catalog) {
  const file = resolve(path);
  await writeFile(file, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  return file;
}
