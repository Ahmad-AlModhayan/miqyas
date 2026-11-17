// SPDX-License-Identifier: AGPL-3.0-only
// What can be put to the gate to decide, and the facts it is decided against. Plain data. Every field here is
// established by code that is not the page, a plan or a model: the gate never takes a caller's word for a class,
// and a missing fact is read as the answer that refuses.

import type { EffectClass } from './classes.js';
import type { OriginFacts } from './origin.js';
import type { RouteFacts, WireRequest } from './wire.js';

/** What the gate knows about a run: its origins, its routes, and which origins drive a live physical process. */
export interface RunFacts extends OriginFacts, RouteFacts {
  /** Origins known to drive a live physical process. Nothing is written to or disrupted there, whatever the flags. */
  readonly livePhysical: readonly string[];
}

/** The limits on Miqyas's own probes (threat model, "What Miqyas may do to a target"). */
export interface ProbeFacts {
  /** The probe sends inert markers only. */
  readonly inertMarkersOnly: boolean;
  /** Which account sent it. The second account only reads. */
  readonly identity: 'first-account' | 'second-account';
  /** Every id it uses is one the test accounts own. */
  readonly idsOwnedByTestAccounts: boolean;
  /** It goes through ids to find some. */
  readonly enumeratesIds: boolean;
  /** What it makes the target store is tagged `miqyas-probe-<run id>`. */
  readonly taggedWithRunId: boolean;
}

export interface LoginAttempt {
  /** The secret is one a step names, not one the gate or a collector made up or took from a list. */
  readonly secret: 'named-by-step' | 'not-named';
  /** How many different secrets have been tried on this account, this one included. Only 1 keeps the limit. */
  readonly distinctSecretsTriedOnAccount: number;
}

export interface Containment {
  readonly startedByEngine: boolean;
  readonly noNetwork: boolean;
  readonly readOnlyRepository: boolean;
}

export type Effect =
  | {
      readonly kind: 'request';
      readonly request: WireRequest;
      /** The permit the collector holds. */
      readonly session: { readonly permit: EffectClass };
      /** Present on what a collector sends itself. A request without it is not known to keep the limits and is refused off a sandbox. */
      readonly probe?: ProbeFacts;
      /**
       * A login attempt, or `'not-a-login'` when the request is not one. On what a collector sends itself, a request
       * that says neither is not known to keep the limit and is refused off a sandbox.
       */
      readonly loginAttempt?: LoginAttempt | 'not-a-login';
    }
  | { readonly kind: 'capsule'; readonly operation: 'capture' | 'restore' | 'fork'; readonly origin: string }
  | { readonly kind: 'plant-seed'; readonly subject: 'public-corpus-copy' | 'other'; readonly origin: string }
  | { readonly kind: 'run-code'; readonly source: 'target' | 'page' | 'model'; readonly containment?: Partial<Containment> }
  | { readonly kind: 'send-page-data'; readonly to: 'scrubbed-model-call' | 'elsewhere' }
  | { readonly kind: 'type-secret'; readonly origin: string; readonly namedByStep: boolean }
  | { readonly kind: 'upload-file'; readonly origin: string; readonly namedByPlan: boolean }
  | { readonly kind: 'get-past-challenge'; readonly origin: string; readonly challenge: 'captcha' | 'waf' };

/** The origin an effect lands on, as a URL or an origin; undefined when it has none. */
export function targetOf(effect: Effect): string | undefined {
  switch (effect.kind) {
    case 'request':
      return effect.request.url;
    case 'capsule':
    case 'plant-seed':
    case 'type-secret':
    case 'upload-file':
    case 'get-past-challenge':
      return effect.origin;
    default:
      return undefined;
  }
}
