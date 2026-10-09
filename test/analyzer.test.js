import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { analyzeJob, assessBudget, assessProfile, containsPhraseForTest, findNegatedMentions } from '../src/analysis/analyzer.js';
import { buildProposalDraft } from '../src/analysis/proposal-draft.js';
import { renderJobMessage, renderJobMessages, splitMessage } from '../src/telegram/format.js';

const here = dirname(fileURLToPath(import.meta.url));
const realProfile = JSON.parse(readFileSync(resolve(here, '..', 'config', 'performer-profile.json'), 'utf8'));

const completeProfile = {
  ...realProfile,
  availability: {
    timezone: 'Asia/Ho_Chi_Minh',
    hours_per_week: 20,
    current_workload: 'низкая',
    earliest_start: '2026-10-08',
    preferred_deadline_days: 5
  }
};

function makeJob(overrides = {}) {
  return {
    id: '5001',
    url: 'https://kwork.ru/projects/5001/verstka-lendinga-po-maketu-figma',
    title: 'Вёрстка лендинга по макету Figma',
    description: 'Нужно сверстать одностраничный лендинг по готовому макету Figma с адаптивом.',
    budget: { min: 5000, max: 5000, currency: 'RUB', text: '5 000 ₽', isRange: false, isFrom: false },
    publishedAt: { text: '10 минут назад', iso: '2026-10-07T09:50:00.000Z', origin: 'derived:relative', confidence: 'derived' },
    category: { id: 'markup-by-layout', label: 'Вёрстка - Верстка по макету', matchedBy: 'text-hint', confidence: 'medium' },
    declaredCategory: 'Вёрстка',
    client: null,
    missingFields: ['clientName'],
    dedupKey: 'id:5001',
    dedupKind: 'stable-id',
    ...overrides
  };
}

test('подходящее задание: рекомендация «подходит» и конкретные обоснования', () => {
  const analysis = analyzeJob(makeJob(), completeProfile);
  assert.equal(analysis.verdict, 'подходит');
  assert.equal(analysis.preliminary, false);
  assert.ok(analysis.inferences.positive.length > 0);
  assert.ok(analysis.inferences.positive.some((line) => /Figma|адаптивная вёрстка/i.test(line)));
  assert.ok(analysis.facts.every((fact) => typeof fact.source === 'string' && fact.source.length > 0));
});

test('профиль с незаполненной доступностью даёт предварительную оценку', () => {
  const analysis = analyzeJob(makeJob(), realProfile);
  assert.equal(analysis.preliminary, true);
  assert.ok(analysis.profileCompleteness.missing.includes('availability.hours_per_week'));
  assert.ok(analysis.unknown.some((item) => /Доступность исполнителя не задана/.test(item)));
});

test('backend и интеграции переводят задание в «не подходит»', () => {
  const analysis = analyzeJob(
    makeJob({
      title: 'Разработка backend и личного кабинета под ключ',
      description: 'Нужен backend на Node.js, API, вебхуки, платёжная интеграция, база данных MySQL.'
    }),
    completeProfile
  );
  assert.equal(analysis.verdict, 'не подходит');
  assert.ok(analysis.risks.some((risk) => risk.code === 'excluded_work'));
  assert.ok(analysis.risks.some((risk) => risk.code === 'backend_requested'));
});

test('отрицание («Backend не требуется») не считается запросом backend', () => {
  const analysis = analyzeJob(
    makeJob({
      title: 'Доработка адаптации существующего сайта',
      description: 'Нужно поправить адаптивную вёрстку на разрешениях 768 и 375. Backend не требуется.'
    }),
    completeProfile
  );
  assert.notEqual(analysis.verdict, 'не подходит', 'отрицание не должно блокировать рекомендацию');
  assert.equal(analysis.risks.some((risk) => risk.code === 'backend_requested'), false);
  assert.equal(analysis.risks.some((risk) => risk.code === 'excluded_work'), false);
  assert.ok(analysis.risks.some((risk) => risk.code === 'explicitly_excluded'));
  assert.ok(analysis.unknown.some((item) => /явно исключает часть работ/.test(item)));
});

test('findNegatedMentions различает отрицание до и после упоминания', () => {
  assert.deepEqual(findNegatedMentions('Backend не требуется', ['backend']).map((entry) => entry.phrase), ['backend']);
  assert.deepEqual(findNegatedMentions('без backend и API', ['backend', 'api']).length, 2);
  assert.deepEqual(findNegatedMentions('Нужен backend на Node.js и API', ['backend', 'api']), []);
});

test('упоминание CMS не блокирует задание, а порождает уточняющий вопрос', () => {
  const analysis = analyzeJob(
    makeJob({
      title: 'Доработка вёрстки на WordPress',
      description: 'Нужно поправить адаптивную вёрстку и подключить плагин.'
    }),
    completeProfile
  );
  assert.ok(analysis.risks.some((risk) => risk.code === 'cms_mentioned'));
  assert.notEqual(analysis.verdict, 'не подходит', 'CMS-контекст сам по себе не повод отказываться');
  assert.ok(analysis.questions.some((question) => /CMS/.test(question)));
});

test('бюджет ниже минимальной цены профиля отмечается как заниженный', () => {
  const analysis = analyzeJob(
    makeJob({ budget: { min: 800, max: 800, currency: 'RUB', text: '800 ₽', isRange: false, isFrom: false } }),
    completeProfile
  );
  assert.equal(analysis.budget.undervalued, true);
  assert.ok(analysis.risks.some((risk) => risk.code === 'budget_below_minimum'));
  assert.ok(analysis.inferences.negative.some((line) => /ниже минимальной цены/.test(line)));
});

test('отсутствие бюджета не выдумывает цену и увеличивает неопределённость', () => {
  const analysis = analyzeJob(makeJob({ budget: null }), completeProfile);
  assert.ok(analysis.risks.some((risk) => risk.code === 'budget_absent'));
  assert.ok(analysis.unknown.some((item) => /Бюджет не указан/.test(item)));
  assert.equal(analysis.budget.undervalued, false);
});

test('assessBudget: чужая валюта не сравнивается с рублёвыми ценами', () => {
  const result = assessBudget(
    makeJob({ budget: { min: 50, max: 50, currency: 'USD', text: '$50', isRange: false, isFrom: false } }),
    completeProfile
  );
  assert.equal(result.undervalued, false);
  assert.ok(result.unknown.some((item) => /Валюта бюджета/.test(item)));
});

test('assessProfile сообщает о неполном профиле и не падает на пустом', () => {
  assert.equal(assessProfile(null).complete, false);
  assert.ok(assessProfile({}).missing.length > 0);
  assert.equal(assessProfile(completeProfile).complete, true);
});

test('нет описания и макета — это неизвестное, а не выдуманные детали', () => {
  const analysis = analyzeJob(
    makeJob({
      title: 'Доработка сайта',
      description: null,
      missingFields: ['description', 'clientName']
    }),
    completeProfile
  );
  assert.ok(analysis.unknown.some((item) => /Описание в карточке отсутствует/.test(item)));
  assert.ok(analysis.risks.some((risk) => risk.code === 'no_layout'));
  assert.ok(analysis.questions.some((question) => /макет/i.test(question)));
});

test('черновик отклика: без фиксированной цены, без лишних обещаний, всегда черновик', () => {
  const analysis = analyzeJob(makeJob(), completeProfile);
  const draft = buildProposalDraft(makeJob(), analysis, completeProfile);
  assert.equal(draft.isDraft, true);
  assert.equal(draft.sentToKwork, false);
  assert.equal(draft.manualReviewRequired, true);
  assert.match(draft.text, /Черновик для ручной проверки/);
  assert.match(draft.text, /не отправлен/i);
  assert.doesNotMatch(draft.text, /\b\d+\s*(дн|дней)\b.*точно/i, 'точный срок без основания не обещаем');
  assert.match(draft.text, /backend/i, 'исключения профиля должны проговариваться');
});

test('черновик ссылается только на подтверждённые работы из портфолио', () => {
  const job = makeJob({ title: 'Вёрстка каталога по макету', description: 'Каталог товаров по макету Figma.' });
  const analysis = analyzeJob(job, completeProfile);
  const draft = buildProposalDraft(job, analysis, completeProfile);
  const knownNames = completeProfile.portfolio.map((item) => item.name);
  for (const mentioned of draft.portfolioMentioned) {
    assert.ok(knownNames.includes(mentioned), `${mentioned} должен быть из портфолио профиля`);
  }
});

test('при отсутствии цены и ставки в профиле черновик не называет стоимость', () => {
  const withoutPricing = {
    ...completeProfile,
    pricing: { ...completeProfile.pricing, minimum_project_price: undefined, hourly_rate: undefined }
  };
  const job = makeJob();
  const analysis = analyzeJob(job, withoutPricing);
  const draft = buildProposalDraft(job, analysis, withoutPricing);

  assert.equal(analysis.pricing.known, false);
  // Стоимость не называется: в черновике нет чисел с рублями.
  assert.doesNotMatch(draft.text, /\d[\d\s]*₽/, 'нельзя называть цену без ставки в профиле');
  assert.equal(draft.rate.known, false);
  assert.ok(draft.assumptions.some((item) => /Цена не указана/.test(item)));
});

test('со ставкой в профиле черновик называет ориентир по цене и сроку', () => {
  const job = makeJob({ description: 'Нужна вёрстка одной секции по макету Figma с адаптивом.' });
  const analysis = analyzeJob(job, completeProfile);
  const draft = buildProposalDraft(job, analysis, completeProfile);

  assert.equal(draft.rate.known, true);
  assert.match(draft.text, /Стоимость: \d[\d\s]*–\d[\d\s]*₽/);
  assert.match(draft.text, /Срок: \d/);
  assert.ok(draft.rate.estimate.assumptions.length > 0, 'нужны допущения к оценке');
});

test('сообщение явно разделяет факты, выводы и неизвестное', () => {
  const job = makeJob();
  const analysis = analyzeJob(job, realProfile);
  analysis.draft = buildProposalDraft(job, analysis, realProfile);
  const message = renderJobMessage(job, analysis);
  assert.match(message, /Факты из карточки/);
  assert.match(message, /Вывод/);
  assert.match(message, /Неизвестно/);
  assert.match(message, /Риски/);
  assert.match(message, /Черновик отклика \(только для ручной проверки, на Kwork не отправлен\)/);
  assert.match(message, /страница задания не открывалась/);
  assert.match(message, /Рекомендация: подходит|Рекомендация: возможно|Рекомендация: не подходит/);
});

test('сообщение размечено HTML: заголовки разделов выделены жирным', () => {
  const job = makeJob();
  const analysis = analyzeJob(job, realProfile);
  analysis.draft = buildProposalDraft(job, analysis, realProfile);
  const messages = renderJobMessages(job, analysis);

  assert.ok(messages.length >= 1);
  for (const part of messages) {
    assert.ok(part.length <= 4096, `часть длиной ${part.length} превышает лимит Telegram`);
  }
  const all = messages.join('\n');
  assert.match(all, /<b>Новое задание Kwork<\/b>/);
  assert.match(all, /<b>Факты из карточки<\/b>/);
  assert.match(all, /<b>Вывод<\/b>/);
  assert.match(all, /<b>Риски<\/b>/);
  assert.match(all, /<b>Черновик отклика<\/b>/);
  assert.match(all, /<b>Заголовок<\/b>/);
  assert.match(all, /<b>Бюджет<\/b>/);
  // Разметка не должна «ломаться» незакрытыми тегами.
  const opens = (all.match(/<b>/g) ?? []).length;
  const closes = (all.match(/<\/b>/g) ?? []).length;
  assert.equal(opens, closes, 'у каждого <b> должен быть закрывающий тег');
});

test('опасные символы из задания экранируются и не ломают разметку', () => {
  const job = makeJob({
    title: 'Вёрстка <b>ломает</b> & разметку',
    description: 'Нужно <script>alert(1)</script> и 5 < 7 & 8 > 6'
  });
  const analysis = analyzeJob(job, realProfile);
  analysis.draft = buildProposalDraft(job, analysis, realProfile);
  const all = renderJobMessages(job, analysis).join('\n');

  assert.doesNotMatch(all, /<script>/, 'теги из задания должны быть экранированы');
  assert.match(all, /&lt;b&gt;ломает&lt;\/b&gt;/);
  assert.match(all, /&amp;/);
  assert.match(all, /5 &lt; 7/);
});

test('длинный черновик разбивается на несколько сообщений без потери текста', () => {
  const longDescription = 'Очень длинное описание задачи. '.repeat(300);
  const job = makeJob({ description: longDescription });
  const analysis = analyzeJob(job, realProfile);
  analysis.draft = buildProposalDraft(job, analysis, realProfile);
  const messages = renderJobMessages(job, analysis);

  assert.ok(messages.length > 1, 'сообщение должно быть разбито');
  for (const part of messages) assert.ok(part.length <= 4096);
  const joined = messages.join(' ');
  assert.match(joined, /Черновик отклика/, 'последняя часть с черновиком не должна потеряться');
});

test('splitMessage не теряет строки и уважает лимит', () => {
  const chunks = splitMessage('a'.repeat(2500) + '\n' + 'b'.repeat(2500), 4096);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(chunk.length <= 4096, `чанк длиной ${chunk.length} превышает лимит`);
  assert.ok(chunks.join('').includes('bbbb'));
});

test('containsPhrase не ловит подстроки внутри слов', () => {
  assert.equal(containsPhraseForTest('email рассылка', 'AI'), false);
  assert.equal(containsPhraseForTest('нужен AI-модуль', 'AI'), true);
  assert.equal(containsPhraseForTest('разработка SaaS сервиса', 'SaaS'), true);
});
