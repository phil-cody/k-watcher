/**
 * Признаки защиты, блокировки и смены разметки.
 *
 * Важно различать реальную проверку и безобидное упоминание. Слово «captcha»
 * в подключённом скрипте или в скрытом служебном блоке не означает, что показана
 * проверка: большинство обычных страниц такие упоминания содержат. Поэтому
 * детектор ищет конкретные признаки показанной проверки, а не текст «captcha».
 *
 * Реальная проверка/блокировка => жёсткая остановка опроса.
 * Слабое упоминание        => страница разбирается, сигнал пишется в диагностику.
 */

import { findAll, classesOf, textOf, normalizeWhitespace, parseHtml } from '../util/html.js';

export const ANOMALY = {
  CAPTCHA: 'captcha',
  BLOCKED: 'blocked',
  ACCESS_DENIED: 'access-denied',
  BOT_CHECK: 'bot-check'
};

const HARD_TITLE = /(подтвердите,?\s+что\s+вы\s+не\s+робот|проверка\s+безопасности|attention\s+required|just\s+a\s+moment|checking\s+your\s+browser|are\s+you\s+a\s+human|verify\s+you\s+are\s+human|слишком\s+много\s+запросов|доступ\s+запрещ|доступ\s+ограничен|you\s+have\s+been\s+blocked)/i;
const SOFT_MENTION = /\b(captcha|recaptcha|hcaptcha|turnstile)\b/i;
const HARD_ACCESS = /(access\s+denied|403\s+forbidden|доступ\s+запрещ|доступ\s+ограничен)/i;
const HARD_BLOCK = /(вы\s+заблокирован|заблокирован[аы]?\s+до|too\s+many\s+requests|слишком\s+много\s+запросов|rate\s+limit)/i;

const CHALLENGE_ELEMENT = /(^|[-_])(g?-?recaptcha|h-captcha|hcaptcha|cf-turnstile|turnstile|captcha)([-_]|$)/i;
const VISIBLE_CAPTCHA_INPUT = /(captcha|recaptcha|smart-?captcha)/i;

function isHiddenSource(source) {
  return /display\s*:\s*none|visibility\s*:\s*hidden|hidden\s*=\s*["']?(?:true|hidden|1)?["']?/i.test(source);
}

/** Короткий безопасный контекст вокруг метки: без записи HTML целиком. */
function contextAround(text, index, length = 60) {
  const start = Math.max(0, index - length);
  const end = Math.min(text.length, index + length);
  return normalizeWhitespace(text.slice(start, end));
}

function findHtmlSignal(html, pattern) {
  const match = pattern.exec(html);
  if (!match) return null;
  return { marker: match[0].slice(0, 60), context: contextAround(html, match.index) };
}

/** Видимый текст страницы без содержимого script/style — чтобы не ловить код. */
function visibleText(html, doc) {
  const withoutScripts = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const parsed = withoutScripts === html ? doc : parseHtml(withoutScripts);
  return normalizeWhitespace(textOf(parsed));
}

/**
 * Разбор признаков. Возвращает { hard, soft, markers }, где hard — то, из-за чего
 * опрос обязан остановиться.
 */
export function detectPageAnomaliesDetailed(html) {
  const source = String(html ?? '');
  const doc = parseHtml(source);
  const hard = [];
  const soft = [];
  const markers = [];

  // 1) Показанный challenge-виджет: сам элемент или его iframe.
  if (/<iframe[^>]+(google\.com\/recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|recaptcha)/i.test(source)) {
    hard.push({ kind: ANOMALY.CAPTCHA, reason: 'document-contains-challenge-iframe' });
    markers.push('challenge-iframe');
  }

  // 2) Видимый контейнер проверки (не скрытый служебный блок).
  const containers = findAll(doc, (node) => {
    const classMatch = classesOf(node).some((name) => CHALLENGE_ELEMENT.test(name));
    const idMatch = CHALLENGE_ELEMENT.test(node.attrs?.id ?? '');
    return classMatch || idMatch;
  });
  for (const node of containers) {
    const signature = `${node.attrs?.class ?? ''} ${node.attrs?.id ?? ''} ${node.attrs?.style ?? ''}`;
    if (isHiddenSource(signature)) {
      soft.push({ kind: 'hidden-captcha-container', reason: 'container-hidden' });
      continue;
    }
    const visibleText = textOf(node);
    const ownStyle = node.attrs?.style ?? '';
    if (ownStyle && /display\s*:\s*none/i.test(ownStyle)) {
      soft.push({ kind: 'hidden-captcha-container', reason: 'container-hidden' });
      continue;
    }
    hard.push({ kind: ANOMALY.CAPTCHA, reason: visibleText ? 'visible-captcha-widget' : 'captcha-container' });
    markers.push(`captcha-container:${(node.attrs?.class || node.attrs?.id || '').slice(0, 40)}`);
    break;
  }

  // 3) Видимое поле ввода кода проверки.
  const captchaInput = findAll(doc, (node) =>
    node.tag === 'input' && VISIBLE_CAPTCHA_INPUT.test(`${node.attrs?.name ?? ''} ${node.attrs?.id ?? ''}`)
  ).find((node) => !isHiddenSource(node.attrs?.style ?? '') && node.attrs?.type !== 'hidden');
  if (captchaInput) {
    hard.push({ kind: ANOMALY.CAPTCHA, reason: 'visible-captcha-input' });
    markers.push('captcha-input');
  }

  // 4) Заголовок страницы или её основной заголовок прямо говорит о проверке.
  const titleMatch = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(source);
  const title = titleMatch ? normalizeWhitespace(titleMatch[1]) : '';
  const heading = (() => {
    const found = findAll(doc, (node) => ['h1', 'h2'].includes(node.tag));
    return found.length > 0 ? textOf(found[0]) : '';
  })();
  for (const [where, value] of [['title', title], ['heading', heading]]) {
    if (value && HARD_TITLE.test(value)) {
      const kind = /captcha|робот|human/i.test(value) ? ANOMALY.CAPTCHA : HARD_BLOCK.test(value) ? ANOMALY.BLOCKED : ANOMALY.BOT_CHECK;
      hard.push({ kind, reason: `challenge-${where}`, snippet: value.slice(0, 120) });
      markers.push(`${kind}-${where}`);
    }
  }

  // 5) Явные тексты проверки и отказа доступа где угодно на странице.
  // Скрипты и стили исключаются: упоминание в коде — не показанная проверка.
  const bodyText = visibleText(source, doc);
  if (bodyText && hard.length === 0 && HARD_TITLE.test(bodyText)) {
    const match = HARD_TITLE.exec(bodyText);
    const kind = /captcha|робот|human|browser/i.test(match[0]) ? ANOMALY.CAPTCHA : HARD_BLOCK.test(match[0]) ? ANOMALY.BLOCKED : ANOMALY.BOT_CHECK;
    hard.push({ kind, reason: 'challenge-text', snippet: match[0].slice(0, 120) });
    markers.push(`${kind}-text`);
  }

  const accessSignal = findHtmlSignal(source, HARD_ACCESS);
  if (accessSignal) {
    hard.push({ kind: ANOMALY.ACCESS_DENIED, reason: 'access-denied-text', snippet: accessSignal.marker });
    markers.push('access-denied-text');
  }
  const blockSignal = findHtmlSignal(source, HARD_BLOCK);
  if (blockSignal && !hard.some((entry) => entry.kind === ANOMALY.CAPTCHA)) {
    hard.push({ kind: ANOMALY.BLOCKED, reason: 'blocked-text', snippet: blockSignal.marker });
    markers.push('blocked-text');
  }

  // 6) Слабое упоминание: скрипт или текст в другом месте страницы.
  if (hard.length === 0) {
    const softMatch = SOFT_MENTION.exec(source);
    if (softMatch) {
      const scriptMatch = /<script[^>]*>[^<]{0,200}captcha/i.exec(source) || /<script[^>]+src=["'][^"']*captcha/i.exec(source);
      soft.push({
        kind: 'captcha-mention',
        reason: scriptMatch ? 'captcha-in-script' : 'captcha-text-mention',
        snippet: contextAround(source, softMatch.index)
      });
      markers.push('captcha-mention');
    }
  }

  // 7) Признаки смены разметки — отдельный тип, чтобы отличить блокировку от редизайна.
  const structureSignals = [];
  if (/<div[^>]+id=["'](root|app)["'][^>]*>\s*<\/div>/i.test(source)) structureSignals.push('empty-spa-root');

  return { hard, soft, markers, structureSignals };
}

/**
 * Диагностика ответа для логов и сообщения пользователю.
 * Полный HTML не сохраняется: только статус, размер, маркеры и короткие выдержки.
 */
export function describeAnomalyDiagnostics({ status = null, url = null, html = '' } = {}) {
  const source = String(html ?? '');
  const detailed = detectPageAnomaliesDetailed(source);
  const titleMatch = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(source);
  return {
    status,
    url,
    bytes: source.length,
    title: titleMatch ? normalizeWhitespace(titleMatch[1]).slice(0, 120) : null,
    markers: detailed.markers,
    hard: detailed.hard,
    soft: detailed.soft,
    structureSignals: detailed.structureSignals,
    // Одна короткая выдержка вместо страницы: этого достаточно для разбора причины.
    excerpt: detailed.hard[0]?.snippet ?? detailed.soft[0]?.snippet ?? contextAround(source, 0, 120)
  };
}
