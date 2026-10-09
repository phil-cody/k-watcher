/**
 * Адаптер модели анализа.
 *
 * По умолчанию provider = heuristic: анализ полностью офлайн, внешних вызовов и
 * биллинга нет. Платные провайдеры включаются только явной конфигурацией через
 * переменные окружения (ключи никогда не читаются из config/*.json и не логируются).
 *
 * Модель НЕ получает права менять факты, риски и черновик: она может только
 * дополнить резюме и вопросы. Недоступность модели не должна ломать анализ —
 * вызывающий код продолжает работать на эвристике.
 */

import { createTexts } from '../texts/texts.js';
import { ModelUsageTracker } from './model-usage.js';

let defaultModelTexts = null;
function modelTexts(textsInput) {
  if (textsInput) return textsInput;
  if (!defaultModelTexts) defaultModelTexts = createTexts({ rootDir: process.cwd() });
  return defaultModelTexts;
}

export class ModelUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ModelUnavailableError';
    this.details = details;
  }
}

/** Разбор ответа модели, содержащего JSON-объект. */
export function parseModelJson(content) {
  if (typeof content !== 'string' || content.trim() === '') return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const candidate = (fenced ? fenced[1] : content).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Промпт: строгие требования к различию факта, вывода и неизвестного. */
export function buildPrompt(job, analysis, profile, { texts = null } = {}) {
  const t = (path, params) => modelTexts(texts).t(path, params);
  return modelTexts(texts)
    .lines('model.prompt', {
      job: JSON.stringify({
        title: job.title,
        description: job.description,
        budget: job.budget?.text ?? null,
        category: job.declaredCategory
      }),
      analysis: JSON.stringify({
        verdict: analysis.verdict,
        risks: analysis.risks.map((risk) => risk.code),
        unknown: analysis.unknown
      }),
      profile: JSON.stringify({
        headline: profile?.headline,
        skills: profile?.skills,
        excluded_work: profile?.excluded_work,
        pricing: profile?.pricing,
        availability: profile?.availability
      })
    })
    .join('\n');
}

/**
 * Классификация ответа провайдера.
 * Для бесплатных тарифов это ключевое различие: 429 — исчерпан лимит (лечится паузой),
 * 401/403 — неверный или отозванный ключ (пауза не поможет).
 */
export function classifyProviderStatus(status, body = '') {
  const text = String(body ?? '').toLowerCase();
  if (status === 429 || /rate.?limit|quota|too many requests|resource_exhausted/.test(text)) return 'rate-limit';
  if (status === 401 || status === 403 || /invalid.?api.?key|unauthorized|permission/.test(text)) return 'auth';
  if (/model.*(not found|does not exist)|unknown model|no such model/.test(text)) return 'model-not-found';
  if (/context length|too many tokens|maximum context/.test(text)) return 'too-long';
  if (status >= 500) return 'provider-error';
  return 'unknown';
}

export function createModelAdapter({
  model = {},
  secrets = {},
  logger = null,
  fetchImpl = globalThis.fetch,
  texts = null,
  usageTracker = null,
  timezone = 'UTC',
  dataDir = 'data'
} = {}) {
  const provider = model.provider ?? 'heuristic';
  const t = (path, params) => modelTexts(texts).t(path, params);

  const log = (level, message, meta = {}) => {
    if (logger && typeof logger[level] === 'function') logger[level](message, meta);
  };

  // Учёт квоты: у бесплатных тарифов лимиты на сутки и час.
  const limits = {
    perDay: model.usage?.perDay ?? null,
    perHour: model.usage?.perHour ?? null
  };
  const tracker =
    usageTracker ??
    new ModelUsageTracker({ dataDir, provider, limits, timezone, logger });

  // Что именно подключено: провайдер и имя модели (для /status и /usage).
  const modelName = provider === 'openai-compatible' ? secrets.llmModel ?? null : provider === 'anthropic' ? secrets.anthropicModel ?? null : null;

  return {
    provider,
    model: modelName,
    /** Короткая подпись: «openai-compatible · deepseek-chat» или «heuristic». */
    get label() {
      return modelName ? `${provider} · ${modelName}` : provider;
    },
    /** Доступен ли внешний вызов. heuristic всегда доступен и ничего не вызывает. */
    get available() {
      if (provider === 'heuristic') return true;
      if (provider === 'openai-compatible') {
        return Boolean(secrets.llmBaseUrl && secrets.llmApiKey && secrets.llmModel && typeof fetchImpl === 'function');
      }
      if (provider === 'anthropic') {
        return Boolean(secrets.anthropicApiKey && typeof fetchImpl === 'function');
      }
      return false;
    },

    /** Настроен ли провайдер (без учёта квоты). */
    get configured() {
      return this.available;
    },

    /** Расход и остаток квоты — для /status и диагностики. */
    get usage() {
      return tracker.snapshot;
    },

    /**
     * Загрузить сохранённый счётчик (вызывается один раз при старте).
     * В режиме эвристики файл не создаётся: считать нечего.
     */
    async initUsage() {
      if (provider === 'heuristic') return tracker.snapshot;
      await tracker.init();
      tracker.limits = limits;
      return tracker.snapshot;
    },

    /**
     * Стоит ли вообще обращаться к модели для этого задания.
     * Экономит бесплатную квоту: понятные задания и явные отказы в модели не нуждаются.
     */
    shouldEnrich(job, analysis) {
      if (provider === 'heuristic' || !this.available) return false;
      const mode = model.selective?.enabled === false ? 'always' : model.selective?.mode ?? 'uncertain';
      if (mode === 'always') return true;
      // uncertain: зовём только там, где эвристика не уверена или видит риски.
      if (analysis?.verdict === 'нужно уточнить' || analysis?.verdict === 'возможно') return true;
      if (Array.isArray(analysis?.risks) && analysis.risks.length > 0) return true;
      if (Array.isArray(analysis?.unknown) && analysis.unknown.length > 0) return true;
      return false;
    },

    /**
     * Дополнение анализа. Для heuristic возвращает null (нечего дополнять).
     * Ошибки провайдера не пробрасываются наверх: анализ продолжается на эвристике.
     */
    async enrich(job, analysis, profile) {
      if (provider === 'heuristic') return null;
      if (!this.available) {
        log('warn', t('model.logUnavailable'), { provider });
        return null;
      }

      // Бюджет: у бесплатных тарифов лимит на сутки и час. Лучше пропустить вызов
      // и остаться на эвристике, чем получить 429 и потерять остаток квоты.
      const budget = tracker.check();
      if (!budget.allowed) {
        log('warn', t(budget.reason === 'hour' ? 'model.logBudgetHour' : 'model.logBudgetDay'), {
          provider,
          used: budget.snapshot.dayCount,
          limit: budget.reason === 'hour' ? budget.snapshot.limits.perHour : budget.snapshot.limits.perDay
        });
        return null;
      }

      const prompt = buildPrompt(job, analysis, profile, { texts });
      const timeoutMs = model.timeoutMs ?? 30000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        let content = null;
        // Расход токенов: провайдеры возвращают его в usage, но не все.
        let tokensIn = 0;
        let tokensOut = 0;
        if (provider === 'openai-compatible') {
          const url = `${secrets.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`;
          const response = await fetchImpl(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${secrets.llmApiKey}`
            },
            body: JSON.stringify({
              model: secrets.llmModel,
              temperature: model.temperature ?? 0.2,
              max_tokens: model.maxOutputTokens ?? 1200,
              messages: [
                { role: 'system', content: t('model.systemPrompt') },
                { role: 'user', content: prompt }
              ]
            }),
            signal: controller.signal
          });
          if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new ModelUnavailableError(t('model.httpError', { status: response.status }), {
              kind: classifyProviderStatus(response.status, body)
            });
          }
          const payload = await response.json();
          content = payload?.choices?.[0]?.message?.content ?? null;
          tokensIn = Number(payload?.usage?.prompt_tokens ?? 0);
          tokensOut = Number(payload?.usage?.completion_tokens ?? 0);
        } else if (provider === 'anthropic') {
          const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': secrets.anthropicApiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: secrets.anthropicModel ?? 'claude-3-5-haiku-latest',
              max_tokens: model.maxOutputTokens ?? 1200,
              temperature: model.temperature ?? 0.2,
              messages: [{ role: 'user', content: prompt }]
            }),
            signal: controller.signal
          });
          if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new ModelUnavailableError(t('model.httpError', { status: response.status }), {
              kind: classifyProviderStatus(response.status, body)
            });
          }
          const payload = await response.json();
          content = payload?.content?.[0]?.text ?? null;
          // Anthropic отдаёт расход в полях input_tokens/output_tokens.
          tokensIn = Number(payload?.usage?.input_tokens ?? 0);
          tokensOut = Number(payload?.usage?.output_tokens ?? 0);
        }

        // Учитываем запрос: провайдер его принял и потратил квоту (и токены, если сообщил).
        await tracker.record({ tokensIn, tokensOut });

        const parsed = parseModelJson(content);
        if (!parsed) {
          log('warn', t('model.logBadJson'), { provider });
          return null;
        }
        const summary = typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : null;
        const extraQuestions = Array.isArray(parsed.extraQuestions)
          ? parsed.extraQuestions.filter((item) => typeof item === 'string' && item.trim()).slice(0, 5)
          : [];
        const notes = Array.isArray(parsed.notes) ? parsed.notes.filter((item) => typeof item === 'string').slice(0, 5) : [];
        return { summary, extraQuestions, notes, provider };
      } catch (error) {
        const kind = error.details?.kind ?? (error.name === 'AbortError' ? 'timeout' : 'unknown');
        const reason = error.name === 'AbortError' ? 'timeout' : error.message;
        // Разные подсказки для разных причин: лимит лечится паузой, ключ — заменой ключа.
        const messageKey =
          kind === 'rate-limit'
            ? 'model.logRateLimited'
            : kind === 'auth'
              ? 'model.logAuthFailed'
              : kind === 'model-not-found'
                ? 'model.logModelNotFound'
                : kind === 'too-long'
                  ? 'model.logTooLong'
                  : 'model.logCallFailed';
        log('warn', t(messageKey), { provider, reason, kind });
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
