// SPDX-License-Identifier: AGPL-3.0-only
// The deny rules: the never-do lines of docs/threat-model.md, with the ones the foundation rewords or adds. A deny
// rule is checked before the ceiling and no grant overrides it. Each has a stable id.

import { atLeast, type EffectClass } from './classes.js';
import type { Effect, LoginAttempt, RunFacts } from './effects.js';
import { isReadableOrigin, originOf, originsOfTheRun, type OriginClassification } from './origin.js';

/** What a rule is judged on. */
export interface DenyContext {
  readonly effect: Effect;
  /** The class found, or null for an effect that is not done to a target. */
  readonly effectClass: EffectClass | null;
  /** Set when the effect lands on an origin. */
  readonly env: OriginClassification | null;
  readonly run: RunFacts;
  /** The rules of B1 that gave a request its class; empty for any other effect. */
  readonly reasons: readonly string[];
}

export interface DenyRule {
  readonly id: string;
  /** The line of the threat model, or of the foundation's additions to it, that the rule comes from. */
  readonly source: string;
  readonly matches: (ctx: DenyContext) => boolean;
}

const writeOrMore = (ctx: DenyContext) => ctx.effectClass !== null && atLeast(ctx.effectClass, 'write');
const probeOrMore = (ctx: DenyContext) => ctx.effectClass !== null && atLeast(ctx.effectClass, 'probe');
// A form a plan step submits is an interact, and still changes what it is sent to. Where a rule holds whatever the
// class, it counts as a write.
const mayWrite = (ctx: DenyContext) => writeOrMore(ctx) || ctx.reasons.includes('wire.unsafe-method-plan-step');

function inTheRun(env: OriginClassification, run: RunFacts): boolean {
  const own = originsOfTheRun(run);
  if (env.origin === '') return false;
  return own.has(env.origin) || run.observedCalls.some((c) => originOf(c.to) === env.origin && own.has(originOf(c.from) ?? ''));
}

/** A request a collector sent itself, off a sandbox: Miqyas's own probe. */
function ownProbe(ctx: DenyContext): Extract<Effect, { kind: 'request' }> | null {
  const e = ctx.effect;
  if (e.kind !== 'request' || e.request.cause === 'page') return null;
  if (ctx.env === null || ctx.env.environment === 'sandbox') return null;
  return e;
}

// In the order they are checked. A rule that binds in a sandbox says so; the limits on probes do not.
export const DENY_RULES: readonly DenyRule[] = [
  {
    // First, so that a refusal names the cause the person can fix: the list they wrote, not the origin.
    id: 'deny.live-physical-unreadable',
    source:
      'never write to or disrupt a live physical process, whatever the flags and whoever owns it: an entry that cannot be read as an origin could be any origin',
    matches: (c) => mayWrite(c) && !c.run.livePhysical.every(isReadableOrigin),
  },
  {
    id: 'deny.leave-the-run',
    source: 'never leave the set of origins the run is about: the target’s origin and the backends its own pages call',
    matches: (c) => c.env !== null && !inTheRun(c.env, c.run),
  },
  {
    id: 'deny.foreign-origin-active',
    source:
      'never probe, write to or disrupt an origin that isn’t a sandbox, a test host, an owned host or the backend of one',
    matches: (c) =>
      c.env !== null &&
      probeOrMore(c) &&
      (c.env.environment === 'other' ||
        (c.env.environment === 'backend' && c.env.callers.some((x) => x.environment === 'other'))),
  },
  {
    id: 'deny.live-physical-process',
    source: 'never write to or disrupt a live physical process, whatever the flags and whoever owns it',
    matches: (c) => c.env !== null && mayWrite(c) && c.run.livePhysical.some((p) => originOf(p) === c.env?.origin),
  },
  {
    id: 'deny.capsule-outside-sandbox',
    source: 'capturing, restoring and forking are refused on any origin that isn’t a sandbox, whatever was granted',
    matches: (c) => c.effect.kind === 'capsule' && c.env?.environment !== 'sandbox',
  },
  {
    id: 'deny.seed-outside-public-corpus',
    source: 'seeds are planted only in copies of the public corpus',
    matches: (c) => c.effect.kind === 'plant-seed' && c.effect.subject !== 'public-corpus-copy',
  },
  {
    id: 'deny.brute-force-login',
    source: 'never brute-force a login',
    matches: (c) => {
      if (c.effect.kind !== 'request') return false;
      const a: unknown = c.effect.loginAttempt;
      if (a === 'not-a-login') return false;
      // Saying nothing is not known to keep the limit: refused on Miqyas's own probes off a sandbox.
      if (a === undefined) return ownProbe(c) !== null;
      if (typeof a !== 'object' || a === null) return true;
      const attempt = a as Partial<LoginAttempt>;
      return attempt.secret !== 'named-by-step' || attempt.distinctSecretsTriedOnAccount !== 1;
    },
  },
  {
    id: 'deny.get-past-challenge',
    source: 'never get past a CAPTCHA or WAF (it stops and reports instead)',
    matches: (c) => c.effect.kind === 'get-past-challenge',
  },
  {
    id: 'deny.upload-unnamed-file',
    source: 'never upload a file no plan names',
    matches: (c) => c.effect.kind === 'upload-file' && c.effect.namedByPlan !== true,
  },
  {
    id: 'deny.run-page-or-model-code',
    source: 'never run page or model code in Node',
    matches: (c) => c.effect.kind === 'run-code' && c.effect.source !== 'target',
  },
  {
    id: 'deny.send-page-data',
    source: 'never send page data anywhere but the scrubbed model call',
    matches: (c) => c.effect.kind === 'send-page-data' && c.effect.to !== 'scrubbed-model-call',
  },
  {
    id: 'deny.type-unnamed-secret',
    source: 'never type a secret the step doesn’t name',
    matches: (c) => c.effect.kind === 'type-secret' && c.effect.namedByStep !== true,
  },
  {
    id: 'deny.probe-not-inert',
    source: 'Miqyas’s own probes send inert markers only, on every origin that isn’t a sandbox',
    matches: (c) => {
      const own = ownProbe(c);
      return own !== null && own.probe?.inertMarkersOnly !== true;
    },
  },
  {
    id: 'deny.second-account-writes',
    source: 'the second account only reads, on every origin that isn’t a sandbox',
    matches: (c) => {
      const own = ownProbe(c);
      return own !== null && writeOrMore(c) && own.probe?.identity !== 'first-account';
    },
  },
  {
    id: 'deny.probe-foreign-ids',
    source: 'a probe uses only ids the test accounts own, with no enumeration, on every origin that isn’t a sandbox',
    matches: (c) => {
      const own = ownProbe(c);
      return own !== null && (own.probe?.idsOwnedByTestAccounts !== true || own.probe?.enumeratesIds !== false);
    },
  },
  {
    id: 'deny.probe-untagged',
    source: 'what a target stores is tagged miqyas-probe-<run id>, on every origin that isn’t a sandbox',
    matches: (c) => {
      const own = ownProbe(c);
      return own !== null && writeOrMore(c) && own.probe?.taggedWithRunId !== true;
    },
  },
];
