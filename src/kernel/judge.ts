// SPDX-License-Identifier: AGPL-3.0-only
// The judge for a `set` claim, and the fold (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A1 and A5, ADR 0006). The
// judge is a pure function of a loaded claim and the facts in its view: no clock, no randomness, no input or output.
// It gives the whole verdict record, with the facts it read, the items it showed and the coverage it saw; nothing
// else assembles a verdict. So far it judges the `none` quantifier only, without `where` or `usable`: the loader
// refuses a claim that uses anything else, and the rest of A1 comes with the judge in full.
import { type CompiledExpression, evaluate } from './cel.js';
import type { PlacedFact } from './fact.js';
import type { Json } from './ledger.js';

export const QUANTIFIERS = ['none'] as const;
export type Quantifier = (typeof QUANTIFIERS)[number];

export const VERDICTS = ['pass', 'fail', 'not_checked', 'blocked', 'unverified'] as const;
export type VerdictValue = (typeof VERDICTS)[number];

/** A `set` claim as its file states it (docs/FOUNDATION.md §4). */
export type SetClaim = {
  id: string;
  version: number;
  title: string;
  view: { kinds: string[]; by?: string[] };
  shape: 'set';
  quantifier: Quantifier;
  from: string;
  holds: string;
  covered: string;
  vacuous?: 'pass' | 'not_checked';
};

/** How a verdict names its claim: `id@version`. */
export function claimRef(claim: Pick<SetClaim, 'id' | 'version'>): string {
  return `${claim.id}@${claim.version}`;
}

/** A claim that loaded: its rules compiled, its file's digest, and the failing example that showed it can fail. */
export interface LoadedClaim {
  claim: SetClaim;
  /** SHA-256 of the claim file's bytes, in hex. */
  rule: string;
  compiled: { holds: CompiledExpression; covered: CompiledExpression };
  /** The name of the example on which the claim gave `fail`. */
  failedOn: string;
}

export interface JudgeInput {
  /** The subject the view is about; the engine fills it in (docs/FOUNDATION.md §4, "Views"). */
  subject: string;
  /** The facts recorded so far. The judge keeps those its view names, and reads nothing else. */
  facts: readonly PlacedFact[];
  /** The run's inputs by name, for `ctx.inputs`. */
  inputs?: { [name: string]: Json };
}

/** The verdict record's body (docs/FOUNDATION.md §4, "Evidence"). */
export type Verdict = {
  claim: string;
  rule: string;
  view: { subject: string; kinds: string[]; by?: string[] };
  verdict: VerdictValue;
  reason?: string;
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

/** Judges a `set` claim over the facts in its view (docs/ALGORITHMS.md A1, the `none` quantifier). */
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

  const held: number[] = [];
  const failed: number[] = [];
  let uncertain = 0;
  for (const { seq, fact } of inView) {
    if (fact.kind !== claim.from) continue;
    const holds = evaluate(compiled.holds, { item: fact.body });
    if (holds === 'true') held.push(seq);
    else if (holds === 'false') failed.push(seq);
    else uncertain++;
  }

  const ctx = { collections: collections(inView), inputs: input.inputs ?? {} };
  const met = evaluate(compiled.covered, { ctx }) === 'true'; // an error is not covered

  const outcome = decide();
  return {
    claim: claimRef(claim),
    rule: loaded.rule,
    view: { subject: input.subject, kinds: [...claim.view.kinds], ...(claim.view.by ? { by: [...claim.view.by] } : {}) },
    verdict: outcome.verdict,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    items: { held: held.length, failed: failed.length, outside: 0, uncertain },
    read: inView.map(({ seq }) => seq),
    shown: outcome.shown,
    coverage: { rule: claim.covered, met, saw: ctx },
    ...(outcome.vacuous ? { vacuous: true } : {}),
    depth: depth(inView),
    assurance: 'tested',
    basis: 'rule',
    failed_on: loaded.failedOn,
  };

  function decide(): { verdict: VerdictValue; reason?: string; shown: number[]; vacuous?: boolean } {
    const notKnown = (reason: string) => ({ verdict: 'not_checked' as const, reason, shown: [] });
    if (held.length > 0) return { verdict: 'fail', shown: held };
    if (uncertain > 0) return notKnown('uncertain items: an expression gave an error');
    if (!met) return notKnown('coverage not met');
    if (failed.length === 0) {
      return claim.vacuous === 'pass' ? { verdict: 'pass', shown: [], vacuous: true } : { ...notKnown('nothing to check'), vacuous: true };
    }
    return { verdict: 'pass', shown: [] };
  }
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
 * docs/ALGORITHMS.md A8, over the facts read. A fact that lists withheld fields makes the verdict `measured`: the judge
 * does not yet tell which fields an expression reads, so it takes the cautious answer.
 */
function depth(read: readonly PlacedFact[]): Verdict['depth'] {
  if (read.some(({ fact }) => (fact.withheld?.length ?? 0) > 0)) return 'measured';
  if (read.some(({ fact }) => fact.from !== undefined)) return 'derived';
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
