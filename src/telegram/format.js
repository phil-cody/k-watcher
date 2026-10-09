/**
 * Формирование Telegram-сообщения по заданию.
 *
 * Формат: HTML (parse_mode=HTML) — заголовки разделов выделены жирным, чтобы
 * длинный текст читался. Все подставляемые значения экранируются, иначе
 * символы < > & из описания задания сломают разметку Telegram.
 *
 * Все формулировки берутся из config/texts.json (см. src/texts/texts.js):
 * код отвечает за структуру и данные, тексты — за слова.
 *
 * Требования к содержанию сохранены: сообщение обязано явно разделять
 *  - ФАКТЫ из карточки задания,
 *  - ВЫВОДЫ (оценку и рекомендацию),
 *  - НЕИЗВЕСТНОЕ,
 * и содержать черновик отклика с пометкой «только для ручной проверки».
 */

import { createTexts } from '../texts/texts.js';

/** Лимит Telegram на одно сообщение. */
export const TELEGRAM_LIMIT = 4096;
/** Запас на служебные символы разметки при упаковке блоков. */
const PACK_LIMIT = TELEGRAM_LIMIT - 64;

/** Тексты по умолчанию: если объект не передан, читаем config/texts.json рядом с проектом. */
let defaultTexts = null;
function textsOf(texts) {
  if (texts) return texts;
  if (!defaultTexts) defaultTexts = createTexts({ rootDir: process.cwd() });
  return defaultTexts;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const bold = (value) => `<b>${escapeHtml(value)}</b>`;

/** Подпись «метка: значение» с жирной меткой. */
const label = (text, value) => `• ${bold(text)} ${value}`;

/** Дата для сообщения: текст из карточки, иначе локальное время из ISO. */
function formatPublishedAt(job, texts, timezone = 'Europe/Moscow') {
  const published = job.publishedAt;
  if (!published) return texts.t('telegram.valueMissing');
  const looksLikeIso = published.text && /^\d{4}-\d{2}-\d{2}T/.test(published.text);
  if (published.text && !looksLikeIso) return escapeHtml(published.text);
  if (published.iso) {
    const formatted = new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(published.iso));
    return `${formatted} (${escapeHtml(timezone)})`;
  }
  return escapeHtml(published.text ?? texts.t('telegram.valueMissing'));
}

/**
 * Разделы сообщения. Каждый — отдельный блок HTML; сборка упаковывает блоки
 * в сообщения, не разрезая теги.
 */
export function buildJobSections(job, analysis, { texts: textsInput = null } = {}) {
  const texts = textsOf(textsInput);
  const t = (path, params) => texts.t(path, params);
  const sections = [];
  const missing = t('telegram.valueMissing');

  const title = job.title ? escapeHtml(job.title) : t('telegram.texts.jobWithoutTitle');
  sections.push(
    [
      t('telegram.newJobHeader'),
      `<b>${title}</b>`,
      `${bold(t('telegram.recommendation'))}: ${escapeHtml(analysis.verdict)}` +
        (analysis.preliminary ? t('telegram.recommendationPreliminary') : '')
    ].join('\n')
  );

  const facts = [t('telegram.sections.facts')];
  facts.push(label(t('telegram.labels.title'), job.title ? escapeHtml(job.title) : missing));
  facts.push(label(t('telegram.labels.url'), job.url ? escapeHtml(job.url) : missing));
  facts.push(label(t('telegram.labels.budget'), job.budget?.text ? escapeHtml(job.budget.text) : missing));
  facts.push(
    label(
      t('telegram.labels.date'),
      `${formatPublishedAt(job, texts)}${job.publishedAt?.iso ? '' : t('telegram.dateUnknownSuffix')}`
    )
  );
  const declaredCategory =
    job.declaredCategory ?? (job.kworkCategoryId ? t('telegram.labels.categoryId', { id: job.kworkCategoryId }) : null);
  facts.push(label(t('telegram.labels.categoryKwork'), declaredCategory ? escapeHtml(declaredCategory) : missing));
  facts.push(label(t('telegram.labels.categoryBot'), job.category?.label ? escapeHtml(job.category.label) : missing));

  // Заказчик: показываем ровно те числа, которые есть в данных, и называем их точно.
  // «Предложений к заданию» — это extra.offersCount (сколько откликов уже подано),
  // «заказов у заказчика» — extra.kworkCount. Это разные числа, и подписи у них разные.
  if (job.client?.name) {
    const extras = [];
    if (job.extra?.offersCount !== undefined && job.extra?.offersCount !== null) {
      extras.push(escapeHtml(t('telegram.labels.clientOffers', { count: job.extra.offersCount })));
    }
    if (job.extra?.kworkCount !== undefined && job.extra?.kworkCount !== null) {
      extras.push(escapeHtml(t('telegram.labels.clientOrders', { count: job.extra.kworkCount })));
    }
    facts.push(label(t('telegram.labels.client'), `${escapeHtml(job.client.name)}${extras.join('')}`));
  }

  if (job.description) {
    facts.push(`• ${bold(t('telegram.labels.descriptionFromList'))}`);
    facts.push(escapeHtml(job.description));
  } else {
    facts.push(label(t('telegram.labels.description'), t('telegram.labels.descriptionAbsent')));
  }
  if (job.missingFields?.length > 0) {
    facts.push(label(t('telegram.labels.missingFields'), escapeHtml(job.missingFields.join(', '))));
  }
  sections.push(facts.join('\n'));

  const verdict = [
    `${t('telegram.sections.verdict')}: ${escapeHtml(analysis.verdict)}` +
      (analysis.preliminary ? t('telegram.sections.verdictPreliminaryNote') : '')
  ];
  for (const reason of analysis.inferences.positive) {
    verdict.push(`• ${t('telegram.labels.reasonPlus')}: ${escapeHtml(reason)}`);
  }
  for (const reason of analysis.inferences.negative) {
    verdict.push(`• ${t('telegram.labels.reasonMinus')}: ${escapeHtml(reason)}`);
  }
  if (analysis.inferences.modelSummary) {
    verdict.push(`• ${t('telegram.labels.reasonModel')}: ${escapeHtml(analysis.inferences.modelSummary)}`);
  }
  if (analysis.inferences.positive.length === 0 && analysis.inferences.negative.length === 0) {
    verdict.push(`• ${t('telegram.labels.noReasons')}`);
  }
  sections.push(verdict.join('\n'));

  const risks = [t('telegram.sections.risks')];
  if (analysis.risks.length === 0) {
    risks.push(`• ${t('telegram.labels.noRisks')}`);
  } else {
    for (const risk of analysis.risks) {
      const evidence = risk.evidence ? ` — ${t('telegram.labels.riskEvidence', { evidence: escapeHtml(risk.evidence) })}` : '';
      risks.push(`• <code>${escapeHtml(risk.code)}</code> ${escapeHtml(risk.message)}${evidence}`);
    }
  }
  risks.push('');
  risks.push(t('telegram.sections.unknown'));
  for (const item of analysis.unknown) risks.push(`• ${escapeHtml(item)}`);
  sections.push(risks.join('\n'));

  // Для «не подходит» не пишем цену, предварительные условия, вопросы и черновик:
  // отчёт — только факты, вывод и риски. «Нужно уточнить» показывает вопросы/условия,
  // но без черновика (он готовится только для «подходит»/«возможно»).
  const rejected = analysis.verdict === 'не подходит';

  if (!rejected) {
    const price = [t('telegram.sections.pricing')];
    price.push(label(t('telegram.labels.price'), escapeHtml(analysis.pricing.text)));
    price.push(label(t('telegram.labels.deadline'), escapeHtml(analysis.estimate.text)));
    for (const warning of analysis.pricing.warnings) {
      price.push(label(t('telegram.labels.priceSuspicious'), escapeHtml(warning)));
    }
    if (!analysis.pricing.known || !analysis.estimate.known) {
      price.push(`• ${t('telegram.labels.estimateIncomplete')}`);
    }
    sections.push(price.join('\n'));

    // Предварительные условия (составляются моделью; эвристика их не задаёт).
    if (Array.isArray(analysis.conditions) && analysis.conditions.length > 0) {
      const conditions = [t('telegram.sections.conditions')];
      for (const condition of analysis.conditions) conditions.push(`• ${escapeHtml(condition)}`);
      sections.push(conditions.join('\n'));
    }

    const questions = [t('telegram.sections.questions')];
    analysis.questions.forEach((question, index) => questions.push(`${index + 1}. ${escapeHtml(question)}`));
    sections.push(questions.join('\n'));
  }

  // Черновик есть только для «подходит»/«возможно»; иначе секцию не показываем.
  if (analysis.draft) {
    const draft = [t('telegram.sections.draft'), '', escapeHtml(analysis.draft.text)];
    if (analysis.draft.assumptions.length > 0) {
      draft.push('');
      draft.push(t('telegram.sections.draftAssumptions'));
      for (const assumption of analysis.draft.assumptions) draft.push(`— ${escapeHtml(assumption)}`);
    }
    sections.push(draft.join('\n'));
  }

  return sections;
}

/**
 * Сборка сообщений: блоки упаковываются в части так, чтобы не разрезать
 * HTML-теги и уложиться в лимит Telegram.
 */
export function renderJobMessages(job, analysis, options = {}) {
  return packSections(buildJobSections(job, analysis, options));
}

/**
 * Упаковка отдельных блоков текста в сообщения под лимит.
 * Длинный блок режется по строкам; если строка сама длиннее лимита — по символам.
 */
export function packSections(sections, { limit = PACK_LIMIT } = {}) {
  const messages = [];
  let current = '';

  const flush = () => {
    if (current) {
      messages.push(current);
      current = '';
    }
  };

  for (const section of sections) {
    for (const piece of splitLongSection(section, limit)) {
      const candidate = current ? `${current}\n\n${piece}` : piece;
      if (candidate.length > limit) {
        flush();
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  flush();
  return messages;
}

/** Разбиение слишком длинного блока на части по строкам с сохранением тегов. */
function splitLongSection(section, limit) {
  if (section.length <= limit) return [section];
  const parts = [];
  let current = '';
  for (const line of section.split('\n')) {
    if (line.length > limit) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      parts.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Текст без разметки — для dry-run, логов и тестов. */
export function renderJobMessage(job, analysis, options = {}) {
  return renderJobMessages(job, analysis, options)
    .join('\n\n')
    .replace(/<\/?b>/g, '')
    .replace(/<\/?code>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Совместимость: разбиение готового текста на части под лимит. */
export function splitMessage(text, limit = TELEGRAM_LIMIT) {
  return packSections([String(text)], { limit: limit - 64 });
}
