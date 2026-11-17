// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { compile, evaluate } from '../../src/kernel/cel.js';

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
