/**
 * Тесты плана опроса: какие URL запрашиваются в зависимости от выбранных категорий.
 *
 * Правила:
 *  - категории не выбраны  → один запрос на общий список (/projects);
 *  - «все категории»       → тоже общий список;
 *  - выбраны категории     → запрос на каждую (/projects?c=<id>);
 *  - допустим любой положительный числовой id: белого списка URL больше нет.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPollPlan, categoryUrl, allProjectsUrl, categoryIdOfUrl, effectiveCategorySelection } from '../src/source/poll-plan.js';
import { dispatchCommand } from '../src/bot/kwork-watcher-bot.js';
import { createTexts } from '../src/texts/texts.js';
import { loadConfig } from '../src/config/load-config.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });
const { config } = loadConfig({ rootDir, env: {}, readEnvFile: false });
const base = String(config.source.baseUrl).replace(/\/+$/, '');

test('вспомогательные функции строят корректные URL', () => {
  assert.equal(allProjectsUrl('https://kwork.ru'), 'https://kwork.ru/projects');
  assert.equal(allProjectsUrl('https://kwork.ru/'), 'https://kwork.ru/projects');
  assert.equal(categoryUrl('https://kwork.ru', 37), 'https://kwork.ru/projects?c=37');
  assert.equal(categoryIdOfUrl('https://kwork.ru/projects?c=79'), 79);
  assert.equal(categoryIdOfUrl('https://kwork.ru/projects'), null);
  assert.equal(categoryIdOfUrl('мусор'), null);
});

test('категории не выбраны — один запрос на общий список', () => {
  const plan = buildPollPlan({ base, selection: null });
  assert.equal(plan.mode, 'all');
  assert.deepEqual(plan.urls.map((entry) => entry.url), ['https://kwork.ru/projects']);
  assert.equal(plan.urls[0].categoryId, null);
});

test('пустой выбор категорий — тоже общий список', () => {
  const plan = buildPollPlan({ base, selection: [] });
  assert.equal(plan.mode, 'all');
  assert.deepEqual(plan.urls.map((entry) => entry.url), ['https://kwork.ru/projects']);
});

test('«все категории» — общий список', () => {
  const plan = buildPollPlan({ base, selection: 'all' });
  assert.equal(plan.mode, 'all');
  assert.deepEqual(plan.urls.map((entry) => entry.url), ['https://kwork.ru/projects']);
});

test('выбранные категории дают запрос на каждую', () => {
  const plan = buildPollPlan({ base, selection: [37, 79] });
  assert.equal(plan.mode, 'categories');
  assert.deepEqual(plan.urls.map((entry) => entry.url), [
    'https://kwork.ru/projects?c=37',
    'https://kwork.ru/projects?c=79'
  ]);
  assert.deepEqual(plan.urls.map((entry) => entry.categoryId), [37, 79]);
});

test('дубликаты и нечисловые значения схлопываются/отбрасываются', () => {
  const plan = buildPollPlan({ base, selection: [79, 79, 37, null, 'abc', -1] });
  assert.deepEqual(plan.urls.map((entry) => entry.url), [
    'https://kwork.ru/projects?c=37',
    'https://kwork.ru/projects?c=79'
  ]);
});

test('любой положительный id допустим — белого списка категорий нет', () => {
  // Категория приходит из каталога, но id 999 тоже даст корректный URL списка.
  const plan = buildPollPlan({ base, selection: [999] });
  assert.deepEqual(plan.urls.map((entry) => entry.url), ['https://kwork.ru/projects?c=999']);
});

test('effectiveCategorySelection объединяет выбор получателей', () => {
  assert.equal(effectiveCategorySelection([]).source, 'none');
  assert.deepEqual(effectiveCategorySelection([[37], [79, 37]]).selection, [37, 79]);
  assert.equal(effectiveCategorySelection([[37], 'all']).selection, 'all');
  assert.deepEqual(effectiveCategorySelection([[37], []]).selection, [37]);
});

test('/plan показывает план по выбранным категориям', async () => {
  const dirPlan = await dispatchCommand('/plan', { config, profile: null, texts });
  assert.match(dirPlan.reply, /План опроса:/);
  assert.match(dirPlan.reply, /все категории заданий/);
  assert.match(dirPlan.reply, /https:\/\/kwork\.ru\/projects — все категории заданий/);
  assert.match(dirPlan.reply, /Базовый список заданий: https:\/\/kwork\.ru\/projects/);

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
  assert.doesNotMatch(withCategories.reply, /• https:\/\/kwork\.ru\/projects — /);
});
