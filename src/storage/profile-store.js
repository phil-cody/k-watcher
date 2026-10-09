/**
 * Профили исполнителей: у каждого пользователя бота — свой.
 *
 * Зачем: профиль определяет вердикт, риски, цену, срок и черновик отклика. Один общий
 * профиль на всех не имеет смысла, если ботом пользуются разные люди.
 *
 * Раскладка файлов:
 *   data/profiles/<userId>.json     — профиль конкретного пользователя (загружен через /profile)
 *   config/performer-profile.json   — общий профиль из репозитория (запасной вариант)
 *
 * Приоритет для пользователя: личный профиль → общий (если задан PROFILE_FILE и файл есть)
 * → профиля нет (пользователь пропускается, ему приходит напоминание).
 *
 * Профиль всегда валидируется перед сохранением: битый файл не должен попадать в работу.
 */

import { readFile, writeFile, mkdir, readdir, unlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

import { validateProfile } from '../config/load-config.js';
import { checkProfileShape, preflightJson, LIMITS } from './profile-guard.js';

/** Максимальный размер принимаемого профиля: защита от случайной отправки большого файла. */
export const PROFILE_SIZE_LIMIT = LIMITS.maxBytes;

/** Допустимые расширения и MIME-типы для загружаемого профиля. */
export const ALLOWED_FILE_EXTENSIONS = ['.json', '.txt'];
export const ALLOWED_MIME_TYPES = ['application/json', 'text/json', 'text/plain', 'application/octet-stream'];

/**
 * Проверка типа файла. Telegram присылает имя и MIME; оба поля необязательны,
 * но если они есть — должны быть допустимыми.
 */
export function checkFileType({ fileName = null, mimeType = null } = {}) {
  if (fileName) {
    const lower = String(fileName).toLowerCase();
    if (!ALLOWED_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      return { ok: false, error: `Ожидался файл ${ALLOWED_FILE_EXTENSIONS.join(' или ')}, получен «${fileName}».` };
    }
    if (/\.(zip|rar|7z|tar|gz|exe|sh|js|html?)$/i.test(lower)) {
      return { ok: false, error: 'Архивы, программы и страницы не принимаются — нужен JSON-профиль.' };
    }
  }
  if (mimeType && !ALLOWED_MIME_TYPES.includes(String(mimeType).toLowerCase().split(';')[0].trim())) {
    return { ok: false, error: `Недопустимый тип файла: ${mimeType}.` };
  }
  return { ok: true };
}

/**
 * Есть ли в профиле то, по чему можно анализировать: навыки, портфолио или цены.
 * Пустой объект формально проходит валидацию, но работать с ним бессмысленно.
 */
export function isUsable(profile) {
  if (!profile || typeof profile !== 'object') return false;
  const skills = Array.isArray(profile.skills) ? profile.skills.length : 0;
  const portfolio = Array.isArray(profile.portfolio) ? profile.portfolio.length : 0;
  const services = Array.isArray(profile.services) ? profile.services.length : 0;
  const hasPricing = Number.isFinite(Number(profile.pricing?.minimum_project_price)) ||
    Number.isFinite(Number(profile.pricing?.hourly_rate));
  const hasKeywords = Array.isArray(profile.matching_preferences?.positive_keywords)
    ? profile.matching_preferences.positive_keywords.length > 0
    : false;
  return skills > 0 || portfolio > 0 || services > 0 || hasPricing || hasKeywords;
}

export class ProfileStore {
  constructor({ dataDir = 'data', profilesDir = null, logger = null } = {}) {
    this.dir = profilesDir ? resolve(profilesDir) : resolve(dataDir, 'profiles');
    this.logger = logger;
  }

  pathFor(userId) {
    const id = Number(userId);
    if (!Number.isFinite(id)) return null;
    return join(this.dir, `${id}.json`);
  }

  /** Есть ли личный профиль у пользователя. */
  has(userId) {
    const path = this.pathFor(userId);
    return Boolean(path && existsSync(path));
  }

  /**
   * Профиль пользователя.
   *
   * Общего профиля нет: у каждого он свой. Если личного нет — анализа не будет,
   * пользователь получит напоминание загрузить профиль.
   *
   * @returns {{ profile: object|null, source: 'personal'|null, path: string|null }}
   */
  async get(userId) {
    const path = this.pathFor(userId);
    if (path && existsSync(path)) {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        return { profile: parsed, source: 'personal', path };
      } catch (error) {
        this.logger?.warn('Личный профиль повреждён: пользователю нужно загрузить его заново', {
          userId: Number(userId),
          reason: error.message
        });
        return { profile: null, source: null, path };
      }
    }
    return { profile: null, source: null, path: null };
  }

  /** Профиль для пользователя или null, если его нет. */
  async profileOf(userId) {
    return (await this.get(userId)).profile;
  }

  /**
   * Разбор и проверка профиля из загруженного текста.
   * Возвращает либо профиль, либо понятную причину отказа.
   */
  /**
   * Разбор и проверка профиля.
   *
   * Порядок важен: сначала дешёвые проверки текста (размер, глубина, баланс скобок),
   * только потом JSON.parse — чтобы большой или хитро вложенный файл не уронил процесс.
   */
  parse(text, { fileName = null, mimeType = null } = {}) {
    const raw = String(text ?? '');

    // 1. Тип файла по имени и MIME: пропускаем только JSON и текст.
    const typeCheck = checkFileType({ fileName, mimeType });
    if (!typeCheck.ok) return { ok: false, error: typeCheck.error };

    // 2. Предварительная проверка текста до разбора.
    const preflight = preflightJson(raw, { maxBytes: PROFILE_SIZE_LIMIT });
    if (!preflight.ok) return { ok: false, error: preflight.error };

    // 3. Разбор. JSON.parse не исполняет код, но результат всё равно проверяем схемой.
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, error: `Это не корректный JSON: ${error.message}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Профиль должен быть JSON-объектом.' };
    }

    // 4. Строгая схема: типы, длины, лимиты, запрещённые ключи (__proto__ и подобные).
    const shape = checkProfileShape(parsed);
    if (!shape.ok) {
      return { ok: false, error: shape.problems.slice(0, 5).join('; '), warnings: shape.warnings };
    }

    const validation = validateProfile(parsed);
    if (!validation.ok) {
      return { ok: false, error: validation.errors.join('; '), warnings: validation.warnings };
    }
    // Проверка «есть ли чем анализировать»: профиль без навыков, портфолио и цен
    // формально валиден, но пользы от него нет — лучше сказать об этом сразу.
    const usable = isUsable(parsed);
    if (!usable) {
      return {
        ok: false,
        error: 'В профиле нет ни skills, ни portfolio, ни pricing — анализировать нечего.',
        warnings: validation.warnings
      };
    }
    return { ok: true, profile: parsed, warnings: validation.warnings };
  }

  /** Сохранение личного профиля. Пишем атомарно, чтобы не оставить обрезанный файл. */
  async save(userId, profile) {
    const path = this.pathFor(userId);
    if (!path) throw new Error(`Некорректный id пользователя: ${userId}`);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
    return path;
  }

  /** Проверка и сохранение загруженного текста. */
  async import(userId, text, { fileName = null, mimeType = null } = {}) {
    const parsed = this.parse(text, { fileName, mimeType });
    if (!parsed.ok) return parsed;
    await this.save(userId, parsed.profile);
    return {
      ok: true,
      profile: parsed.profile,
      warnings: [...(parsed.warnings ?? [])],
      path: this.pathFor(userId)
    };
  }

  /** Удаление личного профиля: пользователь возвращается на запасной или на «нет профиля». */
  async remove(userId) {
    const path = this.pathFor(userId);
    if (!path || !existsSync(path)) return false;
    await unlink(path);
    return true;
  }

  /** Кто из перечисленных пользователей имеет профиль. */
  async summarize(userIds = []) {
    const result = [];
    for (const userId of userIds) {
      const { profile, source } = await this.get(userId);
      result.push({ userId: Number(userId), hasProfile: Boolean(profile), source });
    }
    return result;
  }

  /**
   * Отметка о напоминании и проверка «можно ли напоминать сейчас».
   * Напоминаем не чаще одного раза в сутки: иначе бот превратится в спам.
   */
  async noteReminder(userId, { now = new Date(), intervalMs = 24 * 60 * 60 * 1000 } = {}) {
    const id = String(Number(userId));
    const state = await this.readReminders();
    const previous = state[id] ? Date.parse(state[id]) : null;
    if (previous && Number.isFinite(previous) && now.getTime() - previous < intervalMs) {
      return { allowed: false, lastReminderAt: state[id] };
    }
    state[id] = now.toISOString();
    await this.writeReminders(state);
    return { allowed: true, lastReminderAt: null };
  }

  async readReminders() {
    const file = join(this.dir, 'reminders.json');
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  async writeReminders(state) {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, 'reminders.json');
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  }

  /** Список id пользователей, у которых есть личный профиль. */
  async listPersonal() {
    if (!existsSync(this.dir)) return [];
    const names = await readdir(this.dir);
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => Number(name.replace(/\.json$/, '')))
      .filter((id) => Number.isFinite(id));
  }
}

/**
 * Текст профиля-шаблона для отправки пользователю.
 * Берём текущий общий профиль (или пример из репозитория), чтобы человеку было что править.
 */
export async function readTemplateProfile({ fallbackPath = null, samplePath = null } = {}) {
  for (const candidate of [fallbackPath, samplePath]) {
    if (candidate && existsSync(candidate)) {
      return { text: await readFile(candidate, 'utf8'), path: candidate };
    }
  }
  return { text: null, path: null };
}
