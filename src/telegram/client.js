/**
 * Тонкий клиент Telegram Bot API на встроенном fetch.
 *
 * Осознанно без сторонних библиотек: нужны ровно две операции — long polling
 * (getUpdates) и отправка сообщения (sendMessage). Клиент отвечает только
 * пользователю из TELEGRAM_ALLOWED_USER_ID и не имеет других прав.
 *
 * Токен никогда не попадает в логи и сообщения об ошибках (см. redact).
 */

import { redact } from '../util/logger.js';

/**
 * Разбор сетевой ошибки fetch.
 *
 * Node прячет настоящую причину в `error.cause`: снаружи видно только «fetch failed».
 * Без разбора в логе не отличить обрыв соединения от таймаута или отказа DNS.
 */
export function describeNetworkError(error) {
  if (!error) return { reason: 'неизвестная ошибка', code: null };
  if (error.name === 'AbortError') return { reason: 'таймаут запроса', code: 'ETIMEDOUT' };

  const parts = [];
  let current = error;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = current.code ?? current.errno ?? null;
    const message = typeof current.message === 'string' ? current.message : '';
    if (code && !parts.includes(code)) parts.push(code);
    // Технические тексты вроде «fetch failed» не несут смысла — пропускаем.
    if (message && message !== 'fetch failed' && !parts.includes(message)) parts.push(message);
    current = current.cause;
  }
  const reason = parts.filter(Boolean).join(': ') || 'сетевая ошибка';
  const code = (error.cause?.code ?? error.code ?? null);
  return { reason, code };
}

export class TelegramError extends Error {
  constructor(
    message,
    { status = null, retryAfterSeconds = null, details = null, conflict = false, network = false, networkCode = null } = {}
  ) {
    super(message);
    this.name = 'TelegramError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = details;
    this.conflict = conflict;
    this.network = network;
    this.networkCode = networkCode;
  }
}

/**
 * Таймаут для getUpdates: время ожидания на стороне Telegram плюс запас на сеть.
 * Минимум 20 секунд запаса: при 30-секундном опросе клиент ждёт 55 секунд.
 */
export function longPollTimeoutMs(timeoutSeconds, { marginSeconds = 25 } = {}) {
  const wait = Number(timeoutSeconds) > 0 ? Number(timeoutSeconds) : 30;
  return (wait + marginSeconds) * 1000;
}

/** Описание присланного файла (или null, если это не документ). */
function normalizeDocument(document) {
  if (!document?.file_id) return null;
  return {
    fileId: document.file_id,
    fileUniqueId: document.file_unique_id ?? null,
    fileName: document.file_name ?? null,
    mimeType: document.mime_type ?? null,
    size: Number.isFinite(Number(document.file_size)) ? Number(document.file_size) : null
  };
}

export class TelegramClient {
  constructor({
    token,
    allowedUserId = null,
    chatId = null,
    telegramState = null,
    autoApprove = true,
    apiBase = 'https://api.telegram.org',
    fetchImpl = globalThis.fetch,
    logger = null,
    timeoutMs = 35000,
    texts = null
  }) {
    if (!token) throw new TelegramError('TELEGRAM_BOT_TOKEN не задан.');
    this.token = token;
    // allowedUserId — владелец из окружения; реестр пользователей живёт в telegramState.
    this.allowedUserId = allowedUserId;
    this.telegramState = telegramState;
    // Доступ по умолчанию открыт: подтверждение владельцем не требуется.
    // Отключить можно явно: config.telegram.autoApprove = false.
    this.autoApprove = autoApprove !== false;
    this.chatId = chatId;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    // Тексты логов: клиент может не иметь доступа к config/texts.json, поэтому необязательны.
    this.logs = texts?.data?.logs ?? null;
    this.offset = 0;
  }

  async call(method, payload = {}, { timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        const description = redact(data?.description ?? `HTTP ${response.status}`);
        const conflict = /terminated by other getUpdates|other getUpdates request/i.test(description);
        throw new TelegramError(
          conflict
            ? 'Тот же токен бота уже опрашивается другим процессом. Остановите другие копии бота (или второй компьютер), иначе Telegram будет отдавать обновления только одной из них.'
            : `Telegram ${method} не выполнен: ${description}`,
          {
            status: response.status,
            retryAfterSeconds: data?.parameters?.retry_after ?? null,
            details: { errorCode: data?.error_code ?? null, method },
            conflict
          }
        );
      }
      return data.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      const described = describeNetworkError(error);
      throw new TelegramError(`Telegram ${method}: ${redact(described.reason)}`, {
        network: true,
        networkCode: described.code
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Отправка только в личный чат пользователя (или явно заданный chat id). */
  async sendMessage(text, { chatId = this.chatId, parseMode = 'HTML', disableNotification = false } = {}) {
    if (!chatId) throw new TelegramError('Неизвестен chat id: сначала отправьте боту /start.');
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      disable_notification: disableNotification,
      disable_web_page_preview: true
    });
  }

  /** Один цикл long polling. Возвращает сообщения, прошедшие фильтр доступа. */
  /**
   * Приём обновлений.
   *
   * Возвращает `{ messages, denied }`:
   *  - `messages` — сообщения от подтверждённых пользователей (и от владельца);
   *  - `denied` — те, кому доступ ещё не выдан: вызывающая сторона сама решает,
   *    что ответить (обычно «запрос на доступ отправлен»).
   */
  async pollOnce({ timeoutSeconds = 30, signal = null } = {}) {
    const result = await this.call(
      'getUpdates',
      { offset: this.offset || undefined, timeout: timeoutSeconds, allowed_updates: ['message'] },
      // Запас обязателен: Telegram держит соединение открытым всё время long polling,
      // и таймаут клиента должен быть заметно больше. Иначе получаем ложные таймауты.
      { timeoutMs: longPollTimeoutMs(timeoutSeconds) }
    );
    const messages = [];
    const denied = [];
    for (const update of result ?? []) {
      this.offset = Math.max(this.offset, (update.update_id ?? 0) + 1);
      const message = update.message;
      if (!message) continue;
      const fromId = message.from?.id ?? null;
      const chatId = message.chat?.id ?? null;
      const user = {
        userId: fromId,
        chatId,
        username: message.from?.username ?? null,
        name: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || null
      };

      if (this.telegramState) {
        this.telegramState.rememberUser(user);
        const approved = this.telegramState.isApproved(fromId);
        // Доступ открыт: подтверждение владельцем не требуется, подключение только логируем.
        let isNewUser = false;
        if (!this.telegramState.isApproved(fromId)) {
          if (!this.autoApprove) {
            this.logger?.info('Сообщение от пользователя без доступа проигнорировано', { fromId });
            denied.push({ ...user, text: message.text ?? '', updateId: update.update_id, date: message.date ?? null });
            continue;
          }
          isNewUser = this.telegramState.markNewUser(fromId);
          this.telegramState.approveUser(fromId);
          await this.telegramState.save();
          this.logger?.info(this.logs?.newUser ?? 'Новый пользователь подключился к боту', {
            userId: fromId,
            username: user.username,
            name: user.name
          });
        }
        if (!this.chatId && chatId) this.chatId = chatId;
        messages.push({
          updateId: update.update_id,
          fromId,
          chatId,
          username: user.username,
          name: user.name,
          text: message.text ?? '',
          document: normalizeDocument(message.document),
          date: message.date ?? null,
          isNewUser
        });
        // Важно: без continue сообщение попало бы ещё и в ветку без реестра ниже.
        continue;
      }

      // Без реестра поведение прежнее: отвечаем только владельцу из окружения.
      if (this.allowedUserId && fromId !== this.allowedUserId) {
        this.logger?.warn('Сообщение от постороннего пользователя проигнорировано', { fromId });
        continue;
      }
      if (!this.chatId && fromId) this.chatId = chatId ?? fromId;
      messages.push({
        updateId: update.update_id,
        fromId,
        chatId,
        username: user.username,
        name: user.name,
        text: message.text ?? '',
        document: normalizeDocument(message.document),
        date: message.date ?? null
      });
    }
    return { messages, denied };
  }

  /**
   * Скачивание присланного файла (`getFile` + загрузка по file_path).
   * Ограничение по размеру обязательно: профиль — это десятки килобайт, не мегабайты.
   */
  async downloadFile(fileId, { maxBytes = 256 * 1024 } = {}) {
    const file = await this.call('getFile', { file_id: fileId });
    const filePath = file?.file_path;
    if (!filePath) throw new TelegramError('Telegram не вернул путь к файлу');
    if (Number.isFinite(Number(file?.file_size)) && Number(file.file_size) > maxBytes) {
      throw new TelegramError(`Файл больше ${Math.round(maxBytes / 1024)} КБ`);
    }
    const url = `${this.apiBase}/file/bot${this.token}/${filePath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { method: 'GET', signal: controller.signal });
      if (!response.ok) throw new TelegramError(`Не удалось скачать файл: HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) throw new TelegramError(`Файл больше ${Math.round(maxBytes / 1024)} КБ`);
      return { text: buffer.toString('utf8'), bytes: buffer.byteLength, path: filePath };
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError(`Скачивание файла: ${error.name === 'AbortError' ? 'таймаут' : error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Отправка файла документом (`sendDocument`). Нужна, чтобы выдать шаблон профиля. */
  async sendDocument({ chatId = this.chatId, fileName, content, caption = null } = {}) {
    if (!chatId) throw new TelegramError('Неизвестен chat id: сначала отправьте боту /start.');
    if (typeof FormData !== 'function') throw new TelegramError('FormData недоступен в этой версии Node.js');
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([String(content ?? '')], { type: 'application/json' }), fileName ?? 'profile.json');
    if (caption) form.append('caption', String(caption));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBase}/bot${this.token}/sendDocument`, {
        method: 'POST',
        body: form,
        signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        throw new TelegramError(
          `Telegram sendDocument не выполнен: ${redact(data?.description ?? `HTTP ${response.status}`)}`,
          { status: response.status }
        );
      }
      return data.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      const described = describeNetworkError(error);
      throw new TelegramError(`Telegram sendDocument: ${redact(described.reason)}`, {
        network: true,
        networkCode: described.code
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Публикация списка команд в интерфейсе Telegram (`setMyCommands`).
   * После этого команды видны в меню бота — их не нужно набирать вручную.
   *
   * `chatId` задаёт область видимости: без него команды видны всем, с ним —
   * только указанному чату. Так владелец видит дополнительные команды.
   */
  async publishCommands(commands, { chatId = null } = {}) {
    const list = (commands ?? []).filter((item) => item?.command && item?.description);
    if (list.length === 0) return false;
    const payload = { commands: list };
    const target = chatId === null || chatId === undefined || chatId === '' ? null : Number(chatId);
    if (target !== null && Number.isFinite(target)) {
      payload.scope = { type: 'chat', chat_id: target };
    }
    await this.call('setMyCommands', payload);
    return true;
  }

  /** Удаление команд из меню (например, чтобы убрать старый набор владельца). */
  async deleteCommands({ chatId = null } = {}) {
    const payload = {};
    const target = chatId === null || chatId === undefined || chatId === '' ? null : Number(chatId);
    if (target !== null && Number.isFinite(target)) payload.scope = { type: 'chat', chat_id: target };
    await this.call('deleteMyCommands', payload);
    return true;
  }

  get initialized() {
    return Boolean(this.chatId);
  }
}

/** Заглушка для dry-run: сообщения не отправляются, а печатаются. */
export class NullNotifier {
  constructor({ sink = (text) => process.stdout.write(`${text}\n`) } = {}) {
    this.sink = sink;
    this.sent = [];
  }

  async sendMessage(text) {
    this.sent.push(text);
    this.sink(text);
    return { message_id: this.sent.length, stub: true };
  }
}
