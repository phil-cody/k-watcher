import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');

// Импорт точки входа: main() не выполняется, потому что файл не запущен напрямую.
const { createScheduler } = await import('../src/index.js');
const { PollingScheduler } = await import('../src/scheduler/scheduler.js');
const { KworkWatcherBot } = await import('../src/bot/kwork-watcher-bot.js');
const { JobStore } = await import('../src/storage/job-store.js');
const { loadConfig } = await import('../src/config/load-config.js');

/**
 * Запуск CLI как отдельного процесса в изолированном каталоге данных.
 * Возвращает код возврата и потоки — так тестируется реальное поведение команды.
 */
function runCli(args, dataDir) {
  const result = spawnSync(process.execPath, [resolve(rootDir, 'src', 'index.js'), ...args], {
    cwd: rootDir,
    env: { ...process.env, DATA_DIR: dataDir, TELEGRAM_BOT_TOKEN: '', TELEGRAM_ALLOWED_USER_ID: '' },
    encoding: 'utf8'
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function fakeCycleRunner() {
  return { runOnce: async () => ({ structureOk: true, cardsFound: 0 }) };
}

test('createScheduler возвращает готовый планировщик с методом run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-boot-'));
  try {
    const { config } = loadConfig({ rootDir, env: {}, readEnvFile: false });
    const store = await new JobStore({ dataDir: dir }).init();
    const scheduler = await createScheduler({ config, cycleRunner: fakeCycleRunner(), store, logger: null });

    assert.ok(scheduler instanceof PollingScheduler, 'должен вернуться именно планировщик');
    assert.equal(typeof scheduler.run, 'function');
    assert.equal(typeof scheduler.tick, 'function');
    assert.equal(typeof scheduler.stopLoop, 'function');
    assert.equal(typeof scheduler.state, 'object');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('планировщик восстанавливает время последнего запроса из состояния', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-boot-'));
  try {
    const { config } = loadConfig({ rootDir, env: {}, readEnvFile: false });
    const store = await new JobStore({ dataDir: dir }).init();
    await store.writeState({ scheduler: { lastRequestAt: '2026-10-07T07:00:00.000Z' } });

    const scheduler = await createScheduler({ config, cycleRunner: fakeCycleRunner(), store, logger: null });
    assert.equal(scheduler.lastRequestAt.toISOString(), '2026-10-07T07:00:00.000Z');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('бот отказывается работать с планировщиком без run и объясняет причину', () => {
  assert.throws(
    () =>
      new KworkWatcherBot({
        config: {},
        profile: {},
        store: {},
        scheduler: Promise.resolve({}), // типичная ошибка: забытый await
        client: null,
        cycleRunner: fakeCycleRunner()
      }),
    (error) => error instanceof TypeError && /await/.test(error.message)
  );
});

test('остановка планировщика уведомляет пользователя с диагностикой', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-boot-'));
  try {
    const { config } = loadConfig({ rootDir, env: {}, readEnvFile: false });
    const store = await new JobStore({ dataDir: dir }).init();
    const sent = [];
    // chatId означает, что клиент инициализирован: без него уведомления не отправляются.
    const notifier = { sendMessage: async (text) => sent.push(text), chatId: 1, initialized: true };

    const scheduler = await createScheduler({ config, cycleRunner: fakeCycleRunner(), store, logger: null, notifier });
    // stop() асинхронный: уведомление и сохранение состояния завершаются до возврата.
    await scheduler.stop('captcha', 'Обнаружена защита', {
      diagnostics: { status: 200, bytes: 12345, title: 'Проверка безопасности', markers: ['captcha-heading'], excerpt: 'Подтвердите, что вы не робот' }
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0], /Опрос остановлен/);
    assert.match(sent[0], /captcha/);
    assert.match(sent[0], /HTTP статус: 200/);
    assert.match(sent[0], /Проверка безопасности/);

    const state = await store.readState();
    assert.equal(state.lastStop.reason, 'captcha');
    assert.equal(state.scheduler.status, 'stopped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('состояние планировщика сохраняет lastRequestAt для защиты от рестарта', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-boot-'));
  try {
    const { config } = loadConfig({ rootDir, env: {}, readEnvFile: false });
    const store = await new JobStore({ dataDir: dir }).init();
    const scheduler = await createScheduler({ config, cycleRunner: fakeCycleRunner(), store, logger: null });
    await scheduler.notifyStateChange();
    const state = await store.readState();
    assert.ok('lastRequestAt' in state.scheduler, 'поле lastRequestAt должно сохраняться');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('исходный код создания планировщика содержит await', () => {
  const lines = readFileSync(resolve(rootDir, 'src', 'index.js'), 'utf8').split('\n');
  const callLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /createScheduler\(\{/.test(line) && !/function\s+createScheduler/.test(line));
  assert.ok(callLines.length > 0, 'должен быть хотя бы один вызов createScheduler');
  for (const { line, index } of callLines) {
    const context = `${lines[index - 1] ?? ''} ${line}`;
    assert.match(context, /await\s+createScheduler\(/, `вызов на строке ${index + 1} должен быть с await`);
  }
});


test('reset очищает индекс и состояние, но сохраняет историю обработки', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-reset-'));
  try {
    // Готовим окружение: пишем индекс, состояние и историю.
    const store = await new JobStore({ dataDir: dir }).init();
    await store.record({
      id: '9001',
      url: 'https://kwork.ru/projects/9001/test',
      title: 'Тестовое задание',
      dedupKey: 'id:9001',
      dedupKind: 'stable-id'
    });
    await store.writeState({ scheduler: { status: 'running' } });
    await store.appendMessageLog({ jobId: '9001', text: 'черновик' });

    assert.equal(existsSync(store.paths.index), true);
    assert.equal(existsSync(store.paths.state), true);
    assert.equal(existsSync(store.paths.processed), true);

    const result = await runCli(['reset', '--yes'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(store.paths.index), false, 'индекс должен быть удалён');
    assert.equal(existsSync(store.paths.state), false, 'состояние должно быть удалено');
    assert.equal(existsSync(store.paths.processed), true, 'история обработки сохраняется без --hard');

    // После очистки индекс пустой: при следующем запуске данные собираются заново.
    const fresh = await new JobStore({ dataDir: dir }).init();
    assert.equal(fresh.stats.total, 0);
    assert.deepEqual(fresh.activeJobs(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reset --hard удаляет и историю обработки', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-reset-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    await store.record({ id: '9002', url: 'https://kwork.ru/projects/9002/test', dedupKey: 'id:9002', dedupKind: 'stable-id' });
    await store.appendMessageLog({ jobId: '9002', text: 'черновик' });

    const result = await runCli(['reset', '--yes', '--hard'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(store.paths.index), false);
    assert.equal(existsSync(store.paths.processed), false, '--hard удаляет историю');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reset без --yes ничего не удаляет и просит подтверждение', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-reset-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    await store.record({ id: '9003', url: 'https://kwork.ru/projects/9003/test', dedupKey: 'id:9003', dedupKind: 'stable-id' });

    const result = await runCli(['reset'], dir);
    assert.equal(result.code, 2, 'нужно подтверждение');
    assert.match(result.stdout, /--yes/);
    assert.equal(existsSync(store.paths.index), true, 'без подтверждения индекс не трогаем');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('syncTelegramRecipients объявлена и попадает в список получателей', async () => {
  const { syncTelegramRecipients } = await import('../src/index.js');
  assert.equal(typeof syncTelegramRecipients, 'function');

  const dir = await mkdtemp(join(tmpdir(), 'kwork-recipients-'));
  try {
    const { TelegramState } = await import('../src/telegram/state.js');
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    state.rememberUser({ userId: 111, chatId: 111 });
    state.approveUser(111);
    state.rememberUser({ userId: 222, chatId: 222 });
    state.approveUser(222);
    state.rememberUser({ userId: 333, chatId: 333 }); // без доступа

    const written = [];
    const store = { writeState: async (patch) => written.push(patch) };
    const recipients = await syncTelegramRecipients({ store, telegramState: state, client: null });

    assert.deepEqual(recipients, [
      { userId: 111, chatId: 111 },
      { userId: 222, chatId: 222 }
    ]);
    assert.deepEqual(written.at(-1), { telegram: { recipients } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('каждая функция, вызываемая в main, объявлена', () => {
  // Регрессия: syncTelegramRecipients вызывалась, но не была объявлена —
  // команда `bot` падала с ReferenceError.
  const source = readFileSync(resolve(rootDir, 'src', 'index.js'), 'utf8');
  const called = new Set([
    ...[...source.matchAll(/\bawait ([a-zA-Z_$][a-zA-Z0-9_$]*)\(/g)].map((m) => m[1]),
    // const x = await f(...) — тоже вызов.
    ...[...source.matchAll(/=\s*await ([a-zA-Z_$][a-zA-Z0-9_$]*)\(/g)].map((m) => m[1])
  ]);
  const declared = new Set([
    ...[...source.matchAll(/(?:async )?function ([a-zA-Z_$][a-zA-Z0-9_$]*)/g)].map((m) => m[1]),
    ...[...source.matchAll(/const ([a-zA-Z_$][a-zA-Z0-9_$]*) = (?:async )?\(/g)].map((m) => m[1]),
    ...[...source.matchAll(/import \{([^}]+)\}/g)].flatMap((m) => m[1].split(',').map((name) => name.trim().split(' as ').pop()))
  ]);
  const builtins = new Set(['import', 'resolve', 'require', 'setTimeout', 'clearTimeout', 'fetch']);
  const missing = [...called].filter((name) => !declared.has(name) && !builtins.has(name));
  assert.deepEqual(missing, [], `вызываются необъявленные функции: ${missing.join(', ')}`);
});

test('сообщение об ошибке CLI никогда не оставляет плейсхолдер {message}', async () => {
  const { formatCliError } = await import('../src/index.js');

  const cases = [
    new Error('файл профиля не найден'),
    new TypeError('scheduler is not a function'),
    'строка вместо ошибки',
    { message: 'объект вместо ошибки' },
    null,
    undefined
  ];
  for (const error of cases) {
    const text = formatCliError(error, { rootDir });
    assert.equal(text.includes('{message}'), false, `плейсхолдер остался: ${text}`);
    assert.match(text, /^Ошибка: /);
  }

  // Причина сбоя должна быть видна.
  assert.match(formatCliError(new Error('файл профиля не найден'), { rootDir }), /файл профиля не найден/);

  // Если файл текстов недоступен, всё равно печатаем причину, а не шаблон.
  const broken = formatCliError(new Error('проверка'), { rootDir: '/несуществующий/каталог' });
  assert.match(broken, /проверка/);
  assert.equal(broken.includes('{message}'), false);
});
