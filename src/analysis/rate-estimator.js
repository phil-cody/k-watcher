/**
 * Оценка стоимости и срока по ставке из профиля.
 *
 * Принципы:
 *  - ставка, часы на секцию и часы за отдельные элементы берутся из профиля
 *    (`pricing.hourly_rate`, `pricing.rate_card`), а не из кода;
 *  - оценка всегда диапазон + список допущений: точную цену называем только
 *    после просмотра макета;
 *  - ничего не выдумываем: если в тексте задания нет признаков работ, честно
 *    говорим, что объём не определён, и просим материалы.
 *
 * Слова для этих сообщений живут в config/texts.json (раздел rates.*).
 */

import { createTexts } from '../texts/texts.js';

let defaultTexts = null;
function textsOf(texts) {
  if (texts) return texts;
  if (!defaultTexts) defaultTexts = createTexts({ rootDir: process.cwd() });
  return defaultTexts;
}

const DEFAULTS = {
  hourlyRate: 700,
  hoursPerContentSection: 2.5,
  minimumHours: 2,
  componentHours: {
    calculator: 4,
    sliders: 3,
    beforeAfter: 3,
    forms: 1.5,
    mask: 0.5,
    tabs: 1.5,
    accordion: 1,
    modal: 1.5,
    gallery: 2,
    map: 1,
    animations: 2,
    seo: 1.5,
    stack: 0,
    customDesign: 4,
    texts: 3,
    images: 1.5,
    pdf: 1,
    multipage: 0
  },
  urMultiplyPerSection: 1.5
};

/** Признаки работ в тексте задания. Порядок — приоритет для «главных» пунктов. */
const COMPONENT_PATTERNS = [
  { id: 'calculator', pattern: /(калькулятор|расч[её]т\s+(цен|стоимост)|считает\s+цену|посчит\w*\s+стоимост)/i },
  { id: 'beforeAfter', pattern: /(до\s*\/\s*после|до-после|слайдер\s+«?до)/i },
  { id: 'sliders', pattern: /(слайдер|карусел|carousel|swiper)/i },
  { id: 'forms', pattern: /(форм[аыуе]\s|форма\s|форм[аыу]\b|checkbox|чекбокс|согласи)/i },
  { id: 'mask', pattern: /(маск[аи]\s+телефон|\+7\s*\(\d|маска\s+ввода)/i },
  { id: 'modal', pattern: /(поп-?ап|модальн|modal)/i },
  { id: 'tabs', pattern: /(таб[ыов]\b|вкладк)/i },
  { id: 'accordion', pattern: /(аккордеон|accordion|faq)/i },
  { id: 'gallery', pattern: /(галере|портфолио|кейс[ыа]?\b)/i },
  { id: 'map', pattern: /(яндекс\s*карт|карт[аы]\s+яндекс|google\s*map|карта\s+на\s+сайте)/i },
  { id: 'animations', pattern: /(анимац|плавн\w*\s+(движен|появлен)|scroll\s*animation|параллакс)/i },
  { id: 'seo', pattern: /(seo\b|title\b|description\b|мета-?тег|семантик|оптимизац\w*\s+(картинок|изображен|сайта))/i },
  { id: 'customDesign', pattern: /(дизайн\s+(сайта|лендинг|разработ)|создать\s+дизайн|индивидуальн\w*\s+дизайн|дизайн\s+под\s+ключ|эскиз)/i },
  { id: 'texts', pattern: /(написать\s+текст|тексты\s+(для|сайта)|копирайт|контент\s+наполнен)/i },
  { id: 'images', pattern: /(webp|avif|оптимизац\w*\s+изображен|сжат\w*\s+картинок|подготов\w*\s+фото)/i },
  { id: 'pdf', pattern: /(pdf|смет[аы]|прайс-?лист)/i },
  { id: 'multipage', pattern: /(многостраничн|\d+\s+страниц|страниц[ыа]?:?\s*\d)/i },
  { id: 'stack', pattern: /(tilda|wordpress|вордпресс|битрикс|bitrix|конструктор|на\s+коде|чист\w*\s+код)/i }
];

/** Признаки срочности — влияют на срок и на оценку секций. */
const URGENT_PATTERN = /(срочно|как можно быстрее|в течение \d|за \d+ дн|asap|сегодня)/i;

/** Число объёмных секций контента в тексте задания. */
export function countContentSections(text) {
  const source = String(text ?? '');
  if (!source.trim()) return 0;

  // 1) Явное число: "5 секций", "4 блока", "3 страницы" — приоритетнее списка.
  const explicit = /(\d{1,2})\s*(секц|блок|экран|раздел)/i.exec(source);
  const explicitPages = /(\d{1,2})\s*(страниц|стр\.)/i.exec(source);
  const explicitCount = explicit ? Number(explicit[1]) : null;
  const explicitPagesCount = explicitPages ? Number(explicitPages[1]) : null;

  // 2) Пронумерованный список блоков: "0." / "1." / "2)" в начале строки.
  const numbered = source.match(/^[ \t]*\d{1,2}[.)]\s*\S/gm) ?? [];
  const bullets = source.match(/^[ \t]*[-•*]\s+\S/gm) ?? [];
  const listCount = numbered.length >= 3 ? numbered.length : bullets.length >= 3 ? bullets.length : 0;

  // Берём максимум из явных упоминаний и списка: заказчики перечисляют блоки по-разному.
  const candidates = [explicitCount, explicitPagesCount, listCount].filter((value) => Number.isFinite(value) && value > 0);
  if (candidates.length > 0) return Math.max(1, Math.min(Math.max(...candidates), 24));

  // 3) Единственная секция упомянута словами: «одной секции», «вёрстка секции», «секцию».
  if (/(секц|одну\s+страниц|одностраничн|лендинг|landing|одна\s+страница)/i.test(source)) return 1;

  // 4) Абзацы: считаем только достаточно длинные фрагменты (больше 80 символов).
  const paragraphs = source
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter((item) => item.length > 80);
  if (paragraphs.length > 0) return Math.min(paragraphs.length, 12);

  return 0;
}

/** Найденные в задании элементы работ. */
export function detectComponents(text, { componentHours = DEFAULTS.componentHours } = {}) {
  const source = String(text ?? '');
  const found = [];
  for (const { id, pattern } of COMPONENT_PATTERNS) {
    if (pattern.test(source)) found.push({ id, hours: Number(componentHours[id] ?? 0) });
  }
  return found;
}

/** Нужно ли скорректировать цену за срочность. */
export function detectUrgency(text) {
  return URGENT_PATTERN.test(String(text ?? ''));
}

/**
 * Расчёт оценки.
 * @returns {{
 *   known: boolean, reason: string|null,
 *   hours: {min:number,max:number,content:number,components:number,sections:number} | null,
 *   price: {min:number,max:number,rate:number} | null,
 *   days: {min:number,max:number} | null,
 *   urgency: boolean,
 *   components: Array<{id:string,label:string,hours:number}>,
 *   assumptions: string[],
 *   confidence: 'low'|'medium'
 * }}
 */
export function estimateRate(job, profile, { texts: textsInput = null, referenceDate = new Date() } = {}) {
  const texts = textsOf(textsInput);
  const t = (path, params) => texts.t(path, params);
  const rateCard = { ...DEFAULTS, ...(profile?.pricing?.rate_card ?? {}) };
  const componentHours = { ...DEFAULTS.componentHours, ...(rateCard.componentHours ?? {}) };
  const profileRate = profile?.pricing?.hourly_rate;
  const rate = Number.isFinite(Number(profileRate)) && Number(profileRate) > 0 ? Number(profileRate) : null;
  const text = [job?.title, job?.description].filter(Boolean).join('\n');
  const assumptions = [];

  const sections = countContentSections(text);
  const components = detectComponents(text, { componentHours });
  const urgency = detectUrgency(text);

  // Без ставки в профиле цифры не называем: не выдумываем деньги за пользователя.
  if (rate === null) {
    return {
      known: false,
      reason: t('rates.reasonNoRate'),
      hours: null,
      price: null,
      days: null,
      urgency,
      components: [],
      assumptions,
      confidence: 'low'
    };
  }

  if (!text.trim()) {
    return {
      known: false,
      reason: t('rates.reasonNoText'),
      hours: null,
      price: null,
      days: null,
      urgency,
      components: [],
      assumptions,
      confidence: 'low'
    };
  }

  // Если явных признаков объёма нет, всё равно даём оценку по минимуму: заказчику нужен
  // ориентир, а честность обеспечивается пометкой «по минимальному объёму».
  const minimumOnly = sections === 0 && components.length === 0;

  const perSection = Number(rateCard.hoursPerContentSection ?? DEFAULTS.hoursPerContentSection);
  const contentHours = sections * perSection * (urgency ? Number(rateCard.urMultiplyPerSection ?? 1) : 1);
  const componentTotal = components.reduce((sum, item) => sum + item.hours, 0);
  const rawHours = Math.max(Number(rateCard.minimumHours ?? DEFAULTS.minimumHours), contentHours + componentTotal);

  const minHours = Math.max(1, Math.round(rawHours * 0.85));
  const maxHours = Math.max(minHours + 1, Math.round(rawHours * 1.25));
  const priceMin = Math.round((minHours * rate) / 100) * 100;
  const priceMax = Math.round((maxHours * rate) / 100) * 100;

  // Срок: 6 рабочих часов в день, минимум 1 день.
  const daysMin = Math.max(1, Math.ceil(minHours / 6));
  const daysMax = Math.max(daysMin, Math.ceil(maxHours / 6));
  // Если разница меньше дня, не показываем бессмысленное «1–1».
  const daysIsRange = daysMax > daysMin;

  if (minimumOnly) {
    assumptions.push(t('rates.assumptionMinimumOnly'));
  } else if (sections > 0) {
    assumptions.push(t('rates.assumptionSections', { count: sections, hours: perSection }));
  }
  if (components.length > 0) {
    assumptions.push(
      t('rates.assumptionComponents', {
        list: components.map((item) => t(`rates.components.${item.id}`)).join(', ')
      })
    );
  }
  if (urgency) assumptions.push(t('rates.assumptionUrgency'));
  assumptions.push(t('rates.assumptionRate', { rate }));
  assumptions.push(t('rates.assumptionRefine'));

  return {
    known: true,
    reason: null,
    hours: { min: minHours, max: maxHours, content: Math.round(contentHours * 10) / 10, components: componentTotal, sections },
    price: { min: priceMin, max: priceMax, rate },
    days: { min: daysMin, max: daysMax, isRange: daysIsRange },
    urgency,
    minimumOnly,
    components: components.map((item) => ({ ...item, label: t(`rates.components.${item.id}`) })),
    assumptions,
    confidence: minimumOnly ? 'low' : components.length > 0 ? 'medium' : 'low'
  };
}

/**
 * Строка оценки для черновика: «Стоимость: 2 800–4 200 ₽. Срок: 2–3 дня.»
 * Возвращает null, если оценка невозможна (тогда черновик попросит материалы).
 */
export function buildRateLine(job, profile, { texts: textsInput = null } = {}) {
  const texts = textsOf(textsInput);
  const estimate = estimateRate(job, profile, { texts });
  if (!estimate.known) {
    return { known: false, reason: estimate.reason, text: null, estimate };
  }
  const price = `${estimate.price.min}–${estimate.price.max} ₽`;
  const days = estimate.days.isRange
    ? `${estimate.days.min}–${estimate.days.max} ${declensionDays(estimate.days.max)}`
    : `${estimate.days.min} ${declensionDays(estimate.days.min)}`;
  return {
    known: true,
    minimumOnly: estimate.minimumOnly,
    text: texts.t(estimate.minimumOnly ? 'rates.lineMinimumOnly' : 'rates.line', {
      price,
      days,
      hours: `${estimate.hours.min}–${estimate.hours.max}`,
      rate: estimate.price.rate
    }),
    price,
    days,
    estimate
  };
}

/** Склонение слова «день» для срока. */
export function declensionDays(count) {
  const value = Math.abs(Number(count) || 0) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return 'дней';
  if (last === 1) return 'день';
  if (last >= 2 && last <= 4) return 'дня';
  return 'дней';
}
