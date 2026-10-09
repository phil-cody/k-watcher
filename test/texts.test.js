import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTexts, format, deepMerge, pick, loadTextsJson } from '../src/texts/texts.js';
import { TEXT_CONTRACT, findPlaceholders, flattenKeys } from '../src/texts/contract.js';
import { KworkListingParser } from '../src/parser/job-parser.js';
import { analyzeAndDraft } from '../src/analysis/compose-analysis.js';
import { renderJobMessages, renderJobMessage } from '../src/telegram/format.js';
import { describePlan, buildStatusMessage, buildProfileMessage, dispatchCommand } from '../src/bot/kwork-watcher-bot.js';
import { buildDashboardHtml } from '../src/dashboard/server.js';
import { PollingScheduler } from '../src/scheduler/scheduler.js';
import { loadConfig } from '../src/config/load-config.js';
import { makeFixtureProfile, makeFixtureJob } from './helpers/text-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });

test('все ключи контракта присутствуют и не пусты', () => {
  const listPaths = new Set(TEXT_CONTRACT.lists.map((entry) => entry.path));
  for (const { path } of TEXT_CONTRACT.required) {
    const value = texts.raw(path);
    assert.ok(value !== undefined, `нет текста по пути ${path}`);
    if (listPaths.has(path)) continue; // списки проверяются отдельным тестом
    assert.equal(typeof value, 'string', `${path} должен быть строкой`);
    assert.ok(value.trim().length > 0, `${path} не должен быть пустым`);
  }
});

test('плейсхолдеры в текстах совпадают с ожиданиями кода', () => {
  for (const { path, placeholders = [] } of TEXT_CONTRACT.required) {
    const value = texts.raw(path);
    if (typeof value !== 'string') continue;
    const actual = findPlaceholders(value);
    assert.deepEqual(
      actual,
      [...placeholders].sort(),
      `у ${path} ожидались {${placeholders.join('}, {')}}, найдено {${actual.join('}, {')}}`
    );
  }
});

test('списки и словари текстов заполнены', () => {
  for (const { path } of TEXT_CONTRACT.lists) {
    const value = texts.raw(path);
    assert.ok(Array.isArray(value), `${path} должен быть массивом`);
    assert.ok(value.length > 0, `${path} не должен быть пустым`);
    for (const line of value) assert.equal(typeof line, 'string', `элемент ${path} должен быть строкой`);
  }
  for (const { path, keys } of TEXT_CONTRACT.maps) {
    const value = texts.raw(path);
    assert.ok(value && typeof value === 'object', `${path} должен быть объектом`);
    for (const key of keys) {
      assert.ok(typeof value[key] === 'string' && value[key].length > 0, `${path}.${key} отсутствует`);
    }
  }
});

test('в config/texts.json нет ключей, не упомянутых в контракте', () => {
  const contractPaths = new Set(TEXT_CONTRACT.required.map((entry) => entry.path));
  const allKeys = flattenKeys(texts.data);
  // Служебные разделы: meta (документация) и словари-структуры (проверяются по списку maps).
  // meta — документация самого файла, словари-структуры проверяются по списку maps.
  // meta — документация; остальное — словари-структуры и списки, они проверяются отдельно.
  const ignoredPrefixes = [
    'meta',
    'analysis.verdicts',
    'analysis.verdictLabels',
    'analysis.conclusions',
    'proposal.greetings',
    'model.prompt',
    'rates.components',
    'proposal.scopeItems',
    'proposal.exclusions',
    'proposal.acknowledge',
    'proposal.ready',
    'proposal.cta',
    'proposal.materialsQuestions',
    'proposal.closing',
    'proposal.sectionsCount',
    'commands.plan.pollPlanReasons',
    // Словари-структуры: наборы команд для меню Telegram.
    'commands.telegramMenu',
    'commands.telegramMenuOwner'
  ];
  const orphans = allKeys.filter(
    (key) =>
      !contractPaths.has(key) &&
      !ignoredPrefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))
  );
  assert.deepEqual(orphans, [], `в texts.json есть неиспользуемые ключи: ${orphans.join(', ')}`);
});

test('format подставляет параметры и не ломается без них', () => {
  assert.equal(format('Привет, {name}!', { name: 'мир' }), 'Привет, мир!');
  assert.equal(format('Счёт: {count}', {}), 'Счёт: {count}', 'незаполненный плейсхолдер остаётся видимым');
  assert.equal(format('{a}-{b}', { a: 1, b: null }), '1-{b}');
  assert.equal(format(null, {}), '');
});

test('local-файл переопределяет тексты поверх основного', () => {
  const dir = mkdtempSync(join(tmpdir(), 'texts-'));
  try {
    const overridePath = join(dir, 'texts.local.json');
    writeFileSync(
      overridePath,
      JSON.stringify({
        telegram: { newJobHeader: 'ПОЕХАЛИ' },
        logs: { cycleSummary: 'Итог: новых {newJobs}' }
      }),
      'utf8'
    );
    const custom = createTexts({ rootDir, overrideFile: overridePath });
    assert.equal(custom.t('telegram.newJobHeader'), 'ПОЕХАЛИ');
    assert.equal(custom.t('logs.cycleSummary', { newJobs: 5 }), 'Итог: новых 5');
    // Не переопределённые ключи остаются из основного файла.
    assert.equal(custom.t('telegram.sections.facts'), texts.t('telegram.sections.facts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ошибка в файле текстов сообщает путь, а не молчит', () => {
  const dir = mkdtempSync(join(tmpdir(), 'texts-'));
  try {
    const brokenPath = join(dir, 'broken.json');
    writeFileSync(brokenPath, '{ not json', 'utf8');
    assert.throws(() => loadTextsJson(brokenPath), /Не удалось прочитать файл текстов/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deepMerge и pick работают предсказуемо', () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
  assert.equal(pick({ x: { y: { z: 'ok' } } }, 'x.y.z'), 'ok');
  assert.equal(pick({ x: 1 }, 'x.y.z'), undefined);
  assert.equal(pick({}, ''), undefined);
});

test('в отрендеренных текстах не остаётся незаполненных плейсхолдеров', async () => {
  const profile = makeFixtureProfile();
  const job = makeFixtureJob();
  const analysis = await analyzeAndDraft(job, profile, { config: {} });
  const messages = renderJobMessages(job, analysis, { texts });

  const plan = describePlan(
    {
      source: { allowedUrls: [] },
      schedule: {
        timezone: 'Europe/Moscow',
        windowStart: '05:00',
        windowEnd: '20:00',
        minIntervalSeconds: 240,
        maxIntervalSeconds: 600
      },
      targetCategories: []
    },
    { texts }
  );
  const status = buildStatusMessage({
    store: {
      stats: {
        total: 1,
        keyTotal: 2,
        stableIdKeys: 1,
        urlKeys: 1,
        compositeKeys: 0,
        updatedAt: '2026-10-07T00:00:00.000Z'
      }
    },
    schedulerState: {
      status: 'running',
      pausedByUser: false,
      requestCount: 2,
      window: '05:00–20:00',
      timezone: 'Europe/Moscow',
      intervalSeconds: [240, 600],
      lastRequestAt: '2026-10-07T00:00:00.000Z',
      nextRequestAt: null,
      lastError: null,
      stopMessage: null,
      stopReason: null
    },
    lastSummary: { cardsFound: 12, inTargetCategories: 12, newJobs: 3, duplicates: 9, sent: 3, pruned: 1, activeJobs: 3 },
    modelInfo: 'heuristic',
    texts
  });
  const profileText = buildProfileMessage({ profile, config: { profilePath: 'config/performer-profile.json' }, texts });
  const dashboard = buildDashboardHtml({
    plan: [{ url: 'https://kwork.ru/projects?c=38', label: 'Категория 38', enabled: true }],
    schedule: { timezone: 'Europe/Moscow', windowStart: '05:00', windowEnd: '20:00', minIntervalSeconds: 240, maxIntervalSeconds: 600 },
    categories: [{ label: 'Вёрстка' }],
    profile,
    stats: { total: 1, keyTotal: 2, stableIdKeys: 1, urlKeys: 1, compositeKeys: 0, updatedAt: '2026-10-07T00:00:00.000Z' },
    state: { scheduler: { status: 'running' } },
    recent: [{ recordedAt: '2026-10-07T00:00:00.000Z', id: '1', title: 'Задание', payload: { verdict: 'возможно', notified: true } }],
    texts
  });
  const planCommand = dispatchCommand('/plan', {
    config: {
      source: { allowedUrls: [] },
      schedule: {
        timezone: 'Europe/Moscow',
        windowStart: '05:00',
        windowEnd: '20:00',
        minIntervalSeconds: 240,
        maxIntervalSeconds: 600
      },
      targetCategories: []
    },
    profile,
    texts
  });
  const scheduler = new PollingScheduler({
    schedule: { timezone: 'Europe/Moscow', windowStart: '05:00', windowEnd: '20:00', minIntervalSeconds: 240, maxIntervalSeconds: 600 },
    source: null,
    onCycle: async () => ({}),
    now: () => new Date('2026-10-07T07:00:00Z'),
    sleep: async () => {},
    texts
  });

  const rendered = [
    ...messages,
    renderJobMessage(job, analysis, { texts }),
    plan,
    status,
    profileText,
    dashboard,
    planCommand.reply,
    scheduler.describeState(),
    texts.lines('cli.help').join('\n'),
    texts.lines('commands.start', { headline: 'x', status: 'running' }).join('\n'),
    dispatchCommand('/resume', { config: { schedule: { minIntervalSeconds: 240, maxIntervalSeconds: 600, windowStart: '05:00', windowEnd: '20:00', timezone: 'Europe/Moscow' } }, texts }).reply
  ].join('\n');

  const lines = rendered.split('\n');
  const leftoverLines = lines.filter((line) => /\{[a-zA-Z][a-zA-Z0-9]*\}/.test(line));
  assert.deepEqual(leftoverLines, [], `в выводе остались незаполненные плейсхолдеры:\n${leftoverLines.join('\n')}`);
});

test('формулировки метрик не подменяют смысл чисел', async () => {
  // «Предложений к заданию» — это offersCount, «заказов у заказчика» — kworkCount.
  const job = makeFixtureJob({ extra: { status: 'active', offersCount: 7, kworkCount: 2, views: 10, maxDays: 5, timeLeft: '1 д.' } });
  const profile = makeFixtureProfile();
  const analysis = await analyzeAndDraft(job, profile, { config: {} });
  const message = renderJobMessage(job, analysis, { texts });

  assert.match(message, /предложений к заданию: 7/);
  assert.match(message, /заказов у заказчика: 2/);
  // Старая ошибочная формулировка («заказов: N» для числа предложений) не должна вернуться.
  assert.doesNotMatch(message, /заказов: 7/);
});

test('рабочий config/texts.json — валидный JSON и содержит обязательные разделы', () => {
  const raw = JSON.parse(readFileSync(resolve(rootDir, 'config', 'texts.json'), 'utf8'));
  const sections = ['meta', 'telegram', 'source', 'scheduler', 'logs', 'analysis', 'proposal', 'commands', 'cli', 'dashboard', 'parser'];
  for (const section of sections) {
    assert.ok(raw[section] && typeof raw[section] === 'object', `раздел ${section} отсутствует в texts.json`);
  }
  // Секретов в файле текстов быть не должно.
  const serialized = JSON.stringify(raw);
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]{10,}/);
  assert.doesNotMatch(serialized, /\d{6,}:[A-Za-z0-9_-]{20,}/);
});

test('конфиг умеет указать локальный файл текстов', () => {
  const { config } = loadConfig({ rootDir, env: { TEXTS_FILE: 'config/texts.local.json' }, readEnvFile: false });
  assert.equal(config.secrets.textsFile, 'config/texts.local.json');
  const { config: without } = loadConfig({ rootDir, env: {}, readEnvFile: false });
  assert.equal(without.secrets.textsFile, undefined);
});
