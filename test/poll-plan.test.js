/**
 * Тесты плана опроса: какие URL запрашиваются в зависимости от выбранных категорий.
 *
 * Правила:
 *  - категории не выбраны  → один запрос на общий список (/projects);
 *  - «все категории»       → тоже общий список;
 *  - выбраны категории     → запрос на каждую (/projects?c=<id>);
 *  - в план попадают только URL, объявленные в source.allowedUrls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPollPlan,
  baseFromAllowedUrls,
  categoryUrl,
  allProjectsUrl,
  categoryIdOfUrl,
  effectiveCategorySelection,
  normalizedUrl
} from '../src/source/poll-plan.js';
import { dispatchCommand } from '../src/bot/kwork-watcher-bot.js';
import { createTexts } from '../src/texts/texts.js';
import { loadConfig } from '../src/config/load-config.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });
const { config } = loadConfig({ rootDir, env: {}, readEnvFile: false });
const allowed = config.source.allowedUrls;
const base = baseFromAllowedUrls(allowed);

test('вспомогательные функции строят корректные URL', () => {
  assert.equal(allProjectsUrl('https://kwork.ru'), 'https://kwork.ru/projects');
  assert.equal(allProjectsUrl('https://kwork.ru/'), 'https://kwork.ru/projects');
  assert.equal(categoryUrl('https://kwork.ru', 37), 'https://kwork.ru/projects?c=37');
  assert.equal(categoryIdOfUrl('https://kwork.ru/projects?c=79'), 79);
  assert.equal(categoryIdOfUrl('https://kwork.ru/projects'), null);
  assert.equal(categoryIdOfUrl('мусор'), null);
  // Нормализация убирает page и хвостовые слеши.
  assert.equal(
    normalizedUrl('https://kwork.ru/projects?c=79&page=2'),
    normalizedUrl('https://kwork.ru/projects?c=79')
  );
});

test('категории не выбраны — один запрос на общий список', () => {
  const plan = buildPollPlan({ base, allowedUrls: allowed, selection: null });
  assert.equal(plan.mode, 'all');
  assert.deepEqual(plan.urls.map((entry) => entry.url), ['https://kwork.ru/projects']);
});

test('пустой выбор категорий — тоже общий список', () => {
  const plan = buildPollPlan({ base, allowedUrls: allowed, selection: [] });
  assert.equal(plan.mode, 'all');
  assert.deepEqual(plan.urls.map((entry) => entry.url), ['https://kwork.ru/projects']);
});

test('«все категории» — общий список', () => {
  const plan = buildPollPlan({ base, allowedUrls: allowed, selection: 'all' });
  assert.equal(plan.mode, 'all');
  assert.deepEqual(plan.urls.map((entry) => entry.url), ['https://kwork.ru/projects']);
});

test('выбранные категории дают запрос на каждую', () => {
  const plan = buildPollPlan({ base, allowedUrls: allowed, selection: [37, 79] });
  assert.equal(plan.mode, 'categories');
  assert.deepEqual(plan.urls.map((entry) => entry.url), [
    'https://kwork.ru/projects?c=37',
    'https://kwork.ru/projects?c=79'
  ]);
  // Категория каждого URL известна: пригодится для сообщений.
  assert.deepEqual(plan.urls.map((entry) => entry.categoryId), [37, 79]);
});

test('в план попадают только объявленные URL, остальные помечаются', () => {
  const narrow = [{ url: 'https://kwork.ru/projects?c=79', enabled: true }];
  const plan = buildPollPlan({ base, allowedUrls: narrow, selection: [37, 79] });

  assert.deepEqual(plan.urls.map((entry) => entry.url), ['https://kwork.ru/projects?c=79']);
  // 37 не объявлен — он не должен опрашиваться.
  assert.ok(
    plan.skipped.some((entry) => entry.url.includes('c=37') && entry.reason === 'url-not-declared'),
    `нет пометки о пропуске: ${JSON.stringify(plan.skipped)}`
  );
});

test('если выбранные категории не объявлены, опрашивается объявленное', () => {
  const narrow = [{ url: 'https://kwork.ru/projects?c=79', enabled: true }];
  const plan = buildPollPlan({ base, allowedUrls: narrow, selection: [46] });
  // Не остаёмся без запросов: лучше опросить объявленную категорию.
  assert.equal(plan.mode, 'declared');
  assert.deepEqual(plan.urls.map((entry) => entry.url), ['https://kwork.ru/projects?c=79']);
});

test('если общий список не объявлен, берутся объявленные URL', () => {
  const narrow = [{ url: 'https://kwork.ru/projects?c=38', enabled: true }];
  const plan = buildPollPlan({ base, allowedUrls: narrow, selection: null });
  assert.deepEqual(plan.urls.map((entry) => entry.url), ['https://kwork.ru/projects?c=38']);
});

test('план сохраняет глубину пагинации из объявленного URL', () => {
  const declared = [{ url: 'https://kwork.ru/projects?c=79', enabled: true, pages: 4, pagination: true }];
  const plan = buildPollPlan({ base, allowedUrls: declared, selection: [79] });
  assert.equal(plan.urls[0].pages, 4, 'иначе пагинация схлопнется до одной страницы');
  assert.equal(plan.urls[0].pagination, true);
});

test('скрытые URL не попадают в план', () => {
  const declared = [
    { url: 'https://kwork.ru/projects', enabled: false },
    { url: 'https://kwork.ru/projects?c=79', enabled: true }
  ];
  const plan = buildPollPlan({ base, allowedUrls: declared, selection: null });
  assert.deepEqual(plan.urls.map((entry) => entry.url), ['https://kwork.ru/projects?c=79']);
  assert.ok(plan.skipped.some((entry) => entry.url.endsWith('/projects')));
});

test('дубликаты категорий схлопываются', () => {
  const plan = buildPollPlan({ base, allowedUrls: allowed, selection: [79, 79, 37, 37] });
  assert.deepEqual(plan.urls.map((entry) => entry.url), [
    'https://kwork.ru/projects?c=37',
    'https://kwork.ru/projects?c=79'
  ]);
});

test('effectiveCategorySelection объединяет выбор получателей', () => {
  assert.equal(effectiveCategorySelection([]).source, 'none');
  assert.deepEqual(effectiveCategorySelection([[37], [79, 37]]).selection, [37, 79]);
  // Если кто-то выбрал «все категории» — опрашиваем общий список.
  assert.equal(effectiveCategorySelection([[37], 'all']).selection, 'all');
  assert.deepEqual(effectiveCategorySelection([[37], []]).selection, [37]);
});

test('/plan показывает план по выбранным категориям', async () => {
  const dirPlan = await dispatchCommand('/plan', { config, profile: null, texts });
  assert.match(dirPlan.reply, /План опроса:/);
  assert.match(dirPlan.reply, /все категории заданий/);
  assert.match(dirPlan.reply, /https:\/\/kwork\.ru\/projects — все категории заданий/);

  // Заглушка выбора категорий: как будто пользователь выбрал 37 и 79.
  const preferences = {
    effective: async () => ({ selection: [37, 79], source: 'personal' })
  };
  const withCategories = await dispatchCommand('/plan', {
    config,
    profile: null,
    categoriesPreferences: preferences,
    fromUserId: 111,
    texts
  });
  assert.match(withCategories.reply, /только выбранные категории/);
  assert.equal(withCategories.reply.includes('https://kwork.ru/projects?c=37'), true);
  assert.equal(withCategories.reply.includes('https://kwork.ru/projects?c=79'), true);
  // Общий список в этом режиме не опрашивается.
  assert.doesNotMatch(withCategories.reply, /• https:\/\/kwork\.ru\/projects — /);
});
