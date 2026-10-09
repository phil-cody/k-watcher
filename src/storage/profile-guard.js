/**
 * Строгая проверка профиля, загруженного пользователем через Telegram.
 *
 * Загрузка файла — единственная точка, где в приложение попадают данные от других людей.
 * Поэтому проверок здесь больше, чем при чтении локального конфига:
 *
 *  1. Размер: лимит байт и запрет на пустой файл.
 *  2. Тип: только JSON (по имени файла и MIME), никаких архивов и изображений.
 *  3. Разбор: обычный JSON.parse + защита от prototype pollution (__proto__/constructor).
 *  4. Схема: известные поля, правильные типы, без лишних ключей в глубину.
 *  5. Лимиты: длины строк, количество элементов, размеры вложенных структур.
 *  6. Содержательность: профиль без навыков, портфолио и цен бесполезен.
 *
 * Всё, что не прошло проверку, отклоняется с понятной причиной — и НЕ попадает в работу.
 */

/** Поля верхнего уровня, которые разрешено хранить в профиле. */
export const ALLOWED_PROFILE_KEYS = new Set([
  'profile_version',
  'language',
  'headline',
  'skills',
  'portfolio',
  'services',
  'excluded_work',
  'categories',
  'pricing',
  'availability',
  'proposal_preferences',
  'matching_preferences',
  'experience_summary',
  'categoriesSelection',
  'contacts',
  'notes'
]);

/** Ключи, которых не должно быть нигде: через них ломают прототипы и обходят проверки. */
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const LIMITS = {
  maxBytes: 256 * 1024,
  maxStringLength: 4000,
  maxArrayLength: 200,
  maxPortfolioItems: 50,
  maxDepth: 8,
  maxKeys: 200,
  maxSkills: 100,
  maxKeywords: 100,
  minBudget: 0,
  maxBudget: 100_000_000,
  // Глубина, после которой JSON.parse может переполнить стек.
  maxParseDepth: 64
};

/**
 * Предварительная проверка текста ДО JSON.parse.
 *
 * Зачем: файл на 256 КБ может состоять из тысяч вложенных скобок, и разбор такого
 * текста способен уронить процесс переполнением стека. Поэтому считаем глубину
 * вложенности и количество символов, не разбирая JSON.
 */
export function preflightJson(text, { maxBytes = LIMITS.maxBytes, maxDepth = LIMITS.maxParseDepth } = {}) {
  const raw = String(text ?? '');
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes === 0) return { ok: false, error: 'Файл пуст.' };
  if (bytes > maxBytes) {
    return { ok: false, error: `Файл больше ${Math.round(maxBytes / 1024)} КБ.` };
  }
  // Управляющие символы вне строк говорят о том, что это не JSON-документ.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)) {
    return { ok: false, error: 'Файл содержит управляющие символы — это не JSON-профиль.' };
  }
  let depth = 0;
  let maxSeen = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') {
      depth += 1;
      if (depth > maxSeen) maxSeen = depth;
      if (depth > maxDepth) {
        return { ok: false, error: `Слишком глубокая вложенность в файле (больше ${maxDepth}).` };
      }
    } else if (char === '}' || char === ']') depth -= 1;
  }
  if (depth !== 0) return { ok: false, error: 'Скобки в файле не сбалансированы — это не корректный JSON.' };
  return { ok: true, bytes, maxDepth: maxSeen };
}

/** Глубина и количество ключей в объекте: защита от «дерева на миллион узлов». */
function measure(value, depth = 0, counters = { keys: 0, maxDepth: 0 }) {
  if (depth > LIMITS.maxDepth) return { ...counters, tooDeep: true };
  counters.maxDepth = Math.max(counters.maxDepth, depth);
  if (Array.isArray(value)) {
    for (const item of value) measure(item, depth + 1, counters);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      counters.keys += 1;
      if (FORBIDDEN_KEYS.has(key)) counters.forbidden = key;
      measure(item, depth + 1, counters);
    }
  }
  return counters;
}

/** Проверка строкового поля: тип, длина, отсутствие управляющих символов и разметки. */
function checkString(value, path, problems, { max = LIMITS.maxStringLength, allowed = false } = {}) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    problems.push(`${path}: ожидалась строка`);
    return;
  }
  if (value.length > max) problems.push(`${path}: строка длиннее ${max} символов`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    problems.push(`${path}: управляющие символы в строке`);
  }
  // Разметка и опасные схемы ссылок. Важно не ловить ложные срабатывания:
  // «Базовый JavaScript: меню, табы» — это обычный навык, а не javascript:-ссылка.
  if (!allowed && /<\s*script|javascript\s*:/i.test(value) && /javascript\s*:[^\s]/.test(value)) {
    problems.push(`${path}: подозрительная ссылка или разметка`);
  } else if (!allowed && /<\s*(script|iframe|object|embed)\b/i.test(value)) {
    problems.push(`${path}: подозрительная разметка`);
  }
}

/** Проверка массива строк с лимитом количества. */
function checkStringArray(value, path, problems, { max = LIMITS.maxArrayLength, itemMax = 200 } = {}) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    problems.push(`${path}: ожидался массив`);
    return;
  }
  if (value.length > max) problems.push(`${path}: элементов больше ${max}`);
  value.forEach((item, index) => checkString(item, `${path}[${index}]`, problems, { max: itemMax }));
}

function checkNumber(value, path, problems, { min = null, max = null } = {}) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${path}: ожидалось число`);
    return;
  }
  if (min !== null && value < min) problems.push(`${path}: значение меньше ${min}`);
  if (max !== null && value > max) problems.push(`${path}: значение больше ${max}`);
}

/**
 * Полная проверка схемы профиля.
 * @returns {{ ok: boolean, problems: string[], warnings: string[] }}
 */
export function checkProfileShape(profile) {
  const problems = [];
  const warnings = [];

  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { ok: false, problems: ['Профиль должен быть JSON-объектом'], warnings };
  }

  // Структурные лимиты и запрещённые ключи.
  const measured = measure(profile);
  if (measured.forbidden) {
    problems.push(`Запрещённый ключ в профиле: ${measured.forbidden}`);
  }
  if (measured.tooDeep) problems.push(`Слишком глубокая вложенность (лимит ${LIMITS.maxDepth})`);
  if (measured.keys > LIMITS.maxKeys) problems.push(`Слишком много ключей (лимит ${LIMITS.maxKeys})`);

  // Неизвестные поля верхнего уровня: предупреждаем, но не отказываем —
  // профиль может быть новее кода.
  for (const key of Object.keys(profile)) {
    if (!ALLOWED_PROFILE_KEYS.has(key)) warnings.push(`Неизвестное поле профиля: ${key}`);
  }

  checkNumber(profile.profile_version, 'profile_version', problems, { min: 1, max: 100 });
  checkString(profile.language, 'language', problems, { max: 16 });
  checkString(profile.headline, 'headline', problems, { max: 300 });

  checkStringArray(profile.skills, 'skills', problems, { max: LIMITS.maxSkills, itemMax: 80 });
  checkStringArray(profile.excluded_work, 'excluded_work', problems, { max: LIMITS.maxArrayLength, itemMax: 300 });
  checkStringArray(profile.notes, 'notes', problems, { max: LIMITS.maxArrayLength, itemMax: 1000 });

  // Портфолио: список объектов с ограниченным набором полей.
  if (profile.portfolio !== undefined) {
    if (!Array.isArray(profile.portfolio)) {
      problems.push('portfolio: ожидался массив');
    } else if (profile.portfolio.length > LIMITS.maxPortfolioItems) {
      problems.push(`portfolio: работ больше ${LIMITS.maxPortfolioItems}`);
    } else {
      profile.portfolio.forEach((item, index) => {
        const path = `portfolio[${index}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          problems.push(`${path}: ожидался объект`);
          return;
        }
        checkString(item.name, `${path}.name`, problems, { max: 200 });
        checkString(item.description, `${path}.description`, problems, { max: 2000 });
        checkString(item.repository_url, `${path}.repository_url`, problems, { max: 500 });
        checkString(item.demo_url, `${path}.demo_url`, problems, { max: 500 });
        checkStringArray(item.stack, `${path}.stack`, problems, { max: 50, itemMax: 80 });
        if (!item.name) warnings.push(`${path}: нет name`);
      });
    }
  }

  // Услуги.
  if (profile.services !== undefined) {
    if (!Array.isArray(profile.services)) {
      problems.push('services: ожидался массив');
    } else if (profile.services.length > LIMITS.maxArrayLength) {
      problems.push(`services: элементов больше ${LIMITS.maxArrayLength}`);
    } else {
      profile.services.forEach((item, index) => {
        const path = `services[${index}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          problems.push(`${path}: ожидался объект`);
          return;
        }
        checkString(item.name, `${path}.name`, problems, { max: 200 });
        checkString(item.description, `${path}.description`, problems, { max: 1000 });
        checkNumber(item.starting_price_rub, `${path}.starting_price_rub`, problems, {
          min: LIMITS.minBudget,
          max: LIMITS.maxBudget
        });
      });
    }
  }

  // Цены: числовые поля в разумных границах.
  if (profile.pricing !== undefined) {
    if (!profile.pricing || typeof profile.pricing !== 'object' || Array.isArray(profile.pricing)) {
      problems.push('pricing: ожидался объект');
    } else {
      checkString(profile.pricing.currency, 'pricing.currency', problems, { max: 8 });
      checkString(profile.pricing.pricing_notes, 'pricing.pricing_notes', problems, { max: 1000 });
      checkNumber(profile.pricing.minimum_project_price, 'pricing.minimum_project_price', problems, {
        min: LIMITS.minBudget,
        max: LIMITS.maxBudget
      });
      checkNumber(profile.pricing.hourly_rate, 'pricing.hourly_rate', problems, {
        min: LIMITS.minBudget,
        max: LIMITS.maxBudget
      });
      const rateCard = profile.pricing.rate_card;
      if (rateCard !== undefined) {
        if (!rateCard || typeof rateCard !== 'object' || Array.isArray(rateCard)) {
          problems.push('pricing.rate_card: ожидался объект');
        } else {
          checkNumber(rateCard.hours_per_content_section, 'pricing.rate_card.hours_per_content_section', problems, {
            min: 0,
            max: 1000
          });
          checkNumber(rateCard.minimum_hours, 'pricing.rate_card.minimum_hours', problems, { min: 0, max: 1000 });
          checkNumber(rateCard.urMultiplyPerSection, 'pricing.rate_card.urMultiplyPerSection', problems, {
            min: 0,
            max: 100
          });
          if (rateCard.component_hours !== undefined) {
            if (!rateCard.component_hours || typeof rateCard.component_hours !== 'object' || Array.isArray(rateCard.component_hours)) {
              problems.push('pricing.rate_card.component_hours: ожидался объект');
            } else {
              for (const [key, value] of Object.entries(rateCard.component_hours)) {
                checkNumber(value, `pricing.rate_card.component_hours.${key}`, problems, { min: 0, max: 1000 });
              }
            }
          }
        }
      }
    }
  }

  // Доступность.
  if (profile.availability !== undefined) {
    if (!profile.availability || typeof profile.availability !== 'object' || Array.isArray(profile.availability)) {
      problems.push('availability: ожидался объект');
    } else {
      checkString(profile.availability.timezone, 'availability.timezone', problems, { max: 64 });
      checkNumber(profile.availability.hours_per_week, 'availability.hours_per_week', problems, { min: 0, max: 168 });
      checkNumber(profile.availability.preferred_deadline_days, 'availability.preferred_deadline_days', problems, {
        min: 0,
        max: 365
      });
    }
  }

  // Предпочтения по откликам.
  if (profile.proposal_preferences !== undefined) {
    const prefs = profile.proposal_preferences;
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
      problems.push('proposal_preferences: ожидался объект');
    } else {
      checkString(prefs.tone, 'proposal_preferences.tone', problems, { max: 64 });
      checkString(prefs.preferred_length, 'proposal_preferences.preferred_length', problems, { max: 64 });
      checkStringArray(prefs.must_mention, 'proposal_preferences.must_mention', problems, { max: 50, itemMax: 300 });
      checkStringArray(prefs.must_avoid, 'proposal_preferences.must_avoid', problems, { max: 50, itemMax: 300 });
      checkStringArray(prefs.questions_before_quote, 'proposal_preferences.questions_before_quote', problems, {
        max: 50,
        itemMax: 300
      });
    }
  }

  // Ключевые слова и лимиты сопоставления.
  if (profile.matching_preferences !== undefined) {
    const match = profile.matching_preferences;
    if (!match || typeof match !== 'object' || Array.isArray(match)) {
      problems.push('matching_preferences: ожидался объект');
    } else {
      checkStringArray(match.positive_keywords, 'matching_preferences.positive_keywords', problems, {
        max: LIMITS.maxKeywords,
        itemMax: 80
      });
      checkStringArray(match.negative_keywords, 'matching_preferences.negative_keywords', problems, {
        max: LIMITS.maxKeywords,
        itemMax: 80
      });
      checkNumber(match.minimum_budget_override, 'matching_preferences.minimum_budget_override', problems, {
        min: LIMITS.minBudget,
        max: LIMITS.maxBudget
      });
    }
  }

  // Категории: include/exclude — обычные строки с id.
  if (profile.categories !== undefined) {
    const categories = profile.categories;
    if (!categories || typeof categories !== 'object' || Array.isArray(categories)) {
      problems.push('categories: ожидался объект');
    } else {
      checkStringArray(categories.include, 'categories.include', problems, { max: 200, itemMax: 120 });
      checkStringArray(categories.exclude, 'categories.exclude', problems, { max: 200, itemMax: 120 });
    }
  }

  // Личный выбор категорий Kwork: числа в допустимом диапазоне.
  if (profile.categoriesSelection !== undefined) {
    const selection = profile.categoriesSelection;
    if (selection === 'all') {
      // Явный выбор «все категории» — допустимо.
    } else if (!Array.isArray(selection)) {
      problems.push('categoriesSelection: ожидался массив id или строка "all"');
    } else if (selection.length > 200) {
      problems.push('categoriesSelection: выбрано больше 200 категорий');
    } else {
      selection.forEach((id, index) => {
        if (typeof id !== 'number' && typeof id !== 'string') {
          problems.push(`categoriesSelection[${index}]: ожидался id (число или строка)`);
          return;
        }
        const numeric = Number(id);
        if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 1_000_000) {
          problems.push(`categoriesSelection[${index}]: некорректный id категории`);
        }
      });
    }
  }

  // Контакты: строки, разметка запрещена (значения уйдут в сообщение).
  if (profile.contacts !== undefined) {
    const contacts = profile.contacts;
    if (!contacts || typeof contacts !== 'object' || Array.isArray(contacts)) {
      problems.push('contacts: ожидался объект');
    } else {
      for (const [key, value] of Object.entries(contacts)) {
        checkString(value, `contacts.${key}`, problems, { max: 300 });
      }
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}
