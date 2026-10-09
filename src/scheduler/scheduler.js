/**
 * Планировщик опроса.
 *
 * Жёсткие требования, зашитые в логику (и покрытые тестами):
 *  - окно задаётся расписанием (по умолчанию 05:00–20:00 Europe/Moscow); новый запрос
 *    не начинается, если пауза выводит его за конец окна; после закрытия окна опрос
 *    останавливается до следующего дня;
 *  - между любыми двумя запросами выбирается НОВЫЙ случайный интервал
 *    240–600 секунд включительно; постоянный интервал не используется;
 *  - при ошибках интервал не уменьшается и ускоренных повторов нет;
 *  - при 429, CAPTCHA, 403/блокировке опрос немедленно останавливается;
 *    при повторяющихся сетевых/структурных ошибках — безопасная приостановка.
 */

import { chooseIntervalMs, formatInZone, isWithinWindow, nextWindowStart, planNextRequestWithHistory } from '../util/time.js';
import { STOP_REASONS, SourceError } from '../source/kwork-html-source.js';
import { createTexts } from '../texts/texts.js';

export const SCHEDULER_STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped'
};

const HARD_STOP_REASONS = new Set([
  STOP_REASONS.HTTP_429,
  STOP_REASONS.HTTP_403,
  STOP_REASONS.CAPTCHA,
  STOP_REASONS.BLOCKED,
  STOP_REASONS.BOT_CHECK,
  STOP_REASONS.ACCESS_DENIED
]);

// Пока опрос на паузе по команде пользователя, цикл перепроверяет флаг с этим интервалом,
// чтобы /resume возобновил его без перезапуска процесса.
const PAUSE_POLL_MS = 1000;

export class PollingScheduler {
  constructor({
    schedule,
    source,
    onCycle,
    logger = null,
    now = () => new Date(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    onStateChange = null,
    onStop = null,
    onWindowChange = null,
    lastRequestAt = null,
    windowOpen = null,
    texts = null
  }) {
    this.texts = texts ?? createTexts({ rootDir: process.cwd() });
    this.onWindowChange = onWindowChange;
    // Запоминаем состояние окна между запусками, чтобы не слать уведомление повторно.
    this.windowOpen = null;
    this.initialWindowState = windowOpen;
    this.schedule = schedule;
    this.source = source;
    this.onCycle = onCycle;
    this.logger = logger;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.onStateChange = onStateChange;
    this.onStop = onStop;

    this.status = SCHEDULER_STATE.IDLE;
    this.pausedByUser = false;
    this.stopReason = null;
    this.stopMessage = null;
    this.requestCount = 0;
    this.consecutiveNetworkErrors = 0;
    this.consecutiveStructureErrors = 0;
    // Последний фактический запрос (может быть восстановлен из состояния после перезапуска).
    this.lastRequestAt = lastRequestAt ? new Date(lastRequestAt) : null;
    this.lastRequestInProcess = null;
    this.nextRequestAt = null;
    this.lastError = null;
    this.lastStopDiagnostics = null;
    this.lastOutcome = null;
    this.running = false;
  }

  get state() {
    return {
      status: this.status,
      pausedByUser: this.pausedByUser,
      stopReason: this.stopReason,
      stopMessage: this.stopMessage,
      requestCount: this.requestCount,
      consecutiveNetworkErrors: this.consecutiveNetworkErrors,
      consecutiveStructureErrors: this.consecutiveStructureErrors,
      lastRequestAt: this.lastRequestAt ? this.lastRequestAt.toISOString() : null,
      lastRequestInProcess: this.lastRequestInProcess ? this.lastRequestInProcess.toISOString() : null,
      nextRequestAt: this.nextRequestAt ? this.nextRequestAt.toISOString() : null,
      lastError: this.lastError,
      lastStopDiagnostics: this.lastStopDiagnostics,
      windowOpen: this.windowOpen,
      timezone: this.schedule.timezone,
      window: `${this.schedule.windowStart}–${this.schedule.windowEnd}`,
      intervalSeconds: [this.schedule.minIntervalSeconds, this.schedule.maxIntervalSeconds]
    };
  }

  /** Текст по ключу из config/texts.json. */
  t(path, params) {
    return this.texts.t(path, params);
  }

  /**
   * Уведомление о переходе границы окна опроса.
   * Отправляется один раз на переход: открылось или закрылось. Повторные tick внутри
   * одного и того же состояния ничего не отправляют.
   */
  async trackWindowBoundary({ nextRequestAt = null, stats = null } = {}) {
    const now = this.now();
    const open = isWithinWindow(now, this.schedule);
    const previous = this.windowOpen ?? this.initialWindowState ?? false;
    this.windowOpen = open;
    if (open === previous) return null;

    const payload = {
      direction: open ? 'opened' : 'closed',
      at: now.toISOString(),
      nextWindowStart: open ? null : nextWindowStart(now, this.schedule).toISOString(),
      schedule: {
        start: this.schedule.windowStart,
        end: this.schedule.windowEnd,
        timezone: this.schedule.timezone,
        min: this.schedule.minIntervalSeconds,
        max: this.schedule.maxIntervalSeconds
      },
      stats
    };

    if (typeof this.onWindowChange === 'function') {
      try {
        await this.onWindowChange(payload);
      } catch (error) {
        this.logger?.warn(this.t('logs.windowNotifyFailed'), { reason: error.message });
      }
    }
    this.logger?.info(open ? this.t('logs.windowOpened') : this.t('logs.windowClosedBoundary'), {
      nextWindowStart: payload.nextWindowStart
    });
    return payload;
  }

  async notifyStateChange() {
    if (typeof this.onStateChange === 'function') await this.onStateChange(this.state);
  }

  /** Пауза по команде пользователя. */
  pause(reason = this.t('scheduler.pausedUserReason')) {
    this.pausedByUser = true;
    this.status = SCHEDULER_STATE.PAUSED;
    this.stopMessage = this.t('scheduler.pausedByUser', { reason });
    this.logger?.info(this.t('logs.schedulerPaused'), { reason });
    return this.state;
  }

  /** Возобновление после паузы. */
  resume() {
    this.pausedByUser = false;
    this.stopReason = null;
    this.stopMessage = null;
    this.consecutiveNetworkErrors = 0;
    this.consecutiveStructureErrors = 0;
    this.status = SCHEDULER_STATE.IDLE;
    this.logger?.info(this.t('logs.schedulerResumed'));
    return this.state;
  }

  /** Остановка с причиной (429, CAPTCHA, блокировка, смена структуры и т.д.). */
  async stop(reason, message, { diagnostics = null } = {}) {
    this.status = SCHEDULER_STATE.STOPPED;
    this.stopReason = reason;
    this.stopMessage = message;
    this.nextRequestAt = null;
    this.lastStopDiagnostics = diagnostics;
    this.logger?.warn(this.t('logs.stop'), {
      reason,
      message,
      diagnostics: diagnostics ? { status: diagnostics.status, markers: diagnostics.markers, title: diagnostics.title } : null
    });
    if (typeof this.onStop === 'function') {
      try {
        // Ждём обработчик: он сохраняет причину остановки и уведомляет пользователя.
        // Ошибка уведомления не должна ронять планировщик.
        await this.onStop({ reason, message, diagnostics });
      } catch (error) {
        this.logger?.warn(this.t('logs.sendStopFailed'), { reason: error.message });
      }
    }
    // Состояние сохраняем сразу: причина остановки должна пережить перезапуск.
    await this.notifyStateChange();
    return this.state;
  }

  /**
   * Один шаг цикла: выбрать паузу (или сделать первый запрос сразу), при
   * необходимости дождаться окна, сделать РОВНО один запрос, обработать результат.
   */
  async tick() {
    // Границы окна фиксируем до решения о запросе: даже на паузе окно могло закрыться.
    await this.trackWindowBoundary({ stats: this.lastOutcome ?? null });

    if (this.pausedByUser) {
      return { action: 'paused', reason: this.t('scheduler.pausedUserShort') };
    }

    const decision = planNextRequestWithHistory({
      now: this.now(),
      schedule: this.schedule,
      hasPriorRequest: this.lastRequestInProcess !== null,
      lastRequestAt: this.lastRequestAt,
      chooseInterval: () => chooseIntervalMs(this.schedule.minIntervalSeconds, this.schedule.maxIntervalSeconds, this.random),
      texts: this.texts
    });

    if (decision.action === 'paused') {
      this.status = SCHEDULER_STATE.PAUSED;
      this.nextRequestAt = decision.nextWindowStart ?? null;
      this.stopReason = STOP_REASONS.WINDOW_CLOSED;
      this.stopMessage = decision.reason;
      this.logger?.info(this.t('logs.windowClosed'), { nextWindowStart: decision.nextWindowStart?.toISOString() ?? null });
      await this.notifyStateChange();
      return { action: 'paused', reason: decision.reason, waitMs: decision.waitMs ?? null, nextWindowStart: decision.nextWindowStart ?? null };
    }

    if (decision.action === 'nextWindow') {
      this.status = SCHEDULER_STATE.IDLE;
      this.nextRequestAt = decision.nextWindowStart ?? null;
      this.logger?.info(this.t('logs.awaitingWindow'), {
        waitMs: decision.waitMs,
        nextWindowStart: decision.nextWindowStart?.toISOString() ?? null
      });
      await this.notifyStateChange();
      return { action: 'nextWindow', reason: decision.reason, waitMs: decision.waitMs, nextWindowStart: decision.nextWindowStart ?? null };
    }

    if (decision.action === 'immediate') {
      this.logger?.info(this.t('logs.firstRequestNow'), {
        plannedAt: decision.plannedAt?.toISOString() ?? null
      });
      this.nextRequestAt = decision.plannedAt ?? this.now();
      await this.notifyStateChange();
      return await this.runRequest(decision);
    }

    // action === 'wait'
    this.logger?.info(this.t('logs.pauseBeforeRequest'), {
      intervalSeconds: Math.round(decision.intervalMs / 1000),
      plannedAt: decision.plannedAt?.toISOString() ?? null,
      reason: decision.reason
    });
    this.nextRequestAt = decision.plannedAt ?? null;
    await this.notifyStateChange();
    await this.sleep(decision.waitMs);

    // Повторная проверка окна после сна: пауза могла пересечь границу закрытия.
    // trackWindowBoundary не только проверяет, но и отправляет «окно закрылось»
    // и обновляет windowOpen, если граница была пересечена во сне.
    await this.trackWindowBoundary({ stats: this.lastOutcome ?? null });
    if (!isWithinWindow(this.now(), this.schedule)) {
      const next = nextWindowStart(this.now(), this.schedule);
      this.status = SCHEDULER_STATE.PAUSED;
      this.nextRequestAt = next;
      this.stopReason = STOP_REASONS.WINDOW_CLOSED;
      this.stopMessage = this.t('scheduler.outsideWindow', {
        start: this.schedule.windowStart,
        end: this.schedule.windowEnd,
        timezone: this.schedule.timezone
      });
      await this.notifyStateChange();
      return { action: 'paused', reason: this.stopMessage, nextWindowStart: next };
    }

    return await this.runRequest(decision);
  }

  /** Ровно один запрос и обработка его результата. */
  async runRequest(decision) {
    const requestedAt = this.now();
    try {
      const outcome = await this.onCycle({ requestedAt });
      this.requestCount += 1;
      this.lastRequestAt = requestedAt;
      this.lastRequestInProcess = requestedAt;
      this.consecutiveNetworkErrors = 0;
      this.consecutiveStructureErrors = outcome?.structureOk === false ? this.consecutiveStructureErrors + 1 : 0;
      this.lastOutcome = outcome ?? null;
      this.lastError = null;
      this.status = SCHEDULER_STATE.RUNNING;
      this.stopReason = null;
      this.stopMessage = null;

      if (this.consecutiveStructureErrors >= (this.schedule.failurePolicy?.consecutiveStructureErrorLimit ?? 3)) {
        const message = this.t('scheduler.structureChangedStop', { count: this.consecutiveStructureErrors });
        this.stopReason = STOP_REASONS.STRUCTURE_CHANGED;
        this.stopMessage = message;
        this.status = SCHEDULER_STATE.PAUSED;
      }
      await this.notifyStateChange();
      return { action: 'requested', outcome, intervalMs: decision.intervalMs };
    } catch (error) {
      this.requestCount += 1;
      this.lastRequestAt = requestedAt;
      this.lastRequestInProcess = requestedAt;
      this.lastError = { name: error.name, message: error.message, stopReason: error.stopReason ?? null };

      const stopReason = error instanceof SourceError ? error.stopReason : null;
      if (stopReason && HARD_STOP_REASONS.has(stopReason)) {
        await this.stop(stopReason, error.message, { diagnostics: error.diagnostics ?? null });
        return { action: 'stopped', reason: stopReason, message: error.message, diagnostics: error.diagnostics ?? null };
      }

      if (error instanceof SourceError && error.retryable) {
        this.consecutiveNetworkErrors += 1;
        const limit = this.schedule.failurePolicy?.consecutiveNetworkErrorLimit ?? 3;
        if (this.consecutiveNetworkErrors >= limit) {
          await this.stop(
            STOP_REASONS.NETWORK_ERRORS,
            this.t('scheduler.networkErrorsStop', { count: this.consecutiveNetworkErrors, reason: error.message })
          );
          return { action: 'stopped', reason: STOP_REASONS.NETWORK_ERRORS, message: error.message };
        }
        this.status = SCHEDULER_STATE.RUNNING;
        await this.notifyStateChange();
        return { action: 'error', reason: 'retryable', message: error.message, consecutiveNetworkErrors: this.consecutiveNetworkErrors };
      }

      await this.stop(stopReason ?? 'unknown-error', error.message);
      return { action: 'stopped', reason: stopReason ?? 'unknown-error', message: error.message };
    }
  }

  /** Основной цикл. Проверка окна и пауза выполняются на каждом шаге заново. */
  async run() {
    this.running = true;
    this.status = SCHEDULER_STATE.RUNNING;
    try {
      while (this.running) {
        const result = await this.tick();
        if (result.action === 'stopped') return result;
        if (result.action === 'paused') {
          if (this.pausedByUser) {
            // Пауза по команде пользователя: цикл НЕ завершается, иначе /resume не сможет
            // его возобновить без перезапуска. Ждём и перепроверяем флаг.
            this.status = SCHEDULER_STATE.PAUSED;
            await this.sleep(PAUSE_POLL_MS);
            continue;
          }
          // Ожидание открытия окна: пауза ровно до начала окна, затем продолжаем.
          const waitMs = result.nextWindowStart ? result.nextWindowStart.getTime() - this.now().getTime() : 60000;
          if (waitMs > 0) await this.sleep(waitMs);
          this.stopReason = null;
          this.stopMessage = null;
          this.status = SCHEDULER_STATE.IDLE;
          continue;
        }
        if (result.action === 'nextWindow') {
          if (result.waitMs > 0) await this.sleep(result.waitMs);
          this.status = SCHEDULER_STATE.IDLE;
          continue;
        }
      }
      return { action: 'stopped', reason: 'stopped-by-request' };
    } finally {
      this.running = false;
    }
  }

  stopLoop() {
    this.running = false;
  }

  /** Человекочитаемое состояние для Telegram и логов. */
  describeState() {
    const state = this.state;
    const parts = [];
    parts.push(this.t('scheduler.statusLine', { status: state.status }));
    if (state.pausedByUser) parts.push(this.t('scheduler.statusPausedByUser'));
    if (state.stopReason) parts.push(this.t('scheduler.statusStopReason', { reason: state.stopReason }));
    if (state.stopMessage) parts.push(state.stopMessage);
    parts.push(this.t('scheduler.statusRequestCount', { count: state.requestCount }));
    parts.push(this.t('scheduler.statusWindow', { window: `${this.schedule.windowStart}–${this.schedule.windowEnd}`, timezone: state.timezone }));
    parts.push(this.t('scheduler.statusInterval', { min: state.intervalSeconds[0], max: state.intervalSeconds[1] }));
    if (state.lastRequestAt) {
      parts.push(this.t('scheduler.statusLastRequest', { date: formatInZone(state.lastRequestAt, state.timezone) }));
    }
    if (state.nextRequestAt) {
      parts.push(this.t('scheduler.statusNextRequest', { date: formatInZone(new Date(state.nextRequestAt), state.timezone) }));
    }
    if (state.lastError) parts.push(this.t('scheduler.statusLastError', { message: state.lastError.message }));
    return parts.join('\n');
  }
}
