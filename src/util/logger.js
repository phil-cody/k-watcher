/**
 * Логирование с защитой от утечек.
 *
 * Запрещено писать в логи: токены Telegram, ключи моделей, заголовки авторизации,
 * полный HTML и лишние персональные данные. Все значения проходят через
 * redact(), который вырезает похожие на секреты подстроки.
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

function safeMeta(meta) {
  const out = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (/token|key|secret|password|authorization|cookie/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') {
      // Длинные строки почти наверняка HTML или тело ответа — не логируем целиком.
      out[key] = redact(value, { maxLength: 200 });
      continue;
    }
    out[key] = value;
  }
  return out;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger({ level = 'info', sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (name) => (message, meta) => {
    if (LEVELS[name] < threshold) return;
    const line = `${new Date().toISOString()} [${name}] ${redact(message)}`;
    const payload = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(safeMeta(meta))}` : '';
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
    /** Дочерний логгер с постоянным контекстом. */
    child(context = {}) {
      const child = createLogger({ level, sink });
      return {
        ...child,
        debug: (message, meta) => child.debug(message, { ...context, ...meta }),
        info: (message, meta) => child.info(message, { ...context, ...meta }),
        warn: (message, meta) => child.warn(message, { ...context, ...meta }),
        error: (message, meta) => child.error(message, { ...context, ...meta })
      };
    }
  };
}
