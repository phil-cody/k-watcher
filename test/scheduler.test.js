import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PollingScheduler, SCHEDULER_STATE } from '../src/scheduler/scheduler.js';
import { SourceError, STOP_REASONS, fetchSinglePage, KworkHtmlSource } from '../src/source/kwork-html-source.js';
import { chooseIntervalMs, isWithinWindow, nextWindowStart, planNextRequest, zonedMinutesOfDay } from '../src/util/time.js';

const here = dirname(fileURLToPath(import.meta.url));

const baseSchedule = {
  timezone: 'Europe/Moscow',
  windowStart: '05:00',
  windowEnd: '19:00',
  minIntervalSeconds: 240,
  maxIntervalSeconds: 600,
  firstRequestNoDelay: true,
  failurePolicy: { consecutiveNetworkErrorLimit: 3, consecutiveStructureErrorLimit: 3 }
};

/** Время в UTC для московского времени (МСК = UTC+3). */
const msk = (hour, minute = 0, day = 7) => new Date(Date.UTC(2026, 9, day, hour - 3, minute, 0));

test('chooseIntervalMs всегда попадает в 240–600 секунд включительно', () => {
  const samples = [0, 0.0001, 0.25, 0.5, 0.75, 0.9999, 0.999999999];
  for (const sample of samples) {
    const ms = chooseIntervalMs(240, 600, () => sample);
    assert.ok(ms >= 240000 && ms <= 600000, `${sample} -> ${ms} мс вне диапазона`);
  }
  assert.equal(chooseIntervalMs(240, 600, () => 0), 240000);
  assert.equal(chooseIntervalMs(240, 600, () => 0.999999999), 600000);
});

test('planNextRequest выбирает новую паузу внутри окна', () => {
  const decision = planNextRequest({
    now: msk(10, 0),
    schedule: baseSchedule,
    chooseInterval: () => 300000
  });
  assert.equal(decision.action, 'wait');
  assert.equal(decision.intervalMs, 300000);
  assert.equal(decision.plannedAt.toISOString(), msk(10, 5).toISOString());
});

test('пауза, выводящая запрос за 19:00, откладывает опрос до следующего дня', () => {
  const decision = planNextRequest({
    now: msk(18, 57),
    schedule: baseSchedule,
    chooseInterval: () => 600000
  });
  assert.equal(decision.action, 'nextWindow');
  assert.ok(
    decision.reason.includes(baseSchedule.windowEnd),
    `причина должна упоминать конец окна (${baseSchedule.windowEnd}): ${decision.reason}`
  );
  assert.ok(decision.nextWindowStart.getTime() > msk(18, 57).getTime());
  assert.equal(isWithinWindow(decision.plannedAt, baseSchedule), false);
});

test('вне окна после 19:00 новый запрос не начинается', () => {
  const decision = planNextRequest({ now: msk(19, 30), schedule: baseSchedule, chooseInterval: () => 240000 });
  assert.equal(decision.action, 'paused');
  assert.ok(decision.nextWindowStart.getTime() > msk(19, 30).getTime());
});

test('до открытия окна планировщик ждёт 05:00', () => {
  const decision = planNextRequest({ now: msk(3, 0), schedule: baseSchedule, chooseInterval: () => 240000 });
  assert.equal(decision.action, 'nextWindow');
  assert.equal(decision.nextWindowStart.toISOString(), msk(5, 0).toISOString());
});

test('окно считается в Europe/Moscow, а не по локальному времени машины', () => {
  // 02:00 UTC = 05:00 МСК — внутри окна; 16:00 UTC = 19:00 МСК — уже закрыто.
  assert.equal(isWithinWindow(new Date('2026-10-07T02:00:00Z'), baseSchedule), true);
  assert.equal(isWithinWindow(new Date('2026-10-07T01:59:00Z'), baseSchedule), false);
  assert.equal(isWithinWindow(new Date('2026-10-07T16:00:00Z'), baseSchedule), false);
  assert.equal(isWithinWindow(new Date('2026-10-07T15:59:00Z'), baseSchedule), true);
  assert.equal(zonedMinutesOfDay(new Date('2026-10-07T16:00:00Z'), 'Europe/Moscow'), 19 * 60);
});

test('nextWindowStart возвращает ближайшее открытие окна', () => {
  const next = nextWindowStart(msk(20, 0), baseSchedule);
  assert.equal(next.toISOString(), msk(5, 0, 8).toISOString());
});

function makeScheduler({ now, random = () => 0.5, onCycle, sleep = async () => {} }) {
  return new PollingScheduler({
    schedule: baseSchedule,
    source: null,
    onCycle,
    now,
    random,
    sleep
  });
}

test('tick делает один запрос и не уменьшает интервал при ошибке', async () => {
  const sleeps = [];
  let nowValue = msk(10, 0);
  const calls = [];
  const scheduler = makeScheduler({
    now: () => nowValue,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowValue = new Date(nowValue.getTime() + ms);
    },
    onCycle: async () => {
      calls.push(nowValue.toISOString());
      throw new SourceError('сетевая ошибка', { retryable: true });
    }
  });

  await scheduler.tick(); // первый запрос: без паузы
  await scheduler.tick(); // второй запрос: после случайной паузы
  assert.equal(calls.length, 2, 'за каждый tick выполняется ровно один запрос');
  assert.deepEqual(sleeps, [420000], 'пауза 420 с соответствует random=0.5 в диапазоне 240–600');
  assert.equal(scheduler.consecutiveNetworkErrors, 2);
  assert.equal(scheduler.status, SCHEDULER_STATE.RUNNING, 'две сетевые ошибки не останавливают опрос');
});

test('три сетевые ошибки подряд останавливают опрос без ускоренных повторов', async () => {
  let nowValue = msk(10, 0);
  const scheduler = makeScheduler({
    now: () => nowValue,
    sleep: async (ms) => {
      nowValue = new Date(nowValue.getTime() + ms);
    },
    onCycle: async () => {
      throw new SourceError('сеть недоступна', { retryable: true });
    }
  });

  await scheduler.tick();
  await scheduler.tick();
  const result = await scheduler.tick();
  assert.equal(result.action, 'stopped');
  assert.equal(scheduler.stopReason, STOP_REASONS.NETWORK_ERRORS);
  assert.equal(scheduler.consecutiveNetworkErrors, 3);
});

test('HTTP 429 немедленно останавливает опрос', async () => {
  let nowValue = msk(10, 0);
  const scheduler = makeScheduler({
    now: () => nowValue,
    sleep: async (ms) => {
      nowValue = new Date(nowValue.getTime() + ms);
    },
    onCycle: async () => {
      throw new SourceError('HTTP 429', { stopReason: STOP_REASONS.HTTP_429, httpStatus: 429 });
    }
  });
  const result = await scheduler.tick();
  assert.equal(result.action, 'stopped');
  assert.equal(scheduler.status, SCHEDULER_STATE.STOPPED);
  assert.equal(scheduler.stopReason, STOP_REASONS.HTTP_429);
});

test('CAPTCHA останавливает опрос и не приводит к повторам', async () => {
  let nowValue = msk(11, 0);
  let calls = 0;
  const scheduler = makeScheduler({
    now: () => nowValue,
    sleep: async (ms) => {
      nowValue = new Date(nowValue.getTime() + ms);
    },
    onCycle: async () => {
      calls += 1;
      throw new SourceError('CAPTCHA', { stopReason: STOP_REASONS.CAPTCHA });
    }
  });
  const result = await scheduler.tick();
  assert.equal(result.action, 'stopped');
  assert.equal(scheduler.stopReason, STOP_REASONS.CAPTCHA);
  assert.equal(calls, 1);
});

test('три подряд неразобранные структуры безопасно приостанавливают опрос', async () => {
  let nowValue = msk(12, 0);
  const scheduler = makeScheduler({
    now: () => nowValue,
    sleep: async (ms) => {
      nowValue = new Date(nowValue.getTime() + ms);
    },
    onCycle: async () => ({ structureOk: false })
  });
  await scheduler.tick();
  await scheduler.tick();
  const third = await scheduler.tick();
  assert.equal(third.action, 'requested');
  assert.equal(scheduler.stopReason, STOP_REASONS.STRUCTURE_CHANGED);
  assert.equal(scheduler.status, SCHEDULER_STATE.PAUSED);
});

test('команды pause и resume меняют состояние', async () => {
  let nowValue = msk(10, 0);
  let calls = 0;
  const scheduler = makeScheduler({
    now: () => nowValue,
    onCycle: async () => {
      calls += 1;
      return { structureOk: true };
    }
  });
  scheduler.pause('по команде пользователя');
  const paused = await scheduler.tick();
  assert.equal(paused.action, 'paused');
  assert.equal(calls, 0, 'на паузе запросы не выполняются');

  scheduler.resume();
  assert.equal(scheduler.status, SCHEDULER_STATE.IDLE);
  assert.equal(scheduler.pausedByUser, false);
});

test('после 19:00 tick не выполняет запрос', async () => {
  let calls = 0;
  const scheduler = makeScheduler({
    now: () => msk(19, 5),
    onCycle: async () => {
      calls += 1;
      return { structureOk: true };
    }
  });
  const result = await scheduler.tick();
  assert.equal(result.action, 'paused');
  assert.equal(calls, 0);
  assert.equal(scheduler.stopReason, STOP_REASONS.WINDOW_CLOSED);
});

test('describeState содержит окно и диапазон интервала', () => {
  const scheduler = makeScheduler({ now: () => msk(10, 0), onCycle: async () => ({ structureOk: true }) });
  const text = scheduler.describeState();
  assert.match(text, /05:00–19:00/);
  assert.match(text, /Europe\/Moscow/);
  assert.match(text, /240–600/);
});

test('fetchSinglePage отвергает URL вне подтверждённого объёма', async () => {
  await assert.rejects(
    () => fetchSinglePage('https://kwork.ru/projects/12345/some-job', { userAgent: 'test', fetchImpl: async () => ({}) }),
    (error) => error.stopReason === STOP_REASONS.CONFIG
  );
  await assert.rejects(
    () => fetchSinglePage('http://kwork.ru/projects', { userAgent: 'test', fetchImpl: async () => ({}) }),
    (error) => error.stopReason === STOP_REASONS.CONFIG
  );
  await assert.rejects(
    () => fetchSinglePage('https://example.com/projects', { userAgent: 'test', fetchImpl: async () => ({}) }),
    (error) => error.stopReason === STOP_REASONS.CONFIG
  );
});

test('fetchSinglePage обрабатывает 429, 403 и CAPTCHA как остановку', async () => {
  const makeResponse = (status, body = '') => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => ({})
  });

  await assert.rejects(
    () => fetchSinglePage('https://kwork.ru/projects', { userAgent: 't', fetchImpl: async () => makeResponse(429) }),
    (error) => error.stopReason === STOP_REASONS.HTTP_429
  );
  await assert.rejects(
    () => fetchSinglePage('https://kwork.ru/projects', { userAgent: 't', fetchImpl: async () => makeResponse(403) }),
    (error) => error.stopReason === STOP_REASONS.HTTP_403
  );
  await assert.rejects(
    () =>
      fetchSinglePage('https://kwork.ru/projects', {
        userAgent: 't',
        fetchImpl: async () => makeResponse(200, '<html><body>Подтвердите, что вы не робот</body></html>')
      }),
    (error) => [STOP_REASONS.CAPTCHA, STOP_REASONS.BOT_CHECK].includes(error.stopReason)
  );
});

test('первый запрос после старта выполняется без паузы', async () => {
  const sleeps = [];
  let nowValue = msk(10, 0);
  const calls = [];
  const scheduler = makeScheduler({
    now: () => nowValue,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowValue = new Date(nowValue.getTime() + ms);
    },
    onCycle: async () => {
      calls.push(nowValue.toISOString());
      return { structureOk: true };
    }
  });

  await scheduler.tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, [], 'перед первым запросом паузы быть не должно');
  assert.equal(scheduler.lastRequestAt.toISOString(), msk(10, 0).toISOString());
});

test('второй запрос ждёт новую случайную паузу 240–600 с', async () => {
  const sleeps = [];
  let nowValue = msk(10, 0);
  let calls = 0;
  const scheduler = makeScheduler({
    now: () => nowValue,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowValue = new Date(nowValue.getTime() + ms);
    },
    onCycle: async () => {
      calls += 1;
      return { structureOk: true };
    }
  });

  await scheduler.tick();
  await scheduler.tick();
  assert.equal(calls, 2);
  assert.equal(sleeps.length, 1, 'пауза нужна только перед вторым запросом');
  assert.equal(sleeps[0], 420000);
  assert.ok(sleeps[0] >= 240000 && sleeps[0] <= 600000);
});

test('после перезапуска процесс не запрашивает страницу немедленно', async () => {
  const sleeps = [];
  let nowValue = msk(10, 0);
  const scheduler = makeScheduler({
    now: () => nowValue,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowValue = new Date(nowValue.getTime() + ms);
    },
    onCycle: async () => ({ structureOk: true })
  });
  // Имитация перезапуска: запрос был минуту назад, состояние восстановлено.
  scheduler.lastRequestAt = new Date(nowValue.getTime() - 60000);

  await scheduler.tick();
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 180000, 'ждём остаток минимального интервала с момента последнего запроса');
});

test('ручная пауза и возобновление не приводят к немедленному запросу', async () => {
  const sleeps = [];
  let nowValue = msk(10, 0);
  const scheduler = makeScheduler({
    now: () => nowValue,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowValue = new Date(nowValue.getTime() + ms);
    },
    onCycle: async () => ({ structureOk: true })
  });
  await scheduler.tick(); // первый запрос без паузы
  scheduler.pause('по команде пользователя');
  scheduler.resume();
  await scheduler.tick(); // после возобновления — обычная случайная пауза
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 240000 && sleeps[0] <= 600000);
});

test('fetchSinglePage не останавливается из-за упоминания captcha в скрипте', async () => {
  const html = readFileSync(resolve(here, 'fixtures', 'listing-with-captcha-script.html'), 'utf8');
  const result = await fetchSinglePage('https://kwork.ru/projects', {
    userAgent: 't',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => html, headers: { get: () => null } })
  });
  assert.ok(result.html.length > 0);
  assert.ok(Array.isArray(result.softAnomalies));
});

test('fetchSinglePage сообщает Retry-After при 429', async () => {
  await assert.rejects(
    () =>
      fetchSinglePage('https://kwork.ru/projects', {
        userAgent: 't',
        fetchImpl: async () => ({
          ok: false,
          status: 429,
          headers: { get: (name) => (name === 'retry-after' ? '120' : null) },
          text: async () => ''
        })
      }),
    (error) => error.stopReason === STOP_REASONS.HTTP_429 && error.details.retryAfterSeconds === 120
  );
});

test('fetchSinglePage принимает страницы подтверждённого URL (?page=N)', async () => {
  const requested = [];
  const allowedUrls = [
    { url: 'https://kwork.ru/projects', enabled: true },
    { url: 'https://kwork.ru/projects?c=38', enabled: true }
  ];
  const fetchImpl = async (url) => {
    requested.push(url);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '<html><body><main></main></body></html>' };
  };
  for (const url of ['https://kwork.ru/projects?page=2', 'https://kwork.ru/projects?c=38&page=3']) {
    await fetchSinglePage(url, { userAgent: 't', allowedUrls, fetchImpl });
  }
  assert.deepEqual(requested, ['https://kwork.ru/projects?page=2', 'https://kwork.ru/projects?c=38&page=3']);

  // Чужая категория или лишний параметр — отклоняются до сети.
  for (const url of ['https://kwork.ru/projects?c=99&page=2', 'https://kwork.ru/projects?c=38&page=3&evil=1']) {
    await assert.rejects(
      () => fetchSinglePage(url, { userAgent: 't', allowedUrls, fetchImpl }),
      (error) => error.stopReason === STOP_REASONS.CONFIG
    );
  }
});

test('fetchSinglePage принимает подтверждённый URL категории с ?c=', async () => {
  let requested = null;
  const allowedUrls = [{ url: 'https://kwork.ru/projects?c=79', enabled: true }];
  await fetchSinglePage('https://kwork.ru/projects?c=79', {
    userAgent: 't',
    allowedUrls,
    fetchImpl: async (url) => {
      requested = url;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => '<html><body><main></main></body></html>' };
    }
  });
  assert.equal(requested, 'https://kwork.ru/projects?c=79');

  await assert.rejects(
    () =>
      fetchSinglePage('https://kwork.ru/projects?c=999', {
        userAgent: 't',
        allowedUrls,
        fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' })
      }),
    (error) => error.stopReason === STOP_REASONS.CONFIG
  );
});

test('fetchSinglePage отправляет GET без cookies и заголовков авторизации', async () => {
  let seen = null;
  const response = { ok: true, status: 200, text: async () => '<html><body><div class="want-card"></div></body></html>' };
  await fetchSinglePage('https://kwork.ru/projects', {
    userAgent: 'kwork-watcher-test',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return response;
    }
  });
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.headers['user-agent'], 'kwork-watcher-test');
  const headerNames = Object.keys(seen.options.headers).map((name) => name.toLowerCase());
  assert.ok(!headerNames.some((name) => /cookie|authorization|referer|origin/.test(name)));
});

test('KworkHtmlSource запрещает параллельные запросы', async () => {
  let release;
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const source = new KworkHtmlSource({
    allowedUrls: [{ url: 'https://kwork.ru/projects', enabled: true }],
    userAgent: 't',
    fetchImpl: async () => {
      await gate;
      return { ok: true, status: 200, text: async () => '<html><body></body></html>' };
    }
  });

  const first = source.fetchPage('https://kwork.ru/projects');
  await assert.rejects(
    () => source.fetchPage('https://kwork.ru/projects'),
    (error) => error.stopReason === STOP_REASONS.CONFIG
  );
  release();
  await first;
  assert.equal(source.requestCount, 1);
});

test('KworkHtmlSource показывает план запрашиваемых URL', () => {
  const source = new KworkHtmlSource({
    allowedUrls: [{ id: 'projects-all', url: 'https://kwork.ru/projects', label: 'Список', enabled: true }],
    userAgent: 't'
  });
  const plan = source.describePlan();
  assert.equal(plan.length, 1);
  assert.equal(plan[0].url, 'https://kwork.ru/projects');
  assert.equal(plan[0].pages, 1);
});


test('уведомление об открытии окна отправляется один раз на переход', async () => {
  const events = [];
  let nowValue = msk(4, 59); // 04:59 МСК — окно ещё закрыто
  const scheduler = new PollingScheduler({
    schedule: baseSchedule,
    source: null,
    onCycle: async () => ({ structureOk: true }),
    now: () => nowValue,
    sleep: async () => {},
    onWindowChange: async (event) => events.push(event),
    windowOpen: false
  });

  await scheduler.trackWindowBoundary();
  assert.equal(events.length, 0, 'пока окно закрыто, уведомлений нет');

  nowValue = msk(5, 1); // окно открылось
  await scheduler.trackWindowBoundary();
  assert.equal(events.length, 1);
  assert.equal(events[0].direction, 'opened');
  assert.equal(events[0].schedule.start, '05:00');
  assert.equal(events[0].nextWindowStart, null);

  await scheduler.trackWindowBoundary();
  assert.equal(events.length, 1, 'повторный tick внутри окна не шлёт уведомление');
});

test('уведомление о закрытии окна содержит время следующего открытия и статистику', async () => {
  const events = [];
  let nowValue = msk(19, 59);
  const scheduler = new PollingScheduler({
    schedule: baseSchedule,
    source: null,
    onCycle: async () => ({ structureOk: true }),
    now: () => nowValue,
    sleep: async () => {},
    onWindowChange: async (event) => events.push(event),
    windowOpen: true
  });

  nowValue = msk(20, 1);
  await scheduler.trackWindowBoundary({ stats: { requests: 7, newJobs: 4, activeJobs: 33 } });
  assert.equal(events.length, 1);
  assert.equal(events[0].direction, 'closed');
  assert.equal(events[0].stats.requests, 7);
  assert.ok(events[0].nextWindowStart, 'должно быть указано время следующего открытия');
  assert.ok(new Date(events[0].nextWindowStart).getTime() > nowValue.getTime());
});

test('state содержит windowOpen — состояние окна переживает перезапуск', async () => {
  let nowValue = msk(10, 0);
  const scheduler = new PollingScheduler({
    schedule: baseSchedule,
    source: null,
    onCycle: async () => ({ structureOk: true }),
    now: () => nowValue,
    sleep: async () => {},
    texts: null
  });
  scheduler.windowOpen = null;
  await scheduler.trackWindowBoundary();
  assert.equal(scheduler.state.windowOpen, true, 'внутри окна состояние должно быть true');

  // Перезапуск: состояние окна уже известно — уведомление не отправится.
  const events = [];
  const restarted = new PollingScheduler({
    schedule: baseSchedule,
    source: null,
    onCycle: async () => ({ structureOk: true }),
    now: () => nowValue,
    sleep: async () => {},
    onWindowChange: async (event) => events.push(event),
    windowOpen: true
  });
  await restarted.trackWindowBoundary();
  assert.equal(events.length, 0, 'после перезапуска ложного «открылось» быть не должно');
});
