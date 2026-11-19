// SPDX-License-Identifier: AGPL-3.0-only
// The judge for `set` claims in full (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A1): each row of its table for each
// quantifier, `where` and `usable`, an empty domain, the reasons a verdict that is not known carries, what to add, and
// the view it reads. Every claim here is loaded by the real loader and judged by the real judge over the real CEL.
import { describe, expect, it } from 'vitest';
import { loadClaim } from '../../src/kernel/claim.js';
import type { Fact, PlacedFact } from '../../src/kernel/fact.js';
import { type JudgeInput, type Quantifier, REASONS, type SetClaim, type Verdict, judgeClaim } from '../../src/kernel/judge.js';
import type { Json } from '../../src/kernel/ledger.js';
import { type Given, done, item, judge as judgeOver, loadFile, place, setClaimFile, sha256 } from '../kernel-helpers.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const outsideItem = (v: Json = 9) => item(v, { w: false });
const errorItem = () => item('x'); // `item.v > 5` over text is an error

/** `holds` is `item.v > 5`: 9 holds, 1 fails. The examples every claim file must carry (ADR 0014), per quantifier. */
const EXAMPLES: Record<Quantifier, { fail: Given[]; pass: Given[] }> = {
  every: { fail: [item(1)], pass: [item(9)] },
  some: { fail: [item(1)], pass: [item(9)] },
  none: { fail: [item(9)], pass: [item(1)] },
  count: { fail: [item(1)], pass: [item(1), item(1)] }, // count `n >= 2`
};

const claimFile = (quantifier: Quantifier, extra: Record<string, unknown> = {}) => setClaimFile(quantifier, EXAMPLES[quantifier], extra);
const load = (quantifier: Quantifier, extra: Record<string, unknown> = {}) => loadFile(claimFile(quantifier, extra));

/** Loads a claim of this quantifier with `extra`, and judges it over these facts. */
const judge = async (quantifier: Quantifier, facts: Given[], extra: Record<string, unknown> = {}, more: Partial<JudgeInput> = {}): Promise<Verdict> =>
  judgeOver(await load(quantifier, extra), place(facts), more);

/** The verdict, its reason and what it showed, which is what a table row decides. */
const row = (v: Verdict) => ({ verdict: v.verdict, reason: v.reason, shown: v.shown });
const pass = (shown: number[] = []) => ({ verdict: 'pass', reason: undefined, shown });
const fail = (shown: number[] = []) => ({ verdict: 'fail', reason: undefined, shown });
const notChecked = (reason: string) => ({ verdict: 'not_checked', reason, shown: [] });
const ERRORED = 'uncertain items: an expression gave an error';
const UNUSABLE = "uncertain items: a measurement couldn't be used";
const COVERAGE = 'coverage not met';
const NOTHING = 'nothing to check';

/** No `collection` fact at all: `ctx.collections["c@1"]` is a missing key, so `covered` gives an error. */
const coveredErrors: Given[] = [];

/** A count rule that gives an error at n = 0: one item passes (10 >= 5), three fail (3 < 5). */
const divides = {
  count: '10 / n >= 5',
  examples: [
    { name: 'three fail', expect: 'fail', facts: [item(1), item(1), item(1), done()] },
    { name: 'one passes', expect: 'pass', facts: [item(1), done()] },
    { name: 'not collected', expect: 'not_checked', facts: [done('failed')] },
  ],
};

describe('every', () => {
  it('passes when every item holds and coverage is met', async () => {
    const v = await judge('every', [item(9), item(7), done()]);
    expect(row(v)).toEqual(pass());
    expect(v.items).toEqual({ held: 2, failed: 0, outside: 0, uncertain: 0 });
  });

  it('fails on one item that fails, showing it, at any coverage', async () => {
    expect(row(await judge('every', [item(9), item(1), done()]))).toEqual(fail([2]));
    expect(row(await judge('every', [item(9), item(1), done('failed')]))).toEqual(fail([2]));
    expect(row(await judge('every', [item(1), ...coveredErrors]))).toEqual(fail([1]));
  });

  it('a failing item wins over an item whose holds gives an error', async () => {
    expect(row(await judge('every', [errorItem(), item(1), done()]))).toEqual(fail([2]));
  });

  it('is not known when an item gives an error and none fails', async () => {
    const v = await judge('every', [item(9), errorItem(), done()]);
    expect(row(v)).toEqual(notChecked(ERRORED));
    expect(v.items).toEqual({ held: 1, failed: 0, outside: 0, uncertain: 1 });
  });

  it('is not known when coverage is false, or covered gives an error', async () => {
    expect(row(await judge('every', [item(9), done('failed')]))).toEqual(notChecked(COVERAGE));
    const v = await judge('every', [item(9), ...coveredErrors]);
    expect(row(v)).toEqual(notChecked(COVERAGE));
    expect(v.coverage.met).toBe(false);
  });

  it('over no items is not known, nothing to check, marked vacuous', async () => {
    const v = await judge('every', [done()]);
    expect(row(v)).toEqual(notChecked(NOTHING));
    expect(v.vacuous).toBe(true);
  });

  it('with a where that selects nothing is not known, nothing to check, and the items left outside are counted', async () => {
    const v = await judge('every', [outsideItem(1), outsideItem(9), done()], { where: 'item.w' });
    expect(row(v)).toEqual(notChecked(NOTHING));
    expect(v.vacuous).toBe(true);
    expect(v.items).toEqual({ held: 0, failed: 0, outside: 2, uncertain: 0 });
  });

  it('leaves an item outside when where is false, so a failing item outside does not fail it', async () => {
    const v = await judge('every', [outsideItem(1), item(9), done()], { where: 'item.w' });
    expect(row(v)).toEqual(pass());
    expect(v.items).toEqual({ held: 1, failed: 0, outside: 1, uncertain: 0 });
  });

  it('reads a where that gives an error as uncertain, and a failing item still wins', async () => {
    const whereErrors = item(9, { w: 'x' });
    const v = await judge('every', [whereErrors, item(9), done()], { where: 'item.w' });
    expect(row(v)).toEqual(notChecked(ERRORED));
    expect(v.items).toEqual({ held: 1, failed: 0, outside: 0, uncertain: 1 });
    expect(row(await judge('every', [whereErrors, item(1), done()], { where: 'item.w' }))).toEqual(fail([2]));
  });
});

describe('some', () => {
  it('passes on one item that holds, showing it, at any coverage', async () => {
    expect(row(await judge('some', [item(1), item(9), done()]))).toEqual(pass([2]));
    expect(row(await judge('some', [item(1), item(9), done('failed')]))).toEqual(pass([2]));
    expect(row(await judge('some', [item(9), ...coveredErrors]))).toEqual(pass([1]));
  });

  it('a witness wins over an item whose holds gives an error', async () => {
    expect(row(await judge('some', [errorItem(), item(9), done()]))).toEqual(pass([2]));
  });

  it('fails when no item holds and coverage is met', async () => {
    const v = await judge('some', [item(1), item(2), done()]);
    expect(row(v)).toEqual(fail());
    expect(v.items).toEqual({ held: 0, failed: 2, outside: 0, uncertain: 0 });
  });

  it('is not known when no item holds and one gives an error, though another fails', async () => {
    expect(row(await judge('some', [item(1), errorItem(), done()]))).toEqual(notChecked(ERRORED));
  });

  it('is not known when no item holds and coverage is false, or covered gives an error', async () => {
    expect(row(await judge('some', [item(1), done('failed')]))).toEqual(notChecked(COVERAGE));
    expect(row(await judge('some', [item(1), ...coveredErrors]))).toEqual(notChecked(COVERAGE));
  });

  it('over no items, or a where that selects nothing, fails when covered and is never vacuous', async () => {
    const empty = await judge('some', [done()]);
    expect(row(empty)).toEqual(fail());
    expect(empty.vacuous).toBeUndefined();
    const v = await judge('some', [outsideItem(9), done()], { where: 'item.w' });
    expect(row(v)).toEqual(fail());
    expect(v.items.outside).toBe(1);
    expect(row(await judge('some', [done('failed')]))).toEqual(notChecked(COVERAGE));
  });
});

describe('none', () => {
  it('passes when no item holds and coverage is met', async () => {
    const v = await judge('none', [item(1), item(2), done()]);
    expect(row(v)).toEqual(pass());
    expect(v.vacuous).toBeUndefined();
  });

  it('fails on one item that holds, showing it, at any coverage', async () => {
    expect(row(await judge('none', [item(1), item(9), done()]))).toEqual(fail([2]));
    expect(row(await judge('none', [item(9), done('failed')]))).toEqual(fail([1]));
    expect(row(await judge('none', [item(9), ...coveredErrors]))).toEqual(fail([1]));
  });

  it('an item that holds wins over an item whose holds gives an error', async () => {
    expect(row(await judge('none', [errorItem(), item(9), done()]))).toEqual(fail([2]));
  });

  it('is not known when an item gives an error and none holds', async () => {
    expect(row(await judge('none', [item(1), errorItem(), done()]))).toEqual(notChecked(ERRORED));
  });

  it('is not known when coverage is false, or covered gives an error', async () => {
    expect(row(await judge('none', [item(1), done('failed')]))).toEqual(notChecked(COVERAGE));
    expect(row(await judge('none', [item(1), ...coveredErrors]))).toEqual(notChecked(COVERAGE));
  });

  it('over no items, or a where that selects nothing, is not known, nothing to check, marked vacuous', async () => {
    const empty = await judge('none', [done()]);
    expect(row(empty)).toEqual(notChecked(NOTHING));
    expect(empty.vacuous).toBe(true);
    const v = await judge('none', [outsideItem(9), done()], { where: 'item.w' });
    expect(row(v)).toEqual(notChecked(NOTHING));
    expect(v.vacuous).toBe(true);
    expect(v.items.outside).toBe(1);
  });
});

describe('count', () => {
  it('passes when covered and the count rule is true of the number of items inside', async () => {
    const v = await judge('count', [item(1), item(9), done()]);
    expect(row(v)).toEqual(pass());
    expect(v.items).toEqual({ held: 2, failed: 0, outside: 0, uncertain: 0 });
  });

  it('fails when covered and the count rule is false, over no items too, and is never vacuous', async () => {
    expect(row(await judge('count', [item(1), done()]))).toEqual(fail());
    const empty = await judge('count', [done()]);
    expect(row(empty)).toEqual(fail());
    expect(empty.vacuous).toBeUndefined();
  });

  it('counts only the items where selects', async () => {
    const v = await judge('count', [item(1), outsideItem(), done()], { where: 'item.w' });
    expect(row(v)).toEqual(fail());
    expect(v.items).toEqual({ held: 1, failed: 0, outside: 1, uncertain: 0 });
  });

  it('is not known when coverage is false or covered gives an error, even when the count is settled', async () => {
    expect(row(await judge('count', [item(1), item(1), done('failed')]))).toEqual(notChecked(COVERAGE));
    expect(row(await judge('count', [item(1), item(1), ...coveredErrors]))).toEqual(notChecked(COVERAGE));
    expect(row(await judge('count', [done('failed')]))).toEqual(notChecked(COVERAGE));
  });

  it('is not known when the uncertain items could change the answer', async () => {
    const whereErrors = item(1, { w: 'x' });
    const v = await judge('count', [item(1), whereErrors, done()], { where: 'item.w' });
    expect(row(v)).toEqual(notChecked(ERRORED));
    expect(v.items).toEqual({ held: 1, failed: 0, outside: 0, uncertain: 1 });
  });

  it('is settled when every count the uncertain items allow gives the same answer', async () => {
    const whereErrors = item(1, { w: 'x' });
    expect(row(await judge('count', [item(1), item(1), whereErrors, done()], { where: 'item.w' }))).toEqual(pass());
    expect(row(await judge('count', [whereErrors, done()], { where: 'item.w' }))).toEqual(fail());
  });

  it('does not read holds: an item is counted whatever its fields', async () => {
    expect(row(await judge('count', [errorItem(), errorItem(), done()]))).toEqual(pass());
  });

  it('is not known, for an expression that gave an error, when the count rule gives an error (ALGORITHMS A1)', async () => {
    expect(row(await judge('count', [done()], divides))).toEqual(notChecked(ERRORED));
    // An error among the counts the uncertain items allow is still an error, whatever the other counts give.
    expect(row(await judge('count', [item(1, { w: 'x' }), done()], { ...divides, where: 'item.w' }))).toEqual(notChecked(ERRORED));
    // Beside an item that could not be used, the reason says both.
    expect(row(await judge('count', [item(1, { u: 0 }), done()], { ...divides, usable: 'item.u > 0' }))).toEqual(
      notChecked("uncertain items: an expression gave an error, and a measurement couldn't be used"),
    );
  });
});

describe('when an item is uncertain and coverage is not met too', () => {
  it('every, some and none name the uncertain items, and count names the coverage (ALGORITHMS A1, in order)', async () => {
    for (const quantifier of ['every', 'some', 'none'] as const) {
      expect(row(await judge(quantifier, [errorItem(), done('failed')]))).toEqual(notChecked(ERRORED));
    }
    expect(row(await judge('count', [item(1), item(1, { w: 'x' }), done('failed')], { where: 'item.w' }))).toEqual(notChecked(COVERAGE));
  });
});

describe('usable', () => {
  const usable = { usable: 'item.u > 0' };
  const unusable = (v: Json) => item(v, { u: 0 });

  it('an item that is not usable is uncertain, and the reason says a measurement could not be used', async () => {
    const v = await judge('every', [item(9), unusable(9), done()], usable);
    expect(row(v)).toEqual(notChecked(UNUSABLE));
    expect(v.items).toEqual({ held: 1, failed: 0, outside: 0, uncertain: 1 });
  });

  it('an item whose usable rule gives an error is not usable either', async () => {
    expect(row(await judge('every', [item(9), item(9, { u: 'x' }), done()], usable))).toEqual(notChecked(UNUSABLE));
  });

  it('an item that is not usable never makes a fail', async () => {
    expect(row(await judge('every', [unusable(1), item(9), done()], usable))).toEqual(notChecked(UNUSABLE));
    expect(row(await judge('none', [unusable(9), item(1), done()], usable))).toEqual(notChecked(UNUSABLE));
    expect(row(await judge('some', [unusable(1), done()], usable))).toEqual(notChecked(UNUSABLE));
  });

  it('an item that is not usable never makes a pass', async () => {
    expect(row(await judge('some', [unusable(9), item(1), done()], usable))).toEqual(notChecked(UNUSABLE));
    expect(row(await judge('count', [unusable(1), item(1), done()], usable))).toEqual(notChecked(UNUSABLE));
  });

  it('a usable item settles the claim beside one that is not', async () => {
    expect(row(await judge('every', [unusable(9), item(1), done()], usable))).toEqual(fail([2]));
    expect(row(await judge('some', [unusable(1), item(9), done()], usable))).toEqual(pass([2]));
  });

  it('says both when one item gave an error and another could not be used', async () => {
    expect(row(await judge('every', [errorItem(), unusable(9), done()], usable))).toEqual(
      notChecked("uncertain items: an expression gave an error, and a measurement couldn't be used"),
    );
  });

  it('is not asked of an item outside the claim', async () => {
    const v = await judge('every', [item(9, { w: false, u: 0 }), item(9), done()], { ...usable, where: 'item.w' });
    expect(row(v)).toEqual(pass());
    expect(v.items).toEqual({ held: 1, failed: 0, outside: 1, uncertain: 0 });
  });
});

describe('an empty domain', () => {
  it('passes, marked vacuous, when an every or none claim says an empty set is a pass', async () => {
    for (const quantifier of ['every', 'none'] as const) {
      const v = await judge(quantifier, [done()], { vacuous: 'pass' });
      expect(row(v)).toEqual(pass());
      expect(v.vacuous).toBe(true);
    }
  });

  it('a where that selected nothing is still reported when the empty set is a pass', async () => {
    const v = await judge('every', [outsideItem(1), done()], { vacuous: 'pass', where: 'item.w' });
    expect(row(v)).toEqual(pass());
    expect(v.vacuous).toBe(true);
    expect(v.items.outside).toBe(1);
  });

  it('is not known, nothing to check, when the claim says so in words', async () => {
    const v = await judge('none', [done()], { vacuous: 'not_checked' });
    expect(row(v)).toEqual(notChecked(NOTHING));
    expect(v.vacuous).toBe(true);
  });

  it('never passes when coverage is not met, and is still marked vacuous', async () => {
    const v = await judge('every', [done('failed')], { vacuous: 'pass' });
    expect(row(v)).toEqual(notChecked(COVERAGE));
    expect(v.vacuous).toBe(true);
  });

  it('is not an empty domain when an item inside is uncertain', async () => {
    const v = await judge('every', [errorItem(), done()], { vacuous: 'pass' });
    expect(row(v)).toEqual(notChecked(ERRORED));
    expect(v.vacuous).toBeUndefined();
  });
});

describe('reasons and what to add', () => {
  const needs = (n: Record<string, unknown>) => ({ needs: n });

  it('every verdict that is not known carries a reason from the list of its word, and pass and fail carry none', async () => {
    const verdicts = [
      await judge('every', [errorItem(), done()]),
      await judge('every', [item(9), item(9, { u: 0 }), done()], { usable: 'item.u > 0' }),
      await judge('every', [done('failed')]),
      await judge('none', [done()]),
      await judge('count', [done()], divides),
      await judge('every', [item(9), done()], needs({ kinds: ['t.item'], inputs: ['accounts'] }), { supplies: { kinds: ['t.item'] } }),
      await judge('every', [item(9), done()], needs({ kinds: ['t.item'], effect: 'probe' }), { supplies: { kinds: ['t.item'] } }),
      await judge('every', [item(9), done()], needs({ kinds: ['t.item'] })),
    ];
    expect(verdicts.map((v) => v.verdict)).toEqual(['not_checked', 'not_checked', 'not_checked', 'not_checked', 'not_checked', 'blocked', 'blocked', 'blocked']);
    for (const v of verdicts) {
      const word = v.verdict as keyof typeof REASONS;
      expect(REASONS[word] as readonly string[]).toContain(v.reason);
    }
    for (const v of [await judge('every', [item(9), done()]), await judge('every', [item(1), done()])]) expect(v.reason).toBeUndefined();
  });

  it('the list gives each reason to one word only', () => {
    const all = Object.values(REASONS).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(Object.keys(REASONS).sort()).toEqual(['blocked', 'not_checked', 'unverified']);
  });

  it("is FOUNDATION's list: blocked names a missing flag, and an error in the count rule has no reason of its own", () => {
    expect(REASONS.blocked as readonly string[]).toContain('a flag is missing');
    expect(Object.values(REASONS).flat() as string[]).not.toContain('the count rule gave an error');
  });

  it('is blocked when an input it needs was not given, and what to add names it', async () => {
    const v = await judge('every', [item(9), done()], needs({ kinds: ['t.item'], inputs: ['accounts', 'date'] }), { inputs: { date: '2026-11-18' }, supplies: { kinds: ['t.item'] } });
    expect(v.verdict).toBe('blocked');
    expect(v.reason).toBe('an input is missing');
    expect(v.add).toEqual(['input:accounts']);
    expect(v.shown).toEqual([]);
  });

  it('is blocked when the run does not allow the effect it needs, the least effect being observe', async () => {
    const probe = needs({ kinds: ['t.item'], effect: 'probe' });
    const v = await judge('every', [item(9), done()], probe, { supplies: { kinds: ['t.item'], effect: 'interact' } });
    expect(v.verdict).toBe('blocked');
    expect(v.reason).toBe('an effect it needs is not allowed');
    expect(v.add).toEqual(['effect:probe']);
    expect((await judge('every', [item(9), done()], probe, { supplies: { kinds: ['t.item'] } })).add).toEqual(['effect:probe']);
    expect((await judge('every', [item(9), done()], probe, { supplies: { kinds: ['t.item'], effect: 'probe' } })).verdict).toBe('pass');
    expect((await judge('every', [item(9), done()], probe, { supplies: { kinds: ['t.item'], effect: 'write' } })).verdict).toBe('pass');
    const observe = needs({ kinds: ['t.item'], effect: 'observe' });
    expect((await judge('every', [item(9), done()], observe, { supplies: { kinds: ['t.item'] } })).verdict).toBe('pass');
  });

  it('is blocked when no collector in the run records a kind it needs', async () => {
    const v = await judge('every', [item(9), done()], needs({ kinds: ['t.item', 't.other'] }), { supplies: { kinds: ['t.item'] } });
    expect(v.verdict).toBe('blocked');
    expect(v.reason).toBe('no collector records a kind it needs');
    expect(v.add).toEqual(['kind:t.other']);
  });

  it('lists everything unmet in what to add, and gives the reason of the first', async () => {
    const all = needs({ kinds: ['t.item', 't.other'], inputs: ['accounts'], effect: 'write' });
    const v = await judge('every', [item(9), done()], all);
    expect(v.reason).toBe('an input is missing');
    expect(v.add).toEqual(['input:accounts', 'effect:write', 'kind:t.item', 'kind:t.other']);
    const noInput = needs({ kinds: ['t.other'], effect: 'write' });
    expect((await judge('every', [item(9), done()], noInput)).reason).toBe('an effect it needs is not allowed');
  });

  it('is judged as usual when its needs are met, and carries nothing to add', async () => {
    const v = await judge('every', [item(9), done()], needs({ kinds: ['t.item'], inputs: ['accounts'] }), { inputs: { accounts: ['a', 'b'] }, supplies: { kinds: ['t.item'] } });
    expect(row(v)).toEqual(pass());
    expect(v.add).toBeUndefined();
    expect((await judge('every', [item(9), errorItem(), done()], needs({ kinds: ['t.item'] }), { supplies: { kinds: ['t.item'] } })).add).toBeUndefined();
  });

  it('a counterexample still fails a claim whose needs are not met; anything short of a fail is blocked', async () => {
    const unmet = needs({ kinds: ['t.item'], inputs: ['accounts'] });
    const failed = await judge('every', [item(1), done()], unmet);
    expect(row(failed)).toEqual(fail([1]));
    expect(failed.add).toBeUndefined();
    expect((await judge('some', [item(9), done()], unmet)).verdict).toBe('blocked');
    expect((await judge('every', [errorItem(), done()], unmet)).verdict).toBe('blocked');
    expect((await judge('every', [item(9), done('failed')], unmet)).verdict).toBe('blocked');
  });

  it('a none claim with a counterexample fails whatever needs are not met', async () => {
    for (const [unmet, supplies] of [
      [needs({ kinds: ['t.item'] }), {}],
      [needs({ kinds: ['t.item'], effect: 'probe' }), { supplies: { kinds: ['t.item'] } }],
    ] as const) {
      const v = await judge('none', [item(1), item(9), done()], unmet, supplies);
      expect(row(v)).toEqual(fail([2]));
      expect(v.add).toBeUndefined();
    }
  });

  it('a some or count claim that finds nothing is blocked, not failed, when its needs are not met, though covered', async () => {
    // Not finding one settles nothing until covered, and covered can't tell whether a kind it needs was ever recorded.
    const cases: [Quantifier, Given[]][] = [
      ['some', [done()]],
      ['some', [item(1), item(2), done()]],
      ['count', [done()]],
      ['count', [item(1), done()]],
    ];
    for (const [quantifier, facts] of cases) {
      const kind = await judge(quantifier, facts, needs({ kinds: ['t.item'] }));
      expect(row(kind)).toEqual({ verdict: 'blocked', reason: 'no collector records a kind it needs', shown: [] });
      expect(kind.add).toEqual(['kind:t.item']);
      const effect = await judge(quantifier, facts, needs({ kinds: ['t.item'], effect: 'probe' }), { supplies: { kinds: ['t.item'] } });
      expect(row(effect)).toEqual({ verdict: 'blocked', reason: 'an effect it needs is not allowed', shown: [] });
      expect(effect.add).toEqual(['effect:probe']);
      // With the needs met, the same facts fail.
      expect(row(await judge(quantifier, facts, needs({ kinds: ['t.item'] }), { supplies: { kinds: ['t.item'] } }))).toEqual(fail());
    }
  });

  it("judges a claim's own examples with its needs for effect and kinds met", async () => {
    const loaded = await load('every', needs({ kinds: ['t.item'], effect: 'probe' }));
    expect((loaded.claim as SetClaim).needs).toEqual({ kinds: ['t.item'], effect: 'probe' });
    // The inputs it needs are the examples' to give: without them its passing example is blocked, and it isn't loaded.
    const file = claimFile('every', needs({ kinds: ['t.item'], inputs: ['accounts'] }));
    const withoutInputs = { ...file, examples: file.examples.map(({ name, expect, facts }) => ({ name, expect, facts })) };
    await expect(loadClaim(encode(withoutInputs), sha256)).rejects.toThrow(/"passes" gives blocked, not pass/);
  });
});

describe('the view, the read set, the depth and the kind of assurance', () => {
  it('reads exactly the facts of its view, in ledger order, items left outside and coverage facts included', async () => {
    const facts: PlacedFact[] = [
      { seq: 8, fact: { v: 1, run: 1, subject: 's', ...done() } as Fact },
      { seq: 2, fact: { v: 1, run: 1, subject: 's', ...item(9) } as Fact },
      { seq: 3, fact: { v: 1, run: 1, subject: 'other', ...item(1) } as Fact }, // another subject
      { seq: 4, fact: { v: 1, run: 1, subject: 's', ...item(1), kind: 't.unread' } as Fact }, // a kind not in view
      { seq: 5, fact: { v: 1, run: 1, subject: 's', ...item(1), by: 'd@1' } as Fact }, // a collector not in view
      { seq: 6, fact: { v: 1, run: 1, subject: 's', ...outsideItem(1) } as Fact },
    ];
    const loaded = await load('every', { where: 'item.w', view: { kinds: ['t.item', 'collection'], by: ['c@1'] } });
    const v = judgeClaim(loaded, { subject: 's', facts });
    expect(v.read).toEqual([2, 6, 8]);
    expect(v.view).toEqual({ subject: 's', kinds: ['t.item', 'collection'], by: ['c@1'] });
    expect(row(v)).toEqual(pass());
    expect(v.items).toEqual({ held: 1, failed: 0, outside: 1, uncertain: 0 });
  });

  it('reads the facts of its view whatever kind they are, though it takes items only from its from', async () => {
    const loaded = await load('every', { view: { kinds: ['t.item', 't.note', 'collection'] } });
    const v = judgeClaim(loaded, { subject: 's', facts: place([item(9), { kind: 't.note', by: 'c@1', body: { v: 1 } }, done()]) });
    expect(v.read).toEqual([1, 2, 3]);
    expect(v.items.held).toBe(1);
    expect(row(v)).toEqual(pass());
  });

  it('records the kind of assurance its collectors give: tested', async () => {
    expect((await judge('some', [item(9), done()])).assurance).toBe('tested');
  });

  it('follows from back through every fact a fact it read was derived from, in or out of its view', async () => {
    const loaded = await load('every');
    const depth = (...facts: PlacedFact[]) => judgeClaim(loaded, { subject: 's', facts }).depth;
    const at = (seq: number, g: Given): PlacedFact => ({ seq, fact: { v: 1, run: 1, subject: 's', ...g } as Fact });
    const source = (more: Partial<Given> = {}): Given => ({ kind: 't.source', by: 'r@1', body: {}, ...more });
    // The item was derived from 1, which was derived from 2, which withholds a field: the verdict rests on it.
    expect(depth(at(2, source({ withheld: ['score'] })), at(1, source({ from: [2] })), at(5, { ...item(9), from: [1] }), at(6, done()))).toBe('measured');
    expect(depth(at(2, source()), at(1, source({ from: [2] })), at(5, { ...item(9), from: [1] }), at(6, done()))).toBe('derived');
    // A source the judge can't see is an input that isn't in the bundle (ALGORITHMS A8), here or further back.
    expect(depth(at(5, { ...item(9), from: [99] }), at(6, done()))).toBe('measured');
    expect(depth(at(1, source({ from: [99] })), at(5, { ...item(9), from: [1] }), at(6, done()))).toBe('measured');
    // A loop of from ends.
    expect(depth(at(1, source({ from: [2] })), at(2, source({ from: [1], withheld: ['x'] })), at(5, { ...item(9), from: [1] }), at(6, done()))).toBe('measured');
  });
});
