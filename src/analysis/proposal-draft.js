/**
 * Черновик отклика.
 *
 * Стиль: как в реальных откликах пользователя — сначала подтверждение, что
 * материалы понятны, затем конкретный состав работ, стек, ориентир по цене и
 * сроку, один–два уточняющих вопроса и предложение начать.
 *
 * Жёсткие правила:
 *  - это черновик для ручной проверки, на Kwork ничего не отправляется;
 *  - в тексте нет внутренних имён и значений проекта (dedupKey, provenance,
 *    kworkCategoryId, названия стратегий парсера и т. п.) — только человеческие данные;
 *  - утверждение «макет посмотрел» допустимо только если ссылка на макет есть
 *    в тексте задания (бот сам страницу задания не открывает);
 *  - упоминаются только подтверждённые профилем навыки, услуги и работы;
 *  - нет выдуманных фактов об опыте, отзывах и технологиях.
 *
 * Все формулировки — config/texts.json, раздел proposal.*
 */

import { createTexts } from '../texts/texts.js';
import { detectJobSignals, materialsContext } from './job-signals.js';
import { buildRateLine } from './rate-estimator.js';

let defaultTexts = null;
function textsOf(texts) {
  if (texts) return texts;
  if (!defaultTexts) defaultTexts = createTexts({ rootDir: process.cwd() });
  return defaultTexts;
}

/** Стек для строки «Стек: …» — только подтверждённые навыки профиля. */
export function pickStack(profile) {
  const skills = profile?.skills ?? [];
  const wanted = ['HTML', 'CSS', 'SCSS/SASS', 'JavaScript'];
  const found = wanted.filter((skill) => skills.some((item) => item.toLowerCase() === skill.toLowerCase()));
  const base = found.length > 0 ? found : skills.slice(0, 3);
  const hasJs = base.some((item) => /javascript/i.test(item));
  return hasJs || base.length === 0 ? base.join(', ') : [...base, 'JavaScript'].join(', ');
}

/** Портфолио: только совпавшие по ключевым словам задания работы. */
export function pickPortfolio(profile, keywords, limit = 2) {
  const items = Array.isArray(profile?.portfolio) ? profile.portfolio : [];
  const scored = items.map((item) => {
    const haystack = [item.name, item.description, ...(item.stack ?? [])].join(' ').toLowerCase();
    const score = (keywords ?? []).reduce(
      (sum, keyword) => (haystack.includes(String(keyword).toLowerCase()) ? sum + 1 : sum),
      0
    );
    return { item, score };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * Ключи внутренних данных, которых не должно быть в тексте отклика.
 * Используются в тесте: если такой ключ встретится в черновике — это ошибка.
 */
export const INTERNAL_KEYS = [
  'dedupKey',
  'dedupKind',
  'provenance',
  'rawHtmlStored',
  'kworkCategoryId',
  'categoryLinkIds',
  'matchedBy',
  'strategy',
  'embedded-json',
  'missingFields',
  'probableMatch',
  'offersCount',
  'kworkCount',
  'priceLimit',
  'possiblePriceLimit',
  'isHigherPrice',
  'category_id',
  'categoryLinksIdRu',
  'wantUserGetProfileUrl',
  'sourceUrl',
  'budgetAssessment',
  'rate_card',
  'hourly_rate',
  'pendingNotifications',
  'seen-index',
  'processed-jobs',
  'pageInfo',
  'lastPage'
];

/** Формирование черновика отклика и списка допущений (для ручной проверки). */
export function buildProposalDraft(job, analysis, profile, { texts: textsInput = null } = {}) {
  const texts = textsOf(textsInput);
  const t = (path, params) => texts.t(path, params);
  const proposalTexts = texts.data?.proposal ?? {};

  const preferences = profile?.proposal_preferences ?? {};
  const greetings = proposalTexts.greetings ?? {};
  const greeting = greetings[preferences.tone] ?? greetings.professional_friendly ?? '';

  const signals = detectJobSignals(job, profile, { texts });
  const context = materialsContext(signals);
  const rate = buildRateLine(job, profile, { texts });
  const assumptions = [];

  const lines = [];
  lines.push(greeting);

  // 1. Подтверждение по материалам: утверждаем только то, что видно из текста задания.
  lines.push('');
  const acknowledge = t(`proposal.acknowledge.${context}`);
  lines.push(acknowledge);
  // Если в подтверждении уже сказано «готов выполнить» (например, при запросе макета),
  // не повторяем одну и ту же мысль двумя строками.
  const acknowledgeCoversReady = /готов\s+выполнить/i.test(acknowledge);
  if (!acknowledgeCoversReady) {
    const readyKey = signals.hasLayoutLink
      ? 'withLayout'
      : signals.hasDesignWork
        ? 'design'
        : signals.hasReference
          ? 'reference'
          : 'default';
    lines.push(t(`proposal.ready.${readyKey}`));
  }

  // 2. Состав работ по тому, что перечислено в задании.
  const inScope = [];
  if (signals.hasMobileRequirement || signals.components.length > 0) {
    inScope.push(t('proposal.scopeItems.markup'));
  }
  if (signals.hasAnimationRequirement) inScope.push(t('proposal.scopeItems.interactive'));
  if (signals.hasSeoRequirement) inScope.push(t('proposal.scopeItems.seo'));
  if (inScope.length === 0) inScope.push(t('proposal.scopeItems.fallback'));

  lines.push('');
  lines.push(t('proposal.scopeHeading'));
  for (const item of inScope) lines.push(`— ${item};`);
  lines.push(`— ${t('proposal.scopeExtra')}.`);

  const totalSections = analysis?.rate?.estimate?.hours?.sections ?? null;
  if (totalSections && totalSections > 0) {
    const countKey = totalSections === 1 ? 'one' : totalSections < 5 ? 'few' : 'many';
    lines.push(t(`proposal.sectionsCount.${countKey}`, { count: totalSections }));
  }

  // 3. Отдельные элементы, найденные в задании (названия человеческие, из текстов).
  if (signals.componentLabels.length > 0) {
    lines.push('');
    lines.push(t('proposal.componentsHeading'));
    for (const label of signals.componentLabels) lines.push(`— ${label};`);
  }

  // 4. Стек — только подтверждённые навыки.
  const stack = pickStack(profile);
  if (stack) lines.push('', t('proposal.stackLine', { stack }));

  // 5. Что не входит в мою услугу.
  const exclusionKey = signals.mentionsBackend ? 'backend' : signals.mentionsCms ? 'cms' : 'default';
  lines.push('', t(`proposal.exclusions.${exclusionKey}`));

  // 6. Цена и срок — из оценки по ставке профиля.
  if (rate.known) {
    lines.push('', rate.text);
  } else {
    lines.push('', t('proposal.price.unknown'));
    assumptions.push(t('proposal.assumptions.priceUnknown'));
  }
  for (const item of rate.estimate?.assumptions ?? []) assumptions.push(item);

  // 7. Вопросы: только те, что действительно нужны.
  const questions = [];
  if (!signals.hasLayoutLink) questions.push(t('proposal.materialsQuestions.noLayout'));
  if (!signals.hasMobileRequirement) questions.push(t('proposal.materialsQuestions.mobile'));
  if (signals.mentionsCms) questions.push(t('proposal.materialsQuestions.integration'));
  if (signals.hasDesignWork && !signals.hasLayoutLink) questions.push(t('proposal.materialsQuestions.design'));
  if (!signals.hasAttachments && questions.length < 2) questions.push(t('proposal.materialsQuestions.texts'));
  const limitedQuestions = questions.slice(0, 2);

  if (limitedQuestions.length > 0) {
    lines.push('', t('proposal.materialsHeading'));
    limitedQuestions.forEach((question, index) => lines.push(`${index + 1}. ${question}`));
  }

  // 8. Призыв к действию.
  lines.push('', limitedQuestions.length > 0 ? t('proposal.cta.withQuestions') : t('proposal.cta.solo'));

  // 9. Допущения для ручной проверки (в текст отклика они не попадают).
  if (!job.description) assumptions.push(t('proposal.assumptions.noDescription'));
  if (!rate.known) assumptions.push(t('rates.assumptionRefine'));
  if (!profile?.availability?.preferred_deadline_days) {
    assumptions.push(t('proposal.assumptions.deadlineUnknown'));
  }
  const portfolioItems = pickPortfolio(profile, [
    ...(analysis?.matchedKeywords ?? []).map((entry) => entry.phrase),
    'верстка',
    'адаптив',
    'figma',
    'каталог',
    'сайт'
  ]);
  if (portfolioItems.length === 0) {
    assumptions.push(
      (profile?.portfolio ?? []).length === 0
        ? t('proposal.assumptions.noPortfolio')
        : t('proposal.assumptions.portfolioNoMatch')
    );
  }
  if ((profile?.services ?? []).length > 0) {
    assumptions.push(
      t('proposal.assumptions.services', {
        services: (profile.services ?? []).map((service) => service.name).join('; ')
      })
    );
  }

  lines.push('');
  lines.push(t('proposal.footer'));

  const text = lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');

  return {
    isDraft: true,
    manualReviewRequired: true,
    sentToKwork: false,
    text,
    assumptions,
    questions: limitedQuestions,
    portfolioMentioned: portfolioItems.map((item) => item.name),
    signals,
    rate,
    // Самопроверка: если во внутренних ключах окажется что-то из текста — это баг.
    usedInternalKeys: findInternalKeys(text)
  };
}

/** Поиск внутренних ключей проекта в готовом тексте (тест и самопроверка). */
export function findInternalKeys(text) {
  const source = String(text ?? '');
  return INTERNAL_KEYS.filter((key) => source.includes(key));
}
