// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { exitCodeFor, PlanLedger, reportPath, runVerdict, settleJudgement, type EvidenceNode, type PlanResult } from '../../src/proof-core/ledger.js';
import { parsePlan } from '../../src/proof-core/plan.js';

const plan = parsePlan(
  {
    format: 'miqyas-plan',
    version: 1,
    id: 'p',
    steps: [
      { id: 's1', type: 'action', text: 'Click Add' },
      { id: 'a1', type: 'assertion', text: 'Errors are listed' },
      { id: 's2', type: 'action', text: 'Click Back' },
      { id: 'a2', type: 'assertion', text: 'Folder pairs shows' },
    ],
  },
  'p',
);

const node: EvidenceNode = { ref: 'c1e1', role: 'alert', name: 'Missing: name', box: { x: 0, y: 0, width: 10, height: 10 } };
const pass = { verdict: 'pass' as const, method: 'ai' as const, observation: 'seen' };

function ledgerWith(a1: 'pass' | 'fail' | 'unverified' | null, a2: 'pass' | 'fail' | null = 'pass') {
  const l = new PlanLedger(plan);
  l.recordAction({ stepId: 's1', status: 'done', summary: 'clicked', actions: [] });
  if (a1) l.recordAssertion({ stepId: 'a1', ...pass, verdict: a1 });
  l.recordAction({ stepId: 's2', status: 'done', summary: 'clicked', actions: [] });
  if (a2) l.recordAssertion({ stepId: 'a2', ...pass, verdict: a2 });
  return l;
}

describe('ledger verdict rules', () => {
  it('passes only when every assertion has a recorded pass', () => {
    const r = ledgerWith('pass').close(1);
    expect(r.verdict).toBe('pass');
    expect(r.counts).toMatchObject({ assertions: 2, passed: 2 });
  });

  it('fails when one assertion is skipped (the TestSprite miss): not_checked counts as failure', () => {
    const r = ledgerWith(null).close(1);
    expect(r.verdict).toBe('fail');
    expect(r.entries.find((e) => e.stepId === 'a1')).toMatchObject({ verdict: 'not_checked', method: 'none' });
    expect(r.counts.notChecked).toBe(1);
  });

  it('fails on a recorded fail and on unverified', () => {
    expect(ledgerWith('fail').close(1).verdict).toBe('fail');
    expect(ledgerWith('unverified').close(1).verdict).toBe('fail');
  });

  it('fills unreached steps and fails when an action failed', () => {
    const l = new PlanLedger(plan);
    l.recordAction({ stepId: 's1', status: 'failed', summary: 'no Add button', actions: [] });
    const r = l.close(1);
    expect(r.verdict).toBe('fail');
    expect(r.entries.map((e) => (e.kind === 'action' ? e.status : e.verdict))).toEqual(['failed', 'not_checked', 'blocked', 'not_checked']);
  });

  it('blocks every assertion a missing secret kept it from reaching, naming the variable (FR-P5)', () => {
    const l = new PlanLedger(plan);
    l.recordAction({ stepId: 's1', status: 'blocked', summary: 'missing secret(s): MIQYAS_SECRET_PASS', actions: [] });
    l.block('blocked: MIQYAS_SECRET_PASS not set');
    const r = l.close(1);
    expect(r.entries.map((e) => (e.kind === 'action' ? e.status : e.verdict))).toEqual(['blocked', 'blocked', 'blocked', 'blocked']);
    expect(r.entries[1]).toMatchObject({ verdict: 'blocked', method: 'none', reason: 'not reached: blocked: MIQYAS_SECRET_PASS not set' });
    expect(r.counts).toMatchObject({ assertions: 2, blocked: 2, notChecked: 0 });
    expect(r.verdict).toBe('error');
    expect(exitCodeFor(runVerdict([r]))).toBe(3);
  });

  it('leaves unreached assertions not checked when another error ended the plan first', () => {
    const l = ledgerWith(null, null);
    l.fail('model error');
    l.block('blocked: MIQYAS_SECRET_PASS not set');
    const r = l.close(1);
    expect(r.error).toBe('model error');
    expect(r.counts).toMatchObject({ notChecked: 2, blocked: 0 });
  });

  it('is an error when the run broke before any assertion failed, a fail when one already had', () => {
    const l = new PlanLedger(plan);
    l.fail('browser crashed');
    expect(l.close(1)).toMatchObject({ verdict: 'error', error: 'browser crashed' });
    const l2 = ledgerWith('fail', null);
    l2.fail('model error');
    expect(l2.close(1).verdict).toBe('fail');
  });

  it('allows exactly one entry per step and checks step kinds', () => {
    const l = ledgerWith('pass');
    expect(() => l.recordAssertion({ stepId: 'a1', ...pass })).toThrow(/already/);
    expect(() => l.recordAssertion({ stepId: 's1', ...pass } as never)).toThrow(/action/);
    expect(() => l.recordAssertion({ stepId: 'zz', ...pass })).toThrow(/no step/);
  });

  it('never passes a plan with zero assertions', () => {
    const p = parsePlan({ format: 'miqyas-plan', version: 1, steps: [{ id: 's1', type: 'action', text: 'x' }] }, 'p');
    const l = new PlanLedger(p);
    l.recordAction({ stepId: 's1', status: 'done', summary: '', actions: [] });
    expect(l.close(1).verdict).toBe('fail');
  });
});

describe('settling a judgement', () => {
  it('keeps a pass with an observation and a resolved node', () => {
    expect(settleJudgement({ verdict: 'pass', observation: 'alert lists 3 items', nodes: [node], unresolvedRefs: [] })).toEqual({ verdict: 'pass' });
  });
  it('downgrades a pass without a cited node, or with unresolved refs only, to unverified', () => {
    expect(settleJudgement({ verdict: 'pass', observation: 'ok', nodes: [], unresolvedRefs: [] }).verdict).toBe('unverified');
    const r = settleJudgement({ verdict: 'pass', observation: 'ok', nodes: [], unresolvedRefs: ['c9e9'] });
    expect(r).toMatchObject({ verdict: 'unverified' });
    expect(r.reason).toMatch(/c9e9/);
  });
  it('downgrades a pass with no observation', () => {
    expect(settleJudgement({ verdict: 'pass', observation: ' ', nodes: [node], unresolvedRefs: [] }).verdict).toBe('unverified');
  });
  it('keeps a fail as a fail even without evidence', () => {
    expect(settleJudgement({ verdict: 'fail', observation: '', nodes: [], unresolvedRefs: [] }).verdict).toBe('fail');
  });
});

describe('run verdict and exit codes', () => {
  const r = (v: PlanResult['verdict']) => ({ verdict: v }) as PlanResult;
  it('combines plans', () => {
    expect(runVerdict([r('pass'), r('pass')])).toBe('pass');
    expect(runVerdict([r('pass'), r('fail')])).toBe('fail');
    expect(runVerdict([r('fail'), r('error')])).toBe('error');
    expect(runVerdict([])).toBe('fail');
  });
  it('maps to 0 pass, 1 fail, 3 environment', () => {
    expect([exitCodeFor('pass'), exitCodeFor('fail'), exitCodeFor('error')]).toEqual([0, 1, 3]);
  });
});

describe('reportPath', () => {
  const cwd = path.resolve('/work/miqyas');
  it('records a plan under the working directory relative, with / separators', () => {
    expect(reportPath(path.join(cwd, 'plans', 'wasl', '01-navigation.json'), cwd)).toBe('plans/wasl/01-navigation.json');
    expect(reportPath('plans/wasl/01-navigation.json', cwd)).toBe('plans/wasl/01-navigation.json');
  });
  it('keeps only the file name for a plan outside it, so no absolute path reaches a report', () => {
    expect(reportPath(path.resolve('/home/someone/private/plan.json'), cwd)).toBe('plan.json');
    expect(reportPath('../other/plan.json', cwd)).toBe('plan.json');
  });
});
