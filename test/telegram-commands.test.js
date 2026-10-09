/**
 * Тесты разметки ответов на команды и прав доступа.
 *
 * Регрессия, которую эти тесты закрывают: команда `/users` возвращала текст с `<id>`,
 * ответ уходил с parse_mode=HTML, и Telegram отвечал
 * «can't parse entities: Unsupported start tag "id"». Теперь любой ответ на команду
 * проверяется на допустимость разметки и на отсутствие незаполненных плейсхолдеров.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  dispatchCommand,
  buildTelegramCommands,
  KworkWatcherBot
} from '../src/bot/kwork-watcher-bot.js';
import { TelegramState } from '../src/telegram/state.js';
import { TelegramClient } from '../src/telegram/client.js';
import { createTexts } from '../src/texts/texts.js';
import { makeFixtureProfile } from './helpers/text-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });

/** Теги, которые Telegram принимает в HTML-режиме. */
const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'tg-spoiler', 'blockquote']);

/**
 * Проверка разметки как у Telegram.
 *
 * Telegram в HTML-режиме отвергает любой символ «<», который не открывает известный
 * тег: именно на этом падал ответ `/users` со строкой «/approve <id>». Поэтому здесь
 * проверяются и парность, и то, что вне тегов символов «<»/«>» не осталось.
 */
export function validateTelegramHtml(html) {
  const problems = [];
  const source = String(html ?? '');
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;
  const stack = [];
  let consumed = 0;
  for (const match of source.matchAll(tagPattern)) {
    const between = source.slice(consumed, match.index);
    if (between.includes('<')) problems.push(`Символ «<» вне тега: ${JSON.stringify(between.slice(0, 40))}`);
    if (between.includes('>')) problems.push(`Символ «>» вне тега: ${JSON.stringify(between.slice(0, 40))}`);
    consumed = match.index + match[0].length;
    const raw = match[0];
    const tag = match[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      problems.push(`Unsupported start tag "${tag}"`);
      continue;
    }
    if (raw.startsWith('</')) {
      const last = stack.pop();
      if (last !== tag) problems.push(`Закрывающий </${tag}> не соответствует <${last ?? '—'}>`);
    } else {
      stack.push(tag);
    }
  }
  const tail = source.slice(consumed);
  if (tail.includes('<') || tail.includes('>')) {
    problems.push(`Символы «<»/«>» вне тега в конце: ${JSON.stringify(tail.slice(0, 40))}`);
  }
  if (stack.length > 0) problems.push(`Не закрыты теги: ${stack.join(', ')}`);
  return problems;
}

/** Полный контекст для диспетчера: все команды должны отвечать без ошибок. */
function makeContext({ state, fromUserId, isOwner = true } = {}) {
  const messages = [];
  const fakeScheduler = {
    pause: () => messages.push({ action: 'pause' }),
    resume: () => messages.push({ action: 'resume' }),
    state: {
      status: 'running',
      pausedByUser: false,
      requestCount: 3,
      window: '05:00–20:00',
      timezone: 'Europe/Moscow',
      intervalSeconds: [240, 600],
      lastRequestAt: null,
      nextRequestAt: null,
      lastError: null,
      stopMessage: null,
      stopReason: null
    }
  };
  return {
    config: {
      rootDir,
      telegram: {},
      schedule: {
        timezone: 'Europe/Moscow',
        windowStart: '05:00',
        windowEnd: '20:00',
        minIntervalSeconds: 240,
        maxIntervalSeconds: 600
      },
      source: { allowedUrls: [{ url: 'https://kwork.ru/projects?c=37', label: 'Вёрстка', enabled: true, pages: 1 }] },
      targetCategories: [],
      profilePath: 'config/performer-profile.json',
      secrets: { telegramAllowedUserId: isOwner ? fromUserId : 1 }
    },
    profile: makeFixtureProfile(),
    store: {
      stats: { total: 3, keyTotal: 3, stableIdKeys: 3, urlKeys: 0, compositeKeys: 0, updatedAt: null }
    },
    schedulerState: fakeScheduler.state,
    scheduler: fakeScheduler,
    modelInfo: 'openai-compatible',
    modelUsage: { dayCount: 4, hourCount: 1, limits: { perDay: 200, perHour: 20 } },
    lastSummary: { cardsFound: 4, inTargetCategories: 4, newJobs: 2, duplicates: 2, sent: 2, pruned: 0, activeJobs: 3 },
    telegramState: state,
    fromUserId,
    fromChatId: fromUserId,
    fromUsername: isOwner ? 'owner' : 'member',
    fromName: 'Тест',
    texts
  };
}

const COMMANDS = ['/start', '/help', '/status', '/plan', '/profile', '/categories', '/pause', '/resume', '/users', '/usage', '/unknown'];

test('любой ответ на команду — корректная разметка без ложных тегов', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmd-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    state.rememberUser({ userId: 111, chatId: 111, username: 'owner' });
    state.approveUser(111);
    state.rememberUser({ userId: 555, chatId: 555, username: 'member' });
    state.approveUser(555);
    state.rememberUser({ userId: 777, chatId: 777, username: 'another' });
    state.approveUser(777);

    for (const command of COMMANDS) {
      const result = await dispatchCommand(command, makeContext({ state, fromUserId: 111 }));
      assert.ok(result, `${command}: ожидался ответ`);
      const problems = validateTelegramHtml(result.reply);
      assert.deepEqual(problems, [], `${command}: разметка сломана — ${problems.join('; ')}\n${result.reply}`);
      assert.doesNotMatch(result.reply, /\{[a-zA-Z][a-zA-Z0-9]*\}/, `${command}: остались плейсхолдеры`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/users отвечает владельцу и не содержит угловых скобок', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmd-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    state.rememberUser({ userId: 111, chatId: 111, username: 'owner' });
    state.approveUser(111);
    state.rememberUser({ userId: 555, chatId: 555, username: 'member' });
    state.approveUser(555);
    state.rememberUser({ userId: 777, chatId: 777, username: 'another' });
    state.approveUser(777);

    const result = await dispatchCommand('/users', makeContext({ state, fromUserId: 111 }));
    assert.match(result.reply, /Пользователи бота/);
    assert.match(result.reply, /@owner/);
    assert.match(result.reply, /@member/);
    assert.match(result.reply, /@another/);
    // Символы «<» и «>» сломали бы HTML-разбор Telegram.
    assert.equal(result.reply.includes('<'), false, `в ответе не должно быть «<»:\n${result.reply}`);
    assert.equal(result.reply.includes('>'), false, `в ответе не должно быть «>»:\n${result.reply}`);
    // Подтверждения больше нет: подсказка не должна его предлагать.
    assert.doesNotMatch(result.reply, /\/approve/);
    assert.match(result.reply, /Доступ открыт всем/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('команды владельца недоступны остальным', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmd-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    state.rememberUser({ userId: 555, chatId: 555, username: 'member' });
    state.approveUser(555);

    for (const command of ['/users', '/usage']) {
      const result = await dispatchCommand(command, makeContext({ state, fromUserId: 555, isOwner: false }));
      assert.equal(result.reply, texts.t('commands.onboarding.ownerOnly'), `${command} должен быть закрыт`);
      assert.deepEqual(validateTelegramHtml(result.reply), []);
    }
    // Ничего не сломалось: доступ не выдавался и не отзывался.
    assert.equal(state.isApproved(555), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('обычные команды доступны подтверждённому пользователю', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmd-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    state.rememberUser({ userId: 555, chatId: 555, username: 'member' });
    state.approveUser(555);

    for (const command of ['/status', '/plan', '/profile', '/help']) {
      const result = await dispatchCommand(command, makeContext({ state, fromUserId: 555, isOwner: false }));
      assert.notEqual(result.reply, texts.t('commands.onboarding.ownerOnly'), `${command} должен быть доступен`);
      assert.deepEqual(validateTelegramHtml(result.reply), [], command);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('меню владельца шире общего и содержит только команды владельца дополнительно', () => {
  const general = buildTelegramCommands({ texts, config: { telegram: {} }, owner: false }).map((item) => item.command);
  const owner = buildTelegramCommands({ texts, config: { telegram: {} }, owner: true }).map((item) => item.command);

  assert.equal(general.includes('users'), false, '/users не должен быть в общем меню');
  // Владельцу дополнительно доступны список пользователей и статистика расхода.
  assert.deepEqual(owner.filter((command) => !general.includes(command)), ['usage', 'users']);
  for (const command of general) assert.ok(owner.includes(command), `${command} должен остаться в меню владельца`);
});

test('меню владельца публикуется в его чат, общее — всем', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ method: String(url).split('/').pop(), payload: JSON.parse(options.body ?? '{}') });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
  };
  const client = new TelegramClient({ token: 'test-token', fetchImpl, logger: null });
  const { publishTelegramCommands } = await import('../src/bot/kwork-watcher-bot.js');

  const ok = await publishTelegramCommands({
    client,
    texts,
    config: { telegram: {} },
    ownerChatId: 111
  });

  assert.equal(ok, true);
  const setCalls = calls.filter((call) => call.method === 'setMyCommands');
  assert.equal(setCalls.length, 2, 'два вызова: общий и для чата владельца');
  assert.equal(setCalls[0].payload.scope, undefined, 'общий набор — без scope');
  assert.deepEqual(setCalls[1].payload.scope, { type: 'chat', chat_id: 111 });
  const ownerCommands = setCalls[1].payload.commands.map((item) => item.command);
  assert.ok(ownerCommands.includes('users'));
  assert.equal(setCalls[0].payload.commands.some((item) => item.command === 'users'), false);
});

test('повторный запуск не публикует меню заново', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'menu-'));
  try {
    const { TelegramState } = await import('../src/telegram/state.js');
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ method: String(url).split('/').pop(), payload: JSON.parse(options.body ?? '{}') });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    };
    const client = new TelegramClient({ token: 'test-token', fetchImpl, logger: null });
    const { publishTelegramCommands } = await import('../src/bot/kwork-watcher-bot.js');
    const infos = [];
    const logger = { info: (message) => infos.push(message), warn: () => {}, error: () => {}, debug: () => {} };

    // Первый запуск: общий набор и набор владельца.
    await publishTelegramCommands({ client, texts, config: { telegram: {} }, ownerChatId: 111, telegramState: state, logger });
    const afterFirst = calls.filter((call) => call.method === 'setMyCommands').length;
    assert.equal(afterFirst, 2);
    assert.ok(state.publishedMenus.general, 'отпечаток общего меню сохранён');
    assert.ok(state.publishedMenus.owner, 'отпечаток меню владельца сохранён');
    assert.equal(state.publishedMenus.ownerChatId, 111);

    // Второй запуск: ничего не изменилось — публикации быть не должно.
    calls.length = 0;
    infos.length = 0;
    await publishTelegramCommands({ client, texts, config: { telegram: {} }, ownerChatId: 111, telegramState: state, logger });
    assert.equal(calls.filter((call) => call.method === 'setMyCommands').length, 0, 'повторной публикации быть не должно');
    assert.equal(calls.filter((call) => call.method === 'deleteMyCommands').length, 0);
    assert.ok(infos.some((message) => /не изменились/.test(message)), 'в логе должно быть сказано, что публикация не нужна');

    // Набор изменился — публикуем снова только изменённую часть.
    const otherTexts = createTexts({
      rootDir,
      data: {
        ...texts.data,
        commands: { ...texts.data.commands, telegramMenu: [...texts.data.commands.telegramMenu, ['extra', 'новая команда']] }
      }
    });
    calls.length = 0;
    await publishTelegramCommands({ client, texts: otherTexts, config: { telegram: {} }, ownerChatId: 111, telegramState: state, logger });
    const republished = calls.filter((call) => call.method === 'setMyCommands');
    assert.equal(republished.length, 1, 'перепубликуется только общий набор');
    assert.equal(republished[0].payload.scope, undefined);
    assert.ok(republished[0].payload.commands.some((item) => item.command === 'extra'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('сбой публикации меню не роняет бота', async () => {
  const failingFetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, description: 'boom' }) });
  const client = new TelegramClient({ token: 'test-token', fetchImpl: failingFetch, logger: null });
  const warnings = [];
  const logger = { info: () => {}, warn: (message) => warnings.push(message), error: () => {}, debug: () => {} };
  const { publishTelegramCommands } = await import('../src/bot/kwork-watcher-bot.js');
  const ok = await publishTelegramCommands({ client, texts, config: { telegram: {} }, ownerChatId: 111, logger });
  assert.equal(ok, false);
  assert.ok(warnings.length >= 1);
});

test('бот отправляет ответ на команду так, что Telegram его принимает', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmd-'));
  try {
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    state.rememberUser({ userId: 111, chatId: 111, username: 'owner' });
    state.approveUser(111);
    state.rememberUser({ userId: 555, chatId: 555, username: 'member' });
    state.approveUser(555);
    state.rememberUser({ userId: 777, chatId: 777, username: 'another' });
    state.approveUser(777);

    // Проверяем ровно то, на чём падал реальный Telegram: текст ответа и режим разметки.
    const sent = [];
    const client = {
      chatId: 111,
      get initialized() {
        return true;
      },
      sendMessage: async (text, options = {}) => {
        sent.push({ text, options });
        const problems = validateTelegramHtml(text);
        if (problems.length > 0) throw new Error(`can't parse entities: ${problems.join('; ')}`);
        return {};
      }
    };
    // Заглушка должна выглядеть как настоящий планировщик: конструктор это проверяет.
    const scheduler = {
      pause: () => {},
      resume: () => {},
      run: async () => {},
      tick: async () => ({}),
      stopLoop: () => {},
      state: null
    };
    const bot = new KworkWatcherBot({
      config: { rootDir, telegram: {}, schedule: { minIntervalSeconds: 240, maxIntervalSeconds: 600 } },
      profile: makeFixtureProfile(),
      store: null,
      scheduler,
      client,
      cycleRunner: null,
      logger: null,
      telegramState: state,
      texts
    });

    await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/users' });
    assert.equal(sent.length, 1, 'ответ должен уйти без ошибки разметки');
    assert.match(sent[0].text, /Пользователи бота/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateTelegramHtml ловит именно проблему с <id>', () => {
  const broken = [
    'Подтвердить: /approve <id>, отозвать: /deny <id>',
    '<b>жирный</b> и <неизвестный>тег</неизвестный>',
    '<b>не закрыт'
  ];
  const good = ['Обычный текст без разметки', '<b>жирный</b> и &lt;id&gt;', '<b>a</b> <u>b</u>'];
  for (const text of broken) {
    assert.ok(validateTelegramHtml(text).length > 0, `должно считаться сломанным: ${text}`);
  }
  for (const text of good) {
    assert.deepEqual(validateTelegramHtml(text), [], `должно считаться корректным: ${text}`);
  }
});
