// SPDX-License-Identifier: AGPL-3.0-only
// Loading a claim file and judging a `set` claim (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A1 and A5, ADR 0014),
// over check 13's shipped claim and small claims written here. The judge and the CEL library are real.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaimRejection, loadClaim } from '../../src/kernel/claim.js';
import type { Fact, PlacedFact } from '../../src/kernel/fact.js';
import { fold, judgeSet, sealResult } from '../../src/kernel/judge.js';
import { sha256 } from '../kernel-helpers.js';

const CLAIM_FILE = path.resolve(import.meta.dirname, '../../src/claims/readiness-13-dependencies.json');
const bytes = () => new Uint8Array(readFileSync(CLAIM_FILE));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const fact = (kind: string, by: string, body: Fact['body']): Fact => ({ kind, v: 1, by, run: 1, subject: 'repository', body });
const reader = (lockfiles: number, status = 'complete') => fact('collection', 'lockfile-reader@1', { status, counts: { lockfiles } });
const osv = (status = 'complete') => fact('collection', 'osv-adapter@1', { status, counts: { lockfiles: 1, advisories: 0 } });
const advisory = (id: string, severity: string, malicious = false) =>
  fact('dep.advisory', 'osv-adapter@1', { id, severity, malicious, package: { name: 'p', version: '1.0.0', ecosystem: 'npm' } });
const placed = (...facts: Fact[]): PlacedFact[] => facts.map((f, i) => ({ seq: i + 3, fact: f }));

describe("check 13's claim", () => {
  it('loads, with its digest and the failing example that shows it can fail', async () => {
    const loaded = await loadClaim(bytes(), sha256);
    expect(loaded.claim.id).toBe('readiness.13.dependencies');
    expect(loaded.rule).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.failedOn).toBe('a high advisory fails');
  });

  it('fails on a critical advisory, and its verdict lists the facts read, the advisory shown and the coverage it saw', async () => {
    const loaded = await loadClaim(bytes(), sha256);
    const facts = placed(reader(1), advisory('GHSA-crit-0001', 'critical'), advisory('GHSA-low-0003', 'low'), osv());
    const verdict = judgeSet(loaded, { subject: 'repository', facts });
    expect(verdict).toEqual({
      claim: 'readiness.13.dependencies@1',
      rule: loaded.rule,
      view: { subject: 'repository', kinds: ['dep.advisory', 'collection'], by: ['lockfile-reader@1', 'osv-adapter@1'] },
      verdict: 'fail',
      items: { held: 1, failed: 1, outside: 0, uncertain: 0 },
      read: [3, 4, 5, 6],
      shown: [4],
      coverage: {
        rule: loaded.claim.covered,
        met: true,
        saw: {
          collections: {
            'lockfile-reader@1': { status: 'complete', counts: { lockfiles: 1 } },
            'osv-adapter@1': { status: 'complete', counts: { lockfiles: 1, advisories: 0 } },
          },
          inputs: {},
        },
      },
      depth: 'facts',
      assurance: 'tested',
      basis: 'rule',
      failed_on: 'a high advisory fails',
    });
  });

  it('reads only the facts its view names', async () => {
    const loaded = await loadClaim(bytes(), sha256);
    const other = fact('dep.advisory', 'someone-else@1', { id: 'X', severity: 'critical', malicious: false });
    const verdict = judgeSet(loaded, { subject: 'repository', facts: placed(reader(1), other, osv()) });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.vacuous).toBe(true);
    expect(verdict.read).toEqual([3, 5]);
  });

  it("reads no fact of another subject: another subject's coverage can't make it pass, nor its advisories fail or count", async () => {
    const loaded = await loadClaim(bytes(), sha256);
    const of = (subject: string, f: Fact): Fact => ({ ...f, subject });

    const coveredElsewhere = judgeSet(loaded, { subject: 'repository', facts: placed(of('other', reader(1)), of('other', osv())) });
    expect(coveredElsewhere.verdict).toBe('not_checked');
    expect(coveredElsewhere.reason).toBe('coverage not met');
    expect(coveredElsewhere.read).toEqual([]);
    expect(coveredElsewhere.coverage.saw).toEqual({ collections: {}, inputs: {} });

    const failsElsewhere = placed(reader(1), of('elsewhere', advisory('GHSA-crit-0001', 'critical')), of('other', advisory('GHSA-med-0002', 'medium')), osv());
    const verdict = judgeSet(loaded, { subject: 'repository', facts: failsElsewhere });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.items).toEqual({ held: 0, failed: 0, outside: 0, uncertain: 0 });
    expect(verdict.read).toEqual([3, 6]);
    expect(verdict.view.subject).toBe('repository');
  });

  it('does not pass when coverage is not met: no database, no lockfile, or no scan at all', async () => {
    const loaded = await loadClaim(bytes(), sha256);
    for (const facts of [
      placed(reader(1), advisory('GHSA-med', 'medium'), osv('failed')),
      placed(reader(0), osv()),
      placed(reader(1)),
    ]) {
      const verdict = judgeSet(loaded, { subject: 'repository', facts });
      expect(verdict.verdict).toBe('not_checked');
      expect(verdict.reason).toBe('coverage not met');
      expect(verdict.coverage.met).toBe(false);
    }
  });

  it('a counterexample fails it at any coverage', async () => {
    const loaded = await loadClaim(bytes(), sha256);
    const verdict = judgeSet(loaded, { subject: 'repository', facts: placed(reader(1), advisory('MAL-1', 'low', true), osv('failed')) });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.coverage.met).toBe(false);
  });
});


/** A small claim whose rule can error: a score compared as a number. */
const done = { kind: 'collection', by: 'c@1', body: { status: 'complete' } };
const failingExample = { name: 'nine fails', expect: 'fail', facts: [{ kind: 't.item', by: 'c@1', body: { score: 9 } }, done] };
const passingExample = { name: 'one passes', expect: 'pass', facts: [{ kind: 't.item', by: 'c@1', body: { score: 1 } }, done] };
const unknownExample = { name: 'not collected is not known', expect: 'not_checked', facts: [{ kind: 'collection', by: 'c@1', body: { status: 'failed' } }] };
const allThree = [failingExample, passingExample, unknownExample];
const scoreClaim = (examples: unknown[] = allThree, holds = 'item.score > 7', extra: Record<string, unknown> = {}) => ({
  id: 'test.score',
  version: 1,
  title: 'no item scores over 7',
  view: { kinds: ['t.item', 'collection'] },
  shape: 'set',
  quantifier: 'none',
  from: 't.item',
  holds,
  covered: 'ctx.collections["c@1"].status == "complete"',
  ...extra,
  examples,
});
const complete = () => fact('collection', 'c@1', { status: 'complete' });
const item = (score: unknown, more: Partial<Fact> = {}): Fact => ({ ...fact('t.item', 'c@1', { score } as Fact['body']), ...more });

describe('the judge', () => {
  it('names in failed_on the example that gave fail, wherever it stands in the file', async () => {
    const loaded = await loadClaim(encode(scoreClaim([passingExample, unknownExample, failingExample])), sha256);
    expect(loaded.failedOn).toBe('nine fails');
    expect(judgeSet(loaded, { subject: 'repository', facts: placed(complete()) }).failed_on).toBe('nine fails');
  });

  it('reads a rule that gives an error as uncertain, never as a pass', async () => {
    const loaded = await loadClaim(encode(scoreClaim()), sha256);
    const verdict = judgeSet(loaded, { subject: 'repository', facts: placed(item('high'), complete()) });
    expect(verdict.verdict).toBe('not_checked');
    expect(verdict.reason).toBe('uncertain items: an expression gave an error');
    expect(verdict.items).toEqual({ held: 0, failed: 0, outside: 0, uncertain: 1 });
  });

  it('a counterexample fails it even beside an item whose rule gives an error', async () => {
    const loaded = await loadClaim(encode(scoreClaim()), sha256);
    const verdict = judgeSet(loaded, { subject: 'repository', facts: placed(item('high'), item(9), complete()) });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.shown).toEqual([4]);
  });

  it('with nothing to check, passes marked vacuous when the claim says vacuous: pass', async () => {
    const loaded = await loadClaim(encode(scoreClaim(allThree, undefined, { vacuous: 'pass' })), sha256);
    const verdict = judgeSet(loaded, { subject: 'repository', facts: placed(complete()) });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.vacuous).toBe(true);
    expect(verdict.reason).toBeUndefined();
  });

  it('with nothing to check, is not known, marked vacuous, when the claim says vacuous: not_checked', async () => {
    const loaded = await loadClaim(encode(scoreClaim(allThree, undefined, { vacuous: 'not_checked' })), sha256);
    const verdict = judgeSet(loaded, { subject: 'repository', facts: placed(complete()) });
    expect(verdict.verdict).toBe('not_checked');
    expect(verdict.reason).toBe('nothing to check');
    expect(verdict.vacuous).toBe(true);
  });

  it('a pass over items checked is not vacuous', async () => {
    const loaded = await loadClaim(encode(scoreClaim(allThree, undefined, { vacuous: 'pass' })), sha256);
    const verdict = judgeSet(loaded, { subject: 'repository', facts: placed(item(1), complete()) });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.vacuous).toBeUndefined();
  });

  it('gives depth measured when a fact it read withholds a field, derived when one was derived, facts otherwise', async () => {
    const loaded = await loadClaim(encode(scoreClaim()), sha256);
    const depthOf = (...facts: Fact[]) => judgeSet(loaded, { subject: 'repository', facts: placed(...facts) }).depth;
    expect(depthOf(item(1, { withheld: ['score'] }), complete())).toBe('measured');
    expect(depthOf(item(1, { from: [1] }), complete())).toBe('derived');
    expect(depthOf(item(1, { withheld: ['score'], from: [1] }), complete())).toBe('measured');
    expect(depthOf(item(1), complete())).toBe('facts');
    // A fact outside the view withholds nothing from this claim.
    expect(depthOf(item(1), complete(), fact('t.other', 'c@1', { score: 1 }), { ...fact('t.other', 'c@1', {}), withheld: ['score'] })).toBe('facts');
  });

  it('reads its view in ledger order, and takes the last run of each collection, in collector order', async () => {
    const loaded = await loadClaim(encode(scoreClaim()), sha256);
    const facts: PlacedFact[] = [
      { seq: 9, fact: fact('collection', 'c@1', { status: 'complete' }) },
      { seq: 4, fact: item(9) },
      { seq: 7, fact: { ...fact('collection', 'c@1', { status: 'failed' }), run: 2 } },
      { seq: 10, fact: fact('collection', 'b@1', { status: 'complete' }) },
      { seq: 11, fact: { ...item(1), run: 2 } }, // an item of the same collector and run is not its collection
    ];
    const verdict = judgeSet(loaded, { subject: 'repository', facts });
    expect(verdict.read).toEqual([4, 7, 9, 10, 11]);
    expect(Object.keys(verdict.coverage.saw as { collections: object }).length).toBe(2);
    const saw = (verdict.coverage.saw as { collections: Record<string, unknown> }).collections;
    expect(Object.keys(saw)).toEqual(['b@1', 'c@1']);
    expect(saw['c@1']).toEqual({ status: 'failed' }); // run 2 wins, though run 1 comes later in the ledger
    expect(verdict.coverage.met).toBe(false);

    const sameRun = [{ seq: 1, fact: fact('collection', 'c@1', { status: 'failed' }) }, { seq: 2, fact: complete() }];
    expect(judgeSet(loaded, { subject: 'repository', facts: sameRun }).coverage.met).toBe(true); // in one run, the later wins
  });

  it('folds: any fail fails, anything not known is not known, an empty set never passes', () => {
    expect(fold([])).toBe('not_known');
    expect(fold(['pass'])).toBe('pass');
    expect(fold(['pass', 'not_checked'])).toBe('not_known');
    expect(fold(['blocked', 'fail', 'pass'])).toBe('fail');
    expect(sealResult(['pass', 'not_checked'])).toEqual({ verdict: 'not_known', verdicts: 2 });
  });
});

describe('a claim file that is refused', () => {
  const refused = (claim: unknown) => expect(loadClaim(encode(claim), sha256)).rejects;

  it('has no failing example, no passing one, or none that is not known (ADR 0014)', async () => {
    await refused(scoreClaim([passingExample, unknownExample])).toThrow(/no example that gives fail/);
    await refused(scoreClaim([failingExample, unknownExample])).toThrow(/no example that gives pass/);
    await refused(scoreClaim([failingExample, passingExample])).toThrow(/no example that gives not_checked/);
  });

  it('has an example that does not give what it says', async () => {
    const wrong = { name: 'nine passes', expect: 'pass', facts: failingExample.facts };
    await refused(scoreClaim([...allThree, wrong])).toThrow(/"nine passes" gives fail, not pass/);
  });

  it('has a rule over a CEL limit, or outside the subset', async () => {
    const long = `item.score > 7${' || item.score > 7'.repeat(70)}`;
    await refused(scoreClaim(allThree, long)).toThrow(/^holds: limit: .*maxLength/);
    await refused(scoreClaim(allThree, 'item.score > 7.5')).toBeInstanceOf(ClaimRejection);
  });

  it('has a shape the judge does not judge yet', async () => {
    await refused({ ...scoreClaim(), shape: 'pair' }).toThrow(/only "set" is judged so far/);
  });

  it('has a quantifier other than none, naming it', async () => {
    for (const quantifier of ['every', 'some', 'count']) {
      await refused({ ...scoreClaim(), quantifier }).toThrow(new RegExp(`quantifier "${quantifier}": only "none" is judged so far`));
    }
  });

  it('uses where, usable or count, naming the field', async () => {
    for (const field of ['where', 'usable', 'count']) {
      await refused(scoreClaim(allThree, undefined, { [field]: 'true' })).toThrow(new RegExp(`has "${field}": it is not judged yet`));
    }
  });

  it('has a key it does not know, at the top, in its view or in an example, naming the key', async () => {
    await refused(scoreClaim(allThree, undefined, { vacous: 'pass' })).toThrow(/unknown key "vacous"/);
    await refused({ ...scoreClaim(), view: { kinds: ['t.item', 'collection'], subjects: ['x'] } }).toThrow(/unknown key "view.subjects"/);
    await refused(scoreClaim([{ ...failingExample, expected: 'fail' }, passingExample, unknownExample])).toThrow(/example 0 has an unknown key "expected"/);
  });

  it('is not UTF-8, not JSON, or not an object', async () => {
    await expect(loadClaim(new Uint8Array([0xff, 0xfe]), sha256)).rejects.toThrow(/not UTF-8/);
    await expect(loadClaim(new TextEncoder().encode('{'), sha256)).rejects.toThrow(/not JSON/);
    await expect(loadClaim(encode([scoreClaim()]), sha256)).rejects.toThrow(/not a JSON object/);
  });

  it('lacks a field it needs, or gives one in the wrong form', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ id: '' }, /needs id as text/],
      [{ version: 0 }, /needs version as a whole number/],
      [{ version: 1.5 }, /needs version as a whole number/],
      [{ title: 7 }, /needs title as text/],
      [{ view: { kinds: 't.item' } }, /needs view.kinds/],
      [{ view: { kinds: ['t.item', 'collection'], by: [''] } }, /needs view.kinds, and view.by if given/],
      [{ from: 't.other' }, /reads items of kind t.other, which its view does not hold/],
      [{ holds: undefined }, /needs holds as text/],
      [{ covered: '' }, /needs covered as text/],
      [{ each: 'item.list' }, /has "each": it is not judged yet/],
      [{ examples: {} }, /needs examples as a list/],
    ];
    for (const [change, why] of cases) await refused({ ...scoreClaim(), ...change }).toThrow(why);
  });

  it('has an example in the wrong form', async () => {
    const cases: [unknown, RegExp][] = [
      ['nine', /example 0 is not an object/],
      [{ ...failingExample, name: '' }, /example 0 needs a name/],
      [{ ...failingExample, expect: 'maybe' }, /example 0 needs expect: pass, fail, not_checked, blocked, unverified/],
      [{ ...failingExample, facts: {} }, /example 0 needs facts as a list/],
      [{ ...failingExample, inputs: [] }, /example 0 has inputs that are not an object/],
      [{ ...failingExample, facts: [{ kind: 't.item', body: {} }] }, /example 0 fact 0 needs kind, by and body/],
    ];
    for (const [example, why] of cases) await refused(scoreClaim([example, passingExample, unknownExample])).toThrow(why);
  });

  it('has a vacuous rule other than pass or not_checked', async () => {
    await refused(scoreClaim(allThree, undefined, { vacuous: 'fail' })).toThrow(/vacuous other than pass or not_checked/);
  });
});
