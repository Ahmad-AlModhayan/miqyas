// SPDX-License-Identifier: AGPL-3.0-only
// Check 13's collectors (docs/FOUNDATION.md §3): given the lockfiles of a seed fixture and the osv result the adapter
// gives for it, the facts they record through a recorder over a store in memory. The recorder and the kernel are real.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoLockfiles } from '../../src/adapters/osv.js';
import { recordLockfiles, recordOsvScan } from '../../src/collectors/dependencies.js';
import { openRecorder } from '../../src/engine/recorder.js';
import { readLedger } from '../../src/kernel/ledger.js';
import { MemoryStore, sha256 } from '../kernel-helpers.js';

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
    const lockfiles = await findRepoLockfiles(SEED);
    const placed = await recordLockfiles(recorder, 'repository', { lockfiles });
    expect(placed.map((p) => p.seq)).toEqual([1, 2]);
    const records = (await readLedger(store)).records.slice(1);
    expect(records.map((r) => [r.t, r.body])).toEqual([
      ['fact', { kind: 'repo.file', v: 1, by: 'lockfile-reader@1', run: 1, subject: 'repository', body: { path: 'package-lock.json', role: 'lockfile' } }],
      [
        'fact',
        {
          kind: 'collection',
          v: 1,
          by: 'lockfile-reader@1',
          run: 1,
          subject: 'repository',
          body: { setOut: 'every supported lockfile in the repository', status: 'complete', counts: { lockfiles: 1 }, dropped: 0 },
        },
      ],
    ]);
  });

  it('the osv adapter records the tool run, each advisory with its package and severity, and its collection; no verdict, no path, no float', async () => {
    const { store, recorder } = await recorderOverMemory();
    const placed = await recordOsvScan(recorder, 'repository', criticalScan(await findRepoLockfiles(SEED)));
    expect(placed.map((p) => p.fact.kind)).toEqual(['tool.run', 'dep.advisory', 'collection']);
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
        counts: { lockfiles: 1, scanned: 1, packages: 1, advisories: 1 },
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
          counts: { lockfiles: 1, scanned: 0, packages: 0, advisories: 0 },
          dropped: 0,
        },
      ],
    ]);
  });

  it('cuts a path a tool gives as absolute to its last part', async () => {
    const { recorder } = await recorderOverMemory();
    const placed = await recordLockfiles(recorder, 'repository', { lockfiles: [path.join(SEED, 'package-lock.json'), 'apps/web/yarn.lock'] });
    expect(placed.slice(0, 2).map((p) => (p.fact.body as { path: string }).path)).toEqual(['package-lock.json', 'apps/web/yarn.lock']);
  });
});
