import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseListingHtml, extractJobFromCard, buildDedupKey } from '../src/parser/job-parser.js';
import { parseBudget, parseRelativeDate, extractJobId, matchTargetCategory } from '../src/parser/normalize.js';
import { detectPageAnomaliesDetailed, describeAnomalyDiagnostics } from '../src/parser/anomaly-detector.js';
import { decodeEntities, parseHtml, textOf, findAll } from '../src/util/html.js';
import { TARGET_CATEGORIES } from './helpers/target-categories.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(resolve(here, 'fixtures', name), 'utf8');
// Набор «целевых» категорий — тестовый (в рабочем конфиге его нет).
const TARGETS = TARGET_CATEGORIES;
const SOURCE_URL = 'https://kwork.ru/projects';
const REFERENCE = new Date('2026-10-07T12:00:00Z');

test('стандартная разметка: карточки и нормализованные поля', () => {
  const result = parseListingHtml(fixture('listing-standard.html'), {
    sourceUrl: SOURCE_URL,
    targetCategories: TARGETS,
    referenceDate: REFERENCE
  });

  assert.equal(result.jobs.length, 3, 'должно быть три карточки');
  assert.equal(result.structure.containerCount, 3);

  const first = result.jobs[0];
  assert.equal(first.id, '884213');
  assert.equal(first.url, 'https://kwork.ru/projects/884213/verstka-lendinga-po-maketu-figma');
  assert.equal(first.title, 'Вёрстка лендинга по макету Figma');
  assert.match(first.description, /одностраничный лендинг/);
  assert.equal(first.budget.min, 5000);
  assert.equal(first.budget.max, 5000);
  assert.equal(first.budget.currency, 'RUB');
  assert.equal(first.budget.isRange, false);
  assert.equal(first.publishedAt.iso, '2026-10-07T05:10:00.000Z');
  assert.equal(first.publishedAt.origin, 'fact:datetime-attribute');
  assert.equal(first.category.id, 'markup-adaptation', 'в заголовке явно сказано про адаптивную вёрстку');
  assert.equal(first.missingFields.includes('budget'), false);
  assert.equal(first.provenance.rawHtmlStored, false);
});

test('диапазон бюджета разбирается в min и max', () => {
  const result = parseListingHtml(fixture('listing-standard.html'), {
    sourceUrl: SOURCE_URL,
    targetCategories: TARGETS,
    referenceDate: REFERENCE
  });
  const second = result.jobs[1];
  assert.equal(second.budget.min, 2000);
  assert.equal(second.budget.max, 4000);
  assert.equal(second.budget.isRange, true);
  assert.equal(second.category.id, 'markup-adaptation', 'при равной длине подсказок выигрывает приоритетная категория');
});

test('текстовая дата без атрибута не превращается в точный ISO', () => {
  const result = parseListingHtml(fixture('listing-standard.html'), {
    sourceUrl: SOURCE_URL,
    targetCategories: TARGETS,
    referenceDate: REFERENCE
  });
  const third = result.jobs[2];
  assert.equal(third.publishedAt.text, 'сегодня');
  assert.equal(third.publishedAt.iso, null, 'точная дата не должна выдумываться');
  assert.equal(third.publishedAt.confidence, 'imprecise');
});

test('отсутствующие поля остаются null и попадают в missingFields', () => {
  const result = parseListingHtml(fixture('listing-missing-fields.html'), {
    sourceUrl: SOURCE_URL,
    targetCategories: TARGETS,
    referenceDate: REFERENCE
  });

  assert.equal(result.jobs.length, 2);

  const noDescription = result.jobs[0];
  assert.equal(noDescription.id, '900001');
  assert.equal(noDescription.description, null, 'описание отсутствует в карточке — не выдумываем');
  assert.equal(noDescription.descriptionSource, 'absent-in-list');
  assert.equal(noDescription.publishedAt, null);
  assert.ok(noDescription.missingFields.includes('description'));
  assert.ok(noDescription.missingFields.includes('publishedAt'));
  assert.ok(!noDescription.missingFields.includes('declaredCategory'), 'категория берётся из каталога сайта, а не из карточки');
  assert.ok(noDescription.missingFields.includes('clientName'));
});

test('нечисловой data-want-id не подставляется как id, но даёт предупреждение', () => {
  const html = `
    <div class="want-card js-want-card" data-want-id="unknown-id">
      <a href="/projects/unknown-id/dorabotka-sayta-na-wordpress">Доработка сайта на WordPress</a>
      <div class="want-card__description">Нужно поправить вёрстку и подключить плагин.</div>
      <span class="want-card__price">от 1 000 ₽</span>
    </div>`;
  const result = parseListingHtml(html, {
    sourceUrl: SOURCE_URL,
    targetCategories: TARGETS,
    referenceDate: REFERENCE
  });
  assert.equal(result.jobs.length, 1);
  const job = result.jobs[0];
  assert.equal(job.id, null, 'нечисловой атрибут не должен становиться идентификатором');
  assert.equal(job.title, 'Доработка сайта на WordPress');
  assert.ok(job.warnings.some((warning) => /не является числом/.test(warning)));
  assert.equal(job.budget.min, 1000);
  assert.equal(job.budget.isFrom, true);
  assert.equal(job.dedupKind, 'url', 'составной ключ не нужен, пока есть ссылка');
});

test('относительная ссылка без ведущего слэша и query-параметры обрабатываются корректно', () => {
  const result = parseListingHtml(fixture('listing-missing-fields.html'), {
    sourceUrl: SOURCE_URL,
    targetCategories: TARGETS,
    referenceDate: REFERENCE
  });
  const second = result.jobs[1];
  assert.equal(second.id, '900002');
  assert.equal(second.url, 'https://kwork.ru/projects/900002/verstka-pochtovogo-shablona?ref=list');
  assert.equal(second.budget.min, 3000);
  assert.equal(second.budget.text, '3 000 ₽, возможно больше');
  assert.equal(second.publishedAt.iso, '2026-10-06T16:30:00.000Z');
});

test('nbsp в цене и пустой <time> обрабатываются без потери данных', () => {
  const result = parseListingHtml(fixture('listing-missing-fields.html'), {
    sourceUrl: SOURCE_URL,
    targetCategories: TARGETS,
    referenceDate: REFERENCE
  });
  const first = result.jobs[0];
  assert.equal(first.budget.min, 1500);
  assert.equal(first.budget.currency, 'RUB');
  assert.equal(first.id, '900001');
  assert.equal(first.category, null, 'категория не угадывается без подсказок и объявленного раздела');
  assert.ok(!first.missingFields.includes('declaredCategory'), 'категория берётся из каталога сайта, а не из карточки');
});

test('изменённая структура (data-* вместо классов) разбирается без выдумывания', () => {
  const result = parseListingHtml(fixture('listing-changed-structure.html'), {
    sourceUrl: SOURCE_URL,
    targetCategories: TARGETS,
    referenceDate: REFERENCE
  });

  assert.equal(result.jobs.length, 2);
  assert.equal(result.structure.strategy, 'data-project-id');

  const first = result.jobs[0];
  assert.equal(first.id, '771001');
  assert.equal(first.title, 'Адаптивная вёрстка каталога товаров');
  assert.match(first.description, /Каталог с фильтрами/);
  assert.equal(first.budget.min, 7000);
  assert.equal(first.declaredCategory, 'Вёрстка');
  assert.equal(first.publishedAt.iso, '2026-10-07T06:00:00.000Z');
  assert.equal(first.client, null, 'клиент в карточке не указан — не выдумываем');
  assert.ok(first.missingFields.includes('clientName'));

  const second = result.jobs[1];
  assert.equal(second.budget, null);
  assert.equal(second.declaredCategory, null);
  assert.ok(second.missingFields.includes('budget'));
  assert.ok(!second.missingFields.includes('declaredCategory'), 'категория берётся из каталога сайта, а не из карточки');
  assert.equal(second.publishedAt.iso, '2026-10-07T03:15:00.000Z');
});

test('карточка-обёртка без собственных данных не считается заданием', () => {
  const html = `
    <div class="want-card js-want-card" data-want-id="123456">
      <div class="want-card js-want-card" data-want-id="123457">
        <a href="/projects/123457/nastroyka-sayta">Настройка сайта на WordPress</a>
        <span class="want-card__price">2 000 ₽</span>
      </div>
    </div>`;
  const result = parseListingHtml(html, {
    sourceUrl: SOURCE_URL,
    targetCategories: TARGETS,
    referenceDate: REFERENCE
  });
  assert.equal(result.jobs.length, 1, 'обёртка не должна давать вторую карточку');
  assert.equal(result.jobs[0].id, '123457');
});

test('JSON-LD используется, когда DOM-карточек нет', () => {
  const result = parseListingHtml(fixture('listing-jsonld.html'), {
    sourceUrl: SOURCE_URL,
    targetCategories: TARGETS,
    referenceDate: REFERENCE
  });
  assert.equal(result.structure.strategy, 'json-ld');
  assert.equal(result.jobs.length, 2);
  const first = result.jobs[0];
  assert.equal(first.id, '660001');
  assert.equal(first.budget.min, 8000);
  assert.equal(first.client.name, 'ИП Пример');
  assert.equal(first.category.id, 'markup-by-layout');
});

test('CAPTCHA определяется как аномалия и не даёт заданий', () => {
  const html = fixture('page-captcha.html');
  const result = parseListingHtml(html, { sourceUrl: SOURCE_URL, targetCategories: TARGETS });
  assert.ok(result.anomalies.includes('captcha'));
  assert.equal(result.jobs.length, 0);
  assert.ok(result.warnings.some((warning) => /стратегия разбора не нашла карточек/.test(warning)));
});

test('упоминание captcha в скрипте — мягкий сигнал, а не остановка', () => {
  const html = fixture('listing-with-captcha-script.html');
  const result = parseListingHtml(html, { sourceUrl: SOURCE_URL, targetCategories: TARGETS, referenceDate: REFERENCE });

  assert.deepEqual(result.anomalies, [], 'жёстких признаков проверки нет');
  assert.ok(result.softAnomalies.length > 0, 'мягкие упоминания фиксируются');
  assert.ok(result.softAnomalies.some((entry) => entry.reason === 'captcha-in-script' || entry.reason === 'container-hidden'));
  assert.equal(result.jobs.length, 1, 'страница разбирается, карточка не теряется');
  assert.equal(result.jobs[0].id, '700001');
  assert.ok(result.anomalyMarkers.includes('captcha-mention'));
});

test('detectPageAnomaliesDetailed различает показанную проверку и упоминание', () => {
  const hard = detectPageAnomaliesDetailed('<html><head><title>Проверка безопасности</title></head><body></body></html>');
  assert.ok(hard.hard.some((entry) => entry.kind === 'bot-check'));
  assert.ok(hard.markers.includes('bot-check-title'));

  const soft = detectPageAnomaliesDetailed('<html><head><script src="https://www.google.com/recaptcha/api.js"></script></head><body><p>Задания</p></body></html>');
  assert.deepEqual(soft.hard, [], 'подключённый скрипт не является проверкой');
  assert.ok(soft.soft.length > 0);

  const hidden = detectPageAnomaliesDetailed('<html><body><div class="captcha-container" style="display:none"></div></body></html>');
  assert.deepEqual(hidden.hard, [], 'скрытый служебный блок не является проверкой');
  assert.ok(hidden.soft.some((entry) => entry.reason === 'container-hidden'));

  const visibleInput = detectPageAnomaliesDetailed('<html><body><form><input type="text" name="captcha"></form></body></html>');
  assert.ok(visibleInput.hard.some((entry) => entry.reason === 'visible-captcha-input'));
});

test('диагностика аномалии не содержит HTML целиком', () => {
  const html = `${'x'.repeat(5000)}<html><head><title>Проверка безопасности</title></head><body>${'y'.repeat(5000)}</body></html>`;
  const diagnostics = describeAnomalyDiagnostics({ status: 200, url: SOURCE_URL, html });
  assert.equal(diagnostics.status, 200);
  assert.equal(diagnostics.bytes, html.length);
  assert.ok(diagnostics.markers.length > 0);
  assert.ok(diagnostics.excerpt.length <= 200, 'выдержка должна быть короткой');
  assert.ok(!diagnostics.excerpt.includes('yyyyyyyyyy'), 'HTML целиком попадать в диагностику не должен');
});

test('пустая страница не превращается в ошибку с выдуманными данными', () => {
  const result = parseListingHtml('<html><body><main></main></body></html>', {
    sourceUrl: SOURCE_URL,
    targetCategories: TARGETS
  });
  assert.equal(result.jobs.length, 0);
  assert.equal(result.structure.strategy, null);
  assert.ok(result.warnings.length > 0);
});

test('parseBudget: форматы и валюта', () => {
  assert.deepEqual(
    { min: parseBudget('5 000 ₽').min, max: parseBudget('5 000 ₽').max, currency: parseBudget('5 000 ₽').currency },
    { min: 5000, max: 5000, currency: 'RUB' }
  );
  assert.equal(parseBudget('от 2 000 до 4 000 ₽').isRange, true);
  assert.equal(parseBudget('от 2 000 до 4 000 ₽').max, 4000);
  assert.equal(parseBudget('1000-2000 руб').min, 1000);
  assert.equal(parseBudget('1000-2000 руб').max, 2000);
  assert.equal(parseBudget('$50').currency, 'USD');
  assert.equal(parseBudget('от 3 000 ₽').isFrom, true);
  assert.equal(parseBudget('Бюджет не указан'), null);
  assert.equal(parseBudget(''), null);
  assert.equal(parseBudget(null), null);
});

test('parseRelativeDate: производные и неточные значения различаются', () => {
  const reference = new Date('2026-10-07T12:00:00Z');
  assert.equal(parseRelativeDate('8 минут назад', reference).iso, '2026-10-07T11:52:00.000Z');
  assert.equal(parseRelativeDate('8 минут назад', reference).origin, 'derived:relative');
  assert.equal(parseRelativeDate('сегодня', reference).iso, null);
  assert.equal(parseRelativeDate('вчера', reference).confidence, 'imprecise');
  assert.equal(parseRelativeDate('12.05.2026', reference).iso, '2026-05-12T00:00:00.000Z');
  assert.equal(parseRelativeDate('12 мая 2026', reference).iso, '2026-05-12T00:00:00.000Z');
  assert.equal(parseRelativeDate('12 мая', reference).confidence, 'year-unknown');
  assert.equal(parseRelativeDate(''), null);
});

test('extractJobId берёт только числовой идентификатор задания', () => {
  assert.equal(extractJobId('https://kwork.ru/projects/884213/slug'), '884213');
  assert.equal(extractJobId('https://kwork.ru/projects/884213'), '884213');
  assert.equal(extractJobId('https://kwork.ru/projects/abc/slug'), null);
  assert.equal(extractJobId('https://kwork.ru/user/12345'), null);
  assert.equal(extractJobId(null), null);
});

test('matchTargetCategory не угадывает категорию вне списка', () => {
  assert.equal(matchTargetCategory('верстка сайта', TARGETS).id, 'markup-by-layout');
  assert.equal(matchTargetCategory('нужен backend на python', TARGETS), null);
  const declared = matchTargetCategory('что-то', TARGETS, 'Вёрстка - Доработка и адаптация верстки');
  assert.equal(declared.id, 'markup-adaptation');
  assert.equal(declared.matchedBy, 'declared-label');
});

test('buildDedupKey: стабильный id приоритетнее составного ключа', () => {
  assert.equal(buildDedupKey({ id: '1', url: 'https://kwork.ru/projects/1/a', title: 'x' }).kind, 'stable-id');
  assert.equal(buildDedupKey({ id: null, url: 'https://kwork.ru/projects/1/a?x=1', title: 'x' }).kind, 'url');
  const composite = buildDedupKey({ id: null, url: null, title: 'Вёрстка', budgetText: '1000 ₽' });
  assert.equal(composite.kind, 'composite-fallback');
  assert.equal(
    composite.key,
    buildDedupKey({ id: null, url: null, title: 'Вёрстка', budgetText: '1000 ₽' }).key,
    'составной ключ должен быть детерминированным'
  );
});

test('извлечение карточки не падает на пустом узле', () => {
  const doc = parseHtml('<div class="want-card"></div>');
  const card = findAll(doc, (node) => node.attrs?.class === 'want-card')[0];
  const job = extractJobFromCard(card, { sourceUrl: SOURCE_URL, targetCategories: TARGETS, referenceDate: REFERENCE });
  assert.equal(job.id, null);
  assert.equal(job.title, null);
  assert.equal(job.budget, null);
  assert.ok(job.missingFields.includes('title'));
  assert.ok(job.warnings.some((warning) => /заголовок/.test(warning)));
});

test('служебные функции HTML работают предсказуемо', () => {
  assert.equal(decodeEntities('1&nbsp;500 &amp; 200 &laquo;тест&raquo;'), '1\u00a0500 & 200 «тест»');
  assert.equal(decodeEntities('&#1055;&#x440;'), 'Пр');
  const doc = parseHtml('<div><p>Привет <b>мир</b></p></div>');
  const paragraphs = findAll(doc, (node) => node.tag === 'p');
  assert.equal(textOf(paragraphs[0]), 'Привет мир');
  assert.ok(detectPageAnomaliesDetailed('<html><body>Access denied</body></html>').hard.some((entry) => entry.kind === 'access-denied'));
});
