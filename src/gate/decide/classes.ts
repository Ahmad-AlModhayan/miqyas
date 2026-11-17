// SPDX-License-Identifier: AGPL-3.0-only
// The effect classes, the environment classes and the ceiling table that joins them
// (docs/adr/0008-every-effect-passes-one-gate.md, FOUNDATION §6). Data and pure functions only.

/** Effects, lowest first. */
export const EFFECT_CLASSES = ['observe', 'interact', 'probe', 'write', 'disrupt', 'execute'] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

/** The environment classes, in the order of the ADR's table. An environment class belongs to an origin, not to a run. */
export const ENVIRONMENT_CLASSES = [
  'sandbox',
  'local-test-host',
  'named-test-host',
  'owned-host',
  'backend',
  'other',
] as const;
export type EnvironmentClass = (typeof ENVIRONMENT_CLASSES)[number];

/** What a cell of the table can ask of the person, beyond the origin being of that class. */
export type Need = 'active' | 'allow-writes' | 'allow-disrupt' | 'token';

export type Cell =
  | { readonly kind: 'yes' }
  | { readonly kind: 'never' }
  /** Every one of these grants, and for `token` the ownership token found for the host. */
  | { readonly kind: 'needs'; readonly needs: readonly Need[] }
  /** Only a request the target's own page sent, as a person's plan told it to. */
  | { readonly kind: 'through-the-page' }
  /** The consent of the origin whose pages call this one, and these grants as well. */
  | { readonly kind: 'as-calling-origin'; readonly also: readonly Need[] };

/** The effect classes that have a row in the table. `execute` has no row: see `decide`. */
export type CeilingEffect = Exclude<EffectClass, 'execute'>;

const yes: Cell = { kind: 'yes' };
const never: Cell = { kind: 'never' };
const needs = (...n: Need[]): Cell => ({ kind: 'needs', needs: n });

/** The table of ADR 0008. `CEILING[effect][environment]`. */
export const CEILING: Readonly<Record<CeilingEffect, Readonly<Record<EnvironmentClass, Cell>>>> = {
  observe: {
    sandbox: yes,
    'local-test-host': yes,
    'named-test-host': yes,
    'owned-host': yes,
    backend: yes,
    other: yes,
  },
  interact: {
    sandbox: yes,
    'local-test-host': yes,
    'named-test-host': yes,
    'owned-host': yes,
    backend: { kind: 'through-the-page' },
    other: yes,
  },
  probe: {
    sandbox: yes,
    'local-test-host': needs('active'),
    'named-test-host': needs('active'),
    'owned-host': needs('active'),
    backend: { kind: 'as-calling-origin', also: [] },
    other: never,
  },
  write: {
    sandbox: yes,
    'local-test-host': needs('active'),
    'named-test-host': needs('active', 'allow-writes', 'token'),
    'owned-host': needs('active', 'allow-writes'),
    backend: { kind: 'as-calling-origin', also: ['allow-writes'] },
    other: never,
  },
  disrupt: {
    sandbox: yes,
    'local-test-host': needs('allow-disrupt'),
    'named-test-host': needs('allow-disrupt', 'token'),
    'owned-host': needs('allow-disrupt'),
    backend: never,
    other: never,
  },
};

const rank = (c: string): number => {
  const i = (EFFECT_CLASSES as readonly string[]).indexOf(c);
  // A class this module doesn't know is the most restrictive one: it fails closed.
  return i === -1 ? EFFECT_CLASSES.length - 1 : i;
};

/** True when `a` is the same class as `b` or a higher one. */
export function atLeast(a: EffectClass, b: EffectClass): boolean {
  return rank(a) >= rank(b);
}

/** The higher of two classes. A class that isn't known counts as `execute`. */
export function maxEffect(a: EffectClass, b: EffectClass): EffectClass {
  const known = (c: EffectClass): EffectClass => EFFECT_CLASSES[rank(c)] as EffectClass;
  return rank(a) >= rank(b) ? known(a) : known(b);
}
