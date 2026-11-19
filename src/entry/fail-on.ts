// SPDX-License-Identifier: AGPL-3.0-only
// --fail-on <severity> on the new path (docs/FOUNDATION.md §4, "The fold"): it adds the claim "no confirmed finding at
// or above <severity>", a `set` claim over `finding` facts. The claim is data, one file per severity in src/claims
// (§14), recorded verbatim, loaded with its examples and judged like any other claim; this module only records and
// judges it. The fold has no special case for it. A finding's body has `severity` and `state`; the facts it rests on
// are its envelope's `from`.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunRecorder } from '../engine/recorder.js';
import { loadClaim } from '../kernel/claim.js';
import type { PlacedFact } from '../kernel/fact.js';
import { type JudgeInput, type Verdict, claimRef, judgeClaim } from '../kernel/judge.js';
import type { FindingSeverity } from '../proof-core/findings.js';
import { nodeSha256 } from './fs-store.js';

/** The subject a run on a target is about. It is not named by digest yet. */
export const TARGET_SUBJECT = 'target';

/** The claim file for `--fail-on <severity>`, found from this module whether it runs from src/entry or from dist/entry. */
export function failOnClaimPath(severity: FindingSeverity): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../src/claims/fail-on-${severity}.json`);
}

export interface FailOnOptions {
  severity: FindingSeverity;
  /** The run's own subject. The claim is judged for it, and for every other subject a finding is about. */
  subject: string;
  /** The facts recorded so far that the claim may read. */
  facts: readonly PlacedFact[];
  /**
   * The collectors declared as recording findings, by the name their facts carry in `by`. The claim reads them as
   * `ctx.inputs.finders` and is covered only once each has closed complete about the subject: a declared finder that
   * never closed wrote no `collection` fact, so without this list its silence would read as nothing to see.
   */
  finders: readonly string[];
  supplies?: JudgeInput['supplies'];
}

/**
 * The subjects the claim is judged for: the run's own, then each other subject a `finding` fact is about, in ledger
 * order. A view has one subject (docs/FOUNDATION.md §4, "Views"), so a finding on any other subject is read only by a
 * verdict of its own; with one per subject, no confirmed finding is missed.
 */
export function failOnSubjects(subject: string, facts: readonly PlacedFact[]): string[] {
  const subjects = [subject];
  for (const { fact } of [...facts].sort((a, b) => a.seq - b.seq)) {
    if (fact.kind === 'finding' && !subjects.includes(fact.subject)) subjects.push(fact.subject);
  }
  return subjects;
}

/**
 * The facts the claim is handed from a bundle: every `finding` fact, whoever recorded it, so no confirmed finding is
 * missed; and the `collection` facts of `finders`, the collectors that record findings, alone, so that the claim's
 * coverage is theirs and another collector closing complete never stands in for a look for findings. The facts a
 * finding rests on, through `from`, come too: the claim's view does not read them, but its depth is worked out from
 * them, so a verdict on a derived finding is `derived` and not `measured`.
 */
export function failOnFacts(facts: readonly PlacedFact[], finders: readonly string[]): PlacedFact[] {
  const bySeq = new Map(facts.map((p) => [p.seq, p]));
  const kept = new Set<number>();
  const otherClosing = ({ fact }: PlacedFact) => fact.kind === 'collection' && !finders.includes(fact.by);
  const queue = facts.filter((p) => p.fact.kind === 'finding' || (p.fact.kind === 'collection' && !otherClosing(p))).map((p) => p.seq);
  while (queue.length > 0) {
    const seq = queue.pop() as number;
    const placed = bySeq.get(seq);
    // Another collector's closing never comes in, even through `from`: the view would read it as coverage.
    if (kept.has(seq) || placed === undefined || otherClosing(placed)) continue;
    kept.add(seq);
    queue.push(...(placed.fact.from ?? []));
  }
  return facts.filter((p) => kept.has(p.seq));
}

/**
 * Records the --fail-on claim through the recorder once, judges it for each of its subjects, records each verdict,
 * and returns them; the fold takes them like any others.
 */
export async function runFailOn(recorder: RunRecorder, options: FailOnOptions): Promise<Verdict[]> {
  const bytes = new Uint8Array(await readFile(failOnClaimPath(options.severity)));
  const loaded = await loadClaim(bytes, nodeSha256);
  await recorder.record('claim', { claim: claimRef(loaded.claim), rule: loaded.rule, file: new TextDecoder().decode(bytes) });
  const verdicts: Verdict[] = [];
  for (const subject of failOnSubjects(options.subject, options.facts)) {
    const verdict = judgeClaim(loaded, {
      subject,
      facts: options.facts,
      inputs: { finders: [...options.finders] },
      ...(options.supplies !== undefined ? { supplies: options.supplies } : {}),
    });
    await recorder.record('verdict', verdict);
    verdicts.push(verdict);
  }
  return verdicts;
}
