/**
 * Логирование с защитой от утечек.
 *
 * Запрещено писать в логи: токены Telegram, ключи моделей, заголовки авторизации,
 * полный HTML и лишние персональные данные. Все значения проходят через
 * redact(), который вырезает похожие на секреты подстроки. Ключи с секретами
 * редактируются и во вложенных объектах — иначе утечёт `details: { token: … }`.
 */

const SECRET_PATTERNS = [
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, // токен Telegram-бота
  /\bsk-[A-Za-z0-9_-]{10,}\b/g, // OpenAI-подобные ключи
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, // Anthropic
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
  /\b(?:api[_-]?key|token|password|secret)\b["'\s:=]+[A-Za-z0-9._-]{8,}/gi
];

/** Удаление секретов и обрезка длинных строк (защита от попадания HTML в лог). */
export function redact(value, { maxLength = 500 } = {}) {
  let text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redacted]');
  }
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}…[обрезано ${text.length - maxLength} символов]`;
  return text;
}

/** Похож ли ключ метаданных на секрет (с учётом camelCase/snake_case). */
function isSensitiveKey(key) {
  const lower = String(key).toLowerCase();
  return /token|secret|password|authorization|cookie|apikey|api_key|api-key/.test(lower) || /\bkey\b/.test(lower);
}

/**
 * Безопасная сериализация метаданных: рекурсивно редактирует секретные ключи
 * и длинные строки (HTML/тело ответа) на любой вложенности.
 */
function safeMeta(meta, depth = 0) {
  if (depth > 6) return '[redacted]'; // защита от циклических и аномально глубоких структур
  if (meta === null || meta === undefined) return meta;
  if (typeof meta === 'string') return redact(meta, { maxLength: 200 });
  if (typeof meta !== 'object') return meta;
  if (Array.isArray(meta)) return meta.map((item) => safeMeta(item, depth + 1));
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (isSensitiveKey(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = safeMeta(value, depth + 1);
  }
  return out;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger({ level = 'info', sink = console, baseContext = null } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (name) => (message, meta) => {
    if (LEVELS[name] < threshold) return;
    const merged = baseContext ? { ...baseContext, ...(meta ?? {}) } : meta;
    const line = `${new Date().toISOString()} [${name}] ${redact(message)}`;
    const payload = merged && Object.keys(merged).length > 0 ? ` ${JSON.stringify(safeMeta(merged))}` : '';
    if (name === 'error') sink.error(line + payload);
    else if (name === 'warn') sink.warn(line + payload);
    else sink.log(line + payload);
  };
  return {
    level,
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    /** Дочерний логгер с постоянным контекстом (накапливается при вложенных child()). */
    child(context = {}) {
      return createLogger({
        level,
        sink,
        baseContext: { ...(baseContext ?? {}), ...(context ?? {}) }
      });
    }
  };
}
