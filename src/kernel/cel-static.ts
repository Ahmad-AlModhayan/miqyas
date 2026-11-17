// SPDX-License-Identifier: AGPL-3.0-only
// The static checks on a CEL expression's text, made when it is loaded and before any CEL library sees it: its
// length, how deeply it nests, the largest list or map literal in it, and whether it stays inside the documented
// subset (docs/cel-subset.md). It reads tokens itself, so what it accepts does not depend on the library in use.
// Pure functions of the text: no clock and no Node API.

export interface CelLimits {
  /** Characters in the expression. */
  readonly maxLength: number;
  /** Nesting of parentheses, brackets and braces. */
  readonly maxDepth: number;
  /** Comprehensions (`all`, `exists`, `exists_one`, `map`, `filter`) inside one another. */
  readonly maxComprehensionDepth: number;
  /** Elements in a list or map literal; also the most a list or map may hold when the expression is evaluated. */
  readonly maxListLength: number;
}

export const DEFAULT_LIMITS: CelLimits = Object.freeze({
  maxLength: 1024,
  maxDepth: 16,
  maxComprehensionDepth: 2,
  maxListLength: 1000,
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

/** The first reason the text cannot be loaded, or undefined when it passes every static check. */
export function checkStatic(source: string, limits: CelLimits): StaticRejection | undefined {
  if (source.length > limits.maxLength) {
    return {
      reason: 'limit',
      limit: 'maxLength',
      message: `the expression is ${source.length} characters, over the limit maxLength of ${limits.maxLength}`,
    };
  }

  const stack: Frame[] = [];
  let macros = 0;
  // The previous token: its kind, and its text for an identifier.
  let prev: { kind: 'start' | 'ident' | 'value' | 'close' | 'dot' | 'open' | 'other'; text: string } = { kind: 'start', text: '' };
  let beforePrev = '';
  const top = () => stack[stack.length - 1];
  const push = (kind: 'ident' | 'value' | 'close' | 'dot' | 'open' | 'other', text: string) => {
    beforePrev = prev.kind === 'dot' ? '.' : prev.text;
    prev = { kind, text };
    const frame = top();
    if (frame !== undefined && text !== ',') {
      frame.hasContent = true;
      frame.trailingComma = false;
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
    let opened: Frame | undefined;
    switch (c) {
      case '(': {
        const call = prev.kind === 'ident' && !WORDS.has(prev.text);
        let frame: Frame;
        if (call) {
          const method = beforePrev === '.';
          const name = prev.text;
          const known = method ? METHODS.has(name) || MACROS.has(name) : GLOBAL_FUNCTIONS.has(name);
          if (!known) return outside(`the ${method ? 'method' : 'function'} ${name}()`);
          const macro = method && MACROS.has(name);
          if (macro) {
            macros += 1;
            if (macros > limits.maxComprehensionDepth) {
              return {
                reason: 'limit',
                limit: 'maxComprehensionDepth',
                message: `comprehensions nest ${macros} deep, over the limit maxComprehensionDepth of ${limits.maxComprehensionDepth}`,
              };
            }
          }
          frame = { kind: 'call', name: method ? `.${name}` : name, macro, commas: 0, hasContent: false, trailingComma: false };
        } else {
          frame = { kind: 'group', name: '', macro: false, commas: 0, hasContent: false, trailingComma: false };
        }
        opened = frame;
        break;
      }
      case '[': {
        if (source[i] === '?') return outside('an optional index');
        const index = prev.kind === 'value' || prev.kind === 'close' || (prev.kind === 'ident' && prev.text !== 'in');
        opened = { kind: index ? 'index' : 'list', name: '', macro: false, commas: 0, hasContent: false, trailingComma: false };
        break;
      }
      case '{':
        if (prev.kind === 'ident' && !WORDS.has(prev.text)) return outside('constructing a message');
        opened = { kind: 'map', name: '', macro: false, commas: 0, hasContent: false, trailingComma: false };
        break;
      case ')':
      case ']':
      case '}': {
        const frame = stack.pop();
        const want = frame?.kind === 'call' || frame?.kind === 'group' ? ')' : frame?.kind === 'map' ? '}' : ']';
        if (frame === undefined || want !== c) return syntax(`unexpected ${c}`);
        if (frame.macro) macros -= 1;
        const count = frame.hasContent ? frame.commas + 1 - (frame.trailingComma ? 1 : 0) : 0;
        if ((frame.kind === 'list' || frame.kind === 'map') && count > limits.maxListLength) {
          return {
            reason: 'limit',
            limit: 'maxListLength',
            message: `a ${frame.kind === 'list' ? 'list' : 'map'} literal has ${count} elements, over the limit maxListLength of ${limits.maxListLength}`,
          };
        }
        if (frame.kind === 'call') {
          const bad = checkArity(frame, count);
          if (bad !== undefined) return bad;
        }
        push('close', ')');
        continue;
      }
      case ',': {
        const frame = top();
        if (frame !== undefined) {
          frame.commas += 1;
          frame.trailingComma = true;
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
    if (opened === undefined) continue;
    stack.push(opened);
    if (stack.length > limits.maxDepth) {
      return {
        reason: 'limit',
        limit: 'maxDepth',
        message: `the expression nests ${stack.length} deep, over the limit maxDepth of ${limits.maxDepth}`,
      };
    }
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
