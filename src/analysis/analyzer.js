/**
 * Анализатор задания.
 *
 * Жёсткие правила:
 *  - ничего не выдумывать: если данных нет в задании или в профиле, это попадает
 *    в unknown или в вопросы заказчику, а не в утверждение;
 *  - каждый вывод сопровождается ссылкой на конкретный фрагмент задания и на
 *    конкретное поле профиля (evidence);
 *  - цена и срок предварительные и только на основании профиля; фиксированная
 *    цена до уточнения объёма не называется;
 *  - черновик отклика — всегда черновик для ручной проверки, на Kwork не отправляется.
 *
 * Модуль работает офлайн (эвристика) и не делает сетевых вызовов.
 */

import { createTexts } from '../texts/texts.js';

let defaultTexts = null;
/** Тексты по умолчанию: config/texts.json. Можно передать свой объект (тесты, другая локаль). */
function textsOf(texts) {
  if (texts) return texts;
  if (!defaultTexts) defaultTexts = createTexts({ rootDir: process.cwd() });
  return defaultTexts;
}

const VERDICT = {
  FITS: 'подходит',
  PARTIAL: 'возможно',
  UNFIT: 'не подходит',
  UNCLEAR: 'нужно уточнить'
};

const RISK = {
  BUDGET_BELOW_MINIMUM: 'budget_below_minimum',
  BUDGET_ABSENT: 'budget_absent',
  BUDGET_NOT_FIXED: 'budget_not_fixed',
  RATE_NOT_ESTIMATED: 'rate_not_estimated',
  DEADLINE_NOT_ESTIMATED: 'deadline_not_estimated',
  EXCLUDED_WORK: 'excluded_work',
  BACKEND_REQUESTED: 'backend_requested',
  VAGUE_SCOPE: 'vague_scope',
  URGENT: 'urgent',
  NO_LAYOUT: 'no_layout',
  MISSING_FIELDS: 'missing_fields',
  OUT_OF_CATEGORIES: 'out_of_target_categories',
  CMS_MENTIONED: 'cms_mentioned',
  COMPOSITE_KEY: 'dedup_composite_key'
};

/** Риски, которые действительно блокируют рекомендацию. */
const BLOCKING_RISKS = new Set([RISK.EXCLUDED_WORK, RISK.BACKEND_REQUESTED]);

const URGENT_PATTERN = /(срочно|вчера|как можно быстрее|asap|сегодня вечером|в течение часа)/i;
const LAYOUT_PATTERN = /(figma|psd|макет|mockup)/i;
const CMS_PATTERN = /(cms|wordpress|вордпресс|bitrix|битрикс|tilda|тильда|opencart|modx|1c[- ]?bitrix)/i;
const BACKEND_PATTERN = /(backend|бэкенд|серверн|api|вебхук|webhook|база данных|database|postgres|mysql|node\.?js сервер)/i;
const UNDEFINED_PATTERN = /(доработ|правк|настро|адаптац|исправ)/i;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Поиск фразы по границе слова; для фраз с дефисом допускается совпадение подстроки. */
export function containsPhraseForTest(haystack, phrase) {
  return containsPhrase(haystack, phrase);
}

function containsPhrase(haystack, phrase) {
  const text = String(haystack ?? '').toLowerCase();
  const needle = String(phrase ?? '').toLowerCase().trim();
  if (!needle) return false;
  if (/[^\p{L}\p{N}\s]/u.test(needle)) return text.includes(needle);
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}([^\\p{L}\\p{N}]|$)`, 'u');
  return pattern.test(text);
}

/** Короткая цитата фрагмента задания для обоснования. */
export function quoteFragment(text, phrase, maxLength = 120) {
  if (!text || !phrase) return null;
  const lower = String(text).toLowerCase();
  const index = lower.indexOf(String(phrase).toLowerCase());
  if (index === -1) return null;
  const start = Math.max(0, index - 40);
  const end = Math.min(String(text).length, index + String(phrase).length + 40);
  const fragment = String(text).slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + fragment + (end < String(text).length ? '…' : '');
}

const NEGATION_WORD = /(^|[\s(,;:])(не|без|нет|no)\s/i;
const NEGATION_AT_END = /(^|[\s(,;:])(не|без|нет|no)\s*[.!?…]?\s*$/i;

/**
 * Упоминание с отрицанием («Backend не требуется», «без интеграций», «no API»)
 * не означает, что работа запрошена. Отрицание ищется и перед упоминанием, и
 * сразу после него. Такие упоминания не считаются признаком и попадают в
 * пояснения, чтобы пользователь видел, что бот их учёл.
 */
export function findNegatedMentions(text, phrases = []) {
  const source = String(text ?? '');
  const negated = [];
  for (const phrase of phrases) {
    const needle = String(phrase ?? '').trim();
    if (!needle) continue;
    const pattern = new RegExp(escapeRegExp(needle), 'gi');
    let match;
    let found = false;
    while ((match = pattern.exec(source)) !== null) {
      const before = source.slice(Math.max(0, match.index - 40), match.index);
      const after = source.slice(match.index + match[0].length, match.index + match[0].length + 40);
      if (NEGATION_WORD.test(before) || NEGATION_WORD.test(after) || NEGATION_AT_END.test(after)) {
        negated.push({ phrase: needle, quote: quoteFragment(source, needle) });
        found = true;
      }
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      if (found) break;
    }
  }
  return negated;
}

function withoutNegated(matches, negated) {
  const negatedPhrases = new Set(negated.map((entry) => entry.phrase.toLowerCase()));
  return matches.filter((entry) => !negatedPhrases.has(entry.phrase.toLowerCase()));
}

function collectMatches(text, list, limit = 6) {
  const out = [];
  for (const phrase of list ?? []) {
    if (containsPhrase(text, phrase)) out.push({ phrase, quote: quoteFragment(text, phrase) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Оценка полноты профиля: без неё нельзя выдавать уверенную рекомендацию. */
export function assessProfile(profile) {
  const missing = [];
  if (!profile) return { complete: false, missing: ['профиль отсутствует'] };
  if (!Array.isArray(profile.skills) || profile.skills.length === 0) missing.push('skills');
  if (!Array.isArray(profile.portfolio) || profile.portfolio.length === 0) missing.push('portfolio');
  if (!Array.isArray(profile.categories?.include) || profile.categories.include.length === 0) missing.push('categories.include');
  if (typeof profile.pricing?.minimum_project_price !== 'number') missing.push('pricing.minimum_project_price');
  if (!profile.availability?.hours_per_week) missing.push('availability.hours_per_week');
  if (!profile.availability?.preferred_deadline_days) missing.push('availability.preferred_deadline_days');
  if (!profile.proposal_preferences?.tone) missing.push('proposal_preferences.tone');
  return { complete: missing.length === 0, missing };
}

/** Соответствие бюджету и признаки заниженной цены. */
export function assessBudget(job, profile, { minimumBudgetOverride = null, texts: textsInput = null } = {}) {
  const t = (path, params) => textsOf(textsInput).t(path, params);
  const minimum =
    typeof minimumBudgetOverride === 'number'
      ? minimumBudgetOverride
      : typeof profile?.pricing?.minimum_project_price === 'number'
        ? profile.pricing.minimum_project_price
        : null;
  const cheapestService = (profile?.services ?? [])
    .map((service) => service.starting_price_rub)
    .filter((value) => typeof value === 'number')
    .sort((a, b) => a - b)[0] ?? null;

  const budget = job.budget;
  const result = {
    minimum,
    cheapestService,
    budgetText: budget?.text ?? null,
    budgetMin: budget?.min ?? null,
    budgetMax: budget?.max ?? null,
    currency: budget?.currency ?? null,
    belowMinimum: false,
    undervalued: false,
    reasons: [],
    unknown: []
  };

  if (!budget) {
    result.unknown.push(t('analysis.budgetNotes.absent'));
    return result;
  }
  if (budget.currency && budget.currency !== 'RUB') {
    result.unknown.push(t('analysis.budgetNotes.foreignCurrency', { currency: budget.currency }));
    return result;
  }
  if (minimum === null) {
    result.unknown.push(t('analysis.budgetNotes.noMinimum'));
    return result;
  }
  if (typeof budget.max === 'number' && budget.max < minimum) {
    result.belowMinimum = true;
    result.undervalued = true;
    result.reasons.push(t('analysis.budgetNotes.belowMaximum', { max: budget.max, minimum }));
  } else if (typeof budget.min === 'number' && budget.min < minimum) {
    result.reasons.push(t('analysis.budgetNotes.belowMinimum', { min: budget.min, minimum }));
    if (!budget.isRange) {
      result.belowMinimum = true;
      result.undervalued = true;
    }
  }
  if (cheapestService !== null && typeof budget.max === 'number' && budget.max < cheapestService) {
    result.undervalued = true;
    const serviceName = (profile.services ?? []).find((s) => s.starting_price_rub === cheapestService)?.name ?? 'услуга';
    result.reasons.push(t('analysis.budgetNotes.belowService', { price: cheapestService, service: serviceName }));
  }
  if (budget.isFrom) {
    result.unknown.push(t('analysis.budgetNotes.fromPrice'));
  }
  return result;
}

/** Основной разбор задания. */
export function analyzeJob(job, profile, options = {}) {
  const texts = textsOf(options.texts);
  const t = (path, params) => texts.t(path, params);
  const text = [job.title, job.description, job.declaredCategory].filter(Boolean).join(' \n ');
  const profileAssessment = assessProfile(profile);

  const positiveSkills = collectMatches(text, profile?.matching_preferences?.positive_keywords ?? []);
  const negativeSkillsAll = collectMatches(text, profile?.matching_preferences?.negative_keywords ?? []);
  const excludedWork = collectMatches(text, profile?.excluded_work ?? [], 4);

  // Отрицания: «Backend не требуется» — это не запрос backend.
  const negatedMentions = findNegatedMentions(text, [
    ...(profile?.matching_preferences?.negative_keywords ?? []),
    'backend',
    'api',
    'cms'
  ]);
  const negativeSkills = withoutNegated(negativeSkillsAll, negatedMentions);
  const backendNegated = negatedMentions.some((entry) => /backend|api/i.test(entry.phrase));
  const cmsNegated = negatedMentions.some((entry) => /cms/i.test(entry.phrase));

  const risks = [];
  const pushRisk = (code, message, evidence = null) => risks.push({ code, message, evidence });

  const budgetAssessment = assessBudget(job, profile, {
    minimumBudgetOverride: profile?.matching_preferences?.minimum_budget_override ?? null,
    texts
  });

  if (budgetAssessment.undervalued) pushRisk(RISK.BUDGET_BELOW_MINIMUM, budgetAssessment.reasons.join(' '), budgetAssessment.budgetText);
  if (!job.budget) pushRisk(RISK.BUDGET_ABSENT, t('analysis.riskMessages.budget_absent'));
  if (job.budget && job.budget.currency && job.budget.currency !== 'RUB') {
    pushRisk(RISK.BUDGET_NOT_FIXED, t('analysis.riskMessages.budget_not_fixed', { currency: job.budget.currency }));
  }
  if (negativeSkills.length > 0) {
    pushRisk(
      RISK.EXCLUDED_WORK,
      t('analysis.riskMessages.excluded_work', { phrases: negativeSkills.map((entry) => entry.phrase).join(', ') }),
      negativeSkills[0].quote
    );
  }
  if (excludedWork.length > 0) {
    pushRisk(
      RISK.EXCLUDED_WORK,
      t('analysis.riskMessages.excluded_work_profile', { phrases: excludedWork.map((entry) => entry.phrase).join(', ') }),
      excludedWork[0].quote
    );
  }
  if (URGENT_PATTERN.test(text)) {
    pushRisk(RISK.URGENT, t('analysis.riskMessages.urgent'), quoteFragment(text, 'срочно') ?? null);
  }
  if (BACKEND_PATTERN.test(text) && !backendNegated) {
    pushRisk(
      RISK.BACKEND_REQUESTED,
      t('analysis.riskMessages.backend_requested'),
      quoteFragment(text, 'api') ?? quoteFragment(text, 'backend') ?? null
    );
  }
  if (CMS_PATTERN.test(text) && !cmsNegated) {
    // Само упоминание CMS не блокирует: важно, кто отвечает за интеграцию.
    pushRisk(RISK.CMS_MENTIONED, t('analysis.riskMessages.cms_mentioned'), quoteFragment(text, 'cms') ?? null);
  }
  for (const mention of negatedMentions) {
    pushRisk(
      'explicitly_excluded',
      t('analysis.riskMessages.explicitly_excluded', { phrase: mention.phrase }),
      mention.quote
    );
  }
  if (!LAYOUT_PATTERN.test(text)) {
    pushRisk(RISK.NO_LAYOUT, t('analysis.riskMessages.no_layout'));
  }
  if (UNDEFINED_PATTERN.test(text) && (!job.description || job.description.length < 200)) {
    pushRisk(RISK.VAGUE_SCOPE, t('analysis.riskMessages.vague_scope'));
  }
  if (job.dedupKind === 'composite-fallback') {
    pushRisk(RISK.COMPOSITE_KEY, t('analysis.riskMessages.dedup_composite_key'));
  }
  if (!job.category) {
    pushRisk(RISK.OUT_OF_CATEGORIES, t('analysis.riskMessages.out_of_target_categories'));
  }
  if (job.missingFields?.length > 0) {
    pushRisk(RISK.MISSING_FIELDS, t('analysis.riskMessages.missing_fields', { fields: job.missingFields.join(', ') }), null);
  }

  const unknown = [];
  unknown.push(t('analysis.unknown.descriptionFromListOnly'));
  if (!job.description) unknown.push(t('analysis.unknown.descriptionAbsent'));
  if (!job.publishedAt?.iso) {
    unknown.push(
      job.publishedAt?.text
        ? t('analysis.unknown.dateRelative', { text: job.publishedAt.text })
        : t('analysis.unknown.dateAbsent')
    );
  }
  if (!job.client) unknown.push(t('analysis.unknown.clientAbsent'));
  unknown.push(...budgetAssessment.unknown);
  if (!profile?.availability?.hours_per_week) unknown.push(t('analysis.unknown.availabilityUnknown'));
  if (!profile?.availability?.preferred_deadline_days) unknown.push(t('analysis.unknown.deadlineUnknown'));
  if (profileAssessment.missing.length > 0) {
    unknown.push(t('analysis.unknown.profileIncomplete', { fields: profileAssessment.missing.join(', ') }));
  }
  if (negatedMentions.length > 0) {
    unknown.push(
      t('analysis.unknown.explicitlyExcluded', { phrases: negatedMentions.map((entry) => entry.phrase).join(', ') })
    );
  }

  const facts = [];
  const cardSource = t('analysis.factsSource.card');
  facts.push({ field: 'title', value: job.title, source: cardSource });
  facts.push({ field: 'url', value: job.url, source: job.url ? t('analysis.factsSource.urlFromCard') : t('analysis.factsSource.absent') });
  facts.push({ field: 'budget', value: job.budget ? job.budget.text : null, source: job.budget ? cardSource : t('analysis.factsSource.absent') });
  facts.push({ field: 'publishedAt', value: job.publishedAt?.text ?? null, source: job.publishedAt?.origin ?? t('analysis.factsSource.absent') });
  facts.push({ field: 'category', value: job.category?.label ?? job.declaredCategory ?? null, source: job.category?.matchedBy ?? t('analysis.factsSource.unknown') });
  if (job.description) facts.push({ field: 'description', value: job.description, source: cardSource });

  const positiveReasons = [];
  if (positiveSkills.length > 0) {
    positiveReasons.push(
      `Совпали ключевые слова профиля: ${positiveSkills
        .map((entry) => `«${entry.phrase}»${entry.quote ? ` (в задании: ${entry.quote})` : ''}`)
        .join('; ')}.`
    );
  }
  if (job.category) {
    positiveReasons.push(`Задание попадает в выбранную категорию «${job.category.label}» (${job.category.matchedBy}).`);
  }
  if (job.budget && budgetAssessment.minimum !== null && !budgetAssessment.undervalued) {
    positiveReasons.push(`Бюджет не ниже минимальной цены профиля (${budgetAssessment.minimum} ₽).`);
  }

  let verdict = VERDICT.UNCLEAR;
  const blockingRisks = risks.filter((risk) => BLOCKING_RISKS.has(risk.code) || (risk.code === RISK.BUDGET_BELOW_MINIMUM && budgetAssessment.belowMinimum));
  if (blockingRisks.length > 0) {
    verdict = VERDICT.UNFIT;
  } else if (positiveSkills.length > 0 && job.category) {
    verdict = risks.length > 2 ? VERDICT.PARTIAL : VERDICT.FITS;
  } else if (positiveSkills.length > 0 || job.category) {
    verdict = VERDICT.PARTIAL;
  } else if (!job.title) {
    verdict = VERDICT.UNCLEAR;
  }

  const availability = profile?.availability ?? {};
  const deadlineKnown = Boolean(availability.preferred_deadline_days);
  const estimate = deadlineKnown
    ? {
        known: true,
        text: t('analysis.estimate.known', { days: availability.preferred_deadline_days }),
        basis: 'availability.preferred_deadline_days'
      }
    : {
        known: false,
        text: t('analysis.estimate.unknown'),
        basis: null
      };

  const pricing = {
    known: budgetAssessment.minimum !== null,
    minimum: budgetAssessment.minimum,
    text:
      budgetAssessment.minimum !== null
        ? t('analysis.pricing.known', { minimum: budgetAssessment.minimum })
        : t('analysis.pricing.unknown'),
    basis: budgetAssessment.minimum !== null ? 'pricing.minimum_project_price' : null,
    warnings: budgetAssessment.undervalued ? budgetAssessment.reasons : []
  };

  const questions = buildQuestions(job, text, profile, texts);
  const assumptions = [];
  assumptions.push(t('analysis.assumptions.scopeFromListOnly'));
  if (!job.description) assumptions.push(t('analysis.assumptions.descriptionAbsent'));
  if (job.publishedAt?.confidence === 'derived') assumptions.push(t('analysis.assumptions.dateDerived'));
  if (!profileAssessment.complete) assumptions.push(t('analysis.assumptions.profileIncomplete'));

  const verdictKey = Object.keys(VERDICT).find((key) => VERDICT[key] === verdict);
  const verdictLabel = texts.data?.analysis?.verdictLabels?.[verdict] ?? verdictKey ?? verdict;
  return {
    verdict,
    verdictLabel,
    preliminary: !profileAssessment.complete,
    profileCompleteness: { complete: profileAssessment.complete, missing: profileAssessment.missing },
    facts,
    inferences: {
      positive: positiveReasons,
      negative: risks.map((risk) => risk.message),
      summary: buildSummary(job, verdict, positiveSkills, risks, texts)
    },
    risks,
    unknown,
    questions,
    estimate,
    pricing,
    assumptions,
    matchedKeywords: positiveSkills,
    negativeKeywords: negativeSkills,
    excludedWork,
    budget: budgetAssessment,
    provider: 'heuristic'
  };
}

function buildSummary(job, verdict, positiveSkills, risks, texts) {
  const t = (path, params) => texts.t(path, params);
  const budget = job.budget ? t('analysis.summary.budgetKnown', { text: job.budget.text }) : t('analysis.summary.budgetUnknown');
  const parts = [
    job.title ? t('analysis.summary.titleKnown', { title: job.title, budget }) : t('analysis.summary.titleUnknown', { budget }),
    t('analysis.summary.recommendation', { conclusion: verdict })
  ];
  if (positiveSkills.length > 0) {
    parts.push(t('analysis.summary.positive', { phrases: positiveSkills.map((entry) => entry.phrase).join(', ') }));
  }
  if (risks.length > 0) {
    parts.push(t('analysis.summary.risks', { codes: risks.map((risk) => risk.code).join(', ') }));
  }
  return parts.join(' ');
}

/** Вопросы заказчику: сначала специфичные для задания, затем базовые из профиля. */
export function buildQuestions(job, text, profile, textsInput = null) {
  const t = (path) => textsOf(textsInput).t(path);
  const questions = [];
  if (!LAYOUT_PATTERN.test(text)) {
    questions.push(t('analysis.questions.noLayout'));
  } else {
    questions.push(t('analysis.questions.layout'));
  }
  if (job.category?.id === 'markup-by-layout' || /сверста/i.test(text)) {
    questions.push(t('analysis.questions.pages'));
  }
  if (job.category?.id === 'markup-adaptation' || UNDEFINED_PATTERN.test(text)) {
    questions.push(t('analysis.questions.edits'));
  }
  if (CMS_PATTERN.test(text)) {
    questions.push(t('analysis.questions.cmsOwner'));
  }
  if (BACKEND_PATTERN.test(text)) {
    questions.push(t('analysis.questions.backendScope'));
  }
  if (!job.budget) {
    questions.push(t('analysis.questions.budgetAbsent'));
  } else if (job.budget.isFrom || job.budget.isRange) {
    questions.push(t('analysis.questions.budgetRange'));
  }
  const base = profile?.proposal_preferences?.questions_before_quote ?? [];
  for (const question of base) {
    if (!questions.includes(question)) questions.push(question);
  }
  // Без повторов и без разрастания списка: приоритет у специфичных вопросов выше.
  return questions.slice(0, 6);
}
