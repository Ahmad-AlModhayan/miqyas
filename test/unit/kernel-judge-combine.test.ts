// SPDX-License-Identifier: AGPL-3.0-only
// Combinations (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A5): `all` and `any` in three values, for every pair of part
// values; an empty list refused when loaded; and a combination's record, judged by the real judge over real parts.
import { describe, expect, it } from 'vitest';
import { VERDICTS, type VerdictValue, combine } from '../../src/kernel/judge.js';
import { done, item, judge, leftItem, loadFile, pairClaimFile, place, rightItem, setClaimFile } from '../kernel-helpers.js';

/** Kleene's strong logic written here apart from the judge: F < U < T, `all` the least and `any` the greatest. */
const rank = (v: VerdictValue) => (v === 'fail' ? 0 : v === 'pass' ? 2 : 1);
const NOT_KNOWN: VerdictValue[] = ['blocked', 'not_checked', 'unverified'];
function expected(how: 'all' | 'any', a: VerdictValue, b: VerdictValue): VerdictValue {
  const r = how === 'all' ? Math.min(rank(a), rank(b)) : Math.max(rank(a), rank(b));
  if (r === 0) return 'fail';
  if (r === 2) return 'pass';
  return NOT_KNOWN.find((w) => w === a || w === b) as VerdictValue;
}

describe('all and any combine in three values', () => {
  for (const how of ['all', 'any'] as const) {
    for (const a of VERDICTS) {
      for (const b of VERDICTS) {
        it(`${how}(${a}, ${b}) is ${expected(how, a, b)}`, () => {
          expect(combine(how, [a, b])).toBe(expected(how, a, b));
          expect(combine(how, [b, a])).toBe(expected(how, a, b));
        });
      }
    }
  }

  it('one part gives that part; an empty list is refused', () => {
    for (const v of VERDICTS) expect(combine('all', [v])).toBe(v);
    expect(() => combine('all', [])).toThrow(/empty list/);
    expect(() => combine('any', [])).toThrow(/empty list/);
  });
});

/** A set part over `t.item` and a pair part over `t.left` and `t.right`, without the examples a whole file carries. */
const part = (file: { examples: unknown }, id: string) => {
  const { examples: _, ...rest } = file;
  return { ...rest, id };
};
const setPart = part(setClaimFile('every', { fail: [item(1)], pass: [item(9)] }), 'part.set');
const pairPart = part(pairClaimFile('every', { fail: [], pass: [] }), 'part.pair');
const examples = [
  { name: 'fails', expect: 'fail', facts: [item(1), leftItem(1, 1), rightItem(1, 1), done()] },
  { name: 'passes', expect: 'pass', facts: [item(9), leftItem(1, 1), rightItem(1, 1), done()] },
  { name: 'not collected', expect: 'not_checked', facts: [done('failed')] },
];
const combination = (how: 'all' | 'any', parts: unknown[] = [setPart, pairPart], extra: Record<string, unknown> = {}) => ({
  id: `test.${how}`,
  version: 1,
  title: `${how} of two parts`,
  [how]: parts,
  // `any` fails only when both parts fail, and passes on the set part alone.
  examples:
    how === 'all'
      ? examples
      : [{ ...examples[0], facts: [item(1), leftItem(1, 1), rightItem(1, 2), done()] }, { ...examples[1], facts: [item(9), done()] }, examples[2]],
  ...extra,
});

describe('a combination claim', () => {
  it('judges each part over the same view and records each part; its read set is every part’s', async () => {
    const loaded = await loadFile(combination('all'));
    // 1 item fails, 2-3 a pair that holds, 4 the collection.
    const v = judge(loaded, place([item(1), leftItem(1, 1), rightItem(1, 1), done()]));
    expect(v.verdict).toBe('fail');
    expect(v.claim).toBe('test.all@1');
    expect(v.parts?.map((p) => [p.claim, p.verdict])).toEqual([
      ['part.set@1', 'fail'],
      ['part.pair@1', 'pass'],
    ]);
    expect(v.read).toEqual([1, 2, 3, 4]);
    expect(v.shown).toEqual([1]);
    expect(v.view.kinds).toEqual(['t.item', 'collection', 't.left', 't.right']);
    expect(v.failed_on).toBe('fails');
    expect(v.parts?.every((p) => p.rule === v.rule)).toBe(true);
  });

  it('any: one passing part passes; the reason of a not-known answer is that of the part that gave it', async () => {
    const loaded = await loadFile(combination('any'));
    expect(judge(loaded, place([item(9), done()])).verdict).toBe('pass');
    const v = judge(loaded, place([item(1), leftItem(1, 1), rightItem(2, 1), done()]));
    expect(v.verdict).toBe('not_checked');
    expect(v.reason).toBe('coverage not met');
  });

  it('what to add is every blocked part’s', async () => {
    const needs = (kinds: string[]) => ({ needs: { kinds } });
    const loaded = await loadFile(combination('all', [{ ...setPart, ...needs(['t.item']) }, { ...pairPart, ...needs(['t.left', 't.right']) }]));
    const v = judge(loaded, place([item(9), leftItem(1, 1), rightItem(1, 1), done()]));
    expect(v.verdict).toBe('blocked');
    expect(v.add).toEqual(['kind:t.item', 'kind:t.left', 'kind:t.right']);
    expect(judge(loaded, place([item(9), leftItem(1, 1), rightItem(1, 1), done()]), { supplies: { kinds: ['t.item', 't.left', 't.right'] } }).verdict).toBe('pass');
  });

  it('nests: a combination may be a part', async () => {
    const inner = { id: 'inner', version: 1, title: 'inner', any: [setPart] };
    const loaded = await loadFile(combination('all', [inner, pairPart]));
    expect(judge(loaded, place([item(9), leftItem(1, 1), rightItem(1, 1), done()])).parts?.[0]?.parts?.[0]?.claim).toBe('part.set@1');
  });
});

describe('the loader refuses a combination', () => {
  const refused = (file: unknown) => expect(loadFile(file)).rejects;

  it('with an empty list, or a list that is not one', async () => {
    await refused(combination('all', [])).toThrow(/needs all as a list of claims: an empty list is refused/);
    await refused(combination('any', [])).toThrow(/needs any as a list of claims: an empty list is refused/);
    await refused({ ...combination('all'), all: setPart }).toThrow(/needs all as a list of claims/);
    await refused(combination('all', [{ id: 'inner', version: 1, title: 'inner', all: [] }])).toThrow(/part all\[0\] needs all as a list of claims/);
  });

  it('with both all and any, or with keys a combination does not read', async () => {
    await refused({ ...combination('all'), any: [setPart] }).toThrow(/has both all and any/);
    await refused(combination('all', undefined, { covered: 'true' })).toThrow(/unknown key "covered"/);
    await refused(combination('all', undefined, { needs: { kinds: [] } })).toThrow(/unknown key "needs"/);
  });

  it('with a part that is not a claim the judge takes, naming the part', async () => {
    await refused(combination('all', [setPart, { ...pairPart, unmatched: 'drop' }])).toThrow(/^part all\[1\] needs unmatched/);
    await refused(combination('all', [{ ...setPart, examples }])).toThrow(/part all\[0\] has an unknown key "examples"/);
    await refused(combination('all', [{ ...setPart, shape: 'trace' }])).toThrow(/part all\[0\] has shape "trace"/);
  });
});
