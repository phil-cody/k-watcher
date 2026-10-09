/**
 * Telegram-бот: команды пользователя и запуск планировщика в одном процессе.
 *
 * Границы:
 *  - бот отвечает только пользователю TELEGRAM_ALLOWED_USER_ID;
 *  - бот умеет ровно три вещи: показать состояние, поставить опрос на паузу,
 *    возобновить опрос. Никаких действий на Kwork он не выполняет.
 */

import { formatInZone } from '../util/time.js';
import { SCHEDULER_STATE } from '../scheduler/scheduler.js';
import { createHash } from 'node:crypto';
import { resolveCategoryInput } from '../storage/category-store.js';
import { buildPollPlan, allProjectsUrl } from '../source/poll-plan.js';
import { createTexts, format } from '../texts/texts.js';

/** Описание плана опроса — показывается пользователю перед живым запуском. */
export function describePlan(config, { texts = null, selection = null } = {}) {
  const textsObject = texts ?? createTexts({ rootDir: config.rootDir ?? process.cwd() });
  const t = (path, params) => textsObject.t(path, params);
  const source = config.source ?? {};
  const schedule = config.schedule ?? {};
  const lines = [];
  lines.push(t('commands.plan.title'));
  lines.push(`• ${t('commands.plan.timezone', { timezone: schedule.timezone })}`);
  lines.push(`• ${t('commands.plan.window', { start: schedule.windowStart, end: schedule.windowEnd })}`);
  lines.push(
    `• ${t('commands.plan.interval', { min: schedule.minIntervalSeconds, max: schedule.maxIntervalSeconds })}`
  );
  lines.push(
    schedule.firstRequestNoDelay === true
      ? `• ${t('commands.plan.firstRequestImmediate')}`
      : `• ${t('commands.plan.firstRequestDelayed')}`
  );
  lines.push(`• ${t('commands.plan.singleRequest')}`);
  const pagination = source.pagination ?? {};
  if (pagination.enabled === true && Number(pagination.maxPagesPerUrl ?? 1) > 1) {
    lines.push(`• ${t('commands.plan.pagesAuto', { max: Number(pagination.maxPagesPerUrl) })}`);
  } else {
    lines.push(`• ${t('commands.plan.pagesSingle')}`);
  }
  // План опроса: зависит от выбранных категорий.
  const base = String(source.baseUrl ?? 'https://kwork.ru').replace(/\/+$/, '');
  const plan = buildPollPlan({ base, selection });
  lines.push('');
  lines.push(
    t(plan.mode === 'categories' ? 'commands.plan.pollPlanCategories' : 'commands.plan.pollPlanAll', {
      count: plan.urls.length
    })
  );
  for (const entry of plan.urls) {
    const reason = t(`commands.plan.pollPlanReasons.${entry.reason}`);
    lines.push(`• ${t('commands.plan.pollPlanUrl', { url: entry.url, reason })}`);
  }
  lines.push('');
  lines.push(t('commands.plan.baseUrl', { url: allProjectsUrl(base) }));
  // Список категорий в конфиге не хранится: он персональный (data/categories/<id>.json)
  // и виден в самом плане опроса выше. Здесь только подсказка, где его менять.
  lines.push(t('commands.plan.categoriesHint'));
  lines.push('');
  lines.push(
    t('commands.plan.permission', { status: source.permission?.status ?? t('commands.plan.permissionNone') })
  );
  if (source.permission?.scope) lines.push(t('commands.plan.scope', { text: source.permission.scope }));
  if (source.permission?.scopeChanges?.length) {
    lines.push(t('commands.plan.scopeChanges'));
    for (const change of source.permission.scopeChanges) {
      lines.push(`— ${t('commands.plan.scopeChange', { date: change.at, text: change.change })}`);
    }
  }
  if (source.permission?.notCovered?.length) {
    lines.push(t('commands.plan.notCovered'));
    for (const item of source.permission.notCovered) lines.push(`— ${item}`);
  }
  lines.push('');
  lines.push(t('commands.plan.noHtml'));
  return lines.join('\n');
}

/** Текст ответа на /start. */
export function buildStartMessage({ config, profile, schedulerState = null, texts = null }) {
  const textsObject = texts ?? createTexts({ rootDir: config?.rootDir ?? process.cwd() });
  const templates = Array.isArray(textsObject.data?.commands?.start) ? textsObject.data.commands.start : [];
  const lines = [];
  for (const template of templates) {
    if (typeof template !== 'string') continue;
    // Строку о состоянии показываем только при живом планировщике.
    // Фильтруем по плейсхолдеру {status}, а не по русскому тексту — иначе смена
    // формулировки в texts.json молча сломает логику.
    if (template.includes('{status}') && !schedulerState) continue;
    lines.push(
      format(template, {
        headline: profile?.headline ?? '—',
        status: schedulerState?.status ?? ''
      })
    );
  }
  // Убираем пустую строку, оставшуюся от блока про состояние.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** Текст ответа на /status. */
export function buildStatusMessage({
  store,
  schedulerState,
  modelInfo = null,
  modelUsage = null,
  lastSummary = null,
  texts = null,
  config = null
}) {
  const textsObject = texts ?? createTexts({ rootDir: config?.rootDir ?? process.cwd() });
  const t = (path, params) => textsObject.t(path, params);
  const lines = [t('commands.statusTitle')];
  if (schedulerState) {
    lines.push(`• ${t('commands.statusScheduler', { status: schedulerState.status })}`);
    if (schedulerState.pausedByUser) lines.push(`• ${t('commands.statusPausedByUser')}`);
    if (schedulerState.stopMessage) lines.push(`• ${t('commands.statusExplanation', { text: schedulerState.stopMessage })}`);
    if (schedulerState.stopReason) lines.push(`• ${t('commands.statusStopReason', { reason: schedulerState.stopReason })}`);
    lines.push(`• ${t('commands.statusRequestCount', { count: schedulerState.requestCount })}`);
    lines.push(`• ${t('commands.statusWindow', { window: schedulerState.window, timezone: schedulerState.timezone })}`);
    lines.push(
      `• ${t('commands.statusInterval', { min: schedulerState.intervalSeconds?.[0], max: schedulerState.intervalSeconds?.[1] })}`
    );
    if (schedulerState.lastRequestAt) {
      lines.push(
        `• ${t('commands.statusLastRequest', { date: formatInZone(new Date(schedulerState.lastRequestAt), schedulerState.timezone) })}`
      );
    }
    if (schedulerState.nextRequestAt) {
      lines.push(
        `• ${t('commands.statusNextRequest', { date: formatInZone(new Date(schedulerState.nextRequestAt), schedulerState.timezone) })}`
      );
    }
    if (schedulerState.lastError) {
      lines.push(`• ${t('commands.statusLastError', { message: schedulerState.lastError.message })}`);
    }
  } else {
    lines.push(`• ${t('commands.statusNoScheduler')}`);
  }
  if (store) {
    const stats = store.stats;
    lines.push(`• ${t('commands.statusActiveJobs', { count: stats.total })}`);
    lines.push(
      `• ${t('commands.statusKeys', {
        total: stats.keyTotal,
        stableId: stats.stableIdKeys,
        url: stats.urlKeys,
        composite: stats.compositeKeys
      })}`
    );
  }
  if (lastSummary) {
    lines.push(
      `• ${t('commands.statusLastCycle', {
        cards: lastSummary.cardsFound,
        inTargets: lastSummary.inTargetCategories,
        newJobs: lastSummary.newJobs,
        duplicates: lastSummary.duplicates,
        sent: lastSummary.sent
      })}`
    );
    if (lastSummary.pruned !== undefined) lines.push(`• ${t('commands.statusPruned', { count: lastSummary.pruned })}`);
    if (lastSummary.activeJobs !== undefined) {
      lines.push(`• ${t('commands.statusActiveAfter', { count: lastSummary.activeJobs })}`);
    }
  }
  if (modelInfo) lines.push(`• ${t('commands.statusModel', { model: modelInfo })}`);
  if (modelUsage) {
    lines.push(
      `• ${t('commands.statusModelUsage', {
        dayUsed: modelUsage.dayCount,
        dayLimit: modelUsage.limits?.perDay === null || modelUsage.limits?.perDay === undefined
          ? ' (без лимита)'
          : ` из ${modelUsage.limits.perDay}`,
        hourUsed: modelUsage.hourCount,
        hourLimit: modelUsage.limits?.perHour === null || modelUsage.limits?.perHour === undefined
          ? ' (без лимита)'
          : ` из ${modelUsage.limits.perHour}`
      })}`
    );
  }
  return lines.join('\n');
}

export function buildProfileMessage({ profile, config, texts = null }) {
  const textsObject = texts ?? createTexts({ rootDir: config?.rootDir ?? process.cwd() });
  const t = (path, params) => textsObject.t(path, params);
  const lines = [t('commands.profileTitle')];
  lines.push(`• ${t('commands.profileHeadline', { headline: profile?.headline ?? '—' })}`);
  lines.push(`• ${t('commands.profileSkills', { skills: (profile?.skills ?? []).join(', ') || '—' })}`);
  lines.push(
    `• ${t('commands.profileMinimum', {
      price: profile?.pricing?.minimum_project_price ?? '—',
      currency: profile?.pricing?.currency ?? ''
    })}`
  );
  lines.push(`• ${t('commands.profilePricingNotes', { notes: profile?.pricing?.pricing_notes ?? '—' })}`);
  lines.push(`• ${t('commands.profilePortfolio', { count: (profile?.portfolio ?? []).length })}`);
  lines.push(`• ${t('commands.profileTimezone', { timezone: profile?.availability?.timezone ?? '—' })}`);
  lines.push(`• ${t('commands.profileDeadline', { days: profile?.availability?.preferred_deadline_days ?? '—' })}`);
  lines.push(`• ${t('commands.profileHours', { hours: profile?.availability?.hours_per_week ?? '—' })}`);
  lines.push(`• ${t('commands.profileTone', { tone: profile?.proposal_preferences?.tone ?? '—' })}`);
  lines.push('');
  // Путь к файлу не показываем: профиль у каждого свой и лежит внутри приложения.
  lines.push(t('commands.profileEditHint'));
  return lines.join('\n');
}

/**
 * Список команд для меню Telegram (`setMyCommands`).
 * Описания берутся из config/texts.json → commands.telegramMenu, поэтому их можно
 * менять без правки кода. Необязательный фильтр — config.telegram.menuFilter.
 * Сама публикация — в `publishTelegramCommands`.
 */
export function buildTelegramCommands({ texts = null, config = null, owner = false } = {}) {
  const textsObject = texts ?? createTexts({ rootDir: process.cwd() });
  const menu = owner
    ? textsObject.data?.commands?.telegramMenuOwner ?? textsObject.data?.commands?.telegramMenu
    : textsObject.data?.commands?.telegramMenu;
  if (!Array.isArray(menu)) return [];
  const filter = Array.isArray(config?.telegram?.menuFilter) ? config.telegram.menuFilter.map((item) => String(item)) : [];
  const allowed = filter.length > 0 ? filter : null;
  return menu
    .map((entry) => (Array.isArray(entry) ? { command: entry[0], description: entry[1] } : entry))
    .filter((entry) => entry?.command && entry?.description)
    .filter((entry) => !allowed || allowed.includes(String(entry.command)))
    .map((entry) => ({ command: String(entry.command), description: String(entry.description) }));
}

/** Короткий отпечаток набора команд: по нему понимаем, нужно ли публиковать заново. */
export function commandsFingerprint(commands) {
  const normalized = (commands ?? [])
    .map((item) => `${item.command}\u0000${item.description}`)
    .join('\u0001');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Публикация меню: общий набор — всем, расширенный набор владельца — только его чату.
 * Права в интерфейсе Telegram не поддерживаются, поэтому используем два вызова setMyCommands
 * с разными scope: default (все) и chat (конкретный чат владельца).
 */
export async function publishTelegramCommands({
  client,
  texts = null,
  config = null,
  logger = null,
  ownerChatId = null,
  telegramState = null
}) {
  if (!client || typeof client.publishCommands !== 'function') return false;
  const textsObject = texts ?? createTexts({ rootDir: process.cwd() });
  const general = buildTelegramCommands({ texts, config, owner: false });
  const ownerMenu = buildTelegramCommands({ texts, config, owner: true });
  const ownerChat = Number.isFinite(Number(ownerChatId)) && ownerChatId !== null ? Number(ownerChatId) : null;

  // Уже опубликованные наборы запоминаем: Telegram не нужно получать одно и то же
  // при каждом запуске. При смене набора или имени команды отпечаток изменится.
  const published = telegramState?.publishedMenus ?? {};
  const generalPrint = commandsFingerprint(general);
  const ownerPrint = ownerChat ? commandsFingerprint(ownerMenu) : null;

  const plan = [];
  if (general.length > 0 && published.general !== generalPrint) {
    plan.push({ scope: 'general', commands: general, chatId: null, fingerprint: generalPrint });
  }
  if (ownerChat && ownerMenu.length > general.length && published.owner !== ownerPrint) {
    plan.push({ scope: 'owner', commands: ownerMenu, chatId: ownerChat, fingerprint: ownerPrint });
  }
  // Старое меню владельца нужно убрать, если его чат больше не известен.
  const staleOwnerMenu = !ownerChat && published.owner;

  if (plan.length === 0 && !staleOwnerMenu) {
    logger?.info(textsObject.t('logs.telegramCommandsUnchanged', { count: general.length }));
    return true;
  }

  let ok = plan.length === 0;
  try {
    for (const step of plan) {
      await client.publishCommands(step.commands, { chatId: step.chatId });
      ok = true;
      logger?.info(
        textsObject.t(
          step.scope === 'owner' ? 'logs.telegramOwnerCommandsPublished' : 'logs.telegramCommandsPublished',
          { count: step.commands.length }
        )
      );
      const next = { ...(telegramState?.publishedMenus ?? {}), [step.scope]: step.fingerprint };
      if (step.scope === 'owner') next.ownerChatId = step.chatId;
      await telegramState?.save({ publishedMenus: next });
    }
    if (staleOwnerMenu) {
      await client.deleteCommands({ chatId: Number(published.ownerChatId) }).catch(() => {});
      await client.deleteCommands().catch(() => {});
      const next = { ...(telegramState?.publishedMenus ?? {}) };
      delete next.owner;
      delete next.ownerChatId;
      await telegramState?.save({ publishedMenus: next });
    }
  } catch (error) {
    logger?.warn(textsObject.t('logs.telegramCommandsFailed'), { reason: error.message });
    return false;
  }
  return ok;
}

/**
 * Отчёт об использовании приложения — только для владельца.
 * Собирает: пользователей, профили, категории, задания, расход модели и токенов.
 */
export async function buildUsageMessage({
  store = null,
  telegramState = null,
  profiles = null,
  categories = null,
  modelInfo = null,
  modelUsage = null,
  texts = null
} = {}) {
  const textsObject = texts ?? createTexts({ rootDir: process.cwd() });
  const t = (path, params) => textsObject.t(path, params);
  const lines = [t('commands.usage.title')];

  // Пользователи.
  const approved = telegramState?.approvedUsers ?? [];
  lines.push(
    t('commands.usage.users', {
      approved: approved.length,
      owner: telegramState?.primaryUserId ?? '—'
    })
  );

  // Профили и категории.
  if (profiles?.summarize && approved.length > 0) {
    const summary = await profiles.summarize(approved);
    const withProfile = summary.filter((item) => item.hasProfile).length;
    lines.push(t('commands.usage.profiles', { withProfile, approved: approved.length }));
  }
  if (categories?.get && approved.length > 0) {
    let withCategories = 0;
    for (const userId of approved) {
      const selection = await categories.get(userId);
      if (selection !== null) withCategories += 1;
    }
    lines.push(t('commands.usage.categories', { withCategories, approved: approved.length }));
  }

  // Хранилище заданий.
  if (store?.stats) lines.push(t('commands.usage.jobs', { active: store.stats.total }));

  // Метрики циклов.
  const state = store?.readState ? await store.readState() : null;
  const metrics = state?.metrics ?? null;
  if (metrics) {
    lines.push(
      t('commands.usage.cycle', {
        cycles: metrics.cycles ?? 0,
        requests: metrics.requests ?? 0,
        pages: metrics.pages ?? 0,
        cards: metrics.cards ?? 0,
        newJobs: metrics.newJobs ?? 0,
        duplicates: metrics.duplicates ?? 0,
        sentMessages: metrics.sentMessages ?? 0
      })
    );
    lines.push(
      t('commands.usage.errors', { errors: metrics.errors ?? 0, warnings: metrics.warnings ?? 0 })
    );
    if (Number(metrics.reminders ?? 0) > 0) {
      lines.push(t('commands.usage.reminders', { reminders: metrics.reminders }));
    }
    if (metrics.firstRunAt) {
      lines.push(
        t('commands.usage.period', {
          firstRunAt: String(metrics.firstRunAt).slice(0, 16).replace('T', ' '),
          lastRunAt: String(metrics.lastRunAt ?? '—').slice(0, 16).replace('T', ' ')
        })
      );
    }
  } else {
    lines.push(t('commands.usage.noData'));
  }

  // Расход модели и токенов. Показываем то, что реально подключено.
  if (modelInfo) {
    const limits = modelUsage?.limits ?? {};
    lines.push(t('commands.usage.modelLine', { model: modelInfo }));
    lines.push(
      t('commands.usage.model', {
        provider: modelInfo,
        dayCalls: modelUsage?.dayCount ?? 0,
        dayLimit: limits.perDay === null || limits.perDay === undefined ? '' : ` из ${limits.perDay}`,
        hourCalls: modelUsage?.hourCount ?? 0,
        hourLimit: limits.perHour === null || limits.perHour === undefined ? '' : ` из ${limits.perHour}`,
        totalCalls: modelUsage?.totalCalls ?? 0
      })
    );
    const tokens = modelUsage?.tokens;
    if (tokens && (tokens.total > 0 || tokens.todayIn > 0 || tokens.todayOut > 0)) {
      lines.push(
        t('commands.usage.tokens', {
          todayIn: tokens.todayIn,
          todayOut: tokens.todayOut,
          totalIn: tokens.totalIn,
          totalOut: tokens.totalOut,
          total: tokens.total
        })
      );
    } else if (modelInfo !== 'heuristic') {
      lines.push(t('commands.usage.tokensUnknown'));
    }
  }

  lines.push(t('commands.usage.hint'));
  return lines.join('\n');
}

/**
 * Диспетчер команд. Чистая функция: принимает текст, возвращает текст ответа
 * и, при необходимости, действие для вызывающей стороны.
 */
export async function dispatchCommand(
  text,
  {
    config,
    profile,
    store,
    schedulerState,
    scheduler,
    modelInfo = null,
    modelUsage = null,
    lastSummary = null,
    telegramState = null,
    fromUserId = null,
    fromChatId = null,
    fromUsername = null,
    fromName = null,
    profileSource = null,
    categoriesPreferences = null,
    categoryCatalog = null,
    profiles = null,
    texts = null
  } = {}
) {
  const textsObject = texts ?? createTexts({ rootDir: config?.rootDir ?? process.cwd() });
  const t = (path, params) => textsObject.t(path, params);
  const raw = String(text ?? '').trim();
  if (!raw.startsWith('/')) return null;
  const [commandRaw, ...args] = raw.split(/\s+/);
  const command = commandRaw.slice(1).split('@')[0].toLowerCase();

  // Команды управления доступом — только владелец. Остальным их не показывают
  // в меню (см. publishTelegramCommands) и не выполняют.
  const OWNER_ONLY = new Set(['users', 'usage']);
  if (OWNER_ONLY.has(command) && telegramState && !telegramState.isOwner(fromUserId)) {
    return { action: null, reply: t('commands.onboarding.ownerOnly') };
  }

  switch (command) {
    case 'start':
      // Доступ открыт всем: подтверждение владельцем не требуется.
      if (telegramState) {
        const userId = Number(fromUserId);
        telegramState.rememberUser({
          userId,
          chatId: fromChatId ?? null,
          username: fromUsername,
          name: fromName
        });
        return {
          action: 'registered',
          reply:
            t('commands.onboarding.registeredTitle') +
            '\n\n' +
            textsObject.lines('commands.onboarding.welcomeBody', {
              who: telegramState.describeUser(userId)
            }).join('\n')
        };
      }
      return {
        action: null,
        reply: buildStartMessage({ config, profile, schedulerState, texts: textsObject })
      };
    case 'help':
      return {
        action: null,
        reply: buildStartMessage({ config, profile, schedulerState, texts: textsObject })
      };
    case 'users': {
      if (!telegramState) {
        return { action: null, reply: t('commands.unknownCommand', { command }) };
      }
      const approved = telegramState.approvedUsers;
      const lines = [t('commands.onboarding.usersTitle')];
      if (telegramState.primaryUserId) {
        lines.push(t('commands.onboarding.usersOwner', { who: telegramState.describeUser(telegramState.primaryUserId) }));
      }
      lines.push(
        approved.length > 0
          ? t('commands.onboarding.usersApproved', { list: approved.map((id) => telegramState.describeUser(id)).join('; ') })
          : t('commands.onboarding.usersNone')
      );
      lines.push(t('commands.onboarding.usersHint'));
      return { action: null, reply: lines.join('\n') };
    }
    case 'usage': {
      return {
        action: null,
        reply: await buildUsageMessage({
          store,
          telegramState,
          profiles,
          categories: categoriesPreferences,
          modelInfo,
          modelUsage,
          texts: textsObject
        })
      };
    }
    case 'categories': {
      if (!categoriesPreferences || !categoryCatalog) {
        return { action: null, reply: t('commands.categories.empty') };
      }
      const sub = String(args[0] ?? '').toLowerCase();

      // Показать каталог: /categories list [фильтр]
      if (sub === 'list') {
        const filter = args.slice(1).join(' ');
        const found = filter ? categoryCatalog.findByName(filter) : null;
        const entries = filter
          ? [
              ...found.categories.map((entry) => ({
                key: `c${entry.id}`,
                id: entry.id,
                label: entry.label,
                section: entry.section
              })),
              ...found.sections.flatMap((section) =>
                (section.categoryIds ?? []).map((categoryId) => {
                  const entry = categoryCatalog.entryOf(categoryId);
                  return {
                    key: `c${categoryId}`,
                    id: categoryId,
                    label: entry?.name ?? `Категория ${categoryId}`,
                    section: section.name
                  };
                })
              ),
              ...found.attributes.map((attribute) => ({
                key: `a${attribute.id}`,
                id: attribute.categoryId,
                label: `${attribute.title} (подраздел — ${attribute.categoryName})`,
                section: null
              }))
            ].filter((entry, index, list) => list.findIndex((item) => item.key === entry.key) === index)
          : categoryCatalog.list().map((entry) => ({ key: `c${entry.id}`, id: entry.id, label: entry.label, section: entry.section }));
        const lines = [t('commands.categories.catalogTitle')];
        for (const entry of entries.slice(0, 60)) {
          lines.push(
            t('commands.categories.catalogLine', {
              id: entry.id,
              label: entry.section ? `${entry.label} (${entry.section})` : entry.label
            })
          );
        }
        if (entries.length > 60) lines.push(t('commands.categories.more', { count: entries.length - 60 }));
        if (entries.length === 0) lines.push(t('commands.categories.empty'));
        lines.push(t('commands.categories.byText'));
        lines.push(t('commands.categories.usage'));
        return { action: null, reply: lines.join('\n') };
      }

      // Все категории: /categories all
      if (sub === 'all' || sub === 'все') {
        return { action: 'categories-set', selection: 'all', reply: t('commands.categories.all') };
      }

      // Сброс: /categories reset
      if (sub === 'reset' || sub === 'default') {
        return { action: 'categories-reset', reply: t('commands.categories.reset') };
      }

      // Выбор: /categories 37,38 или /categories Верстка, SEO аудиты
      if (args.length > 0) {
        const resolved = resolveCategoryInput(args, categoryCatalog);
        if (resolved.ids.length === 0) {
          return {
            action: null,
            reply: resolved.unknown.length > 0
              ? t('commands.categories.unknown', { ids: resolved.unknown.join('; ') })
              : t('commands.categories.empty')
          };
        }
        const known = resolved.ids.filter((id) => categoryCatalog.has(id));
        const unknownIds = resolved.ids.filter((id) => !categoryCatalog.has(id));
        const labels = resolved.ids
          .map((id) => (categoryCatalog.has(id) ? `${id} — ${categoryCatalog.labelOf(id)}` : `${id}`))
          .join(', ');
        const parts = [t('commands.categories.saved', { list: labels })];
        if (resolved.attributes.length > 0) {
          parts.push(
            t('commands.categories.resolved', {
              list: resolved.attributes
                .map((id) => categoryCatalog.attributes.get(Number(id))?.title ?? String(id))
                .join(', ')
            })
          );
        }
        if (unknownIds.length > 0 || resolved.unknown.length > 0) {
          parts.push(
            t('commands.categories.unknown', {
              ids: [...unknownIds.map(String), ...resolved.unknown].join('; ')
            })
          );
        }
        return { action: 'categories-set', selection: resolved.ids, attributes: resolved.attributes, reply: parts.join('\n') };
      }

      // Без аргументов: показать текущий выбор
      const current = await categoriesPreferences.effective(fromUserId);
      if (current.selection === 'all') {
        const allLines = [t('commands.categories.title'), t('commands.categories.all')];
        // Подсказки нужны и в режиме «все категории»: иначе непонятно, как их сузить.
        allLines.push(t('commands.categories.byText'));
        allLines.push(t('commands.categories.usage'));
        return { action: null, reply: allLines.join('\n') };
      }
      const lines = [t('commands.categories.title')];
      const describe = (id) => {
        const entry = categoryCatalog.entryOf(id);
        return entry ? `${id} — ${categoryCatalog.labelOf(id)}` : `${id} — своя категория`;
      };
      lines.push(t('commands.categories.current', { list: current.selection.map(describe).join(', ') }));
      if (current.source !== 'personal') lines.push(t('commands.categories.none'));
      const attributes = (fromUserId !== null ? await categoriesPreferences.get(fromUserId) : null) ?? null;
      if (Array.isArray(attributes) && attributes.length > 0) {
        // Подразделы показываем отдельно: они уточняют категорию.
        const attributeNames = [];
        for (const id of attributes) {
          for (const attribute of categoryCatalog.attributesOf(id)) attributeNames.push(attribute.title);
        }
        if (attributeNames.length > 0) {
          lines.push(t('commands.categories.resolved', { list: attributeNames.join(', ') }));
        }
      }
      lines.push(t('commands.categories.byText'));
      lines.push(t('commands.categories.usage'));
      return { action: null, reply: lines.join('\n') };
    }
    case 'status':
      return {
        action: null,
        reply: buildStatusMessage({
          store,
          schedulerState,
          modelInfo,
          modelUsage,
          lastSummary,
          texts: textsObject,
          config
        })
      };
    case 'plan': {
      // План зависит от выбора категорий: показываем актуальный для этого пользователя.
      let planSelection = null;
      if (categoriesPreferences && Number.isFinite(Number(fromUserId))) {
        const effective = await categoriesPreferences.effective(fromUserId);
        planSelection = effective.source === 'personal' ? effective.selection : null;
      }
      return { action: null, reply: describePlan(config, { texts: textsObject, selection: planSelection }) };
    }
    case 'profile': {
      const sub = String(args[0] ?? '').toLowerCase();
      if (sub === 'upload') {
        return { action: 'profile-upload', reply: t('commands.onboarding.profileUploadPrompt') };
      }
      if (sub === 'template') {
        return { action: 'profile-template', reply: t('commands.onboarding.profileTemplateSent') };
      }
      if (sub === 'reset' || sub === 'delete' || sub === 'remove') {
        return { action: 'profile-reset', reply: null };
      }
      if (sub === 'show') {
        const source = profileSource === 'personal'
          ? t('commands.onboarding.profileSourcePersonal')
          : t('commands.onboarding.profileSourceNone');
        return { action: null, reply: `${source}\n\n${buildProfileMessage({ profile, config, texts: textsObject })}` };
      }
      const extra = profileSource === 'personal'
        ? t('commands.onboarding.profileSourcePersonal')
        : t('commands.onboarding.profileMissing');
      return { action: null, reply: `${buildProfileMessage({ profile, config, texts: textsObject })}\n\n${extra}` };
    }
    case 'pause':
      if (scheduler) scheduler.pause('по команде пользователя');
      return { action: 'pause', reply: t('commands.pauseReply') };
    case 'resume':
      if (scheduler) scheduler.resume();
      return {
        action: 'resume',
        reply: t('commands.resumeReply', {
          min: config?.schedule?.minIntervalSeconds ?? 240,
          max: config?.schedule?.maxIntervalSeconds ?? 600,
          window: `${config?.schedule?.windowStart ?? '05:00'}–${config?.schedule?.windowEnd ?? '20:00'}`,
          timezone: config?.schedule?.timezone ?? 'Europe/Moscow'
        })
      };
    default:
      return { action: null, reply: t('commands.unknownCommand', { command }) };
  }
}

/** Проверка готовности к живому запуску. Возвращает { ok, errors, warnings }. */
export function preflight(config, { requireLiveSource = false } = {}) {
  const errors = [];
  const warnings = [];
  const source = config.source ?? {};

  if (requireLiveSource) {
    if (source.enabled !== true) errors.push('source.enabled = false. Включите источник только после подтверждения URL.');
    if (source.permission?.status !== 'confirmed') {
      errors.push('Нет подтверждения охвата разрешением Kwork (source.permission.status).');
    }
    if (!source.baseUrl) errors.push('source.baseUrl не задан: опрос некуда направлять.');
  }

  const min = config.schedule?.minIntervalSeconds;
  const max = config.schedule?.maxIntervalSeconds;
  if (min < 240 || max > 600) errors.push(`Интервал ${min}–${max} с вне подтверждённого диапазона 240–600 с.`);

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Оркестратор процесса: планировщик + long polling команд.
 * Параллелизм ограничен: цикл опроса строго последовательный, команды
 * обрабатываются между циклами (long polling не создаёт запросов к Kwork).
 */
export class KworkWatcherBot {
  constructor({
    config,
    profile,
    store,
    scheduler,
    client,
    logger = null,
    modelInfo = null,
    modelUsage = null,
    telegramState = null,
    profiles = null,
    profileTemplate = null,
    categories = null,
    categoryCatalog = null,
    pendingProfileUploads = null,
    now = () => Date.now(),
    persistedOffset = 0,
    texts = null
  }) {
    this.texts = texts ?? createTexts({ rootDir: config?.rootDir ?? process.cwd() });
    // Понятная ошибка вместо «this.scheduler.run is not a function»:
    // такое случается, если планировщик создан асинхронно и передан без await.
    if (scheduler && typeof scheduler.run !== 'function') {
      throw new TypeError(
        'scheduler должен быть объектом PollingScheduler с методом run(). Похоже, асинхронная фабрика планировщика вызвана без await.'
      );
    }
    this.config = config;
    this.telegramState = telegramState;
    this.persistedOffset = persistedOffset;
    this.profile = profile;
    this.store = store;
    this.scheduler = scheduler;
    this.client = client;
    this.logger = logger;
    this.modelInfo = modelInfo;
    this.modelUsage = modelUsage;
    this.profiles = profiles;
    // Шаблон профиля: отправляется пользователю по /profile template.
    this.profileTemplate = profileTemplate;
    // Персональные категории заданий.
    this.categories = categories;
    this.categoryCatalog = categoryCatalog;
    // Кто из пользователей ждёт загрузки профиля: { userId: expiresAt }.
    this.pendingProfileUploads = pendingProfileUploads ?? new Map();
    // Когда пользователь загружал профиль: защита от частых загрузок.
    this.profileUploadAttempts = new Map();
    // Часы процесса: внедряются в тестах, чтобы проверки времени были детерминированными.
    this.now = now;
    this.stopping = false;
    this.polling = false;
  }

  get state() {
    return this.scheduler ? this.scheduler.state : null;
  }

  /** Кто владелец: из реестра пользователей или из окружения. */
  get ownerId() {
    return this.telegramState?.primaryUserId ?? this.client?.allowedUserId ?? null;
  }

  /** Профиль и его источник для конкретного пользователя. */
  async profileFor(userId) {
    if (!this.profiles) return { profile: this.profile, source: this.profile ? 'fallback' : null };
    if (Number.isFinite(Number(userId))) {
      return this.profiles.get(userId);
    }
    return { profile: this.profile, source: this.profile ? 'fallback' : null };
  }

  async handleIncoming(message) {
    // Первое сообщение делает чат известным: без этого уведомления отправлять некуда.
    if (this.client && !this.client.chatId && message.chatId) {
      this.client.chatId = message.chatId;
    }
    // Новый пользователь подключился: обновляем список получателей и приветствуем.
    if (message.isNewUser) {
      await this.syncRecipients();
    }

    // Присланный файл обрабатываем, если этот пользователь запросил загрузку профиля.
    if (message.document) {
      const handled = await this.handleProfileDocument(message);
      if (handled) return handled;
      return null;
    }

    const { profile, source } = await this.profileFor(message.fromId);
    const result = await dispatchCommand(message.text, {
      config: this.config,
      // Профиль конкретного пользователя: у каждого он свой.
      profile,
      profileSource: source,
      store: this.store,
      schedulerState: this.state,
      scheduler: this.scheduler,
      modelInfo: this.modelInfo,
      modelUsage: this.modelUsage,
      telegramState: this.telegramState,
      fromUserId: message.fromId,
      fromChatId: message.chatId,
      fromUsername: message.username ?? null,
      fromName: message.name ?? null,
      categoriesPreferences: this.categories,
      categoryCatalog: this.categoryCatalog,
      profiles: this.profiles,
      texts: this.texts
    });
    if (!result) {
      this.logger?.debug(this.texts.t('logs.messageWithoutCommand'));
      return null;
    }
    // Ответ отправляем через reply: сбой сети или блокировки чата не должен
    // прерывать обработку команды — действие уже выполнено, запись состояния будет ниже.
    if (this.client && result.reply) {
      await this.reply(message.chatId, result.reply);
    }
    // /profile upload — ждём файл от этого пользователя 5 минут.
    if (result.action === 'profile-upload' && Number.isFinite(Number(message.fromId))) {
      this.pendingProfileUploads.set(Number(message.fromId), this.now() + 5 * 60 * 1000);
    }
    // /profile template — отправляем шаблон файлом.
    if (result.action === 'profile-template') {
      await this.sendProfileTemplate(message.chatId);
    }
    // /categories — сохраняем или сбрасываем персональный выбор категорий.
    if (result.action === 'categories-set' && this.categories) {
      await this.categories.set(message.fromId, result.selection);
      this.logger?.info(this.texts.t('logs.categoriesSaved'), {
        userId: message.fromId,
        selection: result.selection
      });
    }
    if (result.action === 'categories-reset' && this.categories) {
      await this.categories.remove(message.fromId);
      this.logger?.info(this.texts.t('logs.categoriesReset'), { userId: message.fromId });
    }
    // /profile reset — удаляем личный профиль. Общего профиля нет: без личного
    // задания не приходят, поэтому напоминаем, что нужно загрузить свой.
    if (result.action === 'profile-reset') {
      const removed = this.profiles ? await this.profiles.remove(message.fromId) : false;
      const text = removed
        ? `${this.texts.t('commands.onboarding.profileRemoved')}\n${this.texts.t('commands.onboarding.profileNoPersonal')}`
        : this.texts.t('commands.onboarding.profileMissing');
      await this.reply(message.chatId, text);
      return { action: 'profile-reset', removed };
    }
    return result;
  }

  /**
   * Запись списка получателей в состояние бота: планировщик и цикл читают его,
   * чтобы знать, кому отправлять уведомления и чей профиль использовать.
   */
  async syncRecipients() {
    if (!this.telegramState || !this.store) return [];
    const recipients = [];
    for (const userId of this.telegramState.approvedUsers) {
      const chatId = this.telegramState.chatIdOf(userId) ?? (this.telegramState.isOwner(userId) ? this.client?.chatId : null);
      if (!Number.isFinite(Number(chatId))) continue;
      recipients.push({ userId: Number(userId), chatId: Number(chatId) });
    }
    await this.store.writeState({ telegram: { recipients } });
    return recipients;
  }

  /**
   * Напоминание пользователю без профиля: не чаще одного раза в сутки.
   * Без профиля задания не отправляются, поэтому молчать нельзя.
   */
  async remindAboutProfile(userId, chatId) {
    if (!this.profiles || !this.client) return false;
    const chat = chatId ?? this.telegramState?.chatIdOf(userId) ?? null;
    if (!Number.isFinite(Number(chat))) return false;
    const allowed = await this.profiles.noteReminder(userId);
    if (!allowed.allowed) return false;
    await this.reply(chat, this.texts.t('commands.onboarding.profileReminder'));
    this.logger?.info(this.texts.t('logs.profileReminderSent'), { userId });
    return true;
  }

  /**
   * Ограничение частоты загрузок: не больше 5 попыток за 10 минут на пользователя.
   * Защита от перебора и от случайного «залил 200 файлов».
   */
  checkUploadRate(userId, { limit = 5, windowMs = 10 * 60 * 1000 } = {}) {
    const id = Number(userId);
    const now = this.now();
    const attempts = (this.profileUploadAttempts.get(id) ?? []).filter((at) => now - at < windowMs);
    if (attempts.length >= limit) {
      return { allowed: false, retryAfterMs: windowMs - (now - attempts[0]) };
    }
    attempts.push(now);
    this.profileUploadAttempts.set(id, attempts);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Ожидает ли этот пользователь загрузки профиля. */
  isWaitingForProfile(userId) {
    const expires = this.pendingProfileUploads.get(Number(userId));
    if (!expires) return false;
    if (expires < this.now()) {
      this.pendingProfileUploads.delete(Number(userId));
      return false;
    }
    return true;
  }

  /**
   * Обработка присланного файла: принимаем как профиль, только если пользователь
   * сам запросил загрузку (/profile upload). Иначе файл игнорируем.
   */
  async handleProfileDocument(message) {
    const userId = Number(message.fromId);
    if (!this.isWaitingForProfile(userId)) {
      this.logger?.debug(this.texts.t('logs.profileUploadRejected'), { userId, reason: 'not-requested' });
      return null;
    }
    // Ограничение частоты: до скачивания, чтобы не тратить трафик на флуд.
    const rate = this.checkUploadRate(userId);
    if (!rate.allowed) {
      this.pendingProfileUploads.delete(userId);
      const seconds = Math.ceil(rate.retryAfterMs / 1000);
      await this.reply(
        message.chatId,
        this.texts.t('commands.onboarding.profileRateLimited', { seconds })
      );
      this.logger?.warn(this.texts.t('logs.profileUploadRejected'), { userId, reason: 'rate-limit' });
      return { action: 'profile-rejected' };
    }
    this.pendingProfileUploads.delete(userId);

    if (!this.profiles || !this.client) {
      await this.reply(message.chatId, this.texts.t('commands.onboarding.profileNoTemplate'));
      return { action: 'profile-rejected' };
    }

    let text;
    try {
      const downloaded = await this.client.downloadFile(message.document.fileId, { maxBytes: 256 * 1024 });
      text = downloaded.text;
    } catch (error) {
      this.logger?.warn(this.texts.t('logs.profileUploadRejected'), { userId, reason: error.message });
      await this.reply(
        message.chatId,
        this.texts.t('commands.onboarding.profileDownloadFailed', { reason: error.message })
      );
      return { action: 'profile-rejected' };
    }

    const result = await this.profiles.import(userId, text, {
      fileName: message.document.fileName ?? null,
      mimeType: message.document.mimeType ?? null
    });
    if (!result.ok) {
      this.logger?.warn(this.texts.t('logs.profileUploadRejected'), { userId, reason: result.error });
      await this.reply(message.chatId, this.texts.t('commands.onboarding.profileInvalid', { reason: result.error }));
      return { action: 'profile-rejected' };
    }

    const profile = result.profile;
    // Если в профиле указан выбор категорий — применяем его.
    if (profile.categoriesSelection !== undefined && this.categories) {
      const selection = profile.categoriesSelection === 'all'
        ? 'all'
        : Array.isArray(profile.categoriesSelection)
          ? profile.categoriesSelection
          : null;
      if (selection !== null) {
        try {
          await this.categories.set(userId, selection);
        } catch (error) {
          this.logger?.warn(this.texts.t('logs.profileUploadRejected'), {
            userId,
            reason: `categories: ${error.message}`
          });
        }
      }
    }
    let reply = this.texts.t('commands.onboarding.profileSaved', {
      skills: (profile.skills ?? []).length,
      price: profile.pricing?.minimum_project_price ?? profile.pricing?.hourly_rate ?? '—',
      timezone: profile.availability?.timezone ?? '—'
    });
    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      reply += `\n${this.texts.t('commands.onboarding.profileSavedWarnings', { warnings: result.warnings.join('; ') })}`;
    }
    this.logger?.info(this.texts.t('logs.profileUploaded'), {
      userId,
      skills: (profile.skills ?? []).length,
      bytes: Buffer.byteLength(text, 'utf8')
    });
    await this.reply(message.chatId, reply);
    return { action: 'profile-saved' };
  }

  /** Отправка шаблона профиля файлом. */
  async sendProfileTemplate(chatId) {
    if (!this.client) return false;
    const template = this.profileTemplate;
    if (!template?.text) {
      await this.reply(chatId, this.texts.t('commands.onboarding.profileNoTemplate'));
      return false;
    }
    try {
      await this.client.sendDocument({
        chatId,
        fileName: 'performer-profile.template.json',
        content: template.text
      });
      return true;
    } catch (error) {
      this.logger?.warn(this.texts.t('logs.profileUploadRejected'), { reason: error.message });
      await this.reply(chatId, this.texts.t('commands.onboarding.profileNoTemplate'));
      return false;
    }
  }

  /** Короткая отправка сообщения в чат: ошибки не должны ломать обработку. */
  async reply(chatId, text) {
    if (!this.client || !chatId) return false;
    try {
      await this.client.sendMessage(text, { chatId });
      return true;
    } catch (error) {
      this.logger?.warn(this.texts.t('logs.sendFailed'), { reason: error.message });
      return false;
    }
  }

  /** Запуск: планировщик и приём команд работают независимо, но не параллельно с запросами. */
  async start({ runSchedulerLoop = true } = {}) {
    if (this.stopping) throw new Error('Бот уже остановлен.');
    // Публикуем список команд, чтобы они были видны в меню Telegram.
    // Владельцу — расширенный набор (с /users и /usage).
    if (this.client) {
      const ownerId = this.ownerId;
      const ownerChatId = ownerId ? this.telegramState?.chatIdOf(ownerId) ?? this.client.chatId : this.client.chatId;
      await publishTelegramCommands({
        client: this.client,
        texts: this.texts,
        config: this.config,
        logger: this.logger,
        ownerChatId,
        telegramState: this.telegramState
      });
    }
    const tasks = [];
    if (this.client && this.config?.telegram?.enabled !== false) {
      tasks.push(this.pollCommands());
    }
    if (runSchedulerLoop && this.scheduler) {
      tasks.push(
        this.scheduler.run().then((result) => {
          this.logger?.info(this.texts.t('logs.stop'), { result });
          return result;
        })
      );
    }
    if (tasks.length === 0) throw new Error('Нечего запускать: нет ни планировщика, ни Telegram-клиента.');
    return await Promise.all(tasks);
  }

  async pollCommands() {
    if (this.client && this.persistedOffset) this.client.offset = this.persistedOffset;
    this.polling = true;
    let backoffMs = 1000;
    while (!this.stopping && this.polling) {
      try {
        const { messages } = await this.client.pollOnce({
          timeoutSeconds: this.config?.telegram?.pollTimeoutSeconds ?? 30
        });
        backoffMs = 1000;
        this.networkFailures = 0;
        for (const message of messages) {
          await this.handleIncoming(message);
        }
        // Сохраняем chat id и offset: режим poll тоже должен знать, куда отправлять.
        if (this.telegramState && this.client.chatId) {
          await this.telegramState.save({ offset: this.client.offset, chatId: this.client.chatId });
        }
      } catch (error) {
        if (this.stopping) break;
        const retryAfter = error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : null;
        const waitMs = retryAfter ?? Math.min(backoffMs, 30000);
        if (error.conflict) {
          // Конфликт getUpdates: обычно запущена вторая копия бота с тем же токеном.
          this.logger?.error(error.message || this.texts.t('logs.telegramConflict'), { conflict: true, waitMs });
        } else if (error.network) {
          // Сетевые сбои неизбежны (Wi-Fi, мобильная сеть, блокировка VPN-туннеля).
          // Пишем их кратко: это не ошибка бота, а состояние сети.
          this.networkFailures = (this.networkFailures ?? 0) + 1;
          const level = this.networkFailures < 3 ? 'debug' : 'warn';
          this.logger?.[level]?.(this.texts.t('logs.telegramNetworkError'), {
            attempt: this.networkFailures,
            code: error.networkCode ?? null,
            reason: error.message,
            waitMs
          });
        } else {
          this.logger?.warn(this.texts.t('logs.telegramPollError'), { waitMs, reason: error.message });
        }
        backoffMs = Math.min(backoffMs * 2, 30000);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    this.polling = false;
  }

  async stop() {
    this.stopping = true;
    this.polling = false;
    this.scheduler?.stopLoop();
    this.logger?.info(this.texts.t('logs.botStopping'));
  }
}

