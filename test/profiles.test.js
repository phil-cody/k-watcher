/**
 * Тесты профилей на пользователя: хранилище, загрузка файлом, напоминания
 * и анализ своих заданий для каждого пользователя.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProfileStore, PROFILE_SIZE_LIMIT } from '../src/storage/profile-store.js';
import { JobStore } from '../src/storage/job-store.js';
import { KworkListingParser } from '../src/parser/job-parser.js';
import { createCycleRunner } from '../src/scheduler/cycle.js';
import { createTexts } from '../src/texts/texts.js';
import { makeFixtureProfile } from './helpers/text-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });
const realProfile = JSON.parse(await readFile(resolve(rootDir, 'config', 'performer-profile.json'), 'utf8'));

test('общего профиля нет: пока пользователь не загрузил свой, анализа не будет', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'profiles-'));
  try {
    const store = new ProfileStore({ dataDir: dir });

    // Без личного профиля — профиля нет вовсе.
    const before = await store.get(222);
    assert.equal(before.profile, null);
    assert.equal(before.source, null);

    // Пользователь загрузил свой профиль.
    const personal = makeFixtureProfile({ headline: 'Личный профиль', pricing: { ...realProfile.pricing, hourly_rate: 1500 } });
    await store.save(222, personal);

    const after = await store.get(222);
    assert.equal(after.source, 'personal');
    assert.equal(after.profile.headline, 'Личный профиль');
    assert.equal(after.profile.pricing.hourly_rate, 1500);
    // Другой пользователь по-прежнему без профиля.
    assert.equal((await store.get(333)).profile, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('битый файл профиля не ломает работу: профиля просто нет', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'profiles-'));
  try {
    const store = new ProfileStore({ dataDir: dir, logger: null });
    const path = store.pathFor(222);
    await store.save(222, makeFixtureProfile());
    await writeFile(path, '{ это не json', 'utf8');

    const result = await store.get(222);
    assert.equal(result.profile, null, 'повреждённый личный профиль не используется');
    assert.equal(result.source, null);
    // Пользователю нужно загрузить профиль заново.
    assert.equal(store.has(222), true, 'файл на месте, но невалиден');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('без личного и общего профиля пользователь остаётся без анализа', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'profiles-'));
  try {
    const store = new ProfileStore({ dataDir: dir });
    const result = await store.get(555);
    assert.equal(result.profile, null);
    assert.equal(result.source, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parse принимает корректный профиль и объясняет отказ', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'profiles-'));
  try {
    const store = new ProfileStore({ dataDir: dir });

    const good = store.parse(JSON.stringify(realProfile));
    assert.equal(good.ok, true);

    assert.match(store.parse('').error, /пуст/i);
    assert.match(store.parse('{').error, /не корректный JSON/);
    assert.match(store.parse('[1,2,3]').error, /JSON-объектом/);
    // Профиль без содержания отклоняется: анализировать по нему нечего.
    const incomplete = store.parse(JSON.stringify({ headline: 'Без навыков' }));
    assert.equal(incomplete.ok, false);
    assert.match(incomplete.error, /skills|portfolio|pricing/i);

    // Достаточно одного содержательного блока: хватает навыков.
    const minimalOk = store.parse(JSON.stringify({ skills: ['HTML', 'CSS'] }));
    assert.equal(minimalOk.ok, true);

    // Слишком большой файл отклоняется до разбора.
    const huge = `{"x":"${'a'.repeat(PROFILE_SIZE_LIMIT)}"}`;
    assert.match(store.parse(huge).error, /больше/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('import сохраняет профиль и возвращает предупреждения', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'profiles-'));
  try {
    const store = new ProfileStore({ dataDir: dir });
    const minimal = {
      profile_version: 1,
      headline: 'Вёрстка',
      skills: ['HTML', 'CSS'],
      portfolio: [],
      pricing: { minimum_project_price: 3000 },
      availability: { timezone: 'Europe/Moscow' },
      proposal_preferences: {}
    };
    const result = await store.import(777, JSON.stringify(minimal));
    assert.equal(result.ok, true, result.error);
    assert.ok(result.warnings.length > 0, 'неполный профиль должен дать предупреждения');
    assert.equal(store.has(777), true);
    assert.equal((await store.get(777)).profile.pricing.minimum_project_price, 3000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('remove убирает профиль: анализа больше нет', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'profiles-'));
  try {
    const store = new ProfileStore({ dataDir: dir });
    await store.save(222, makeFixtureProfile());
    assert.equal(store.has(222), true);
    assert.equal(await store.remove(222), true);
    assert.equal(store.has(222), false);
    assert.equal((await store.get(222)).profile, null);
    assert.equal(await store.remove(222), false, 'повторное удаление — не ошибка');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('напоминание о профиле отправляется не чаще раза в сутки', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'profiles-'));
  try {
    const store = new ProfileStore({ dataDir: dir });
    const now = new Date('2026-10-08T10:00:00.000Z');

    const first = await store.noteReminder(222, { now });
    assert.equal(first.allowed, true);

    const second = await store.noteReminder(222, { now: new Date(now.getTime() + 60 * 60 * 1000) });
    assert.equal(second.allowed, false, 'через час повторять нельзя');
    assert.ok(second.lastReminderAt);

    const nextDay = await store.noteReminder(222, { now: new Date(now.getTime() + 25 * 60 * 60 * 1000) });
    assert.equal(nextDay.allowed, true, 'на следующий день напомнить можно');

    // Отметки переживают перезапуск.
    const reloaded = new ProfileStore({ dataDir: dir });
    const sameDay = await reloaded.noteReminder(222, { now: new Date(now.getTime() + 25 * 60 * 60 * 1000 + 1000) });
    assert.equal(sameDay.allowed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('summarize и listPersonal показывают, у кого есть профиль', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'profiles-'));
  try {
    const store = new ProfileStore({ dataDir: dir });
    await store.save(222, makeFixtureProfile());

    const summary = await store.summarize([222, 333]);
    assert.deepEqual(summary, [
      { userId: 222, hasProfile: true, source: 'personal' },
      { userId: 333, hasProfile: false, source: null }
    ]);
    assert.deepEqual(await store.listPersonal(), [222]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Сборка цикла с двумя пользователями и разными профилями. */
async function makeRunner({ dir, recipients, profiles, html }) {
  const store = await new JobStore({ dataDir: dir }).init();
  const sent = [];
  const runner = createCycleRunner({
    source: { fetchPage: async (url) => ({ html, status: 200, url }) },
    parser: new KworkListingParser({ targetCategories: [] }),
    store,
    profile: null,
    profiles,
    recipients,
    notifier: {
      chatId: null,
      sendMessage: async (text, options = {}) => {
        sent.push({ text, chatId: options.chatId ?? null });
      }
    },
    config: {
      rootDir,
      targetCategories: [],
      source: { allowedUrls: [{ url: 'https://kwork.ru/projects', enabled: true, pages: 1 }] },
      categoryMapping: { confirmed: false }
    },
    logger: null,
    texts
  });
  return { runner, store, sent };
}

test('каждому пользователю задание уходит со своим профилем и своей ценой', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'peruser-'));
  try {
    const profiles = new ProfileStore({ dataDir: dir });
    // Два разных исполнителя: у одного ставка 700, у другого 2000.
    await profiles.save(111, {
      ...makeFixtureProfile(),
      headline: 'Исполнитель А',
      pricing: { ...makeFixtureProfile().pricing, hourly_rate: 700 }
    });
    await profiles.save(222, {
      ...makeFixtureProfile(),
      headline: 'Исполнитель Б',
      pricing: { ...makeFixtureProfile().pricing, hourly_rate: 2000 }
    });

    const html = await readFile(resolve(rootDir, 'test', 'fixtures', 'listing-embedded-json.html'), 'utf8');
    const { runner, sent } = await makeRunner({
      dir,
      profiles,
      html,
      recipients: [
        { userId: 111, chatId: 111 },
        { userId: 222, chatId: 222 }
      ]
    });

    const summary = await runner.runOnce();

    assert.equal(summary.newJobs, 4, 'четыре новых задания из фикстуры');
    assert.equal(summary.sent, 8, 'каждое задание ушло обоим пользователям');

    const toFirst = sent.filter((item) => item.chatId === 111);
    const toSecond = sent.filter((item) => item.chatId === 222);
    assert.equal(toFirst.length, 4);
    assert.equal(toSecond.length, 4);
    // Цифры в черновиках различаются: у второго ставка выше.
    const firstPrices = toFirst.map((item) => /Стоимость: (\d[\d\s]*)/.exec(item.text)?.[1]).filter(Boolean);
    const secondPrices = toSecond.map((item) => /Стоимость: (\d[\d\s]*)/.exec(item.text)?.[1]).filter(Boolean);
    assert.ok(firstPrices.length > 0 && secondPrices.length > 0, 'в сообщениях должна быть цена');
    const toNumber = (value) => Number(String(value).replace(/\s/g, ''));
    assert.ok(
      Math.min(...secondPrices.map(toNumber)) > Math.max(...firstPrices.map(toNumber)),
      `цена второго исполнителя должна быть выше: ${secondPrices} против ${firstPrices}`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('пользователь без профиля не получает заданий, но получает напоминание один раз', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'peruser-'));
  try {
    const profiles = new ProfileStore({ dataDir: dir });
    await profiles.save(111, makeFixtureProfile()); // профиль есть только у первого

    const html = await readFile(resolve(rootDir, 'test', 'fixtures', 'listing-embedded-json.html'), 'utf8');
    const { runner, sent } = await makeRunner({
      dir,
      profiles,
      html,
      recipients: [
        { userId: 111, chatId: 111 },
        { userId: 222, chatId: 222 }
      ]
    });

    const summary = await runner.runOnce();
    assert.deepEqual([...new Set(summary.noProfile)], [222], 'второй пользователь без профиля');
    assert.equal(summary.reminders, 1, 'напоминание отправлено один раз');

    const toSecond = sent.filter((item) => item.chatId === 222);
    assert.equal(toSecond.length, 1);
    assert.match(toSecond[0].text, /профиль не загружен/i);
    // Заданий второму не отправляли.
    assert.equal(sent.filter((item) => item.chatId === 222 && /Новое задание/.test(item.text)).length, 0);

    // Второй цикл: заданий уже нет, напоминание повторять нельзя.
    const second = await runner.runOnce();
    assert.equal(second.reminders, 0, 'второе напоминание в тот же день не отправляется');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('без списка получателей работает прежняя схема с одним профилем', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'peruser-'));
  try {
    const html = await readFile(resolve(rootDir, 'test', 'fixtures', 'listing-embedded-json.html'), 'utf8');
    const store = await new JobStore({ dataDir: dir }).init();
    const sent = [];
    const runner = createCycleRunner({
      source: { fetchPage: async (url) => ({ html, status: 200, url }) },
      parser: new KworkListingParser({ targetCategories: [] }),
      store,
      profile: makeFixtureProfile(),
      // chatId не задан: клиент сам знает, куда отправлять.
      notifier: {
        chatId: null,
        sendMessage: async (text, options = {}) => sent.push({ text, chatId: options.chatId ?? null })
      },
      config: {
        rootDir,
        targetCategories: [],
        source: { allowedUrls: [{ url: 'https://kwork.ru/projects', enabled: true, pages: 1 }] },
        categoryMapping: { confirmed: false }
      },
      logger: null,
      texts
    });

    const summary = await runner.runOnce();
    assert.equal(summary.newJobs, 4);
    assert.equal(summary.sent, 4);
    assert.equal(summary.noProfile.length, 0);
    // Без явного chatId сообщение уходит в чат по умолчанию клиента.
    assert.ok(sent.length > 0);
    assert.ok(sent.every((item) => item.chatId === null), 'явный chatId не должен передаваться');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
