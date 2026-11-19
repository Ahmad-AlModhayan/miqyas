// SPDX-License-Identifier: AGPL-3.0-only
// The judge for `set` and `pair` claims and their combinations (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A1, A2, A5
// and A8, ADR 0006); the fold is in fold.ts. The judge is a pure function of a loaded claim and the facts in its view:
// no clock, no randomness, no input or output. It gives the whole verdict record, with the facts it read, the items it
// showed and the coverage it saw; nothing else assembles a verdict. The loader refuses a claim that asks for more
// (`each`, or a `trace` or `sample` shape).
import { type CelValue, type CompiledExpression, type Truth, evaluate, evaluateValue } from './cel.js';
import type { Fact, PlacedFact } from './fact.js';
import { type Combination, type VerdictValue, combine } from './fold.js';
import type { Json } from './ledger.js';

// The verdict words, the combinations and the fold moved to fold.ts; they are exported here too, for the importers
// that take them with the judge.
export { COMBINATIONS, type Combination, type Conclusion, type ExitCode, type SealResult, VERDICTS, type VerdictValue, combine, fold, sealResult } from './fold.js';

export const QUANTIFIERS = ['every', 'some', 'none', 'count'] as const;
export type Quantifier = (typeof QUANTIFIERS)[number];

/**
 * The effect classes of the gate, least first (docs/FOUNDATION.md §6). A claim's `needs` names the least it needs;
 * the run allows every class up to the one it was given.
 */
export const EFFECT_CLASSES = ['observe', 'interact', 'probe', 'write', 'disrupt', 'execute'] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

/**
 * Why a verdict is not known: one list, each reason under the one word it goes with (docs/FOUNDATION.md §4). The
 * word says who acts next: `blocked`, the person; `not_checked`, Miqyas; `unverified`, a review.
 */
export const REASONS = {
  blocked: [
    'an input is missing',
    'an effect it needs is not allowed',
    'no collector records a kind it needs',
    'a secret is missing',
    'a flag is missing',
    'a tool is not installed',
    'a step was never bound',
  ],
  not_checked: [
    'coverage not met',
    'uncertain items: an expression gave an error',
    "uncertain items: a measurement couldn't be used",
    "uncertain items: an expression gave an error, and a measurement couldn't be used",
    'nothing to check',
    'a collector failed',
    'dropped for time',
    'dropped for money',
    'too few samples',
  ],
  unverified: ['not seen to fail', 'a binding nobody reviewed'],
} as const;
export type NotKnown = keyof typeof REASONS;
export type Reason = (typeof REASONS)[NotKnown][number];

/** What a claim needs before it can be judged at all (docs/FOUNDATION.md §4, docs/ALGORITHMS.md E2). */
export type Needs = { inputs?: string[]; effect?: EffectClass; kinds: string[] };

/** The rule a quantifier reads: `holds` over each item, or for `count`, `count` over `n`. */
type QuantifiedBy<Rule> = { quantifier: Exclude<Quantifier, 'count'>; holds: Rule } | { quantifier: 'count'; count: Rule };

/** A `set` claim as its file states it (docs/FOUNDATION.md §4). */
export type SetClaim = {
  id: string;
  version: number;
  title: string;
  needs?: Needs;
  view: { kinds: string[]; by?: string[] };
  shape: 'set';
  from: string;
  where?: string;
  usable?: string;
  covered: string;
  /** `every` and `none` only. */
  vacuous?: 'pass' | 'not_checked';
} & QuantifiedBy<string>;

/** One side of a `pair` claim: the kind of fact its items are, and optionally which of them (CEL over `item`). */
export type Selector = { from: string; where?: string };

/** What an item with no partner means in a `pair` claim; `uncovered` by default (docs/FOUNDATION.md §4). */
export const UNMATCHED = ['uncovered', 'fail', 'ignore'] as const;
export type Unmatched = (typeof UNMATCHED)[number];

/**
 * A `pair` claim as its file states it (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A2). `on` is a key expression over
 * `item` for each side; `holds` and `usable` are CEL over one pair, as `left` and `right`.
 */
export type PairClaim = {
  id: string;
  version: number;
  title: string;
  needs?: Needs;
  view: { kinds: string[]; by?: string[] };
  shape: 'pair';
  quantifier: Exclude<Quantifier, 'count'>;
  left: Selector;
  right: Selector;
  on: [string, string];
  usable?: string;
  holds: string;
  unmatched?: Unmatched;
  covered: string;
  /** `every` and `none` only. */
  vacuous?: 'pass' | 'not_checked';
};

/** A combination: `all` or `any` of its parts, each a claim of its own. Its file states it as `all: [...]` or `any: [...]`. */
export type CombinedClaim = { id: string; version: number; title: string; combine: Combination; parts: Claim[] };

/** Every claim the judge takes. The other shapes join this union as they are judged. */
export type Claim = SetClaim | PairClaim | CombinedClaim;

/** How a verdict names its claim: `id@version`. */
export function claimRef(claim: Pick<Claim, 'id' | 'version'>): string {
  return `${claim.id}@${claim.version}`;
}

/** What every loaded claim carries: its file's digest, and the failing example that showed it can fail. */
type Loaded = {
  /** SHA-256 of the claim file's bytes, in hex. A part of a combination carries its file's. */
  rule: string;
  /** The name of the example on which the claim gave `fail`. */
  failedOn: string;
};

/** A `set` claim that loaded: each rule it states, compiled, with the quantifier that reads `holds` or `count`. */
export type LoadedSetClaim = Loaded & {
  claim: SetClaim;
  compiled: { where?: CompiledExpression; usable?: CompiledExpression; covered: CompiledExpression } & QuantifiedBy<CompiledExpression>;
};

/** A `pair` claim that loaded, its rules compiled. */
export type LoadedPairClaim = Loaded & {
  claim: PairClaim;
  compiled: {
    left: { where?: CompiledExpression };
    right: { where?: CompiledExpression };
    on: [CompiledExpression, CompiledExpression];
    usable?: CompiledExpression;
    holds: CompiledExpression;
    covered: CompiledExpression;
  };
};

/** A combination that loaded, with each part loaded. */
export type LoadedCombinedClaim = Loaded & { claim: CombinedClaim; parts: LoadedClaim[] };

/** A claim that loaded. */
export type LoadedClaim = LoadedSetClaim | LoadedPairClaim | LoadedCombinedClaim;

export interface JudgeInput {
  /** The subject the view is about; the engine fills it in (docs/FOUNDATION.md §4, "Views"). */
  subject: string;
  /** The facts recorded so far. The judge keeps those its view names, and reads nothing else. */
  facts: readonly PlacedFact[];
  /** The run's inputs by name, for `ctx.inputs` and for the inputs a claim needs. */
  inputs?: { [name: string]: Json };
  /**
   * What the run can supply beyond its inputs, for the claim's `needs`: the effect it allows (`observe` when not
   * given) and the kinds its collectors record (none when not given).
   */
  supplies?: { effect?: EffectClass; kinds?: readonly string[] };
}

/** The verdict record's body (docs/FOUNDATION.md §4, "Evidence"). */
export type Verdict = {
  claim: string;
  rule: string;
  view: { subject: string; kinds: string[]; by?: string[] };
  verdict: VerdictValue;
  reason?: Reason;
  add?: string[];
  /** Items for a `set` claim, pairs for a `pair` claim; `unmatched` is a `pair` claim's left items with no partner. */
  items: { held: number; failed: number; outside: number; uncertain: number; unmatched?: number };
  read: number[];
  shown: number[];
  coverage: { rule: string; met: boolean; saw: Json };
  vacuous?: boolean;
  depth: 'facts' | 'derived' | 'measured';
  assurance: 'tested';
  basis: 'rule';
  failed_on: string;
  /** A combination's parts, each its own verdict record, in the order the claim lists them. */
  parts?: Verdict[];
};

type Outcome = { verdict: VerdictValue; reason?: Reason; shown: number[] };

/** Judges any loaded claim over the facts in its view: a `set`, a `pair` or a combination. */
export function judgeClaim(loaded: LoadedClaim, input: JudgeInput): Verdict {
  if ('parts' in loaded) return judgeCombined(loaded, input);
  if (loaded.claim.shape === 'pair') return judgePair(loaded as LoadedPairClaim, input);
  return judgeSet(loaded as LoadedSetClaim, input);
}

/**
 * The facts in a claim's view, in ledger order. A view has one subject (docs/FOUNDATION.md §4, "Views"): a fact about
 * another is not read, so re-judging the verdict's view reads exactly the facts this judging read.
 */
function factsInView(view: { kinds: string[]; by?: string[] }, input: JudgeInput): PlacedFact[] {
  return input.facts
    .filter(({ fact }) => fact.subject === input.subject && view.kinds.includes(fact.kind) && (view.by === undefined || view.by.includes(fact.by)))
    .sort((a, b) => a.seq - b.seq);
}

/**
 * How a claim's items or pairs were sorted (docs/ALGORITHMS.md A1): `yes` holds (or for `count`, is inside the claim),
 * `no` fails, each with the positions it shows; the rest outside, or uncertain by an error or as unusable.
 */
type Groups = { yes: number[][]; no: number[][]; outside: number; errored: number; unusable: number };

/** The table of ALGORITHMS A1 for every quantifier but `count`, over items or pairs. */
function decideTable(quantifier: Exclude<Quantifier, 'count'>, g: Groups, met: boolean, vacuousRule: 'pass' | 'not_checked' | undefined): Outcome {
  const uncertain = g.errored + g.unusable;
  const vacuous = g.yes.length + g.no.length + uncertain === 0;
  const empty = (): Outcome => (vacuousRule === 'pass' ? { verdict: 'pass', shown: [] } : notKnown('nothing to check'));
  switch (quantifier) {
    case 'every':
      if (g.no.length > 0) return { verdict: 'fail', shown: positions(g.no) };
      if (uncertain > 0) return uncertainItems(g);
      if (!met) return notKnown('coverage not met');
      if (vacuous) return empty();
      return { verdict: 'pass', shown: [] };
    case 'some':
      if (g.yes.length > 0) return { verdict: 'pass', shown: positions(g.yes) };
      if (uncertain > 0) return uncertainItems(g);
      if (!met) return notKnown('coverage not met');
      return { verdict: 'fail', shown: [] };
    case 'none':
      if (g.yes.length > 0) return { verdict: 'fail', shown: positions(g.yes) };
      if (uncertain > 0) return uncertainItems(g);
      if (!met) return notKnown('coverage not met');
      if (vacuous) return empty();
      return { verdict: 'pass', shown: [] };
  }
}

const notKnown = (reason: Reason): Outcome => ({ verdict: 'not_checked', reason, shown: [] });

/** `U(uncertain items)`, saying which it was. `countErred`: a count rule's error, which A1 counts as an expression's. */
function uncertainItems(g: Groups, countErred = false): Outcome {
  return notKnown(
    g.unusable === 0
      ? 'uncertain items: an expression gave an error'
      : g.errored === 0 && !countErred
        ? "uncertain items: a measurement couldn't be used"
        : "uncertain items: an expression gave an error, and a measurement couldn't be used",
  );
}

/** The positions shown, each once, in ledger order. */
function positions(groups: readonly number[][]): number[] {
  return [...new Set(groups.flat())].sort((a, b) => a - b);
}

/**
 * Unmet needs, then the verdict record (docs/FOUNDATION.md §4, "Evidence"). A counterexample of an `every` or `none` claim is
 * enough whatever is missing. Anything else waits on the person: a `some` or `count` claim fails by not finding
 * something, and `covered` can't tell whether what it needs was there.
 */
function verdictRecord(
  loaded: LoadedSetClaim | LoadedPairClaim,
  input: JudgeInput,
  inView: readonly PlacedFact[],
  g: Groups,
  decided: Outcome,
  coverage: Verdict['coverage'],
  more: { unmatched?: number },
): Verdict {
  const { claim } = loaded;
  const vacuous = (claim.quantifier === 'every' || claim.quantifier === 'none') && g.yes.length + g.no.length + g.errored + g.unusable === 0;
  const missing = unmet(claim.needs, input);
  const add = missing.map(({ need, name }) => `${need}:${name}`);
  let outcome = decided;
  const counterexample = outcome.verdict === 'fail' && (claim.quantifier === 'every' || claim.quantifier === 'none');
  const first = missing[0];
  if (first !== undefined && !counterexample) outcome = { verdict: 'blocked', reason: BLOCKED_BY[first.need], shown: [] };
  return {
    claim: claimRef(claim),
    rule: loaded.rule,
    view: { subject: input.subject, kinds: [...claim.view.kinds], ...(claim.view.by ? { by: [...claim.view.by] } : {}) },
    verdict: outcome.verdict,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    ...(outcome.verdict === 'blocked' ? { add } : {}),
    items: { held: g.yes.length, failed: g.no.length, outside: g.outside, uncertain: g.errored + g.unusable, ...more },
    read: inView.map(({ seq }) => seq),
    shown: outcome.shown,
    coverage,
    ...(vacuous ? { vacuous: true } : {}),
    depth: depth(inView, input.facts),
    assurance: 'tested',
    basis: 'rule',
    failed_on: loaded.failedOn,
  };
}

/** Judges a `set` claim over the facts in its view (docs/ALGORITHMS.md A1). */
export function judgeSet(loaded: LoadedSetClaim, input: JudgeInput): Verdict {
  const { claim, compiled } = loaded;
  const inView = factsInView(claim.view, input);

  // Each item goes to one of four groups, named as in ALGORITHMS A1: `yes` (it holds, or for `count` it is inside the
  // claim), `no` (it fails), outside, or uncertain. The record calls the first two `held` and `failed`.
  const yes: number[][] = [];
  const no: number[][] = [];
  let outside = 0;
  let errored = 0;
  let unusable = 0;
  for (const { seq, fact } of inView) {
    if (fact.kind !== claim.from) continue;
    const item = { item: fact.body };
    const where = compiled.where === undefined ? 'true' : evaluate(compiled.where, item);
    if (where === 'false') {
      outside++;
      continue;
    }
    if (where === 'error') {
      errored++;
      continue;
    }
    if (compiled.usable !== undefined && evaluate(compiled.usable, item) !== 'true') {
      unusable++; // the measurement can't be used
      continue;
    }
    if (compiled.quantifier === 'count') {
      yes.push([seq]);
      continue;
    }
    const holds = evaluate(compiled.holds, item);
    if (holds === 'true') yes.push([seq]);
    else if (holds === 'false') no.push([seq]);
    else errored++;
  }
  const groups: Groups = { yes, no, outside, errored, unusable };

  const ctx = { collections: collections(inView), inputs: input.inputs ?? {} };
  const met = evaluate(compiled.covered, { ctx }) === 'true'; // an error is not covered

  let decided: Outcome;
  if (compiled.quantifier === 'count') {
    if (!met) decided = notKnown('coverage not met');
    else {
      // The count rule over every count the uncertain items allow: each may be inside the claim or not.
      const answers = new Set<Truth>();
      for (let n = yes.length; n <= yes.length + errored + unusable; n++) answers.add(evaluate(compiled.count, { n }));
      if (answers.size > 1 || answers.has('error')) decided = uncertainItems(groups, answers.has('error'));
      else decided = { verdict: answers.has('true') ? 'pass' : 'fail', shown: [] };
    }
  } else decided = decideTable(compiled.quantifier, groups, met, claim.vacuous);
  return verdictRecord(loaded, input, inView, groups, decided, { rule: claim.covered, met, saw: ctx }, {});
}

/** One side's item of a `pair` claim, with its key as text, or the item uncertain. */
type Keyed = { seq: number; body: Json; key: string };

/**
 * Judges a `pair` claim over the facts in its view (docs/ALGORITHMS.md A2): the sides joined on their keys, each
 * pair sorted as A1 sorts an item, then A1's table over the pairs. A left item with no partner is unmatched; a right
 * item with no partner is not counted, as in A2's loop. Under `uncovered` an unmatched item means coverage is not met,
 * under `fail` it is a counterexample (counted as held for a `none` claim, as failed for the others), under `ignore` it
 * is left out. Under `fail`, an unmatched item is uncertain instead while an item on the right is uncertain, since that
 * item could be its partner: an error never makes a fail.
 */
export function judgePair(loaded: LoadedPairClaim, input: JudgeInput): Verdict {
  const { claim, compiled } = loaded;
  const inView = factsInView(claim.view, input);
  const groups: Groups = { yes: [], no: [], outside: 0, errored: 0, unusable: 0 };

  const side = (selector: Selector, where: CompiledExpression | undefined, on: CompiledExpression) => {
    const keyed: Keyed[] = [];
    let uncertain = 0;
    for (const { seq, fact } of inView) {
      if (fact.kind !== selector.from) continue;
      const item = { item: fact.body };
      const w = where === undefined ? 'true' : evaluate(where, item);
      if (w === 'false') {
        groups.outside++;
        continue;
      }
      const key = w === 'error' ? undefined : keyOf(on, item);
      if (key === undefined) uncertain++; // a `where` or a key that errors
      else keyed.push({ seq, body: fact.body, key });
    }
    groups.errored += uncertain;
    return { keyed, uncertain };
  };
  const left = side(claim.left, compiled.left.where, compiled.on[0]);
  const right = side(claim.right, compiled.right.where, compiled.on[1]);

  const index = new Map<string, Keyed[]>();
  for (const b of right.keyed) index.set(b.key, [...(index.get(b.key) ?? []), b]);
  const unmatched: number[] = [];
  for (const a of left.keyed) {
    const partners = index.get(a.key) ?? [];
    if (partners.length === 0) unmatched.push(a.seq);
    for (const b of partners) {
      const pair = { left: a.body, right: b.body };
      if (compiled.usable !== undefined && evaluate(compiled.usable, pair) !== 'true') {
        groups.unusable++; // the measurement can't be used
        continue;
      }
      const holds = evaluate(compiled.holds, pair);
      if (holds === 'true') groups.yes.push([a.seq, b.seq]);
      else if (holds === 'false') groups.no.push([a.seq, b.seq]);
      else groups.errored++;
    }
  }

  const policy = claim.unmatched ?? 'uncovered';
  if (policy === 'fail') {
    // A counterexample goes where A1's table looks for one: among the pairs that hold for a `none` claim, among those
    // that fail for an `every` claim. A `some` claim has no counterexample; an unmatched item is one more that is not a
    // witness, so it counts as failed, and the claim fails, covered, with nothing shown, as any `some` that finds none.
    const against = claim.quantifier === 'none' ? groups.yes : groups.no;
    for (const seq of unmatched) {
      if (right.uncertain > 0) groups.errored++;
      else against.push([seq]);
    }
  }
  const ctx = { collections: collections(inView), inputs: input.inputs ?? {} };
  const covered = evaluate(compiled.covered, { ctx }) === 'true'; // an error is not covered
  const met = covered && (policy !== 'uncovered' || unmatched.length === 0);
  const decided = decideTable(claim.quantifier, groups, met, claim.vacuous);
  return verdictRecord(loaded, input, inView, groups, decided, { rule: claim.covered, met, saw: ctx }, { unmatched: unmatched.length });
}

/** A key as text, so that keys compare by value; undefined when the key expression errors. */
function keyOf(on: CompiledExpression, item: { item: Json }): string | undefined {
  const outcome = evaluateValue(on, item);
  return outcome.ok ? keyText(outcome.value) : undefined;
}

function keyText(value: CelValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return `i${value}`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(keyText).join(',')}]`;
  const entries = [...value.entries()].map(([k, v]) => `${keyText(k)}:${keyText(v)}`).sort();
  return `{${entries.join(',')}}`;
}

const DEPTHS: readonly Verdict['depth'][] = ['facts', 'derived', 'measured'];

/**
 * Judges a combination: each part over the same input, then `combine`. The record keeps each part's verdict; its
 * reason and what it shows come from the parts that gave its answer, what to add from every blocked part, its read set
 * is every part's, and its depth the deepest.
 */
function judgeCombined(loaded: LoadedCombinedClaim, input: JudgeInput): Verdict {
  const { claim } = loaded;
  const parts = loaded.parts.map((part) => judgeClaim(part, input));
  const verdict = combine(claim.combine, parts.map((p) => p.verdict));
  const deciding = parts.filter((p) => p.verdict === verdict);
  const reason = deciding.find((p) => p.reason !== undefined)?.reason;
  const add = [...new Set(parts.flatMap((p) => p.add ?? []))];
  const kinds = [...new Set(parts.flatMap((p) => p.view.kinds))];
  const by = parts.every((p) => p.view.by !== undefined) ? [...new Set(parts.flatMap((p) => p.view.by ?? []))] : undefined;
  const sum = (field: 'held' | 'failed' | 'outside' | 'uncertain') => parts.reduce((n, p) => n + p.items[field], 0);
  return {
    claim: claimRef(claim),
    rule: loaded.rule,
    view: { subject: input.subject, kinds, ...(by !== undefined ? { by } : {}) },
    verdict,
    ...(reason !== undefined ? { reason } : {}),
    ...(verdict === 'blocked' ? { add } : {}),
    items: { held: sum('held'), failed: sum('failed'), outside: sum('outside'), uncertain: sum('uncertain') },
    read: [...new Set(parts.flatMap((p) => p.read))].sort((a, b) => a - b),
    shown: verdict === 'pass' || verdict === 'fail' ? positions(deciding.map((p) => p.shown)) : [],
    coverage: { rule: claim.combine, met: parts.every((p) => p.coverage.met), saw: null },
    ...(parts.some((p) => p.vacuous) ? { vacuous: true } : {}),
    depth: DEPTHS[Math.max(...parts.map((p) => DEPTHS.indexOf(p.depth)))] as Verdict['depth'],
    assurance: 'tested',
    basis: 'rule',
    failed_on: loaded.failedOn,
    parts,
  };
}

/** One of a claim's `needs` the run doesn't meet. The verdict's `add` writes it as `<need>:<name>`. */
type Unmet = { need: 'input' | 'effect' | 'kind'; name: string };

const BLOCKED_BY: { [need in Unmet['need']]: Reason } = {
  input: 'an input is missing',
  effect: 'an effect it needs is not allowed',
  kind: 'no collector records a kind it needs',
};

/**
 * What to add: each of the claim's `needs` the run doesn't meet, its inputs, then its effect class, then its kinds
 * (docs/FOUNDATION.md §4; docs/ALGORITHMS.md E2).
 */
function unmet(needs: Needs | undefined, input: JudgeInput): Unmet[] {
  if (needs === undefined) return [];
  const missing: Unmet[] = [];
  const inputs = input.inputs ?? {};
  for (const name of needs.inputs ?? []) if (!Object.hasOwn(inputs, name)) missing.push({ need: 'input', name });
  const allowed = input.supplies?.effect ?? 'observe';
  if (needs.effect !== undefined && EFFECT_CLASSES.indexOf(needs.effect) > EFFECT_CLASSES.indexOf(allowed)) missing.push({ need: 'effect', name: needs.effect });
  const kinds = input.supplies?.kinds ?? [];
  for (const kind of needs.kinds) if (!kinds.includes(kind)) missing.push({ need: 'kind', name: kind });
  return missing;
}

/** `ctx.collections`: each collector's `collection` fact in the view, keyed by the collector, the last run winning. */
function collections(inView: readonly PlacedFact[]): { [by: string]: Json } {
  const latest = new Map<string, { run: number; body: Json }>();
  for (const { fact } of inView) {
    if (fact.kind !== 'collection') continue;
    const seen = latest.get(fact.by);
    if (seen === undefined || fact.run >= seen.run) latest.set(fact.by, { run: fact.run, body: fact.body });
  }
  const out: { [by: string]: Json } = {};
  for (const by of [...latest.keys()].sort()) out[by] = (latest.get(by) as { body: Json }).body;
  return out;
}

/**
 * docs/ALGORITHMS.md A8, over the facts read and, through `from`, every fact they were derived from. A `from` source
 * that isn't among the facts given is an input the judge can't see, so it can't be re-run: `measured`. A fact that
 * lists withheld fields makes the verdict `measured` too: the judge does not yet tell which fields an expression
 * reads, so it takes the cautious answer.
 */
function depth(read: readonly PlacedFact[], given: readonly PlacedFact[]): Verdict['depth'] {
  const bySeq = new Map(given.map(({ seq, fact }) => [seq, fact]));
  const reached: Fact[] = [];
  const seen = new Set<number>();
  const queue = read.map(({ seq }) => seq);
  while (queue.length > 0) {
    const seq = queue.pop() as number;
    if (seen.has(seq)) continue;
    seen.add(seq);
    const fact = bySeq.get(seq);
    if (fact === undefined) return 'measured';
    reached.push(fact);
    queue.push(...(fact.from ?? []));
  }
  if (reached.some((fact) => (fact.withheld?.length ?? 0) > 0)) return 'measured';
  if (reached.some((fact) => fact.from !== undefined)) return 'derived';
  return 'facts';
}
