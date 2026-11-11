// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { describe, expect, it } from 'vitest';
import { lintPlan, parsePlan, PlanError, resolveSecrets, serializePlan } from '../../src/core/plan.js';

const testsprite = {
  projectId: 'PROJECT_ID',
  type: 'frontend',
  name: 'Remove a pair',
  planSteps: [
    { type: 'action', description: "Open the app's home page" },
    { type: 'action', description: "Click 'Remove pair'" },
    { type: 'assertion', description: 'A confirmation dialog appears' },
    { type: 'action', description: 'Cancel the dialog' },
    { type: 'assertion', description: "The 'Music' card is still listed" },
  ],
};

describe('plan parsing', () => {
  it('imports a TestSprite plan one to one, dropping projectId and assigning ids', () => {
    const p = parsePlan(testsprite, '04-remove-pair');
    expect(p.id).toBe('04-remove-pair');
    expect(p.source.kind).toBe('testsprite');
    expect(p.derivedIds).toBe(true);
    expect(p.steps.map((s) => s.id)).toEqual(['s1', 's2', 'a1', 's3', 'a2']);
    expect(p.steps[2]).toEqual({ id: 'a1', type: 'assertion', text: 'A confirmation dialog appears' });
    expect(serializePlan(p)).not.toContain('PROJECT_ID');
  });

  it('keeps stored ids stable when a step is inserted', () => {
    const stored = JSON.parse(serializePlan(parsePlan(testsprite, 'x')));
    stored.steps.splice(1, 0, { type: 'assertion', text: 'The home page shows Folder pairs' });
    const p = parsePlan(stored, 'x');
    expect(p.steps.map((s) => s.id)).toEqual(['s1', 'a3', 's2', 'a1', 's3', 'a2']);
  });

  it('round-trips a native plan with a deterministic check', () => {
    const native = {
      format: 'miqyas-plan',
      version: 1,
      id: 'p',
      surface: 'web',
      steps: [
        { id: 's1', type: 'action', text: 'Click Add' },
        { id: 'a1', type: 'assertion', text: 'An alert shows', check: { locator: { role: 'alert' }, expect: 'visible' } },
      ],
    };
    const p = parsePlan(native, 'fallback');
    expect(p.derivedIds).toBe(false);
    expect(parsePlan(JSON.parse(serializePlan(p)), 'fallback')).toEqual(p);
  });

  it.each([
    [{ format: 'nope', version: 1, steps: [] }, /format/],
    [{ format: 'miqyas-plan', version: 2, steps: [{ type: 'action', text: 'x' }] }, /version/],
    [{ format: 'miqyas-plan', version: 1, steps: [] }, /at least one step/],
    [{ format: 'miqyas-plan', version: 1, steps: [{ type: 'click', text: 'x' }] }, /type/],
    [{ format: 'miqyas-plan', version: 1, steps: [{ type: 'action', text: '  ' }] }, /needs text/],
    [{ format: 'miqyas-plan', version: 1, steps: [{ id: 'a', type: 'action', text: 'x' }, { id: 'a', type: 'assertion', text: 'y' }] }, /duplicate/],
    [{ format: 'miqyas-plan', version: 1, steps: [{ type: 'action', text: 'x', check: { locator: { role: 'x' }, expect: 'visible' } }] }, /only assertions/],
    [{ format: 'miqyas-plan', version: 1, steps: [{ type: 'assertion', text: 'x', check: { locator: {}, expect: 'visible' } }] }, /locator needs/],
    [{ projectId: 'p', type: 'backend', planSteps: [{ type: 'action', description: 'x' }] }, /frontend only/],
  ])('rejects invalid plan %#', (raw, msg) => {
    expect(() => parsePlan(raw, 'f')).toThrow(PlanError);
    expect(() => parsePlan(raw, 'f')).toThrow(msg);
  });
});

describe('lint', () => {
  it('makes a plan without assertions an error', () => {
    const p = parsePlan({ format: 'miqyas-plan', version: 1, steps: [{ id: 's1', type: 'action', text: 'Click' }] }, 'p');
    expect(lintPlan(p).filter((i) => i.level === 'error').map((i) => i.message)).toEqual(['the plan has no assertion']);
  });

  it('warns about derived ids and a trailing action', () => {
    const p = parsePlan({ ...testsprite, planSteps: [...testsprite.planSteps, { type: 'action', description: 'Click Back' }] }, 'p');
    expect(lintPlan(p).map((i) => i.level)).toEqual(['warning', 'warning']);
  });

  it('refuses secrets in assertions', () => {
    const p = parsePlan({ format: 'miqyas-plan', version: 1, steps: [{ id: 'a1', type: 'assertion', text: 'Shows ${secret.pass}' }] }, 'p');
    expect(lintPlan(p).some((i) => i.level === 'error' && /secret/.test(i.message))).toBe(true);
  });
});

describe('secrets', () => {
  it('resolves from MIQYAS_SECRET_* and reports a missing one', () => {
    expect(resolveSecrets('type ${secret.vault}', { MIQYAS_SECRET_vault: 'horse' })).toBe('type horse');
    expect(resolveSecrets('type ${secret.vault}', {})).toBeUndefined();
    expect(resolveSecrets('no secrets', {})).toBe('no secrets');
  });
});
