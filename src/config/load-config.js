/**
 * Загрузка и проверка конфигурации.
 *
 * Принципы:
 *  - секреты только из переменных окружения (или локального .env), никогда из config/*.json;
 *  - разрешённые URL и окно опроса — данные конфигурации, а не константы в коде;
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
 * Является ли URL страницей объявленного URL: те же параметры плюс `page`.
 * Пример: https://kwork.ru/projects?c=38&page=2 — страница для ?c=38.
 */
export function isDeclaredPageVariant(rawUrl, allowedUrls = []) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return false;
  }
  if (!parsed.searchParams.has('page')) return false;
  const pageValue = Number(parsed.searchParams.get('page'));
  if (!Number.isInteger(pageValue) || pageValue < 2) return false;

  for (const declared of allowedUrls) {
    let base;
    try {
      base = new URL(String(declared));
    } catch {
      continue;
    }
    if (base.origin !== parsed.origin || base.pathname !== parsed.pathname) continue;
    const baseParams = [...base.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`);
    const otherParams = [...parsed.searchParams.entries()]
      .filter(([key]) => key !== 'page')
      .sort()
      .map(([k, v]) => `${k}=${v}`);
    if (baseParams.join('&') === otherParams.join('&')) return true;
  }
  return false;
}

/**
 * Проверка URL источника.
 *
 * Разрешены только страницы списка заданий: https://kwork.ru/projects
 * (в том числе с параметром ?c=<id>, если такой точный URL перечислен в
 * source.allowedUrls, и его страницы ?page=N). Страницы отдельных заданий
 * (/projects/<id>/<slug>), API, поиск, профили и аккаунтные разделы
 * отклоняются, даже если попали в конфиг по ошибке.
 *
 * @param {string} rawUrl проверяемый URL
 * @param {{ allowedUrls?: string[] }} [options] точный список разрешённых URL
 */
export function validateSourceUrl(rawUrl, { allowedUrls = [] } = {}) {
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
  if (path !== '/projects') {
    errors.push(
      `Путь не входит в подтверждённый объём (разрешён только список заданий /projects): ${parsed.pathname}`
    );
  }
  if (parsed.search) {
    // Query-параметры допускаются, только если это подтверждённый URL или его
    // страница (тот же URL + параметр page). Иначе — ошибка.
    const declared = allowedUrls.includes(String(rawUrl));
    const pageVariant = isDeclaredPageVariant(rawUrl, allowedUrls);
    if (!declared && !pageVariant) {
      errors.push(
        `Параметры запроса не подтверждены: ${parsed.search}. Разрешены только URL из source.allowedUrls и их страницы ?page=N.`
      );
    }
  }
  return { ok: errors.length === 0, errors, url: parsed.toString(), path };
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
  const allowedUrls = Array.isArray(source.allowedUrls) ? source.allowedUrls : [];

  if (allowedUrls.length === 0) {
    warnings.push('Список разрешённых URL пуст: живой опрос невозможен, доступны только локальные fixtures.');
  }
  const enabledUrls = allowedUrls.filter((entry) => entry?.enabled !== false);
  const declaredUrlStrings = allowedUrls.map((entry) => entry?.url).filter(Boolean);
  for (const entry of enabledUrls) {
    if (!entry?.url) {
      errors.push('У записи allowedUrls отсутствует url');
      continue;
    }
    const check = validateSourceUrl(entry.url, { allowedUrls: declaredUrlStrings });
    if (!check.ok) errors.push(...check.errors.map((message) => `allowedUrls[${entry.id ?? entry.url}]: ${message}`));
    // Пейджинация допустима только при явно включённом source.pagination.enabled.
    const paginationAllowed = config.source?.pagination?.enabled === true;
    if (!paginationAllowed && (entry.pagination === true || Number(entry.pages ?? 1) > 1)) {
      errors.push(
        `Пейджинация не подтверждена пользователем: allowedUrls[${entry.id ?? entry.url}].pages = ${entry.pages ?? 1}. ` +
          'Включите source.pagination.enabled и подтвердите число страниц.'
      );
    }
  }

  if (requireLiveSource) {
    if (source.enabled !== true) {
      errors.push('source.enabled = false: живой опрос запрещён, пока пользователь не включит источник.');
    }
    if (source.permission?.status !== 'confirmed') {
      errors.push('source.permission.status != "confirmed": нет подтверждения охвата разрешением Kwork.');
    }
    if (enabledUrls.length === 0) errors.push('Нет ни одного включённого разрешённого URL.');
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

  const categories = Array.isArray(config.targetCategories) ? config.targetCategories : [];
  if (categories.length === 0) warnings.push('targetCategories пуст: все карточки будут помечаться как «вне выбранных категорий».');

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

  const profilePath = resolvePath(profileFile);
  if (!existsSync(profilePath)) throw new ConfigError(`Файл профиля не найден: ${profilePath}`);
  let profile;
  try {
    profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  } catch (error) {
    throw new ConfigError(`Не удалось прочитать профиль: ${error.message}`);
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
  const profileValidation = validateProfile(profile);

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
    errors.push('TELEGRAM_ALLOWED_USER_ID не задан: бот не должен отвечать неопределённому кругу лиц.');
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
