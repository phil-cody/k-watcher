/**
 * Загрузка и проверка конфигурации.
 *
 * Принципы:
 *  - секреты только из переменных окружения (или локального .env), никогда из config/*.json;
 *  - адрес источника (baseUrl) и окно опроса — данные конфигурации, а не константы в коде;
 *  - небезопасная или противоречивая конфигурация останавливает запуск, а не «чинится молча».
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

export class ConfigError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ConfigError';
    this.details = details;
  }
}

const MODEL_PROVIDERS = new Set(['heuristic', 'openai-compatible', 'anthropic']);
const ALLOWED_SOURCE_HOSTS = new Set(['kwork.ru', 'www.kwork.ru']);
// Подтверждённый объём: только страницы списка заданий.
const PROJECTS_PATH = '/projects';
// Параметры списка: категория, подраздел внутри неё и номер страницы. Больше ничего.
const ALLOWED_QUERY_PARAMS = new Set(['c', 'attr', 'page']);

/** Разбор файла .env в объект (без раскрытия значений в логах). */
export function parseEnvFile(content) {
  const env = {};
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  }
  return env;
}

/**
 * Проверка URL источника.
 *
 * Разрешены ТОЛЬКО страницы списка заданий: https://kwork.ru/projects
 * и её варианты по категории/подразделу/странице — `?c=<id>`, `?attr=<id>`,
 * `?page=<n>=2`. Список категорий не перечисляется жёстко: он приходит из
 * полного каталога сайта (config/categories.json), поэтому допустим любой
 * положительный числовой id.
 *
 * Страницы отдельных заданий (/projects/<id>/<slug>), API, поиск, профили
 * и аккаунтные разделы отклоняются по структуре URL, даже если попали в
 * запрос по ошибке.
 *
 * @param {string} rawUrl проверяемый URL
 */
export function validateSourceUrl(rawUrl) {
  const errors = [];
  let parsed = null;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return { ok: false, errors: [`Некорректный URL: ${rawUrl}`] };
  }
  if (parsed.protocol !== 'https:') errors.push(`Разрешён только https: ${rawUrl}`);
  if (!ALLOWED_SOURCE_HOSTS.has(parsed.hostname)) {
    errors.push(`Хост не разрешён (ожидается kwork.ru): ${parsed.hostname}`);
  }
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (path !== PROJECTS_PATH) {
    errors.push(
      `Путь не входит в подтверждённый объём (разрешён только список заданий ${PROJECTS_PATH}): ${parsed.pathname}`
    );
  }

  // Query-параметры: только категория, подраздел и номер страницы. Значения — целые числа.
  const seen = new Set();
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!ALLOWED_QUERY_PARAMS.has(key)) {
      errors.push(`Параметр запроса не разрешён: ${key}. Разрешены только c, attr, page.`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`Параметр запроса повторяется: ${key}.`);
      continue;
    }
    seen.add(key);
    if (!/^\d+$/.test(value)) {
      errors.push(`Значение параметра ${key} должно быть целым числом: ${value}.`);
      continue;
    }
    const numeric = Number(value);
    if (key === 'page') {
      if (numeric < 2) errors.push(`Параметр page должен быть не меньше 2: ${value}.`);
    } else if (numeric < 1) {
      errors.push(`Значение параметра ${key} должно быть положительным: ${value}.`);
    }
  }
  // Подраздел без категории бессмысленен и не входит в подтверждённый объём.
  if (seen.has('attr') && !seen.has('c')) {
    errors.push('Параметр attr разрешён только вместе с c (категорией).');
  }

  return { ok: errors.length === 0, errors, url: parsed.toString(), path };
}

/** URL общего списка заданий из конфигурации источника. */
export function baseProjectsUrl(config = {}) {
  const source = config.source ?? config;
  const base = String(source.baseUrl ?? 'https://kwork.ru').replace(/\/+$/, '');
  return `${base}${PROJECTS_PATH}`;
}

function requireNumber(value, name, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${name} должен быть числом`);
    return false;
  }
  return true;
}

function isValidTimezone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function isClock(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? '').trim());
}

/** Проверка структуры конфигурации. Возвращает { ok, errors, warnings }. */
export function validateConfig(config, { requireLiveSource = false } = {}) {
  const errors = [];
  const warnings = [];

  if (!config || typeof config !== 'object') {
    return { ok: false, errors: ['Конфигурация пуста'], warnings };
  }

  const source = config.source ?? {};
  const schedule = config.schedule ?? {};

  // Базовый адрес источника: общий список заданий и его варианты по категориям.
  if (!source.baseUrl) {
    errors.push('source.baseUrl не задан: опрос некуда направлять.');
  } else {
    const check = validateSourceUrl(baseProjectsUrl(config));
    if (!check.ok) errors.push(...check.errors.map((message) => `source.baseUrl: ${message}`));
  }
  // Пейджинация допустима только при явно включённом source.pagination.enabled.
  if (source.pagination?.enabled === true) {
    const maxPages = Number(source.pagination.maxPagesPerUrl ?? 0);
    if (!Number.isFinite(maxPages) || maxPages < 1) {
      errors.push('source.pagination.maxPagesPerUrl должен быть положительным числом.');
    }
  }

  if (requireLiveSource) {
    if (source.enabled !== true) {
      errors.push('source.enabled = false: живой опрос запрещён, пока пользователь не включит источник.');
    }
    if (source.permission?.status !== 'confirmed') {
      errors.push('source.permission.status != "confirmed": нет подтверждения охвата разрешением Kwork.');
    }
  }

  if (!isValidTimezone(schedule.timezone)) {
    errors.push(`Некорректный часовой пояс: ${schedule.timezone}`);
  }
  if (!isClock(schedule.windowStart)) errors.push(`Некорректное windowStart: ${schedule.windowStart}`);
  if (!isClock(schedule.windowEnd)) errors.push(`Некорректное windowEnd: ${schedule.windowEnd}`);

  const min = schedule.minIntervalSeconds;
  const max = schedule.maxIntervalSeconds;
  if (requireNumber(min, 'schedule.minIntervalSeconds', errors) && requireNumber(max, 'schedule.maxIntervalSeconds', errors)) {
    if (min < 240 || max > 600) {
      errors.push(
        `Интервал ${min}–${max} с выходит за подтверждённый пользователем диапазон 240–600 с и не может быть расширен автоматически.`
      );
    }
    if (min > max) errors.push('schedule.minIntervalSeconds больше maxIntervalSeconds');
  }

  if (schedule.pollingEnabled !== true) warnings.push('schedule.pollingEnabled = false: планировщик не будет делать запросы.');

  const model = config.model ?? {};
  if (!MODEL_PROVIDERS.has(model.provider)) {
    errors.push(`Неизвестный model.provider: ${model.provider}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Проверка профиля исполнителя. */
export function validateProfile(profile) {
  const errors = [];
  const warnings = [];
  if (!profile || typeof profile !== 'object') return { ok: false, errors: ['Профиль пуст'], warnings };

  if (!Array.isArray(profile.skills) || profile.skills.length === 0) {
    warnings.push('В профиле нет skills: уверенная оценка соответствия будет помечена как предварительная.');
  }
  if (!Array.isArray(profile.portfolio) || profile.portfolio.length === 0) {
    warnings.push('В профиле нет portfolio: бот не сможет ссылаться на подтверждённые работы.');
  }
  const minPrice = profile.pricing?.minimum_project_price;
  if (typeof minPrice !== 'number' || !Number.isFinite(minPrice)) {
    warnings.push('В профиле нет pricing.minimum_project_price: признаки заниженной цены не будут оцениваться.');
  }
  if (!profile.availability?.timezone) {
    warnings.push('В профиле нет availability.timezone: сроки будут оцениваться без учёта пояса исполнителя.');
  }
  if (!Array.isArray(profile.proposal_preferences?.questions_before_quote)) {
    warnings.push('В профиле нет proposal_preferences.questions_before_quote: вопросы заказчику будут общими.');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Загрузка конфигурации и профиля.
 * @param {object} options
 * @param {string} options.rootDir корень проекта
 * @param {string} [options.configFile] путь к конфигу (по умолчанию config/default.json)
 * @param {string} [options.profileFile] путь к профилю (по умолчанию config/performer-profile.json)
 * @param {NodeJS.ProcessEnv} [options.env] переменные окружения
 * @param {boolean} [options.requireLiveSource] требовать разрешённый живой источник
 * @param {boolean} [options.readEnvFile] читать ли локальный .env (по умолчанию да)
 */
export function loadConfig({
  rootDir = process.cwd(),
  configFile = 'config/default.json',
  profileFile = 'config/performer-profile.json',
  env = process.env,
  requireLiveSource = false,
  readEnvFile = true
} = {}) {
  const resolvePath = (value) => (isAbsolute(value) ? value : resolve(rootDir, value));

  const configPath = resolvePath(configFile);
  if (!existsSync(configPath)) throw new ConfigError(`Файл конфигурации не найден: ${configPath}`);
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new ConfigError(`Не удалось прочитать конфигурацию: ${error.message}`);
  }

  const envPath = resolvePath('.env');
  const fileEnv = readEnvFile && existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  const merged = { ...fileEnv, ...env };
  const pick = (...names) => {
    for (const name of names) {
      const value = merged[name];
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
    return undefined;
  };

  // Профиль — только шаблон (config/performer-profile.json) и нужен для dry-run/шаблона.
  // Бот анализирует по персональным профилям пользователей, поэтому общий профиль не обязателен.
  const profilePath = resolvePath(profileFile);
  let profile = null;
  if (existsSync(profilePath)) {
    try {
      profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    } catch (error) {
      throw new ConfigError(`Не удалось прочитать профиль: ${error.message}`);
    }
  }

  const dataDir = resolvePath(pick('DATA_DIR') ?? config.app?.dataDir ?? 'data');

  const telegramToken = pick('TELEGRAM_BOT_TOKEN');
  const allowedUserId = pick('TELEGRAM_ALLOWED_USER_ID');
  const modelProvider = pick('MODEL_PROVIDER') ?? config.model?.provider ?? 'heuristic';

  const resolved = {
    ...config,
    rootDir,
    configPath,
    profilePath,
    profile,
    dataDir,
    model: { ...config.model, provider: modelProvider },
    secrets: {
      telegramBotToken: telegramToken,
      telegramAllowedUserId: allowedUserId ? Number(allowedUserId) : null,
      telegramChatId: pick('TELEGRAM_CHAT_ID') ? Number(pick('TELEGRAM_CHAT_ID')) : null,
      llmBaseUrl: pick('LLM_BASE_URL'),
      llmApiKey: pick('LLM_API_KEY'),
      llmModel: pick('LLM_MODEL'),
      anthropicApiKey: pick('ANTHROPIC_API_KEY'),
      anthropicModel: pick('ANTHROPIC_MODEL'),
      // Локальный файл текстов: переопределяет config/texts.json, не трогая репозиторий.
      textsFile: pick('TEXTS_FILE')
    }
  };

  const validation = validateConfig(resolved, { requireLiveSource });
  const profileValidation = profile ? validateProfile(profile) : { ok: true, errors: [], warnings: [] };

  return {
    config: resolved,
    profile,
    validation: {
      ok: validation.ok && profileValidation.ok,
      errors: [...validation.errors, ...profileValidation.errors],
      warnings: [...validation.warnings, ...profileValidation.warnings]
    }
  };
}

/** Проверка готовности Telegram (без раскрытия секретов). */
export function validateTelegramSecrets(secrets) {
  const errors = [];
  const warnings = [];
  if (!secrets.telegramBotToken) {
    errors.push('TELEGRAM_BOT_TOKEN не задан.');
  } else if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(secrets.telegramBotToken)) {
    warnings.push('TELEGRAM_BOT_TOKEN не похож на токен BotFather (формат <digits>:<token>).');
  }
  if (!secrets.telegramAllowedUserId || !Number.isFinite(secrets.telegramAllowedUserId)) {
    // Доступ открыт всем: владелец определяется первым написавшим, поэтому id владельца не обязателен.
    warnings.push('TELEGRAM_ALLOWED_USER_ID не задан: владельцем станет первый написавший боту.');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Проверка настроек модели (без раскрытия секретов). */
export function validateModelSecrets(model, secrets) {
  const errors = [];
  const warnings = [];
  if (model.provider === 'openai-compatible') {
    if (!secrets.llmBaseUrl) errors.push('LLM_BASE_URL не задан для model.provider=openai-compatible.');
    if (!secrets.llmApiKey) errors.push('LLM_API_KEY не задан для model.provider=openai-compatible.');
    if (!secrets.llmModel) errors.push('LLM_MODEL не задан для model.provider=openai-compatible.');
  } else if (model.provider === 'anthropic') {
    if (!secrets.anthropicApiKey) errors.push('ANTHROPIC_API_KEY не задан для model.provider=anthropic.');
    if (!secrets.anthropicModel) warnings.push('ANTHROPIC_MODEL не задан: будет использовано значение по умолчанию адаптера.');
  } else if (model.provider === 'heuristic') {
    warnings.push('model.provider=heuristic: анализ идёт офлайн, внешние вызовы и биллинг не используются.');
  }
  return { ok: errors.length === 0, errors, warnings };
}
