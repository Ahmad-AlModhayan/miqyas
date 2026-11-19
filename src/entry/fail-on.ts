// SPDX-License-Identifier: AGPL-3.0-only
// --fail-on <severity> on the new path (docs/FOUNDATION.md §4, "The fold"): it adds the claim "no confirmed finding at
// or above <severity>", a `set` claim over `finding` facts, built from the severity, loaded with its examples and judged
// like any other claim. The fold has no special case for it. A finding's body has `severity` and `state`; the facts it
// rests on are its envelope's `from`.
import type { RunRecorder } from '../engine/recorder.js';
import { loadClaim } from '../kernel/claim.js';
import type { PlacedFact } from '../kernel/fact.js';
import { type JudgeInput, type Verdict, claimRef, judgeClaim } from '../kernel/judge.js';
import { nodeSha256 } from './fs-store.js';

/** A finding's severities, least first. */
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The subject a run on a target is about. It is not named by digest yet. */
export const TARGET_SUBJECT = 'target';

const finding = (severity: Severity, state: 'confirmed' | 'unconfirmed') => ({ kind: 'finding', by: 'example', body: { severity, state } });
const collection = (status: 'complete' | 'failed') => ({ kind: 'collection', by: 'example', body: { status } });

/**
 * The claim file for `--fail-on <severity>`. It needs a collector that records findings; its coverage is that every
 * collector in its view closed complete, and then no finding at all is a pass.
 */
export function failOnClaimFile(severity: Severity) {
  const at = SEVERITIES.indexOf(severity);
  const below = SEVERITIES[at - 1];
  return {
    id: `fail-on.${severity}`,
    version: 1,
    title: `no confirmed finding at or above ${severity}`,
    needs: { kinds: ['finding'] },
    view: { kinds: ['finding', 'collection'] },
    shape: 'set',
    quantifier: 'none',
    from: 'finding',
    where: `item.severity in ${JSON.stringify(SEVERITIES.slice(at))}`,
    holds: 'item.state == "confirmed"',
    covered: 'ctx.collections.size() > 0 && ctx.collections.all(by, ctx.collections[by].status == "complete")',
    vacuous: 'pass',
    examples: [
      { name: `a confirmed ${severity} finding`, expect: 'fail', facts: [finding(severity, 'confirmed'), collection('complete')] },
      {
        name: `an unconfirmed ${severity} finding${below === undefined ? '' : `, and a confirmed ${below} one`}`,
        expect: 'pass',
        facts: [finding(severity, 'unconfirmed'), ...(below === undefined ? [] : [finding(below, 'confirmed')]), collection('complete')],
      },
      { name: 'a collector that did not finish', expect: 'not_checked', facts: [finding(severity, 'unconfirmed'), collection('failed')] },
    ],
  };
}

export interface FailOnOptions {
  severity: Severity;
  subject: string;
  /** The facts recorded so far that the claim may read. */
  facts: readonly PlacedFact[];
  supplies?: JudgeInput['supplies'];
}

/** Records the --fail-on claim through the recorder, judges it, records the verdict, and returns it. */
export async function runFailOn(recorder: RunRecorder, options: FailOnOptions): Promise<Verdict> {
  const file = JSON.stringify(failOnClaimFile(options.severity));
  const loaded = await loadClaim(new TextEncoder().encode(file), nodeSha256);
  await recorder.record('claim', { claim: claimRef(loaded.claim), rule: loaded.rule, file });
  const verdict = judgeClaim(loaded, {
    subject: options.subject,
    facts: options.facts,
    ...(options.supplies !== undefined ? { supplies: options.supplies } : {}),
  });
  await recorder.record('verdict', verdict);
  return verdict;
}
