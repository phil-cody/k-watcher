/**
 * Один цикл опроса: получить страницы (при необходимости — все страницы
 * категории), разобрать, отфильтровать новое, проанализировать, отправить
 * пользователю в Telegram, записать в хранилище и почистить индекс.
 *
 * Гарантии:
 *  - HTML разбирается в памяти и не сохраняется;
 *  - задание записывается в хранилище ТОЛЬКО после успешной отправки;
 *  - если отправка не удалась, задание ставится в очередь `pendingNotifications`
 *    и уходит в начале следующего цикла — уведомление не теряется;
 *  - повторная карточка не создаёт дубликат и не отправляется второй раз;
 *  - очистка индекса (prune) выполняется только по источникам, которые в этом
 *    проходе получены и разобраны успешно: сбой сети не сбрасывает базу;
 *  - отбор по категориям не отбрасывает данные, пока пользователь не подтвердил
 *    соответствие числовых id категорий Kwork (categoryMapping.confirmed).
 */

import { renderJobMessages } from '../telegram/format.js';
import { analyzeAndDraft } from '../analysis/compose-analysis.js';
import { keyIdsForJob } from '../storage/job-store.js';
import { applyCategoryName } from '../storage/category-store.js';
import { buildPollPlan, baseFromAllowedUrls } from '../source/poll-plan.js';
import { createTexts } from '../texts/texts.js';

const PENDING_LIMIT = 50;
const HARD_PAGE_LIMIT = 20;

export function createCycleRunner({
  source,
  parser,
  store,
  profile,
  profiles = null,
  categories = null,
  categoryCatalog = null,
  recipients = null,
  notifier = null,
  modelAdapter = null,
  config = {},
  logger = null,
  now = () => new Date(),
  texts = null
}) {
  const textsObject = texts ?? createTexts({ rootDir: config.rootDir ?? process.cwd() });
  const t = (path, params) => textsObject.t(path, params);
  const sourceConfig = config.source ?? {};
  const categoryFilterConfirmed = config.categoryMapping?.confirmed === true;
  const paginationEnabled = config.source?.pagination?.enabled === true;
  const maxPagesPerUrl = paginationEnabled
    ? Math.min(Number(config.source.pagination.maxPagesPerUrl ?? 5) || 5, HARD_PAGE_LIMIT)
    : 1;

  async function readPending() {
    const state = await store.readState();
    return Array.isArray(state.pendingNotifications) ? state.pendingNotifications : [];
  }

  async function writePending(items) {
    await store.writeState({ pendingNotifications: items.slice(-PENDING_LIMIT) });
  }

  /**
   * Напоминание пользователям, у которых нет профиля: без него задания не отправляются.
   * Не чаще одного раза в сутки на человека (учёт в ProfileStore).
   */
  async function remindWithoutProfile(audience, chatLookup) {
    if (!notifier || !profiles?.noteReminder) return 0;
    let sent = 0;
    for (const recipient of audience) {
      if (recipient.profile || !recipient.userId) continue;
      const chatId = recipient.chatId ?? (chatLookup ? chatLookup(recipient.userId) : null);
      if (!Number.isFinite(Number(chatId))) continue;
      try {
        const allowed = await profiles.noteReminder(recipient.userId);
        if (!allowed.allowed) continue;
        await notifier.sendMessage(t('commands.onboarding.profileReminder'), { chatId: Number(chatId), parseMode: null });
        sent += 1;
        logger?.info(t('logs.profileReminderSent'), { userId: recipient.userId });
      } catch (error) {
        logger?.warn(t('logs.sendFailed'), { jobId: 'reminder', reason: error.message });
      }
    }
    return sent;
  }

  /** Отправка с разбивкой на части. Бросает ошибку, если доставить не удалось. */
  async function deliver(messages, { chatId = null } = {}) {
    const list = Array.isArray(messages) ? messages : [messages];
    for (const chunk of list) {
      await notifier.sendMessage(chunk, chatId ? { chatId, parseMode: 'HTML' } : { parseMode: 'HTML' });
    }
  }

  /**
   * Список получателей.
   *
   * Без `recipients` работает прежняя схема: один профиль и один адресат (notifier.chatId).
   * С `recipients` у каждого пользователя свой профиль, вердикт, цена и черновик.
   */
  async function resolveRecipients() {
    // recipients может быть массивом или функцией: список доступа меняется во время работы.
    const resolved = typeof recipients === 'function' ? await recipients() : recipients;
    if (!Array.isArray(resolved) || resolved.length === 0) {
      return [
        {
          userId: null,
          chatId: notifier?.chatId ?? null,
          profile,
          source: profile ? 'single' : null
        }
      ];
    }
    const list = [];
    for (const entry of resolved) {
      const userId = Number(entry.userId ?? entry);
      if (!Number.isFinite(userId)) continue;
      const chatId = Number.isFinite(Number(entry.chatId)) ? Number(entry.chatId) : null;
      const found = profiles?.get ? await profiles.get(userId) : { profile: profile ?? null, source: null };
      list.push({
        userId,
        chatId,
        profile: found.profile ?? null,
        source: found.profile ? found.source : null
      });
    }
    return list;
  }

  // Тексты ошибок, уже напечатанных на своём уровне: в сводке не дублируем.
  // Живёт на уровне цикла, потому что используется и в досылке очереди, и в сводке.
  let loggedErrors = new Set();

  /** Досылка того, что не удалось отправить в прошлые циклы. */
  async function flushPending(summary) {
    if (!notifier) return;
    const pending = await readPending();
    if (pending.length === 0) return;
    const stillPending = [];
    for (const entry of pending) {
      try {
        await deliver(entry.messages ?? (entry.text ? [entry.text] : []));
        summary.retried += 1;
      } catch (error) {
        stillPending.push(entry);
        const message = t('logs.retrySendFailed', { jobId: entry.jobId ?? '—', reason: error.message });
        summary.errors.push(message);
        loggedErrors.add(message);
      }
    }
    if (stillPending.length !== pending.length) {
      await writePending(stillPending);
    }
    if (stillPending.length > 0) {
      logger?.warn(t('logs.pendingLeft'), { count: stillPending.length });
    }
  }

  /** URL страницы N для объявленного URL (страница 1 — сам URL). */
  function pageUrlOf(entry, page) {
    if (page <= 1) return entry.url;
    const url = new URL(entry.url);
    url.searchParams.set('page', String(page));
    return url.toString();
  }

  /**
   * Сколько страниц запрашивать для этого URL.
   * Ориентируемся на last_page из выдачи: если Kwork говорит, что страниц больше,
   * добираем их (в пределах maxPagesPerUrl и жёсткого предела).
   */
  function maxPagesFor(entry, pageInfo) {
    const declared = Math.max(
      1,
      Math.min(Number(entry.pages ?? 1) || 1, maxPagesPerUrl)
    );
    const hint = Number(pageInfo?.lastPage ?? 0);
    if (!Number.isFinite(hint) || hint <= 1) return declared;
    return Math.max(declared, Math.min(hint, maxPagesPerUrl, HARD_PAGE_LIMIT));
  }

  /**
   * URL текущего прохода.
   *
   * Если получатели выбрали категории, опрашиваются именно они; иначе — общий список.
   * План всегда ограничен объявленными URL: выйти за согласованный объём нельзя.
   */
  async function planUrlsForPass() {
    const audience = await resolveRecipients();
    const allowed = (sourceConfig.allowedUrls ?? []).filter((entry) => entry.enabled !== false);
    const base = baseFromAllowedUrls(allowed);

    // У каждого получателя свой выбор; объединяем. Нет профиля — всё равно учитываем выбор.
    const selections = [];
    for (const recipient of audience) {
      if (!recipient.userId || !categories?.effective) continue;
      const effective = await categories.effective(recipient.userId);
      selections.push(effective.selection);
    }

    const plan = buildPollPlan({ base, allowedUrls: allowed, selection: unionSelection(selections) });
    return { allowed, plan };
  }

  async function runOnce() {
    const startedAt = now();
    const { allowed: enabledUrls, plan } = await planUrlsForPass();
    if (plan.urls.length === 0) {
      throw new Error(
        enabledUrls.length === 0
          ? 'Нет ни одного включённого разрешённого URL: опрос невозможен.'
          : 'Ни один URL из плана не объявлен в source.allowedUrls: опрос невозможен.'
      );
    }

    loggedErrors = new Set();
    const summary = {
      startedAt: startedAt.toISOString(),
      pages: [],
      cardsFound: 0,
      inTargetCategories: 0,
      outOfTargetCategories: 0,
      uncategorized: [],
      newJobs: 0,
      duplicates: 0,
      sent: 0,
      retried: 0,
      pending: 0,
      pruned: 0,
      sources: [],
      activeJobs: store.stats.total,
      categoryFilterConfirmed,
      // Что опрашивали в этом проходе: режим и число страниц.
      pollPlan: { mode: plan.mode, urls: plan.urls.map((entry) => entry.url) },
      structureOk: true,
      errors: [],
      warnings: [],
      // Кому не отправили из-за отсутствия профиля (для напоминаний).
      noProfile: [],
      // Сколько раз задание пропущено из-за персональных категорий.
      skippedByCategory: 0,
      reminders: 0
    };

    // Ключи, встреченные в этом проходе, и источники, которым можно доверять.
    const seenKeys = new Set();
    const reliableSourceUrls = new Set();

    await flushPending(summary);

    for (const entry of plan.urls) {
      let sourceReliable = true;
      let urlCards = 0;
      let declaredTotal = null;
      let currentPageInfo = null;
      let pagesRequested = 0;

      // Первая страница нужна, чтобы узнать last_page, затем добираем остальные.
      for (let pageNumber = 1; pageNumber <= HARD_PAGE_LIMIT; pageNumber += 1) {
        const url = pageUrlOf(entry, pageNumber);
        if (pageNumber > 1 && pageNumber > maxPagesFor(entry, currentPageInfo)) break;
        pagesRequested += 1;
        let page;
        try {
          page = await source.fetchPage(url);
        } catch (error) {
          // Ошибку источника не глотаем: её обрабатывает планировщик (стоп/пауза).
          throw error;
        }

        const parsed = parser.parse(page.html, { sourceUrl: entry.url, referenceDate: startedAt });
        currentPageInfo = parsed.pageInfo ?? currentPageInfo;
        if (pageNumber === 1 && parsed.pageInfo?.total !== null && parsed.pageInfo?.total !== undefined) {
          declaredTotal = parsed.pageInfo.total;
        }
        urlCards += parsed.jobs.length;
        summary.cardsFound += parsed.jobs.length;
        // Метаданные страницы пишем всегда — включая пустую, чтобы в состоянии
        // было видно, где остановилась пагинация.
        summary.pages.push({
          url,
          strategy: parsed.structure.strategy,
          cards: parsed.jobs.length,
          warnings: parsed.warnings.length,
          anomalies: parsed.anomalies,
          softAnomalies: (parsed.softAnomalies ?? []).map((item) => item.reason)
        });

        // Замечания парсера (без «упоминаний защиты») — в debug-детали.
        for (const warning of parsed.warnings) {
          logger?.debug(t('logs.parserNote'), { url, warning });
        }

        if (parsed.anomalies.length > 0) {
          // Источник останавливается сам, это страховка на уровне цикла.
          throw new Error(`Обнаружены признаки блокировки/CAPTCHA: ${parsed.anomalies.join(', ')}`);
        }

        if (parsed.jobs.length === 0) {
          // Пустая страница: либо конец пагинации, либо смена разметки.
          if (url !== entry.url) {
            logger?.info(t('logs.noCardsInPage'), { url });
          } else {
            sourceReliable = false;
            summary.structureOk = false;
            summary.errors.push(
              t('logs.structureBroken', { url, details: parsed.warnings.join(' ') || t('logs.noDetails') })
            );
            logger?.warn(t('logs.noCardsAtAll'), {
              url,
              warnings: parsed.warnings.join(' ')
            });
          }
          break;
        }

        // Отбор по категориям выполняет персональный фильтр получателя
        // (`categories.matches`): у каждого пользователя свой набор. Глобальный список
        // targetCategories остаётся справочником для подписей и не отбрасывает задания.
        const inTargets = parsed.jobs.filter((job) => Boolean(job.category));
        const undetermined = parsed.jobs.filter((job) => !job.category);
        let selected = parsed.jobs;

        // Если персональных категорий нет (старая схема, тесты, dry-run), работает
        // общий фильтр из конфигурации. С персональными категориями решение принимает
        // фильтр получателя — тогда глобально ничего не отбрасываем.
        if (categoryFilterConfirmed && !categories) {
          selected = inTargets;
          summary.outOfTargetCategories += undetermined.length;
        } else if (!categoryFilterConfirmed && parsed.jobs.length > 0) {
          summary.uncategorized.push(...parsed.jobs.map((job) => job.id));
        }
        summary.inTargetCategories += inTargets.length;

        // 1. Отбираем задания, которых ещё нет в индексе.
        const fresh = [];
        for (const job of selected) {
          // Задание видели в выдаче: ключ сохраняем от очистки.
          for (const keyId of keyIdsForJob(job)) seenKeys.add(keyId);

          // Название категории вместо числа: берём из каталога сайта.
          const described = categoryCatalog ? applyCategoryName(job, categoryCatalog) : job;

          const duplicateCheck = store.isProcessed(described);
          if (duplicateCheck.isDuplicate) {
            summary.duplicates += 1;
            logger?.debug(t('logs.duplicateSkipped'), {
              id: described.id,
              matchedBy: duplicateCheck.matchedBy,
              probableMatch: duplicateCheck.probableMatch
            });
            continue;
          }
          fresh.push(described);
        }

        // Решение о следующей странице принимаем до отправки: иначе пагинация
        // остановилась бы на первой странице без новых заданий (только повторы).
        const nextPage = pageNumber + 1;
        const canContinue = nextPage <= maxPagesFor(entry, currentPageInfo) && nextPage <= HARD_PAGE_LIMIT;

        if (fresh.length === 0) {
          if (!canContinue) break;
          continue;
        }

        // 2. Новые задания анализируем и отправляем отдельно для каждого пользователя:
        //    у каждого свой профиль, а значит свой вердикт, цена и черновик отклика.
        const audience = await resolveRecipients();
        for (const job of fresh) {
          summary.newJobs += 1;
          let delivered = false;

          for (const recipient of audience) {
            // Категории у каждого свои: задание из чужой категории не анализируем
            // и не отправляем, чтобы не тратить время и квоту модели.
            if (categories && recipient.userId) {
              const fits = await categories.matches(recipient.userId, job);
              if (!fits) {
                summary.skippedByCategory += 1;
                logger?.debug(t('logs.jobSkippedByCategory'), {
                  id: job.id,
                  userId: recipient.userId,
                  kworkCategoryId: job.kworkCategoryId ?? null
                });
                continue;
              }
            }
            if (!recipient.profile) {
              // Профиля нет — уведомление не отправляем, пользователю уйдёт напоминание.
              if (recipient.userId) summary.noProfile.push(recipient.userId);
              logger?.debug(t('logs.jobSkippedNoProfile'), {
                id: job.id,
                userId: recipient.userId ?? null
              });
              continue;
            }

            const analysis = await analyzeAndDraft(job, recipient.profile, {
              modelAdapter,
              config,
              texts: textsObject
            });
            const messages = renderJobMessages(job, analysis, { texts: textsObject });

            if (!notifier) continue;

            try {
              await deliver(messages, { chatId: recipient.chatId });
              delivered = true;
              summary.sent += 1;
              await store.appendMessageLog({
                at: now().toISOString(),
                userId: recipient.userId,
                chatId: recipient.chatId,
                jobId: job.id,
                url: job.url,
                verdict: analysis.verdict,
                notified: true,
                parts: messages.length,
                messageLength: messages.join('').length,
                draftIncluded: true
              });
            } catch (error) {
              // Не записываем задание как обработанное: уведомление не должно потеряться.
              const pending = await readPending();
              pending.push({
                userId: recipient.userId,
                chatId: recipient.chatId,
                jobId: job.id,
                url: job.url,
                title: job.title,
                verdict: analysis.verdict,
                messages,
                failedAt: now().toISOString(),
                reason: error.message
              });
              await writePending(pending);
              summary.pending += 1;
              const message = t('logs.sendFailed', { jobId: job.id ?? job.url, reason: error.message });
              summary.errors.push(message);
              loggedErrors.add(message);
              logger?.error(t('logs.sendFailedQueued'), {
                jobId: job.id,
                userId: recipient.userId ?? null,
                reason: error.message
              });
            }
          }

          // Задание попадает в индекс только после успешной доставки хотя бы одному
          // получателю: иначе уведомление потеряется при повторном проходе.
          if (!notifier) {
            await store.record(job, {
              recordedAt: now().toISOString(),
              payload: buildPayload(job, { verdict: null, risks: [], preliminary: true, modelUsed: null }, { notified: false }),
              sourceRef: { url: entry.url, kworkCategoryId: job.kworkCategoryId ?? null, title: job.title }
            });
            continue;
          }
          if (!delivered) continue;

          await store.record(job, {
            recordedAt: now().toISOString(),
            payload: buildPayload(job, { verdict: 'доставлено', risks: [], preliminary: false, modelUsed: null }, { notified: true }),
            sourceRef: { url: entry.url, kworkCategoryId: job.kworkCategoryId ?? null, title: job.title }
          });
        }
      }

      if (sourceReliable && urlCards > 0) {
        reliableSourceUrls.add(entry.url);
      }

      // Собираем сведения по источнику: подробности пойдут в сводку цикла.
      summary.sources.push({
        url: entry.url,
        cards: urlCards,
        pagesRequested,
        declaredTotal
      });
      // Если выдача заявляет больше заданий, чем удалось забрать, честно сообщаем
      // об этом в итогах цикла — молча терять задания нельзя.
      if (declaredTotal !== null && urlCards < declaredTotal) {
        const availablePages = Number(currentPageInfo?.lastPage ?? 1);
        const reachedLimit = pagesRequested >= Math.min(availablePages || 1, maxPagesPerUrl);
        const hint =
          reachedLimit && maxPagesPerUrl < availablePages
            ? t('analysis.structureShortfallHints.limitReached', { limit: maxPagesPerUrl })
            : t('analysis.structureShortfallHints.unknown');
        // Недобор — это предупреждение, а не сбой: данные валидны, просто их меньше.
        summary.warnings.push(
          t('analysis.riskMessages.structure_shortfall', {
            url: entry.url,
            declared: declaredTotal,
            fetched: urlCards,
            hint
          })
        );
      }
    }

    // Очистка индекса: удаляем задания, которых больше нет в успешно полученных источниках.
    if (sourceConfig.pruneMissingJobs !== false && reliableSourceUrls.size > 0) {
      const result = await store.prune({ seenKeys, reliableSourceUrls });
      summary.pruned = result.removed;
      summary.activeJobs = result.active;
      if (result.removed > 0) {
        logger?.info(`Индекс очищен: удалено задач ${result.removed} | активных задач: ${result.active}`);
      }
    }

    summary.activeJobs = store.stats.total;

    // Единственное сообщение по итогам цикла: без строк на каждый запрос.
    const perSource = summary.sources
      .map((item) => {
        const cards = t('logs.sourceShortCards', { cards: item.cards });
        const pages = item.pagesRequested > 1 ? t('logs.sourceShortPages', { pages: item.pagesRequested }) : '';
        return `${shortUrl(item.url)}: ${cards}${pages}`;
      })
      .join(', ');
    logger?.info(
      t('logs.cycleSummary', {
        requests: summary.sources.length,
        cards: summary.cardsFound,
        newJobs: summary.newJobs,
        duplicates: summary.duplicates,
        pruned: summary.pruned,
        active: summary.activeJobs,
        pending: summary.pending > 0 ? t('logs.cycleSummaryPending', { count: summary.pending }) : '',
        errors: summary.errors.length > 0 ? t('logs.cycleSummaryErrors', { count: summary.errors.length }) : '',
        warnings: summary.warnings.length > 0 ? t('logs.cycleSummaryWarnings', { count: summary.warnings.length }) : '',
        perSource: perSource ? t('logs.cycleSummaryPerSource', { sources: perSource }) : ''
      }),
      {
        requests: summary.sources.length,
        cards: summary.cardsFound,
        newJobs: summary.newJobs,
        duplicates: summary.duplicates,
        pruned: summary.pruned,
        totalJobs: summary.activeJobs,
        pending: summary.pending,
        errors: summary.errors.length,
        warnings: summary.warnings.length
      }
    );

    // Расшифровка: одна строка на проблему, чтобы в логе было видно, о чём речь.
    // Проблемы, которые уже напечатаны на своём уровне (например, ошибка отправки
    // конкретного сообщения), повторно не дублируем.
    // Накопительная статистика приложения: её показывает команда владельца /usage.
    const previous = (await store.readState()).metrics ?? {};
    await store.writeState({
      metrics: {
        cycles: Number(previous.cycles ?? 0) + 1,
        requests: Number(previous.requests ?? 0) + summary.sources.length,
        pages: Number(previous.pages ?? 0) + summary.pages.length,
        cards: Number(previous.cards ?? 0) + summary.cardsFound,
        newJobs: Number(previous.newJobs ?? 0) + summary.newJobs,
        duplicates: Number(previous.duplicates ?? 0) + summary.duplicates,
        sentMessages: Number(previous.sentMessages ?? 0) + summary.sent,
        pruned: Number(previous.pruned ?? 0) + summary.pruned,
        errors: Number(previous.errors ?? 0) + summary.errors.length,
        warnings: Number(previous.warnings ?? 0) + summary.warnings.length,
        reminders: Number(previous.reminders ?? 0) + summary.reminders,
        skippedByCategory: Number(previous.skippedByCategory ?? 0) + summary.skippedByCategory,
        firstRunAt: previous.firstRunAt ?? startedAt.toISOString(),
        lastRunAt: now().toISOString()
      }
    });

    // Напоминаем тем, у кого нет профиля: иначе человек молча не получает заданий.
    if (summary.noProfile.length > 0) {
      const audience = await resolveRecipients();
      summary.reminders = await remindWithoutProfile(audience);
    }

    for (const warning of summary.warnings) logger?.warn(`${t('logs.cycleWarning')}: ${warning}`);
    for (const error of summary.errors) {
      if (loggedErrors.has(error)) continue;
      logger?.error(`${t('logs.cycleError')}: ${error}`);
    }

    return summary;
  }

  /** Объединение выбора категорий у нескольких получателей. */
  function unionSelection(selections) {
    const list = (selections ?? []).filter((item) => item !== null && item !== undefined);
    if (list.length === 0) return null;
    if (list.some((item) => item === 'all')) return 'all';
    const ids = new Set();
    for (const item of list) {
      if (!Array.isArray(item)) continue;
      for (const id of item) {
        const numeric = Number(id);
        if (Number.isFinite(numeric) && numeric > 0) ids.add(numeric);
      }
    }
    return ids.size === 0 ? null : [...ids].sort((a, b) => a - b);
  }

  function shortUrl(url) {
    try {
      const parsed = new URL(url);
      const c = parsed.searchParams.get('c');
      const page = parsed.searchParams.get('page');
      const base = c ? t('logs.sourceShortCategory', { id: c }) : t('logs.sourceShortAll');
      return `${base}${page ? t('logs.sourceShortPage', { page }) : ''}`;
    } catch {
      return url;
    }
  }

  function buildPayload(job, analysis, { notified }) {
    return {
      verdict: analysis.verdict,
      preliminary: analysis.preliminary,
      risks: (analysis.risks ?? []).map((risk) => risk.code),
      notified,
      modelUsed: analysis.modelUsed,
      // Числовые id Kwork сохраняем: по ним пользователь подтверждает отображение категорий.
      kworkCategoryId: job.kworkCategoryId ?? null,
      categoryLinkIds: job.categoryLinkIds ?? []
    };
  }

  return { runOnce };
}
