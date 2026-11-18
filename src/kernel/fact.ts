// SPDX-License-Identifier: AGPL-3.0-only
// A fact (docs/FOUNDATION.md §3): what a collector measured, about one subject, as a `fact` record's body holds it.
// Collectors build facts and the judge reads them; both take the type from here.
import type { FactCause } from '../protocol/facts.js';
import type { BlobRef } from './blobs.js';
import type { Json } from './ledger.js';

export type Fact = {
  kind: string;
  v: number;
  by: string;
  run: number;
  subject: string;
  /** The origin it was observed at, for facts about network traffic. */
  origin?: string;
  /** Where it was measured: screen, route, file, table, session label, step. */
  place?: Record<string, string>;
  /** The ledger position of the gate record that allowed the action behind it. */
  effect?: number;
  /** Who caused the traffic or the change this fact records. A kind that records traffic requires it. */
  cause?: FactCause;
  body: Json;
  /** Large payloads, by digest. */
  blobs?: Record<string, BlobRef>;
  /** The facts this one was derived from, by ledger position. */
  from?: number[];
  /** Fields of `body` that rest on a value the collector did not keep (docs/FOUNDATION.md §3). */
  withheld?: string[];
};

/** A fact and its position in the ledger. */
export type PlacedFact = { seq: number; fact: Fact };
