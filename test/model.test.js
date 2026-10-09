/**
 * Тесты модели: бюджет запросов, классификация ошибок провайдера и
 * выборочный вызов. Это защита бесплатных тарифов от выжигания квоты.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ModelUsageTracker, timeKeys } from '../src/analysis/model-usage.js';
import { createModelAdapter, classifyProviderStatus, parseModelJson } from '../src/analysis/model-adapter.js';
import { analyzeJob } from '../src/analysis/analyzer.js';
import { createTexts } from '../src/texts/texts.js';
import { makeFixtureJob, makeFixtureProfile } from './helpers/text-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });
const profile = makeFixtureProfile();

function okFetch(content = '{"summary":"ок","extraQuestions":[],"notes":[]}') {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => ''
  });
}

function failFetch(status, body = '') {
  return async () => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body
  });
}

function makeAdapter({ fetchImpl, model = {}, dataDir }) {
  return createModelAdapter({
    model: { provider: 'openai-compatible', ...model },
    secrets: { llmBaseUrl: 'https://example.invalid/v1', llmApiKey: 'test-key', llmModel: 'test-model' },
    logger: null,
    fetchImpl,
    texts,
    dataDir,
    timezone: 'Europe/Moscow'
  });
}

test('timeKeys считает сутки и час в заданном поясе', () => {
  const at = new Date('2026-10-08T21:30:00.000Z'); // 00:30 следующего дня в Москве
  const moscow = timeKeys(at, 'Europe/Moscow');
  assert.equal(moscow.day, '2026-10-09');
  assert.equal(moscow.hour, '2026-10-09T00');
  const utc = timeKeys(at, 'UTC');
  assert.equal(utc.day, '2026-10-08');
});

test('счётчик сбрасывается при смене суток и часа', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    const tracker = new ModelUsageTracker({ dataDir: dir, provider: 'openai-compatible', limits: { perDay: 5, perHour: 2 }, timezone: 'Europe/Moscow' });
    await tracker.init();
    await tracker.record({}, new Date('2026-10-08T06:00:00.000Z'));
    await tracker.record({}, new Date('2026-10-08T06:10:00.000Z'));
    assert.equal(tracker.snapshot.dayCount, 2);
    assert.equal(tracker.snapshot.hourCount, 2);

    // Новый час — часовой счётчик обнуляется, суточный остаётся.
    tracker.rollover(new Date('2026-10-08T07:05:00.000Z'));
    assert.equal(tracker.snapshot.dayCount, 2);
    assert.equal(tracker.snapshot.hourCount, 0);

    // Новые сутки — обнуляются оба.
    tracker.rollover(new Date('2026-10-09T07:05:00.000Z'));
    assert.equal(tracker.snapshot.dayCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('часовой лимит останавливает вызовы, суточный — тоже', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    const tracker = new ModelUsageTracker({ dataDir: dir, provider: 'openai-compatible', limits: { perDay: 3, perHour: 1 }, timezone: 'UTC' });
    await tracker.init();
    const now = new Date('2026-10-08T10:00:00.000Z');
    assert.equal(tracker.check(now).allowed, true);
    await tracker.record({}, now);
    const blockedHour = tracker.check(new Date('2026-10-08T10:30:00.000Z'));
    assert.equal(blockedHour.allowed, false);
    assert.equal(blockedHour.reason, 'hour');
    // Следующий час — снова можно, но суточный лимит ещё не исчерпан.
    assert.equal(tracker.check(new Date('2026-10-08T11:00:00.000Z')).allowed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('без лимитов бюджет не ограничивает', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    const tracker = new ModelUsageTracker({ dataDir: dir, provider: 'openai-compatible', limits: {}, timezone: 'UTC' });
    await tracker.init();
    for (let i = 0; i < 100; i += 1) await tracker.record({}, new Date('2026-10-08T10:00:00.000Z'));
    assert.equal(tracker.check().allowed, true);
    assert.equal(tracker.snapshot.remainingDay, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('исчерпанная квота не приводит к вызову провайдера', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    let calls = 0;
    const adapter = makeAdapter({
      model: { usage: { perDay: 1, perHour: 1 }, selective: { enabled: false } },
      dataDir: dir,
      fetchImpl: async (...args) => {
        calls += 1;
        return okFetch()(...args);
      }
    });
    await adapter.initUsage();
    const job = makeFixtureJob();
    const analysis = analyzeJob(job, profile, { texts });

    const first = await adapter.enrich(job, analysis, profile);
    assert.ok(first, 'первый вызов должен пройти');
    assert.equal(calls, 1);
    assert.equal(adapter.usage.dayCount, 1);

    const second = await adapter.enrich(job, analysis, profile);
    assert.equal(second, null, 'второй вызов должен быть пропущен по бюджету');
    assert.equal(calls, 1, 'провайдер не должен вызываться повторно');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('счётчик сохраняется между запусками', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    const first = new ModelUsageTracker({ dataDir: dir, provider: 'openai-compatible', limits: { perDay: 10 }, timezone: 'UTC' });
    await first.init();
    await first.record();
    const second = new ModelUsageTracker({ dataDir: dir, provider: 'openai-compatible', limits: { perDay: 10 }, timezone: 'UTC' });
    await second.init();
    assert.equal(second.snapshot.dayCount, 1, 'расход квоты переживает перезапуск');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('classifyProviderStatus различает лимит, ключ и отсутствие модели', () => {
  assert.equal(classifyProviderStatus(429, ''), 'rate-limit');
  assert.equal(classifyProviderStatus(200, 'RESOURCE_EXHAUSTED: quota exceeded'), 'rate-limit');
  assert.equal(classifyProviderStatus(401, 'invalid api key'), 'auth');
  assert.equal(classifyProviderStatus(403, 'permission denied'), 'auth');
  assert.equal(classifyProviderStatus(404, 'model not found'), 'model-not-found');
  assert.equal(classifyProviderStatus(400, 'maximum context length exceeded'), 'too-long');
  assert.equal(classifyProviderStatus(500, 'internal error'), 'provider-error');
});

test('429 от провайдера не роняет анализ и даёт понятное предупреждение', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    const warnings = [];
    const adapter = createModelAdapter({
      model: { provider: 'openai-compatible', selective: { enabled: false } },
      secrets: { llmBaseUrl: 'https://example.invalid/v1', llmApiKey: 'k', llmModel: 'm' },
      logger: { warn: (message, meta) => warnings.push({ message, meta }), info: () => {}, error: () => {}, debug: () => {} },
      fetchImpl: failFetch(429, 'rate limit exceeded'),
      texts,
      dataDir: dir
    });
    await adapter.initUsage();
    const job = makeFixtureJob();
    const analysis = analyzeJob(job, profile, { texts });
    const result = await adapter.enrich(job, analysis, profile);

    assert.equal(result, null, 'при 429 дополнения нет');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /лимитом \(429\)/);
    assert.equal(warnings[0].meta.kind, 'rate-limit');
    // Неудачный запрос не должен считаться израсходованной квотой.
    assert.equal(adapter.usage.dayCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ошибка ключа подсказывает проверить LLM_API_KEY', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    const warnings = [];
    const adapter = createModelAdapter({
      model: { provider: 'openai-compatible', selective: { enabled: false } },
      secrets: { llmBaseUrl: 'https://example.invalid/v1', llmApiKey: 'bad', llmModel: 'm' },
      logger: { warn: (message) => warnings.push(message), info: () => {}, error: () => {}, debug: () => {} },
      fetchImpl: failFetch(401, 'invalid api key'),
      texts,
      dataDir: dir
    });
    await adapter.initUsage();
    await adapter.enrich(makeFixtureJob(), analyzeJob(makeFixtureJob(), profile, { texts }), profile);
    assert.match(warnings[0], /LLM_API_KEY/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('выборочный режим не тратит квоту на понятные задания', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    let calls = 0;
    const adapter = makeAdapter({
      model: { selective: { enabled: true, mode: 'uncertain' } },
      dataDir: dir,
      fetchImpl: async (...args) => {
        calls += 1;
        return okFetch()(...args);
      }
    });
    await adapter.initUsage();

    // Уверенное совпадение — модель не нужна.
    const clearJob = makeFixtureJob();
    const clearAnalysis = { verdict: 'подходит', risks: [], unknown: [] };
    assert.equal(adapter.shouldEnrich(clearJob, clearAnalysis), false);

    // Неуверенность — модель поможет.
    assert.equal(adapter.shouldEnrich(clearJob, { verdict: 'нужно уточнить', risks: [], unknown: [] }), true);
    assert.equal(adapter.shouldEnrich(clearJob, { verdict: 'подходит', risks: [{ code: 'vague_scope' }], unknown: [] }), true);
    assert.equal(adapter.shouldEnrich(clearJob, { verdict: 'подходит', risks: [], unknown: ['budget'] }), true);

    // Режим always вызывает всегда.
    const always = makeAdapter({ model: { selective: { enabled: true, mode: 'always' } }, dataDir: dir, fetchImpl: okFetch() });
    assert.equal(always.shouldEnrich(clearJob, clearAnalysis), true);
    assert.equal(calls, 0, 'shouldEnrich не должен сам делать запросы');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('эвристика не делает сетевых вызовов, даже если передан fetch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    let calls = 0;
    const adapter = createModelAdapter({
      model: { provider: 'heuristic' },
      secrets: {},
      logger: null,
      fetchImpl: async () => {
        calls += 1;
        return okFetch()();
      },
      texts,
      dataDir: dir
    });
    const job = makeFixtureJob();
    const analysis = analyzeJob(job, profile, { texts });
    assert.equal(adapter.shouldEnrich(job, analysis), false);
    assert.equal(await adapter.enrich(job, analysis, profile), null);
    assert.equal(calls, 0);
    // В режиме эвристики файл расхода не создаётся — считать нечего.
    await adapter.initUsage();
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(dir, 'model-usage.json')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseModelJson разбирает ответ в ограждении и терпит лишний текст', () => {
  assert.deepEqual(parseModelJson('```json\n{"summary":"a"}\n```'), { summary: 'a' });
  assert.deepEqual(parseModelJson('Вот результат: {"summary":"b"} — готово'), { summary: 'b' });
  assert.equal(parseModelJson('не json'), null);
  assert.equal(parseModelJson(''), null);
});

test('в /status видно расход квоты модели', async () => {
  const { buildStatusMessage } = await import('../src/bot/kwork-watcher-bot.js');
  const message = buildStatusMessage({
    store: null,
    schedulerState: null,
    modelInfo: 'openai-compatible',
    modelUsage: { dayCount: 12, hourCount: 3, limits: { perDay: 200, perHour: 20 } },
    texts
  });
  assert.match(message, /Модель: запросов за сутки 12 из 200, за час 3 из 20/);
});

test('в /status при отсутствии лимитов пишется «без лимита»', async () => {
  const { buildStatusMessage } = await import('../src/bot/kwork-watcher-bot.js');
  const message = buildStatusMessage({
    store: null,
    schedulerState: null,
    modelInfo: 'openai-compatible',
    modelUsage: { dayCount: 5, hourCount: 1, limits: { perDay: null, perHour: null } },
    texts
  });
  // Простой поиск подстроки: понятнее и не зависит от экранирования в регэкспе.
  assert.equal(message.includes("за сутки 5 (без лимита)"), true, message);
});


test('расход токенов учитывается по ответу провайдера', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    const adapter = makeAdapter({
      model: { selective: { enabled: false } },
      dataDir: dir,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          choices: [{ message: { content: '{"summary":"ок","extraQuestions":[],"notes":[]}' } }],
          usage: { prompt_tokens: 1200, completion_tokens: 300 }
        })
      })
    });
    await adapter.initUsage();
    const job = makeFixtureJob();
    await adapter.enrich(job, analyzeJob(job, profile, { texts }), profile);

    const usage = adapter.usage;
    assert.equal(usage.totalCalls, 1);
    assert.equal(usage.tokens.todayIn, 1200);
    assert.equal(usage.tokens.todayOut, 300);
    assert.equal(usage.tokens.total, 1500);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('токены суммируются за несколько вызовов и хранятся между запусками', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    const makeOne = (tokensIn, tokensOut) =>
      makeAdapter({
        model: { selective: { enabled: false } },
        dataDir: dir,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            choices: [{ message: { content: '{"summary":"ок"}' } }],
            usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut }
          })
        })
      });
    const job = makeFixtureJob();
    const analysis = analyzeJob(job, profile, { texts });

    const first = makeOne(100, 20);
    await first.initUsage();
    await first.enrich(job, analysis, profile);
    await first.enrich(job, analysis, profile);

    // Новый процесс читает сохранённый расход.
    const second = makeOne(50, 10);
    await second.initUsage();
    const before = second.usage;
    assert.equal(before.totalCalls, 2, 'вызовы переживают перезапуск');
    assert.equal(before.tokens.totalIn, 200);
    assert.equal(before.tokens.totalOut, 40);

    await second.enrich(job, analysis, profile);
    const after = second.usage;
    assert.equal(after.totalCalls, 3);
    assert.equal(after.tokens.totalIn, 250);
    assert.equal(after.tokens.total, 250 + 50);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('провайдер без usage не ломает учёт: считаются только вызовы', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    const adapter = makeAdapter({
      model: { selective: { enabled: false } },
      dataDir: dir,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: '{"summary":"ок"}' } }] })
      })
    });
    await adapter.initUsage();
    const job = makeFixtureJob();
    await adapter.enrich(job, analyzeJob(job, profile, { texts }), profile);

    const usage = adapter.usage;
    assert.equal(usage.totalCalls, 1);
    assert.equal(usage.tokens.total, 0);
    assert.equal(usage.tokens.todayIn, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('токены за сутки сбрасываются, всего за всё время — нет', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  try {
    const tracker = new ModelUsageTracker({
      dataDir: dir,
      provider: 'openai-compatible',
      limits: { perDay: null, perHour: null },
      timezone: 'UTC'
    });
    await tracker.init();
    await tracker.record({ tokensIn: 100, tokensOut: 50 }, new Date('2026-10-08T10:00:00.000Z'));
    await tracker.record({ tokensIn: 200, tokensOut: 60 }, new Date('2026-10-08T12:00:00.000Z'));
    assert.equal(tracker.snapshot.tokens.todayIn, 300);
    assert.equal(tracker.snapshot.tokens.total, 410);

    // Новые сутки: суточные счётчики обнуляются.
    tracker.rollover(new Date('2026-10-09T09:00:00.000Z'));
    const snapshot = tracker.snapshot;
    assert.equal(snapshot.tokens.todayIn, 0);
    assert.equal(snapshot.tokens.todayOut, 0);
    assert.equal(snapshot.tokens.totalIn, 300, 'общий расход сохраняется');
    assert.equal(snapshot.tokens.total, 410);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/usage показывает пользователей, задания, расход модели и токены', async () => {
  const { buildUsageMessage } = await import('../src/bot/kwork-watcher-bot.js');
  const { TelegramState } = await import('../src/telegram/state.js');
  const { ProfileStore } = await import('../src/storage/profile-store.js');
  const { CategoryPreferences, createCategoryCatalog } = await import('../src/storage/category-store.js');
  const { loadConfig } = await import('../src/config/load-config.js');
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const here2 = dirname(fileURLToPath(import.meta.url));
  const root2 = resolve(here2, '..');
  const { config: cfg } = loadConfig({ rootDir: root2, env: {}, readEnvFile: false });

  const dir = await mkdtemp(join(tmpdir(), 'usage-msg-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    state.rememberUser({ userId: 111, chatId: 111 });
    state.approveUser(111);
    state.rememberUser({ userId: 222, chatId: 222 });
    state.approveUser(222);
    state.approveUser(333);

    const profiles = new ProfileStore({ dataDir: dir });
    await profiles.save(111, profile);
    await profiles.save(222, profile);
    const categories = new CategoryPreferences({ dataDir: dir, catalog: createCategoryCatalog(cfg) });
    await categories.set(111, [37]);

    const message = await buildUsageMessage({
      store: {
        stats: { total: 35 },
        readState: async () => ({
          metrics: {
            cycles: 10,
            requests: 40,
            pages: 52,
            cards: 380,
            newJobs: 90,
            duplicates: 290,
            sentMessages: 180,
            errors: 1,
            warnings: 4,
            reminders: 2,
            firstRunAt: '2026-10-01T02:00:00.000Z',
            lastRunAt: '2026-10-08T06:00:00.000Z'
          }
        })
      },
      telegramState: state,
      profiles,
      categories,
      modelInfo: 'openai-compatible',
      modelUsage: {
        dayCount: 12,
        hourCount: 3,
        limits: { perDay: 200, perHour: 20 },
        totalCalls: 500,
        tokens: { todayIn: 1000, todayOut: 200, totalIn: 5000, totalOut: 1000, total: 6000 }
      },
      texts
    });

    assert.match(message, /Использование приложения/);
    assert.match(message, /Подключено пользователей: 3, владелец id 111/);
    assert.match(message, /Профили загружены: 2 из 3/);
    assert.match(message, /Свои категории выбрали: 1 из 3/);
    assert.match(message, /сейчас в списке 35/);
    assert.match(message, /циклов 10, запросов к Kwork 40/);
    assert.match(message, /вызовов за сутки 12 из 200, за час 3 из 20, всего вызовов 500/);
    assert.match(message, /Токены: сегодня 1000 вход \/ 200 выход, всего 5000 \/ 1000 \(сумма 6000\)/);
    assert.match(message, /Ошибок за всё время: 1, предупреждений: 4/);
    assert.match(message, /Напоминаний о профиле отправлено: 2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/usage сообщает об отсутствии данных до первого цикла', async () => {
  const { buildUsageMessage } = await import('../src/bot/kwork-watcher-bot.js');
  const message = await buildUsageMessage({
    store: { stats: { total: 0 }, readState: async () => ({}) },
    telegramState: null,
    modelInfo: 'heuristic',
    texts
  });
  assert.match(message, /Данных пока нет/);
  // Для эвристики про токены не пишем: расхода нет.
  assert.doesNotMatch(message, /Токены:/);
});

test('/usage говорит, что провайдер не сообщает токены', async () => {
  const { buildUsageMessage } = await import('../src/bot/kwork-watcher-bot.js');
  const message = await buildUsageMessage({
    store: null,
    telegramState: null,
    modelInfo: 'openai-compatible',
    modelUsage: { dayCount: 1, hourCount: 1, limits: { perDay: null, perHour: null }, totalCalls: 1, tokens: { total: 0, todayIn: 0, todayOut: 0 } },
    texts
  });
  assert.match(message, /провайдер не сообщает расход/);
});


test('/usage при подключённой модели показывает её, а не heuristic', async () => {
  const { buildUsageMessage } = await import('../src/bot/kwork-watcher-bot.js');
  const { createModelAdapter } = await import('../src/analysis/model-adapter.js');
  const adapter = createModelAdapter({
    model: { provider: 'openai-compatible' },
    secrets: { llmBaseUrl: 'https://example.invalid/v1', llmApiKey: 'k', llmModel: 'deepseek-chat' },
    dataDir: tmpdir()
  });
  const message = await buildUsageMessage({ store: null, telegramState: null, modelInfo: adapter.label, texts });
  assert.match(message, /Модель: openai-compatible · deepseek-chat/);
  assert.doesNotMatch(message, /heuristic/);
});

test('/usage показывает подключённую модель, а не heuristic', async () => {
  const { buildUsageMessage } = await import('../src/bot/kwork-watcher-bot.js');
  const message = await buildUsageMessage({
    store: null,
    telegramState: null,
    modelInfo: 'openai-compatible · deepseek-chat',
    modelUsage: {
      dayCount: 3,
      hourCount: 1,
      limits: { perDay: 200, perHour: 20 },
      totalCalls: 3,
      tokens: { todayIn: 100, todayOut: 20, totalIn: 100, totalOut: 20, total: 120 }
    },
    texts
  });
  // Строка «Модель: …» содержит провайдера и имя модели.
  assert.match(message, /Модель: openai-compatible · deepseek-chat/);
  assert.match(message, /deepseek-chat/);
  assert.doesNotMatch(message, /Модель: heuristic/);
});

test('подпись модели собирается из провайдера и имени', async () => {
  const { createModelAdapter } = await import('../src/analysis/model-adapter.js');
  const heuristic = createModelAdapter({ model: { provider: 'heuristic' }, secrets: {}, dataDir: tmpdir() });
  assert.equal(heuristic.label, 'heuristic');

  const openai = createModelAdapter({
    model: { provider: 'openai-compatible' },
    secrets: { llmBaseUrl: 'https://x/v1', llmApiKey: 'k', llmModel: 'gemini-2.5-flash' },
    dataDir: tmpdir()
  });
  assert.equal(openai.model, 'gemini-2.5-flash');
  assert.equal(openai.label, 'openai-compatible · gemini-2.5-flash');

  const anthropic = createModelAdapter({
    model: { provider: 'anthropic' },
    secrets: { anthropicApiKey: 'k', anthropicModel: 'claude-3-5-haiku-latest' },
    dataDir: tmpdir()
  });
  assert.equal(anthropic.label, 'anthropic · claude-3-5-haiku-latest');
});

test('сетевые ошибки Telegram описываются с причиной, а не «fetch failed»', async () => {
  const { describeNetworkError, longPollTimeoutMs } = await import('../src/telegram/client.js');
  // Таймаут клиента заметно больше времени long polling.
  assert.ok(longPollTimeoutMs(30) >= 45_000, 'запас должен быть не меньше 15 секунд');

  const wrapped = new TypeError('fetch failed');
  wrapped.cause = Object.assign(new Error('connect ECONNREFUSED 149.154.167.220:443'), { code: 'ECONNREFUSED' });
  const described = describeNetworkError(wrapped);
  assert.equal(described.reason.includes('fetch failed'), false, 'технический текст не должен попадать в лог');
  assert.match(described.reason, /ECONNREFUSED/);
  assert.equal(described.code, 'ECONNREFUSED');

  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  assert.match(describeNetworkError(abort).reason, /таймаут/);
});
