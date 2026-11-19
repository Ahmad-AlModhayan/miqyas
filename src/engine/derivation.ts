// SPDX-License-Identifier: AGPL-3.0-only
// Derivations (docs/FOUNDATION.md §3): pure, versioned functions from facts to facts, such as grouping requests into
// routes or turning advisories into findings. One is registered as id@version and ships examples of its own, each
// stating the facts it gives, which it must give exactly before it is accepted. Running one hands it only the kinds it reads, frozen, runs it twice and refuses it
// unless both runs give the same facts; each fact it produces is checked against its kind and must name in `from` the
// facts it was computed from, all of them among those it was given. It records `by` as its id@version.
import type { Fact, PlacedFact } from '../kernel/fact.js';
import { checkFact } from './fact-check.js';
import { normalise } from './withhold.js';

/** A fact as a derivation produces it: the runner adds `by` and `run`. */
export type Derived = Omit<Fact, 'by' | 'run'>;

/**
 * An example a derivation ships: the facts it is given, and the facts it gives for them, in order, as it produces them
 * (without `by` and `run`). A derivation that gives other facts, or as many but not the same, fails its example.
 */
export interface DerivationExample {
  name: string;
  facts: readonly PlacedFact[];
  gives: readonly Derived[];
}

export interface Derivation {
  /** Lower case, digits, ".", "_" and "-". */
  id: string;
  /** A whole number from 1; a change to what it gives is a new version. */
  version: number;
  /** The kinds it reads: it is handed only facts of these. */
  reads: readonly string[];
  derive(facts: readonly PlacedFact[]): Derived[];
  examples: readonly DerivationExample[];
}

/** A derivation that is not well formed, or did not behave as one. */
export class DerivationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DerivationRefused';
  }
}

const ID = /^[a-z0-9][a-z0-9._-]*$/;

/** The name a derivation is registered and records its facts under. */
export const derivationName = (d: Pick<Derivation, 'id' | 'version'>): string => `${d.id}@${d.version}`;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** Runs a derivation on facts: the facts it produces, or DerivationRefused. */
export function runDerivation(d: Derivation, facts: readonly PlacedFact[]): Fact[] {
  const name = derivationName(d);
  const given = facts.filter((p) => d.reads.includes(p.fact.kind));
  const once = () => d.derive(deepFreeze(structuredClone(given))).map((f): Fact => ({ ...f, by: name, run: 1 }));
  const first = once();
  const second = once();
  if (normalise(first as never) !== normalise(second as never)) throw new DerivationRefused(`${name} gave other facts when run again on the same facts`);
  const positions = new Set(given.map((p) => p.seq));
  for (const fact of first) {
    if (fact.from === undefined || fact.from.length === 0) throw new DerivationRefused(`${name} produced a ${fact.kind} fact without from`);
    const stray = fact.from.find((seq) => !positions.has(seq));
    if (stray !== undefined) throw new DerivationRefused(`${name} produced a fact from position ${stray}, which it was not given`);
    const check = checkFact(fact);
    if (!check.ok) throw new DerivationRefused(`${name}: ${check.message}`);
  }
  return first;
}

/** The derivations a run may use, by id@version. */
export class Derivations {
  private readonly byName = new Map<string, Derivation>();

  /** Registers a derivation once it gives each of its examples. */
  register(d: Derivation): void {
    if (!ID.test(d.id) || !Number.isSafeInteger(d.version) || d.version < 1) {
      throw new DerivationRefused(`a derivation is named id@version, the id in lower case and the version a whole number from 1: got ${JSON.stringify(`${d.id}@${d.version}`)}`);
    }
    const name = derivationName(d);
    if (this.byName.has(name)) throw new DerivationRefused(`${name} is registered already`);
    if (d.examples.length === 0) throw new DerivationRefused(`${name} ships no example`);
    for (const example of d.examples) {
      const got = runDerivation(d, example.facts).map(({ by: _by, run: _run, ...derived }) => derived);
      if (normalise(got as never) !== normalise(example.gives as never)) {
        const which = got.length === example.gives.length ? 'other facts than' : `${got.length} facts, not the ${example.gives.length}`;
        throw new DerivationRefused(`${name}: example ${JSON.stringify(example.name)} gives ${which} it states`);
      }
    }
    this.byName.set(name, d);
  }

  get(name: string): Derivation | undefined {
    return this.byName.get(name);
  }

  /** The names registered, in order. */
  ids(): string[] {
    return [...this.byName.keys()].sort();
  }
}
