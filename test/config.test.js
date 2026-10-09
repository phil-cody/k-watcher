import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadConfig, validateConfig, validateProfile, validateSourceUrl, parseEnvFile, ConfigError } from '../src/config/load-config.js';
import { preflight, describePlan, dispatchCommand } from '../src/bot/kwork-watcher-bot.js';
import { planNextRequestWithHistory } from '../src/util/time.js';
import { redact, createLogger } from '../src/util/logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');

/**
 * Тесты не должны зависеть от заполненного рабочего .env и не должны видеть его
 * секреты: чтение .env отключено, окружение передаётся явно.
 */
const cleanEnv = {};
const loadIsolated = (options = {}) => loadConfig({ rootDir, env: cleanEnv, readEnvFile: false, ...options });

test('рабочая конфигурация загружается и проходит проверку', () => {
  const { config, profile, validation } = loadIsolated();
  assert.equal(config.schedule.timezone, 'Europe/Moscow');
  // Значения окна берём из конфига: пользователь может их менять, тест не должен ломаться.
  assert.match(config.schedule.windowStart, /^\d{2}:\d{2}$/);
  assert.match(config.schedule.windowEnd, /^\d{2}:\d{2}$/);
  assert.equal(config.schedule.minIntervalSeconds >= 240, true, 'минимум не может быть меньше 240 с');
  assert.equal(config.schedule.maxIntervalSeconds <= 600, true, 'максимум не может быть больше 600 с');
  assert.equal(config.schedule.firstRequestNoDelay, true, 'первый запрос после старта идёт без паузы');
  // Список URL пользователь может менять: проверяем структуру, а не конкретный набор.
  assert.ok(config.source.allowedUrls.length >= 1, 'нужен хотя бы один разрешённый URL');
  for (const entry of config.source.allowedUrls) {
    assert.match(entry.url, /^https:\/\/kwork\.ru\/projects(\?c=\d+)?$/, `недопустимый URL: ${entry.url}`);
    assert.equal(entry.pagination, false);
    assert.equal(Number(entry.pages) >= 1, true);
  }
  assert.equal(config.model.provider, 'heuristic');
  assert.equal(profile.pricing.minimum_project_price, 2000);
  assert.equal(validation.ok, true, validation.errors.join('; '));
});

test('URL категорий с ?c= разрешены только если перечислены в конфигурации', () => {
  const { config } = loadIsolated();
  const declared = config.source.allowedUrls.map((entry) => entry.url);
  // Объявленные URL и их страницы должны быть разрешены — набор берём из конфига.
  for (const url of declared) {
    assert.equal(validateSourceUrl(url, { allowedUrls: declared }).ok, true, `${url} должен быть разрешён`);
    for (const page of [2, 5]) {
      const withPage = `${url}${url.includes('?') ? '&' : '?'}page=${page}`;
      assert.equal(
        validateSourceUrl(withPage, { allowedUrls: declared }).ok,
        true,
        `${withPage} должен быть разрешён как страница`
      );
      // Порядок параметров не важен: ?page=2&c=79 — та же страница, что ?c=79&page=2.
      const reversed = url.includes('?c=')
        ? `https://kwork.ru/projects?page=${page}&c=${url.split('c=')[1]}`
        : `https://kwork.ru/projects?page=${page}`;
      assert.equal(validateSourceUrl(reversed, { allowedUrls: declared }).ok, true, `${reversed} должен быть разрешён`);
    }
  }

  // Необъявленные параметры, чужие категории и мусорные page запрещены.
  for (const url of [
    'https://kwork.ru/projects?c=999',
    'https://kwork.ru/projects?c=999&page=2',
    'https://kwork.ru/projects?c=38&page=2&evil=1',
    'https://kwork.ru/projects?page=0',
    'https://kwork.ru/projects?page=abc'
  ]) {
    assert.equal(validateSourceUrl(url, { allowedUrls: declared }).ok, false, `${url} должен быть отклонён`);
  }

  // Страница задания запрещена при любых обстоятельствах.
  assert.equal(validateSourceUrl('https://kwork.ru/projects/12345/some-job', { allowedUrls: declared }).ok, false);
});

test('первый запрос без паузы не отменяет выдержку после перезапуска', () => {
  const schedule = {
    timezone: 'Europe/Moscow',
    windowStart: '05:00',
    windowEnd: '19:00',
    minIntervalSeconds: 240,
    maxIntervalSeconds: 600
  };
  const now = new Date(Date.UTC(2026, 9, 7, 7, 0, 0)); // 10:00 МСК
  const immediate = planNextRequestWithHistory({
    now,
    schedule: { ...schedule, firstRequestNoDelay: true },
    hasPriorRequest: false,
    lastRequestAt: null,
    chooseInterval: () => 300000
  });
  assert.equal(immediate.action, 'immediate');

  const afterRestart = planNextRequestWithHistory({
    now,
    schedule: { ...schedule, firstRequestNoDelay: true },
    hasPriorRequest: false,
    lastRequestAt: new Date(now.getTime() - 60000), // запрос был минуту назад
    chooseInterval: () => 300000
  });
  assert.equal(afterRestart.action, 'wait');
  assert.equal(afterRestart.waitMs, 180000, 'ждём остаток минимального интервала');
});

test('интервал вне 240–600 секунд считается ошибкой, а не «починится» молча', () => {
  const { config } = loadIsolated();
  const broken = {
    ...config,
    schedule: { ...config.schedule, minIntervalSeconds: 60, maxIntervalSeconds: 900 }
  };
  const result = validateConfig(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /240–600/.test(error)));
});

test('живой источник требует включения и подтверждения пользователя', () => {
  const { config } = loadIsolated();
  const disabled = { ...config, source: { ...config.source, enabled: false } };
  const result = validateConfig(disabled, { requireLiveSource: true });
  assert.equal(result.ok, false, 'source.enabled=false должен блокировать живой запуск');
  assert.ok(result.errors.some((error) => /source\.enabled = false/.test(error)));

  const confirmed = {
    ...config,
    source: { ...config.source, enabled: true, permission: { ...config.source.permission, status: 'confirmed' } }
  };
  assert.equal(validateConfig(confirmed, { requireLiveSource: true }).ok, true);
});

test('пейджинация без подтверждения запрещена', () => {
  const { config } = loadIsolated();
  const withPagination = {
    ...config,
    source: {
      ...config.source,
      pagination: { ...config.source.pagination, enabled: false },
      allowedUrls: [{ ...config.source.allowedUrls[0], pages: 3, pagination: true }]
    }
  };
  const result = validateConfig(withPagination, { requireLiveSource: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /Пейджинация не подтверждена/.test(error)));

  // При включённой пагинации те же URL допустимы.
  const enabled = {
    ...withPagination,
    source: { ...withPagination.source, pagination: { enabled: true, maxPagesPerUrl: 3 } }
  };
  assert.equal(validateConfig(enabled, { requireLiveSource: true }).ok, true);
});

test('validateSourceUrl пропускает только список заданий', () => {
  assert.equal(validateSourceUrl('https://kwork.ru/projects').ok, true);
  for (const url of [
    'https://kwork.ru/projects/12345/some-job',
    'https://kwork.ru/projects?page=2',
    'http://kwork.ru/projects',
    'https://kwork.ru/api/v1/projects',
    'https://kwork.ru/user/12345',
    'https://example.com/projects',
    'не-url'
  ]) {
    assert.equal(validateSourceUrl(url).ok, false, `${url} должен быть отклонён`);
  }
});

test('секреты читаются только из окружения и не попадают в объект конфигурации', () => {
  const { config } = loadIsolated();
  assert.equal(config.secrets.telegramBotToken, undefined);
  assert.equal(config.secrets.llmApiKey, undefined);

  const withSecrets = loadIsolated({
    env: {
      TELEGRAM_BOT_TOKEN: '123456789:AAaaBBbbCCccDDddEEeeFFffGGgg',
      TELEGRAM_ALLOWED_USER_ID: '4242',
      MODEL_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'https://api.example.com/v1',
      LLM_API_KEY: 'sk-test-key-1234567890',
      LLM_MODEL: 'example-model'
    }
  });
  assert.equal(withSecrets.config.secrets.telegramBotToken, '123456789:AAaaBBbbCCccDDddEEeeFFffGGgg');
  assert.equal(withSecrets.config.secrets.telegramAllowedUserId, 4242);
  assert.equal(withSecrets.config.model.provider, 'openai-compatible');
  // В самом JSON-конфиге секретов быть не должно.
  const rawConfig = readFileSync(resolve(rootDir, 'config', 'default.json'), 'utf8');
  assert.doesNotMatch(rawConfig, /sk-test|AAaaBBbbCCcc/);
  assert.doesNotMatch(rawConfig, /TELEGRAM_BOT_TOKEN/);
});

test('секреты из рабочего .env не попадают в конфигурацию и в логи', () => {
  // Читаем .env только чтобы убедиться: его значения не утекают в конфиг и логи.
  const envPath = resolve(rootDir, '.env');
  const raw = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const tokenMatch = /TELEGRAM_BOT_TOKEN\s*=\s*"?([^\s"]+)"?/.exec(raw);
  if (!tokenMatch) return; // .env отсутствует или не заполнен — проверять нечего

  const token = tokenMatch[1];
  // Маркер для поиска утечки: значение не печатаем в сообщениях об ошибке.
  const leakMarker = token.slice(8, 24);
  const { config } = loadConfig({ rootDir, env: {} }); // как в реальном запуске: .env читается
  assert.equal(config.secrets.telegramBotToken, token, 'токен должен читаться из .env');
  assert.equal(JSON.stringify(config.source).includes(leakMarker), false, 'секрет не должен попадать в source');
  assert.equal(JSON.stringify(config.model).includes(leakMarker), false, 'секрет не должен попадать в model');

  const lines = [];
  const logger = createLogger({
    level: 'debug',
    sink: { log: (line) => lines.push(line), warn: (line) => lines.push(line), error: (line) => lines.push(line) }
  });
  logger.error(`Токен бота: ${token}`);
  logger.info('Конфигурация', { token, note: raw.slice(0, 200) });
  const logged = lines.join('\n');
  assert.equal(logged.includes(leakMarker), false, 'токен не должен попадать в логи');
  assert.match(logged, /\[redacted\]/);
  assert.equal(logged.includes('TELEGRAM_ALLOWED_USER_ID='), false, 'содержимое .env не должно логироваться');
});

test('переменные из .env доступны, но окружение имеет приоритет', () => {
  const parsed = parseEnvFile('A=1\n# комментарий\nB="two words"\n\nC=3\n');
  assert.deepEqual(parsed, { A: '1', B: 'two words', C: '3' });
});

test('ошибка в профиле не роняет загрузку, а предупреждает', () => {
  const result = validateProfile({ skills: [], portfolio: [] });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.length > 0);
});

test('некорректный часовой пояс — ошибка конфигурации', () => {
  const { config } = loadIsolated();
  const result = validateConfig({ ...config, schedule: { ...config.schedule, timezone: 'Not/AZone' } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /часовой пояс/i.test(error)));
});

test('отсутствие файла конфигурации даёт понятную ошибку', () => {
  assert.throws(() => loadIsolated({ configFile: 'config/does-not-exist.json' }), ConfigError);
});

test('preflight блокирует живой запуск без подтверждения и пейджинации', () => {
  const { config } = loadIsolated();
  const disabled = { ...config, source: { ...config.source, enabled: false } };
  const blocked = preflight(disabled, { requireLiveSource: true });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.some((error) => /source\.enabled/.test(error)));

  const withPagination = {
    ...config,
    source: {
      ...config.source,
      enabled: true,
      permission: { ...config.source.permission, status: 'confirmed' },
      allowedUrls: [{ ...config.source.allowedUrls[0], pages: 2, pagination: true }]
    }
  };
  const paginated = preflight(withPagination, { requireLiveSource: true });
  assert.equal(paginated.ok, false);
  assert.ok(paginated.errors.some((error) => /Пейджинация/.test(error)));

  const ready = preflight(
    {
      ...config,
      source: {
        ...config.source,
        enabled: true,
        permission: { ...config.source.permission, status: 'confirmed' }
      }
    },
    { requireLiveSource: true }
  );
  assert.equal(ready.ok, true, ready.errors.join('; '));
});

test('описание плана содержит URL, окно, интервал и категории', () => {
  const { config } = loadIsolated();
  const text = describePlan(config);
  assert.match(text, /https:\/\/kwork\.ru\/projects/);
  const { config: current } = loadIsolated();
  const windowPattern = new RegExp(`${current.schedule.windowStart}–${current.schedule.windowEnd}`);
  assert.match(text, windowPattern);
  assert.match(text, new RegExp(`${config.schedule.minIntervalSeconds}–${config.schedule.maxIntervalSeconds}`));
  assert.match(text, /Europe\/Moscow/);
  // Подпись категории берём из конфига: названия могут уточняться по данным сайта.
  const anyLabel = config.targetCategories.find((category) => category.label)?.label;
  assert.ok(anyLabel, 'в конфиге должны быть категории с подписями');
  assert.ok(text.includes(anyLabel), `в плане нет подписи категории «${anyLabel}»`);
  assert.match(text, /Страницы отдельных заданий/);
});

test('команды pause и resume управляют планировщиком', async () => {
  const { config, profile } = loadIsolated();
  const calls = [];
  const fakeScheduler = {
    pause: (reason) => calls.push(['pause', reason]),
    resume: () => calls.push(['resume'])
  };
  const pause = await dispatchCommand('/pause', { config, profile, scheduler: fakeScheduler });
  assert.equal(pause.action, 'pause');
  assert.deepEqual(calls[0], ['pause', 'по команде пользователя']);

  const resume = await dispatchCommand('/resume', { config, profile, scheduler: fakeScheduler });
  assert.equal(resume.action, 'resume');
  assert.deepEqual(calls[1], ['resume']);
  assert.match(resume.reply, new RegExp(`${config.schedule.minIntervalSeconds}–${config.schedule.maxIntervalSeconds}`));
});

test('неизвестная команда и обычный текст обрабатываются предсказуемо', async () => {
  const { config, profile } = loadIsolated();
  assert.equal(await dispatchCommand('просто текст', { config, profile }), null);
  const unknown = await dispatchCommand('/foobar', { config, profile });
  assert.equal(unknown.action, null);
  assert.match(unknown.reply, /Неизвестная команда/);
});

test('/status показывает состояние источника и хранилища', async () => {
  const { config, profile } = loadIsolated();
  const fakeStore = {
    stats: { total: 7, keyTotal: 12, stableIdKeys: 5, urlKeys: 6, compositeKeys: 1, updatedAt: '2026-10-07T10:00:00.000Z' }
  };
  const result = await dispatchCommand('/status', {
    config,
    profile,
    store: fakeStore,
    schedulerState: {
      status: 'paused',
      pausedByUser: true,
      requestCount: 4,
      window: '05:00–19:00',
      timezone: 'Europe/Moscow',
      intervalSeconds: [240, 600],
      lastRequestAt: '2026-10-07T08:00:00.000Z',
      nextRequestAt: null,
      lastError: null,
      stopMessage: null,
      stopReason: null
    }
  });
  assert.match(result.reply, /Опрос: paused/);
  assert.match(result.reply, /Актуальных заданий в индексе: 7/);
  // Ключи не должны путаться с заданиями: явно указано и то, и другое.
  assert.match(result.reply, /Ключей дедупликации: 12 \(id 5 \+ url 6 \+ составных 1\)/);
  assert.match(result.reply, /по одному на задание/);
  assert.match(result.reply, /05:00–19:00/);
});

test('redact вырезает токены и ключи из логов', () => {
  const telegramToken = '123456789:AAaaBBbbCCccDDddEEeeFFffGGgg';
  const openAiKey = 'sk-abcdefghijklmnop';
  const line = redact(`token=${telegramToken} key=${openAiKey} Authorization: Bearer abcdef123456`);
  assert.doesNotMatch(line, /123456789:AAaa/);
  assert.doesNotMatch(line, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(line, /Bearer abcdef123456/);
  assert.match(line, /\[redacted\]/);
});

test('логгер не пишет HTML целиком и маскирует секретные поля', () => {
  const lines = [];
  const logger = createLogger({
    level: 'info',
    sink: { log: (line) => lines.push(line), warn: (line) => lines.push(line), error: (line) => lines.push(line) }
  });
  logger.info('Получена страница', {
    html: '<html>'.padEnd(2000, 'x'),
    telegramBotToken: '123456789:AAaaBBbbCCccDDddEEeeFFffGGgg'
  });
  const joined = lines.join('\n');
  assert.ok(joined.length < 700, 'длинный HTML должен быть обрезан');
  assert.doesNotMatch(joined, /AAAA|AAaaBBbb/);
  assert.match(joined, /\[redacted\]/);
});
