/**
 * Учёт расхода запросов к модели.
 *
 * Зачем: у бесплатных тарифов жёсткие лимиты (запросов в минуту и в сутки). Без учёта
 * бот может выжечь суточную квоту за один цикл и потом молча работать на эвристике.
 * Здесь мы считаем запросы и заранее отказываемся от вызова, когда бюджет исчерпан.
 *
 * Файл состояния: `data/model-usage.json`
 *   {
 *     "provider": "openai-compatible",
 *     "day": "2026-10-08",        // сутки в часовом поясе расписания
 *     "hour": "2026-10-08T11",    // час в том же поясе
 *     "dayCount": 12,
 *     "hourCount": 3,
 *     "lastCallAt": "…",
 *     "updatedAt": "…"
 *   }
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Ключ суток и часа в нужном часовом поясе. */
export function timeKeys(date, timezone = 'UTC') {
  const at = date instanceof Date ? date : new Date(date ?? Date.now());
  let day;
  let hour;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false
    }).formatToParts(at);
    const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
    day = `${get('year')}-${get('month')}-${get('day')}`;
    const hourValue = get('hour') === '24' ? '00' : get('hour');
    hour = `${day}T${hourValue}`;
  } catch {
    // Неизвестный часовой пояс не должен ломать учёт: считаем по UTC.
    day = at.toISOString().slice(0, 10);
    hour = at.toISOString().slice(0, 13);
  }
  return { day, hour };
}

export class ModelUsageTracker {
  constructor({ dataDir = 'data', file = null, provider = 'heuristic', limits = {}, timezone = 'UTC', logger = null } = {}) {
    this.path = file ? resolve(file) : resolve(dataDir, 'model-usage.json');
    this.provider = provider;
    this.timezone = timezone;
    this.limits = { perDay: null, perHour: null, ...limits };
    this.logger = logger;
    this.data = {
      provider,
      day: null,
      hour: null,
      dayCount: 0,
      hourCount: 0,
      // Всего за всё время: по этим числам владелец видит расход приложения.
      totalCalls: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      tokensIn: 0,
      tokensOut: 0,
      lastCallAt: null,
      updatedAt: null
    };
  }

  async init() {
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(await readFile(this.path, 'utf8'));
        this.data = {
          provider: parsed.provider ?? this.provider,
          day: parsed.day ?? null,
          hour: parsed.hour ?? null,
          dayCount: Number(parsed.dayCount) || 0,
          hourCount: Number(parsed.hourCount) || 0,
          totalCalls: Number(parsed.totalCalls) || 0,
          totalTokensIn: Number(parsed.totalTokensIn) || 0,
          totalTokensOut: Number(parsed.totalTokensOut) || 0,
          tokensIn: Number(parsed.tokensIn) || 0,
          tokensOut: Number(parsed.tokensOut) || 0,
          lastCallAt: parsed.lastCallAt ?? null,
          updatedAt: parsed.updatedAt ?? null
        };
      } catch {
        // Повреждённый файл не мешает работе: начинаем счёт заново.
      }
    }
    this.rollover();
    return this;
  }

  /** Сброс счётчиков при смене суток и часа. */
  rollover(now = new Date()) {
    const { day, hour } = timeKeys(now, this.timezone);
    if (this.data.day !== day) {
      this.data.day = day;
      this.data.dayCount = 0;
      // Токены считаем за сутки; всего за всё время они не сбрасываются.
      this.data.tokensIn = 0;
      this.data.tokensOut = 0;
    }
    if (this.data.hour !== hour) {
      this.data.hour = hour;
      this.data.hourCount = 0;
    }
    return this;
  }

  /** Нормализованные лимиты: null означает «не ограничивать». */
  get effectiveLimits() {
    const perDay = Number(this.limits.perDay) > 0 ? Number(this.limits.perDay) : null;
    const perHour = Number(this.limits.perHour) > 0 ? Number(this.limits.perHour) : null;
    return { perDay, perHour };
  }

  get snapshot() {
    const { perDay, perHour } = this.effectiveLimits;
    return {
      provider: this.provider,
      dayCount: this.data.dayCount,
      hourCount: this.data.hourCount,
      lastCallAt: this.data.lastCallAt,
      limits: { perDay, perHour },
      remainingDay: perDay === null ? null : Math.max(0, perDay - this.data.dayCount),
      remainingHour: perHour === null ? null : Math.max(0, perHour - this.data.hourCount),
      tokens: {
        todayIn: this.data.tokensIn,
        todayOut: this.data.tokensOut,
        totalIn: this.data.totalTokensIn,
        totalOut: this.data.totalTokensOut,
        total: this.data.totalTokensIn + this.data.totalTokensOut
      },
      totalCalls: this.data.totalCalls
    };
  }

  /**
   * Можно ли сделать ещё один запрос.
   * @returns {{ allowed: boolean, reason: string|null, snapshot: object }}
   */
  check(now = new Date()) {
    this.rollover(now);
    const { perDay, perHour } = this.effectiveLimits;
    if (perDay !== null && this.data.dayCount >= perDay) {
      return { allowed: false, reason: 'day', snapshot: this.snapshot };
    }
    if (perHour !== null && this.data.hourCount >= perHour) {
      return { allowed: false, reason: 'hour', snapshot: this.snapshot };
    }
    return { allowed: true, reason: null, snapshot: this.snapshot };
  }

  /**
   * Учесть фактический вызов и (если провайдер вернул) расход токенов.
   * @param {{ tokensIn?: number, tokensOut?: number }} usage
   */
  async record({ tokensIn = 0, tokensOut = 0 } = {}, now = new Date()) {
    this.rollover(now);
    this.data.dayCount += 1;
    this.data.hourCount += 1;
    this.data.totalCalls += 1;
    const inTokens = Number.isFinite(Number(tokensIn)) ? Math.max(0, Number(tokensIn)) : 0;
    const outTokens = Number.isFinite(Number(tokensOut)) ? Math.max(0, Number(tokensOut)) : 0;
    this.data.tokensIn += inTokens;
    this.data.tokensOut += outTokens;
    this.data.totalTokensIn += inTokens;
    this.data.totalTokensOut += outTokens;
    this.data.lastCallAt = now.toISOString();
    await this.save();
    return this.snapshot;
  }

  async save() {
    this.data.provider = this.provider;
    this.data.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(temporary, this.path);
    return this.data;
  }
}
