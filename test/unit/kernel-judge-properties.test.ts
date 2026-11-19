// SPDX-License-Identifier: AGPL-3.0-only
// What the judge guarantees for `set` claims (docs/ALGORITHMS.md A6), tested over generated claims and facts. The
// generator is a small seeded one written here, so a failure names its seed and can be run again exactly.
import { describe, expect, it } from 'vitest';
import type { PlacedFact } from '../../src/kernel/fact.js';
import {
  EFFECT_CLASSES,
  type EffectClass,
  type JudgeInput,
  type LoadedClaim,
  type Needs,
  type PairClaim,
  type Quantifier,
  type SetClaim,
  VERDICTS,
  type Verdict,
  type VerdictValue,
} from '../../src/kernel/judge.js';
import { combine, fold } from '../../src/kernel/fold.js';
import type { Json } from '../../src/kernel/ledger.js';
import { type Given, done, item, judge as judgeOver, leftItem, loadFile, pairClaimFile, place, rank, rightItem, setClaimFile } from '../kernel-helpers.js';

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

/** A claim, from the generator: any quantifier, with or without `where`, `usable`, `vacuous` and `needs`. */
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
      ...(g.chance(0.5) ? { needs: randomNeeds(g) } : {}),
    },
  );
}

function randomNeeds(g: Gen): Needs {
  return {
    ...(g.chance(0.5) ? { inputs: ['accounts'] } : {}),
    ...(g.chance(0.5) ? { effect: g.pick<EffectClass>(['observe', 'probe', 'write']) } : {}),
    kinds: g.chance(0.5) ? ['t.item'] : ['t.item', 't.other'],
  };
}

/** What a run gives the judge for a claim's needs, and whether that leaves any of them unmet. */
type Run = { more: Partial<JudgeInput>; unmet: boolean };

/** A run that meets every need of the claim, or all but one: a kind, the input, or the effect, taken away. */
function randomRun(g: Gen, needs: Needs | undefined): Run {
  if (needs === undefined) return { more: {}, unmet: false };
  const least = EFFECT_CLASSES.indexOf(needs.effect ?? 'observe');
  let kinds = [...needs.kinds];
  let inputs: { [name: string]: Json } = Object.fromEntries((needs.inputs ?? []).map((name) => [name, 'given']));
  let effect = g.pick(EFFECT_CLASSES.slice(least));
  const takeAway = [
    () => {
      const kind = g.pick(needs.kinds);
      kinds = kinds.filter((k) => k !== kind);
    },
    ...(needs.inputs !== undefined ? [() => (inputs = {})] : []),
    ...(least > 0 ? [() => (effect = g.pick(EFFECT_CLASSES.slice(0, least)))] : []),
  ];
  const unmet = g.chance(0.5);
  if (unmet) g.pick(takeAway)();
  return { more: { inputs, supplies: { kinds, effect } }, unmet };
}

/** Judges the claim over the facts with what the run gives. */
const judge = (loaded: LoadedClaim, run: Run, facts: PlacedFact[]): Verdict => judgeOver(loaded, facts, run.more);

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
async function forAll(check: (g: Gen, loaded: LoadedClaim, facts: Given[], run: Run) => void): Promise<void> {
  for (let seed = 1; seed <= RUNS; seed++) {
    const g = generator(seed);
    const file = claimFile(g);
    if (!loadedBySeed.has(seed)) loadedBySeed.set(seed, loadFile(file));
    const loaded = await (loadedBySeed.get(seed) as Promise<LoadedClaim>);
    const facts = randomFacts(g);
    const run = randomRun(g, (loaded.claim as SetClaim).needs);
    try {
      check(g, loaded, facts, run);
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
    await forAll((_g, loaded, facts, run) => {
      expect(judge(loaded, run, place(facts))).toEqual(judge(loaded, run, place(facts)));
    });
  });

  it('2. order: reordering the facts of a view, or the positions they hold, never changes the verdict', async () => {
    await forAll((g, loaded, facts, run) => {
      const before = judge(loaded, run, place(facts));
      const shuffled = place(facts);
      expect(judge(loaded, run, g.shuffle(shuffled))).toEqual(before);
      // The same facts at other positions: what is read and shown moves with them, and nothing else changes. Each
      // collector run records one collection fact, so the order of two in one run never arises.
      expect(decided(judge(loaded, run, place(g.shuffle(facts))))).toEqual(decided(before));
    });
  });

  it('3. persistence: a fail of every or none, and a pass of some, stay when facts are added', async () => {
    await forAll((g, loaded, facts, run) => {
      const before = judge(loaded, run, place(facts));
      const q = (loaded.claim as SetClaim).quantifier;
      const settled = ((q === 'every' || q === 'none') && before.verdict === 'fail') || (q === 'some' && before.verdict === 'pass');
      if (!settled) return;
      const more = randomFacts(g);
      const after = judge(loaded, run, [...place(facts), ...place(more, facts.length + 1)]);
      expect(after.verdict).toBe(before.verdict);
      // Adding a counterexample never changes a fail either.
      if (before.verdict === 'fail') {
        const counterexample = item(q === 'every' ? 1 : 9);
        expect(judge(loaded, run, [...place(facts), ...place([counterexample], facts.length + 1)]).verdict).toBe('fail');
      }
    });
  });

  it('4. no uncovered absence: a pass of every, none or count, and a fail of some, imply covered was true', async () => {
    let seen = 0;
    await forAll((_g, loaded, facts, run) => {
      const v = judge(loaded, run, place(facts));
      const q = (loaded.claim as SetClaim).quantifier;
      if ((q !== 'some' && v.verdict === 'pass') || (q === 'some' && v.verdict === 'fail')) {
        seen++;
        expect(v.coverage.met).toBe(true);
      }
    });
    expect(seen).toBeGreaterThan(10);
  });

  it('lowering coverage never turns a verdict that is not known into a pass, nor makes a pass or fail that was not there', async () => {
    await forAll((g, loaded, facts, run) => {
      const covered = [...facts.filter((f) => f.kind !== 'collection'), collection('complete', 1)];
      const lowered = [...facts.filter((f) => f.kind !== 'collection'), g.pick([collection('failed', 1)])];
      const high = judge(loaded, run, place(covered));
      const low = judge(loaded, run, place(lowered));
      expect(low.coverage.met).toBe(false);
      if (low.verdict === 'pass' || low.verdict === 'fail') expect(high.verdict).toBe(low.verdict);
    });
  });

  it('5. errors never help: turning an item into an error, or marking it unusable, never makes a pass or a fail that was not there', async () => {
    let changed = 0;
    await forAll((g, loaded, facts, run) => {
      const items = facts.map((f, i) => [f, i] as const).filter(([f]) => f.kind === 't.item' && f.subject === undefined && f.by === 'c@1');
      if (items.length === 0) return;
      const [target, at] = g.pick(items);
      const spoiled = facts.map((f, i) => (i === at ? spoil(target, g.int(0, 3)) : f));
      const before = judge(loaded, run, place(facts));
      const after = judge(loaded, run, place(spoiled));
      if (after.verdict !== before.verdict) changed++;
      if (after.verdict === 'pass' || after.verdict === 'fail') expect(before.verdict).toBe(after.verdict);
    });
    expect(changed).toBeGreaterThan(10);
  });

  it('unmet needs: a verdict is never a pass, and a fail only of every or none with a counterexample shown', async () => {
    let seen = 0;
    await forAll((_g, loaded, facts, run) => {
      if (!run.unmet) return;
      seen++;
      const v = judge(loaded, run, place(facts));
      expect(v.verdict).not.toBe('pass');
      if (v.verdict === 'fail') {
        expect(['every', 'none']).toContain((loaded.claim as SetClaim).quantifier);
        expect(v.shown.length).toBeGreaterThan(0);
      } else {
        expect(v.verdict).toBe('blocked');
        expect(v.add?.length).toBeGreaterThan(0);
      }
    });
    expect(seen).toBeGreaterThan(30);
  });

  it('7. seen to fail: a claim that gives a pass names the example on which it gives a fail', async () => {
    await forAll((_g, loaded, facts, run) => {
      const v = judge(loaded, run, place(facts));
      if (v.verdict === 'pass') expect(v.failed_on).toBe('fails');
    });
  });
});

/** A pair claim, from the generator: any quantifier but count, with or without `where` on each side, `usable`, `unmatched` and `vacuous`. */
function pairFile(g: Gen) {
  const quantifier = g.pick<'every' | 'some' | 'none'>(['every', 'some', 'none']);
  const holding = [leftItem(1, 1), rightItem(1, 1)];
  const failing = [leftItem(1, 1), rightItem(1, 2)];
  const examples = quantifier === 'none' ? { fail: holding, pass: failing } : { fail: failing, pass: holding };
  return pairClaimFile(quantifier, examples, {
    id: 'generated.pair',
    ...(g.chance(0.5) ? { left: { from: 't.left', where: 'item.w' }, right: { from: 't.right', where: 'item.w' } } : {}),
    ...(g.chance(0.5) ? { usable: 'left.u > 0 && right.u > 0' } : {}),
    ...(g.chance(0.7) ? { unmatched: g.pick(['uncovered', 'fail', 'ignore']) } : {}),
    ...(quantifier !== 'some' && g.chance(0.5) ? { vacuous: g.pick(['pass', 'not_checked']) } : {}),
  });
}

/** One side's item: any key (or none, an error), any value (or none, an error), inside or outside, usable or not. */
function randomSide(g: Gen): Given {
  const base = g.pick([leftItem, rightItem])(g.pick<Json>([1, 2, 3]), g.pick<Json>([1, 2]), { w: g.pick<Json>([true, true, true, false, 'x']), u: g.pick<Json>([1, 1, 1, 0, 'x']) });
  const body = { ...(base.body as Record<string, Json>) };
  if (g.chance(0.1)) delete body.k;
  if (g.chance(0.1)) delete body.v;
  return { ...base, body };
}

function randomPairFacts(g: Gen): Given[] {
  const facts: Given[] = [];
  for (let run = 1, runs = g.int(0, 2); run <= runs; run++) facts.push(collection(g.pick(['complete', 'complete', 'failed']), run));
  for (let i = g.int(0, 7); i > 0; i--) facts.push(randomSide(g));
  if (g.chance(0.3)) facts.push({ ...randomSide(g), subject: 'other' });
  return g.shuffle(facts);
}

const pairBySeed = new Map<number, Promise<LoadedClaim>>();

async function forAllPairs(check: (g: Gen, loaded: LoadedClaim, claim: PairClaim, facts: Given[]) => void): Promise<void> {
  for (let seed = 1; seed <= RUNS; seed++) {
    const g = generator(seed + 100_000);
    const file = pairFile(g);
    if (!pairBySeed.has(seed)) pairBySeed.set(seed, loadFile(file));
    const loaded = await (pairBySeed.get(seed) as Promise<LoadedClaim>);
    try {
      check(g, loaded, loaded.claim as PairClaim, randomPairFacts(g));
    } catch (error) {
      throw new Error(`pair seed ${seed}, a ${file.quantifier} claim, unmatched ${String((file as { unmatched?: string }).unmatched)}: ${(error as Error).message}`);
    }
  }
}

/** Every way to make one item of a pair claim an error or unusable: its key, its value, its `where`, its `usable`. */
const spoilSide = (given: Given, how: number): Given => {
  const { k: _k, v: _v, ...rest } = given.body as Record<string, Json>;
  const body = given.body as Record<string, Json>;
  return { ...given, body: [{ ...rest, v: body.v ?? 1 }, { ...rest, k: body.k ?? 1 }, { ...body, w: 'x' }, { ...body, u: 0 }][how] as Json };
};

describe('what the judge guarantees for pair claims (ALGORITHMS A6)', () => {
  const none = {};
  it('1. function, and 2. order: the same claim and view give the same verdict, in any order of the facts', async () => {
    await forAllPairs((g, loaded, _claim, facts) => {
      const before = judgeOver(loaded, place(facts), none);
      expect(judgeOver(loaded, place(facts), none)).toEqual(before);
      expect(judgeOver(loaded, g.shuffle(place(facts)), none)).toEqual(before);
      expect(decided(judgeOver(loaded, place(g.shuffle(facts)), none))).toEqual(decided(before));
    });
  });

  it('3. persistence: a fail of every or none from a pair, and a pass of some, stay when facts are added', async () => {
    let seen = 0;
    await forAllPairs((g, loaded, claim, facts) => {
      const before = judgeOver(loaded, place(facts), none);
      const q = claim.quantifier;
      // Under `unmatched: 'fail'` a fail can rest on a left item with no partner, which is an absence: a partner added
      // later ends it. That is the one exception A6.3 states; the view is closed before the judge runs, so no partner
      // arrives late (FOUNDATION §4, "Views"). Those claims are left out here.
      const settled = claim.unmatched !== 'fail' && (((q === 'every' || q === 'none') && before.verdict === 'fail') || (q === 'some' && before.verdict === 'pass'));
      if (!settled) return;
      seen++;
      const after = judgeOver(loaded, [...place(facts), ...place(randomPairFacts(g), facts.length + 1)], none);
      expect(after.verdict).toBe(before.verdict);
    });
    expect(seen).toBeGreaterThan(10);
  });

  it('only a left item can be unmatched: adding a right item no left item partners never changes the verdict, under any mode', async () => {
    await forAllPairs((g, loaded, _claim, facts) => {
      const before = judgeOver(loaded, place(facts), none);
      // The generator's keys are 1 to 3, so key 99 partners nothing.
      const after = judgeOver(loaded, g.shuffle(place([...facts, rightItem(99, 1)])), none);
      expect(decided(after)).toEqual(decided(before));
    });
  });

  it('4. no uncovered absence: a pass of every or none, and a fail of some, imply covered was true', async () => {
    let seen = 0;
    await forAllPairs((_g, loaded, claim, facts) => {
      const v = judgeOver(loaded, place(facts), none);
      if ((claim.quantifier !== 'some' && v.verdict === 'pass') || (claim.quantifier === 'some' && v.verdict === 'fail')) {
        seen++;
        expect(v.coverage.met).toBe(true);
      }
    });
    expect(seen).toBeGreaterThan(10);
  });

  it('lowering coverage never turns a verdict that is not known into a pass, nor makes a pass or fail that was not there', async () => {
    await forAllPairs((_g, loaded, _claim, facts) => {
      const items = facts.filter((f) => f.kind !== 'collection');
      const high = judgeOver(loaded, place([...items, collection('complete', 1)]), none);
      const low = judgeOver(loaded, place([...items, collection('failed', 1)]), none);
      expect(low.coverage.met).toBe(false);
      if (low.verdict === 'pass' || low.verdict === 'fail') expect(high.verdict).toBe(low.verdict);
    });
  });

  it('5. errors never help: a key, a value or a where that errors, or an unusable pair, never makes a pass or a fail that was not there', async () => {
    let changed = 0;
    await forAllPairs((g, loaded, _claim, facts) => {
      const sides = facts.map((f, i) => [f, i] as const).filter(([f]) => f.kind !== 'collection' && f.subject === undefined);
      if (sides.length === 0) return;
      const [target, at] = g.pick(sides);
      const spoiled = facts.map((f, i) => (i === at ? spoilSide(target, g.int(0, 3)) : f));
      const before = judgeOver(loaded, place(facts), none);
      const after = judgeOver(loaded, place(spoiled), none);
      if (after.verdict !== before.verdict) changed++;
      if (after.verdict === 'pass' || after.verdict === 'fail') expect(before.verdict).toBe(after.verdict);
    });
    expect(changed).toBeGreaterThan(10);
  });
});

describe('6. monotone fold (ALGORITHMS A6): raising one verdict in the order F < U < T never lowers the result', () => {
  it('for the fold, all and any, over generated lists of verdicts', () => {
    const g = generator(6);
    for (let i = 0; i < RUNS * 3; i++) {
      const list = Array.from({ length: g.int(1, 5) }, () => g.pick(VERDICTS));
      const at = g.int(0, list.length - 1);
      const from = list[at] as VerdictValue;
      // Another word of the same rank, as well as a higher one: the result's rank must not drop either way.
      const higher = VERDICTS.filter((v) => rank(v) >= rank(from));
      const raised = list.map((v, j) => (j === at ? g.pick(higher) : v));
      const where = `${JSON.stringify(list)} raised at ${at} to ${JSON.stringify(raised)}`;
      expect(rank(fold(raised)), where).toBeGreaterThanOrEqual(rank(fold(list)));
      expect(rank(combine('all', raised)), where).toBeGreaterThanOrEqual(rank(combine('all', list)));
      expect(rank(combine('any', raised)), where).toBeGreaterThanOrEqual(rank(combine('any', list)));
    }
  });
});