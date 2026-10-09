import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { JobStore } from '../src/storage/job-store.js';
import { KworkListingParser } from '../src/parser/job-parser.js';
import { createCycleRunner } from '../src/scheduler/cycle.js';
import { analyzeAndDraft } from '../src/analysis/compose-analysis.js';
import { renderJobMessage } from '../src/telegram/format.js';
import { SourceError } from '../src/source/kwork-html-source.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const config = JSON.parse(readFileSync(resolve(rootDir, 'config', 'default.json'), 'utf8'));
const profile = JSON.parse(readFileSync(resolve(rootDir, 'config', 'performer-profile.json'), 'utf8'));
const fixture = (name) => readFileSync(resolve(here, 'fixtures', name), 'utf8');

function makeSource(htmlOrMap) {
  const map = typeof htmlOrMap === 'string' ? { '*': htmlOrMap } : htmlOrMap;
  return {
    fetchPage: async (url) => {
      const html = map[url] ?? map['*'];
      if (html === undefined) throw new Error(`Неожиданный URL в тесте: ${url}`);
      return { html, status: 200, url, fetchedAt: new Date().toISOString(), bytes: html.length };
    }
  };
}

function makeNotifier({ failTimes = 0 } = {}) {
  const sent = [];
  let failures = failTimes;
  return {
    sent,
    async sendMessage(text) {
      if (failures > 0) {
        failures -= 1;
        throw new Error('Telegram недоступен');
      }
      sent.push(text);
      return { message_id: sent.length };
    }
  };
}

/**
 * Нотификатор, у которого «падает» отправка целого задания: все части одного
 * сообщения имеют одинаковую подпись, ошибка повторяется для каждой части.
 */
function makeJobFailingNotifier({ failJobs = 1 } = {}) {
  const sent = [];
  let failedJobs = 0;
  let currentJob = null;
  let currentFailed = false;
  return {
    sent,
    async sendMessage(text) {
      const jobId = /projects\/(\d+)/.exec(text)?.[1] ?? null;
      if (jobId !== currentJob) {
        currentJob = jobId;
        currentFailed = false;
      }
      if (!currentFailed && failedJobs < failJobs) {
        failedJobs += 1;
        currentFailed = true;
      }
      if (currentFailed) throw new Error('Telegram недоступен');
      sent.push(text);
      return { message_id: sent.length };
    }
  };
}

/** Конфиг теста: baseUrl задаёт адрес списка заданий, категории добавляются параметром c. */
function makeRunnerConfig(dir) {
  return {
    ...config,
    dataDir: dir,
    source: {
      ...config.source,
      baseUrl: 'https://kwork.ru'
    }
  };
}

async function makeRunner({ html, notifier, logger = null, configPatch = {}, source = null }) {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-cycle-'));
  const store = await new JobStore({ dataDir: dir }).init();
  const parser = new KworkListingParser({ targetCategories: config.targetCategories });
  const base = makeRunnerConfig(dir);
  // source мержим вложенно: иначе патч одного поля затирает pagination/allowedUrls.
  const merged = {
    ...base,
    ...configPatch,
    source: {
      ...base.source,
      ...(configPatch.source ?? {}),
      // Вложенные объекты мержим отдельно: иначе патч одного поля затирает остальные.
      pagination: { ...(base.source.pagination ?? {}), ...(configPatch.source?.pagination ?? {}) },
      categoryMapping: { ...(base.source.categoryMapping ?? {}), ...(configPatch.source?.categoryMapping ?? {}) }
    },
    categoryMapping: { ...(base.categoryMapping ?? {}), ...(configPatch.categoryMapping ?? {}) }
  };
  const runner = createCycleRunner({
    source: source ?? makeSource(html),
    parser,
    store,
    profile,
    notifier,
    config: merged,
    logger
  });
  return { dir, store, runner, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Логгер в массив строк — для проверки сообщений. */
function makeCapturingLogger() {
  const lines = [];
  const push = (level) => (message, meta) => lines.push(`[${level}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  return {
    lines,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error')
  };
}

test('карточка обрабатывается один раз, повторный цикл не создаёт дубликат', async () => {
  const html = fixture('listing-standard.html');
  const notifier = makeNotifier();
  const { runner, store, cleanup } = await makeRunner({ html, notifier });
  try {
    const first = await runner.runOnce();
    assert.equal(first.cardsFound, 3);
    assert.equal(first.newJobs, 3);
    assert.equal(first.sent, 3, 'уведомление должно уйти по каждой новой карточке');
    assert.ok(notifier.sent.length >= 3, 'длинное сообщение может быть разбито на несколько частей');
    const messagesAfterFirstRun = notifier.sent.length;

    const second = await runner.runOnce();
    assert.equal(second.newJobs, 0);
    assert.equal(second.duplicates, 3, 'все карточки должны быть распознаны как повторные');
    assert.equal(notifier.sent.length, messagesAfterFirstRun, 'повторный цикл не должен ничего отправлять');

    const third = await runner.runOnce();
    assert.equal(third.duplicates, 3);
    assert.equal(notifier.sent.length, messagesAfterFirstRun);
    assert.equal(store.stats.total, 3, 'в хранилище ровно три задания');
  } finally {
    await cleanup();
  }
});

test('без подтверждённого маппинга категорий данные не отбрасываются молча', async () => {
  const html = fixture('listing-missing-fields.html');
  const notifier = makeNotifier();
  const dir = await mkdtemp(join(tmpdir(), 'kwork-cycle-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    const parser = new KworkListingParser({ targetCategories: config.targetCategories });
    const runner = createCycleRunner({
      source: makeSource(html),
      parser,
      store,
      profile,
      notifier,
      config: { ...makeRunnerConfig(dir), categoryMapping: { confirmed: false, byCategoryId: {}, byCategoryLinkId: {} } },
      logger: null
    });
    const summary = await runner.runOnce();
    assert.equal(summary.cardsFound, 2);
    assert.equal(summary.categoryFilterConfirmed, false);
    // Отбор делает персональный фильтр категорий, а не глобальный список:
    // при неподтверждённом маппинге ничего не отбрасывается.
    assert.equal(summary.outOfTargetCategories, 0, 'при неподтверждённом маппинге ничего не отбрасывается');
    assert.equal(summary.newJobs, 2, 'оба задания уходят с пометкой о неподтверждённой категории');
    assert.equal(summary.uncategorized.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('при подтверждённом маппинге карточки вне выбранных категорий не отправляются', async () => {
  const html = fixture('listing-missing-fields.html');
  const notifier = makeNotifier();
  const dir = await mkdtemp(join(tmpdir(), 'kwork-cycle-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    const parser = new KworkListingParser({ targetCategories: config.targetCategories });
    const runner = createCycleRunner({
      source: makeSource(html),
      parser,
      store,
      profile,
      notifier,
      config: {
        ...makeRunnerConfig(dir),
        categoryMapping: { confirmed: true, byCategoryId: {}, byCategoryLinkId: {} }
      },
      logger: null
    });
    const summary = await runner.runOnce();
    assert.equal(summary.categoryFilterConfirmed, true);
    assert.equal(summary.inTargetCategories, 1, '«Сбор данных с сайта» не входит в выбранные категории');
    assert.equal(summary.outOfTargetCategories, 1);
    assert.equal(summary.newJobs, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('сбой отправки не приводит к потере задания: следующий цикл отправляет его снова', async () => {
  const html = fixture('listing-standard.html');
  const notifier = makeJobFailingNotifier({ failJobs: 1 });
  const { runner, store, cleanup } = await makeRunner({ html, notifier });
  try {
    const first = await runner.runOnce();
    assert.equal(first.sent, 2, 'два задания отправлены, одно не удалось');
    assert.equal(first.pending, 1, 'неотправленное задание поставлено в очередь');
    assert.ok(first.errors.some((error) => /Не удалось отправить/.test(error)));
    assert.equal(store.stats.total, 2, 'неотправленное задание не считается обработанным');

    const second = await runner.runOnce();
    assert.equal(second.retried, 1, 'очередь досылается в начале следующего цикла');
    assert.equal(store.stats.total, 3, 'после успешной отправки задание записывается');
    const state = await store.readState();
    assert.deepEqual(state.pendingNotifications ?? [], [], 'очередь пуста после успешной досылки');
  } finally {
    await cleanup();
  }
});

test('если Telegram недоступен, уведомления не теряются и не растут бесконечно', async () => {
  const html = fixture('listing-standard.html');
  const notifier = makeJobFailingNotifier({ failJobs: 99 });
  const { runner, store, cleanup } = await makeRunner({ html, notifier });
  try {
    const first = await runner.runOnce();
    assert.equal(first.sent, 0);
    assert.equal(first.pending, 3, 'все задания остаются в очереди');

    const second = await runner.runOnce();
    assert.equal(second.retried, 0, 'доставить по-прежнему не удалось');
    assert.equal(second.sent, 0);
    assert.equal(second.duplicates, 0, 'задания не записаны как обработанные');
    const state = await store.readState();
    assert.ok(state.pendingNotifications.length <= 50, 'очередь ограничена по размеру');
  } finally {
    await cleanup();
  }
});

test('страница без разобранных карточек помечается как structureOk=false', async () => {
  const notifier = makeNotifier();
  const { runner, cleanup } = await makeRunner({ html: '<html><body><main></main></body></html>', notifier });
  try {
    const summary = await runner.runOnce();
    assert.equal(summary.structureOk, false);
    assert.equal(summary.newJobs, 0);
    assert.ok(summary.errors.some((error) => /ни одной карточки/.test(error)));
  } finally {
    await cleanup();
  }
});

test('каждая ошибка цикла расшифровывается в логе', async () => {
  const lines = [];
  const logger = {
    debug: () => {},
    info: (message, meta) => lines.push({ level: 'info', message, meta }),
    warn: (message, meta) => lines.push({ level: 'warn', message, meta }),
    error: (message, meta) => lines.push({ level: 'error', message, meta })
  };
  const { runner, cleanup } = await makeRunner({
    html: '<html><body><main></main></body></html>',
    notifier: makeNotifier(),
    logger
  });
  try {
    const summary = await runner.runOnce();
    assert.ok(summary.errors.length > 0, 'ожидалась хотя бы одна ошибка');
    const explained = lines.filter((line) => /^Ошибка цикла: /.test(line.message));
    assert.equal(explained.length, summary.errors.length, 'на каждую ошибку — одна расшифровка');
    assert.ok(
      explained.some((line) => /ни одной карточки/.test(line.message)),
      `расшифровка должна быть понятной: ${explained.map((line) => line.message).join(' | ')}`
    );
    // Сводка остаётся одной строкой и содержит счётчики.
    assert.equal(lines.filter((line) => /Цикл завершён/.test(line.message)).length, 1);
    assert.equal(lines.find((line) => /Цикл завершён/.test(line.message)).meta.errors, summary.errors.length);
  } finally {
    await cleanup();
  }
});

test('предупреждения цикла печатаются отдельно от ошибок', async () => {
  const lines = [];
  const logger = {
    debug: () => {},
    info: (message, meta) => lines.push({ level: 'info', message, meta }),
    warn: (message, meta) => lines.push({ level: 'warn', message, meta }),
    error: (message, meta) => lines.push({ level: 'error', message, meta })
  };
  const { runner, cleanup } = await makeRunner({ html: fixture('listing-embedded-json.html'), notifier: makeNotifier(), logger });
  try {
    await runner.runOnce();
    // В фикстуре нет объявленного total, поэтому предупреждений нет — но разделение уровней проверяем.
    const warnings = lines.filter((line) => /^Предупреждение цикла: /.test(line.message));
    const errors = lines.filter((line) => /^Ошибка цикла: /.test(line.message));
    for (const line of warnings) assert.equal(line.level, 'warn');
    for (const line of errors) assert.equal(line.level, 'error');
  } finally {
    await cleanup();
  }
});

test('страница с CAPTCHA останавливает цикл ошибкой', async () => {
  const notifier = makeNotifier();
  const { runner, cleanup } = await makeRunner({ html: fixture('page-captcha.html'), notifier });
  try {
    await assert.rejects(() => runner.runOnce(), /признаки блокировки\/CAPTCHA/);
  } finally {
    await cleanup();
  }
});

test('в сообщении по каждому новому заданию есть черновик и пометка о ручной проверке', async () => {
  const html = fixture('listing-standard.html');
  const notifier = makeNotifier();
  const { runner, cleanup } = await makeRunner({ html, notifier });
  try {
    await runner.runOnce();
    // Длинные сообщения разбиваются на части: проверяем текст каждого задания целиком.
    const messages = splitJobsMessages(notifier.sent);
    assert.equal(
      messages.length,
      3,
      `по каждой карточке должен быть сформирован текст; частей ${notifier.sent.length}: ${notifier.sent.map((p) => p.slice(0, 30)).join(' || ')}`
    );
    for (const message of messages) {
      assert.match(message, /📌 <b>Факты из карточки<\/b>/);
      assert.match(message, /🧭 <b>Вывод<\/b>/);
      assert.match(message, /❓ <b>Неизвестно<\/b>/);
      assert.match(message, /✍️ <b>Черновик отклика<\/b> \(только для ручной проверки, на Kwork не отправлен\)/);
      assert.match(message, /На Kwork ничего не отправлено/);
      // Разметка должна быть корректной: без незакрытых тегов.
      assert.equal((message.match(/<b>/g) ?? []).length, (message.match(/<\/b>/g) ?? []).length);
    }
    assert.ok(
      notifier.sent.every((part) => part.length <= 4096),
      'каждая часть должна укладываться в лимит Telegram'
    );
  } finally {
    await cleanup();
  }
});

/** Склейка частей одного задания: начало задания помечено «🔔 Новое задание Kwork». */
function splitJobsMessages(chunks) {
  const messages = [];
  for (const chunk of chunks) {
    // Начало задания помечено колокольчиком; в HTML-режиме маркер содержит <b>.
    if (chunk.startsWith('🔔') || messages.length === 0) messages.push(chunk);
    else messages[messages.length - 1] += `\n${chunk}`;
  }
  return messages;
}

test('анализ с эвристикой не делает сетевых вызовов и помечает провайдера', async () => {
  const parser = new KworkListingParser({ targetCategories: config.targetCategories });
  const parsed = parser.parse(fixture('listing-standard.html'), { sourceUrl: 'https://kwork.ru/projects' });
  const analysis = await analyzeAndDraft(parsed.jobs[0], profile, { modelAdapter: null, config: { ...config, dataDir: tmpdir() } });
  assert.equal(analysis.modelUsed, false);
  assert.equal(analysis.provider, 'heuristic');
  assert.equal(analysis.draft.sentToKwork, false);
  const message = renderJobMessage(parsed.jobs[0], analysis);
  assert.match(message, /Рекомендация: /);
});


test('пропавшие из выдачи задания удаляются из индекса', async () => {
  const notifier = makeNotifier();
  const firstHtml = fixture('listing-standard.html');
  // Убираем третью карточку простым и надёжным способом: по её id и до конца блока.
  const thirdStart = firstHtml.indexOf('data-want-id="884215"');
  const thirdEnd = firstHtml.indexOf('</main>', thirdStart);
  const secondHtml = firstHtml.slice(0, firstHtml.lastIndexOf('<div class="want-card js-want-card"', thirdStart)) + firstHtml.slice(thirdEnd);
  let currentHtml = firstHtml;
  const dir = await mkdtemp(join(tmpdir(), 'kwork-cycle-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    const parser = new KworkListingParser({ targetCategories: config.targetCategories });
    const runner = createCycleRunner({
      source: { fetchPage: async (url) => ({ html: currentHtml, status: 200, url }) },
      parser,
      store,
      profile,
      notifier,
      config: makeRunnerConfig(dir),
      logger: null
    });

    const first = await runner.runOnce();
    assert.equal(first.sent, 3);
    assert.equal(first.activeJobs, 3);

    currentHtml = secondHtml;
    const second = await runner.runOnce();
    assert.equal(second.pruned, 1, 'задание, которого больше нет в выдаче, удаляется из индекса');
    assert.equal(second.activeJobs, 2, 'в индексе остаются только актуальные задания');
    const active = store.activeJobs();
    assert.equal(active.length, 2);
    assert.equal(active.some((job) => job.id === '884215'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('при ошибке источника индекс не очищается (нет повторных уведомлений)', async () => {
  const notifier = makeNotifier();
  const html = fixture('listing-standard.html');
  const dir = await mkdtemp(join(tmpdir(), 'kwork-cycle-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    const parser = new KworkListingParser({ targetCategories: config.targetCategories });
    let mode = 'ok';
    const runner = createCycleRunner({
      source: {
        fetchPage: async (url) => {
          if (mode === 'fail') throw new SourceError('сеть недоступна', { retryable: true });
          return { html, status: 200, url };
        }
      },
      parser,
      store,
      profile,
      notifier,
      config: makeRunnerConfig(dir),
      logger: null
    });

    await runner.runOnce();
    assert.equal(store.stats.total, 3);

    mode = 'fail';
    await assert.rejects(() => runner.runOnce(), /сеть недоступна/);
    assert.equal(store.stats.total, 3, 'база не должна сбрасываться при сбое запроса');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('пустая страница не помечается как пропавшие задания', async () => {
  const notifier = makeNotifier();
  const html = fixture('listing-standard.html');
  const dir = await mkdtemp(join(tmpdir(), 'kwork-cycle-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    const parser = new KworkListingParser({ targetCategories: config.targetCategories });
    let mode = 'ok';
    const runner = createCycleRunner({
      source: {
        fetchPage: async (url) => ({
          html: mode === 'ok' ? html : '<html><body><main></main></body></html>',
          status: 200,
          url
        })
      },
      parser,
      store,
      profile,
      notifier,
      config: makeRunnerConfig(dir),
      logger: null
    });

    await runner.runOnce();
    assert.equal(store.stats.total, 3);

    mode = 'empty';
    const summary = await runner.runOnce();
    assert.equal(summary.structureOk, false);
    assert.equal(summary.pruned, 0, 'по неразобранной странице ничего не удаляем');
    assert.equal(store.stats.total, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('логируется одно сводное сообщение по итогам цикла, без шума', async () => {
  const html = fixture('listing-with-captcha-script.html');
  const notifier = makeNotifier();
  const logger = makeCapturingLogger();
  const { runner, cleanup } = await makeRunner({ html, notifier, logger });
  try {
    const summary = await runner.runOnce();
    const cycleLines = logger.lines.filter((line) => line.includes('Цикл завершён'));
    assert.equal(cycleLines.length, 1, 'на цикл должно быть ровно одно сводное сообщение');
    assert.match(
      cycleLines[0],
      /Цикл завершён: запросов 1, карточек 1, новых 1, повторов 0, удалено устаревших 0, всего задач 1/
    );
    assert.match(cycleLines[0], /\| .*карточек 1/, 'в сводке есть разбивка по источникам');

    const perRequestLines = logger.lines.filter((line) => line.includes('Запрос выполнен'));
    assert.equal(perRequestLines.length, 0, 'отдельных строк на каждый запрос быть не должно');

    const joined = logger.lines.join('\n');
    assert.doesNotMatch(joined, /упоминани/i, 'шум про упоминания защиты в логе не нужен');
    assert.doesNotMatch(joined, /captcha-in-script/);
    assert.equal(summary.sources.length, 1);
    assert.equal(summary.sources[0].cards, 1);
  } finally {
    await cleanup();
  }
});

test('пустая страница останавливает пагинацию и фиксируется в состоянии', async () => {
  // Первая страница сообщает last_page=2, вторая пуста — проход останавливается сам.
  const html = fixture('listing-embedded-json.html').replace(
    '"id":3259320',
    '"id":3259320,"pagination":{"current_page":1,"last_page":2,"total":16,"per_page":12}'
  );
  const requested = [];
  const notifier = makeNotifier();
  const source = {
    fetchPage: async (url) => {
      requested.push(url);
      return { html: url.includes('page=2') ? '<html><body><main></main></body></html>' : html, status: 200, url };
    }
  };
  const { runner, cleanup } = await makeRunner({
    notifier,
    source,
    configPatch: {
      source: {
        ...config.source,
        pruneMissingJobs: false,
        pagination: { enabled: true, maxPagesPerUrl: 3 }
      }
    }
  });
  try {
    const summary = await runner.runOnce();
    assert.deepEqual(requested, ['https://kwork.ru/projects', 'https://kwork.ru/projects?page=2']);
    assert.equal(summary.pages.length, 2, 'пустая вторая страница фиксируется в состоянии');
    assert.equal(summary.pages[1].cards, 0);
    assert.equal(summary.newJobs, 4, 'карточки первой страницы обработаны');
  } finally {
    await cleanup();
  }
});

test('страницы обходятся автоматически по last_page из выдачи', async () => {
  const html = fixture('listing-embedded-json.html');
  // Первая страница говорит: всего 2 страницы. Вторая отдаёт ещё одно задание.
  // Метаданные выдачи добавляем после первого id — как в реальном payload.
  const withMeta = (page, lastPage, total) =>
    html.replace('"id":3259320', `"id":3259320,"pagination":{"current_page":${page},"last_page":${lastPage},"total":${total},"per_page":12}`);
  const page1 = withMeta(1, 2, 16);
  const page2 = html
    .replace('"id":3259320', '"id":9999999,"pagination":{"current_page":2,"last_page":2,"total":16,"per_page":12}');

  const requested = [];
  const notifier = makeNotifier();
  const source = {
    fetchPage: async (url) => {
      requested.push(url);
      const isPage2 = url.includes('page=2');
      return { html: isPage2 ? page2 : page1, status: 200, url };
    }
  };
  const { runner, cleanup } = await makeRunner({
    notifier,
    source,
    configPatch: {
      source: {
        ...config.source,
        pruneMissingJobs: false,
        pagination: { enabled: true, maxPagesPerUrl: 5 }
      }
    }
  });
  try {
    await runner.runOnce();
    assert.deepEqual(requested, ['https://kwork.ru/projects', 'https://kwork.ru/projects?page=2']);
  } finally {
    await cleanup();
  }
});

test('maxPagesPerUrl ограничивает автопроход даже если last_page больше', async () => {
  const html = fixture('listing-embedded-json.html').replace(
    '"id":3259320',
    '"id":3259320,"pagination":{"current_page":1,"last_page":9,"total":120,"per_page":12}'
  );
  const requested = [];
  const notifier = makeNotifier();
  const source = {
    fetchPage: async (url) => {
      requested.push(url);
      return { html, status: 200, url };
    }
  };
  const { runner, cleanup } = await makeRunner({
    notifier,
    source,
    configPatch: {
      source: {
        ...config.source,
        pruneMissingJobs: false,
        pagination: { enabled: true, maxPagesPerUrl: 2 }
      }
    }
  });
  try {
    await runner.runOnce();
    assert.equal(requested.length, 2, 'не больше maxPagesPerUrl запросов на URL');
    assert.deepEqual(requested, ['https://kwork.ru/projects', 'https://kwork.ru/projects?page=2']);
  } finally {
    await cleanup();
  }
});

test('расхождение «заявлено в выдаче / забрано» попадает в предупреждения цикла', async () => {
  // last_page=1, но total=17 — бот забирает 12 и обязан предупредить.
  const html = fixture('listing-embedded-json.html').replace(
    '"id":3259320',
    '"id":3259320,"pagination":{"current_page":1,"last_page":1,"total":17,"per_page":12}'
  );
  const notifier = makeNotifier();
  const { runner, cleanup } = await makeRunner({
    html,
    notifier,
    configPatch: {
      source: { ...config.source, pruneMissingJobs: false, pagination: { enabled: true, maxPagesPerUrl: 1 } }
    }
  });
  try {
    const summary = await runner.runOnce();
    // Недобор — это предупреждение, а не сбой: данные валидны, их просто меньше.
    assert.equal(summary.errors.length, 0, `не должно быть ошибок: ${summary.errors.join(' | ')}`);
    assert.ok(
      summary.warnings.some((warning) => /заявлено 17 заданий, забрано 4/.test(warning)),
      `ожидалось предупреждение о недоборе, получено: ${summary.warnings.join(' | ')}`
    );
  } finally {
    await cleanup();
  }
});

test('пагинация выключена — запрашивается только первая страница', async () => {
  const html = fixture('listing-standard.html');
  const requested = [];
  const notifier = makeNotifier();
  const source = {
    fetchPage: async (url) => {
      requested.push(url);
      return { html, status: 200, url };
    }
  };
  const { runner, cleanup } = await makeRunner({
    notifier,
    source,
    configPatch: {
      source: {
        ...config.source,
        pruneMissingJobs: false,
        pagination: { enabled: false, maxPagesPerUrl: 3 }
      }
    }
  });
  try {
    await runner.runOnce();
    assert.deepEqual(requested, ['https://kwork.ru/projects']);
  } finally {
    await cleanup();
  }
});
