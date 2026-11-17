// SPDX-License-Identifier: AGPL-3.0-only
// Loading a claim file and judging a `set` claim (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A1 and A5, ADR 0014),
// over check 13's shipped claim and small claims written here. The judge and the CEL library are real.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaimRejection, loadClaim } from '../../src/kernel/claim.js';
import { type Fact, type PlacedFact, fold, judgeSet } from '../../src/kernel/judge.js';
import { sha256 } from '../kernel-helpers.js';

const CLAIM_FILE = path.resolve(import.meta.dirname, '../../src/claims/readiness-13-dependencies.json');
const bytes = () => new Uint8Array(readFileSync(CLAIM_FILE));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const fact = (kind: string, by: string, body: Fact['body']): Fact => ({ kind, v: 1, by, run: 1, subject: 'repository', body });
const reader = (lockfiles: number, status = 'complete') => fact('collection', 'lockfile-reader@1', { status, counts: { lockfiles } });
const osv = (scanned: number, status = 'complete') =>
  fact('collection', 'osv-adapter@1', { status, counts: { lockfiles: 1, scanned, advisories: 0 } });
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
    const facts = placed(reader(1), advisory('GHSA-crit-0001', 'critical'), advisory('GHSA-low-0003', 'low'), osv(1));
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
            'osv-adapter@1': { status: 'complete', counts: { lockfiles: 1, scanned: 1, advisories: 0 } },
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
    const verdict = judgeSet(loaded, { subject: 'repository', facts: placed(reader(1), other, osv(1)) });
    expect(verdict.verdict).toBe('pass');
    expect(verdict.vacuous).toBe(true);
    expect(verdict.read).toEqual([3, 5]);
  });

  it('does not pass when coverage is not met: no database, no lockfile, or fewer lockfiles scanned than found', async () => {
    const loaded = await loadClaim(bytes(), sha256);
    for (const facts of [
      placed(reader(1), advisory('GHSA-med', 'medium'), osv(0, 'failed')),
      placed(reader(0), osv(0)),
      placed(reader(2), osv(1)),
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
    const verdict = judgeSet(loaded, { subject: 'repository', facts: placed(reader(1), advisory('MAL-1', 'low', true), osv(0, 'failed')) });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.coverage.met).toBe(false);
  });
});

/** A small claim whose rule can error: a score compared as a number. */
const scoreClaim = (examples: unknown[], holds = 'item.score > 7') => ({
  id: 'test.score',
  version: 1,
  title: 'no item scores over 7',
  view: { kinds: ['t.item', 'collection'] },
  shape: 'set',
  quantifier: 'none',
  from: 't.item',
  holds,
  covered: 'ctx.collections["c@1"].status == "complete"',
  examples,
});
const done = { kind: 'collection', by: 'c@1', body: { status: 'complete' } };
const failingExample = { name: 'nine fails', expect: 'fail', facts: [{ kind: 't.item', by: 'c@1', body: { score: 9 } }, done] };

describe('the judge', () => {
  it('reads a rule that gives an error as uncertain, never as a pass', async () => {
    const loaded = await loadClaim(encode(scoreClaim([failingExample])), sha256);
    const facts = placed(fact('t.item', 'c@1', { score: 'high' }), fact('collection', 'c@1', { status: 'complete' }));
    const verdict = judgeSet(loaded, { subject: 's', facts });
    expect(verdict.verdict).toBe('not_checked');
    expect(verdict.reason).toBe('uncertain items: an expression gave an error');
    expect(verdict.items).toEqual({ held: 0, failed: 0, outside: 0, uncertain: 1 });
  });

  it('folds: any fail fails, anything not known is not known, an empty set never passes', () => {
    expect(fold([])).toBe('not_known');
    expect(fold(['pass'])).toBe('pass');
    expect(fold(['pass', 'not_checked'])).toBe('not_known');
    expect(fold(['blocked', 'fail', 'pass'])).toBe('fail');
  });
});

describe('a claim file that is refused', () => {
  it('has no failing example', async () => {
    const passing = { name: 'one passes', expect: 'pass', facts: [{ kind: 't.item', by: 'c@1', body: { score: 1 } }, done] };
    await expect(loadClaim(encode(scoreClaim([passing])), sha256)).rejects.toThrow(/no failing example/);
  });

  it('has an example that does not give what it says', async () => {
    const wrong = { name: 'nine passes', expect: 'pass', facts: failingExample.facts };
    await expect(loadClaim(encode(scoreClaim([failingExample, wrong])), sha256)).rejects.toThrow(/"nine passes" gives fail, not pass/);
  });

  it('has a rule over a CEL limit, or outside the subset', async () => {
    const long = `item.score > 7${' || item.score > 7'.repeat(70)}`;
    await expect(loadClaim(encode(scoreClaim([failingExample], long)), sha256)).rejects.toThrow(/^holds: limit: .*maxLength/);
    await expect(loadClaim(encode(scoreClaim([failingExample], 'item.score > 7.5')), sha256)).rejects.toBeInstanceOf(ClaimRejection);
  });

  it('has a shape the judge does not judge yet', async () => {
    await expect(loadClaim(encode({ ...scoreClaim([failingExample]), shape: 'pair' }), sha256)).rejects.toThrow(/only "set" is judged so far/);
  });
});
