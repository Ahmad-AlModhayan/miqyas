// SPDX-License-Identifier: AGPL-3.0-only
// The effect classes, the environment classes and the ceiling table, as data (ADR 0008, FOUNDATION §6).
// Every expected value below is written out from the ADR's table, not read back from the module.

import { describe, expect, it } from 'vitest';
import { CEILING, EFFECT_CLASSES, ENVIRONMENT_CLASSES, atLeast, maxEffect } from '../../src/gate/decide/index.js';

const yes = { kind: 'yes' };
const never = { kind: 'never' };
const throughThePage = { kind: 'through-the-page' };
const needs = (...n: string[]) => ({ kind: 'needs', needs: n });
const asCaller = (...also: string[]) => ({ kind: 'as-calling-origin', also });

describe('the effect classes and the environment classes', () => {
  it('lists the effect classes lowest first, with execute last', () => {
    expect(EFFECT_CLASSES).toEqual(['observe', 'interact', 'probe', 'write', 'disrupt', 'execute']);
  });

  it('lists the environment classes in the order of the ADR table', () => {
    expect(ENVIRONMENT_CLASSES).toEqual(['sandbox', 'local-test-host', 'named-test-host', 'owned-host', 'backend', 'other']);
  });

  it('orders effects so that a higher class is at least a lower one and never the reverse', () => {
    expect(maxEffect('probe', 'write')).toBe('write');
    expect(maxEffect('write', 'observe')).toBe('write');
    expect(atLeast('disrupt', 'write')).toBe(true);
    expect(atLeast('probe', 'write')).toBe(false);
    expect(atLeast('interact', 'interact')).toBe(true);
  });

  it('puts a class it does not know above every class it knows', () => {
    expect(maxEffect('write', 'teleport' as never)).toBe('execute');
    expect(atLeast('teleport' as never, 'disrupt')).toBe(true);
  });
});

// One row per cell of the ADR 0008 table: the effect, the environment, the cell.
describe('the ceiling table of ADR 0008', () => {
  it.each([
    // observe
    ['observe', 'sandbox', yes],
    ['observe', 'local-test-host', yes],
    ['observe', 'named-test-host', yes],
    ['observe', 'owned-host', yes],
    ['observe', 'backend', yes],
    ['observe', 'other', yes],
    // interact, from a person's plan
    ['interact', 'sandbox', yes],
    ['interact', 'local-test-host', yes],
    ['interact', 'named-test-host', yes],
    ['interact', 'owned-host', yes],
    ['interact', 'backend', throughThePage],
    ['interact', 'other', yes],
    // probe
    ['probe', 'sandbox', yes],
    ['probe', 'local-test-host', needs('active')],
    ['probe', 'named-test-host', needs('active')],
    ['probe', 'owned-host', needs('active')],
    ['probe', 'backend', asCaller()],
    ['probe', 'other', never],
    // write
    ['write', 'sandbox', yes],
    ['write', 'local-test-host', needs('active')],
    ['write', 'named-test-host', needs('active', 'allow-writes', 'token')],
    ['write', 'owned-host', needs('active', 'allow-writes')],
    ['write', 'backend', asCaller('allow-writes')],
    ['write', 'other', never],
    // disrupt
    ['disrupt', 'sandbox', yes],
    ['disrupt', 'local-test-host', needs('allow-disrupt')],
    ['disrupt', 'named-test-host', needs('allow-disrupt', 'token')],
    ['disrupt', 'owned-host', needs('allow-disrupt')],
    ['disrupt', 'backend', never],
    ['disrupt', 'other', never],
  ])('%s on a %s is %j', (effect, environment, cell) => {
    expect(CEILING[effect as keyof typeof CEILING][environment as keyof (typeof CEILING)['observe']]).toEqual(cell);
  });

  it('has no cell beyond the thirty of the table: execute is not a row', () => {
    expect(Object.keys(CEILING)).toEqual(['observe', 'interact', 'probe', 'write', 'disrupt']);
    for (const row of Object.values(CEILING)) expect(Object.keys(row)).toEqual([...ENVIRONMENT_CLASSES]);
  });
});
