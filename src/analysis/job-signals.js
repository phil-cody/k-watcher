/**
 * Определение того, что реально есть в тексте задания.
 *
 * Нужно для черновика отклика: бот не открывает страницы заданий и не может
 * посмотреть чужой макет или сайт. Поэтому утверждать «макет посмотрел» можно
 * только тогда, когда ссылка действительно есть в тексте карточки, а все
 * утверждения о составе работ берутся из перечисленных заказчиком элементов.
 *
 * Здесь только детекторы. Слова — в config/texts.json (раздел proposal.*).
 */

import { detectComponents } from './rate-estimator.js';

/**
 * Ссылки на макеты и проекты.
 *
 * Важно: фраза «макет в Figma» сама по себе не означает, что ссылку дали.
 * Утверждать «макет посмотрел» можно только если ссылка реально есть в тексте
 * (URL на Figma/Sketch/PSD) или сказано, что материалы приложены/доступ открыт.
 */
const LAYOUT_LINK = /(https?:\/\/[^\s)]*(figma\.com|sketch\.com|adobe\.com\/xd|zeplin|invisionapp)[^\s)]*)|(www\.(figma|sketch)\.com)|(ссылк[ау][^.]{0,60}(прилага|прикреп|доступ\s+открыт|по\s+ссылке|выше|ниже))|(макет[^.]{0,40}(прикреп|приложен|во\s+вложени|доступ\s+открыт))/i;
const LAYOUT_LINK_HINT_ONLY = /(ссылк[ау][^.]{0,60}(вышл|пришл|отправ|скину|по\s+запросу)|макет[^.]{0,40}(вышл|пришл|по\s+запросу))/i;
const REFERENCE_SITE = /(https?:\/\/[^\s)]+)|(пример|референс|ориентир)/i;
const ATTACHED_FILES = /(прикреп|приложен|вложен|\bfiles?\b|финальный\s*\d*\.png|\.png|\.jpg|\.pdf|\.zip|\.psd|\.fig)/i;
const DETAILED_SPEC = /(тз\b|техническое\s+задание|требования|структура|блоки|секции|пункт\s*\d)/i;
const CMS_MENTION = /(tilda|тильда|wordpress|вордпресс|bitrix|битрикс|opencart|modx|1c-?bitrix|cms)/i;
const BACKEND_MENTION = /(backend|бэкенд|api|вебхук|webhook|база\s+данных|mysql|postgres|серверн)/i;

/**
 * Сигналы задания.
 * @returns {{
 *   hasLayoutLink: boolean, layoutLinkOnlyByRequest: boolean,
 *   hasReference: boolean, hasAttachments: boolean, hasDetailedSpec: boolean,
 *   mentionsCms: boolean, mentionsBackend: boolean,
 *   components: string[], componentLabels: string[],
 *   hasMobileRequirement: boolean, hasAnimationRequirement: boolean,
 *   hasSeoRequirement: boolean, hasDesignWork: boolean
 * }}
 */
export function detectJobSignals(job, profile = null, { texts = null } = {}) {
  const text = [job?.title, job?.description].filter(Boolean).join('\n');
  const components = detectComponents(text).map((item) => item.id);
  const labelOf = (id) => {
    const value = texts?.t?.(`rates.components.${id}`);
    return value && value !== `rates.components.${id}` ? value : id;
  };

  return {
    hasLayoutLink: LAYOUT_LINK.test(text),
    layoutLinkOnlyByRequest: LAYOUT_LINK_HINT_ONLY.test(text) && !LAYOUT_LINK.test(text),
    hasReference: REFERENCE_SITE.test(text) && !LAYOUT_LINK.test(text),
    hasAttachments: ATTACHED_FILES.test(text),
    hasDetailedSpec: DETAILED_SPEC.test(text),
    mentionsCms: CMS_MENTION.test(text),
    mentionsBackend: BACKEND_MENTION.test(text),
    components,
    componentLabels: components.map(labelOf),
    hasMobileRequirement: /(мобильн|адаптив|adaptive|responsive|планшет|375|768)/i.test(text),
    hasAnimationRequirement: /(анимац|плавн|animation|scroll)/i.test(text),
    hasSeoRequirement: /(seo|title|description|мета|семантик)/i.test(text),
    hasDesignWork: /(дизайн|эскиз|создать\s+сайт|разработать\s+сайт|с нуля)/i.test(text),
    tone: profile?.proposal_preferences?.tone ?? 'professional_friendly'
  };
}

/** Есть ли у бота основания утверждать, что материалы видел. */
export function canClaimMaterialsViewed(signals) {
  return Boolean(signals?.hasLayoutLink || signals?.hasReference);
}

/**
 * Контекст для выбора формулировок из текстов:
 *  - viewed  — можно сказать «макет посмотрел»;
 *  - hasLink — ссылка есть, но утверждать осмотр нельзя по другим причинам;
 *  - noLink  — ссылки нет, надо попросить.
 */
export function materialsContext(signals) {
  if (signals.hasLayoutLink) return 'viewedLayout';
  if (signals.hasReference) return 'viewedReference';
  if (signals.hasAttachments) return 'attachmentsOnly';
  if (signals.layoutLinkOnlyByRequest) return 'byRequest';
  return 'unknown';
}
