// SPDX-License-Identifier: AGPL-3.0-only
// What the judge guarantees for `set` claims (docs/ALGORITHMS.md A6), tested over generated claims and facts. The
// generator is a small seeded one written here, so a failure names its seed and can be run again exactly.
import { describe, expect, it } from 'vitest';
import type { LoadedClaim, Quantifier, Verdict } from '../../src/kernel/judge.js';
import type { Json } from '../../src/kernel/ledger.js';
import { type Given, done, item, judge, loadFile, place, setClaimFile } from '../kernel-helpers.js';

const RUNS = 300;

/** mulberry32: a 32-bit generator, enough to spread cases; not for anything secret. */
function generator(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(list: readonly T[]): T => list[int(0, list.length - 1)] as T;
  const shuffle = <T>(list: readonly T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  };
  return { int, pick, shuffle, chance: (p: number) => next() < p };
}
type Gen = ReturnType<typeof generator>;

const collection = (status: string, run: number): Given => ({ ...done(status), run });

/** The count rules, each with how many items make it pass and fail, so its file can carry its examples. */
const COUNTS = [
  { rule: 'n >= 2', pass: 2, fail: 1 },
  { rule: 'n <= 1', pass: 1, fail: 2 },
  { rule: 'n == 1', pass: 1, fail: 0 },
];

/** A claim, from the generator: any quantifier, with or without `where`, `usable` and `vacuous`. */
function claimFile(g: Gen) {
  const quantifier = g.pick<Quantifier>(['every', 'some', 'none', 'count']);
  const count = g.pick(COUNTS);
  const passing = { every: [item(9)], some: [item(9)], none: [item(1)], count: Array.from({ length: count.pass }, () => item(1)) }[quantifier];
  const failing = { every: [item(1)], some: [item(1)], none: [item(9)], count: Array.from({ length: count.fail }, () => item(1)) }[quantifier];
  return setClaimFile(
    quantifier,
    { fail: failing, pass: passing },
    {
      id: 'generated',
      view: { kinds: ['t.item', 'collection'], by: ['c@1'] },
      ...(g.chance(0.5) ? { where: 'item.w' } : {}),
      ...(g.chance(0.5) ? { usable: 'item.u > 0' } : {}),
      ...(quantifier === 'count' ? { count: count.rule } : {}),
      ...((quantifier === 'every' || quantifier === 'none') && g.chance(0.5) ? { vacuous: g.pick(['pass', 'not_checked']) } : {}),
    },
  );
}

/** One item, any of: holds or fails, inside or outside, usable or not, or an error in any rule. */
function randomItem(g: Gen): Given {
  return item(g.pick<Json>([1, 3, 6, 9, 'x']), { w: g.pick<Json>([true, true, true, false, 'x']), u: g.pick<Json>([1, 1, 1, 0, 'x']) });
}

/** A view's worth of facts: items, collections over several runs, and facts the view doesn't hold. */
function randomFacts(g: Gen): Given[] {
  const facts: Given[] = [];
  const runs = g.int(0, 2);
  for (let run = 1; run <= runs; run++) facts.push(collection(g.pick(['complete', 'complete', 'failed']), run));
  for (let i = g.int(0, 6); i > 0; i--) facts.push(randomItem(g));
  for (let i = g.int(0, 2); i > 0; i--) facts.push(g.pick([{ ...randomItem(g), subject: 'other' }, { ...randomItem(g), by: 'd@1' }, { kind: 't.other', by: 'c@1', body: { v: 9 } }]));
  return g.shuffle(facts);
}

/** What a verdict decides, without the ledger positions it names. */
const decided = (v: Verdict) => ({ verdict: v.verdict, reason: v.reason, items: v.items, met: v.coverage.met, vacuous: v.vacuous });

/** Each seed's claim, loaded once and shared by the properties. */
const loadedBySeed = new Map<number, Promise<LoadedClaim>>();

/** Runs `check` over RUNS generated claims and views, naming the seed of a case that breaks it. */
async function forAll(check: (g: Gen, loaded: LoadedClaim, facts: Given[]) => void): Promise<void> {
  for (let seed = 1; seed <= RUNS; seed++) {
    const g = generator(seed);
    const file = claimFile(g);
    if (!loadedBySeed.has(seed)) loadedBySeed.set(seed, loadFile(file));
    const loaded = await (loadedBySeed.get(seed) as Promise<LoadedClaim>);
    const facts = randomFacts(g);
    try {
      check(g, loaded, facts);
    } catch (error) {
      throw new Error(`seed ${seed}, a ${file.quantifier} claim: ${(error as Error).message}`);
    }
  }
}

/** Every way the generator can make one item an error or unusable. */
const spoil = (given: Given, how: number): Given => {
  const body = given.body as { v: Json; w: Json; u: Json };
  return { ...given, body: [{ ...body, v: 'x' }, { ...body, w: 'x' }, { ...body, u: 0 }, { ...body, u: 'x' }][how] as Json };
};

describe('what the judge guarantees for set claims (ALGORITHMS A6)', () => {
  it('1. function: the same claim and view give the same verdict', async () => {
    await forAll((_g, loaded, facts) => {
      expect(judge(loaded, place(facts))).toEqual(judge(loaded, place(facts)));
    });
  });

  it('2. order: reordering the facts of a view, or the positions they hold, never changes the verdict', async () => {
    await forAll((g, loaded, facts) => {
      const before = judge(loaded, place(facts));
      const shuffled = place(facts);
      expect(judge(loaded, g.shuffle(shuffled))).toEqual(before);
      // The same facts at other positions: what is read and shown moves with them, and nothing else changes. Each
      // collector run records one collection fact, so the order of two in one run never arises.
      expect(decided(judge(loaded, place(g.shuffle(facts))))).toEqual(decided(before));
    });
  });

  it('3. persistence: a fail of every or none, and a pass of some, stay when facts are added', async () => {
    await forAll((g, loaded, facts) => {
      const before = judge(loaded, place(facts));
      const q = loaded.claim.quantifier;
      const settled = ((q === 'every' || q === 'none') && before.verdict === 'fail') || (q === 'some' && before.verdict === 'pass');
      if (!settled) return;
      const more = randomFacts(g);
      const after = judge(loaded, [...place(facts), ...place(more, facts.length + 1)]);
      expect(after.verdict).toBe(before.verdict);
      // Adding a counterexample never changes a fail either.
      if (before.verdict === 'fail') {
        const counterexample = item(q === 'every' ? 1 : 9);
        expect(judge(loaded, [...place(facts), ...place([counterexample], facts.length + 1)]).verdict).toBe('fail');
      }
    });
  });

  it('4. no uncovered absence: a pass of every, none or count, and a fail of some, imply covered was true', async () => {
    let seen = 0;
    await forAll((_g, loaded, facts) => {
      const v = judge(loaded, place(facts));
      const q = loaded.claim.quantifier;
      if ((q !== 'some' && v.verdict === 'pass') || (q === 'some' && v.verdict === 'fail')) {
        seen++;
        expect(v.coverage.met).toBe(true);
      }
    });
    expect(seen).toBeGreaterThan(10);
  });

  it('lowering coverage never turns a verdict that is not known into a pass, nor makes a pass or fail that was not there', async () => {
    await forAll((g, loaded, facts) => {
      const covered = [...facts.filter((f) => f.kind !== 'collection'), collection('complete', 1)];
      const lowered = [...facts.filter((f) => f.kind !== 'collection'), g.pick([collection('failed', 1)])];
      const high = judge(loaded, place(covered));
      const low = judge(loaded, place(lowered));
      expect(low.coverage.met).toBe(false);
      if (low.verdict === 'pass' || low.verdict === 'fail') expect(high.verdict).toBe(low.verdict);
    });
  });

  it('5. errors never help: turning an item into an error, or marking it unusable, never makes a pass or a fail that was not there', async () => {
    let changed = 0;
    await forAll((g, loaded, facts) => {
      const items = facts.map((f, i) => [f, i] as const).filter(([f]) => f.kind === 't.item' && f.subject === undefined && f.by === 'c@1');
      if (items.length === 0) return;
      const [target, at] = g.pick(items);
      const spoiled = facts.map((f, i) => (i === at ? spoil(target, g.int(0, 3)) : f));
      const before = judge(loaded, place(facts));
      const after = judge(loaded, place(spoiled));
      if (after.verdict !== before.verdict) changed++;
      if (after.verdict === 'pass' || after.verdict === 'fail') expect(before.verdict).toBe(after.verdict);
    });
    expect(changed).toBeGreaterThan(10);
  });

  it('7. seen to fail: a claim that gives a pass names the example on which it gives a fail', async () => {
    await forAll((_g, loaded, facts) => {
      const v = judge(loaded, place(facts));
      if (v.verdict === 'pass') expect(v.failed_on).toBe('fails');
    });
  });
});
