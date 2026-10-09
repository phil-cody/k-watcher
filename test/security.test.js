/**
 * Тесты безопасности и корректности: постоянная проверка того, что
 * не утекают секреты и данные, нет лишних сетевых выходов и не врут подписи.
 *
 * Эти тесты — «забор»: если кто-то изменит код так, что токен попадёт в лог,
 * добавится запрос на чужой хост или подпись метрики разойдётся с данными, —
 * тест упадёт.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createLogger, redact } from '../src/util/logger.js';
import { createTexts } from '../src/texts/texts.js';
import { describeAnomalyDiagnostics } from '../src/parser/anomaly-detector.js';
import { renderJobMessage, renderJobMessages } from '../src/telegram/format.js';
import { analyzeAndDraft } from '../src/analysis/compose-analysis.js';
import { createCycleRunner } from '../src/scheduler/cycle.js';
import { JobStore } from '../src/storage/job-store.js';
import { KworkListingParser } from '../src/parser/job-parser.js';
import { makeFixtureJob, makeFixtureProfile } from './helpers/text-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });

/** Все .js файлы проекта (src + test) без node_modules. */
function listSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (['.js', '.json', '.md'].includes(extname(entry))) out.push(full);
  }
  return out;
}

test('секреты не попадают в лог даже в хвосте длинной строки', () => {
  const marker = 'ХВОСТ_СТРАНИЦЫ_МАРКЕР';
  const token = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOpp';
  const lines = [];
  const logger = createLogger({
    level: 'debug',
    sink: { log: (line) => lines.push(line), warn: (line) => lines.push(line), error: (line) => lines.push(line) }
  });

  logger.info('Страница получена', {
    url: 'https://kwork.ru/projects',
    html: `<html>${'x'.repeat(3000)}${marker}</html>`,
    telegramBotToken: token,
    authorization: `Bearer ${token}`
  });
  logger.error(`Токен: ${token}`);

  const log = lines.join('\n');
  assert.equal(log.includes(marker), false, 'хвост HTML не должен попадать в лог');
  assert.equal(/123456789:AAbb/.test(log), false, 'токен не должен попадать в лог');
  assert.match(log, /обрезано/, 'длинные значения должны обрезаться с пометкой');
  assert.match(log, /\[redacted\]/, 'секретные поля должны маскироваться');
});

test('redact вырезает все известные форматы секретов', () => {
  const samples = [
    '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOpp',
    'sk-abcdefghijklmnopqrstuvwx',
    'sk-ant-api03-abcdefghijklmnop',
    'Bearer abcdefghijklmnopqrstuvwx',
    'api_key=abcdefghijklmnop',
    'password: supersecret123'
  ];
  for (const sample of samples) {
    const cleaned = redact(`значение: ${sample}`);
    assert.doesNotMatch(cleaned, /abcdefghijklmnop/, `${sample} должен быть вырезан`);
    assert.match(cleaned, /\[redacted\]/);
  }
});

test('в репозитории нет секретов и .env не отслеживается', () => {
  const files = listSourceFiles(join(rootDir, 'src'))
    .concat(listSourceFiles(join(rootDir, 'config')))
    .concat(listSourceFiles(join(rootDir, 'docs')))
    .concat([join(rootDir, 'README.md'), join(rootDir, 'package.json'), join(rootDir, '.env.example')]);

  const tokenPattern = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/;
  for (const file of files) {
    if (file.endsWith('.env.example')) continue; // там только пустые плейсхолдеры
    const content = readFileSync(file, 'utf8');
    assert.doesNotMatch(content, tokenPattern, `в ${file} найден токен Telegram`);
    assert.doesNotMatch(content, /\bsk-[A-Za-z0-9]{20,}\b/, `в ${file} найден API-ключ`);
  }

  const gitignore = readFileSync(join(rootDir, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env$/m, '.env должен быть в .gitignore');
  assert.match(gitignore, /^data\/$/m, 'каталог data должен быть в .gitignore');
});

test('сетевые адреса в коде ограничены известным списком', () => {
  const allowedHosts = new Set([
    'kwork.ru',
    'api.telegram.org',
    'api.anthropic.com',
    // Хосты в комментариях и тестовых фикстурах.
    'github.com',
    'example.github.io',
    'example.com',
    'api.example.com',
    'cdn-edge.kwork.ru',
    'schema.org',
    'www.w3.org'
  ]);
  const files = listSourceFiles(join(rootDir, 'src'));
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
      assert.ok(allowedHosts.has(match[1]), `неожиданный хост в ${file}: ${match[1]}`);
    }
  }
});

test('на Kwork нет ни одного POST: только GET на объявленные URL', () => {
  const files = listSourceFiles(join(rootDir, 'src'));
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(/method:\s*'([A-Z]+)'/g)) {
      const method = match[1];
      if (method === 'GET') continue;
      // POST допустим только в Telegram-клиенте и (выключенном) адаптере модели.
      const isTelegram = file.includes('telegram');
      const isModel = file.includes('model-adapter');
      assert.ok(
        isTelegram || isModel,
        `${file}: метод ${method} вне Telegram/модели — на Kwork отправлять ничего нельзя`
      );
    }
  }
});

test('запросы к Kwork не содержат cookies, referer и авторизации', () => {
  const source = readFileSync(join(rootDir, 'src', 'source', 'kwork-html-source.js'), 'utf8');
  const headersBlock = /headers:\s*\{([\s\S]*?)\}/.exec(source)?.[1] ?? '';
  // Комментарии внутри блока не считаем: ищем именно имена заголовков.
  const headerNames = [...headersBlock.matchAll(/(?:^|\n)\s*['\"]?([a-zA-Z-]+)['\"]?\s*:/g)].map((match) =>
    match[1].toLowerCase()
  );
  assert.ok(headerNames.includes('user-agent'), 'должен быть только user-agent');
  for (const forbidden of ['cookie', 'authorization', 'referer', 'origin', 'x-forwarded-for']) {
    assert.equal(headerNames.includes(forbidden), false, `в заголовках запроса к Kwork не должно быть ${forbidden}`);
  }
  assert.deepEqual([...headerNames].sort(), ['accept', 'user-agent'], 'разрешены только user-agent и accept');
});

test('диагностика аномалии не содержит HTML целиком', () => {
  const marker = 'ХВОСТ_СТРАНИЦЫ_МАРКЕР';
  const html = `<html><head><title>Проверка безопасности</title></head><body>${'y'.repeat(4000)}${marker}</body></html>`;
  const diagnostics = describeAnomalyDiagnostics({ status: 200, url: 'https://kwork.ru/projects', html });
  assert.ok(diagnostics.excerpt.length <= 200, `выдержка слишком длинная: ${diagnostics.excerpt.length}`);
  assert.equal(diagnostics.excerpt.includes(marker), false);
  for (const entry of diagnostics.hard) {
    if (entry.snippet) assert.ok(entry.snippet.length <= 200, 'фрагмент маркера должен быть коротким');
  }
});

test('HTML не сохраняется ни в индекс, ни в журнал', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-'));
  try {
    const html = readFileSync(join(here, 'fixtures', 'listing-embedded-json.html'), 'utf8');
    const job = makeFixtureJob();
    const store = await new JobStore({ dataDir: dir }).init();
    const parser = new KworkListingParser({ targetCategories: [] });
    const runner = createCycleRunner({
      source: { fetchPage: async (url) => ({ html, status: 200, url }) },
      parser,
      store,
      profile: makeFixtureProfile(),
      notifier: { sendMessage: async () => ({}) },
      config: {
        rootDir,
        targetCategories: [],
        source: { allowedUrls: [{ url: 'https://kwork.ru/projects', enabled: true, pages: 1 }] },
        categoryMapping: { confirmed: false }
      },
      logger: null
    });
    await runner.runOnce();

    const index = readFileSync(join(dir, 'seen-index.json'), 'utf8');
    const processed = readFileSync(join(dir, 'processed-jobs.jsonl'), 'utf8');
    for (const [name, content] of [['seen-index.json', index], ['processed-jobs.jsonl', processed]]) {
      assert.doesNotMatch(content, /<html|<!doctype|<script|window\.__INITIAL_STATE__/i, `в ${name} попал HTML`);
    }
    // Профиль заказчика не сохраняется в индекс: только имя в заголовке задания.
    assert.doesNotMatch(index, /profilePictureSrcSet|USERID/);
    assert.equal(job.provenance.rawHtmlStored, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('файл состояния Telegram не содержит секретов и только публичные данные', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-tg-'));
  try {
    const { TelegramState } = await import('../src/telegram/state.js');
    const state = await new TelegramState({ dataDir: dir, ownerId: 111 }).init();
    state.rememberUser({ userId: 222, chatId: 222, username: 'client_one', name: 'Иван' });
    state.markNewUser(222);
    state.approveUser(222);
    await state.save();

    const raw = readFileSync(join(dir, 'telegram-state.json'), 'utf8');
    assert.doesNotMatch(raw, /\d{6,}:[A-Za-z0-9_-]{20,}/, 'токена в файле быть не должно');
    assert.doesNotMatch(raw, /token|api_key|secret/i, 'служебных полей с секретами нет');
    // Разрешены только идентификаторы, username и имя из Telegram.
    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed).sort(), [
      'approvedUsers',
      'chatId',
      'knownUsers',
      'offset',
      'ownerId',
      'publishedMenus',
      'seenUsers',
      'updatedAt'
    ]);
    assert.deepEqual(parsed.approvedUsers, [111, 222]);
    assert.equal(parsed.knownUsers['222'].username, 'client_one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('личные идентификаторы не уходят в логи цикла', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-'));
  try {
    const html = readFileSync(join(here, 'fixtures', 'listing-embedded-json.html'), 'utf8');
    const lines = [];
    const logger = {
      debug: (message, meta) => lines.push(`${message} ${JSON.stringify(meta ?? {})}`),
      info: (message, meta) => lines.push(`${message} ${JSON.stringify(meta ?? {})}`),
      warn: (message, meta) => lines.push(`${message} ${JSON.stringify(meta ?? {})}`),
      error: (message, meta) => lines.push(`${message} ${JSON.stringify(meta ?? {})}`)
    };
    const store = await new JobStore({ dataDir: dir }).init();
    const runner = createCycleRunner({
      source: { fetchPage: async (url) => ({ html, status: 200, url }) },
      parser: new KworkListingParser({ targetCategories: [] }),
      store,
      profile: makeFixtureProfile(),
      notifier: { sendMessage: async () => ({}) },
      config: {
        rootDir,
        targetCategories: [],
        source: { allowedUrls: [{ url: 'https://kwork.ru/projects', enabled: true, pages: 1 }] },
        categoryMapping: { confirmed: false }
      },
      logger
    });
    await runner.runOnce();

    const log = lines.join('\n');
    // В логе допустимы id заданий, но не персональные данные заказчика и не chat id.
    assert.doesNotMatch(log, /test_client_one|test_client_two/);
    assert.doesNotMatch(log, /USERID/);
    assert.doesNotMatch(log, /profilePictureSrcSet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('окно опроса и интервал не выходят за подтверждённые границы', () => {
  const config = JSON.parse(readFileSync(join(rootDir, 'config', 'default.json'), 'utf8'));
  assert.ok(config.schedule.minIntervalSeconds >= 240, 'минимальный интервал не может быть меньше 240 с');
  assert.ok(config.schedule.maxIntervalSeconds <= 600, 'максимальный интервал не может быть больше 600 с');
  assert.equal(config.source.pruneMissingJobs, true);
  // Базовый адрес источника — список заданий, не страница задания.
  assert.match(config.source.baseUrl, /^https:\/\/kwork\.ru$/);
});

test('сообщение не содержит ничего, кроме данных задания и анализа', async () => {
  const job = makeFixtureJob();
  const profile = makeFixtureProfile();
  const analysis = await analyzeAndDraft(job, profile, { config: {} });
  const messages = renderJobMessages(job, analysis, { texts });
  const all = messages.join('\n');

  // Токены, ключи и служебные заголовки в сообщении недопустимы.
  assert.doesNotMatch(all, /\bsk-[A-Za-z0-9]{10,}\b/);
  assert.doesNotMatch(all, /Bearer\s/);
  assert.doesNotMatch(all, /\d{6,}:[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(all, /cookie|authorization/i);
  // Каждая часть — валидная разметка: число <b> и </b> совпадает.
  for (const part of messages) {
    assert.equal(
      (part.match(/<b>/g) ?? []).length,
      (part.match(/<\/b>/g) ?? []).length,
      'у каждого <b> должен быть закрывающий тег'
    );
  }
});

test('подписи метрик соответствуют данным (предложения ≠ заказы)', async () => {
  const job = makeFixtureJob({ extra: { status: 'active', offersCount: 11, kworkCount: 3, views: 50, maxDays: 7, timeLeft: '1 д.' } });
  const profile = makeFixtureProfile();
  const analysis = await analyzeAndDraft(job, profile, { config: {} });
  const message = renderJobMessage(job, analysis, { texts });

  assert.match(message, /предложений к заданию: 11/, 'offersCount — это предложения к заданию');
  assert.match(message, /заказов у заказчика: 3/, 'kworkCount — это заказы заказчика');
  assert.doesNotMatch(message, /заказов: 11/, 'нельзя называть предложения заказами');
});

test('для заказчика показываются предложения и заказы, и каждое число подписано верно', async () => {
  const job = makeFixtureJob({
    client: { name: 'client_one', meta: 'https://kwork.ru/user/client_one' },
    extra: { status: 'active', offersCount: 4, kworkCount: 12, views: 100, maxDays: 5, timeLeft: '1 д.' }
  });
  const analysis = await analyzeAndDraft(job, makeFixtureProfile(), { config: {} });
  const message = renderJobMessage(job, analysis, { texts });

  assert.match(message, /Заказчик/);
  assert.match(message, /предложений к заданию: 4/);
  assert.match(message, /заказов у заказчика: 12/);
  // Числа не должны перепутываться местами.
  assert.doesNotMatch(message, /предложений к заданию: 12/);
  assert.doesNotMatch(message, /заказов у заказчика: 4/);
  // Ссылка на профиль заказчика в сообщении не выводится (это лишние персональные данные).
  assert.doesNotMatch(message, /kwork\.ru\/user\//);
});

test('в сообщении видно, что страница задания не открывалась', async () => {
  const job = makeFixtureJob();
  const analysis = await analyzeAndDraft(job, makeFixtureProfile(), { config: {} });
  const message = renderJobMessage(job, analysis, { texts });
  assert.match(message, /страница задания не открывалась/);
  assert.match(message, /Черновик отклика/);
  assert.match(message, /на Kwork не отправлен/);
});
