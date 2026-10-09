/**
 * Тесты загрузки профиля через Telegram: пользователь отправляет файл,
 * бот его проверяет и сохраняет. Файл принимается только после /profile upload.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KworkWatcherBot } from '../src/bot/kwork-watcher-bot.js';
import { ProfileStore } from '../src/storage/profile-store.js';
import { TelegramState } from '../src/telegram/state.js';
import { createTexts } from '../src/texts/texts.js';
import { makeFixtureProfile } from './helpers/text-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });
const realProfile = JSON.parse(await readFile(resolve(rootDir, 'config', 'performer-profile.json'), 'utf8'));

/** Бот с поддельным клиентом: файл «скачивается» из заранее заданного текста. */
async function makeBot({ fileText = null, downloadError = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'upload-'));
  const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
  state.rememberUser({ userId: 111, chatId: 111, username: 'owner' });
  state.approveUser(111);

  const profiles = new ProfileStore({ dataDir: dir });
  const sent = [];
  const documents = [];
  const client = {
    fileText,
    downloadError,
    chatId: 111,
    get initialized() {
      return true;
    },
    sendMessage: async (text, options = {}) => {
      sent.push({ text, chatId: options.chatId ?? null });
      return {};
    },
    // Переопределяемый источник файла: тесты подменяют его на лету.
    downloadFile: async () => {
      if (client.downloadError) throw new Error(client.downloadError);
      return { text: client.fileText, bytes: Buffer.byteLength(String(client.fileText ?? ''), 'utf8') };
    },
    sendDocument: async ({ fileName, content, chatId }) => {
      documents.push({ fileName, content, chatId });
      return {};
    }
  };

  const bot = new KworkWatcherBot({
    config: { rootDir, telegram: {}, schedule: { minIntervalSeconds: 240, maxIntervalSeconds: 600 } },
    profile: null,
    profiles,
    profileTemplate: { text: JSON.stringify(realProfile, null, 2), path: 'config/performer-profile.json' },
    store: null,
    scheduler: null,
    client,
    cycleRunner: null,
    logger: null,
    telegramState: state,
    texts
  });

  return {
    bot,
    profiles,
    sent,
    documents,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

test('/profile upload просит прислать файл и включает ожидание', async () => {
  const { bot, sent, cleanup } = await makeBot({ fileText: JSON.stringify(realProfile) });
  try {
    await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile upload' });
    assert.match(sent.at(-1).text, /Пришлите файл профиля/);
    assert.equal(bot.isWaitingForProfile(111), true, 'бот должен ждать файл');
  } finally {
    await cleanup();
  }
});

test('присланный файл сохраняется как личный профиль', async () => {
  const { bot, profiles, sent, cleanup } = await makeBot({ fileText: JSON.stringify(realProfile) });
  try {
    await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile upload' });
    const result = await bot.handleIncoming({
      fromId: 111,
      chatId: 111,
      text: '',
      document: { fileId: 'file-1', fileName: 'performer-profile.json', mimeType: 'application/json', size: 1000 }
    });

    assert.equal(result.action, 'profile-saved');
    assert.match(sent.at(-1).text, /Профиль сохранён/);
    assert.equal(profiles.has(111), true, 'профиль должен появиться на диске');
    const saved = await profiles.get(111);
    assert.equal(saved.source, 'personal');
    assert.equal(saved.profile.pricing.hourly_rate, realProfile.pricing.hourly_rate);
    assert.equal(bot.isWaitingForProfile(111), false, 'ожидание сбрасывается');
  } finally {
    await cleanup();
  }
});

test('файл без предварительного /profile upload игнорируется', async () => {
  const { bot, profiles, sent, cleanup } = await makeBot({ fileText: JSON.stringify(realProfile) });
  try {
    const result = await bot.handleIncoming({
      fromId: 111,
      chatId: 111,
      text: '',
      document: { fileId: 'file-1', fileName: 'profile.json' }
    });
    assert.equal(result, null, 'файл не должен обрабатываться');
    assert.equal(profiles.has(111), false);
    assert.equal(sent.length, 0, 'бот не должен отвечать на случайный файл');
  } finally {
    await cleanup();
  }
});

test('битый профиль отклоняется с понятной причиной, старый не теряется', async () => {
  const { bot, profiles, sent, cleanup } = await makeBot({ fileText: '{"skills": ["HTML"]' });
  try {
    // Сначала сохраняем корректный профиль.
    bot.client.fileText = JSON.stringify(realProfile);
    await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile upload' });
    await bot.handleIncoming({ fromId: 111, chatId: 111, document: { fileId: 'ok' } });
    assert.equal(profiles.has(111), true);

    // Теперь присылаем битый: он должен быть отклонён, а прежний профиль — остаться.
    bot.client.fileText = '{"skills": ["HTML"]';
    await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile upload' });
    const result = await bot.handleIncoming({ fromId: 111, chatId: 111, document: { fileId: 'broken' } });

    assert.equal(result.action, 'profile-rejected');
    assert.match(sent.at(-1).text, /Профиль не принят/);
    assert.match(sent.at(-1).text, /JSON/);
    const kept = await profiles.get(111);
    assert.equal(kept.source, 'personal');
    assert.equal(kept.profile.pricing.hourly_rate, realProfile.pricing.hourly_rate);
  } finally {
    await cleanup();
  }
});

test('ошибка скачивания файла объясняется пользователю', async () => {
  const { bot, sent, cleanup } = await makeBot({ downloadError: 'Файл больше 256 КБ' });
  try {
    await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile upload' });
    const result = await bot.handleIncoming({ fromId: 111, chatId: 111, document: { fileId: 'big' } });
    assert.equal(result.action, 'profile-rejected');
    assert.match(sent.at(-1).text, /Не удалось получить файл/);
    assert.match(sent.at(-1).text, /256 КБ/);
  } finally {
    await cleanup();
  }
});

test('/profile показывает источник: личный, общий или отсутствует', async () => {
  const { bot, sent, cleanup } = await makeBot();
  try {
    await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile' });
    assert.match(sent.at(-1).text, /не загружен|Профиль: не задан/);

    bot.client.fileText = JSON.stringify(realProfile);
    await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile upload' });
    await bot.handleIncoming({ fromId: 111, chatId: 111, document: { fileId: 'ok' } });

    await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile' });
    assert.match(sent.at(-1).text, /личный, загружен вами/);
  } finally {
    await cleanup();
  }
});

test('/profile template отправляет файл шаблона', async () => {
  const { bot, documents, cleanup } = await makeBot();
  try {
    await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile template' });
    assert.equal(documents.length, 1);
    assert.equal(documents[0].fileName, 'performer-profile.template.json');
    assert.equal(documents[0].chatId, 111);
    const parsed = JSON.parse(documents[0].content);
    assert.equal(parsed.pricing.hourly_rate, realProfile.pricing.hourly_rate);
  } finally {
    await cleanup();
  }
});

test('выбор категорий из профиля применяется при загрузке', async () => {
  const { CategoryPreferences, createCategoryCatalog } = await import('../src/storage/category-store.js');
  const { loadConfig } = await import('../src/config/load-config.js');
  const { config } = loadConfig({ rootDir, env: {}, readEnvFile: false });
  const harness = await makeBot();
  try {
    const categories = new CategoryPreferences({ dataDir: harness.bot.profiles.dir.replace(/\/profiles$/, ''), catalog: createCategoryCatalog(config) });
    harness.bot.categories = categories;
    harness.bot.client.fileText = JSON.stringify({ ...realProfile, categoriesSelection: [37, 273] });

    await harness.bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile upload' });
    const result = await harness.bot.handleIncoming({ fromId: 111, chatId: 111, document: { fileId: 'ok' } });

    assert.equal(result.action, 'profile-saved');
    assert.deepEqual(await categories.get(111), [37, 273], 'выбор из профиля сохранён');

    // Значение all тоже поддерживается.
    harness.bot.client.fileText = JSON.stringify({ ...realProfile, categoriesSelection: 'all' });
    await harness.bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile upload' });
    await harness.bot.handleIncoming({ fromId: 111, chatId: 111, document: { fileId: 'ok2' } });
    assert.equal(await categories.get(111), 'all');
  } finally {
    await harness.cleanup();
  }
});

test('после загрузки профиля получатели синхронизируются для цикла', async () => {
  const { bot, profiles, cleanup } = await makeBot({ fileText: JSON.stringify(realProfile) });
  try {
    const written = [];
    bot.store = {
      writeState: async (patch) => {
        written.push(patch);
        return {};
      }
    };

    await bot.syncRecipients();
    assert.deepEqual(written.at(-1), { telegram: { recipients: [{ userId: 111, chatId: 111 }] } });

    await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile upload' });
    await bot.handleIncoming({ fromId: 111, chatId: 111, document: { fileId: 'ok' } });
    // Профиль сохранён — цикл возьмёт его при следующем проходе.
    assert.equal((await profiles.get(111)).source, 'personal');
  } finally {
    await cleanup();
  }
});
