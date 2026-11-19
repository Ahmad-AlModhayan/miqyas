// SPDX-License-Identifier: AGPL-3.0-only
// The judge for `pair` claims (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A2): the two sides joined on a key, the table
// of A1 over the pairs, a key that errors, `unmatched` as `uncovered`, `fail` and `ignore`, `usable` over a pair, and
// the record: reasons, read set, depth and assurance. Every claim here is loaded by the real loader and judged by the
// real judge over the real CEL.
import { describe, expect, it } from 'vitest';
import { ClaimRejection } from '../../src/kernel/claim.js';
import { type JudgeInput, type Quantifier, type Unmatched, type Verdict } from '../../src/kernel/judge.js';
import { type Given, done, judge as judgeOver, leftItem, loadFile, pairClaimFile, place, rightItem } from '../kernel-helpers.js';

type PairQuantifier = Exclude<Quantifier, 'count'>;

/** `holds` is `left.v == right.v`. The examples every claim file must carry, per quantifier. */
const EXAMPLES: Record<PairQuantifier, { fail: Given[]; pass: Given[] }> = {
  every: { fail: [leftItem(1, 1), rightItem(1, 2)], pass: [leftItem(1, 1), rightItem(1, 1)] },
  some: { fail: [leftItem(1, 1), rightItem(1, 2)], pass: [leftItem(1, 1), rightItem(1, 1)] },
  none: { fail: [leftItem(1, 1), rightItem(1, 1)], pass: [leftItem(1, 1), rightItem(1, 2)] },
};

const claimFile = (quantifier: PairQuantifier, extra: Record<string, unknown> = {}) => pairClaimFile(quantifier, EXAMPLES[quantifier], extra);
const load = (quantifier: PairQuantifier, extra: Record<string, unknown> = {}) => loadFile(claimFile(quantifier, extra));
const judge = async (quantifier: PairQuantifier, facts: Given[], extra: Record<string, unknown> = {}, more: Partial<JudgeInput> = {}): Promise<Verdict> =>
  judgeOver(await load(quantifier, extra), place(facts), more);

const row = (v: Verdict) => ({ verdict: v.verdict, reason: v.reason, shown: v.shown });
const pass = (shown: number[] = []) => ({ verdict: 'pass', reason: undefined, shown });
const fail = (shown: number[] = []) => ({ verdict: 'fail', reason: undefined, shown });
const notChecked = (reason: string) => ({ verdict: 'not_checked', reason, shown: [] });
const ERRORED = 'uncertain items: an expression gave an error';
const UNUSABLE = "uncertain items: a measurement couldn't be used";
const COVERAGE = 'coverage not met';

describe('a pair claim joins the two sides on a key', () => {
  it('judges each left item against every right item with the same key, and no other', async () => {
    // Positions: 1 L k1, 2 R k1 (holds), 3 R k1 (holds), 4 L k2, 5 R k2 (holds), 6 the collection.
    const v = await judge('every', [leftItem(1, 5), rightItem(1, 5), rightItem(1, 5), leftItem(2, 7), rightItem(2, 7), done()]);
    expect(row(v)).toEqual(pass());
    expect(v.items).toEqual({ held: 3, failed: 0, outside: 0, uncertain: 0, unmatched: 0 });
  });

  it('compares keys as values: text "1" and the number 1 are different keys, and lists and maps compare by content', async () => {
    const v = await judge('every', [leftItem(1, 5), rightItem('1', 5), done()], { unmatched: 'ignore' });
    expect(v.items).toMatchObject({ held: 0, unmatched: 2 });
    const lists = await judge('every', [leftItem([1, 'a'], 5), rightItem([1, 'a'], 5), leftItem({ b: 1, a: 2 }, 6), rightItem({ a: 2, b: 1 }, 6), done()]);
    expect(lists.items).toMatchObject({ held: 2, unmatched: 0 });
    expect(lists.verdict).toBe('pass');
  });

  it('a key that errors makes its item uncertain, on either side', async () => {
    const left = await judge('every', [leftItem(1, 5), rightItem(1, 5), { ...leftItem(1, 5), body: { v: 5 } }, done()]);
    expect(row(left)).toEqual(notChecked(ERRORED));
    expect(left.items).toMatchObject({ held: 1, uncertain: 1 });
    const right = await judge('every', [leftItem(1, 5), rightItem(1, 5), { ...rightItem(1, 5), body: { v: 5 } }, done()]);
    expect(row(right)).toEqual(notChecked(ERRORED));
  });

  it('a left or right where that is false leaves the item outside; one that errors makes it uncertain', async () => {
    const extra = { left: { from: 't.left', where: 'item.w' }, right: { from: 't.right', where: 'item.w' } };
    const outside = await judge('every', [leftItem(1, 5), rightItem(1, 5), leftItem(2, 1, { w: false }), rightItem(3, 1, { w: false }), done()], extra);
    expect(row(outside)).toEqual(pass());
    expect(outside.items).toMatchObject({ held: 1, outside: 2, unmatched: 0 });
    const errs = await judge('every', [leftItem(1, 5), rightItem(1, 5), rightItem(3, 1, { w: 'x' }), done()], extra);
    expect(row(errs)).toEqual(notChecked(ERRORED));
  });
});

describe('the table of A1 over the pairs', () => {
  it('every: a failing pair fails at any coverage, and is shown with both its items', async () => {
    expect(row(await judge('every', [leftItem(1, 1), rightItem(1, 2), done('failed')]))).toEqual(fail([1, 2]));
  });

  it('every: an error beside a failing pair, fail wins; an error alone is not_checked', async () => {
    // `left.v == right.v` over text and a number is false in CEL, so the error here is a missing field.
    expect(row(await judge('every', [leftItem(1, 1), rightItem(1, 2), leftItem(2, 1), { ...rightItem(2, 1), body: { k: 2 } }, done()]))).toEqual(fail([1, 2]));
    expect(row(await judge('every', [leftItem(1, 1), { ...rightItem(1, 1), body: { k: 1 } }, done()]))).toEqual(notChecked(ERRORED));
  });

  it('every: not covered, or covered erroring, is not_checked', async () => {
    expect(row(await judge('every', [leftItem(1, 1), rightItem(1, 1), done('failed')]))).toEqual(notChecked(COVERAGE));
    expect(row(await judge('every', [leftItem(1, 1), rightItem(1, 1)]))).toEqual(notChecked(COVERAGE));
  });

  it('every and none: no pair at all is vacuous, not_checked "nothing to check" unless the claim says an empty set passes', async () => {
    const empty = await judge('every', [done()]);
    expect(row(empty)).toEqual(notChecked('nothing to check'));
    expect(empty.vacuous).toBe(true);
    const passes = await judge('none', [done()], { vacuous: 'pass' });
    expect(row(passes)).toEqual(pass());
    expect(passes.vacuous).toBe(true);
  });

  it('some: a witness pair passes at any coverage; none holding, covered, fails; an uncertain pair is not_checked', async () => {
    expect(row(await judge('some', [leftItem(1, 1), rightItem(1, 2), leftItem(2, 3), rightItem(2, 3), done('failed')]))).toEqual(pass([3, 4]));
    expect(row(await judge('some', [leftItem(1, 1), rightItem(1, 2), done()]))).toEqual(fail());
    expect(row(await judge('some', [leftItem(1, 1), rightItem(1, 2), done('failed')]))).toEqual(notChecked(COVERAGE));
    expect(row(await judge('some', [leftItem(1, 1), { ...rightItem(1, 1), body: { k: 1 } }, done()]))).toEqual(notChecked(ERRORED));
  });

  it('none: a pair that holds fails; none holding, covered, passes', async () => {
    expect(row(await judge('none', [leftItem(1, 1), rightItem(1, 1), done('failed')]))).toEqual(fail([1, 2]));
    expect(row(await judge('none', [leftItem(1, 1), rightItem(1, 2), done()]))).toEqual(pass());
  });
});

describe('unmatched: an item with no partner', () => {
  const unmatchedLeft = [leftItem(1, 1), rightItem(1, 1), leftItem(2, 1), done()];
  const unmatchedRight = [leftItem(1, 1), rightItem(1, 1), rightItem(3, 1), done()];

  it('uncovered (the default): coverage is not met, on either side', async () => {
    for (const facts of [unmatchedLeft, unmatchedRight]) {
      const v = await judge('every', facts);
      expect(row(v)).toEqual(notChecked(COVERAGE));
      expect(v.coverage.met).toBe(false);
      expect(v.items).toMatchObject({ held: 1, unmatched: 1 });
      expect(row(await judge('every', facts, { unmatched: 'uncovered' }))).toEqual(notChecked(COVERAGE));
    }
  });

  it('uncovered: a failing pair still fails, and a witness still passes', async () => {
    expect(row(await judge('every', [leftItem(1, 1), rightItem(1, 2), leftItem(2, 1), done()]))).toEqual(fail([1, 2]));
    expect(row(await judge('some', [leftItem(1, 1), rightItem(1, 1), leftItem(2, 1), done()]))).toEqual(pass([1, 2]));
  });

  it('fail: each unmatched item is a counterexample, shown, on either side', async () => {
    expect(row(await judge('every', unmatchedLeft, { unmatched: 'fail' }))).toEqual(fail([3]));
    expect(row(await judge('every', unmatchedRight, { unmatched: 'fail' }))).toEqual(fail([3]));
    expect((await judge('every', unmatchedLeft, { unmatched: 'fail' })).items).toMatchObject({ held: 1, failed: 1, unmatched: 1 });
  });

  it('fail: an unmatched item is uncertain, not a counterexample, while an item on the other side is uncertain', async () => {
    // Position 4's key errors: it could be the partner of position 3.
    const v = await judge('every', [leftItem(1, 1), rightItem(1, 1), leftItem(2, 1), { ...rightItem(2, 1), body: { v: 1 } }, done()], { unmatched: 'fail' });
    expect(row(v)).toEqual(notChecked(ERRORED));
    expect(v.items).toMatchObject({ held: 1, failed: 0, uncertain: 2, unmatched: 1 });
  });

  it('ignore: unmatched items are left out', async () => {
    for (const facts of [unmatchedLeft, unmatchedRight]) {
      const v = await judge('every', facts, { unmatched: 'ignore' });
      expect(row(v)).toEqual(pass());
      expect(v.coverage.met).toBe(true);
      expect(v.items).toMatchObject({ held: 1, unmatched: 1 });
    }
    // Only unmatched items: no pair is inside the claim, so it is vacuous.
    const empty = await judge('every', [leftItem(1, 1), rightItem(2, 1), done()], { unmatched: 'ignore' });
    expect(row(empty)).toEqual(notChecked('nothing to check'));
    expect(empty.vacuous).toBe(true);
  });
});

describe('unmatched: every quantifier against every mode, with a left item with no partner and without', () => {
  // A pair that decides nothing for its quantifier: one that holds for `every`, one that does not for `some` and `none`.
  const neutral: Record<PairQuantifier, Given[]> = {
    every: [leftItem(1, 1), rightItem(1, 1)],
    some: [leftItem(1, 1), rightItem(1, 2)],
    none: [leftItem(1, 1), rightItem(1, 2)],
  };
  type Row = [PairQuantifier, Unmatched, 'absent' | 'present' | 'alone', ReturnType<typeof row>];
  // `present` adds the left item at position 3; `alone` is that item with no pair beside it, at position 1.
  const TABLE: Row[] = [
    ['every', 'uncovered', 'absent', pass()],
    ['every', 'fail', 'absent', pass()],
    ['every', 'ignore', 'absent', pass()],
    ['every', 'uncovered', 'present', notChecked(COVERAGE)],
    ['every', 'fail', 'present', fail([3])],
    ['every', 'ignore', 'present', pass()],
    ['every', 'uncovered', 'alone', notChecked(COVERAGE)],
    ['every', 'fail', 'alone', fail([1])],
    ['every', 'ignore', 'alone', notChecked('nothing to check')],
    ['some', 'uncovered', 'absent', fail()],
    ['some', 'fail', 'absent', fail()],
    ['some', 'ignore', 'absent', fail()],
    ['some', 'uncovered', 'present', notChecked(COVERAGE)],
    ['some', 'fail', 'present', fail()],
    ['some', 'ignore', 'present', fail()],
    ['some', 'uncovered', 'alone', notChecked(COVERAGE)],
    ['some', 'fail', 'alone', fail()],
    ['some', 'ignore', 'alone', fail()],
    ['none', 'uncovered', 'absent', pass()],
    ['none', 'fail', 'absent', pass()],
    ['none', 'ignore', 'absent', pass()],
    ['none', 'uncovered', 'present', notChecked(COVERAGE)],
    ['none', 'fail', 'present', fail([3])],
    ['none', 'ignore', 'present', pass()],
    ['none', 'uncovered', 'alone', notChecked(COVERAGE)],
    ['none', 'fail', 'alone', fail([1])],
    ['none', 'ignore', 'alone', notChecked('nothing to check')],
  ];
  const factsFor = (q: PairQuantifier, present: Row[2]): Given[] =>
    present === 'absent' ? [...neutral[q], done()] : present === 'present' ? [...neutral[q], leftItem(2, 1), done()] : [leftItem(2, 1), done()];

  for (const [q, mode, present, expected] of TABLE) {
    it(`${q}, unmatched ${mode}, the left item ${present}: ${expected.verdict}${expected.reason ? ` (${expected.reason})` : ''}`, async () => {
      const v = await judge(q, factsFor(q, present), { unmatched: mode });
      expect(row(v)).toEqual(expected);
      expect(v.items.unmatched).toBe(present === 'absent' ? 0 : 1);
    });
  }

  it('none, fail: an unmatched item is a counterexample, so a pass is never left standing beside one', async () => {
    // A pair that does not hold, which a none claim reads as fine, beside a left item with no partner.
    const v = await judge('none', [leftItem(1, 1), rightItem(1, 2), leftItem(2, 1), done()], { unmatched: 'fail' });
    expect(row(v)).toEqual(fail([3]));
    expect(v.items).toMatchObject({ held: 1, failed: 1, unmatched: 1 });
  });

  it('some, fail, over only unmatched items: a fail with nothing shown, as any some claim that finds no witness; the record counts each as failed and unmatched', async () => {
    const v = await judge('some', [leftItem(1, 1), leftItem(2, 1), done()], { unmatched: 'fail' });
    expect(row(v)).toEqual(fail());
    expect(v.items).toEqual({ held: 0, failed: 2, outside: 0, uncertain: 0, unmatched: 2 });
    // Not covered, the same facts settle nothing.
    expect(row(await judge('some', [leftItem(1, 1), leftItem(2, 1), done('failed')], { unmatched: 'fail' }))).toEqual(notChecked(COVERAGE));
  });

  it('none, fail: an unmatched item is uncertain, not a counterexample, while an item on the right is uncertain', async () => {
    const v = await judge('none', [leftItem(1, 1), rightItem(1, 2), leftItem(2, 1), { ...rightItem(2, 1), body: { v: 1 } }, done()], { unmatched: 'fail' });
    expect(row(v)).toEqual(notChecked(ERRORED));
  });
});

describe('usable over a pair', () => {
  const extra = { usable: 'left.u > 0 && right.u > 0' };

  it('a pair whose usable rule is not true is uncertain: never a pass or a fail, and says a measurement could not be used', async () => {
    expect(row(await judge('every', [leftItem(1, 1), rightItem(1, 1, { u: 0 }), done()], extra))).toEqual(notChecked(UNUSABLE));
    expect(row(await judge('none', [leftItem(1, 1, { u: 0 }), rightItem(1, 1), done()], extra))).toEqual(notChecked(UNUSABLE));
    expect(row(await judge('some', [leftItem(1, 1), rightItem(1, 2, { u: 'x' }), done()], extra))).toEqual(notChecked(UNUSABLE));
  });

  it('a usable pair beside an unusable one is judged: its fail still fails', async () => {
    expect(row(await judge('every', [leftItem(1, 1), rightItem(1, 2), leftItem(2, 1), rightItem(2, 1, { u: 0 }), done()], extra))).toEqual(fail([1, 2]));
  });
});

describe('what a pair verdict records', () => {
  it('the read set is exactly the facts of the view, in ledger order; the view, depth and assurance are recorded', async () => {
    const loaded = await load('every');
    const facts = [
      ...place([leftItem(1, 1), rightItem(1, 1)]),
      ...place([{ ...leftItem(1, 1), subject: 'other' }, { kind: 't.note', by: 'c@1', body: {} }], 3),
      ...place([done()], 5),
    ];
    const v = judgeOver(loaded, facts.reverse());
    expect(v.read).toEqual([1, 2, 5]);
    expect(v.view).toEqual({ subject: 's', kinds: ['t.left', 't.right', 'collection'] });
    expect(v.claim).toBe('test.pair.every@1');
    expect(v.depth).toBe('facts');
    expect(v.assurance).toBe('tested');
    expect(v.failed_on).toBe('fails');
    expect(v.coverage).toMatchObject({ rule: 'ctx.collections["c@1"].status == "complete"', met: true });
  });

  it('depth follows from: a derived side is derived, a source it cannot see is measured', async () => {
    const loaded = await load('every');
    const source = place([{ kind: 't.raw', by: 'c@1', body: {} }]);
    const derived = place([{ ...leftItem(1, 1), from: [1] }, rightItem(1, 1), done()], 2);
    expect(judgeOver(loaded, [...source, ...derived]).depth).toBe('derived');
    expect(judgeOver(loaded, derived).depth).toBe('measured');
  });

  it('unmet needs: a some claim that finds nothing is blocked with what to add; an every claim with a failing pair still fails', async () => {
    const needs = { needs: { kinds: ['t.left', 't.right'], inputs: ['accounts'] } };
    const loadedSome = await loadFile(pairClaimFile('some', EXAMPLES.some, { ...needs, examples: withInputs(claimFile('some').examples) }));
    const blocked = judgeOver(loadedSome, place([leftItem(1, 1), rightItem(1, 2), done()]), { inputs: { accounts: 2 } });
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.reason).toBe('no collector records a kind it needs');
    expect(blocked.add).toEqual(['kind:t.left', 'kind:t.right']);
    const loadedEvery = await loadFile(pairClaimFile('every', EXAMPLES.every, { ...needs, examples: withInputs(claimFile('every').examples) }));
    expect(judgeOver(loadedEvery, place([leftItem(1, 1), rightItem(1, 2), done()])).verdict).toBe('fail');
    expect(judgeOver(loadedEvery, place([leftItem(1, 1), rightItem(1, 1), done()])).add).toEqual(['input:accounts', 'kind:t.left', 'kind:t.right']);
  });
});

const withInputs = (examples: { name: string }[]) => examples.map((e) => ({ ...e, inputs: { accounts: 2 } }));

describe('the loader refuses a pair claim', () => {
  const refused = (file: unknown) => expect(loadFile(file)).rejects;

  it('with count, which a pair claim does not take, or a count rule', async () => {
    await refused(claimFile('every', { quantifier: 'count' })).toThrow(/pair claim .*"every", "some", "none"/);
    await refused(claimFile('every', { count: 'n >= 1' })).toThrow(/unknown key "count"/);
  });

  it('without on as two key expressions, or with a key outside the subset', async () => {
    const { on: _, ...noOn } = claimFile('every');
    await refused(noOn).toThrow(/needs on as two key expressions/);
    await refused(claimFile('every', { on: ['item.k'] })).toThrow(/needs on as two key expressions/);
    await refused(claimFile('every', { on: ['item.k', 'item.k > 1.5'] })).toBeInstanceOf(ClaimRejection);
  });

  it('with a side that is not a selector of a kind in its view', async () => {
    await refused(claimFile('every', { left: 't.left' })).toThrow(/needs left as a selector/);
    await refused(claimFile('every', { right: { from: 't.other' } })).toThrow(/reads items of kind t.other, which its view does not hold/);
    await refused(claimFile('every', { left: { from: 't.left', each: 'item.xs' } })).toThrow(/unknown key "left.each"/);
  });

  it('with unmatched other than uncovered, fail or ignore; with vacuous on a some claim; with no covered rule', async () => {
    await refused(claimFile('every', { unmatched: 'drop' })).toThrow(/unmatched as one of "uncovered", "fail", "ignore"/);
    await refused(claimFile('some', { vacuous: 'pass' })).toThrow(/has vacuous, which only an every or none claim reads/);
    const { covered: _, ...noCovered } = claimFile('every');
    await refused(noCovered).toThrow(/needs covered as text/);
  });

  it('with keys of a set claim it would not read', async () => {
    await refused(claimFile('every', { from: 't.left' })).toThrow(/unknown key "from"/);
    await refused(claimFile('every', { where: 'item.w' })).toThrow(/unknown key "where"/);
  });
});
