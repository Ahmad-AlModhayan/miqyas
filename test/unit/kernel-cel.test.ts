// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Truth, compile, evaluate } from '../../src/kernel/cel.js';

describe('evaluating a compiled expression', () => {
  it('gives true when the rule holds for the item', () => {
    const rule = compile("item.role == 'alert' && item.rendered");
    expect(evaluate(rule, { item: { role: 'alert', rendered: true } })).toBe('true');
  });

  it('gives false when the rule does not hold for the item', () => {
    const rule = compile("item.role == 'alert' && item.rendered");
    expect(evaluate(rule, { item: { role: 'alert', rendered: false } })).toBe('false');
  });

  it('reads whole numbers in the variables as integers', () => {
    expect(evaluate(compile('item.count + 1 == 3'), { item: { count: 2 } })).toBe('true');
    expect(evaluate(compile('item.count / 2 == 1'), { item: { count: 3 } })).toBe('true');
  });
});

describe('an evaluation error is never true or false', () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['a missing field', "item.missing == 'x'", { item: { role: 'alert' } }],
    ['a missing variable', 'nobody.role == 1', { item: {} }],
    ['a type mismatch', "item.count + 'a' == 'b'", { item: { count: 1 } }],
    ['comparing unlike types', "item.count < 'a'", { item: { count: 1 } }],
    ['a division by zero', 'item.count / 0 == 1', { item: { count: 1 } }],
    ['an integer overflow', 'item.count + 1 > 0', { item: { count: 9223372036854775807n } }],
    ['an index out of range', 'item.list[5] == 1', { item: { list: [1, 2] } }],
    ['a regular expression that does not parse', "item.text.matches('(')", { item: { text: 'a' } }],
    ['a result that is not a yes or no', 'item.count + 1', { item: { count: 1 } }],
    ['a field read through a prototype name', 'item.constructor == 1', { item: { a: 1 } }],
  ];
  for (const [name, source, variables] of cases) {
    it(`gives error for ${name}`, () => {
      expect(evaluate(compile(source), variables)).toBe('error');
    });
  }

  it('does not let an error decide the result of && or || when the other side does not decide it', () => {
    expect(evaluate(compile('item.missing == 1 && true'), { item: {} })).toBe('error');
    expect(evaluate(compile('item.missing == 1 || false'), { item: {} })).toBe('error');
  });

  it('absorbs an error only when the other side already decides the result', () => {
    expect(evaluate(compile('item.missing == 1 && false'), { item: {} })).toBe('false');
    expect(evaluate(compile('item.missing == 1 || true'), { item: {} })).toBe('true');
  });

  it('keeps CEL equality across types: == is false, != is true, and in is a yes or no, never an error', () => {
    expect(evaluate(compile("'a' == 1"), {})).toBe('false');
    expect(evaluate(compile("'a' != 1"), {})).toBe('true');
    expect(evaluate(compile("1 in ['a']"), {})).toBe('false');
    expect(evaluate(compile("'a' in [1, 'a']"), {})).toBe('true');
    expect(evaluate(compile('item.n == null'), { item: { n: 1 } })).toBe('false');
    // Ordering across types is still an error.
    expect(evaluate(compile("'a' < 1"), {})).toBe('error');
  });

  it('gives the usable example false, not error, when a status arrives as text', () => {
    const usable = compile('item.owner_status == 200 && item.other_status != 401');
    expect(evaluate(usable, { item: { owner_status: '200', other_status: 403 } })).toBe('false');
    expect(evaluate(usable, { item: { owner_status: 200, other_status: '401' } })).toBe('true');
  });

  it('lets exists be true when one element is true and another is an error', () => {
    expect(evaluate(compile("['a', 1].exists(a, a > 0)"), {})).toBe('true');
    expect(evaluate(compile("['a', 0].exists(a, a > 0)"), {})).toBe('error');
  });

  it('lets all be false when one element is false and another is an error', () => {
    expect(evaluate(compile("['a', 0].all(a, a > 0)"), {})).toBe('false');
    expect(evaluate(compile("['a', 1].all(a, a > 0)"), {})).toBe('error');
  });

  it('gives exists_one error when any element is an error', () => {
    expect(evaluate(compile("['a', 1].exists_one(a, a > 0)"), {})).toBe('error');
    expect(evaluate(compile("['a', 1, 2].exists_one(a, a > 0)"), {})).toBe('error');
  });

  it('gives map and filter error when any element is an error', () => {
    expect(evaluate(compile("['a', 1].filter(a, a > 0).size() == 1"), {})).toBe('error');
    expect(evaluate(compile("['a', 1].map(a, a + 1).size() == 2"), {})).toBe('error');
  });

  it('gives error for a variable that cannot be read as a CEL value', () => {
    const bad: unknown[] = [
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      2n ** 63n,
      () => 1,
      new Date(0),
      Symbol('x'),
      new (class Thing {})(),
    ];
    for (const value of bad) {
      expect(evaluate(compile('true'), { item: value })).toBe('error');
    }
  });
});

describe('the examples in docs/cel-subset.md', () => {
  const doc = readFileSync(new URL('../../docs/cel-subset.md', import.meta.url), 'utf8');
  const examples: Array<[string, string, Record<string, unknown>, Truth]> = [
    ['where', 'item.role == "button" && !item.hidden', { item: { role: 'button', hidden: false } }, 'true'],
    ['holds', 'item.name.size() > 0 && !normalize(item.name).contains("click here")', { item: { name: ' Save ' } }, 'true'],
    ['usable', 'item.owner_status == 200 && item.other_status != 401', { item: { owner_status: 200, other_status: 401 } }, 'false'],
    ['count', 'n >= 1 && n <= 3', { n: 2 }, 'true'],
    ['covered', 'ctx.pages.size() > 0 && ctx.inputs.accounts.size() >= 2', { ctx: { pages: ['/'], inputs: { accounts: ['a', 'b'] } } }, 'true'],
  ];
  for (const [place, expression, variables, truth] of examples) {
    it(`${place}: appears in the document and gives ${truth}`, () => {
      expect(doc).toContain('```cel\n' + expression + '\n```');
      expect(evaluate(compile(expression), variables)).toBe(truth);
    });
  }
});
