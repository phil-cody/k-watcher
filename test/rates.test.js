import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  countContentSections,
  detectComponents,
  detectUrgency,
  estimateRate,
  buildRateLine,
  declensionDays
} from '../src/analysis/rate-estimator.js';
import { detectJobSignals, materialsContext, canClaimMaterialsViewed } from '../src/analysis/job-signals.js';
import { buildProposalDraft, findInternalKeys, pickStack } from '../src/analysis/proposal-draft.js';
import { analyzeJob } from '../src/analysis/analyzer.js';
import { createTexts } from '../src/texts/texts.js';
import { makeFixtureJob, makeFixtureProfile } from './helpers/text-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const texts = createTexts({ rootDir });
const profile = JSON.parse(readFileSync(resolve(rootDir, 'config', 'performer-profile.json'), 'utf8'));

test('countContentSections распознаёт список, явное число и одну секцию', () => {
  const numbered = ['1. Шапка', '2. Баннер', '3. Услуги', '4. Контакты'].join('\n');
  assert.equal(countContentSections(numbered), 4);

  assert.equal(countContentSections('Нужно сверстать 5 секций по макету'), 5);
  assert.equal(countContentSections('Сверстать 3 страницы по макету'), 3);
  assert.equal(countContentSections('Нужна вёрстка одной секции по макету Figma'), 1);
  assert.equal(countContentSections('Есть макет, нужно сверстать лендинг'), 1);
  assert.equal(countContentSections(''), 0);
  assert.equal(countContentSections('Нужно сделать сайт'), 0);

  // Список из двух пунктов не считаем структурой: слишком легко спутать с текстом.
  assert.equal(countContentSections('1. Сделать\n2. Проверить'), 0);
});

test('detectComponents находит элементы и не путает их между собой', () => {
  const text = 'Нужен калькулятор стоимости, слайдер «до/после», форма с маской телефона +7(999)999-99-99, FAQ-аккордеон, карта Яндекс, оптимизация WebP, Title и Description';
  const ids = detectComponents(text).map((item) => item.id);
  assert.ok(ids.includes('calculator'));
  assert.ok(ids.includes('beforeAfter'));
  assert.ok(ids.includes('forms'));
  assert.ok(ids.includes('mask'));
  assert.ok(ids.includes('accordion'));
  assert.ok(ids.includes('map'));
  assert.ok(ids.includes('images'));
  assert.ok(ids.includes('seo'));
  assert.equal(detectComponents('Просто сверстать секцию').length, 0);
});

test('detectUrgency ловит срочность', () => {
  assert.equal(detectUrgency('Нужно срочно, за 2 дня'), true);
  assert.equal(detectUrgency('Сделайте в течение недели спокойно'), false);
  assert.equal(detectUrgency(''), false);
});

test('оценка считается от ставки и часов профиля', () => {
  const job = makeFixtureJob({ description: 'Нужна вёрстка одной секции по макету Figma с адаптивом.' });
  const estimate = estimateRate(job, profile, { texts });

  assert.equal(estimate.known, true);
  assert.equal(estimate.price.rate, profile.pricing.hourly_rate);
  assert.equal(estimate.hours.sections, 1);
  // 2.5 ч на секцию, минимум 2 ч, диапазон 0.85–1.25
  assert.ok(estimate.hours.min >= 2);
  assert.ok(estimate.price.min >= 1400, `цена ниже ставки: ${estimate.price.min}`);
  assert.ok(estimate.price.max > estimate.price.min);
  assert.ok(estimate.assumptions.some((item) => /Ставка/.test(item)));
});

test('без ставки в профиле оценка не выдумывается', () => {
  const job = makeFixtureJob();
  const withoutRate = { ...profile, pricing: { ...profile.pricing, hourly_rate: undefined } };
  const estimate = estimateRate(job, withoutRate, { texts });
  assert.equal(estimate.known, false);
  assert.match(estimate.reason, /не задана ставка/);
  assert.equal(estimate.price, null);
});

test('если объём не виден, оценка помечается как минимальная', () => {
  const job = makeFixtureJob({ title: 'Нужно сделать сайт', description: 'Подробности в личных сообщениях.' });
  const line = buildRateLine(job, profile, { texts });
  assert.equal(line.known, true);
  assert.equal(line.minimumOnly, true);
  assert.match(line.text, /минимальному объёму/);
  const estimate = estimateRate(job, profile, { texts });
  assert.ok(estimate.assumptions.some((item) => /минимальному объёму/.test(item)));
});

test('срочность увеличивает оценку секций', () => {
  const description = 'Нужно сверстать 4 секции по макету. Очень срочно, нужно за 2 дня.';
  const normal = { ...profile, pricing: { ...profile.pricing, rate_card: { ...profile.pricing.rate_card } } };
  const estimate = estimateRate(makeFixtureJob({ description }), normal, { texts });
  assert.equal(estimate.urgency, true);
  assert.ok(estimate.assumptions.some((item) => /срочност/i.test(item)));
  // 4 секции × 2.5 ч × 1.5 = 15 ч — заметно больше базовых 10.
  assert.ok(estimate.hours.content >= 15, `часы при срочности: ${estimate.hours.content}`);
});

test('дефолтные часы применяются, если в профиле нет карточки ставок', () => {
  const minimal = {
    ...profile,
    pricing: { ...profile.pricing, rate_card: undefined }
  };
  const estimate = estimateRate(makeFixtureJob({ description: 'Сверстать 3 секции по макету' }), minimal, { texts });
  assert.equal(estimate.known, true);
  assert.equal(estimate.hours.sections, 3);
  assert.equal(estimate.price.rate, minimal.pricing.hourly_rate);
});

test('declensionDays склоняет слово «день»', () => {
  assert.equal(declensionDays(1), 'день');
  assert.equal(declensionDays(2), 'дня');
  assert.equal(declensionDays(4), 'дня');
  assert.equal(declensionDays(5), 'дней');
  assert.equal(declensionDays(11), 'дней');
  assert.equal(declensionDays(21), 'день');
  assert.equal(declensionDays(22), 'дня');
});

test('срок не выводится как «1–1 день»', () => {
  const job = makeFixtureJob({ description: 'Нужна вёрстка одной секции по макету Figma.' });
  const line = buildRateLine(job, profile, { texts });
  assert.doesNotMatch(line.text, /1–1/);
  assert.match(line.text, /Срок: 1 день/);
});

test('детектор материалов: ссылка по запросу не считается просмотренным макетом', () => {
  const byRequest = detectJobSignals(
    { title: '', description: 'Вёрстка по макету в фигме. Ссылку на макет вышлю по запросу в личных сообщениях' },
    null,
    { texts }
  );
  assert.equal(byRequest.hasLayoutLink, false);
  assert.equal(byRequest.layoutLinkOnlyByRequest, true);
  assert.equal(materialsContext(byRequest), 'byRequest');
  assert.equal(canClaimMaterialsViewed(byRequest), false);

  const withLink = detectJobSignals(
    { title: '', description: 'Ссылку на проект прилагаю. Доступ открыт. https://www.figma.com/design/ABC' },
    null,
    { texts }
  );
  assert.equal(withLink.hasLayoutLink, true);
  assert.equal(materialsContext(withLink), 'viewedLayout');
  assert.equal(canClaimMaterialsViewed(withLink), true);

  const reference = detectJobSignals(
    { title: '', description: 'Вот пример как должен выглядеть сайт: https://doit-log.ae/' },
    null,
    { texts }
  );
  assert.equal(reference.hasReference, true);
  assert.equal(materialsContext(reference), 'viewedReference');

  const attached = detectJobSignals({ title: '', description: 'Эскиз прикреплен к проекту. ФИНАЛЬНЫЙ.png' }, null, { texts });
  assert.equal(materialsContext(attached), 'attachmentsOnly');

  const nothing = detectJobSignals({ title: '', description: 'Нужно сделать сайт' }, null, { texts });
  assert.equal(materialsContext(nothing), 'unknown');
});

test('черновик не содержит внутренних имён и значений проекта', () => {
  const job = makeFixtureJob({
    description: 'Сверстать 2 страницы по макету Figma: шапка, формы, таблица, пагинация. https://www.figma.com/design/ABC'
  });
  const analysis = analyzeJob(job, profile, { texts });
  const draft = buildProposalDraft(job, { ...analysis, rate: estimateRate(job, profile, { texts }) }, profile, { texts });

  assert.deepEqual(findInternalKeys(draft.text), [], 'в тексте отклика не должно быть внутренних ключей');
  assert.deepEqual(draft.usedInternalKeys, []);
  // Человеческие данные при этом на месте.
  assert.match(draft.text, /Здравствуйте/);
  assert.match(draft.text, /Стек: HTML/);
  assert.match(draft.text, /Стоимость: \d/);
  assert.match(draft.text, /Черновик для ручной проверки/);
});

test('черновик не утверждает, что видел макет, если ссылки нет', () => {
  const job = makeFixtureJob({
    description: 'Требуется адаптивная вёрстка по макету в фигме. Ссылку на макет вышлю по запросу.'
  });
  const analysis = analyzeJob(job, profile, { texts });
  const draft = buildProposalDraft(job, { ...analysis, rate: estimateRate(job, profile, { texts }) }, profile, { texts });

  assert.doesNotMatch(draft.text, /Макет посмотрел/);
  assert.match(draft.text, /пришлите, пожалуйста, ссылку на макет/);
  assert.match(draft.text, /Есть ли готовый макет в Figma или PSD/);
});

test('черновик утверждает просмотр макета, если ссылка есть в задании', () => {
  const job = makeFixtureJob({
    description: 'Сверстать 2 страницы по макету Figma. Ссылку на проект прилагаю: https://www.figma.com/design/ABC'
  });
  const analysis = analyzeJob(job, profile, { texts });
  const draft = buildProposalDraft(job, { ...analysis, rate: estimateRate(job, profile, { texts }) }, profile, { texts });

  assert.match(draft.text, /Макет посмотрел/);
  assert.doesNotMatch(draft.text, /Есть ли готовый макет/);
});

test('черновик не повторяет «готов выполнить» дважды', () => {
  const job = makeFixtureJob({ description: 'Вёрстка по макету. Ссылку пришлю по запросу.' });
  const analysis = analyzeJob(job, profile, { texts });
  const draft = buildProposalDraft(job, { ...analysis, rate: estimateRate(job, profile, { texts }) }, profile, { texts });
  const matches = draft.text.match(/[Гг]отов выполнить/g) ?? [];
  assert.equal(matches.length, 1, `фраза «готов выполнить» встречается ${matches.length} раз`);
});

test('черновик проговаривает исключения, когда задача этого требует', () => {
  const backendJob = makeFixtureJob({
    description: 'Нужен backend на Node.js, API и вебхуки, плюс вёрстка интерфейса. Макет в Figma: https://www.figma.com/design/ABC'
  });
  const analysis = analyzeJob(backendJob, profile, { texts });
  const draft = buildProposalDraft(
    backendJob,
    { ...analysis, rate: estimateRate(backendJob, profile, { texts }) },
    profile,
    { texts }
  );
  assert.match(draft.text, /Без backend, API и серверной логики/);
  assert.deepEqual(findInternalKeys(draft.text), []);
});

test('pickStack берёт только подтверждённые навыки', () => {
  assert.equal(pickStack(profile), 'HTML, CSS, SCSS/SASS, JavaScript');
  const withoutJs = pickStack({ skills: ['HTML', 'CSS'] });
  assert.match(withoutJs, /HTML, CSS/);
  assert.match(withoutJs, /JavaScript/, 'JavaScript добавляется только как подтверждённая база профиля');
  assert.equal(pickStack({ skills: [] }), '');
});

test('все формулировки оценки и черновика берутся из texts.json', () => {
  const job = makeFixtureJob({ description: 'Сверстать 2 секции по макету Figma: https://www.figma.com/design/ABC' });
  const analysis = analyzeJob(job, profile, { texts });
  const draft = buildProposalDraft(job, { ...analysis, rate: estimateRate(job, profile, { texts }) }, profile, { texts });
  const line = buildRateLine(job, profile, { texts });

  // Подмена текста влияет на вывод — значит, формулировки действительно из файла.
  const custom = createTexts({
    rootDir,
    data: {
      ...texts.data,
      proposal: {
        ...texts.data.proposal,
        greetings: { professional_friendly: 'ДОБРЫЙ ДЕНЬ' },
        scopeHeading: 'СОСТАВ РАБОТ'
      },
      rates: { ...texts.data.rates, line: 'ЦЕНА: {price}, СРОК: {days}' }
    }
  });
  const customDraft = buildProposalDraft(
    job,
    { ...analysis, rate: estimateRate(job, profile, { texts: custom }) },
    profile,
    { texts: custom }
  );
  assert.match(customDraft.text, /ДОБРЫЙ ДЕНЬ/);
  assert.match(customDraft.text, /СОСТАВ РАБОТ/);
  assert.match(buildRateLine(job, profile, { texts: custom }).text, /^ЦЕНА: /);
  assert.match(line.text, /Стоимость:/);
});
