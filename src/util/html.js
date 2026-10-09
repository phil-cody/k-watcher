/**
 * Минимальный токенизатор HTML.
 *
 * Осознанно не используется сторонняя библиотека: нужен предсказуемый разбор
 * сохранённых fixtures и понятная реакция на незнакомую структуру, без ретраев
 * и «угадывания» отсутствующих полей. Парсер не бросает исключение на «мусоре» —
 * он возвращает то, что реально нашёл, а решение о полноте принимает вызывающий код.
 */

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'noscript', 'template']);

const NAMED_ENTITIES = {
  nbsp: '\u00a0',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  hellip: '…',
  deg: '°',
  times: '×',
  bull: '•',
  rsquo: "'",
  lsquo: "'",
  ldquo: '“',
  rdquo: '”',
  euro: '€',
  rub: '₽',
  copy: '©'
};

/** Декодирование HTML-сущностей (именованных и числовых). */
export function decodeEntities(input) {
  if (typeof input !== 'string' || input.indexOf('&') === -1) return input ?? '';
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Разбор строки атрибутов в объект (имена в нижнем регистре). */
export function parseAttributes(raw) {
  const attrs = {};
  if (!raw) return attrs;
  const re = /([^\s"'/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const name = match[1].toLowerCase();
    if (!name || name.startsWith('<')) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Токенизация HTML в плоский список: открывающие теги, закрывающие и текст.
 * Содержимое raw-text элементов (script/style) сохраняется отдельным токеном.
 */
export function tokenize(html) {
  const tokens = [];
  const source = String(html ?? '');
  let index = 0;

  while (index < source.length) {
    const nextTag = source.indexOf('<', index);
    if (nextTag === -1) {
      const text = source.slice(index);
      if (text) tokens.push({ type: 'text', raw: text, text: decodeEntities(text) });
      break;
    }
    if (nextTag > index) {
      const text = source.slice(index, nextTag);
      tokens.push({ type: 'text', raw: text, text: decodeEntities(text) });
    }

    if (source.startsWith('<!--', nextTag)) {
      const end = source.indexOf('-->', nextTag + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', nextTag) || source.startsWith('<?', nextTag)) {
      const end = source.indexOf('>', nextTag);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    const closeMatch = /^<\s*\/\s*([a-zA-Z][a-zA-Z0-9:-]*)\s*>/.exec(source.slice(nextTag));
    if (closeMatch) {
      tokens.push({ type: 'close', tag: closeMatch[1].toLowerCase() });
      index = nextTag + closeMatch[0].length;
      continue;
    }

    const openMatch = /^<\s*([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(source.slice(nextTag));
    if (!openMatch) {
      // Не тег — обычный текст, содержащий "<"
      tokens.push({ type: 'text', raw: '<', text: '<' });
      index = nextTag + 1;
      continue;
    }

    const tag = openMatch[1].toLowerCase();
    const attrsRaw = openMatch[2] ?? '';
    const selfClosing = /\/\s*$/.test(attrsRaw) || VOID_ELEMENTS.has(tag);
    const token = { type: 'open', tag, attrs: parseAttributes(attrsRaw), selfClosing };
    tokens.push(token);
    index = nextTag + openMatch[0].length;

    if (!selfClosing && RAW_TEXT_ELEMENTS.has(tag)) {
      const closeRe = new RegExp(`<\\s*/\\s*${tag}\\s*>`, 'i');
      const rest = source.slice(index);
      const closeMatchRaw = closeRe.exec(rest);
      const rawContent = closeMatchRaw ? rest.slice(0, closeMatchRaw.index) : rest;
      tokens.push({ type: 'text', raw: rawContent, text: '', rawTextElement: tag });
      index += rawContent.length + (closeMatchRaw ? closeMatchRaw[0].length : 0);
    }
  }

  return tokens;
}

/** Построение дерева с родительскими ссылками и порядковым индексом. */
export function buildTree(tokens) {
  const root = { type: 'element', tag: '#root', attrs: {}, children: [], parent: null, order: 0 };
  const stack = [root];
  let order = 0;

  for (const token of tokens) {
    const parent = stack[stack.length - 1];
    if (token.type === 'text') {
      if (token.text) parent.children.push({ type: 'text', text: token.text, parent, order: order += 1 });
      continue;
    }
    if (token.type === 'open') {
      const node = { type: 'element', tag: token.tag, attrs: token.attrs, children: [], parent, order: order += 1 };
      parent.children.push(node);
      if (!token.selfClosing) stack.push(node);
      continue;
    }
    // close
    for (let i = stack.length - 1; i > 0; i -= 1) {
      if (stack[i].tag === token.tag) {
        stack.length = i;
        break;
      }
    }
  }

  return root;
}

/** CSS-подобный класс элемента (атрибут class). */
export function classesOf(node) {
  const value = node?.attrs?.class;
  if (!value) return [];
  return String(value).split(/\s+/).filter(Boolean);
}

export function hasClass(node, className) {
  return classesOf(node).includes(className);
}

/** Обход дерева в глубину. */
export function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) {
    if (child.type === 'element') walk(child, visit);
  }
}

/** Список всех элементов дерева (без корня). */
export function allElements(root) {
  const out = [];
  walk(root, (node) => {
    if (node.type === 'element' && node !== root) out.push(node);
  });
  return out;
}

/** Текст внутри узла, склеенный с нормализацией пробелов. */
export function textOf(node, { separator = ' ' } = {}) {
  const parts = [];
  const visit = (current) => {
    for (const child of current.children ?? []) {
      if (child.type === 'text') {
        parts.push(child.text);
      } else if (child.type === 'element') {
        visit(child);
      }
    }
  };
  if (node) visit(node);
  return normalizeWhitespace(parts.join(separator));
}

/** Нормализация пробелов: nbsp -> пробел, схлопывание, обрезка. */
export function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v\r\n]+/g, ' ')
    .trim();
}

/** Поиск первого элемента, удовлетворяющего предикату. */
export function findElement(root, predicate) {
  let found = null;
  walk(root, (node) => {
    if (found || node.type !== 'element') return;
    if (predicate(node)) found = node;
  });
  return found;
}

/** Поиск всех элементов, удовлетворяющих предикату. */
export function findAll(root, predicate) {
  const out = [];
  walk(root, (node) => {
    if (node.type === 'element' && predicate(node)) out.push(node);
  });
  return out;
}

/**
 * Поиск кандидатов карточек по нескольким независимым «следам» разметки.
 * Возвращает первого кандидата из наиболее специфичного набора, либо пустой список.
 */
export function findCandidates(root, candidateSpecs) {
  for (const spec of candidateSpecs) {
    const matches = findAll(root, spec.match);
    if (matches.length > 0) {
      // Отбрасываем кандидатов, вложенных в другого кандидата (дубли из-за обёрток).
      const filtered = matches.filter((node) => !matches.some((other) => other !== node && isDescendant(node, other)));
      return { matchedBy: spec.id, nodes: filtered };
    }
  }
  return { matchedBy: null, nodes: [] };
}

export function isDescendant(node, possibleAncestor) {
  let current = node.parent;
  while (current) {
    if (current === possibleAncestor) return true;
    current = current.parent;
  }
  return false;
}

/** Простой парсер HTML -> дерево. */
export function parseHtml(html) {
  return buildTree(tokenize(html));
}

/** Извлечение содержимого <title>. */
export function documentTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''));
  return match ? normalizeWhitespace(decodeEntities(match[1])) : '';
}
