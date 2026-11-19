// SPDX-License-Identifier: AGPL-3.0-only
// Check 13's collectors (docs/FOUNDATION.md §3): given the lockfiles of a seed fixture and the osv result the adapter
// gives for it, the facts they record through a recorder over a store in memory. The recorder and the kernel are real.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoLockfiles } from '../../src/adapters/osv.js';
import { type LockfilesFound, type OsvScan, recordLockfiles, recordOsvScan } from '../../src/collectors/dependencies.js';
import { checkFact } from '../../src/engine/fact-check.js';
import { openRecorder } from '../../src/engine/recorder.js';
import type { PlacedFact } from '../../src/kernel/fact.js';
import { readLedger } from '../../src/kernel/ledger.js';
import { MemoryStore, collectionFact, sha256 } from '../kernel-helpers.js';

const SEED = path.resolve(import.meta.dirname, '../../corpus/fixtures/grade1-checks/seed-osv-critical');

async function recorderOverMemory() {
  const store = new MemoryStore();
  const recorder = await openRecorder(store, sha256, { origin: 'test-run', open: { format: 1 }, now: () => new Date(Date.UTC(2026, 10, 18)) });
  return { store, recorder };
}

/** What runOsvScannerOffline gives for the critical seed with the scanner stand-in: an absolute database folder and summary included. */
const criticalScan = (lockfiles: string[]) => ({
  status: 'ok' as const,
  version: '2.7.0',
  lockfiles,
  packageCount: 1,
  hits: [
    {
      id: 'GHSA-crit-0001',
      aliases: [],
      isMalicious: false,
      failsCheck: true,
      severity: 'critical' as const,
      maxCvss: 9.8,
      packageName: 'vuln-critical',
      packageVersion: '1.0.0',
      ecosystem: 'npm',
      sourcePath: 'package-lock.json',
      summary: 'Critical RCE in vuln-critical',
      fixedVersions: [],
    },
  ],
  coverage: `1 lockfile(s) (package-lock.json), 1 package(s) scanned offline via osv-scanner 2.7.0`,
  cacheDir: path.join(SEED, 'osv-cache'),
});

describe("check 13's collectors", () => {
  it('the lockfile reader records each lockfile found, relative, and closes with its collection fact', async () => {
    const { store, recorder } = await recorderOverMemory();
    const lockfiles = await findRepoLockfiles(SEED); // relative to the repository, with "/", as the adapter gives them
    const placed = await recordLockfiles(recorder, 'repository', { lockfiles });
    expect(placed.map((p) => p.seq)).toEqual([1, 2]);
    const records = (await readLedger(store)).records.slice(1);
    expect(records.map((r) => [r.t, r.body])).toEqual([
      ['fact', { kind: 'repo.file', v: 1, by: 'lockfile-reader@1', run: 1, subject: 'repository', body: { path: 'package-lock.json', role: 'lockfile' } }],
      [
        'fact',
        collectionFact({
          by: 'lockfile-reader@1',
          subject: 'repository',
          setOut: 'every supported lockfile in the repository',
          counts: { lockfiles: 1 },
          listed: { lockfiles: ['package-lock.json'] },
        }),
      ],
    ]);
  });

  it('the osv adapter records the tool run, each advisory with its package and severity, and its collection; no verdict, no path, no float', async () => {
    const { store, recorder } = await recorderOverMemory();
    const placed = await recordOsvScan(recorder, 'repository', criticalScan(await findRepoLockfiles(SEED)));
    expect(placed.map((p) => p.fact.kind)).toEqual(['tool.run', 'dep.advisory', 'collection']);
    // The severity is the adapter's classification; the score it came from is not kept, so the fact says so.
    expect(placed.map((p) => p.fact.withheld)).toEqual([undefined, ['severity'], undefined]);
    expect((await readLedger(store)).records[2]!.body).toMatchObject({ kind: 'dep.advisory', withheld: ['severity'] });
    const bodies = (await readLedger(store)).records.slice(1).map((r) => (r.body as { body: unknown }).body);
    expect(bodies).toEqual([
      { tool: 'osv-scanner', version: '2.7.0', finished: true, outcome: 'ok' },
      {
        id: 'GHSA-crit-0001',
        aliases: [],
        malicious: false,
        severity: 'critical',
        package: { name: 'vuln-critical', version: '1.0.0', ecosystem: 'npm' },
        lockfile: 'package-lock.json',
        fixed: [],
      },
      {
        setOut: 'every lockfile found, against the offline vulnerability database',
        status: 'complete',
        counts: { lockfiles: 1, packages: 1, advisories: 1 },
        listed: { lockfiles: ['package-lock.json'] },
        dropped: 0,
      },
    ]);
    const ledger = store.textOf('ledger.jsonl');
    expect(ledger).not.toContain(SEED);
    expect(ledger).not.toMatch(/failsCheck|"pass"|"fail"|verdict/);
    expect(ledger).not.toMatch(/:-?\d+\.\d+[,}\]]/); // the adapter's CVSS score is a fraction and is left out
    expect(ledger).not.toContain('Critical RCE');
  });

  it('a scan that could not run closes failed, with its reason and no advisory', async () => {
    const { recorder } = await recorderOverMemory();
    const placed = await recordOsvScan(recorder, 'repository', { ...criticalScan(['package-lock.json']), status: 'db_missing', hits: [], packageCount: 0 });
    expect(placed.map((p) => [p.fact.kind, p.fact.body])).toEqual([
      ['tool.run', { tool: 'osv-scanner', version: '2.7.0', finished: false, outcome: 'db_missing' }],
      [
        'collection',
        {
          setOut: 'every lockfile found, against the offline vulnerability database',
          status: 'failed',
          reason: 'the offline vulnerability database is not present',
          counts: { lockfiles: 1, packages: 0, advisories: 0 },
          listed: { lockfiles: ['package-lock.json'] },
          dropped: 0,
        },
      ],
    ]);
  });

  it('records a lockfile by its path relative to the repository, with forward slashes', async () => {
    const { recorder } = await recorderOverMemory();
    const placed = await recordLockfiles(recorder, 'repository', { lockfiles: ['apps\\web\\yarn.lock', 'apps/api/yarn.lock', 'package-lock.json'] });
    expect(placed.slice(0, 3).map((p) => (p.fact.body as { path: string }).path)).toEqual(['apps/web/yarn.lock', 'apps/api/yarn.lock', 'package-lock.json']);
    const scan = await recordOsvScan(recorder, 'repository', { ...criticalScan([]), hits: [{ ...criticalScan([]).hits[0]!, sourcePath: 'apps\\web\\package-lock.json' }] });
    expect((scan[1]!.fact.body as { lockfile: string }).lockfile).toBe('apps/web/package-lock.json');
  });

  it('both collectors list the lockfiles they saw by the same paths in the same order, so equal sets give equal lists', async () => {
    // Two looks at one repository, the files given in different orders and with either slash: the lists recorded match.
    const looks = [
      ['apps\\web\\yarn.lock', 'package-lock.json', 'apps/api/yarn.lock', 'Zed/pnpm-lock.yaml'],
      ['Zed\\pnpm-lock.yaml', 'apps/api/yarn.lock', 'package-lock.json', 'apps/web/yarn.lock'],
    ];
    const expected = ['Zed/pnpm-lock.yaml', 'apps/api/yarn.lock', 'apps/web/yarn.lock', 'package-lock.json']; // by code unit, not by locale
    const listed = (placed: PlacedFact[]) => (placed.at(-1)!.fact.body as { listed: { lockfiles: string[] } }).listed.lockfiles;
    for (const lockfiles of looks) {
      expect(listed(await recordLockfiles((await recorderOverMemory()).recorder, 'repository', { lockfiles }))).toEqual(expected);
      expect(listed(await recordOsvScan((await recorderOverMemory()).recorder, 'repository', { ...criticalScan(lockfiles), hits: [] }))).toEqual(expected);
    }
    // A run that found nothing, or could not look, lists nothing.
    expect(listed(await recordLockfiles((await recorderOverMemory()).recorder, 'repository', { failed: 'the repository folder does not exist' }))).toEqual([]);
    expect(listed(await recordOsvScan((await recorderOverMemory()).recorder, 'repository', { failed: 'there was no repository to scan' }))).toEqual([]);
  });

  it('on every way a scan can end, each run records facts that match their kinds and ends with its collection fact', async () => {
    const scans: OsvScan[] = [
      criticalScan(['package-lock.json']),
      { ...criticalScan([]), status: 'no_lockfiles', version: null, hits: [], packageCount: 0 },
      { ...criticalScan([]), status: 'missing', version: null, hits: [], packageCount: 0 },
      { ...criticalScan(['package-lock.json']), status: 'error', hits: [] },
      { failed: 'there was no repository to scan' },
    ];
    const founds: LockfilesFound[] = [{ lockfiles: ['package-lock.json', 'apps/web/yarn.lock'] }, { lockfiles: [] }, { failed: 'the repository folder does not exist' }];
    const runs: PlacedFact[][] = [];
    for (const scan of scans) runs.push(await recordOsvScan((await recorderOverMemory()).recorder, 'repository', scan));
    for (const found of founds) runs.push(await recordLockfiles((await recorderOverMemory()).recorder, 'repository', found));
    for (const placed of runs) {
      for (const p of placed) expect(checkFact(p.fact)).toEqual({ ok: true });
      expect(placed.map((p) => p.fact.kind).filter((k) => k === 'collection')).toEqual(['collection']);
      expect(placed.at(-1)!.fact.kind).toBe('collection');
    }
  });

  it('refuses a path that is absolute or leaves the repository, and records nothing of it', async () => {
    // The two made-up forms are as short as they can be: a leading slash, and a drive letter. Off Windows nothing
    // else reaches the refusal of a drive letter.
    for (const bad of [path.join(SEED, 'package-lock.json'), '/package-lock.json', 'Z:\\yarn.lock', '../package-lock.json']) {
      const { store, recorder } = await recorderOverMemory();
      await expect(recordLockfiles(recorder, 'repository', { lockfiles: [bad] })).rejects.toThrow(/is not a path relative to the repository/);
      await expect(recordOsvScan(recorder, 'repository', { ...criticalScan([]), hits: [{ ...criticalScan([]).hits[0]!, sourcePath: bad }] })).rejects.toThrow(
        /is not a path relative to the repository/,
      );
      await expect(recordOsvScan(recorder, 'repository', { ...criticalScan([bad]), hits: [] })).rejects.toThrow(/is not a path relative to the repository/);
      expect(store.textOf('ledger.jsonl')).not.toContain('package-lock');
      expect(store.textOf('ledger.jsonl')).not.toContain('yarn');
    }
  });
});
