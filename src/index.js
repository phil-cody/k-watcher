/**
 * Точки входа CLI.
 *
 * Режимы:
 *   bot            — планировщик + приём команд Telegram (живой опрос только при разрешённом источнике);
 *   poll           — только планировщик (без приёма команд);
 *   dry-run        — разбор сохранённых fixtures без сети, вывод сообщений в stdout;
 *   status         — состояние хранилища и настройки;
 *   config-check   — проверка конфигурации, профиля, секретов и плана опроса;
 *   plan           — показать список запрашиваемых URL, расписание и категории;
 *   dashboard      — локальная веб-страница состояния (только чтение, по умолчанию 127.0.0.1).
 */

import { readFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

import { loadConfig, validateModelSecrets, validateTelegramSecrets } from './config/load-config.js';
import { buildPollPlan, allProjectsUrl } from './source/poll-plan.js';
import { createLogger } from './util/logger.js';
import { KworkListingParser } from './parser/job-parser.js';
import { JobStore } from './storage/job-store.js';
import { ProfileStore, readTemplateProfile } from './storage/profile-store.js';
import { CategoryPreferences, createCategoryCatalog, applyCategoryName } from './storage/category-store.js';
import {
  parseCategoryCatalog,
  loadCategoryCatalogFile,
  saveCategoryCatalogFile
} from './storage/category-catalog.js';
import { createModelAdapter } from './analysis/model-adapter.js';
import { analyzeAndDraft } from './analysis/compose-analysis.js';
import { KworkHtmlSource } from './source/kwork-html-source.js';
import { PollingScheduler } from './scheduler/scheduler.js';
import { createCycleRunner } from './scheduler/cycle.js';
import { TelegramClient, NullNotifier } from './telegram/client.js';
import { TelegramState } from './telegram/state.js';
import { createTexts } from './texts/texts.js';
import { KworkWatcherBot, describePlan, preflight } from './bot/kwork-watcher-bot.js';
import { renderJobMessage } from './telegram/format.js';
import { buildDashboardHtml } from './dashboard/server.js';

function parseArgs(argv) {
  const args = { command: argv[0] ?? 'help', flags: {} };
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [name, value] = token.slice(2).split('=');
      if (value !== undefined) args.flags[name] = value;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args.flags[name] = argv[++i];
      else args.flags[name] = true;
    }
  }
  return args;
}

function reportValidation(logger, validation) {
  for (const warning of validation.warnings) logger.warn(warning);
  for (const error of validation.errors) logger.error(error);
  return validation.ok;
}

/** Базовый адрес источника (origin) из конфигурации. */
function baseUrlOf(config) {
  return String(config?.source?.baseUrl ?? 'https://kwork.ru').replace(/\/+$/, '');
}

async function bootstrap({ requireLiveSource = false, rootDir = process.cwd(), logger, notifier = null }) {
  const { config, profile, validation } = loadConfig({ rootDir, requireLiveSource });
  reportValidation(logger, validation);

  // Единый объект текстов на весь процесс: локальный файл (TEXTS_FILE) переопределяет config/texts.json.
  const texts = createTexts({ rootDir, overrideFile: config.secrets.textsFile ?? null });

  const store = await new JobStore({ dataDir: config.dataDir, files: config.storage, logger }).init();
  // Профили: у каждого пользователя бота свой. Общий профиль из настроек — запасной.
  // Общего профиля нет: каждый пользователь загружает свой через /profile upload.
  const profiles = new ProfileStore({
    dataDir: config.dataDir,
    profilesDir: resolve(config.dataDir, 'profiles'),
    logger
  });
  // Парсеру список категорий больше не передаётся: подписи и id берутся из каталога
  // сайта (applyCategoryName в цикле), поэтому конфиг не привязан к нише пользователя.
  const parser = new KworkListingParser({
    timezone: config.schedule?.timezone ?? 'Europe/Moscow',
    logger
  });
  // Полный каталог категорий сайта: имена вместо чисел и ввод названием.
  const categoryCatalogFile = resolve(rootDir, config.categoryCatalog?.fullCatalogFile ?? 'config/categories.json');
  const fullCatalog = await loadCategoryCatalogFile(categoryCatalogFile);

  // Персональные категории: у каждого пользователя свой набор.
  const categoryCatalog = createCategoryCatalog(config, { fullCatalog });
  const categories = new CategoryPreferences({
    dataDir: config.dataDir,
    dir: resolve(config.dataDir, 'categories'),
    catalog: categoryCatalog,
    logger
  });

  const modelAdapter = createModelAdapter({
    model: config.model,
    secrets: config.secrets,
    logger,
    texts,
    dataDir: config.dataDir,
    timezone: config.schedule?.timezone ?? 'UTC'
  });
  // Счётчик расхода модели: нужен, чтобы не выжечь бесплатную квоту.
  if (typeof modelAdapter.initUsage === 'function') await modelAdapter.initUsage();
  const source = new KworkHtmlSource({
    userAgent: config.source.userAgent,
    timeoutMs: config.source.requestTimeoutMs,
    logger,
    texts
  });
  const cycleRunner = createCycleRunner({
    source,
    parser,
    store,
    profile,
    profiles,
    categories,
    categoryCatalog,
    // Кому отправлять: подтверждённые пользователи и их чаты из реестра Telegram.
    // Функция, а не массив: доступ может измениться во время работы бота.
    recipients: async () => {
      const state = await store.readState();
      return Array.isArray(state?.telegram?.recipients) ? state.telegram.recipients : [];
    },
    notifier,
    modelAdapter,
    config,
    logger,
    texts
  });

  const profileTemplate = await readTemplateProfile(resolve(rootDir, 'config', 'performer-profile.json'));

  return {
    config,
    profile,
    profiles,
    profileTemplate,
    categories,
    categoryCatalog,
    categoryCatalogFile,
    validation,
    store,
    parser,
    modelAdapter,
    source,
    cycleRunner,
    notifier,
    texts
  };
}

async function createScheduler({ config, cycleRunner, store, logger = null, notifier = null, telegramClient = null, texts = null }) {
  // Тексты можно не передавать: создаём сами, чтобы функция была самодостаточной.
  const textsObject = texts ?? createTexts({ rootDir: config.rootDir ?? process.cwd(), overrideFile: config.secrets?.textsFile ?? null });
  const savedState = await store.readState();
  // Счётчики текущего дня — для уведомлений о границах окна.
  const daily = { requests: 0, newJobs: 0 };
  const savedLastRequestAt = savedState?.scheduler?.lastRequestAt ?? null;
  if (savedLastRequestAt) {
    logger?.info(textsObject.t('logs.restoredLastRequest'), {
      lastRequestAt: savedLastRequestAt
    });
  }
  return new PollingScheduler({
    schedule: config.schedule,
    source: null,
    logger,
    texts: textsObject,
    lastRequestAt: savedLastRequestAt,
    windowOpen: savedState?.scheduler?.windowOpen ?? null,
    onWindowChange: buildWindowNotifier({ config, store, logger, texts: textsObject, telegramClient, daily, notifier }),
    onCycle: () => cycleRunner.runOnce(),
    onStop: async ({ reason, message, diagnostics }) => {
      await store.writeState({ lastStop: { reason, message, diagnostics, at: new Date().toISOString() } });
      if (!notifier) return;
      const t = (path, params) => textsObject.t(path, params);
      const lines = [t('commands.stopNotification.header'), t('commands.stopNotification.reason', { reason })];
      if (message) lines.push(message);
      if (diagnostics) {
        lines.push('');
        lines.push(t('commands.stopNotification.diagnosticsHeader'));
        lines.push(t('commands.stopNotification.diagnosticsStatus', { status: diagnostics.status ?? '—' }));
        lines.push(t('commands.stopNotification.diagnosticsBytes', { bytes: diagnostics.bytes ?? '—' }));
        lines.push(t('commands.stopNotification.diagnosticsTitle', { title: diagnostics.title ?? '—' }));
        lines.push(t('commands.stopNotification.diagnosticsMarkers', { markers: (diagnostics.markers ?? []).join(', ') || '—' }));
        if (diagnostics.excerpt) {
          lines.push(t('commands.stopNotification.diagnosticsExcerpt', { excerpt: diagnostics.excerpt }));
        }
        lines.push('');
      }
      lines.push(t('commands.stopNotification.footer'));
      try {
        await notifier.sendMessage(lines.filter(Boolean).join('\n'));
      } catch (error) {
        logger?.warn(t('logs.sendStopFailed'), { reason: error.message });
      }
    },
    onStateChange: async (state) => {
      await store.writeState({
        scheduler: {
          status: state.status,
          stopReason: state.stopReason,
          stopMessage: state.stopMessage,
          requestCount: state.requestCount,
          lastRequestAt: state.lastRequestAt,
          nextRequestAt: state.nextRequestAt,
          // Состояние окна сохраняем: после перезапуска не шлём ложное «открылось».
          windowOpen: state.windowOpen
        },
        dailyCounters: { ...daily, updatedAt: new Date().toISOString() }
      });
    }
  });
}

/**
 * Уведомление о переходе границы окна опроса (открылось/закрылось).
 * Отправляется тем же Telegram-клиентом, что и задания; если chat id неизвестен —
 * пишем предупреждение в лог и не считаем это ошибкой.
 */
function buildWindowNotifier({ config, store, logger, texts, telegramClient, daily, notifier }) {
  const t = (path, params) => texts.t(path, params);
  return async ({ direction, schedule, stats }) => {
    const client = telegramClient ?? (notifier && typeof notifier.sendMessage === 'function' ? notifier : null);
    if (!client) return;
    const chatReady = typeof client.initialized === 'boolean' ? client.initialized : Boolean(client.chatId);
    if (!chatReady) {
      logger?.warn(t('logs.windowNotifyNoChat'));
      return;
    }

    const state = await store.readState();
    const active = state?.scheduler?.activeJobs ?? stats?.activeJobs ?? null;
    const counters = {
      requests: stats?.requests ?? daily.requests,
      newJobs: stats?.newJobs ?? daily.newJobs,
      active: active ?? '—'
    };

    const lines = [];
    if (direction === 'opened') {
      lines.push(t('window.opened.header'));
      lines.push(t('window.opened.schedule', schedule));
      if (daily.newJobs > 0 || active !== null) {
        lines.push(t('window.opened.previousDay', { count: counters.newJobs }));
      }
      lines.push(t('window.opened.firstRequestSoon'));
      lines.push(t('window.opened.controls'));
    } else {
      lines.push(t('window.closed.header'));
      lines.push(t('window.closed.schedule', { start: schedule.start, timezone: schedule.timezone }));
      lines.push(
        counters.requests > 0
          ? t('window.closed.stats', { requests: counters.requests, newJobs: counters.newJobs, active: counters.active })
          : t('window.closed.noRequests')
      );
      lines.push(t('window.closed.controls'));
    }

    try {
      await client.sendMessage(lines.join('\n'), { parseMode: null });
    } catch (error) {
      logger?.warn(t('logs.windowNotifyFailed'), { reason: error.message });
    }
  };
}

/**
 * Запись списка получателей в состояние: цикл и уведомления о границах окна читают его,
 * чтобы знать чаты подтверждённых пользователей. Нужно и режиму `poll` (без команд).
 */
export async function syncTelegramRecipients({ store, telegramState, client = null }) {
  if (!store || !telegramState) return [];
  const recipients = [];
  for (const userId of telegramState.approvedUsers) {
    const chatId =
      telegramState.chatIdOf(userId) ??
      (telegramState.isOwner(userId) ? client?.chatId ?? telegramState.chatId : null);
    if (!Number.isFinite(Number(chatId))) continue;
    recipients.push({ userId: Number(userId), chatId: Number(chatId) });
  }
  await store.writeState({ telegram: { recipients } });
  return recipients;
}

async function loadFixtures(dir) {
  const target = resolve(dir);
  if (!existsSync(target)) throw new Error(`Папка fixtures не найдена: ${target}`);
  const names = (await readdir(target)).filter((name) => name.endsWith('.html')).sort();
  const files = [];
  for (const name of names) {
    files.push({ name, html: await readFile(resolve(target, name), 'utf8') });
  }
  return files;
}

async function dryRun({ rootDir, logger, fixturesDir = 'test/fixtures', useFixtures = true }) {
  const { config, profile, store, parser, modelAdapter, categoryCatalog, texts } = await bootstrap({ rootDir, logger });
  const results = [];
  let sent = 0;
  let skipped = 0;

  const sources = useFixtures
    ? await loadFixtures(resolve(rootDir, fixturesDir))
    : [{ name: '(inline)', html: '<html><body></body></html>' }];

  for (const fixture of sources) {
    const parsed = parser.parse(fixture.html, { sourceUrl: 'https://kwork.ru/projects', referenceDate: new Date() });
    logger.info(
      texts.t('cli.dryRunFixture', {
        name: fixture.name,
        cards: parsed.jobs.length,
        strategy: parsed.structure.strategy ?? texts.t('cli.dryRunStrategyUnknown')
      })
    );
    // Категория берётся из каталога сайта — так же, как в рабочем цикле.
    const jobs = categoryCatalog ? parsed.jobs.map((job) => applyCategoryName(job, categoryCatalog)) : parsed.jobs;
    for (const job of jobs) {
      if (!job.category) {
        skipped += 1;
        logger.info(
          texts.t('cli.dryRunSkipped', { title: job.title ?? texts.t('cli.dryRunNoTitle') })
        );
        continue;
      }
      const duplicate = store.isProcessed(job);
      const analysis = await analyzeAndDraft(job, profile, { modelAdapter, config, texts });
      const message = renderJobMessage(job, analysis, { texts });
      results.push({
        fixture: fixture.name,
        id: job.id,
        title: job.title,
        verdict: analysis.verdict,
        duplicate: duplicate.isDuplicate,
        message
      });
      if (!duplicate.isDuplicate) sent += 1;
    }
  }

  process.stdout.write(
    results
      .map(
        (entry) =>
          `\n${texts.t('cli.dryRunEntry', {
            fixture: entry.fixture,
            id: entry.id ?? '—',
            verdict: entry.verdict,
            duplicate: entry.duplicate
          })}\n${entry.message}`
      )
      .join('\n')
  );
  process.stdout.write(
    `\n\n${texts.t('cli.dryRunTotals', { total: results.length, fresh: sent, skipped })}\n`
  );
  return { code: 0, results };
}

async function runDashboard({ rootDir, logger, port = 8787, host = '127.0.0.1' }) {
  // Dashboard без аутентификации отдаёт состояние (включая id чатов получателей),
  // поэтому на внешний интерфейс его выставлять нельзя — только loopback.
  const isLocalOnly = ['127.0.0.1', 'localhost', '::1'].includes(String(host));
  if (!isLocalOnly) {
    throw new Error(
      `Dashboard не имеет аутентификации и не может слушать внешний адрес: ${host}. Используйте 127.0.0.1 и туннель SSH.`
    );
  }
  const { config, profile, store, categoryCatalog, texts } = await bootstrap({ rootDir, logger });
  const catalogList = categoryCatalog.list();
  const server = createServer(async (request, response) => {
    if (request.url === '/api/state') {
      const state = await store.readState();
      const body = JSON.stringify(
        {
          plan: buildPollPlan({ base: baseUrlOf(config) }),
          schedule: config.schedule,
          categories: catalogList,
          stats: store.stats,
          state
        },
        null,
        2
      );
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(body);
      return;
    }
    const state = await store.readState();
    const recent = await store.readProcessedTail(20);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      buildDashboardHtml({
        plan: buildPollPlan({ base: baseUrlOf(config) }),
        schedule: config.schedule,
        categories: catalogList,
        profile,
        stats: store.stats,
        state,
        recent,
        timezone: config.schedule.timezone,
        texts
      })
    );
  });
  await new Promise((resolvePromise) => server.listen(port, host, resolvePromise));
  logger.info(texts.t('logs.dashboardAvailable', { url: `http://${host}:${port}` }));
  logger.info(texts.t('logs.dashboardReadOnly'));
  return server;
}
async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const logger = createLogger({ level: flags.logLevel ?? 'info' });

  switch (command) {
    case 'config-check': {
      const { config, profile, validation } = loadConfig({ rootDir, requireLiveSource: flags.live === true });
      const pre = preflight(config, { requireLiveSource: flags.live === true });
      const telegram = validateTelegramSecrets(config.secrets);
      const model = validateModelSecrets(config.model, config.secrets);
      const texts = createTexts({ rootDir, overrideFile: config.secrets.textsFile ?? null });
      process.stdout.write(`${describePlan(config, { texts })}\n\n`);
      process.stdout.write(`${texts.t('cli.configCheckPlanHeader')}\n`);
      for (const warning of validation.warnings) {
        process.stdout.write(`${texts.t('cli.configCheckWarning', { text: warning })}\n`);
      }
      for (const error of [...validation.errors, ...pre.errors]) {
        process.stdout.write(`${texts.t('cli.configCheckError', { text: error })}\n`);
      }
      process.stdout.write(`\n${texts.t('cli.configCheckTelegram')}\n`);
      for (const item of [...telegram.errors, ...telegram.warnings, ...model.errors, ...model.warnings]) {
        process.stdout.write(`${texts.t('cli.configCheckItem', { text: item })}\n`);
      }
      process.stdout.write(
        `\n${texts.t('cli.configCheckResult', {
          text: validation.ok && pre.ok ? texts.t('cli.configCheckOk') : texts.t('cli.configCheckFailed')
        })}\n`
      );
      return validation.ok && pre.ok ? 0 : 2;
    }
    case 'plan': {
      const { config } = loadConfig({ rootDir });
      const texts = createTexts({ rootDir, overrideFile: config.secrets.textsFile ?? null });
      process.stdout.write(`${describePlan(config, { texts })}\n`);
      return 0;
    }
    case 'status': {
      const { config, store } = await bootstrap({ rootDir, logger });
      const state = await store.readState();
      const texts = createTexts({ rootDir, overrideFile: config.secrets.textsFile ?? null });
      const recent = await store.readProcessedTail(10);
      process.stdout.write(`${texts.t('cli.statusStorage')}\n`);
      process.stdout.write(`${texts.t('cli.statusActiveJobs', { count: store.stats.total })}\n`);
      process.stdout.write(
        `${texts.t('cli.statusKeys', {
          total: store.stats.keyTotal,
          stableId: store.stats.stableIdKeys,
          url: store.stats.urlKeys,
          composite: store.stats.compositeKeys
        })}\n`
      );
      process.stdout.write(`${texts.t('cli.statusIndexUpdated', { date: store.stats.updatedAt ?? '—' })}\n`);
      process.stdout.write(`${texts.t('cli.statusState', { json: JSON.stringify(state, null, 2) })}\n`);
      process.stdout.write(`${texts.t('cli.statusRecent')}\n`);
      for (const entry of recent) {
        process.stdout.write(
          `${texts.t('cli.statusRecentEntry', { date: entry.recordedAt, id: entry.id ?? entry.url, title: entry.title })}\n`
        );
      }
      const urls = allProjectsUrl(baseUrlOf(config));
      process.stdout.write(
        `${texts.t('cli.statusAllowedUrls', { urls: urls || texts.t('cli.statusAllowedUrlsNone') })}\n`
      );
      return 0;
    }
    case 'categories': {
      const { config, store, categoryCatalog, texts } = await bootstrap({ rootDir, logger });
      const recent = await store.readProcessedTail(500);
      const counts = new Map();
      for (const entry of recent) {
        const ids = entry.payload?.kworkCategoryId ?? entry.kworkCategoryId;
        const list = Array.isArray(ids) ? ids : [ids];
        for (const id of list) {
          if (id === null || id === undefined) continue;
          const key = String(id);
          if (!counts.has(key)) counts.set(key, { count: 0, titles: [] });
          const bucket = counts.get(key);
          bucket.count += 1;
          if (bucket.titles.length < 2) bucket.titles.push(entry.title);
        }
      }
      process.stdout.write(`${texts.t('cli.categoriesTitle')}\n`);
      if (counts.size === 0) {
        process.stdout.write(`${texts.t('cli.categoriesEmpty')}\n`);
      } else {
        for (const [id, bucket] of [...counts.entries()].sort((a, b) => b[1].count - a[1].count)) {
          process.stdout.write(
            `${texts.t('cli.categoriesEntry', { id, count: bucket.count, titles: bucket.titles.join(' | ') })}\n`
          );
        }
      }
      process.stdout.write(
        `\n${texts.t('cli.categoriesTotals', { total: store.stats.total, categories: counts.size })}\n`
      );
      // Сверка встреченных id с каталогом сайта: список категорий живёт только там,
      // выбор — персональный (data/categories/<userId>.json).
      const catalog = categoryCatalog;
      const unknown = [...counts.keys()].filter((id) => !catalog.has(Number(id)));
      process.stdout.write(`\n${texts.t('cli.categoriesCatalogTitle')}\n`);
      process.stdout.write(`${texts.t('cli.categoriesCatalogTotal', { total: catalog.list().length })}\n`);
      if (unknown.length > 0) {
        process.stdout.write(`${texts.t('cli.categoriesUnknown', { ids: unknown.join(', ') })}\n`);
      }
      return 0;
    }
    case 'reset': {
      const { config, store, texts } = await bootstrap({ rootDir, logger });
      const targets = [
        store.paths.index,
        store.paths.state,
        store.paths.messages
      ];
      const existing = targets.filter((file) => existsSync(file));
      const keepHistory = flags.hard !== true;
      if (existing.length === 0) {
        process.stdout.write(`${texts.t('cli.resetNothing')}\n`);
        return 0;
      }
      if (flags.yes !== true) {
        process.stdout.write(
          `${texts.t('cli.resetConfirm', {
            files: existing.map((file) => file.replace(`${rootDir}/`, '')).join(', '),
            history: store.paths.processed.replace(`${rootDir}/`, '')
          })}\n`
        );
        return 2;
      }
      let removed = 0;
      for (const file of existing) {
        await unlink(file);
        removed += 1;
      }
      if (!keepHistory && existsSync(store.paths.processed)) {
        await unlink(store.paths.processed);
        removed += 1;
        process.stdout.write(`${texts.t('cli.resetHard')}\n`);
      }
      process.stdout.write(`${texts.t('cli.resetDone', { removed })}\n`);
      return 0;
    }
    case 'categories-refresh': {
      const { config, texts, categoryCatalogFile } = await bootstrap({ rootDir, logger });
      const t = (path, params) => texts.t(path, params);
      logger.info(t('cli.refreshTitle'));

      // Источник: сохранённый HTML (--file) или один GET на страницу списка заданий.
      let html = null;
      let source = null;
      if (flags.file) {
        html = await readFile(resolve(rootDir, flags.file), 'utf8');
        source = resolve(rootDir, flags.file);
      } else {
        const target = allProjectsUrl(baseUrlOf(config));
        source = target;
        const response = await fetch(target, {
          headers: { 'user-agent': config.source.userAgent, accept: 'text/html,application/xhtml+xml' }
        });
        if (!response.ok) {
          process.stderr.write(`${t('cli.refreshNoSource')} HTTP ${response.status}\n`);
          return 2;
        }
        html = await response.text();
      }

      const parsed = parseCategoryCatalog(html, { source });
      if (parsed.categories.length === 0) {
        process.stderr.write(`${t('cli.refreshNoSource')} ${parsed.error ?? ''}\n`);
        return 2;
      }
      const payload = {
        note: 'Полный каталог категорий Kwork. Обновляется командой: node src/index.js categories-refresh',
        source: parsed.updatedFrom,
        urlScheme: {
          category: '/projects?c=<id>',
          attribute: '/projects?c=<id>&attr=<id>',
          note: 'Числовой id совпадает с полем category_id в выдаче заданий.'
        },
        counts: {
          sections: parsed.sections.length,
          categories: parsed.categories.length,
          attributes: parsed.categories.reduce((sum, category) => sum + category.attributes.length, 0)
        },
        updatedAt: new Date().toISOString().slice(0, 10),
        sections: parsed.sections,
        categories: parsed.categories
      };
      const file = await saveCategoryCatalogFile(categoryCatalogFile, payload);
      process.stdout.write(`${t('cli.refreshSource', { source })}\n`);
      process.stdout.write(
        `${t('cli.refreshDone', {
          file,
          sections: payload.counts.sections,
          categories: payload.counts.categories,
          attributes: payload.counts.attributes
        })}\n`
      );
      return 0;
    }
    case 'dry-run': {
      const result = await dryRun({ rootDir, logger, fixturesDir: flags.fixtures ?? 'test/fixtures' });
      return result.code;
    }
    case 'poll':
    case 'bot': {
      // Конфигурацию читаем до клиента: chat id и dataDir нужны для уведомлений.
      const preloaded = loadConfig({ rootDir, requireLiveSource: true }).config;
      const tgSecrets = validateTelegramSecrets(preloaded.secrets);
      if (!tgSecrets.ok) {
        for (const error of tgSecrets.errors) logger.error(error);
        return 2;
      }

      const telegramState = await new TelegramState({
        dataDir: preloaded.dataDir,
        file: flags.telegramState,
        ownerId: preloaded.secrets.telegramAllowedUserId ?? null
      }).init();

      const client = new TelegramClient({
        token: preloaded.secrets.telegramBotToken,
        allowedUserId: preloaded.secrets.telegramAllowedUserId,
        chatId: preloaded.secrets.telegramChatId ?? telegramState.chatId,
        telegramState,
        autoApprove: preloaded.telegram?.autoApprove !== false,
        logger
      });

      const {
        config,
        profile,
        profiles,
        profileTemplate,
        categories,
        categoryCatalog,
        categoryCatalogFile,
        validation,
        store,
        parser,
        modelAdapter,
        source,
        cycleRunner,
        texts
      } =
        await bootstrap({
          rootDir,
          requireLiveSource: true,
          logger,
          notifier: client
        });
      await syncTelegramRecipients({ store, telegramState, client });
      const pre = preflight(config, { requireLiveSource: true });
      if (!validation.ok || !pre.ok) {
        logger.error(texts.t('logs.startupCancelled'));
        for (const error of pre.errors) logger.error(error);
        process.stdout.write(`${describePlan(config, { texts })}\n`);
        return 2;
      }

      // Режиму poll chat id нужен сразу: он не принимает команды, значит узнать чат негде.
      // Режиму bot он не нужен — владелец напишет /start, и чат станет известен при первом же опросе.
      if (!client.initialized && command === 'poll') {
        logger.error(texts.t('logs.chatIdUnknownPoll'));
        return 2;
      }
      if (!client.initialized) {
        logger.info(texts.t('logs.chatIdUnknownBotStart'));
      }

      const scheduler = await createScheduler({
        config,
        cycleRunner,
        store,
        logger,
        notifier: client,
        telegramClient: client,
        texts
      });
      const bot = new KworkWatcherBot({
        config,
        profile,
        profiles,
        profileTemplate,
        categories,
        categoryCatalog,
        categoryCatalogFile,
        store,
        scheduler,
        client,
        logger,
        modelInfo: modelAdapter.label ?? modelAdapter.provider,
        modelUsage: typeof modelAdapter.usage === 'object' ? modelAdapter.usage : null,
        telegramState,
        persistedOffset: telegramState.offset,
        texts
      });

      const shutdown = async (signal) => {
        logger.info(texts.t('logs.stoppingOnSignal', { signal }));
        await telegramState.save({ offset: client.offset, chatId: client.chatId });
        await bot.stop();
        process.exit(0);
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));

      process.stdout.write(`${describePlan(config, { texts })}\n\n`);
      logger.info(texts.t('logs.startupMode', { mode: command }), {
        mode: command,
        model: modelAdapter.provider,
        notifications: client.initialized ? texts.t('logs.notificationsOn') : texts.t('logs.notificationsOff')
      });
      await bot.start({ runSchedulerLoop: true });
      return 0;
    }
    case 'dashboard': {
      const server = await runDashboard({ rootDir, logger, port: Number(flags.port ?? 8787), host: flags.host ?? '127.0.0.1' });
      // Сервер должен жить до сигнала: иначе процесс завершится сразу после запуска.
      await new Promise((resolvePromise) => {
        const shutdown = () => {
          logger.info(texts.t('logs.dashboardStopping'));
          server.close(() => resolvePromise(0));
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      });
      return 0;
    }
    default:
      const helpTexts = createTexts({ rootDir });
      process.stdout.write(`${helpTexts.lines('cli.help').join('\n')}\n`);
      process.stdout.write('\n');
      return command === 'help' ? 0 : 1;
  }
}

/**
 * Текст сообщения об ошибке для CLI.
 *
 * Отдельная функция, потому что здесь была неприятная ошибка: при недоступном файле
 * текстов в вывод попадал сам шаблон «Ошибка: {message}» вместо причины сбоя.
 * Теперь причина подставляется всегда.
 */
export function formatCliError(error, { rootDir = process.cwd() } = {}) {
  const reason = error?.message || String(error ?? '') || error?.constructor?.name || 'неизвестная ошибка';
  try {
    const formatted = createTexts({ rootDir }).t('cli.error', { message: reason });
    return formatted.includes('{message}') ? `Ошибка: ${reason}` : formatted;
  } catch {
    return `Ошибка: ${reason}`;
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main()
    .then((code) => {
      process.exit(code ?? 0);
    })
    .catch((error) => {
      process.stderr.write(`${formatCliError(error, { rootDir })}\n`);
      // Трассировка полезна при разборе, но по умолчанию не мешает.
      if (process.env.DSH_DEBUG_ERRORS === '1' && error?.stack) {
        process.stderr.write(`${error.stack}\n`);
      } else {
        process.stderr.write('Подробности: DSH_DEBUG_ERRORS=1 node src/index.js <команда>\n');
      }
      process.exit(1);
    });
}

export { main, bootstrap, createScheduler, dryRun, runDashboard };
