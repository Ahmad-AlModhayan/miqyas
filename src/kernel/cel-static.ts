// SPDX-License-Identifier: AGPL-3.0-only
// The static checks on a CEL expression's text, made when it is loaded and before any CEL library sees it: its
// length, how deeply it nests, the largest list or map literal in it, and whether it stays inside the documented
// subset (docs/cel-subset.md). It reads tokens itself, so what it accepts does not depend on the library in use.
// The bound on the work an expression can do is in cel-cost.ts. Pure functions of the text: no clock and no Node API.

export interface CelLimits {
  /** Characters in the expression. */
  readonly maxLength: number;
  /** Nesting of parentheses, brackets and braces. */
  readonly maxDepth: number;
  /** Comprehensions (`all`, `exists`, `exists_one`, `map`, `filter`) inside one another. */
  readonly maxComprehensionDepth: number;
  /** Elements in a list or map literal; also the most a list or map in the variables may hold. */
  readonly maxListLength: number;
  /** Characters (UTF-16 code units) in one text in the variables. */
  readonly maxStringLength: number;
  /** The size of all the variables together: 1 for each value, plus the length of each text. */
  readonly maxInputSize: number;
  /** The most work the expression may do, in steps, over the largest variables the limits above allow. */
  readonly maxCost: number;
}

export const DEFAULT_LIMITS: CelLimits = Object.freeze({
  maxLength: 1024,
  maxDepth: 16,
  maxComprehensionDepth: 2,
  maxListLength: 1000,
  maxStringLength: 1000,
  maxInputSize: 10_000,
  maxCost: 40_000_000,
});

export type StaticRejection =
  | { reason: 'limit'; limit: keyof CelLimits; message: string }
  | { reason: 'syntax' | 'subset'; message: string };

const GLOBAL_FUNCTIONS = new Set(['size', 'has', 'int', 'string', 'matches', 'normalize']);
const METHODS = new Set(['size', 'contains', 'startsWith', 'endsWith', 'matches']);
const MACROS = new Set(['all', 'exists', 'exists_one', 'map', 'filter']);
const WORDS = new Set(['in', 'true', 'false', 'null']);

interface Frame {
  readonly kind: 'call' | 'group' | 'list' | 'index' | 'map';
  readonly name: string;
  readonly macro: boolean;
  commas: number;
  hasContent: boolean;
  trailingComma: boolean;
}

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

const outside = (what: string): StaticRejection => ({
  reason: 'subset',
  message: `${what} is outside the allowed CEL subset (see docs/cel-subset.md)`,
});
const syntax = (what: string): StaticRejection => ({ reason: 'syntax', message: `syntax error: ${what}` });
const overLimit = (limit: keyof CelLimits, what: string, limits: CelLimits): StaticRejection => ({
  reason: 'limit',
  limit,
  message: `${what}, over the limit ${limit} of ${limits[limit]}`,
});
const frame = (kind: Frame['kind'], name = '', macro = false): Frame => ({
  kind,
  name,
  macro,
  commas: 0,
  hasContent: false,
  trailingComma: false,
});

/** The first reason the text cannot be loaded, or undefined when it passes every static check. */
export function checkStatic(source: string, limits: CelLimits): StaticRejection | undefined {
  if (source.length > limits.maxLength) {
    return overLimit('maxLength', `the expression is ${source.length} characters`, limits);
  }

  const stack: Frame[] = [];
  let macros = 0;
  // The previous token: its kind, and its text for an identifier.
  let prev: { kind: 'start' | 'ident' | 'value' | 'close' | 'dot' | 'open' | 'other'; text: string } = { kind: 'start', text: '' };
  // The token before the previous one, so that `.name(` is read as a method and `name(` as a function.
  let tokenBeforePrev = '';
  const top = () => stack[stack.length - 1];
  const push = (kind: 'ident' | 'value' | 'close' | 'dot' | 'open' | 'other', text: string) => {
    tokenBeforePrev = prev.kind === 'dot' ? '.' : prev.text;
    prev = { kind, text };
    const current = top();
    if (current !== undefined && text !== ',') {
      current.hasContent = true;
      current.trailingComma = false;
    }
  };

  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i += 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') return outside('a comment');
    if (c === '`') return outside('a quoted field name');

    let prefix = '';
    let quoteAt = -1;
    let identEnd = i;
    if (isIdentStart(c)) {
      while (identEnd < n && isIdentPart(source[identEnd] as string)) identEnd += 1;
      const word = source.slice(i, identEnd);
      const lower = word.toLowerCase();
      if ((lower === 'r' || lower === 'b' || lower === 'rb' || lower === 'br') && (source[identEnd] === '"' || source[identEnd] === "'")) {
        prefix = lower;
        quoteAt = identEnd;
      }
    } else if (c === '"' || c === "'") {
      quoteAt = i;
    }

    if (quoteAt >= 0) {
      if (prefix.includes('b')) return outside('a bytes literal');
      const quote = source[quoteAt] as string;
      const triple = source.startsWith(quote.repeat(3), quoteAt);
      const raw = prefix.includes('r');
      let k = quoteAt + (triple ? 3 : 1);
      let closed = false;
      while (k < n) {
        const ch = source[k] as string;
        if (!raw && ch === '\\') {
          k += 2;
          continue;
        }
        if (triple ? source.startsWith(quote.repeat(3), k) : ch === quote) {
          closed = true;
          break;
        }
        if (!triple && ch === '\n') break;
        k += 1;
      }
      if (!closed) return syntax('a string is not closed');
      i = k + (triple ? 3 : 1);
      push('value', '');
      continue;
    }

    if (isIdentStart(c)) {
      const word = source.slice(i, identEnd);
      i = identEnd;
      push('ident', word);
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(source[i + 1] ?? ''))) {
      let k = i;
      let real = false;
      if (c === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        k += 2;
        while (k < n && /[0-9a-fA-F]/.test(source[k] as string)) k += 1;
      } else {
        while (k < n && isDigit(source[k] as string)) k += 1;
        if (source[k] === '.' && isDigit(source[k + 1] ?? '')) {
          real = true;
          k += 1;
          while (k < n && isDigit(source[k] as string)) k += 1;
        }
        if ((source[k] === 'e' || source[k] === 'E') && /[0-9+-]/.test(source[k + 1] ?? '')) {
          real = true;
          k += 1;
          if (source[k] === '+' || source[k] === '-') k += 1;
          while (k < n && isDigit(source[k] as string)) k += 1;
        }
      }
      if (real) return outside('a number with a fraction or an exponent');
      if (source[k] === 'u' || source[k] === 'U') return outside('an unsigned integer');
      i = k;
      push('value', '');
      continue;
    }

    i += 1;
    let openedFrame: Frame | undefined;
    switch (c) {
      case '(': {
        const call = prev.kind === 'ident' && !WORDS.has(prev.text);
        if (call) {
          const method = tokenBeforePrev === '.';
          const name = prev.text;
          const known = method ? METHODS.has(name) || MACROS.has(name) : GLOBAL_FUNCTIONS.has(name);
          if (!known) return outside(`the ${method ? 'method' : 'function'} ${name}()`);
          const macro = method && MACROS.has(name);
          if (macro) {
            macros += 1;
            if (macros > limits.maxComprehensionDepth) {
              return overLimit('maxComprehensionDepth', `comprehensions nest ${macros} deep`, limits);
            }
          }
          openedFrame = frame('call', method ? `.${name}` : name, macro);
        } else {
          openedFrame = frame('group');
        }
        break;
      }
      case '[': {
        if (source[i] === '?') return outside('an optional index');
        const index = prev.kind === 'value' || prev.kind === 'close' || (prev.kind === 'ident' && prev.text !== 'in');
        openedFrame = frame(index ? 'index' : 'list');
        break;
      }
      case '{':
        if (prev.kind === 'ident' && !WORDS.has(prev.text)) return outside('constructing a message');
        openedFrame = frame('map');
        break;
      case ')':
      case ']':
      case '}': {
        const closed = stack.pop();
        const want = closed?.kind === 'call' || closed?.kind === 'group' ? ')' : closed?.kind === 'map' ? '}' : ']';
        if (closed === undefined || want !== c) return syntax(`unexpected ${c}`);
        if (closed.macro) macros -= 1;
        const count = closed.hasContent ? closed.commas + 1 - (closed.trailingComma ? 1 : 0) : 0;
        if ((closed.kind === 'list' || closed.kind === 'map') && count > limits.maxListLength) {
          return overLimit('maxListLength', `a ${closed.kind} literal has ${count} elements`, limits);
        }
        if (closed.kind === 'call') {
          const bad = checkArity(closed, count);
          if (bad !== undefined) return bad;
        }
        push('close', ')');
        continue;
      }
      case ',': {
        const current = top();
        if (current !== undefined) {
          current.commas += 1;
          current.trailingComma = true;
        }
        push('other', ',');
        continue;
      }
      case '.':
        push('dot', '.');
        continue;
      case '?':
        if (prev.kind === 'dot') return outside('an optional field');
        push('other', '?');
        continue;
      default:
        push('other', c);
        continue;
    }

    push('open', c);
    if (openedFrame === undefined) continue;
    stack.push(openedFrame);
    if (stack.length > limits.maxDepth) return overLimit('maxDepth', `the expression nests ${stack.length} deep`, limits);
  }

  if (stack.length > 0) return syntax('a bracket is not closed');
  return undefined;
}

function checkArity(frame: Frame, count: number): StaticRejection | undefined {
  const bare = frame.name.replace(/^\./, '');
  if (frame.macro) {
    const ok = bare === 'map' ? count === 2 || count === 3 : count === 2;
    if (!ok) return outside(`${bare}() with ${count} arguments (the form with two variables is not allowed)`);
  } else if (bare === 'has' && count !== 1) {
    return syntax('has() takes one argument');
  }
  return undefined;
}
