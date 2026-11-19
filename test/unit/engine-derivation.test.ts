// SPDX-License-Identifier: AGPL-3.0-only
// Derivations (docs/FOUNDATION.md §3): pure, versioned functions from facts to facts, registered as id@version, each
// shipping its own examples. Every fact one produces names in `from` the facts it was computed from, and running it
// twice on the same facts gives the same facts. The seam is the registry and the run of a derivation.
import { describe, expect, it } from 'vitest';
import { type Derivation, DerivationRefused, Derivations, runDerivation } from '../../src/engine/derivation.js';
import type { PlacedFact } from '../../src/kernel/fact.js';

const advisory = (seq: number, severity: string, name = `pkg-${seq}`): PlacedFact => ({
  seq,
  fact: {
    kind: 'dep.advisory',
    v: 1,
    by: 'osv-adapter@1',
    run: 1,
    subject: 'repository',
    body: { id: `GHSA-${seq}`, aliases: [], malicious: false, severity, package: { name, version: '1.0.0', ecosystem: 'npm' }, lockfile: 'package-lock.json', fixed: [] },
  },
});

/** The finding `criticals` gives for the advisory at `seq`. */
const findingOf = (seq: number) => ({
  kind: 'finding',
  v: 1,
  subject: 'repository',
  from: [seq],
  body: { id: 'critical-advisory', title: `critical advisory GHSA-${seq}`, severity: 'critical', state: 'confirmed', source: 'derivation' },
});

/** A finding for each critical advisory: a derivation as small as one can be. */
const criticals: Derivation = {
  id: 'critical-advisories',
  version: 1,
  reads: ['dep.advisory'],
  derive: (facts) =>
    facts
      .filter((p) => (p.fact.body as { severity: string }).severity === 'critical')
      .map((p) => ({
        kind: 'finding',
        v: 1,
        subject: p.fact.subject,
        from: [p.seq],
        body: { id: 'critical-advisory', title: `critical advisory ${(p.fact.body as { id: string }).id}`, severity: 'critical', state: 'confirmed', source: 'derivation' },
      })),
  examples: [
    { name: 'one critical among two', facts: [advisory(1, 'critical'), advisory(2, 'low')], gives: [findingOf(1)] },
    { name: 'none critical', facts: [advisory(1, 'low')], gives: [] },
  ],
};

describe('a derivation', () => {
  it('is registered as id@version, and records that as the by of each fact it produces, with from', () => {
    const registry = new Derivations();
    registry.register(criticals);
    expect(registry.ids()).toEqual(['critical-advisories@1']);
    const out = runDerivation(registry.get('critical-advisories@1')!, [advisory(3, 'critical'), advisory(4, 'high'), advisory(5, 'critical')]);
    expect(out.map((f) => [f.by, f.run, f.from])).toEqual([
      ['critical-advisories@1', 1, [3]],
      ['critical-advisories@1', 1, [5]],
    ]);
  });

  it('gives the same facts when run twice on the same facts', () => {
    const facts = [advisory(1, 'critical'), advisory(2, 'critical')];
    expect(runDerivation(criticals, facts)).toEqual(runDerivation(criticals, facts));
  });

  it('is refused when it does not give the same facts twice', () => {
    let calls = 0;
    const drifting: Derivation = { ...criticals, id: 'drifting', derive: (facts) => criticals.derive(facts).slice(0, ++calls % 2) };
    expect(() => runDerivation(drifting, [advisory(1, 'critical')])).toThrow(DerivationRefused);
  });

  it('is refused when it changes the facts it reads', () => {
    const mutating: Derivation = { ...criticals, id: 'mutating', derive: (facts) => ((facts[0]!.fact.body as { severity: string }).severity = 'low', []) };
    expect(() => runDerivation(mutating, [advisory(1, 'critical')])).toThrow();
  });

  it('is refused when a fact it produces has no from, or names a fact it was not given', () => {
    const noFrom: Derivation = { ...criticals, id: 'no-from', derive: (facts) => criticals.derive(facts).map(({ from: _from, ...f }) => f) };
    expect(() => runDerivation(noFrom, [advisory(1, 'critical')])).toThrow(/from/);
    const elsewhere: Derivation = { ...criticals, id: 'elsewhere', derive: (facts) => criticals.derive(facts).map((f) => ({ ...f, from: [99] })) };
    expect(() => runDerivation(elsewhere, [advisory(1, 'critical')])).toThrow(/99/);
  });

  it('is refused when a fact it produces does not match its kind', () => {
    const verdict: Derivation = { ...criticals, id: 'verdict', derive: (facts) => criticals.derive(facts).map((f) => ({ ...f, body: { ...(f.body as object), verdict: 'fail' } })) };
    expect(() => runDerivation(verdict, [advisory(1, 'critical')])).toThrow(/finding/);
  });

  it('reads only the kinds it names', () => {
    const sample: PlacedFact = { seq: 9, fact: { kind: 'sample', v: 1, by: 'p@1', run: 1, subject: 's', body: { name: 'x', value: 1, unit: 'ms' } } };
    let seen: string[] = [];
    runDerivation({ ...criticals, derive: (facts) => ((seen = facts.map((p) => p.fact.kind)), []) }, [sample, advisory(1, 'low')]);
    expect(seen).toEqual(['dep.advisory']);
  });
});

describe('the registry of derivations', () => {
  it('refuses a name that is not id@version, and a second derivation under one name', () => {
    const registry = new Derivations();
    expect(() => registry.register({ ...criticals, id: 'Critical Advisories' })).toThrow(DerivationRefused);
    expect(() => registry.register({ ...criticals, version: 0 })).toThrow(DerivationRefused);
    registry.register(criticals);
    expect(() => registry.register(criticals)).toThrow(/critical-advisories@1/);
    registry.register({ ...criticals, version: 2 });
    expect(registry.ids()).toEqual(['critical-advisories@1', 'critical-advisories@2']);
  });

  it('refuses a derivation that ships no example, or whose examples it does not give', () => {
    const registry = new Derivations();
    expect(() => registry.register({ ...criticals, examples: [] })).toThrow(/example/);
    const wrong = { ...criticals, examples: [{ name: 'claims two', facts: [advisory(1, 'critical')], gives: [findingOf(1), findingOf(1)] }] };
    expect(() => registry.register(wrong)).toThrow(/claims two/);
  });

  it('refuses a derivation that gives as many facts as its example states, but not the facts it states', () => {
    const registry = new Derivations();
    // Right count, wrong fact: the severity is off.
    const misjudging: Derivation = {
      ...criticals,
      id: 'misjudging',
      derive: (facts) => criticals.derive(facts).map((f) => ({ ...f, body: { ...(f.body as object), severity: 'low' } })),
    };
    expect(() => registry.register(misjudging)).toThrow(/one critical among two/);
    // Right facts, from the wrong position.
    const misplaced: Derivation = { ...criticals, id: 'misplaced', examples: [{ name: 'from the low one', facts: [advisory(1, 'critical'), advisory(2, 'low')], gives: [findingOf(2)] }] };
    expect(() => registry.register(misplaced)).toThrow(/from the low one/);
    expect(registry.ids()).toEqual([]);
  });

  it('registers a derivation that gives exactly the facts its examples state, whatever the order of their fields', () => {
    const registry = new Derivations();
    const { body, ...rest } = findingOf(1);
    registry.register({ ...criticals, examples: [{ name: 'reordered', facts: [advisory(1, 'critical')], gives: [{ body, ...rest }] }] });
    expect(registry.ids()).toEqual(['critical-advisories@1']);
  });
});
