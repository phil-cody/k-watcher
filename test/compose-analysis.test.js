/**
 * Сборка анализа: расширенные полномочия модели и правило «черновик только для
 * подходящих заданий».
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createTexts } from '../src/texts/texts.js';
import { analyzeAndDraft } from '../src/analysis/compose-analysis.js';
import { createModelAdapter } from '../src/analysis/model-adapter.js';
import { makeFixtureJob, makeFixtureProfile } from './helpers/text-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });
const profile = makeFixtureProfile();

/** Фейковый адаптер модели с заданными полями ответа. */
function fakeModelAdapter(overrides = {}) {
  return {
    shouldEnrich: () => true,
    enrich: async () => ({
      provider: 'openai-compatible',
      verdict: null,
      summary: null,
      questions: [],
      conditions: [],
      draft: null,
      notes: [],
      ...overrides
    })
  };
}

test('модель дополняет вердикт, вопросы, условия и черновик', async () => {
  const job = makeFixtureJob();
  const result = await analyzeAndDraft(job, profile, {
    modelAdapter: fakeModelAdapter({
      verdict: 'возможно',
      summary: 'Суммари модели',
      questions: ['Вопрос модели 1'],
      conditions: ['Условие модели 1'],
      draft: 'Черновик модели'
    }),
    config: { rootDir },
    texts
  });
  assert.equal(result.verdict, 'возможно');
  assert.deepEqual(result.questions, ['Вопрос модели 1']);
  assert.deepEqual(result.conditions, ['Условие модели 1']);
  assert.equal(result.draft.text, 'Черновик модели');
  assert.equal(result.modelUsed, true);
});

test('для «не подходит» черновик не готовится', async () => {
  const job = { ...makeFixtureJob(), title: 'Backend', description: 'Нужен backend и API с базой данных Postgres' };
  const result = await analyzeAndDraft(job, profile, { modelAdapter: null, config: { rootDir }, texts });
  assert.equal(result.verdict, 'не подходит');
  assert.equal(result.draft, null);
});

test('модель не поднимает «не подходит» до «подходит» при блокирующем риске', async () => {
  const job = { ...makeFixtureJob(), title: 'Backend', description: 'Нужен backend и API с базой данных Postgres' };
  const result = await analyzeAndDraft(job, profile, {
    modelAdapter: fakeModelAdapter({ verdict: 'подходит', draft: 'Не должен попасть в результат' }),
    config: { rootDir },
    texts
  });
  assert.equal(result.verdict, 'не подходит', 'блокирующий риск не перекрывается моделью');
  assert.equal(result.draft, null, 'для «не подходит» черновик не пишется даже при наличии черновика модели');
});

test('реальный адаптер не вызывает модель для «не подходит»', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compose-'));
  try {
    let fetchCalls = 0;
    const adapter = createModelAdapter({
      model: { provider: 'openai-compatible' },
      secrets: { llmBaseUrl: 'https://example.invalid/v1', llmApiKey: 'k', llmModel: 'm' },
      logger: null,
      fetchImpl: async () => {
        fetchCalls += 1;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"summary":"x"}' } }] }), text: async () => '' };
      },
      texts,
      dataDir: dir,
      timezone: 'Europe/Moscow'
    });
    const job = { ...makeFixtureJob(), title: 'Backend', description: 'Нужен backend и API с базой данных Postgres' };
    const result = await analyzeAndDraft(job, profile, { modelAdapter: adapter, config: { rootDir }, texts });
    assert.equal(result.verdict, 'не подходит');
    assert.equal(result.draft, null);
    assert.equal(fetchCalls, 0, 'модель не вызывается для «не подходит»');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
