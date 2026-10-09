/**
 * Хранилище обработанных заданий и дедупликация.
 *
 * Требование: новая карточка обрабатывается один раз, повторная не создаёт дубликат.
 * Индекс дедупликации ведётся по нескольким ключам сразу:
 *  - stable-id  — числовой id задания (самый надёжный);
 *  - url        — нормализованная ссылка без query-параметров;
 *  - composite  — осторожный составной ключ, когда ни id, ни ссылки нет.
 *
 * Для составного ключа возможны ложные совпадения (две разные карточки с тем же
 * заголовком и бюджетом), поэтому такие срабатывания помечаются probableMatch,
 * а не молча считаются дубликатом.
 *
 * HTML не сохраняется: пишутся только нормализованные поля.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Нормализация ссылки для ключа: без query-параметров и хвостового слэша. */
export function normalizeUrlKey(url) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url));
    parsed.search = '';
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${path}`;
  } catch {
    return String(url).split('?')[0].replace(/\/+$/, '');
  }
}

/** Все ключи, по которым задание участвует в дедупликации. */
/**
 * Один ключ дедупликации на задание.
 *
 * Приоритет: числовой id → ссылка → осторожный составной ключ.
 * Хранить задание под несколькими ключами сразу не нужно: у задачи Kwork всегда
 * есть id, а ссылка строится из него. Один ключ на задание делает статистику
 * честной: число записей в индексе равно числу заданий.
 */
export function keyForJob(job) {
  if (job?.id) return { type: 'stable-id', value: String(job.id) };
  const urlKey = normalizeUrlKey(job?.url);
  if (urlKey) return { type: 'url', value: urlKey };
  if (job?.dedupKey?.startsWith('composite:')) {
    return { type: 'composite', value: job.dedupKey.slice('composite:'.length) };
  }
  return null;
}

/** Совместимость: список из одного ключа (или пустой). */
export function keysForJob(job) {
  const key = keyForJob(job);
  return key ? [key] : [];
}

/** Поле индекса, в котором лежит ключ задания. */
export function indexFieldFor(keyType) {
  return keyType === 'stable-id' ? 'stableId' : keyType === 'url' ? 'url' : 'composite';
}

/** Источник задания для последующей очистки индекса: URL списка + id категории. */
export function sourceRefOf(job, { sourceUrl = null } = {}) {
  return {
    url: sourceUrl ?? job?.provenance?.sourceUrl ?? null,
    kworkCategoryId: job?.kworkCategoryId ?? null,
    title: job?.title ?? null
  };
}

/** Значение записи индекса в новом формате. */
function entryOf(job, { recordedAt, sourceRef }) {
  return {
    dedupKey: job.dedupKey ?? null,
    title: job.title ?? null,
    recordedAt,
    sourceUrl: sourceRef?.url ?? null,
    kworkCategoryId: sourceRef?.kworkCategoryId ?? null
  };
}

/** Совместимость: старый формат хранил строку вместо объекта. */
function normalizeIndexEntry(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return { dedupKey: value, title: null, recordedAt: null, sourceUrl: null, kworkCategoryId: null };
  return {
    dedupKey: value.dedupKey ?? null,
    title: value.title ?? null,
    recordedAt: value.recordedAt ?? null,
    sourceUrl: value.sourceUrl ?? null,
    kworkCategoryId: value.kworkCategoryId ?? null
  };
}

/**
 * Проверка «задание уже в индексе».
 *
 * Проверяются все три поля: так старый индекс (где задание лежало и под id, и под
 * ссылкой) продолжает работать, а новый — с одним ключом — не даёт ложных срабатываний.
 */
export function checkDuplicate(job, index) {
  const seen = index?.keys ?? {};
  const key = keyForJob(job);
  if (!key) {
    return { isDuplicate: false, matchedBy: null, matchedId: null, probableMatch: false, noStableKey: true };
  }

  const field = indexFieldFor(key.type);
  const entry = normalizeIndexEntry(seen[field]?.[key.value]);
  if (entry) {
    return {
      isDuplicate: true,
      matchedBy: key.type,
      matchedId: entry.dedupKey,
      probableMatch: key.type === 'composite',
      entry
    };
  }

  // Ссылка могла попасть в индекс раньше (старый формат или другая схема ключей).
  if (key.type === 'stable-id') {
    const urlKey = normalizeUrlKey(job?.url);
    const byUrl = urlKey ? normalizeIndexEntry(seen.url?.[urlKey]) : null;
    if (byUrl) {
      return { isDuplicate: true, matchedBy: 'url', matchedId: byUrl.dedupKey, probableMatch: false, entry: byUrl };
    }
  }

  return { isDuplicate: false, matchedBy: null, matchedId: null, probableMatch: false };
}

/** Запись задания в индекс. Возвращает новый индекс. */
export function addToIndex(job, index, { recordedAt = new Date().toISOString(), sourceRef = null } = {}) {
  const next = {
    version: 1,
    keys: {
      stableId: { ...(index?.keys?.stableId ?? {}) },
      url: { ...(index?.keys?.url ?? {}) },
      composite: { ...(index?.keys?.composite ?? {}) }
    },
    total: (index?.total ?? 0) + 1
  };
  const entry = entryOf(job, { recordedAt, sourceRef });
  const key = keyForJob(job);
  if (key) next.keys[indexFieldFor(key.type)][key.value] = entry;
  next.updatedAt = recordedAt;
  return next;
}

/**
 * Очистка индекса: удаляются записи, которые в текущем проходе больше не
 * встретились. Удаление выполняется ТОЛЬКО для ключей, чей источник
 * (`sourceUrl`) в этом проходе успешно получен и разобран — иначе сбой одного
 * URL сбрасывал бы базу и провоцировал повторные уведомления.
 *
 * @param {object} index текущий индекс
 * @param {Set<string>} seenKeys ключи, встреченные в успешном проходе (`тип:значение`)
 * @param {{reliableSourceUrls: Set<string>}} options источники, которым можно доверять
 */
export function pruneIndex(index, seenKeys, { reliableSourceUrls = new Set() } = {}) {
  // removedKeys — сколько ключей удалено; removedJobs — сколько уникальных заданий
  // (у одного задания может быть несколько ключей, поэтому это разные числа).
  const removed = { stableId: 0, url: 0, composite: 0, protected: 0, removedKeys: 0, removedJobs: 0 };
  const removedDedupKeys = new Set();
  const next = {
    version: index?.version ?? 1,
    keys: { stableId: {}, url: {}, composite: {} },
    total: 0,
    updatedAt: index?.updatedAt ?? null
  };

  const keptDedupKeys = new Set();
  for (const type of ['stableId', 'url', 'composite']) {
    for (const [key, rawEntry] of Object.entries(index?.keys?.[type] ?? {})) {
      const entry = normalizeIndexEntry(rawEntry);
      const keyId = `${type}:${key}`;
      const seen = seenKeys.has(keyId);
      // Записи без источника (старый формат) не удаляем: неизвестно, откуда они.
      const sourceReliable = entry?.sourceUrl ? reliableSourceUrls.has(entry.sourceUrl) : false;
      if (seen || !sourceReliable) {
        next.keys[type][key] = rawEntry;
        if (!seen && sourceReliable) removed.protected += 1;
        if (entry?.dedupKey) keptDedupKeys.add(entry.dedupKey);
        continue;
      }
      removed[type] += 1;
      removed.removedKeys += 1;
      if (entry?.dedupKey) removedDedupKeys.add(entry.dedupKey);
    }
  }
  removed.removedJobs = removedDedupKeys.size;
  next.total = keptDedupKeys.size;
  next.updatedAt = new Date().toISOString();
  return { index: next, removed };
}

/** Количество активных заданий (уникальных dedupKey) в индексе. */
export function activeJobCount(index) {
  const dedupKeys = new Set();
  for (const type of ['stableId', 'url', 'composite']) {
    for (const rawEntry of Object.values(index?.keys?.[type] ?? {})) {
      const entry = normalizeIndexEntry(rawEntry);
      if (entry?.dedupKey) dedupKeys.add(entry.dedupKey);
    }
  }
  return dedupKeys.size;
}

/** Ключ задания в виде строки «тип:значение» — для сопоставления с проходом. */
export function keyIdsForJob(job) {
  const key = keyForJob(job);
  return key ? [`${indexFieldFor(key.type)}:${key.value}`] : [];
}

async function writeJsonAtomic(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

export class JobStore {
  constructor({ dataDir = 'data', files = {}, logger = null } = {}) {
    this.dataDir = dataDir;
    this.paths = {
      index: resolve(dataDir, files.seenIndexFile ?? 'seen-index.json'),
      processed: resolve(dataDir, files.processedJobsFile ?? 'processed-jobs.jsonl'),
      state: resolve(dataDir, files.stateFile ?? 'state.json'),
      messages: resolve(dataDir, files.messagesLogFile ?? 'messages-log.jsonl')
    };
    this.logger = logger;
    this.index = null;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    this.index = await this.readIndex();
    return this;
  }

  async readIndex() {
    if (!existsSync(this.paths.index)) {
      return { version: 1, keys: { stableId: {}, url: {}, composite: {} }, total: 0 };
    }
    try {
      const raw = await readFile(this.paths.index, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        version: parsed.version ?? 1,
        keys: {
          stableId: parsed.keys?.stableId ?? {},
          url: parsed.keys?.url ?? {},
          composite: parsed.keys?.composite ?? {}
        },
        total: parsed.total ?? 0,
        updatedAt: parsed.updatedAt ?? null
      };
    } catch (error) {
      // Повреждённый индекс — не повод молча начинать заново: сообщаем наверх.
      throw new Error(`Не удалось прочитать индекс дедупликации ${this.paths.index}: ${error.message}`);
    }
  }

  /** Есть ли задание в индексе. */
  isProcessed(job) {
    return checkDuplicate(job, this.index);
  }

  /**
   * Идемпотентная запись: если задание уже есть, ничего не меняем.
   * @returns {{recorded: boolean, duplicate: object}}
   */
  async record(job, { payload = {}, recordedAt = new Date().toISOString(), sourceRef = null } = {}) {
    const duplicate = this.isProcessed(job);
    if (duplicate.isDuplicate) {
      return { recorded: false, duplicate };
    }
    const entry = {
      recordedAt,
      id: job.id,
      url: job.url ?? null,
      title: job.title ?? null,
      dedupKey: job.dedupKey,
      dedupKind: job.dedupKind,
      missingFields: job.missingFields ?? [],
      probableMatch: duplicate.probableMatch ?? false,
      payload
    };
    await mkdir(dirname(this.paths.processed), { recursive: true });
    await appendFile(this.paths.processed, `${JSON.stringify(entry)}\n`, 'utf8');
    this.index = addToIndex(job, this.index, { recordedAt, sourceRef: sourceRef ?? sourceRefOf(job) });
    await writeJsonAtomic(this.paths.index, this.index);
    return { recorded: true, duplicate };
  }

  /**
   * Очистка индекса после полного прохода: задания, которых больше нет в выдаче,
   * удаляются. Доверяем только тем источникам, которые в этом проходе получены
   * и разобраны без ошибок, — иначе сбой сети сбросил бы базу.
   */
  async prune({ seenKeys = new Set(), reliableSourceUrls = new Set() } = {}) {
    const { index, removed } = pruneIndex(this.index, seenKeys, { reliableSourceUrls });
    if (removed.removedKeys > 0) {
      this.index = index;
      await writeJsonAtomic(this.paths.index, this.index);
    }
    // removed — число удалённых заданий (не ключей), active — сколько осталось.
    return { removed: removed.removedJobs, removedKeys: removed.removedKeys, active: activeJobCount(this.index), details: removed };
  }

  /** Список активных заданий индекса — для /status и команды categories. */
  activeJobs({ limit = 50 } = {}) {
    const out = [];
    const seenDedup = new Set();
    for (const [key, rawEntry] of Object.entries(this.index?.keys?.stableId ?? {})) {
      const entry = normalizeIndexEntry(rawEntry);
      if (!entry || seenDedup.has(entry.dedupKey)) continue;
      seenDedup.add(entry.dedupKey);
      out.push({
        id: key,
        dedupKey: entry.dedupKey,
        title: entry.title,
        kworkCategoryId: entry.kworkCategoryId,
        sourceUrl: entry.sourceUrl,
        recordedAt: entry.recordedAt
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async readState() {
    if (!existsSync(this.paths.state)) return {};
    try {
      return JSON.parse(await readFile(this.paths.state, 'utf8'));
    } catch {
      return {};
    }
  }

  async writeState(patch) {
    const current = await this.readState();
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.paths.state, next);
    return next;
  }

  async appendMessageLog(entry) {
    await mkdir(dirname(this.paths.messages), { recursive: true });
    await appendFile(this.paths.messages, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Последние записанные задания (для /status и dashboard). */
  async readProcessedTail(limit = 20) {
    if (!existsSync(this.paths.processed)) return [];
    const raw = await readFile(this.paths.processed, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  get stats() {
    const stableIdKeys = Object.keys(this.index?.keys?.stableId ?? {}).length;
    const urlKeys = Object.keys(this.index?.keys?.url ?? {}).length;
    const compositeKeys = Object.keys(this.index?.keys?.composite ?? {}).length;
    return {
      // Одно задание — один ключ, поэтому total совпадает с числом ключей.
      total: activeJobCount(this.index),
      keyTotal: stableIdKeys + urlKeys + compositeKeys,
      stableIdKeys,
      urlKeys,
      compositeKeys,
      updatedAt: this.index?.updatedAt ?? null
    };
  }
}
