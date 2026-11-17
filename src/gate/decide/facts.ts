// SPDX-License-Identifier: AGPL-3.0-only
// Building the run facts for a caller. Every entry the gate cannot read is reported, so the person who wrote it can be
// told, and nothing is dropped or mended: the gate reads an unreadable fact as the answer that refuses. Pure.

import type { RunFacts } from './effects.js';
import { isReadableOrigin } from './origin.js';
import { isReadableRoute } from './wire.js';

/** The lists of the run facts, in the order they are reported. */
export const RUN_FACT_LISTS: readonly (keyof RunFacts)[] = [
  'targets',
  'engineStarted',
  'ownershipTokenHosts',
  'observedCalls',
  'spendingRoutes',
  'seenToChange',
  'knownReads',
  'livePhysical',
];

export interface UnreadableFact {
  /** The list it is in, or null when the facts as a whole are not an object. */
  readonly list: keyof RunFacts | null;
  /** Its place in the list, or null when the list itself is missing or not a list. */
  readonly index: number | null;
  readonly entry: unknown;
  readonly why: 'not-an-object' | 'not-a-list' | 'not-an-origin' | 'not-a-route';
}

export interface BuiltRunFacts {
  /** The facts as they were handed in. The gate refuses what an unreadable entry or list could touch. */
  readonly facts: RunFacts;
  readonly unreadable: readonly UnreadableFact[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when the run facts are an object and every list in them is a list. Entries are judged where they are used. */
export function areReadableRunFacts(run: unknown): run is RunFacts {
  return isObject(run) && RUN_FACT_LISTS.every((list) => Array.isArray(run[list]));
}

// The lists whose entries feed a rule that protects: an entry the gate cannot read there is never ignored.
const ENTRY_CHECKS: Partial<Record<keyof RunFacts, { readonly readable: (e: unknown) => boolean; readonly why: UnreadableFact['why'] }>> = {
  spendingRoutes: { readable: isReadableRoute, why: 'not-a-route' },
  seenToChange: { readable: isReadableRoute, why: 'not-a-route' },
  livePhysical: { readable: isReadableOrigin, why: 'not-an-origin' },
};

/**
 * Take the run facts a caller built, and report each one the gate cannot read: facts that are not an object, a list
 * that is missing or not a list, and an entry of `livePhysical` that is not an origin or of `spendingRoutes` or
 * `seenToChange` that is not a route.
 */
export function runFactsFrom(input: unknown): BuiltRunFacts {
  if (!isObject(input)) {
    return { facts: input as RunFacts, unreadable: [{ list: null, index: null, entry: input, why: 'not-an-object' }] };
  }
  const unreadable: UnreadableFact[] = [];
  for (const list of RUN_FACT_LISTS) {
    const value = input[list];
    if (!Array.isArray(value)) {
      unreadable.push({ list, index: null, entry: value, why: 'not-a-list' });
      continue;
    }
    const check = ENTRY_CHECKS[list];
    if (check === undefined) continue;
    value.forEach((entry: unknown, index) => {
      if (!check.readable(entry)) unreadable.push({ list, index, entry, why: check.why });
    });
  }
  return { facts: input as unknown as RunFacts, unreadable };
}
