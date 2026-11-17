// SPDX-License-Identifier: AGPL-3.0-only
// Check 13 on the new path, end to end over the fixtures (docs/FOUNDATION.md §15): for every osv seed fixture and the
// clean twin, the verdict the new path records equals the verdict the current path gives for the same input, with
// the same osv-scanner stand-in. Both paths run here; nothing is copied from a report. Real folders, real kernel.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCheck13 } from '../../src/entry/check13.js';
import { runWithProofBundle } from '../../src/entry/proof-bundle.js';
import { verifyBundle } from '../../src/entry/verify.js';
import { sealResult } from '../../src/kernel/judge.js';
import { evaluateCheck13Dependencies } from '../../src/proof-core/readiness.js';
import { envWithBin, writeScannerShim } from '../scanner-shim.js';

const FIXTURES = path.resolve(import.meta.dirname, '../../corpus/fixtures/grade1-checks');

/** The stand-in of the readiness e2e test: advisories by the package names in package-lock.json, or no database. */
const OSV_SHIM = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.7.0'); process.exit(0); }
if (process.env.SHIM_NO_DB === '1') { console.error('no local databases found'); process.exit(127); }
const repoDir = args[args.indexOf('-r') + 1];
const lockPath = path.join(repoDir, 'package-lock.json');
const text = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : '';
const vulns = [];
if (text.includes('vuln-critical')) vulns.push({ pkg: { name: 'vuln-critical', version: '1.0.0', ecosystem: 'npm' }, v: { id: 'GHSA-crit-0001', summary: 'Critical RCE', database_specific: { severity: 'CRITICAL' } } });
if (text.includes('vuln-high')) vulns.push({ pkg: { name: 'vuln-high', version: '1.2.0', ecosystem: 'npm' }, v: { id: 'GHSA-high-0002', summary: 'High auth bypass', database_specific: { severity: 'HIGH' } } });
if (text.includes('evil-mal-pkg')) vulns.push({ pkg: { name: 'evil-mal-pkg', version: '0.0.1', ecosystem: 'npm' }, v: { id: 'MAL-2026-9999', summary: 'Malicious package', database_specific: { severity: 'LOW' } } });
const packages = vulns.length
  ? vulns.map((x) => ({ package: x.pkg, vulnerabilities: [x.v] }))
  : [{ package: { name: 'safe-lib', version: '2.1.0', ecosystem: 'npm' }, vulnerabilities: [] }];
process.stdout.write(JSON.stringify({ results: [{ source: { path: lockPath, type: 'lockfile' }, packages }] }));
process.exit(vulns.length ? 1 : 0);
`;

let tmp: string;
let env: NodeJS.ProcessEnv;
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'miqyas-check13-'));
  const bin = path.join(tmp, 'bin');
  writeScannerShim(bin, 'osv-scanner', OSV_SHIM);
  env = envWithBin(bin);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Recorded {
  t: string;
  seq: number;
  body: { kind?: string; body?: Record<string, unknown>; verdict?: string; shown?: number[]; read?: number[] } & Record<string, unknown>;
}

/** Runs check 13 on the new path into a bundle, and returns the bundle's folder and its records. */
async function newPath(name: string, repoPath: string, runEnv: NodeJS.ProcessEnv) {
  const dir = path.join(tmp, 'bundles', name);
  await runWithProofBundle({ dir, runId: name, open: { format: 1 }, print: () => undefined }, async (recorder) => {
    const verdict = await runCheck13(recorder, { repoPath, osv: { env: runEnv } });
    return { result: verdict, fold: sealResult([verdict.verdict]) };
  });
  const ledger = readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8');
  const records = ledger.trim().split('\n').map((l) => JSON.parse(l) as Recorded);
  return { dir, ledger, records };
}

const cases = [
  { fixture: 'seed-osv-critical', shown: 'GHSA-crit-0001' },
  { fixture: 'seed-osv-high', shown: 'GHSA-high-0002' },
  { fixture: 'seed-osv-mal', shown: 'MAL-2026-9999' },
  { fixture: 'clean-twin', shown: undefined },
];

describe('check 13: the new path gives the current path verdict', { timeout: 300_000 }, () => {
  for (const { fixture, shown } of cases) {
    it(`on ${fixture}`, async () => {
      const repo = path.join(tmp, 'repos', fixture);
      cpSync(path.join(FIXTURES, fixture), repo, { recursive: true });

      const current = (await evaluateCheck13Dependencies({ repoPath: repo, osv: { env } })).check.verdict;
      const { dir, ledger, records } = await newPath(fixture, repo, env);
      const verdict = records.find((r) => r.t === 'verdict')!;
      expect(verdict.body.verdict).toBe(current);

      // The advisories shown are the counterexamples, by their ledger positions; the facts read include them.
      const advisories = records.filter((r) => r.t === 'fact' && r.body.kind === 'dep.advisory');
      const shownIds = (verdict.body.shown ?? []).map((seq) => records[seq]!.body.body!.id);
      expect(shownIds).toEqual(shown === undefined ? [] : [shown]);
      expect(verdict.body.read).toEqual(expect.arrayContaining(advisories.map((a) => a.seq)));
      expect(records.map((r) => r.t)).toEqual(['run.open', 'claim', 'fact', 'fact', 'fact', ...advisories.map(() => 'fact'), 'fact', 'verdict', 'run.seal']);

      expect(ledger).not.toContain(tmp);
      expect(ledger).not.toMatch(/(^|[^A-Za-z])[A-Za-z]:[\\/]/);
      const report = await verifyBundle(dir);
      expect(report.lines).toContain('1. Intact? yes');
      expect(report.lines).toContain('2. Does the result follow? yes');
    });
  }

  it('and when the offline database is missing, both say not checked', async () => {
    const repo = path.join(tmp, 'repos', 'no-db');
    cpSync(path.join(FIXTURES, 'seed-osv-critical'), repo, { recursive: true });
    const noDb = { ...env, SHIM_NO_DB: '1' };
    const current = (await evaluateCheck13Dependencies({ repoPath: repo, osv: { env: noDb } })).check.verdict;
    expect(current).toBe('not_checked');
    const { records } = await newPath('no-db', repo, noDb);
    const verdict = records.find((r) => r.t === 'verdict')!;
    expect(verdict.body.verdict).toBe(current);
    expect(verdict.body.reason).toBe('coverage not met');
  });
});
