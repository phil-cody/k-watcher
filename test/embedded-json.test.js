import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  extractEmbeddedWantsPayload,
  sliceBalanced,
  parseEmbeddedDate,
  buildEmbeddedBudget,
  jobFromWant,
  parseEmbeddedJobs,
  categoryLinkIdsOf
} from '../src/parser/embedded-json-parser.js';
import { parseListingHtml } from '../src/parser/job-parser.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(resolve(here, 'fixtures', name), 'utf8');
const SOURCE_URL = 'https://kwork.ru/projects';

function sampleItem(overrides = {}) {
  return {
    id: 111,
    status: 'active',
    category_id: '47',
    categoryLinksIdRu: 59,
    name: 'Вёрстка лендинга по макету Figma',
    description: 'Нужно сверстать лендинг по готовому макету с адаптивом.',
    priceLimit: '5000.00',
    possiblePriceLimit: 5000,
    isHigherPrice: false,
    max_days: '10',
    date_create: '2026-10-07 17:05:42',
    date_expire: '2026-10-10 17:05:42',
    timeLeft: '2 д. 23 ч.',
    views_dirty: '61',
    kwork_count: 1,
    getWantsActiveCount: '2',
    user: { USERID: 1, username: 'client_one' },
    wantUserGetProfileUrl: 'https://kwork.ru/user/client_one',
    ...overrides
  };
}

test('встроенный JSON со списком заданий извлекается из реальной структуры', () => {
  const payload = extractEmbeddedWantsPayload(fixture('listing-embedded-json.html'));
  assert.equal(payload.strategy, 'embedded-json:wants');
  assert.equal(payload.items.length, 4);
  assert.equal(payload.items[0].id, 3259320);
});

test('sliceBalanced корректно проходит вложенные объекты и строки с кавычками', () => {
  const text = 'xx{"a":[{"b":"}"}],"c":"\\"quote\\""}yy';
  const start = text.indexOf('{');
  assert.equal(sliceBalanced(text, start), '{"a":[{"b":"}"}],"c":"\\"quote\\""}');
  // Незакрытый фрагмент не даёт ложного результата.
  assert.equal(sliceBalanced('[{"a":1}', 0), null);
});

test('parseEmbeddedDate: московское время без зоны превращается в точный ISO', () => {
  const parsed = parseEmbeddedDate('2026-10-07 17:05:42', { timezone: 'Europe/Moscow' });
  assert.equal(parsed.iso, '2026-10-07T14:05:42.000Z');
  assert.equal(parsed.origin, 'fact:embedded-datetime');
  assert.equal(parsed.confidence, 'exact');
  assert.equal(parsed.timezone, 'Europe/Moscow');

  // Незнакомый формат: текст сохраняем, точное время не выдумываем.
  const unknown = parseEmbeddedDate('26 сентября, 01:26');
  assert.equal(unknown.iso, null);
  assert.equal(unknown.confidence, 'unknown');
  assert.equal(parseEmbeddedDate(null), null);
});

test('buildEmbeddedBudget различает фиксированную цену и «возможна цена выше»', () => {
  const fixed = buildEmbeddedBudget({ priceLimit: '5000.00', possiblePriceLimit: 5000, isHigherPrice: false });
  assert.equal(fixed.min, 5000);
  assert.equal(fixed.max, 5000);
  assert.equal(fixed.isFrom, false);
  assert.equal(fixed.text, '5000 ₽');

  const higher = buildEmbeddedBudget({ priceLimit: '30000.00', possiblePriceLimit: 90000, isHigherPrice: true });
  assert.equal(higher.min, 30000);
  assert.equal(higher.max, 90000);
  assert.equal(higher.isFrom, true);
  assert.match(higher.text, /возможна цена выше/);

  assert.equal(buildEmbeddedBudget({ priceLimit: null, possiblePriceLimit: null }), null);
  assert.equal(buildEmbeddedBudget({}), null);
});

test('отсутствующие поля остаются null и попадают в missingFields', () => {
  const job = jobFromWant(
    { id: 222, name: 'Задание без описания и бюджета', date_create: null },
    { sourceUrl: SOURCE_URL, targetCategories: [] }
  );
  assert.equal(job.id, '222');
  assert.equal(job.title, 'Задание без описания и бюджета');
  assert.equal(job.description, null);
  assert.equal(job.descriptionSource, 'absent-in-list');
  assert.equal(job.budget, null);
  assert.equal(job.publishedAt, null);
  assert.equal(job.client, null);
  assert.ok(job.missingFields.includes('description'));
  assert.ok(job.missingFields.includes('budget'));
  assert.ok(job.missingFields.includes('publishedAt'));
  assert.ok(job.missingFields.includes('clientName'));
});

test('ссылка собирается из id, но никаких запросов к странице задания не делается', () => {
  const job = jobFromWant(sampleItem(), { sourceUrl: SOURCE_URL, targetCategories: [] });
  assert.equal(job.url, 'https://kwork.ru/projects/111');
  assert.equal(job.provenance.rawHtmlStored, false);
  assert.equal(job.provenance.strategy, 'embedded-json:wants');
});

test('клиент и метаданные задания переносятся без домысливания', () => {
  const job = jobFromWant(sampleItem(), { sourceUrl: SOURCE_URL, targetCategories: [] });
  assert.equal(job.client.name, 'client_one');
  assert.equal(job.client.meta, 'https://kwork.ru/user/client_one');
  assert.equal(job.extra.kworkCount, 1);
  assert.equal(job.extra.views, 61);
  assert.equal(job.extra.timeLeft, '2 д. 23 ч.');
  assert.equal(job.extra.maxDays, 10);
  assert.equal(job.offersCount, 2);
});

test('разбор всей страницы использует встроенный JSON как основную стратегию', () => {
  const result = parseListingHtml(fixture('listing-embedded-json.html'), {
    sourceUrl: SOURCE_URL,
    targetCategories: [],
    referenceDate: new Date('2026-10-07T15:00:00Z')
  });
  assert.equal(result.jobs.length, 4);
  assert.equal(result.structure.strategy, 'embedded-json:wants');
  assert.match(result.structure.description, /Встроенный JSON/);

  const seo = result.jobs[0];
  assert.equal(seo.id, '3259320');
  assert.equal(seo.title, 'Поднять позиции сайта по SEO');
  assert.match(seo.description, /мафия минск/);
  assert.equal(seo.budget.min, 20000);
  assert.equal(seo.publishedAt.iso, '2026-09-25T22:26:34.000Z', '2026-09-26 01:26:34 МСК');
  assert.equal(seo.publishedAt.origin, 'fact:embedded-datetime');
  assert.equal(seo.kworkCategoryId, 37);
  assert.deepEqual(seo.categoryLinkIds, [37]);
});

test('задание без цены не получает выдуманный бюджет', () => {
  const result = parseListingHtml(fixture('listing-embedded-json.html'), {
    sourceUrl: SOURCE_URL,
    targetCategories: []
  });
  const noBudget = result.jobs.find((job) => job.id === '3264850');
  assert.ok(noBudget, 'задание должно присутствовать');
  assert.equal(noBudget.budget, null);
  assert.ok(noBudget.missingFields.includes('budget'));
  assert.equal(noBudget.category, null, 'категория не определяется, пока id не подтверждены');
});

test('числовые id категорий не используются без подтверждения', () => {
  const targets = [
    { id: 'markup-by-layout', label: 'Вёрстка - Верстка по макету', kworkCategoryId: null, matchHint: ['верстка по макету', 'figma'] }
  ];
  const job = jobFromWant(sampleItem(), { sourceUrl: SOURCE_URL, targetCategories: targets });
  // id не подтверждён: категория не присваивается даже при совпадении текста,
  // а сам id сохраняется — по нему пользователь настраивает отображение.
  assert.equal(job.category, null);
  assert.equal(job.kworkCategoryId, 47);
  assert.ok(job.missingFields.includes('declaredCategory'));

  // После подтверждения связи id -> категория сопоставление идёт по id.
  const confirmed = [{ ...targets[0], kworkCategoryId: 47 }];
  const mapped = jobFromWant(sampleItem(), { sourceUrl: SOURCE_URL, targetCategories: confirmed });
  assert.equal(mapped.category.id, 'markup-by-layout');
  assert.equal(mapped.category.matchedBy, 'kwork-category-id');
  assert.equal(mapped.category.confidence, 'high');
});

test('без совпадений по тексту и без подтверждённого id категория остаётся null', () => {
  const targets = [{ id: 'markup-by-layout', label: 'Вёрстка', kworkCategoryId: null, matchHint: ['figma'] }];
  const job = jobFromWant(
    sampleItem({ name: 'Доработка каталога', description: 'Нужно поправить список товаров.' }),
    { sourceUrl: SOURCE_URL, targetCategories: targets }
  );
  assert.equal(job.category, null);
  assert.ok(job.missingFields.includes('declaredCategory'));
});

test('сопоставление по categoryLinksIdRu работает, когда id подтверждён пользователем', () => {
  const targets = [{ id: 'markup-adaptation', label: 'Адаптация верстки', kworkCategoryId: null }];
  const job = jobFromWant(sampleItem({ categoryLinksIdRu: [38] }), {
    sourceUrl: SOURCE_URL,
    targetCategories: targets,
    categoryMapping: { 38: 'markup-adaptation' }
  });
  assert.equal(job.category.id, 'markup-adaptation');
  assert.equal(job.category.matchedBy, 'category-link-id:38');
});

test('categoryLinksIdRu нормализуется и как число, и как массив', () => {
  assert.deepEqual(categoryLinkIdsOf({ categoryLinksIdRu: 59 }), [59]);
  assert.deepEqual(categoryLinkIdsOf({ categoryLinksIdRu: [38, '37'] }), [38, 37]);
  assert.deepEqual(categoryLinkIdsOf({}), []);
  assert.deepEqual(categoryLinkIdsOf({ categoryLinksIdRu: 'нет' }), []);
});

test('разбор не фильтрует задания до анализа — все карточки проходят', () => {
  const html = fixture('listing-embedded-json.html');
  const all = parseEmbeddedJobs(html, { sourceUrl: SOURCE_URL, targetCategories: [] });
  assert.equal(all.jobs.length, 4);
  assert.equal(all.filteredOut, 0);
});

test('подтверждённый маппинг id Kwork отбирает только целевые категории', () => {
  const config = JSON.parse(readFileSync(resolve(here, '..', 'config', 'default.json'), 'utf8'));
  const targets = config.targetCategories;
  const mapping = config.categoryMapping.byCategoryId;

  const result = parseListingHtml(fixture('listing-embedded-json.html'), {
    sourceUrl: SOURCE_URL,
    targetCategories: targets,
    categoryMapping: mapping,
    referenceDate: new Date('2026-10-07T15:00:00Z')
  });

  // В fixture четыре задания. По данным сайта: 37 — «Создание сайта»,
  // 79 — «Верстка», 38 — «Доработка и настройка сайта».
  // Порядок в фикстуре: 37, 79, 38, 37.
  const byKworkId = result.jobs.map((job) => ({
    id: job.id,
    kworkCategoryId: job.kworkCategoryId,
    categoryId: job.category?.id ?? null,
    matchedBy: job.category?.matchedBy ?? null,
    source: job.category?.source ?? null
  }));

  assert.equal(result.jobs.length, 4);
  for (const job of byKworkId) {
    assert.equal(job.source, 'kwork-id', `задание ${job.id} должно определяться по числовому id`);
  }
  assert.equal(byKworkId[0].categoryId, 'site-creation-new');
  assert.equal(byKworkId[1].categoryId, 'markup-by-layout');
  assert.equal(byKworkId[2].categoryId, 'site-repair-editing');
  assert.equal(byKworkId[3].categoryId, 'site-creation-new');

  // Отбор по категориям: только задания с подтверждённым id.
  const inTargets = result.jobs.filter((job) => Boolean(job.category));
  assert.equal(inTargets.length, 4);
  assert.equal(result.jobs.filter((job) => job.kworkCategoryId === 68).length, 0);
});

test('несопоставленный id (вне профиля) не получает категорию', () => {
  const config = JSON.parse(readFileSync(resolve(here, '..', 'config', 'default.json'), 'utf8'));
  const job = jobFromWant(
    { id: 999, category_id: '68', name: '3Д модель для печати', description: 'Нужна модель для печати.' },
    { sourceUrl: SOURCE_URL, targetCategories: config.targetCategories, categoryMapping: config.categoryMapping.byCategoryId }
  );
  assert.equal(job.category, null, '3D-моделирование вне профиля: категория не подтверждается');
  assert.equal(job.kworkCategoryId, 68);
  assert.ok(job.missingFields.includes('declaredCategory'));
});

test('текстовая подсказка не затягивает в целевую категорию чужой kwork-id', () => {
  const config = JSON.parse(readFileSync(resolve(here, '..', 'config', 'default.json'), 'utf8'));
  // «Дизайн шаблона в Figma» содержит слово Figma, но category_id=24 — вне профиля,
  // поэтому ни в «Вёрстку», ни в другие целевые категории такое задание не попадает.
  const job = jobFromWant(
    {
      id: 4242,
      category_id: '24',
      name: 'Дизайн шаблона в Figma для свадебного приглашения',
      description: 'Нужен шаблон приглашения, макет уже есть.',
      date_create: '2026-10-07 10:00:00'
    },
    { sourceUrl: SOURCE_URL, targetCategories: config.targetCategories, categoryMapping: config.categoryMapping.byCategoryId }
  );
  assert.equal(job.category, null, 'подсказка по тексту не должна перебивать числовой id');
  assert.equal(job.kworkCategoryId, 24);

  // Без числового id (например, DOM-разметка) текстовая подсказка продолжает работать.
  const withoutId = jobFromWant(
    { id: 4243, name: 'Вёрстка лендинга по макету Figma', description: 'Макет готов.' },
    { sourceUrl: SOURCE_URL, targetCategories: config.targetCategories }
  );
  assert.equal(withoutId.category?.matchedBy, 'text-hint');
});

test('текстовые подсказки не перебивают подтверждённый числовой id', () => {
  const targets = [
    { id: 'site-creation-new', label: 'Создание сайта', kworkCategoryId: 79, matchHint: [] },
    { id: 'markup-adaptation', label: 'Адаптация верстки', kworkCategoryId: null, matchHint: ['адаптив'] }
  ];
  const job = jobFromWant(
    { id: 1, category_id: '79', name: 'Адаптивная вёрстка каталога', description: 'Нужен адаптив.' },
    { sourceUrl: SOURCE_URL, targetCategories: targets, categoryMapping: { 79: 'site-creation-new' } }
  );
  assert.equal(job.category.id, 'site-creation-new');
  assert.equal(job.category.matchedBy, 'kwork-category-id');
  assert.equal(job.category.source, 'kwork-id');
});

test('испорченный JSON не превращается в выдуманные задания', () => {
  const broken = '<html><body><script>window.x = {"wants":[{"id":1,"name":"a"</script></body></html>';
  const result = parseListingHtml(broken, { sourceUrl: SOURCE_URL, targetCategories: [] });
  assert.equal(result.jobs.length, 0);
  assert.ok(result.warnings.some((warning) => /не нашла карточек|не найден/.test(warning)));

  const empty = parseEmbeddedJobs('<html></html>', { sourceUrl: SOURCE_URL });
  assert.equal(empty.jobs.length, 0);
  assert.equal(empty.strategy, null);
});
