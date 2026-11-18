// SPDX-License-Identifier: AGPL-3.0-only
// The judge for a `set` claim, and the fold (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A1, A5 and A8, ADR 0006). The
// judge is a pure function of a loaded claim and the facts in its view: no clock, no randomness, no input or output.
// It gives the whole verdict record, with the facts it read, the items it showed and the coverage it saw; nothing
// else assembles a verdict. It judges every quantifier of A1 with `where` and `usable`; the loader refuses a claim
// that asks for more (`each`, or another shape).
import { type CompiledExpression, type Truth, evaluate } from './cel.js';
import type { Fact, PlacedFact } from './fact.js';
import type { Json } from './ledger.js';

export const QUANTIFIERS = ['every', 'some', 'none', 'count'] as const;
export type Quantifier = (typeof QUANTIFIERS)[number];

export const VERDICTS = ['pass', 'fail', 'not_checked', 'blocked', 'unverified'] as const;
export type VerdictValue = (typeof VERDICTS)[number];

/**
 * The effect classes of the gate, least first (docs/FOUNDATION.md §6). A claim's `needs` names the least it needs;
 * the run allows every class up to the one it was given.
 */
export const EFFECTS = ['observe', 'interact', 'probe', 'write', 'disrupt', 'execute'] as const;
export type Effect = (typeof EFFECTS)[number];

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
    'a tool is not installed',
    'a step was never bound',
  ],
  not_checked: [
    'coverage not met',
    'uncertain items: an expression gave an error',
    "uncertain items: a measurement couldn't be used",
    "uncertain items: an expression gave an error, and a measurement couldn't be used",
    'the count rule gave an error',
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
export type Needs = { inputs?: string[]; effect?: Effect; kinds: string[] };

/** A `set` claim as its file states it (docs/FOUNDATION.md §4). */
export type SetClaim = {
  id: string;
  version: number;
  title: string;
  needs?: Needs;
  view: { kinds: string[]; by?: string[] };
  shape: 'set';
  quantifier: Quantifier;
  from: string;
  where?: string;
  usable?: string;
  /** Every quantifier but `count`. */
  holds?: string;
  /** `count` only: CEL over `n`. */
  count?: string;
  covered: string;
  /** `every` and `none` only. */
  vacuous?: 'pass' | 'not_checked';
};

/** Every claim the judge takes. The other shapes join this union as they are judged. */
export type Claim = SetClaim;

/** How a verdict names its claim: `id@version`. */
export function claimRef(claim: Pick<Claim, 'id' | 'version'>): string {
  return `${claim.id}@${claim.version}`;
}

/** A claim that loaded: its rules compiled, its file's digest, and the failing example that showed it can fail. */
export interface LoadedClaim {
  claim: SetClaim;
  /** SHA-256 of the claim file's bytes, in hex. */
  rule: string;
  /** Each rule the claim states, compiled. The loader sees that `holds` or `count` is there as the quantifier asks. */
  compiled: { where?: CompiledExpression; usable?: CompiledExpression; holds?: CompiledExpression; count?: CompiledExpression; covered: CompiledExpression };
  /** The name of the example on which the claim gave `fail`. */
  failedOn: string;
}

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
  supplies?: { effect?: Effect; kinds?: readonly string[] };
}

/** The verdict record's body (docs/FOUNDATION.md §4, "Evidence"). */
export type Verdict = {
  claim: string;
  rule: string;
  view: { subject: string; kinds: string[]; by?: string[] };
  verdict: VerdictValue;
  reason?: Reason;
  add?: string[];
  items: { held: number; failed: number; outside: number; uncertain: number };
  read: number[];
  shown: number[];
  coverage: { rule: string; met: boolean; saw: Json };
  vacuous?: boolean;
  depth: 'facts' | 'derived' | 'measured';
  assurance: 'tested';
  basis: 'rule';
  failed_on: string;
};

type Outcome = { verdict: VerdictValue; reason?: Reason; shown: number[] };

/** Judges a `set` claim over the facts in its view (docs/ALGORITHMS.md A1). */
export function judgeSet(loaded: LoadedClaim, input: JudgeInput): Verdict {
  const { claim, compiled } = loaded;
  // A view has one subject (docs/FOUNDATION.md §4, "Views"): a fact about another is not read, so re-judging the
  // verdict's view reads exactly the facts this judging read.
  const inView = input.facts
    .filter(
      ({ fact }) =>
        fact.subject === input.subject &&
        claim.view.kinds.includes(fact.kind) &&
        (claim.view.by === undefined || claim.view.by.includes(fact.by)),
    )
    .sort((a, b) => a.seq - b.seq);

  // Each item goes to one of four groups: it holds, it fails, it is outside, or it is uncertain.
  const held: number[] = [];
  const failed: number[] = [];
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
    if (claim.quantifier === 'count') {
      held.push(seq);
      continue;
    }
    const holds = evaluate(compiled.holds as CompiledExpression, item);
    if (holds === 'true') held.push(seq);
    else if (holds === 'false') failed.push(seq);
    else errored++;
  }
  const uncertain = errored + unusable;

  const ctx = { collections: collections(inView), inputs: input.inputs ?? {} };
  const met = evaluate(compiled.covered, { ctx }) === 'true'; // an error is not covered

  // No item inside an `every` or `none` claim: reported whatever the verdict, so a `where` that selects nothing is seen.
  const vacuous = (claim.quantifier === 'every' || claim.quantifier === 'none') && held.length + failed.length + uncertain === 0;
  const add = unmet(claim.needs, input);
  let outcome = decide();
  // A counterexample is enough whatever is missing; anything short of a fail waits on the person.
  if (add.length > 0 && outcome.verdict !== 'fail') outcome = { verdict: 'blocked', reason: blockedBy(add[0] as string), shown: [] };

  return {
    claim: claimRef(claim),
    rule: loaded.rule,
    view: { subject: input.subject, kinds: [...claim.view.kinds], ...(claim.view.by ? { by: [...claim.view.by] } : {}) },
    verdict: outcome.verdict,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    ...(outcome.verdict === 'blocked' ? { add } : {}),
    items: { held: held.length, failed: failed.length, outside, uncertain },
    read: inView.map(({ seq }) => seq),
    shown: outcome.shown,
    coverage: { rule: claim.covered, met, saw: ctx },
    ...(vacuous ? { vacuous: true } : {}),
    depth: depth(inView, input.facts),
    assurance: 'tested',
    basis: 'rule',
    failed_on: loaded.failedOn,
  };

  function decide(): Outcome {
    const notKnown = (reason: Reason): Outcome => ({ verdict: 'not_checked', reason, shown: [] });
    const uncertainItems = (): Outcome =>
      notKnown(
        unusable === 0
          ? 'uncertain items: an expression gave an error'
          : errored === 0
            ? "uncertain items: a measurement couldn't be used"
            : "uncertain items: an expression gave an error, and a measurement couldn't be used",
      );
    const empty = (): Outcome => (claim.vacuous === 'pass' ? { verdict: 'pass', shown: [] } : notKnown('nothing to check'));
    switch (claim.quantifier) {
      case 'every':
        if (failed.length > 0) return { verdict: 'fail', shown: failed };
        if (uncertain > 0) return uncertainItems();
        if (!met) return notKnown('coverage not met');
        if (vacuous) return empty();
        return { verdict: 'pass', shown: [] };
      case 'some':
        if (held.length > 0) return { verdict: 'pass', shown: held };
        if (uncertain > 0) return uncertainItems();
        if (!met) return notKnown('coverage not met');
        return { verdict: 'fail', shown: [] };
      case 'none':
        if (held.length > 0) return { verdict: 'fail', shown: held };
        if (uncertain > 0) return uncertainItems();
        if (!met) return notKnown('coverage not met');
        if (vacuous) return empty();
        return { verdict: 'pass', shown: [] };
      case 'count': {
        if (!met) return notKnown('coverage not met');
        // The count rule over every count the uncertain items allow: each may be inside the claim or not.
        const answers = new Set<Truth>();
        for (let n = held.length; n <= held.length + uncertain; n++) answers.add(evaluate(compiled.count as CompiledExpression, { n }));
        if (answers.has('error')) return notKnown('the count rule gave an error');
        if (answers.size > 1) return uncertainItems();
        return answers.has('true') ? { verdict: 'pass', shown: [] } : { verdict: 'fail', shown: [] };
      }
    }
  }
}

/**
 * What to add: each of the claim's `needs` the run doesn't meet, as `input:<name>`, `effect:<class>` and
 * `kind:<kind>`, in that order (docs/FOUNDATION.md §4; docs/ALGORITHMS.md E2).
 */
function unmet(needs: Needs | undefined, input: JudgeInput): string[] {
  if (needs === undefined) return [];
  const add: string[] = [];
  const inputs = input.inputs ?? {};
  for (const name of needs.inputs ?? []) if (!Object.hasOwn(inputs, name)) add.push(`input:${name}`);
  const allowed = input.supplies?.effect ?? 'observe';
  if (needs.effect !== undefined && EFFECTS.indexOf(needs.effect) > EFFECTS.indexOf(allowed)) add.push(`effect:${needs.effect}`);
  const kinds = input.supplies?.kinds ?? [];
  for (const kind of needs.kinds) if (!kinds.includes(kind)) add.push(`kind:${kind}`);
  return add;
}

function blockedBy(first: string): Reason {
  if (first.startsWith('input:')) return 'an input is missing';
  if (first.startsWith('effect:')) return 'an effect it needs is not allowed';
  return 'no collector records a kind it needs';
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
 * docs/ALGORITHMS.md A8, over the facts read and, through `from`, every fact among those given that they were derived
 * from. A fact that lists withheld fields makes the verdict `measured`: the judge does not yet tell which fields an
 * expression reads, so it takes the cautious answer.
 */
function depth(read: readonly PlacedFact[], given: readonly PlacedFact[]): Verdict['depth'] {
  const bySeq = new Map(given.map(({ seq, fact }) => [seq, fact]));
  const rests: Fact[] = [];
  const seen = new Set<number>();
  const queue = read.map(({ seq }) => seq);
  while (queue.length > 0) {
    const seq = queue.pop() as number;
    const fact = bySeq.get(seq);
    if (seen.has(seq) || fact === undefined) continue;
    seen.add(seq);
    rests.push(fact);
    queue.push(...(fact.from ?? []));
  }
  if (rests.some((fact) => (fact.withheld?.length ?? 0) > 0)) return 'measured';
  if (rests.some((fact) => fact.from !== undefined)) return 'derived';
  return 'facts';
}

/** What a run concluded: fail if any verdict fails, otherwise not known if any is not a pass, otherwise pass. */
export type Conclusion = 'pass' | 'fail' | 'not_known';

/** The fold (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A5). An empty set never passes. */
export function fold(verdicts: readonly string[]): Conclusion {
  if (verdicts.length === 0) return 'not_known';
  if (verdicts.includes('fail')) return 'fail';
  if (verdicts.some((v) => v !== 'pass')) return 'not_known';
  return 'pass';
}

/** The part of the seal's result that verify recomputes from the verdict records: the conclusion and over how many. */
export type SealResult = { verdict: Conclusion; verdicts: number };

export function sealResult(verdicts: readonly string[]): SealResult {
  return { verdict: fold(verdicts), verdicts: verdicts.length };
}
