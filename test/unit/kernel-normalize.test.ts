// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile, evaluate } from '../../src/kernel/cel.js';
import { normalize } from '../../src/kernel/normalize.js';

interface Vector {
  name: string;
  input: string;
  expected: string;
}

const vectors = (
  JSON.parse(readFileSync(new URL('../vectors/normalize.json', import.meta.url), 'utf8')) as { vectors: Vector[] }
).vectors;

describe('normalize() against the shared vectors', () => {
  it('has vectors for every part of the rule', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(30);
  });

  for (const vector of vectors) {
    it(`${vector.name}`, () => {
      expect(normalize(vector.input)).toBe(vector.expected);
    });
  }

  it('gives the same text again when it is applied to its own result', () => {
    for (const vector of vectors) {
      expect(normalize(normalize(vector.input)), vector.name).toBe(normalize(vector.input));
    }
  });
});

describe('normalize() inside a CEL expression', () => {
  const rule = compile('normalize(item.input) == item.expected');

  for (const vector of vectors) {
    it(`${vector.name}`, () => {
      expect(evaluate(rule, { item: { input: vector.input, expected: vector.expected } })).toBe('true');
    });
  }

  it('compares two spellings of the same text as equal, and different text as different', () => {
    const same = compile('normalize(item.a) == normalize(item.b)');
    expect(evaluate(same, { item: { a: 'Required Field', b: '  REQUIRED   field ' } })).toBe('true');
    expect(evaluate(same, { item: { a: 'أحمد', b: 'احمد' } })).toBe('true');
    expect(evaluate(same, { item: { a: 'abc', b: 'abd' } })).toBe('false');
  });

  it('is the call the foundation example makes', () => {
    const alert = compile("event.nodes.exists(n, n.role == 'alert' && n.rendered && normalize(n.text).contains('required'))");
    const event = { nodes: [{ role: 'alert', rendered: true, text: ' This Field Is  REQUIRED ' }] };
    expect(evaluate(alert, { event })).toBe('true');
    expect(evaluate(alert, { event: { nodes: [{ role: 'alert', rendered: false, text: 'required' }] } })).toBe('false');
  });

  it('gives error for something that is not text', () => {
    expect(evaluate(compile('normalize(item.n) == "1"'), { item: { n: 1 } })).toBe('error');
    expect(evaluate(compile('normalize(item.missing) == ""'), { item: {} })).toBe('error');
    expect(evaluate(compile('normalize(item.s, item.s) == ""'), { item: { s: 'a' } })).toBe('error');
  });
});
