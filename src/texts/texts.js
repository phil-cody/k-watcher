/**
 * Единая точка доступа к текстам интерфейса.
 *
 * Все формулировки (Telegram, логи, вывод CLI, подписи анализа, черновик отклика,
 * лог-сообщения) лежат в config/texts.json. Здесь — только загрузка, переопределение
 * локальным файлом и подстановка плейсхолдеров.
 *
 * Правила:
 *  - плейсхолдеры вида {name} обязаны сохраниться: их проверяет тест placeholder-контракта;
 *  - если ключ отсутствует, возвращается сам ключ — это заметно сразу, но не роняет бота;
 *  - локальный файл (TEXTS_FILE в .env) переопределяет значения поверх основного,
 *    поэтому можно менять формулировки, не затрагивая репозиторий.
 */

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { findPlaceholders } from './contract.js';

export { findPlaceholders };

/** Глубокое слияние: значения из override перекрывают base. */
export function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (typeof base !== 'object' || base === null || typeof override !== 'object' || override === null) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

/** Подстановка {name} без исключений: неизвестный плейсхолдер остаётся как есть. */
export function format(template, params = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined && params[name] !== null
      ? String(params[name])
      : match
  );
}

/** Значение по пути "commands.plan.title". Возвращает undefined, если пути нет. */
export function pick(object, path) {
  if (!path) return undefined;
  return String(path)
    .split('.')
    .reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), object);
}

export function loadTextsJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Не удалось прочитать файл текстов ${filePath}: ${error.message}`);
  }
}

/**
 * Создание объекта текстов.
 * @param {object} options
 * @param {string} options.rootDir корень проекта
 * @param {string} [options.baseFile] основной файл (по умолчанию config/texts.json)
 * @param {string} [options.overrideFile] локальный файл поверх основного
 * @param {object} [options.data] готовые данные (для тестов, вместо чтения файлов)
 */
export function createTexts({ rootDir = process.cwd(), baseFile = 'config/texts.json', overrideFile = null, data = null } = {}) {
  const resolvePath = (value) => (isAbsolute(value) ? value : resolve(rootDir, value));

  const basePath = resolvePath(baseFile);
  let base = data;
  if (!base) {
    base = loadTextsJson(basePath);
    if (!base) throw new Error(`Файл текстов не найден: ${basePath}`);
  }

  let merged = base;
  let usedOverride = null;
  if (overrideFile) {
    const overridePath = resolvePath(overrideFile);
    const override = loadTextsJson(overridePath);
    if (override) {
      merged = deepMerge(base, override);
      usedOverride = override;
    }
  }

  return {
    data: merged,
    basePath,
    overrideFile: usedOverride ? resolvePath(overrideFile) : null,

    /** Текст по пути ключа. */
    raw(path) {
      return pick(merged, path);
    },

    /** Текст по пути ключа с подстановкой параметров. */
    t(path, params = {}) {
      const value = pick(merged, path);
      if (value === undefined || value === null) return path;
      if (typeof value === 'object') {
        // Для структур (например, greetings) возвращаем как есть — вызывающий берёт нужное поле.
        return value;
      }
      return format(value, params);
    },

    /** Массив строк-шаблонов (для многострочных блоков). */
    lines(path, params = {}) {
      const value = pick(merged, path);
      if (!Array.isArray(value)) return [];
      return value.map((item) => format(item, params)).filter((item) => item !== '');
    },

    /** Выбор варианта из строки, массива вариантов или массива {text, when}. */
    choose(path, { params = {}, context = {} } = {}) {
      const value = pick(merged, path);
      if (value === undefined || value === null) return undefined;
      if (typeof value === 'string') return format(value, params);
      if (Array.isArray(value)) {
        const candidates = value.filter((item) => {
          if (typeof item === 'string') return true;
          if (item && typeof item === 'object') {
            if (!item.when) return true;
            return Object.entries(item.when).every(([key, expected]) => context[key] === expected);
          }
          return false;
        });
        if (candidates.length === 0) return undefined;
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        return format(typeof chosen === 'string' ? chosen : chosen.text, params);
      }
      return undefined;
    },

    /** Объект подстановок, где каждый лист — отформатированная строка. */
    parametrized(path, params = {}) {
      const value = pick(merged, path);
      if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
        return {};
      }
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = typeof item === 'string' ? format(item, params) : item;
      }
      return out;
    }
  };
}
