/**
 * Хранилище состояния Telegram: offset обновлений, известные и подтверждённые
 * пользователи и их чаты.
 *
 * Нужно для двух вещей:
 *  1) режим `poll` (без приёма команд) должен знать, куда отправлять уведомления;
 *  2) бот не зашит под одного человека: любой может написать `/start`, владелец
 *     подтверждает доступ, и после этого пользователь получает уведомления.
 *
 * Файл содержит только числовые идентификаторы и имена из Telegram — токенов там нет.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Приведение записи пользователя к единому виду. */
function normalizeUser(user) {
  const id = Number(user?.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    chatId: Number.isFinite(Number(user?.chatId)) ? Number(user.chatId) : null,
    username: user?.username ?? null,
    name: user?.name ?? null,
    addedAt: user?.addedAt ?? null
  };
}

export class TelegramState {
  constructor({ dataDir = 'data', file = null, ownerId = null } = {}) {
    this.path = file ? resolve(file) : resolve(dataDir, 'telegram-state.json');
    this.data = {
      offset: 0,
      chatId: null,
      ownerId: Number.isFinite(Number(ownerId)) ? Number(ownerId) : null,
      approvedUsers: [],
      seenUsers: [],
      knownUsers: {},
      publishedMenus: {},
      updatedAt: null
    };
    if (Number.isFinite(Number(ownerId))) {
      // Владелец из окружения (TELEGRAM_ALLOWED_USER_ID) подтверждён по определению.
      this.data.approvedUsers = [Number(ownerId)];
    }
  }

  async init() {
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(await readFile(this.path, 'utf8'));
        const approved = Array.isArray(parsed.approvedUsers)
          ? parsed.approvedUsers.map(Number).filter((id) => Number.isFinite(id))
          : [];
        // Совместимость: раньше был только chatId одного пользователя.
        if (approved.length === 0 && Number.isFinite(Number(parsed.chatId))) {
          approved.push(Number(parsed.chatId));
        }
        this.data = {
          offset: Number(parsed.offset) || 0,
          chatId: Number.isFinite(Number(parsed.chatId)) ? Number(parsed.chatId) : null,
          ownerId: Number.isFinite(Number(parsed.ownerId))
            ? Number(parsed.ownerId)
            : Number.isFinite(Number(parsed.chatId))
              ? Number(parsed.chatId)
              : this.data.ownerId,
          approvedUsers: [...new Set(approved)],
          // Пользователи, которые уже подключались: по ним показываем «новый» в логах.
          seenUsers: Array.isArray(parsed.seenUsers)
            ? parsed.seenUsers.map(Number).filter((id) => Number.isFinite(id))
            : [],
          publishedMenus:
            parsed.publishedMenus && typeof parsed.publishedMenus === 'object' ? parsed.publishedMenus : {},
          knownUsers:
            parsed.knownUsers && typeof parsed.knownUsers === 'object'
              ? Object.fromEntries(
                  Object.entries(parsed.knownUsers)
                    .map(([id, user]) => [String(id), normalizeUser({ id, ...user })])
                    .filter(([, user]) => user)
                )
              : {},
          updatedAt: parsed.updatedAt ?? null
        };
      } catch {
        // Повреждённый файл не должен мешать запуску: начинаем с пустого состояния.
        this.data = { ...this.data, offset: 0, chatId: null };
      }
    }
    return this;
  }

  get chatId() {
    return this.data.chatId;
  }

  get offset() {
    return this.data.offset;
  }

  get ownerId() {
    return this.data.ownerId;
  }

  get approvedUsers() {
    return [...this.data.approvedUsers];
  }

  get knownUsers() {
    return { ...this.data.knownUsers };
  }

  get seenUsers() {
    return [...this.data.seenUsers];
  }

  /** Отпечатки уже опубликованных меню Telegram: чтобы не публиковать их каждый запуск. */
  get publishedMenus() {
    return { ...this.data.publishedMenus };
  }

  get hasApprovedList() {
    return this.data.approvedUsers.length > 0;
  }

  /** Основной владелец — первый подтверждённый пользователь или ownerId из окружения. */
  get primaryUserId() {
    return this.data.ownerId ?? this.data.approvedUsers[0] ?? null;
  }

  isApproved(userId) {
    const id = Number(userId);
    if (!Number.isFinite(id)) return false;
    return this.data.approvedUsers.includes(id);
  }

  isOwner(userId) {
    return Number(userId) === this.primaryUserId;
  }

  /** Кому отправлять уведомления: чаты всех подтверждённых пользователей. */
  get recipientChatIds() {
    const ids = new Set();
    for (const userId of this.data.approvedUsers) {
      const known = this.data.knownUsers[String(userId)];
      const chatId = known?.chatId ?? (Number.isFinite(this.data.chatId) ? this.data.chatId : null);
      if (Number.isFinite(Number(chatId))) ids.add(Number(chatId));
    }
    return [...ids];
  }

  /** Запомнить пользователя, который написал боту (ещё без доступа). */
  rememberUser({ userId, chatId = null, username = null, name = null }) {
    const id = Number(userId);
    if (!Number.isFinite(id)) return null;
    const existing = this.data.knownUsers[String(id)] ?? { id };
    const user = {
      ...existing,
      chatId: Number.isFinite(Number(chatId)) ? Number(chatId) : existing.chatId ?? null,
      username: username ?? existing.username ?? null,
      name: name ?? existing.name ?? null,
      addedAt: existing.addedAt ?? new Date().toISOString()
    };
    this.data.knownUsers[String(id)] = user;
    // Первому написавшему бот отвечает: его чат становится основным.
    if (!Number.isFinite(this.data.chatId) && user.chatId) this.data.chatId = user.chatId;
    if (!Number.isFinite(this.data.ownerId)) this.data.ownerId = id;
    return user;
  }

  /**
   * Отметить, что пользователь подключается впервые.
   * @returns {boolean} true, если это действительно первое подключение.
   */
  markNewUser(userId) {
    const id = Number(userId);
    if (!Number.isFinite(id)) return false;
    if (this.data.seenUsers.includes(id)) return false;
    this.data.seenUsers.push(id);
    return true;
  }

  approveUser(userId) {
    const id = Number(userId);
    if (!Number.isFinite(id)) return false;
    if (!this.data.approvedUsers.includes(id)) this.data.approvedUsers.push(id);
    const known = this.data.knownUsers[String(id)];
    if (known?.chatId && !Number.isFinite(this.data.chatId)) this.data.chatId = known.chatId;
    return true;
  }

  revokeUser(userId) {
    const id = Number(userId);
    this.data.approvedUsers = this.data.approvedUsers.filter((item) => item !== id);
    return true;
  }

  /** Чат пользователя, если он боту уже писал. */
  chatIdOf(userId) {
    const known = this.data.knownUsers[String(userId)];
    return known?.chatId ?? null;
  }

  /** Краткое представление пользователя для сообщений владельцу. */
  describeUser(userId) {
    const user = this.data.knownUsers[String(userId)];
    if (!user) return String(userId);
    const parts = [`id ${user.id}`];
    if (user.username) parts.push(`@${user.username}`);
    if (user.name) parts.push(user.name);
    return parts.join(', ');
  }

  async save(patch = {}) {
    this.data = { ...this.data, ...patch, updatedAt: new Date().toISOString() };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(temporary, this.path);
    return this.data;
  }
}
