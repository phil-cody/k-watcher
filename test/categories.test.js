/**
 * Тесты персональных категорий: выбор пользователя, приоритет над общими,
 * фильтрация заданий и команда /categories.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CategoryPreferences,
  createCategoryCatalog,
  normalizeSelection,
  parseCategoryIds
} from '../src/storage/category-store.js';
import { dispatchCommand } from '../src/bot/kwork-watcher-bot.js';
import { loadConfig } from '../src/config/load-config.js';
import { loadCategoryCatalogFile } from '../src/storage/category-catalog.js';
import { createTexts } from '../src/texts/texts.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });
const { config } = loadConfig({ rootDir, env: {}, readEnvFile: false });
// Каталог с сайта: названия категорий берутся из config/categories.json.
const fullCatalog = await loadCategoryCatalogFile(resolve(rootDir, 'config', 'categories.json'));
const catalog = createCategoryCatalog(config, { fullCatalog });

test('каталог знает категории по умолчанию и остальные из конфига', () => {
  // Категории по умолчанию — те, что перечислены в targetCategories.
  // Уникальные id: одна категория может быть указана несколько раз (подразделы).
  const expectedDefaults = [...new Set(config.targetCategories.map((category) => category.kworkCategoryId))];
  assert.deepEqual(catalog.defaultIds, expectedDefaults);
  assert.equal(catalog.byId.size >= 54, true, `в каталоге ${catalog.byId.size} категорий (ожидается не меньше 54)`);
  assert.equal(catalog.attributes.size >= 200, true, `атрибутов: ${catalog.attributes.size}`);
  // Названия берутся из полного каталога сайта: 37 — «Создание сайта», 79 — «Верстка».
  assert.match(catalog.labelOf(37), /Создание сайта/);
  assert.equal(catalog.has(79), true);
  assert.equal(catalog.has(999999), false);
  // Для неизвестного id название всё равно формируется: пользователь может указать любой.
  assert.match(catalog.labelOf(999999), /своя категория 999999/);
  // Категории по умолчанию идут первыми в списке.
  assert.equal(catalog.list()[0].inDefault, true);
});

test('normalizeSelection приводит выбор к каноническому виду', () => {
  assert.equal(normalizeSelection('all'), 'all');
  assert.deepEqual(normalizeSelection([38, 37, 38]), [37, 38]);
  assert.deepEqual(normalizeSelection(['79', '38']), [38, 79]);
  assert.deepEqual(normalizeSelection([0, -1, 'x', 37]), [37]);
  assert.equal(normalizeSelection('мусор'), null);
  assert.equal(normalizeSelection(42), null);
});

test('parseCategoryIds разбирает разные формы ввода', () => {
  assert.deepEqual(parseCategoryIds(['37,38,79']).ids, [37, 38, 79]);
  assert.deepEqual(parseCategoryIds(['37', '38 79']).ids, [37, 38, 79]);
  assert.deepEqual(parseCategoryIds(['37;38']).ids, [37, 38]);
  assert.deepEqual(parseCategoryIds(['37,abc']).invalid, ['abc']);
  assert.deepEqual(parseCategoryIds([]).ids, []);
});

test('личный выбор важнее категорий по умолчанию', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cats-'));
  try {
    const prefs = new CategoryPreferences({ dataDir: dir, catalog });

    // Ничего не выбрано — значения по умолчанию из конфига.
    // Пока ничего не выбрано — действуют «все категории заданий».
    const fallback = await prefs.effective(222);
    assert.equal(fallback.source, 'default');
    assert.equal(fallback.selection, 'all');

    await prefs.set(222, [273]);
    const personal = await prefs.effective(222);
    assert.equal(personal.source, 'personal');
    assert.deepEqual(personal.selection, [273]);

    // Другой пользователь не затронут.
    assert.equal((await prefs.effective(333)).source, 'default');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('фильтр пропускает свои категории и не теряет задания без категории', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cats-'));
  try {
    const prefs = new CategoryPreferences({ dataDir: dir, catalog });
    await prefs.set(222, [37, 273]);

    assert.equal(await prefs.matches(222, { kworkCategoryId: 37 }), true);
    assert.equal(await prefs.matches(222, { kworkCategoryId: 273 }), true);
    assert.equal(await prefs.matches(222, { kworkCategoryId: 79 }), false);
    // Задание без числового id не отбрасываем: лучше показать, чем потерять.
    assert.equal(await prefs.matches(222, { kworkCategoryId: null }), true);
    assert.equal(await prefs.matches(222, {}), true);
    // Совпадение по ссылкам категории тоже учитывается.
    assert.equal(await prefs.matches(222, { kworkCategoryId: null, categoryLinkIds: [273] }), true);
    assert.equal(await prefs.matches(222, { kworkCategoryId: null, categoryLinkIds: [79] }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('выбор «все категории» отключает фильтр', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cats-'));
  try {
    const prefs = new CategoryPreferences({ dataDir: dir, catalog });
    await prefs.set(222, 'all');
    assert.equal(await prefs.get(222), 'all');
    assert.equal(await prefs.matches(222, { kworkCategoryId: 46 }), true);
    assert.equal(await prefs.matches(222, { kworkCategoryId: 999999 }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('сброс возвращает категории по умолчанию', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cats-'));
  try {
    const prefs = new CategoryPreferences({ dataDir: dir, catalog });
    await prefs.set(222, [273]);
    assert.equal(await prefs.remove(222), true);
    assert.equal(await prefs.get(222), null);
    assert.equal((await prefs.effective(222)).source, 'default');
    assert.equal(await prefs.remove(222), false, 'повторный сброс — не ошибка');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('повреждённый файл категорий не ломает работу', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cats-'));
  try {
    const prefs = new CategoryPreferences({ dataDir: dir, catalog, logger: null });
    await prefs.set(222, [37]);
    await writeFile(prefs.pathFor(222), '{ не json', 'utf8');
    // Возвращаемся к значениям по умолчанию, не падая.
    assert.equal(await prefs.get(222), null);
    assert.equal((await prefs.effective(222)).source, 'default');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Контекст диспетчера для команды /categories. */
function categoryContext(userId = 222, preferences = null) {
  return {
    config,
    profile: null,
    store: null,
    schedulerState: null,
    scheduler: null,
    telegramState: null,
    fromUserId: userId,
    fromChatId: userId,
    categoriesPreferences: preferences,
    categoryCatalog: catalog,
    texts
  };
}

test('/categories показывает текущий выбор и подсказку', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cats-'));
  try {
    const prefs = new CategoryPreferences({ dataDir: dir, catalog });

    // Пока ничего не выбрано — действуют все категории, и бот об этом сообщает.
    const result = await dispatchCommand('/categories', categoryContext(222, prefs));
    assert.match(result.reply, /Категории заданий/);
    assert.match(result.reply, /Выбраны все категории/);
    assert.match(result.reply, /Можно писать названием/);
    assert.match(result.reply, /\/categories 37,38,79/);
    assert.equal(result.action, null);

    // После личного выбора показываются названия из каталога сайта, а не числа.
    await prefs.set(222, [37, 79]);
    const withSelection = await dispatchCommand('/categories', categoryContext(222, prefs));
    assert.match(withSelection.reply, /37 — Создание сайта/);
    assert.match(withSelection.reply, /79 — Верстка/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/categories 37,273 сохраняет выбор и предупреждает о неизвестных', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cats-'));
  try {
    const prefs = new CategoryPreferences({ dataDir: dir, catalog });

    const saved = await dispatchCommand('/categories 37,273', categoryContext(222, prefs));
    assert.equal(saved.action, 'categories-set');
    assert.deepEqual(saved.selection, [37, 273]);
    assert.match(saved.reply, /Категории сохранены/);
    assert.match(saved.reply, /SEO/);

    const unknown = await dispatchCommand('/categories 37,999999', categoryContext(222, prefs));
    assert.match(unknown.reply, /Неизвестные id категорий: 999999/);
    assert.deepEqual(unknown.selection, [37, 999999], 'неизвестный id всё равно принимается');

    // Неизвестное название объясняем, а не молчим.
    const bad = await dispatchCommand('/categories abc', categoryContext(222, prefs));
    assert.equal(bad.action, null);
    assert.match(bad.reply, /Неизвестные id категорий: abc/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/categories all и reset меняют режим', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cats-'));
  try {
    const prefs = new CategoryPreferences({ dataDir: dir, catalog });

    const all = await dispatchCommand('/categories all', categoryContext(222, prefs));
    assert.equal(all.action, 'categories-set');
    assert.equal(all.selection, 'all');
    assert.match(all.reply, /все категории/);

    const reset = await dispatchCommand('/categories reset', categoryContext(222, prefs));
    assert.equal(reset.action, 'categories-reset');
    assert.match(reset.reply, /сброшен/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/categories list показывает каталог', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cats-'));
  try {
    const prefs = new CategoryPreferences({ dataDir: dir, catalog });
    const result = await dispatchCommand('/categories list', categoryContext(222, prefs));
    assert.match(result.reply, /Доступные категории Kwork/);
    for (const id of [37, 38, 79]) {
      assert.match(result.reply, new RegExp(`• ${id} — `), `в каталоге нет ${id}`);
    }
    assert.equal(result.reply.includes('<'), false, 'в ответе не должно быть угловых скобок');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
