/**
 * Тесты каталога категорий Kwork: разбор страницы, связь с URL-запросами,
 * поиск по названию и подстановка названия в задание.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCategoryCatalog,
  sliceJsonObject,
  normalizeCategoryName,
  findCategoriesByName,
  findAttributesByName,
  labelOfCategory,
  loadCategoryCatalogFile
} from '../src/storage/category-catalog.js';
import {
  createCategoryCatalog,
  resolveCategoryInput,
  applyCategoryName
} from '../src/storage/category-store.js';
import { loadConfig } from '../src/config/load-config.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const { config } = loadConfig({ rootDir, env: {}, readEnvFile: false });
const fullCatalog = await loadCategoryCatalogFile(resolve(rootDir, 'config', 'categories.json'));
const catalog = createCategoryCatalog(config, { fullCatalog });

test('sliceJsonObject достаёт объект с балансировкой скобок и строк', () => {
  const text = 'prefix {"a":{"b":"} текст {"},"c":[1,2]} suffix';
  const sliced = sliceJsonObject(text, 'prefix');
  assert.deepEqual(JSON.parse(sliced), { a: { b: '} текст {' }, c: [1, 2] });
  assert.equal(sliceJsonObject('нет маркера', 'prefix'), null);
  assert.equal(sliceJsonObject('prefix {не закрыт', 'prefix'), null);
});

test('normalizeCategoryName приводит регистр, ё/е, й/и и разделители', () => {
  assert.equal(normalizeCategoryName('ВЁРСТКА'), 'верстка');
  assert.equal(normalizeCategoryName('вёрстка'), 'верстка');
  assert.equal(normalizeCategoryName('Дизайн — логотип'), 'дизаин логотип');
  assert.equal(normalizeCategoryName('  SEO   и   трафик '), 'seo и трафик');
  assert.equal(normalizeCategoryName('Сайт-визитка'), 'саит визитка');
  assert.equal(normalizeCategoryName('«Мокап»'), 'мокап');
  // Слова, различающиеся только й/и, считаются одинаковыми.
  assert.equal(normalizeCategoryName('Таймлайн'), normalizeCategoryName('таимлаин'));
});

test('каталог с сайта содержит все разделы, категории и атрибуты', () => {
  assert.equal(fullCatalog.sections.length, 7, 'семь разделов Kwork');
  assert.equal(fullCatalog.categories.length, 54, 'пятьдесят четыре категории');
  const attributes = fullCatalog.categories.reduce((sum, category) => sum + category.attributes.length, 0);
  assert.equal(attributes, 219, 'двести девятнадцать подразделов');
});

test('каждая категория связана с запросом ?c=, а подраздел — с ?c=&attr=', () => {
  for (const category of fullCatalog.categories) {
    assert.match(category.url, /^\/projects\?c=\d+$/, `некорректная ссылка категории: ${category.url}`);
    assert.equal(category.url, `/projects?c=${category.id}`);
    for (const attribute of category.attributes) {
      assert.match(attribute.url, new RegExp(`^/projects\\?c=${category.id}&attr=\\d+$`));
      assert.equal(attribute.categoryId ?? category.id, category.id);
    }
  }
});

test('известные категории названы по данным сайта, а не перепутаны', () => {
  // Проверка фактов с сайта: 37 — создание сайта, 79 — вёрстка, 38 — доработка.
  const byId = new Map(fullCatalog.categories.map((category) => [category.id, category]));
  assert.equal(byId.get(37).name, 'Создание сайта');
  assert.equal(byId.get(79).name, 'Верстка');
  assert.equal(byId.get(38).name, 'Доработка и настройка сайта');
  assert.deepEqual(
    byId.get(79).attributes.map((attribute) => attribute.title),
    ['Верстка по макету', 'Доработка и адаптация верстки']
  );
  assert.deepEqual(
    byId.get(37).attributes.map((attribute) => attribute.title),
    ['Новый сайт', 'Копия сайта']
  );
});

test('parseCategoryCatalog разбирает реальную страницу', async () => {
  // Фикстура со страницы: сохранена, чтобы тест не зависел от сети.
  const html = await readFile(resolve(rootDir, 'test', 'fixtures', 'projects-page-categories.html'), 'utf8');
  const parsed = parseCategoryCatalog(html, { source: 'fixture' });
  assert.equal(parsed.error, undefined, parsed.error);
  assert.equal(parsed.sections.length, 7);
  assert.equal(parsed.categories.length, 54);
  assert.equal(parsed.updatedFrom, 'fixture');
});

test('parseCategoryCatalog сообщает, если дерева нет', () => {
  const parsed = parseCategoryCatalog('<html><body>пусто</body></html>', { source: 'x' });
  assert.deepEqual(parsed.categories, []);
  assert.match(parsed.error, /не найдено/);
});

test('findCategoriesByName ищет с учётом ё/е, й/и и регистра', () => {
  for (const query of ['верстка', 'ВЁРСТКА', 'Вёрстка', '  верстка  ']) {
    const result = findCategoriesByName(fullCatalog, query);
    assert.equal(result.exact?.name, 'Верстка', `не найдено по запросу ${query}`);
  }
  // «саита» и «сайта» после нормализации совпадают: й→и. Это и нужно пользователю.
  assert.equal(findCategoriesByName(fullCatalog, 'создание саита').exact?.name, 'Создание сайта');
  // А вот реальная опечатка совпадений не даёт.
  assert.deepEqual(findCategoriesByName(fullCatalog, 'созданио сафта').categories, []);
  // Подкатегория находится по части названия: «SEO аудиты» → «SEO аудиты, консультации».
  assert.equal(findCategoriesByName(fullCatalog, 'seo аудиты').categories[0]?.name, 'SEO аудиты, консультации');
  // «Дизайн» — это раздел, а не категория: в нём 11 категорий.
  const design = findCategoriesByName(fullCatalog, 'дизайн');
  assert.equal(design.categories.length > 1, true, 'по названию раздела находится несколько категорий');
  assert.equal(design.sections[0]?.name, 'Дизайн');
  // Пустой запрос.
  assert.deepEqual(findCategoriesByName(fullCatalog, '').categories, []);
});

test('findAttributesByName находит подраздел по названию', () => {
  const found = findAttributesByName(fullCatalog, 'верстка по макету');
  assert.equal(found.length, 1);
  assert.equal(found[0].categoryId, 79);
  assert.equal(found[0].title, 'Верстка по макету');
  assert.equal(found[0].url, '/projects?c=79&attr=224');

  const second = findAttributesByName(fullCatalog, 'Вёрстка по макету');
  assert.equal(second.length, 1, 'ё и е не должны мешать поиску');
});

test('labelOfCategory даёт название, с разделом или без', () => {
  const category = fullCatalog.categories.find((item) => item.id === 79);
  assert.equal(labelOfCategory(category), 'Верстка');
  assert.equal(labelOfCategory(category, { withSection: true }), 'Верстка (Разработка и IT)');
  assert.equal(labelOfCategory(null), null);
});

test('каталог приложения знает названия из файла сайта', () => {
  assert.match(catalog.labelOf(37), /^Создание сайта/);
  assert.match(catalog.labelOf(79), /^Верстка/);
  assert.equal(catalog.urlOf(79), '/projects?c=79');
  assert.deepEqual(
    catalog.attributesOf(79).map((attribute) => `${attribute.id}:${attribute.title}`),
    ['224:Верстка по макету', '226:Доработка и адаптация верстки']
  );
  // Атрибуты доступны и по id.
  assert.equal(catalog.attributes.get(224).categoryId, 79);
  assert.equal(catalog.attributes.get(224).url, '/projects?c=79&attr=224');
});

test('resolveCategoryInput принимает числа, названия и подразделы', () => {
  assert.deepEqual(resolveCategoryInput(['37'], catalog).ids, [37]);
  assert.deepEqual(resolveCategoryInput(['верстка'], catalog).ids, [79]);
  assert.deepEqual(resolveCategoryInput(['ВЁРСТКА'], catalog).ids, [79]);
  assert.deepEqual(resolveCategoryInput(['вёрстка по макету'], catalog).ids, [79]);
  assert.deepEqual(resolveCategoryInput(['вёрстка по макету'], catalog).attributes, [224]);
  // Формат «категория:подраздел».
  const explicit = resolveCategoryInput(['79:226'], catalog);
  assert.deepEqual(explicit.ids, [79]);
  assert.deepEqual(explicit.attributes, [226]);
  // Названия из разных разделов.
  assert.deepEqual(resolveCategoryInput(['SEO аудиты'], catalog).ids, [44]);
  // Название раздела означает все его категории.
  const design = resolveCategoryInput(['Дизайн'], catalog);
  assert.equal(design.ids.length, 11, `в разделе «Дизайн» 11 категорий, получено ${design.ids.length}`);
  assert.deepEqual(design.ids.includes(24), true);
  const seo = resolveCategoryInput(['SEO и трафик'], catalog);
  // Раздел — это семь его категорий; порядок берётся из каталога.
  assert.deepEqual(seo.ids.slice().sort((a, b) => a - b), [43, 44, 56, 59, 71, 72, 273]);
  // Смешанный ввод.
  const mixed = resolveCategoryInput(['37, Верстка'], catalog);
  assert.deepEqual(mixed.ids, [37, 79]);
  // Неизвестное значение не выдумывает id: слова сообщаются как нераспознанные.
  const unknown = resolveCategoryInput(['нет такой категории'], catalog);
  assert.deepEqual(unknown.ids, []);
  assert.deepEqual(unknown.unknown, ['нет', 'такой', 'категории']);
});

test('applyCategoryName подставляет название категории в задание', () => {
  const job = {
    id: '1',
    title: 'Вёрстка лендинга',
    kworkCategoryId: 79,
    declaredCategory: null,
    category: { id: 'markup-by-layout', label: 'Верстка - Верстка по макету', matchedBy: 'kwork-category-id' }
  };
  const described = applyCategoryName(job, catalog);
  assert.match(described.declaredCategory, /Верстка/);
  assert.match(described.category.label, /Верстка \(Разработка и IT\)/);
  // Подразделы перечислены: видно, что приходит по этому запросу.
  assert.match(described.category.label, /Верстка по макету/);
  assert.match(described.category.label, /Доработка и адаптация верстки/);
  // Объявленная категория не перетирается, если уже была.
  const withDeclared = applyCategoryName({ ...job, declaredCategory: 'Из карточки' }, catalog);
  assert.equal(withDeclared.declaredCategory, 'Из карточки');

  // Задание без числового id остаётся как есть.
  const noId = applyCategoryName({ ...job, kworkCategoryId: null }, catalog);
  assert.equal(noId.category.label, job.category.label);
  // Неизвестный id не ломает разбор.
  const unknown = applyCategoryName({ ...job, kworkCategoryId: 999999 }, catalog);
  assert.match(unknown.category.label, /Верстка - Верстка по макету/);
});
