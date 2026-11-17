// SPDX-License-Identifier: AGPL-3.0-only
// Deciding (docs/ALGORITHMS.md B3): the deny rules, then the permit, then the ceiling of ADR 0008. The answer is a value a
// caller can record: the class found, the rule that decided, and the answer. Pure. The third step of B3, the stop and
// the rate of an origin, needs a clock and is not here.

import { CEILING, EFFECT_CLASSES, atLeast, type Cell, type EffectClass, type Need } from './classes.js';
import { DENY_RULES } from './deny.js';
import { targetOf, type Effect, type RunFacts } from './effects.js';
import { isIssuedGrants, noGrants, type Grants } from './grants.js';
import { classOfOrigin, type OriginClassification } from './origin.js';
import { classOfRequest } from './wire.js';

export interface Decision {
  readonly answer: 'allow' | 'refuse';
  /** The class found, or null for an effect that is not done to a target. */
  readonly effectClass: EffectClass | null;
  /**
   * `deny.<id>`, `permit.exceeded`, `ceiling.<class>.<environment>`, `allow.no-target` (page data sent to the model
   * call), `refuse.unknown-effect` (a kind the gate does not know) or `refuse.no-target` (a kind that lands on an
   * origin, handed in without one).
   */
  readonly rule: string;
  readonly environment: string | null;
  readonly origin: string | null;
  /** What a refusal by the ceiling lacked. Empty when nothing could have been granted. */
  readonly missing: readonly Need[];
  /** The rules of B1 that gave a request its class. */
  readonly reasons: readonly string[];
}

const CAPSULE_OPERATIONS: readonly string[] = ['capture', 'restore', 'fork'];

function classOfEffect(effect: Effect, run: RunFacts): { effectClass: EffectClass | null; reasons: readonly string[] } {
  switch (effect.kind) {
    case 'request': {
      const permit = (EFFECT_CLASSES as readonly string[]).includes(effect.session?.permit) ? effect.session.permit : 'observe';
      const c = classOfRequest(effect.request, { permit }, run);
      return { effectClass: c.effectClass, reasons: c.reasons };
    }
    case 'capsule':
      // An operation the gate does not know has no class, and is refused wherever it lands.
      return { effectClass: CAPSULE_OPERATIONS.includes(effect.operation) ? 'disrupt' : null, reasons: [] };
    case 'plant-seed':
      return { effectClass: 'disrupt', reasons: [] };
    case 'type-secret':
    case 'upload-file':
      return { effectClass: 'interact', reasons: [] };
    case 'get-past-challenge':
      return { effectClass: 'probe', reasons: [] };
    case 'run-code':
      return { effectClass: 'execute', reasons: [] };
    default:
      return { effectClass: null, reasons: [] };
  }
}

/** What an origin's cell asks for that grants and findings don't give: null when it is met, otherwise what is missing. */
function missingFor(cell: Cell, host: string, grants: Grants, run: RunFacts): readonly Need[] | 'never' {
  if (cell.kind === 'yes') return [];
  if (cell.kind !== 'needs') return 'never';
  return cell.needs.filter((n) => !holds(n, host, grants, run));
}

function holds(need: Need, host: string, grants: Grants, run: RunFacts): boolean {
  switch (need) {
    case 'active':
      return grants.active;
    case 'allow-writes':
      return grants.allowWrites;
    case 'allow-disrupt':
      return grants.allowDisrupt;
    case 'token':
      return run.ownershipTokenHosts.some((h) => h.toLowerCase() === host);
  }
}

function ceilingMissing(
  c: Exclude<EffectClass, 'execute'>,
  env: OriginClassification,
  cause: 'page' | 'other',
  grants: Grants,
  run: RunFacts,
): readonly Need[] | 'never' {
  const cell = CEILING[c][env.environment];
  if (cell.kind === 'through-the-page') return cause === 'page' ? [] : 'never';
  if (cell.kind !== 'as-calling-origin') return missingFor(cell, env.host, grants, run);
  // A backend takes its consent from every origin of the run that calls it, and from --allow-writes as well where the cell says so.
  if (env.callers.length === 0) return 'never';
  const missing: Need[] = [];
  for (const caller of env.callers) {
    // The sandbox is not the backend: it may be production. A backend of a sandbox is held to a local test host's terms.
    const as = caller.environment === 'sandbox' ? 'local-test-host' : caller.environment;
    const m = missingFor(CEILING[c][as], caller.host, grants, run);
    if (m === 'never') return 'never';
    for (const n of m) if (!missing.includes(n)) missing.push(n);
  }
  for (const n of cell.also) if (!holds(n, env.host, grants, run) && !missing.includes(n)) missing.push(n);
  return missing;
}

/**
 * Decide an effect (B3). A deny rule refuses first, whatever was granted. Then the permit: a class above what the
 * collector holds is refused, except that a page's own request under an interact permit is a person using the
 * product. Then the ceiling table. Grants that no builder issued grant nothing.
 */
export function decide(effect: Effect, run: RunFacts, grantsIn: Grants): Decision {
  const grants = isIssuedGrants(grantsIn) ? grantsIn : noGrants();
  const { effectClass, reasons } = classOfEffect(effect, run);
  const target = targetOf(effect);
  const env = target === undefined ? null : classOfOrigin(target, run, grants);
  const base = { effectClass, environment: env?.environment ?? null, origin: env === null ? null : env.origin, reasons };
  const refuse = (rule: string, missing: readonly Need[] = []): Decision => ({ answer: 'refuse', rule, missing, ...base });
  const allow = (rule: string): Decision => ({ answer: 'allow', rule, missing: [], ...base });

  const ctx = { effect, effectClass, env, run };
  for (const rule of DENY_RULES) if (rule.matches(ctx)) return refuse(rule.id);

  if (effect.kind === 'run-code') {
    const k = effect.containment ?? {};
    if (k.startedByEngine === true && k.noNetwork === true && k.readOnlyRepository === true) return allow('ceiling.execute.container');
    return grants.allowExec ? allow('ceiling.execute.allow-exec') : refuse('ceiling.execute.refused');
  }
  // Only page data sent to the model call lands on no origin by design. A kind the gate does not know, and a kind that
  // lands on an origin but arrives without one, are refused: an untyped caller can hand in either.
  if (effect.kind === 'send-page-data') return allow('allow.no-target');
  if (effectClass === null) return refuse('refuse.unknown-effect');
  if (env === null) return refuse('refuse.no-target');

  if (effect.kind === 'request') {
    const permit = (EFFECT_CLASSES as readonly string[]).includes(effect.session?.permit) ? effect.session.permit : 'observe';
    const byPerson = effect.request.cause === 'page' && permit === 'interact' && !atLeast(effectClass, 'disrupt');
    if (!byPerson && !atLeast(permit, effectClass)) return refuse('permit.exceeded');
  }
  if (effectClass === 'execute') return refuse('ceiling.execute.refused');

  const rule = `ceiling.${effectClass}.${env.environment}`;
  const cause = effect.kind === 'request' && effect.request.cause === 'page' ? 'page' : 'other';
  const missing = ceilingMissing(effectClass, env, cause, grants, run);
  if (missing === 'never') return refuse(rule);
  return missing.length === 0 ? allow(rule) : refuse(rule, missing);
}
