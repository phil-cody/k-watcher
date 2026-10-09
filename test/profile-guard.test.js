/**
 * Тесты защиты загрузки файла профиля.
 *
 * Загрузка файла — единственная точка, где в приложение попадают данные от других людей.
 * Здесь проверяются все уровни: тип файла, размер, глубина, схема, запрещённые ключи,
 * лимиты значений и ограничение частоты.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProfileStore, checkFileType, ALLOWED_FILE_EXTENSIONS } from '../src/storage/profile-store.js';
import { checkProfileShape, preflightJson, LIMITS } from '../src/storage/profile-guard.js';
import { KworkWatcherBot } from '../src/bot/kwork-watcher-bot.js';
import { TelegramState } from '../src/telegram/state.js';
import { createTexts } from '../src/texts/texts.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });

/** Минимальный пригодный профиль. */
const minimalProfile = () => ({
  profile_version: 1,
  headline: 'Вёрстка',
  skills: ['HTML', 'CSS'],
  pricing: { minimum_project_price: 2000 }
});

test('preflightJson ловит пустой файл, размер и глубокую вложенность', () => {
  assert.match(preflightJson('').error, /пуст/i);
  assert.match(preflightJson('x'.repeat(300 * 1024)).error, /больше 256 КБ/);
  assert.match(preflightJson('{"a": ').error, /не сбалансированы/);

  // Глубокая вложенность: собираем 200 уровней и убеждаемся, что разбор не начнётся.
  const deep = `${'['.repeat(200)}1${']'.repeat(200)}`;
  assert.match(preflightJson(deep).error, /глубокая вложенность/);

  // Управляющие символы — не JSON.
  assert.match(preflightJson('{"a": "\u0000"}').error, /управляющие символы/);

  // Корректный профиль проходит и сообщает глубину.
  const ok = preflightJson(JSON.stringify(minimalProfile()));
  assert.equal(ok.ok, true);
  assert.ok(ok.maxDepth > 0);
});

test('checkFileType принимает только JSON и текст', () => {
  assert.equal(checkFileType({ fileName: 'profile.json' }).ok, true);
  assert.equal(checkFileType({ fileName: 'ПРОФИЛЬ.JSON' }).ok, true);
  assert.equal(checkFileType({ fileName: 'profile.txt' }).ok, true);
  assert.equal(checkFileType({ fileName: 'profile.json', mimeType: 'application/json' }).ok, true);
  assert.equal(checkFileType({ mimeType: 'text/plain' }).ok, true);
  assert.equal(checkFileType({}).ok, true, 'без метаданных пропускаем: проверим содержимое');

  for (const name of ['profile.zip', 'profile.exe', 'script.sh', 'payload.js', 'page.html', 'archive.tar.gz']) {
    assert.equal(checkFileType({ fileName: name }).ok, false, `${name} должен быть отклонён`);
  }
  assert.equal(checkFileType({ fileName: 'p.json', mimeType: 'application/zip' }).ok, false);
  assert.match(checkFileType({ fileName: 'a.zip' }).error, new RegExp(ALLOWED_FILE_EXTENSIONS.join('|')));
});

test('checkProfileShape отклоняет запрещённые ключи и неверные типы', () => {
  // prototype pollution: ключ __proto__ в тексте файла.
  const polluted = JSON.parse('{"skills":["HTML"],"__proto__":{"isAdmin":true}}');
  const protoResult = checkProfileShape(polluted);
  assert.equal(protoResult.ok, false);
  assert.match(protoResult.problems.join(' '), /Запрещённый ключ/);
  // И сам объект не пострадал.
  assert.equal({}.isAdmin, undefined);

  assert.equal(checkProfileShape({ skills: 'HTML' }).ok, false);
  assert.equal(checkProfileShape({ skills: ['HTML'], pricing: { hourly_rate: 'много' } }).ok, false);
  assert.equal(checkProfileShape({ skills: ['HTML'], availability: { timezone: 123 } }).ok, false);
  assert.equal(checkProfileShape({ skills: ['HTML'], portfolio: ['строка вместо объекта'] }).ok, false);
  assert.equal(checkProfileShape({ skills: ['HTML'], proposal_preferences: { must_mention: 'не массив' } }).ok, false);
  assert.equal(checkProfileShape([1, 2, 3]).ok, false);

  // Границы чисел: отрицательная цена и абсурдный часовой пояс.
  assert.equal(checkProfileShape({ skills: ['HTML'], pricing: { hourly_rate: -100 } }).ok, false);
  assert.equal(checkProfileShape({ skills: ['HTML'], availability: { hours_per_week: 500 } }).ok, false);

  // Корректный профиль проходит.
  assert.equal(checkProfileShape(minimalProfile()).ok, true);
});

test('checkProfileShape ограничивает длины и количество элементов', () => {
  const longString = checkProfileShape({ headline: 'a'.repeat(LIMITS.maxStringLength + 1), skills: ['HTML'] });
  assert.equal(longString.ok, false);
  assert.match(longString.problems.join(' '), /длиннее/);

  const manySkills = checkProfileShape({
    skills: Array.from({ length: LIMITS.maxSkills + 5 }, (_, index) => `навык-${index}`)
  });
  assert.equal(manySkills.ok, false);

  const manyKeys = checkProfileShape({
    skills: ['HTML'],
    portfolio: Array.from({ length: LIMITS.maxPortfolioItems + 1 }, (_, index) => ({ name: `работа-${index}` }))
  });
  assert.equal(manyKeys.ok, false);

  // Слишком много ключей в объекте.
  const wide = { skills: ['HTML'] };
  for (let index = 0; index < LIMITS.maxKeys + 10; index += 1) wide[`field_${index}`] = 'x';
  assert.equal(checkProfileShape(wide).ok, false);
});

test('checkProfileShape предупреждает о разметке, но не ломает обычные навыки', () => {
  // Ложное срабатывание: навык с двоеточием после названия технологии.
  const skill = checkProfileShape({ skills: ['Базовый JavaScript: меню, табы, модальные окна'] });
  assert.equal(skill.ok, true, 'обычный навык не должен считаться ссылкой');

  for (const bad of ['<script>alert(1)</script>', 'javascript:alert(1)', '<iframe src=x>']) {
    const result = checkProfileShape({ skills: [bad], pricing: { hourly_rate: 100 } });
    assert.equal(result.ok, false, `${bad} должен быть отклонён`);
  }
});

test('checkProfileShape проверяет выбор категорий', () => {
  assert.equal(checkProfileShape({ skills: ['HTML'], categoriesSelection: 'all' }).ok, true);
  assert.equal(checkProfileShape({ skills: ['HTML'], categoriesSelection: [37, 38] }).ok, true);
  assert.equal(checkProfileShape({ skills: ['HTML'], categoriesSelection: [0] }).ok, false);
  assert.equal(checkProfileShape({ skills: ['HTML'], categoriesSelection: [-5] }).ok, false);
  assert.equal(checkProfileShape({ skills: ['HTML'], categoriesSelection: 'мусор' }).ok, false);
  assert.equal(checkProfileShape({ skills: ['HTML'], categoriesSelection: [{}] }).ok, false);
});

test('ProfileStore.parse не разбирает опасные файлы', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guard-'));
  try {
    const store = new ProfileStore({ dataDir: dir });

    // Глубокая вложенность не доходит до JSON.parse.
    const deep = `${'['.repeat(500)}1${']'.repeat(500)}`;
    assert.match(store.parse(deep).error, /глубокая вложенность/);

    // Несбалансированные скобки.
    assert.match(store.parse('{"skills": ["HTML"').error, /не сбалансированы/);

    // Запрещённый ключ.
    assert.match(store.parse('{"skills":["HTML"],"__proto__":{"x":1}}').error, /Запрещённый ключ/);

    // Неверный тип.
    assert.match(store.parse('{"skills":"HTML"}').error, /skills/);

    // Расширение файла.
    assert.match(store.parse(JSON.stringify(minimalProfile()), { fileName: 'evil.zip' }).error, /Ожидался файл/);
    assert.match(store.parse(JSON.stringify(minimalProfile()), { mimeType: 'application/zip' }).error, /Недопустимый тип/);

    // Корректный файл проходит.
    const ok = store.parse(JSON.stringify(minimalProfile()), {
      fileName: 'profile.json',
      mimeType: 'application/json'
    });
    assert.equal(ok.ok, true, ok.error);
    // Предупреждения о неполном профиле приходят, но не мешают сохранению.
    assert.ok(Array.isArray(ok.warnings));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('слишком большой файл отклоняется до разбора', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guard-'));
  try {
    const store = new ProfileStore({ dataDir: dir });
    const huge = JSON.stringify({ skills: ['HTML'], notes: ['x'.repeat(300 * 1024)] });
    assert.match(store.parse(huge).error, /больше 256 КБ/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('частота загрузок ограничена', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guard-'));
  try {
    // Детерминированные часы: проверка не должна зависеть от скорости машины.
    let clock = 1_000_000;
    const now = () => clock;
    const state = new TelegramState({ dataDir: dir, ownerId: 111 });
    state.rememberUser({ userId: 111, chatId: 111 });
    state.approveUser(111);
    const sent = [];
    const bot = new KworkWatcherBot({
      config: { rootDir, telegram: {} },
      profile: null,
      profiles: new ProfileStore({ dataDir: dir }),
      store: null,
      scheduler: null,
      client: {
        chatId: 111,
        initialized: true,
        sendMessage: async (text) => sent.push(text),
        downloadFile: async () => ({ text: JSON.stringify(minimalProfile()) }),
        sendDocument: async () => ({})
      },
      cycleRunner: null,
      logger: null,
      telegramState: state,
      now,
      texts
    });

    // Пять попыток проходят, шестая — нет.
    for (let index = 0; index < 5; index += 1) {
      assert.equal(bot.checkUploadRate(111).allowed, true, `попытка ${index + 1} должна проходить`);
    }
    const blocked = bot.checkUploadRate(111);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);

    // Спустя окно ожидания снова можно: сдвигаем часы на 11 минут.
    clock += 11 * 60 * 1000;
    const afterWindow = bot.checkUploadRate(111);
    assert.equal(afterWindow.allowed, true, 'после окна лимит должен сбрасываться');
    assert.equal(bot.profileUploadAttempts.get(111).length, 1, 'старые попытки забываются');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('через бота принимается только корректный профиль', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guard-'));
  try {
    const state = new TelegramState({ dataDir: dir, ownerId: 111 });
    state.rememberUser({ userId: 111, chatId: 111 });
    state.approveUser(111);
    const profiles = new ProfileStore({ dataDir: dir });
    const sent = [];
    const client = {
      chatId: 111,
      initialized: true,
      sendMessage: async (text) => sent.push(text),
      downloadFile: async () => ({ text: client.fileText }),
      sendDocument: async () => ({}),
      fileText: ''
    };
    const bot = new KworkWatcherBot({
      config: { rootDir, telegram: {} },
      profile: null,
      profiles,
      store: null,
      scheduler: null,
      client,
      cycleRunner: null,
      logger: null,
      telegramState: state,
      texts
    });

    // Плохие файлы: архив по имени, глубокая вложенность, запрещённый ключ.
    const cases = [
      { fileText: JSON.stringify(minimalProfile()), fileName: 'profile.zip', pattern: /Ожидался файл/ },
      { fileText: `${'['.repeat(500)}1${']'.repeat(500)}`, fileName: 'p.json', pattern: /глубокая вложенность/ },
      { fileText: '{"skills":["HTML"],"__proto__":{"x":1}}', fileName: 'p.json', pattern: /Запрещённый ключ/ },
      { fileText: '{"skills":"HTML"}', fileName: 'p.json', pattern: /skills/ }
    ];
    for (const item of cases) {
      client.fileText = item.fileText;
      await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile upload' });
      const result = await bot.handleIncoming({
        fromId: 111,
        chatId: 111,
        document: { fileId: 'f', fileName: item.fileName, mimeType: 'application/json' }
      });
      assert.equal(result.action, 'profile-rejected', `${item.fileName} должен быть отклонён`);
      assert.match(sent.at(-1), item.pattern);
      assert.equal(profiles.has(111), false, 'плохой файл не должен сохраняться');
    }

    // Хороший файл сохраняется.
    client.fileText = JSON.stringify(minimalProfile());
    await bot.handleIncoming({ fromId: 111, chatId: 111, text: '/profile upload' });
    const good = await bot.handleIncoming({
      fromId: 111,
      chatId: 111,
      document: { fileId: 'f', fileName: 'profile.json', mimeType: 'application/json' }
    });
    assert.equal(good.action, 'profile-saved');
    assert.equal(profiles.has(111), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('настоящий config/performer-profile.json проходит все проверки', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(resolve(rootDir, 'config', 'performer-profile.json'), 'utf8');
  const store = new ProfileStore({ dataDir: tmpdir() });
  const result = store.parse(raw, { fileName: 'performer-profile.json', mimeType: 'application/json' });
  assert.equal(result.ok, true, result.error);
});
