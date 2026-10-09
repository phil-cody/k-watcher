import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TelegramClient, TelegramError } from '../src/telegram/client.js';
import { TelegramState } from '../src/telegram/state.js';
import {
  KworkWatcherBot,
  dispatchCommand,
  buildTelegramCommands,
  publishTelegramCommands
} from '../src/bot/kwork-watcher-bot.js';
import { createTexts } from '../src/texts/texts.js';
import { makeFixtureProfile } from './helpers/text-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });

/** Поддельный Telegram API: складывает вызовы и возвращает заранее заданные обновления. */
function makeFetch({ updates = [], failSend = false } = {}) {
  const calls = [];
  let pollCount = 0;
  const fetchImpl = async (url, options) => {
    const method = String(url).split('/').pop();
    const payload = JSON.parse(options.body ?? '{}');
    calls.push({ method, payload });
    if (method === 'getUpdates') {
      // Как настоящий Telegram: обновления выдаются один раз, дальше их нет.
      pollCount += 1;
      const result = pollCount === 1 ? updates : [];
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }
    if (method === 'sendMessage' && failSend) {
      return { ok: false, status: 400, json: async () => ({ ok: false, description: 'chat not found' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: calls.length } }) };
  };
  return { fetchImpl, calls };
}

function updateFrom({ id, chatId = null, text = '/start', username = null, firstName = null, updateId = 1 }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id, username, first_name: firstName },
      chat: { id: chatId ?? id },
      text,
      date: 1770000000
    }
  };
}

test('клиент принимает всех: доступ открыт, подключение логируется', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-users-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    state.approveUser(222);
    state.rememberUser({ userId: 222, chatId: 222, username: 'known' });

    const { fetchImpl } = makeFetch({
      updates: [
        updateFrom({ id: 111, text: '/status', updateId: 1 }),
        updateFrom({ id: 222, text: '/start', username: 'known', updateId: 2 }),
        updateFrom({ id: 333, text: '/start', username: 'stranger', firstName: 'Пётр', updateId: 3 })
      ]
    });
    const logs = [];
    const client = new TelegramClient({
      token: 'test-token',
      telegramState: state,
      fetchImpl,
      logger: { info: (message, meta) => logs.push({ message, meta }), warn: () => {}, error: () => {}, debug: () => {} }
    });
    const { messages, denied } = await client.pollOnce({ timeoutSeconds: 0 });

    // Доступ открыт всем: подтверждение не требуется.
    assert.deepEqual(messages.map((message) => message.fromId), [111, 222, 333]);
    assert.deepEqual(denied, []);
    assert.equal(state.isApproved(333), true, 'новый пользователь получает доступ сразу');
    assert.equal(state.knownUsers['333'].username, 'stranger');
    assert.equal(state.knownUsers['333'].name, 'Пётр');
    // Подключение нового пользователя видно в логах.
    assert.ok(
      logs.some((entry) => entry.meta?.userId === 333),
      `в логах нет подключения: ${JSON.stringify(logs)}`
    );
    // Первое сообщение помечено как новое.
    assert.equal(messages.find((message) => message.fromId === 333).isNewUser, true);
    // Повторный опрос: пользователь уже известен, новых подключений нет.
    const second = await client.pollOnce({ timeoutSeconds: 0 });
    assert.deepEqual(second.messages, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('доступ открыт по умолчанию и сохраняется между запусками', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-users-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    const { fetchImpl } = makeFetch({ updates: [updateFrom({ id: 555, text: '/start' })] });
    const client = new TelegramClient({ token: 'test-token', telegramState: state, fetchImpl, logger: null });
    const { messages, denied } = await client.pollOnce({ timeoutSeconds: 0 });

    assert.deepEqual(messages.map((message) => message.fromId), [555]);
    assert.equal(denied.length, 0);
    assert.equal(state.isApproved(555), true, 'доступ выдаётся без подтверждения');

    const reloaded = await new TelegramState({ dataDir: dir }).init();
    assert.equal(reloaded.isApproved(555), true, 'доступ сохраняется между запусками');
    assert.deepEqual(reloaded.seenUsers, [555], 'первое подключение запомнено');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('autoApprove=false оставляет закрытый доступ и пишет в лог', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-users-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    const { fetchImpl } = makeFetch({ updates: [updateFrom({ id: 444, text: '/start' })] });
    const client = new TelegramClient({
      token: 'test-token',
      telegramState: state,
      autoApprove: false,
      fetchImpl,
      logger: null
    });
    const { messages, denied } = await client.pollOnce({ timeoutSeconds: 0 });
    assert.equal(messages.length, 0);
    assert.equal(denied.length, 1);
    assert.equal(state.isApproved(444), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/start подтверждённого пользователя отвечает приветствием и указывает, кто он', async () => {
  const state = new TelegramState({ dataDir: tmpdir(), ownerId: 111 });
  state.approveUser(111);
  state.rememberUser({ userId: 111, chatId: 111, username: 'owner' });

  const result = await dispatchCommand('/start', {
    config: {},
    profile: makeFixtureProfile(),
    telegramState: state,
    fromUserId: 111,
    fromChatId: 111,
    texts
  });
  assert.equal(result.action, 'registered');
  assert.match(result.reply, /Бот на связи/);
  assert.match(result.reply, /@owner/);
  assert.match(result.reply, /\/status/);
});

test('/start любого пользователя отвечает приветствием и подсказывает шаги', async () => {
  const state = new TelegramState({ dataDir: tmpdir(), ownerId: 111 });
  state.approveUser(111);
  state.rememberUser({ userId: 111, chatId: 111, username: 'owner' });

  const result = await dispatchCommand('/start', {
    config: {},
    profile: makeFixtureProfile(),
    telegramState: state,
    fromUserId: 111,
    fromChatId: 111,
    texts
  });
  assert.equal(result.action, 'registered');
  assert.match(result.reply, /Бот на связи/);
  assert.match(result.reply, /@owner/);
  assert.match(result.reply, /\/profile upload/);
  assert.match(result.reply, /\/categories/);
});

test('/start нового пользователя не требует подтверждения', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-users-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    const seen = state.markNewUser(222);
    assert.equal(seen, true, 'первое подключение фиксируется');

    const result = await dispatchCommand('/start', {
      config: {},
      profile: makeFixtureProfile(),
      telegramState: state,
      fromUserId: 222,
      fromChatId: 222,
      texts
    });
    // Никаких «ждём подтверждения»: доступ открыт сразу.
    assert.equal(result.action, 'registered');
    assert.match(result.reply, /Бот на связи/);
    assert.doesNotMatch(result.reply, /подтвержд/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/users показывает владельца и подключённых, но не «ожидающих»', async () => {
  const state = new TelegramState({ dataDir: tmpdir(), ownerId: 111 });
  state.rememberUser({ userId: 111, chatId: 111, username: 'owner' });
  state.approveUser(111);
  state.rememberUser({ userId: 222, chatId: 222, username: 'client' });
  state.approveUser(222);

  const result = await dispatchCommand('/users', {
    config: {},
    profile: makeFixtureProfile(),
    telegramState: state,
    fromUserId: 111,
    texts
  });
  assert.match(result.reply, /Пользователи бота/);
  assert.match(result.reply, /владелец: id 111, @owner/);
  assert.match(result.reply, /с доступом:.*@client/);
  // Подтверждения больше нет — «ожидающих» быть не должно.
  assert.doesNotMatch(result.reply, /ждут подтверждения/);
  assert.doesNotMatch(result.reply, /\/approve/);
});

test('сквозной сценарий: новый пользователь подключается сам и сразу работает', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-e2e-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    const sent = [];
    const client = {
      chatId: null,
      sendMessage: async (text, { chatId } = {}) => {
        sent.push({ text, chatId });
        return {};
      },
      get initialized() {
        return Boolean(this.chatId);
      }
    };
    const bot = new KworkWatcherBot({
      config: { rootDir, telegram: {} },
      profile: makeFixtureProfile(),
      profiles: null,
      store: null,
      scheduler: null,
      client,
      cycleRunner: null,
      logger: null,
      telegramState: state,
      texts
    });

    // 1. Новый пользователь пишет /start — доступ открывается сразу.
    state.markNewUser(222);
    state.approveUser(222);
    await state.save();
    await bot.handleIncoming({ fromId: 222, chatId: 222, text: '/start', username: 'client' });
    assert.equal(state.isApproved(222), true);
    assert.equal(state.chatId, 222, 'чат запомнен');
    assert.match(sent.at(-1).text, /Бот на связи/);

    // 2. Обычные команды работают без подтверждения.
    await bot.handleIncoming({ fromId: 222, chatId: 222, text: '/plan' });
    assert.match(sent.at(-1).text, /План опроса/);

    // 3. Доступ переживает перезапуск.
    const reloaded = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    assert.equal(reloaded.isApproved(222), true);
    assert.deepEqual(reloaded.seenUsers, [222]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('владельцу не приходят запросы на подтверждение', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-owner-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    state.rememberUser({ userId: 111, chatId: 111 });
    state.approveUser(111);
    const sent = [];
    const client = {
      chatId: 111,
      initialized: true,
      sendMessage: async (text, { chatId } = {}) => {
        sent.push({ text, chatId });
        return {};
      }
    };
    const bot = new KworkWatcherBot({
      config: { rootDir, telegram: {} },
      profile: makeFixtureProfile(),
      store: null,
      scheduler: null,
      client,
      cycleRunner: null,
      logger: null,
      telegramState: state,
      texts
    });

    // Новый пользователь пишет боту: владельцу ничего не уходит.
    state.markNewUser(333);
    state.approveUser(333);
    await bot.handleIncoming({ fromId: 333, chatId: 333, text: '/start' });
    assert.equal(sent.filter((item) => item.chatId === 111).length, 0, 'владельцу не должно быть уведомлений');
    assert.equal(state.isApproved(333), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('список команд собирается из текстов и фильтруется конфигом', () => {
  const all = buildTelegramCommands({ texts });
  assert.ok(all.length >= 6, `ожидался список команд, получено ${all.length}`);
  for (const item of all) {
    assert.match(item.command, /^[a-z]+$/, `команда должна быть в нижнем регистре: ${item.command}`);
    assert.ok(item.description.length <= 256, 'описание команды ограничено 256 символами');
    assert.ok(item.description.length > 0);
  }
  // Конфиг может ограничить публикуемый список.
  const filtered = buildTelegramCommands({ texts, config: { telegram: { menuFilter: ['start', 'status'] } } });
  assert.deepEqual(filtered.map((item) => item.command), ['start', 'status']);
});

test('publishCommands отправляет setMyCommands с описаниями', async () => {
  const { fetchImpl, calls } = makeFetch();
  const client = new TelegramClient({ token: 'test-token', fetchImpl, logger: null });
  const commands = buildTelegramCommands({ texts });
  const ok = await publishTelegramCommands({ client, texts, config: { telegram: { menuFilter: [] } } });

  assert.equal(ok, true);
  const call = calls.find((item) => item.method === 'setMyCommands');
  assert.ok(call, 'должен быть вызов setMyCommands');
  assert.equal(call.payload.commands.length, commands.length);
  assert.deepEqual(call.payload.commands[0], { command: 'start', description: calls.length ? commands[0].description : '' });
});

test('ошибка публикации команд не ломает запуск бота', async () => {
  const failingFetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, description: 'server error' }) });
  const client = new TelegramClient({ token: 'test-token', fetchImpl: failingFetch, logger: null });
  const warnings = [];
  const logger = { info: () => {}, warn: (message) => warnings.push(message), error: () => {}, debug: () => {} };
  const ok = await publishTelegramCommands({ client, texts, logger });
  assert.equal(ok, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /список команд/);
});

test('handleIncoming отвечает пользователю без подтверждения', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-bot-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    state.rememberUser({ userId: 222, chatId: 222 });
    state.markNewUser(222);
    state.approveUser(222);
    await state.save();

    const sent = [];
    const saved = [];
    const originalSave = state.save.bind(state);
    state.save = async (patch) => {
      saved.push(patch ?? {});
      return originalSave(patch);
    };
    const bot = new KworkWatcherBot({
      config: { rootDir, telegram: {}, schedule: { minIntervalSeconds: 240, maxIntervalSeconds: 600 } },
      profile: makeFixtureProfile(),
      store: null,
      scheduler: null,
      client: {
        chatId: 222,
        initialized: true,
        sendMessage: async (text, { chatId } = {}) => {
          sent.push({ text, chatId });
          return {};
        }
      },
      cycleRunner: null,
      logger: null,
      telegramState: state,
      texts
    });

    const result = await bot.handleIncoming({ fromId: 222, chatId: 222, text: '/status' });
    assert.equal(result.action, null);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 222);
    assert.match(sent[0].text, /Состояние бота/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ошибка отправки ответа не роняет обработку команды', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tg-bot-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    state.rememberUser({ userId: 111, chatId: 111 });
    state.approveUser(111);

    const warnings = [];
    const bot = new KworkWatcherBot({
      config: { rootDir, telegram: {} },
      profile: makeFixtureProfile(),
      store: null,
      scheduler: null,
      client: {
        chatId: 111,
        initialized: true,
        sendMessage: async () => {
          throw new TelegramError('Bad Request: chat not found');
        }
      },
      cycleRunner: null,
      logger: { warn: (message) => warnings.push(message), info: () => {}, error: () => {}, debug: () => {} },
      telegramState: state,
      texts
    });

    // Сбой отправки логируется, но команда обрабатывается до конца.
    const result = await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/status' });
    assert.equal(result.action, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
