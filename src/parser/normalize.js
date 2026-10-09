/**
 * Нормализация полей карточки задания.
 *
 * Правило проекта: если поле отсутствует в разметке — это null и запись в
 * missingFields. Никаких значений «по умолчанию», «примерно так» и догадок.
 * Отдельно фиксируется происхождение значения (origin): факт из разметки,
 * производное от факта или атрибут вроде data-*.
 */

import { decodeEntities, normalizeWhitespace } from '../util/html.js';
import { normalizeCategoryName } from '../storage/category-catalog.js';

const MONTHS = {
  янв: 0, фев: 1, мар: 2, апр: 3, мая: 4, май: 4, июн: 5, июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11
};

const TIME_UNITS_MS = {
  секунд: 1000,
  минут: 60 * 1000,
  час: 60 * 60 * 1000,
  день: 24 * 60 * 60 * 1000,
  недел: 7 * 24 * 60 * 60 * 1000,
  месяц: 30 * 24 * 60 * 60 * 1000
};

/** Очистка строки: декодирование сущностей, нормализация пробелов. */
export function cleanText(value) {
  if (value === null || value === undefined) return null;
  const text = normalizeWhitespace(decodeEntities(String(value)));
  return text === '' ? null : text;
}

/** Извлечение стабильного id задания из ссылки вида /projects/<id>/<slug>. */
export function extractJobId(url) {
  const match = /\/projects\/(\d+)(?:[/?#]|$)/.exec(String(url ?? ''));
  return match ? match[1] : null;
}

/**
 * Единый шаблон ссылки на задание.
 * Учитывает абсолютный путь (/projects/123/slug), относительный (projects/123/slug)
 * и нечисловой слаг (projects/unknown-id/slug) — идентификатор всё равно берётся
 * отдельно и только если он числовой.
 */
export const PROJECT_HREF_PATTERN = /(?:^|\/)projects\/[^/?#]+(?:[/?#]|$)/;

/** Является ли элемент ссылкой на задание. */
export function isProjectLink(node) {
  return node?.tag === 'a' && PROJECT_HREF_PATTERN.test(node.attrs?.href ?? '');
}

/**
 * Приведение ссылки к абсолютному виду.
 * Принимает только http(s); относительные ссылки считаются от базового URL.
 */
export function absolutizeUrl(href, baseUrl) {
  const raw = cleanText(href);
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Разбор строки бюджета. Возвращает { min, max, currency, text, isRange, isFrom }. */
export function parseBudget(input) {
  const text = cleanText(input);
  if (!text) return null;

  // Строка без цифр не является бюджетом: «Бюджет не указан», «Договорная» и т.п.
  if (!/\d/.test(text)) return null;

  const currency = /₽|руб/i.test(text) ? 'RUB' : /₴|грн/i.test(text) ? 'UAH' : /(\$|usd)/i.test(text) ? 'USD' : null;
  const normalized = text.replace(/\u00a0/g, ' ');

  // Диапазон: "5 000 - 10 000", "5000–10000", "от 5000 до 10000"
  const range = /(\d[\d\s.,]*)\s*(?:-|–|—|до)\s*(\d[\d\s.,]*)/i.exec(normalized);
  const toNumber = (value) => {
    const digits = String(value).replace(/[^\d]/g, '');
    if (!digits) return null;
    const parsed = Number.parseInt(digits, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  if (range) {
    const min = toNumber(range[1]);
    const max = toNumber(range[2]);
    if (min !== null && max !== null) {
      return {
        min: Math.min(min, max),
        max: Math.max(min, max),
        currency,
        text,
        isRange: true,
        isFrom: false
      };
    }
  }

  const single = /(\d[\d\s.,]*)/.exec(normalized);
  const value = single ? toNumber(single[1]) : null;
  if (value === null) {
    return { min: null, max: null, currency, text, isRange: false, isFrom: /от\s/i.test(normalized) };
  }
  const isFrom = /(от|до)\s/i.test(normalized) && /от\s/i.test(normalized);
  return { min: value, max: isFrom ? null : value, currency, text, isRange: false, isFrom };
}

/**
 * Разбор относительной даты публикации ("3 минуты назад", "сегодня", "вчера").
 * Точная дата не выдумывается: при наличии якорного времени возвращается
 * производное значение с пометкой origin=derived, иначе только текст.
 */
export function parseRelativeDate(input, referenceDate = new Date()) {
  const text = cleanText(input);
  if (!text) return null;

  const lower = text.toLowerCase();
  const reference = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);

  if (/^(только что|just now)$/.test(lower)) {
    return { text, iso: reference.toISOString(), origin: 'derived:relative', confidence: 'derived' };
  }
  if (/^сегодня/.test(lower)) {
    return { text, iso: null, origin: 'fact:relative', confidence: 'imprecise' };
  }
  if (/^вчера/.test(lower)) {
    return { text, iso: null, origin: 'fact:relative', confidence: 'imprecise' };
  }

  const relative = /(\d+)\s*(секунд|минут|час|день|недел|месяц)/i.exec(lower);
  if (relative) {
    const amount = Number.parseInt(relative[1], 10);
    const unitKey = Object.keys(TIME_UNITS_MS).find((key) => relative[2].startsWith(key));
    if (unitKey && Number.isFinite(amount)) {
      const iso = new Date(reference.getTime() - amount * TIME_UNITS_MS[unitKey]).toISOString();
      return { text, iso, origin: 'derived:relative', confidence: 'derived' };
    }
  }

  // Абсолютная дата: "12.05.2026" или "12 мая 2026"
  const numeric = /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/.exec(lower);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]) - 1;
    let year = Number(numeric[3]);
    if (year < 100) year += 2000;
    const date = new Date(Date.UTC(year, month, day));
    if (!Number.isNaN(date.getTime())) {
      return { text, iso: date.toISOString(), origin: 'derived:absolute', confidence: 'date-only' };
    }
  }
  const monthMatch = /(\d{1,2})\s+([а-яё]{3,})\.?\s*(\d{4})?/i.exec(lower);
  if (monthMatch) {
    const day = Number(monthMatch[1]);
    const key = Object.keys(MONTHS).find((month) => monthMatch[2].startsWith(month));
    if (key) {
      const year = monthMatch[3] ? Number(monthMatch[3]) : reference.getUTCFullYear();
      const date = new Date(Date.UTC(year, MONTHS[key], day));
      if (!Number.isNaN(date.getTime())) {
        return {
          text,
          iso: date.toISOString(),
          origin: monthMatch[3] ? 'derived:absolute' : 'derived:absolute:year-assumed',
          confidence: monthMatch[3] ? 'date-only' : 'year-unknown'
        };
      }
    }
  }

  return { text, iso: null, origin: 'fact:text', confidence: 'unknown' };
}

/**
 * Определение категории по подсказкам из конфигурации. Без совпадения — null.
 *
 * Названия сравниваются в нормализованном виде: регистр, ё→е, й→и, дефисы и пробелы.
 * Без этого «Вёрстка - Доработка и адаптация верстки» из карточки не совпадала с
 * подписью категории из-за одной буквы ё.
 */
export function matchTargetCategory(cardText, targetCategories = [], declaredCategory = null) {
  const declared = cleanText(declaredCategory);
  const haystack = cleanText(cardText)?.toLowerCase() ?? '';

  if (declared) {
    const declaredKey = normalizeCategoryName(declared);
    const exact = targetCategories.find((category) => normalizeCategoryName(category.label) === declaredKey);
    if (exact) return { id: exact.id, label: exact.label, matchedBy: 'declared-label', confidence: 'high' };
    const bySub = targetCategories.find((category) => {
      const section = normalizeCategoryName(category.subsection ?? '');
      return section && declaredKey.includes(section);
    });
    if (bySub) return { id: bySub.id, label: bySub.label, matchedBy: 'declared-substring', confidence: 'medium' };
  }

  const hints = [];
  for (const category of targetCategories) {
    for (const hint of category.matchHint ?? []) {
      if (haystack.includes(hint.toLowerCase())) hints.push({ category, hint });
    }
  }
  if (hints.length === 0) return null;
  // Сортировка: при равной длине подсказки выигрывает категория с меньшим priority
  // (более близкая профилю исполнителя). Значения priority задаются в конфигурации.
  hints.sort((a, b) => {
    if (b.hint.length !== a.hint.length) return b.hint.length - a.hint.length;
    return (a.category.priority ?? 100) - (b.category.priority ?? 100);
  });
  const best = hints[0];
  const sameCategoryHints = hints.filter((entry) => entry.category.id === best.category.id);
  return {
    id: best.category.id,
    label: best.category.label,
    matchedBy: 'text-hint',
    hint: best.hint,
    confidence: sameCategoryHints.length > 1 ? 'medium' : 'low'
  };
}

/** Сборка бюджета карточки из нескольких возможных источников. */
export function buildBudget({ fixedText, rangeText, fromText }) {
  const candidates = [
    { text: cleanText(fixedText), field: 'budget' },
    { text: cleanText(rangeText), field: 'priceRange' },
    { text: cleanText(fromText), field: 'priceFrom' }
  ].filter((candidate) => candidate.text);
  if (candidates.length === 0) return null;
  const primary = candidates[0];
  const parsed = parseBudget(primary.text);
  if (!parsed) return null;
  return { ...parsed, sourceField: primary.field, rawText: primary.text };
}

/** Публичная дата задания: сначала атрибут datetime, затем текст. */
export function buildPublishedAt({ datetimeAttr, text, referenceDate = new Date() }) {
  const raw = cleanText(datetimeAttr);
  const isoPattern = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
  if (raw) {
    // Явная ISO-строка из атрибута — факт. Иначе атрибут может содержать
    // относительную подпись, и её нужно разобрать тем же безопасным способом.
    if (isoPattern.test(raw)) {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) {
        return { text: cleanText(text) ?? raw, iso: parsed.toISOString(), origin: 'fact:datetime-attribute', confidence: 'exact' };
      }
    }
    return parseRelativeDate(raw, referenceDate);
  }
  const fromText = cleanText(text);
  // Текст может оказаться ISO-строкой (значение data-атрибута вместо подписи).
  if (fromText && isoPattern.test(fromText)) {
    const parsed = new Date(fromText);
    if (!Number.isNaN(parsed.getTime())) {
      return { text: fromText, iso: parsed.toISOString(), origin: 'fact:datetime-attribute', confidence: 'exact' };
    }
  }
  return parseRelativeDate(fromText, referenceDate);
}
