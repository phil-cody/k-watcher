/**
 * Работа со временем и окном опроса в заданном часовом поясе.
 *
 * Ключевое требование: окно 05:00–19:00 считается в Europe/Moscow, а не по
 * локальным часам машины. Поэтому все проверки идут через Intl с явной зоной.
 */

/** Смещение зоны (в минутах) относительно UTC для конкретного момента. */
export function zoneOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(date)) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  // hour может прийти как 24 при hour12: false — нормализуем
  const hour = parts.hour === 24 ? 0 : parts.hour;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Календарная дата (YYYY-MM-DD) в заданной зоне. */
export function zonedDateString(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return dtf.format(date);
}

/** Полночь календарного дня в зоне — как абсолютный момент времени. */
export function zonedStartOfDay(date, timeZone) {
  const day = zonedDateString(date, timeZone);
  const [y, m, d] = day.split('-').map(Number);
  // Догадка: полночь по UTC, дальше корректируем смещением (одна-две итерации достаточно).
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 3; i += 1) {
    const offset = zoneOffsetMinutes(new Date(guess), timeZone);
    const next = Date.UTC(y, m - 1, d, 0, 0, 0) - offset * 60000;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** Разбор "HH:MM" в минуты от полуночи. */
export function parseClock(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Минуты от полуночи в зоне для конкретного момента.
 * Если минута попадает в "повторяющийся" час перехода на летнее время,
 * берётся первое вхождение — для нашего окна это не критично, но поведение детерминировано.
 */
export function zonedMinutesOfDay(date, timeZone) {
  const start = zonedStartOfDay(date, timeZone).getTime();
  const delta = date.getTime() - start;
  return Math.floor(delta / 60000);
}

/**
 * Момент времени внутри зоны по календарной дате (YYYY-MM-DD) и минутам от полуночи.
 * Разрешает неоднозначность перехода на летнее время детерминированно.
 */
export function zonedTimeFromDayAndMinutes(dayString, minutes, timeZone) {
  const [y, m, d] = dayString.split('-').map(Number);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  let guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  for (let i = 0; i < 4; i += 1) {
    const offset = zoneOffsetMinutes(new Date(guess), timeZone);
    const next = Date.UTC(y, m - 1, d, hour, minute, 0) - offset * 60000;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** Попадает ли момент в окно [start, end) в заданной зоне. */
export function isWithinWindow(date, { timezone, windowStart, windowEnd }) {
  const start = parseClock(windowStart);
  const end = parseClock(windowEnd);
  if (start === null || end === null) return false;
  const minutes = zonedMinutesOfDay(date, timezone);
  if (end > start) return minutes >= start && minutes < end;
  // окно через полночь
  return minutes >= start || minutes < end;
}

/** Следующий момент открытия окна строго после указанного времени. */
export function nextWindowStart(after, { timezone, windowStart }) {
  const start = parseClock(windowStart);
  if (start === null) throw new Error(`Некорректное время начала окна: ${windowStart}`);
  for (let shift = 0; shift <= 2; shift += 1) {
    const day = zonedDateString(new Date(after.getTime() + shift * 86400000), timezone);
    const candidate = zonedTimeFromDayAndMinutes(day, start, timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error('Не удалось вычислить начало следующего окна');
}

/**
 * Случайная пауза в диапазоне [minIntervalSeconds, maxIntervalSeconds] — включительно.
 * newInterval — инъекция генератора для тестов.
 */
export function chooseIntervalMs(minIntervalSeconds, maxIntervalSeconds, newInterval = Math.random) {
  if (!Number.isFinite(minIntervalSeconds) || !Number.isFinite(maxIntervalSeconds)) {
    throw new Error('Диапазон интервала должен быть числом');
  }
  if (minIntervalSeconds > maxIntervalSeconds) {
    throw new Error('minIntervalSeconds не может быть больше maxIntervalSeconds');
  }
  const low = Math.ceil(minIntervalSeconds);
  const high = Math.floor(maxIntervalSeconds);
  const span = high - low + 1;
  const raw = Number(newInterval());
  const clamped = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999999) : 0;
  return (low + Math.floor(clamped * span)) * 1000;
}

/**
 * Планирование следующего запроса.
 *
 * Возвращает решение по одному шагу цикла:
 *  - immediate    — предыдущего запроса не было, пауза не нужна (первый запуск);
 *  - wait         — ждать случайную паузу, затем сделать запрос;
 *  - nextWindow   — ждать открытия окна (пауза вывела бы запрос за конец окна);
 *  - paused       — окно закрыто, сегодня запросов больше не будет.
 */
export function planNextRequest({
  now,
  schedule,
  chooseInterval = () => chooseIntervalMs(schedule.minIntervalSeconds, schedule.maxIntervalSeconds),
  hasPriorRequest = true,
  texts = null
}) {
  // Причина решения — текст из config/texts.json, если объект текстов передан;
  // иначе используется встроенная формулировка (утилита не зависит от файлов).
  const t = (path, params, fallback) => {
    if (!texts) return fallback;
    const value = texts.t(path, params);
    return value === path ? fallback : value;
  };
  const { timezone, windowStart, windowEnd } = schedule;
  const end = parseClock(windowEnd);

  if (!isWithinWindow(now, schedule)) {
    const minutes = zonedMinutesOfDay(now, timezone);
    const start = parseClock(windowStart);
    const afterEnd = end > start ? minutes >= end : minutes < start;
    if (afterEnd) {
      return {
        action: 'paused',
        nextWindowStart: nextWindowStart(now, schedule),
        reason: t(
          'scheduler.outsideWindow',
          { start: windowStart, end: windowEnd, timezone },
          `Вне окна ${windowStart}–${windowEnd} (${timezone}): новый запрос не начинаем до следующего дня.`
        )
      };
    }
    return {
      action: 'nextWindow',
      waitMs: nextWindowStart(now, schedule).getTime() - now.getTime(),
      nextWindowStart: nextWindowStart(now, schedule),
      reason: t(
        'scheduler.awaitWindow',
        { start: windowStart, end: windowEnd, timezone },
        `До открытия окна ${windowStart}–${windowEnd} (${timezone}).`
      )
    };
  }

  // Первый запрос после старта: паузы нет, но только если запросов ещё не было.
  if (!hasPriorRequest && schedule.firstRequestNoDelay === true) {
    return {
      action: 'immediate',
      waitMs: 0,
      plannedAt: new Date(now.getTime()),
      reason: t('scheduler.firstRequestNoDelay', {}, 'Первый запрос после старта: пауза не требуется.')
    };
  }

  return chooseAndValidate(now, schedule, chooseInterval, t);
}

/** Выбор случайной паузы с проверкой, что запрос не выйдет за конец окна. */
function chooseAndValidate(now, schedule, chooseInterval, t = (path, params, fallback) => fallback) {
  const intervalMs = chooseInterval();
  const plannedAt = new Date(now.getTime() + intervalMs);

  if (!isWithinWindow(plannedAt, schedule)) {
    const start = nextWindowStart(now, schedule);
    return {
      action: 'nextWindow',
      waitMs: start.getTime() - now.getTime(),
      intervalMs,
      plannedAt,
      nextWindowStart: start,
      reason: t(
        'scheduler.pauseWouldExceedWindow',
        { seconds: Math.round(intervalMs / 1000), end: schedule.windowEnd, timezone: schedule.timezone },
        `Пауза ${Math.round(intervalMs / 1000)} с вывела бы запрос за ${schedule.windowEnd} (${schedule.timezone}); опрос останавливается до следующего дня.`
      )
    };
  }

  return {
    action: 'wait',
    waitMs: intervalMs,
    intervalMs,
    plannedAt,
    reason: 'Случайная пауза перед следующим запросом.'
  };
}

/**
 * Планирование следующего запроса с учётом последнего фактического запроса.
 * Требование «первый запуск без паузы» сочетается со страховкой на перезапуск:
 * если запрос уже был (например, после рестарта) и минимальная выдержка ещё не
 * прошла, ждём остаток, а не делаем запрос немедленно.
 */
export function planNextRequestWithHistory({
  now,
  schedule,
  hasPriorRequest,
  lastRequestAt = null,
  chooseInterval = () => chooseIntervalMs(schedule.minIntervalSeconds, schedule.maxIntervalSeconds),
  texts = null
}) {
  const base = planNextRequest({ now, schedule, chooseInterval, hasPriorRequest, texts });
  if (base.action !== 'immediate') return base;

  const last = lastRequestAt ? new Date(lastRequestAt) : null;
  if (!last || Number.isNaN(last.getTime())) return base;

  const elapsed = now.getTime() - last.getTime();
  const minimum = schedule.minIntervalSeconds * 1000;
  if (elapsed >= minimum) {
    return {
      ...base,
      reason: texts
        ? texts.t('scheduler.firstRequestAfterLongGap', { seconds: Math.round(elapsed / 1000) })
        : `Первый запрос в этом процессе, с прошлого запроса прошло ${Math.round(elapsed / 1000)} с — пауза не требуется.`
    };
  }

  const remaining = minimum - elapsed;
  const plannedAt = new Date(now.getTime() + remaining);
  if (!isWithinWindow(plannedAt, schedule)) {
    const start = nextWindowStart(now, schedule);
    return {
      action: 'nextWindow',
      waitMs: start.getTime() - now.getTime(),
      plannedAt: start,
      nextWindowStart: start,
      reason: texts
        ? texts.t('scheduler.restartGapExceedsWindow', {
            seconds: Math.round(remaining / 1000),
            end: schedule.windowEnd,
            timezone: schedule.timezone
          })
        : `Выдержка ${Math.round(remaining / 1000)} с вывела бы запрос за ${schedule.windowEnd} (${schedule.timezone}).`
    };
  }
  return {
    action: 'wait',
    waitMs: remaining,
    intervalMs: remaining,
    plannedAt,
    reason: texts
      ? texts.t('scheduler.restartMinInterval', { seconds: Math.round(remaining / 1000) })
      : `После перезапуска выдерживаем минимальный интервал: ждать ещё ${Math.round(remaining / 1000)} с с момента последнего запроса.`
  };
}

/** Человекочитаемое время в зоне, для сообщений и логов. */
export function formatInZone(date, timeZone) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}
