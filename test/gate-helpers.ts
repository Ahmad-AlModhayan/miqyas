// SPDX-License-Identifier: AGPL-3.0-only
// Shared fixtures for the gate's deciding tests: one run with an origin of every class.

import {
  grantsFromFile,
  grantsFromFlags,
  type Effect,
  type Grants,
  type ProbeFacts,
  type RunFacts,
  type WireRequest,
} from '../src/gate/decide/index.js';

/** The origins of the fixture run, one per class of environment. */
export const O = {
  sandbox: 'http://127.0.0.1:4100',
  local: 'http://127.0.0.1:3000',
  named: 'https://staging.example.com',
  owned: 'https://shop.example.com',
  other: 'https://stranger.example',
  /** Called by a page of the local test host. */
  backendOfLocal: 'https://db.example.net',
  /** Called by a page of the sandbox. */
  backendOfSandbox: 'https://db2.example.net',
  /** Called by a page of the stranger's site. */
  backendOfOther: 'https://tracker.example.net',
  /** A test host by name that is known to drive a live physical process. */
  physical: 'http://line-controller.test:502',
  /** Not an origin of the run at all. */
  unrelated: 'https://unrelated.example',
} as const;

export function world(over: Partial<RunFacts> = {}): RunFacts {
  return {
    targets: [O.sandbox, O.local, O.named, O.owned, O.other, O.physical],
    engineStarted: [{ origin: O.sandbox, onlyRouteOutIsGate: true }],
    // The owner of the owned host placed the token; nobody placed one on the named test host.
    ownershipTokenHosts: ['shop.example.com'],
    observedCalls: [
      { from: O.local, to: O.backendOfLocal },
      { from: O.sandbox, to: O.backendOfSandbox },
      { from: O.other, to: O.backendOfOther },
    ],
    spendingRoutes: [],
    seenToChange: [],
    knownReads: [],
    livePhysical: [O.physical],
    ...over,
  };
}

/** Every grant there is, and every host named: the strongest thing a person can say. */
export const everyGrant = (): Grants =>
  grantsFromFile({
    active: true,
    allowWrites: true,
    allowDisrupt: true,
    allowExec: true,
    allowHosts: ['shop.example.com', 'staging.example.com', 'stranger.example', 'line-controller.test'],
  });

export const grants = (...flags: string[]): Grants => grantsFromFlags(flags);

/** A probe that keeps every limit of the threat model. */
export const inertProbe: ProbeFacts = {
  inertMarkersOnly: true,
  identity: 'first-account',
  idsOwnedByTestAccounts: true,
  enumeratesIds: false,
  taggedWithRunId: true,
};

export const request = (r: WireRequest, permit: 'observe' | 'interact' | 'probe' | 'write' | 'disrupt', extra: object = {}): Effect => ({
  kind: 'request',
  request: r,
  session: { permit },
  ...extra,
});

/** A request a page sent. */
export const pageGet = (url: string, permit: 'observe' | 'interact' = 'observe'): Effect =>
  request({ method: 'GET', url, cause: 'page' }, permit);

/** A request a collector sent itself, with probe facts that keep every limit. */
export const probeSent = (
  method: string,
  url: string,
  permit: 'probe' | 'write' | 'disrupt',
  probe: Partial<ProbeFacts> | null = {},
  extra: Partial<WireRequest> = {},
): Effect =>
  request({ method, url, cause: 'collector', ...extra }, permit, probe === null ? {} : { probe: { ...inertProbe, ...probe } });
