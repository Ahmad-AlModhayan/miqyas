// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { CelRejection, DEFAULT_LIMITS, compile, evaluate } from '../../src/kernel/cel.js';

function rejection(source: string, limits?: Parameters<typeof compile>[1]): CelRejection {
  try {
    compile(source, limits);
  } catch (error) {
    if (error instanceof CelRejection) return error;
    throw error;
  }
  throw new Error(`expected "${source.slice(0, 40)}" to be rejected`);
}

const nest = (depth: number, inner = '1') => '('.repeat(depth) + inner + ')'.repeat(depth);
const comprehensions = (depth: number) =>
  Array.from({ length: depth }, (_, i) => `xs.all(a${i}, `).join('') + 'true' + ')'.repeat(depth);

describe('static limits, checked when an expression is loaded', () => {
  it('rejects an expression longer than maxLength and names the limit', () => {
    const source = `item.name == '${'a'.repeat(DEFAULT_LIMITS.maxLength)}'`;
    const error = rejection(source);
    expect(error.reason).toBe('limit');
    expect(error.limit).toBe('maxLength');
    expect(error.message).toContain('maxLength');
  });

  it('accepts an expression of exactly maxLength', () => {
    const source = "item.name == 'abc' && true";
    expect(() => compile(source, { maxLength: source.length })).not.toThrow();
    expect(() => compile(source, { maxLength: source.length - 1 })).toThrow(/maxLength/);
  });

  it('rejects nesting deeper than maxDepth, of parentheses, brackets and braces alike', () => {
    for (const source of [nest(DEFAULT_LIMITS.maxDepth + 1), '['.repeat(DEFAULT_LIMITS.maxDepth + 1) + ']'.repeat(DEFAULT_LIMITS.maxDepth + 1)]) {
      const error = rejection(source);
      expect(error.limit).toBe('maxDepth');
      expect(error.message).toContain('maxDepth');
    }
    expect(rejection('{"a":'.repeat(20) + '1' + '}'.repeat(20)).limit).toBe('maxDepth');
    expect(() => compile(nest(DEFAULT_LIMITS.maxDepth))).not.toThrow();
  });

  it('does not count brackets inside a string literal', () => {
    const open = '('.repeat(100);
    expect(() => compile(`item.text == "${open}"`)).not.toThrow();
    expect(() => compile(`item.text == '''${open}'''`)).not.toThrow();
    expect(() => compile(`item.text == r"${open}"`)).not.toThrow();
    expect(() => compile(`item.text == "\\"${open}"`)).not.toThrow();
  });

  it('rejects comprehensions nested deeper than maxComprehensionDepth', () => {
    expect(() => compile(comprehensions(DEFAULT_LIMITS.maxComprehensionDepth))).not.toThrow();
    const error = rejection(comprehensions(DEFAULT_LIMITS.maxComprehensionDepth + 1));
    expect(error.limit).toBe('maxComprehensionDepth');
    expect(error.message).toContain('maxComprehensionDepth');
  });

  it('counts comprehensions that are nested, not ones that follow each other', () => {
    expect(() => compile('xs.all(a, a > 0) && xs.exists(b, b > 1) && xs.map(c, c).size() > 0 && xs.filter(d, d > 0).size() > 0')).not.toThrow();
  });

  it('rejects a list or map literal with more than maxListLength elements', () => {
    const elements = (n: number) => Array.from({ length: n }, (_, i) => String(i)).join(',');
    const wide = { maxLength: 1_000_000 };
    const list = rejection(`[${elements(DEFAULT_LIMITS.maxListLength + 1)}].size() > 0`, wide);
    expect(list.limit).toBe('maxListLength');
    expect(list.message).toContain('maxListLength');
    const map = rejection(`{${Array.from({ length: DEFAULT_LIMITS.maxListLength + 1 }, (_, i) => `${i}:1`).join(',')}}.size() > 0`, wide);
    expect(map.limit).toBe('maxListLength');
    expect(() => compile(`1 in [${elements(DEFAULT_LIMITS.maxListLength)}]`, wide)).not.toThrow();
  });

  it('does not take indexing for a list literal, and counts the elements of a nested list', () => {
    expect(() => compile('item.rows[0][1] == 2', { maxListLength: 1 })).not.toThrow();
    expect(rejection('[[1,2,3],[4]].size() > 0', { maxListLength: 2 }).limit).toBe('maxListLength');
    expect(() => compile('x in [1,2,]', { maxListLength: 2 })).not.toThrow();
  });

  it('takes limits from the caller, and the caller cannot switch one off with a bad value', () => {
    expect(rejection('1 == 1', { maxLength: 3 }).limit).toBe('maxLength');
    expect(() => compile('1 == 1', { maxLength: Number.NaN })).toThrow(RangeError);
    expect(() => compile('1 == 1', { maxDepth: -1 })).toThrow(RangeError);
    expect(() => compile('1 == 1', { maxListLength: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it('measures a list the expression may walk in the variables too, and an item over the limit is an error', () => {
    const rule = compile('item.rows.all(r, r > 0)', { maxListLength: 3 });
    expect(evaluate(rule, { item: { rows: [1, 2, 3] } })).toBe('true');
    expect(evaluate(rule, { item: { rows: [1, 2, 3, 4] } })).toBe('error');
    expect(evaluate(rule, { item: { rows: { a: 1, b: 2, c: 3, d: 4 } } })).toBe('error');
  });

  it('gives error for variables nested so deep that reading them would exhaust the stack', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(evaluate(compile('true'), { item: deep })).toBe('error');
  });

  it('rejects a syntax error and says it is one', () => {
    for (const source of ['1 +', '(1', 'item.', "'unterminated", '"""never closed', '1 == == 2', 'has(item.a, item.b)', '']) {
      const error = rejection(source);
      expect(error.reason).toBe('syntax');
      expect(error.limit).toBeUndefined();
    }
  });
});

describe('the allowed subset, checked when an expression is loaded', () => {
  const outside: Array<[string, string]> = [
    ['a fraction', 'item.n < 1.5'],
    ['an exponent', 'item.n < 1e3'],
    ['an unsigned integer', 'item.n == 1u'],
    ['a bytes literal', "item.s == b'abc'"],
    ['a timestamp', "timestamp('2026-01-01T00:00:00Z') == item.t"],
    ['a duration', "duration('1h') == item.d"],
    ['a comment', 'item.ok // yes'],
    ['a time accessor', 'item.t.getFullYear() == 2026'],
    ['a conversion to a double', 'double(item.n) == 1'],
    ['a conversion to bytes', "bytes('a') == item.b"],
    ['type()', 'type(item) == int'],
    ['dyn()', 'dyn(item) == 1'],
    ['the math extension', 'math.greatest(1, 2) == 2'],
    ['cel.bind', 'cel.bind(a, 1, a == 1)'],
    ['an optional field', 'item.?name.hasValue()'],
    ['an optional index', 'item.rows[?0].hasValue()'],
    ['a quoted field name', 'item.`a-b` == 1'],
    ['a function Miqyas does not define', 'upper(item.s) == "A"'],
    ['a string method outside the subset', "item.s.lowerAscii() == 'a'"],
    ['a macro with two variables', 'item.rows.all(i, v, v > i)'],
    ['a macro that is not one', 'item.rows.reduce(a, b, a + b) == 1'],
  ];
  for (const [name, source] of outside) {
    it(`rejects ${name} and says it is outside the subset`, () => {
      const error = rejection(source);
      expect(error.reason).toBe('subset');
      expect(error.message).toContain('subset');
    });
  }

  it('accepts one expression for each thing the subset allows', () => {
    const inside = [
      "item.role == 'alert' && !(item.hidden) || item.flag",
      'item.n * 2 + 1 - 3 / 1 % 2 >= -1',
      "item.rows.all(r, r.size() > 0) && item.rows.exists(r, r == 'a') && item.rows.exists_one(r, r == 'b')",
      "item.rows.map(r, r + 'x').size() == 2 && item.rows.map(r, r != 'a', r).size() == 1 && item.rows.filter(r, r != 'a').size() == 1",
      "has(item.maybe) ? item.maybe == 1 : false",
      "'a' in item.rows && item.map['k'] == 1 && item.rows[0] == 'a' && null == item.nothing",
      "item.s.contains('a') && item.s.startsWith('a') && item.s.endsWith('a') && item.s.matches('^a+$') && matches(item.s, 'a')",
      "int('12') == 12 && string(12) == '12' && size(item.rows) == 2 && size('abc') == 3",
      "normalize(item.s) == 'a' && [1, 2] + [3] == [1, 2, 3] && {'a': 1}.size() == 1 && 0x10 == 16",
      'r"\\d" == "\\\\d" && """a\nb""" == \'a\\nb\'',
    ];
    for (const source of inside) expect(() => compile(source), source).not.toThrow();
  });
});
