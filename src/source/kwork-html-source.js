/**
 * Источник HTML.
 *
 * Подтверждённый объём: одиночные GET-запросы страниц СПИСКА заданий
 * (https://kwork.ru/projects и подтверждённые пользователем URL категорий
 * с параметрами ?c=...).
 *
 * Модуль физически не умеет больше:
 *  - только GET;
 *  - только URL из source.allowedUrls конфигурации (сравнение по полному URL);
 *  - один запрос за раз (никакого параллелизма);
 *  - без cookies, авторизации, заголовков авторизации и обхода защиты;
 *  - при 429/CAPTCHA/403/блокировке источник останавливается, а не повторяет запрос.
 *
 * Признаком настоящей проверки считается показанный challenge, а не упоминание
 * слова «captcha» в подключённом скрипте или скрытом блоке.
 */

import { describeAnomalyDiagnostics, detectPageAnomaliesDetailed, ANOMALY } from '../parser/anomaly-detector.js';
import { isDeclaredPageVariant, validateSourceUrl } from '../config/load-config.js';
import { createTexts } from '../texts/texts.js';

export const STOP_REASONS = {
  HTTP_429: 'http-429',
  HTTP_403: 'http-403',
  CAPTCHA: 'captcha',
  BLOCKED: 'blocked',
  BOT_CHECK: 'bot-check',
  ACCESS_DENIED: 'access-denied',
  NETWORK_ERRORS: 'network-errors',
  STRUCTURE_CHANGED: 'structure-changed',
  CONFIG: 'config-error',
  PAUSED_BY_USER: 'paused-by-user',
  WINDOW_CLOSED: 'window-closed'
};

const KIND_TO_STOP_REASON = {
  [ANOMALY.CAPTCHA]: STOP_REASONS.CAPTCHA,
  [ANOMALY.BLOCKED]: STOP_REASONS.BLOCKED,
  [ANOMALY.BOT_CHECK]: STOP_REASONS.BOT_CHECK,
  [ANOMALY.ACCESS_DENIED]: STOP_REASONS.ACCESS_DENIED
};

export class SourceError extends Error {
  constructor(message, { stopReason = null, retryable = false, httpStatus = null, details = {}, diagnostics = null } = {}) {
    super(message);
    this.name = 'SourceError';
    this.stopReason = stopReason;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    this.details = details;
    this.diagnostics = diagnostics;
  }
}

/** Один GET с ограниченным таймаутом. Без ретраев и без последовательных попыток. */
export async function fetchSinglePage(
  url,
  { userAgent, timeoutMs = 20000, fetchImpl = globalThis.fetch, allowedUrls = [], texts = null } = {}
) {
  const textsObject = texts ?? createTexts({ rootDir: process.cwd() });
  const t = (path, params) => textsObject.t(path, params);
  const allowed = allowedUrls.map((entry) => entry.url);
  const check = validateSourceUrl(url, { allowedUrls: allowed });
  if (!check.ok) {
    throw new SourceError(t('source.urlNotAllowed', { errors: check.errors.join('; ') }), {
      stopReason: STOP_REASONS.CONFIG
    });
  }
  // Разрешены объявленные URL и их страницы (?page=N): это тот же список заданий.
  if (allowed.length > 0 && !allowed.includes(url) && !isDeclaredPageVariant(url, allowed)) {
    throw new SourceError(t('source.urlNotDeclared', { url }), { stopReason: STOP_REASONS.CONFIG });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        // Только идентификация клиента. Никаких cookies, referer-подмен и масок.
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml'
      },
      signal: controller.signal
    });
  } catch (error) {
    throw new SourceError(
      t('source.networkError', { url, reason: error.name === 'AbortError' ? t('source.timeout') : error.message }),
      {
      stopReason: null,
      retryable: true,
      details: { cause: error.name }
      }
    );
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  const retryAfterHeader = typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : null;
  const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) || null : null;

  if (status === 429) {
    throw new SourceError(
      t('source.http429', {
        retryAfter: retryAfterSeconds ? t('source.http429RetryAfter', { seconds: retryAfterSeconds }) : ''
      }),
      { stopReason: STOP_REASONS.HTTP_429, httpStatus: status, details: { retryAfterSeconds } }
    );
  }
  if (status === 403) {
    throw new SourceError(t('source.http403'), {
      stopReason: STOP_REASONS.HTTP_403,
      httpStatus: status
    });
  }
  if (status === 401 || status === 407) {
    throw new SourceError(t('source.http401', { status }), {
      stopReason: STOP_REASONS.ACCESS_DENIED,
      httpStatus: status
    });
  }
  if (status === 503 || status === 502 || status === 504) {
    throw new SourceError(t('source.httpUnavailable', { status }), { retryable: true, httpStatus: status });
  }
  if (!response.ok) {
    throw new SourceError(t('source.httpUnexpected', { status }), { retryable: true, httpStatus: status });
  }

  const html = await response.text();
  const detailed = detectPageAnomaliesDetailed(html);
  if (detailed.hard.length > 0) {
    const diagnostics = describeAnomalyDiagnostics({ status, url, html });
    const primary = detailed.hard[0];
    const stopReason = KIND_TO_STOP_REASON[primary.kind] ?? STOP_REASONS.BLOCKED;
    throw new SourceError(
      t('source.anomaly', { kind: primary.kind, reason: primary.reason }),
      { stopReason, httpStatus: status, details: { markers: detailed.markers }, diagnostics }
    );
  }

  return {
    html,
    status,
    url,
    fetchedAt: new Date().toISOString(),
    bytes: html.length,
    // Мягкие упоминания не останавливают разбор, но полезны в диагностике.
    softAnomalies: detailed.soft,
    structureSignals: detailed.structureSignals
  };
}

/**
 * Источник как объект. Держит счётчики и сериализует обращения.
 * Параллельные вызовы запрещены: второй вызов получает ошибку, а не второй запрос.
 */
export class KworkHtmlSource {
  constructor({ allowedUrls = [], userAgent, timeoutMs = 20000, fetchImpl = globalThis.fetch, logger = null, texts = null } = {}) {
    this.texts = texts ?? createTexts({ rootDir: process.cwd() });
    this.allowedUrls = allowedUrls;
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.inFlight = false;
    this.requestCount = 0;
    this.lastRequestAt = null;
    this.lastSoftAnomalies = [];
  }

  /** Список URL, которые разрешено запрашивать (для показа пользователю перед запуском). */
  describePlan() {
    return this.allowedUrls.map((entry) => ({
      id: entry.id,
      url: entry.url,
      label: entry.label ?? null,
      category: entry.category ?? null,
      pages: entry.pages ?? 1,
      enabled: entry.enabled !== false
    }));
  }

  async fetchPage(url) {
    if (this.inFlight) {
      throw new SourceError(this.texts.t('source.parallelDenied'), {
        stopReason: STOP_REASONS.CONFIG
      });
    }
    this.inFlight = true;
    try {
      const result = await fetchSinglePage(url, {
        userAgent: this.userAgent,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        allowedUrls: this.allowedUrls,
        texts: this.texts
      });
      this.requestCount += 1;
      this.lastRequestAt = result.fetchedAt;
      // Технические упоминания защиты не пишем в лог: это шум. Они остаются
      // в структуре ответа и доступны для диагностики при необходимости.
      this.lastSoftAnomalies = result.softAnomalies ?? [];
      return result;
    } finally {
      this.inFlight = false;
    }
  }
}
