// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// The assertion ledger: one verdict with evidence per written assertion. A plan passes only when every assertion
// has a recorded pass; the verdict is computed from the entries, never taken from a model's overall impression.

import path from 'node:path';
import type { Box, EvidenceNode } from '../surfaces/session.js';
import type { Plan, Step } from './plan.js';

export type { Box, EvidenceNode } from '../surfaces/session.js';
export type Verdict = 'pass' | 'fail' | 'not_checked' | 'blocked' | 'unverified';
export type Method = 'code' | 'ai' | 'none';

export interface Evidence {
  /** Paths relative to the run folder. */
  screenshot?: string;
  crop?: string;
  nodes: EvidenceNode[];
  url?: string;
  capturedAt?: string;
  /** Why the screenshot may show a secret that could not be masked before capture. */
  unmasked?: string;
}

export interface AssertionEntry {
  kind: 'assertion';
  stepId: string;
  text: string;
  verdict: Verdict;
  method: Method;
  /** What was seen, in words. For code checks, what the check found. */
  observation: string;
  /** Why the verdict is not a plain pass or fail (blocked, unverified, not checked). */
  reason?: string;
  evidence?: Evidence;
  durationMs?: number;
}

export interface ActionLog {
  tool: string;
  /** Tool input with secrets masked. */
  input: Record<string, unknown>;
  /** A role/name locator for the element acted on, when there was one (used by exports). */
  locator?: string;
  ok: boolean;
  error?: string;
  /** Why the screenshot taken after this action may show a secret that could not be masked. */
  unmasked?: string;
}

export interface ActionEntry {
  kind: 'action';
  stepId: string;
  text: string;
  status: 'done' | 'failed' | 'blocked';
  summary: string;
  actions: ActionLog[];
  durationMs?: number;
}

export type LedgerEntry = AssertionEntry | ActionEntry;

export type PlanVerdict = 'pass' | 'fail' | 'error';

export interface PlanCounts {
  assertions: number;
  passed: number;
  failed: number;
  notChecked: number;
  blocked: number;
  unverified: number;
}

export interface PlanResult {
  planId: string;
  name: string;
  file?: string;
  verdict: PlanVerdict;
  counts: PlanCounts;
  entries: LedgerEntry[];
  /** A run-level problem (browser crash, model error) that ended the plan early. */
  error?: string;
  durationMs: number;
}

/**
 * A judge's raw opinion becomes a ledger verdict here. A "pass" counts only with an observation and at least one
 * cited node that resolved to something on the page: otherwise it is `unverified`, which fails the plan.
 */
export function settleJudgement(j: {
  verdict: 'pass' | 'fail';
  observation: string;
  nodes: EvidenceNode[];
  unresolvedRefs: string[];
}): { verdict: Verdict; reason?: string } {
  if (j.verdict === 'fail') return { verdict: 'fail' };
  if (!j.observation.trim()) return { verdict: 'unverified', reason: 'the judge passed it without saying what it saw' };
  if (j.nodes.length === 0) {
    const why = j.unresolvedRefs.length
      ? `the cited nodes (${j.unresolvedRefs.join(', ')}) are not in the observation`
      : 'the judge passed it without citing a node';
    return { verdict: 'unverified', reason: why };
  }
  return { verdict: 'pass' };
}

export class PlanLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private error: string | undefined;
  private blocked = false;

  constructor(readonly plan: Plan) {}

  private step(stepId: string, kind: Step['type']): Step {
    const step = this.plan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`ledger: no step "${stepId}" in plan "${this.plan.id}"`);
    if (step.type !== kind) throw new Error(`ledger: step "${stepId}" is an ${step.type}, not an ${kind}`);
    if (this.entries.has(stepId)) throw new Error(`ledger: step "${stepId}" already has an entry`);
    return step;
  }

  recordAssertion(e: Omit<AssertionEntry, 'kind' | 'text'>): AssertionEntry {
    const step = this.step(e.stepId, 'assertion');
    const entry: AssertionEntry = { kind: 'assertion', text: step.text, ...e };
    this.entries.set(e.stepId, entry);
    return entry;
  }

  recordAction(e: Omit<ActionEntry, 'kind' | 'text'>): ActionEntry {
    const step = this.step(e.stepId, 'action');
    const entry: ActionEntry = { kind: 'action', text: step.text, ...e };
    this.entries.set(e.stepId, entry);
    return entry;
  }

  has(stepId: string): boolean {
    return this.entries.has(stepId);
  }

  fail(error: string): void {
    this.error ??= error;
  }

  /** A missing input (a secret) stopped the plan: the assertions it didn't reach are `blocked` (FR-P5), not merely
   * not checked. The reason names what is missing, never a value. */
  block(reason: string): void {
    if (this.error === undefined) this.blocked = true;
    this.fail(reason);
  }

  /** Close the ledger: every step without an entry gets one, then the plan verdict is computed. */
  close(durationMs: number): PlanResult {
    const reason = this.error ? `not reached: ${this.error}` : 'not reached';
    const unreached = this.blocked ? 'blocked' : 'not_checked';
    const entries: LedgerEntry[] = this.plan.steps.map((s) => {
      const e = this.entries.get(s.id);
      if (e) return e;
      return s.type === 'assertion'
        ? { kind: 'assertion', stepId: s.id, text: s.text, verdict: unreached, method: 'none', observation: '', reason }
        : { kind: 'action', stepId: s.id, text: s.text, status: 'blocked', summary: reason, actions: [] };
    });
    const result: PlanResult = {
      planId: this.plan.id,
      name: this.plan.name,
      verdict: planVerdict(entries, this.error),
      counts: countEntries(entries),
      entries,
      durationMs,
    };
    if (this.plan.source.file) result.file = reportPath(this.plan.source.file);
    if (this.error) result.error = this.error;
    return result;
  }
}

export function countEntries(entries: LedgerEntry[]): PlanCounts {
  const c: PlanCounts = { assertions: 0, passed: 0, failed: 0, notChecked: 0, blocked: 0, unverified: 0 };
  for (const e of entries) {
    if (e.kind !== 'assertion') continue;
    c.assertions++;
    if (e.verdict === 'pass') c.passed++;
    else if (e.verdict === 'fail') c.failed++;
    else if (e.verdict === 'not_checked') c.notChecked++;
    else if (e.verdict === 'blocked') c.blocked++;
    else c.unverified++;
  }
  return c;
}

/**
 * PASS is the conjunction of recorded passes. Zero assertions never pass. A run-level error is `error` unless an
 * assertion already failed (a recorded failure is the stronger, more useful result).
 */
export function planVerdict(entries: LedgerEntry[], error?: string): PlanVerdict {
  const assertions = entries.filter((e): e is AssertionEntry => e.kind === 'assertion');
  if (assertions.some((a) => a.verdict === 'fail')) return 'fail';
  if (error) return 'error';
  if (assertions.length === 0) return 'fail';
  if (entries.some((e) => e.kind === 'action' && e.status !== 'done')) return 'fail';
  return assertions.every((a) => a.verdict === 'pass') ? 'pass' : 'fail';
}

export type RunVerdict = 'pass' | 'fail' | 'error';

export function runVerdict(plans: PlanResult[]): RunVerdict {
  if (plans.length === 0) return 'fail';
  if (plans.some((p) => p.verdict === 'error')) return 'error';
  return plans.every((p) => p.verdict === 'pass') ? 'pass' : 'fail';
}

/** CLI exit codes (SRS FR-C1): 0 pass, 1 fail, 2 plan or usage error, 3 blocked or environment. */
export function exitCodeFor(v: RunVerdict): 0 | 1 | 3 {
  return v === 'pass' ? 0 : v === 'fail' ? 1 : 3;
}

/** A plan file as reports record it: relative to the working directory with / separators, or the bare file name when
 * it lies outside, so a report never carries a local absolute path. */
export function reportPath(file: string, cwd = process.cwd()): string {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(file) : rel.split(path.sep).join('/');
}
