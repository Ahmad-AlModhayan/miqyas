// SPDX-License-Identifier: AGPL-3.0-only
// A fact (docs/FOUNDATION.md §3): what a collector measured, about one subject, as a `fact` record's body holds it.
// Collectors build facts and the judge reads them; both take the type from here.
import type { Json } from './ledger.js';

export type Fact = {
  kind: string;
  v: number;
  by: string;
  run: number;
  subject: string;
  body: Json;
  /** The facts this one was derived from, by ledger position. */
  from?: number[];
  /** Fields of `body` that rest on a value the collector did not keep (docs/FOUNDATION.md §3). */
  withheld?: string[];
};

/** A fact and its position in the ledger. */
export type PlacedFact = { seq: number; fact: Fact };
