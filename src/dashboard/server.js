/**
 * Локальная страница состояния (только чтение).
 *
 * Сервер слушает 127.0.0.1 и не имеет записи: он показывает план опроса,
 * состояние планировщика и последние обработанные задания. Никаких данных
 * с Kwork сверх нормализованных полей здесь нет.
 */

import { createTexts } from '../texts/texts.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildDashboardHtml({
  plan = [],
  schedule = {},
  categories = [],
  profile = null,
  stats = {},
  state = {},
  recent = [],
  timezone = 'Europe/Moscow',
  texts = null
}) {
  const textsObject = texts ?? createTexts({ rootDir: process.cwd() });
  const t = (path, params) => textsObject.t(path, params);
  const rows = recent
    .slice()
    .reverse()
    .map(
      (entry) => `<tr>
        <td>${escapeHtml(entry.recordedAt ?? '')}</td>
        <td>${escapeHtml(entry.id ?? '—')}</td>
        <td>${escapeHtml(entry.title ?? '—')}</td>
        <td>${escapeHtml(entry.payload?.verdict ?? '—')}</td>
        <td>${entry.payload?.notified ? t('dashboard.tableYes') : t('dashboard.tableNo')}</td>
      </tr>`
    )
    .join('\n');

  const urlRows = plan
    .map(
      (entry) => `<li><code>${escapeHtml(entry.url)}</code> — ${escapeHtml(entry.label ?? '')}
        ${entry.enabled === false ? `<b>${escapeHtml(t('dashboard.disabled'))}</b>` : ''}
        ${entry.pagination && entry.paginationConfirmed !== true ? `<b>${escapeHtml(t('dashboard.paginationNotConfirmed'))}</b>` : ''}</li>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(t('dashboard.title'))}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; color: #1b1b1f; }
    h1 { font-size: 1.4rem; }
    section { margin-bottom: 1.5rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #ddd; padding: 0.4rem; text-align: left; font-size: 0.9rem; }
    code { background: #f4f4f6; padding: 0.1rem 0.3rem; border-radius: 4px; }
    .muted { color: #666; }
  </style>
</head>
<body>
  <h1>${escapeHtml(t('dashboard.title'))}</h1>
  <p class="muted">${escapeHtml(t('dashboard.subtitle'))}</p>

  <section>
    <h2>${escapeHtml(t('dashboard.planTitle'))}</h2>
    <ul>${urlRows || `<li>${escapeHtml(t('dashboard.noUrls'))}</li>`}</ul>
    <p>${t('dashboard.scheduleLine', {
      start: escapeHtml(schedule.windowStart),
      end: escapeHtml(schedule.windowEnd),
      timezone: escapeHtml(timezone),
      min: escapeHtml(schedule.minIntervalSeconds),
      max: escapeHtml(schedule.maxIntervalSeconds)
    })}</p>
  </section>

  <section>
    <h2>${escapeHtml(t('dashboard.categoriesTitle'))}</h2>
    <ul>${categories.map((category) => `<li>${escapeHtml(category.label)}</li>`).join('\n') || `<li>${escapeHtml(t('dashboard.noCategories'))}</li>`}</ul>
  </section>

  <section>
    <h2>${escapeHtml(t('dashboard.stateTitle'))}</h2>
    <pre>${escapeHtml(JSON.stringify(state, null, 2))}</pre>
  </section>

  <section>
    <h2>${escapeHtml(t('dashboard.storageTitle'))}</h2>
    <p>${t('dashboard.storageLine', {
      total: escapeHtml(stats.total ?? 0),
      stableId: escapeHtml(stats.stableIdKeys ?? 0),
      url: escapeHtml(stats.urlKeys ?? 0),
      composite: escapeHtml(stats.compositeKeys ?? 0),
      updatedAt: escapeHtml(stats.updatedAt ?? '—')
    })}</p>
  </section>

  <section>
    <h2>${escapeHtml(t('dashboard.recentTitle'))}</h2>
    <table>
      <thead><tr><th>${escapeHtml(t('dashboard.tableWhen'))}</th><th>${escapeHtml(t('dashboard.tableId'))}</th><th>${escapeHtml(t('dashboard.tableTitle'))}</th><th>${escapeHtml(t('dashboard.tableVerdict'))}</th><th>${escapeHtml(t('dashboard.tableNotified'))}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5">${escapeHtml(t('dashboard.tableEmpty'))}</td></tr>`}</tbody>
    </table>
  </section>

  <section>
    <h2>${escapeHtml(t('dashboard.profileTitle'))}</h2>
    <p>${t('dashboard.profileLine', {
      headline: escapeHtml(profile?.headline ?? '—'),
      minimum: escapeHtml(profile?.pricing?.minimum_project_price ?? '—'),
      currency: escapeHtml(profile?.pricing?.currency ?? ''),
      portfolio: escapeHtml((profile?.portfolio ?? []).length)
    })}</p>
  </section>
</body>
</html>`;
}
