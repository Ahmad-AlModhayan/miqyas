// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// E2E verification for #17: miqyas update-db, offline zero-network Check 13 (osv-scanner) & Check 7 (libpg-query RLS),
// 3 Check 7 readiness seeds, 3 Check 13 readiness seeds, clean twin, and JSON schema validation.

import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import type { buildReport } from '../../src/proof-core/report.js';
import { schemaErrors } from '../report-helpers.js';

type Report = ReturnType<typeof buildReport>;

const FIXTURES_ROOT = path.resolve(import.meta.dirname, '../../corpus/fixtures/grade1-checks');

let tmp: string;
const servers: http.Server[] = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'miqyas-e2e-checks17-'));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) {
    await new Promise<void>((r) => s.close(() => r()));
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function startHtmlServer(html: string): Promise<string> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

function createGitleaksAndOsvShims(binDir: string, expectedCacheDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const gitleaks = path.join(binDir, 'gitleaks');
  writeFileSync(
    gitleaks,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'version') { console.log('8.30.1'); process.exit(0); }
const rpIdx = args.indexOf('--report-path');
if (rpIdx >= 0) fs.writeFileSync(args[rpIdx + 1], '[]');
process.exit(0);
`,
  );
  chmodSync(gitleaks, 0o755);

  const osv = path.join(binDir, 'osv-scanner');
  writeFileSync(
    osv,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.7.0'); process.exit(0); }
if (!args.includes('--offline') || !args.includes('--all-packages')) {
  console.error('forbidden online scan or missing --all-packages in e2e test');
  process.exit(2);
}
const cacheDir = process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY || ${JSON.stringify(expectedCacheDir)};
const zipPath = path.join(cacheDir, 'osv-scanner', 'npm', 'all.zip');
if (!fs.existsSync(zipPath)) {
  console.error('no local databases found');
  process.exit(127);
}
const rIdx = args.indexOf('-r');
const repoDir = rIdx >= 0 ? args[rIdx + 1] : process.cwd();
const lockPath = path.join(repoDir, 'package-lock.json');
const text = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : '';
const vulns = [];
if (text.includes('vuln-critical')) {
  vulns.push({
    pkg: { name: 'vuln-critical', version: '1.0.0', ecosystem: 'npm' },
    v: { id: 'GHSA-crit-0001', summary: 'Critical RCE in vuln-critical', database_specific: { severity: 'CRITICAL' } },
  });
}
if (text.includes('vuln-high')) {
  vulns.push({
    pkg: { name: 'vuln-high', version: '1.2.0', ecosystem: 'npm' },
    v: { id: 'GHSA-high-0002', summary: 'High auth bypass in vuln-high', database_specific: { severity: 'HIGH' } },
  });
}
if (text.includes('evil-mal-pkg')) {
  vulns.push({
    pkg: { name: 'evil-mal-pkg', version: '0.0.1', ecosystem: 'npm' },
    v: { id: 'MAL-2026-9999', summary: 'Malicious package evil-mal-pkg', database_specific: { severity: 'LOW' } },
  });
}
const report = vulns.length
  ? { results: [{ source: { path: lockPath, type: 'lockfile' }, packages: vulns.map((x) => ({ package: x.pkg, vulnerabilities: [x.v] })) }] }
  : {
      results: [
        {
          source: { path: lockPath, type: 'lockfile' },
          packages: [{ package: { name: 'safe-lib', version: '2.1.0', ecosystem: 'npm' }, vulnerabilities: [] }],
        },
      ],
    };
process.stdout.write(JSON.stringify(report));
process.exit(vulns.length ? 1 : 0);
`,
  );
  chmodSync(osv, 0o755);
}

function stageFixtureRepo(name: string): string {
  const dest = path.join(tmp, 'repos', name);
  cpSync(path.join(FIXTURES_ROOT, name), dest, { recursive: true });
  execFileSync('git', ['init'], { cwd: dest, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'ci@kahflabs.example'], { cwd: dest, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Kahf CI'], { cwd: dest, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: dest, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', `fixture ${name}`], { cwd: dest, stdio: 'ignore' });
  return dest;
}

describe('Checks 7 & 13 readiness seeds, clean twin, and offline update-db e2e (#17)', () => {
  it('downloads OSV DB via update-db, makes zero OSV network requests during verification, passes clean twin, and catches all 6 seeds', async () => {
    // 1. Download offline OSV database via `miqyas update-db` from local fixture server
    const requestedUrls: string[] = [];
    const dbSrv = http.createServer((req, res) => {
      requestedUrls.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(Buffer.from(`PK\x03\x04osv-offline-db-${req.url}`));
    });
    servers.push(dbSrv);
    await new Promise<void>((r) => dbSrv.listen(0, '127.0.0.1', () => r()));
    const dbAddr = dbSrv.address() as { port: number };
    const dbCacheDir = path.join(tmp, 'osv-cache');
    mkdirSync(dbCacheDir, { recursive: true });

    const updateExit = await main(
      ['update-db', '--ecosystems', 'npm,PyPI', '--db-dir', dbCacheDir, '--json'],
      { osvBaseUrl: `http://127.0.0.1:${dbAddr.port}` },
    );
    expect(updateExit).toBe(0);
    expect(requestedUrls).toEqual(['/npm/all.zip', '/PyPI/all.zip']);
    expect(existsSync(path.join(dbCacheDir, 'osv-scanner', 'npm', 'all.zip'))).toBe(true);
    expect(existsSync(path.join(dbCacheDir, 'osv-scanner', 'PyPI', 'all.zip'))).toBe(true);
    expect(existsSync(path.join(dbCacheDir, 'update-db.log.jsonl'))).toBe(true);

    // 2. Prepare trap server & point OSV env vars so ANY network OSV call fails the test immediately
    let trapHits = 0;
    const trapSrv = http.createServer((_req, res) => {
      trapHits++;
      res.writeHead(500);
      res.end('unexpected network OSV access during verification');
    });
    servers.push(trapSrv);
    await new Promise<void>((r) => trapSrv.listen(0, '127.0.0.1', () => r()));
    const trapAddr = trapSrv.address() as { port: number };

    const binDir = path.join(tmp, 'bin');
    createGitleaksAndOsvShims(binDir, dbCacheDir);

    const prevPath = process.env.PATH;
    const prevCache = process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY;
    const prevOsvBase = process.env.OSV_DB_BASE_URL;
    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY = dbCacheDir;
    process.env.OSV_DB_BASE_URL = `http://127.0.0.1:${trapAddr.port}`;

    try {
      const cleanTwinDir = stageFixtureRepo('clean-twin');
      const appUrl = await startHtmlServer(readFileSync(path.join(cleanTwinDir, 'index.html'), 'utf8'));

      // 3. Clean twin passes Checks 5, 6, 7, 13 with zero findings and valid schema
      const cleanOut = path.join(tmp, 'out-clean');
      const cleanCode = await main([
        'run',
        '--profile',
        'grade-1',
        '--url',
        appUrl,
        '--repo',
        cleanTwinDir,
        '--no-model',
        '--out',
        cleanOut,
      ]);
      expect([0, 1]).toContain(cleanCode);
      const cleanReport = JSON.parse(readFileSync(path.join(cleanOut, 'report.json'), 'utf8')) as Report;
      expect(schemaErrors('report', cleanReport)).toEqual([]);
      expect(cleanReport.findings ?? []).toEqual([]);
      expect((cleanReport.method.adapters ?? []).map((a) => a.id)).toEqual(
        expect.arrayContaining(['gitleaks', 'libpg-query', 'osv-scanner']),
      );
      expect(cleanReport.readiness!.checks.find((c) => c.number === 5)?.verdict).toBe('pass');
      expect(cleanReport.readiness!.checks.find((c) => c.number === 6)?.verdict).toBe('pass');
      const c7Clean = cleanReport.readiness!.checks.find((c) => c.number === 7)!;
      const c13Clean = cleanReport.readiness!.checks.find((c) => c.number === 13)!;
      expect(c7Clean.verdict).toBe('pass');
      expect(c7Clean.coverage).toContain('1 public table(s) parsed');
      expect(c13Clean.verdict).toBe('pass');
      expect(c13Clean.coverage).toContain('1 lockfile(s)');
      expect(c13Clean.coverage).toContain('1 package(s)');

      // 4. All 3 Check 7 SQL migration seeds fail Check 7 with linked missing-rls findings
      for (const seedName of ['seed-rls-missing', 'seed-rls-disabled', 'seed-rls-unqualified']) {
        const outDir = path.join(tmp, `out-${seedName}`);
        const repoDir = stageFixtureRepo(seedName);
        const code = await main([
          'run',
          '--profile',
          'grade-1',
          '--url',
          appUrl,
          '--repo',
          repoDir,
          '--no-model',
          '--out',
          outDir,
        ]);
        expect(code).toBe(1);
        const rep = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as Report;
        expect(schemaErrors('report', rep)).toEqual([]);
        const check7 = rep.readiness!.checks.find((c) => c.number === 7)!;
        expect(check7.verdict).toBe('fail');
        expect(check7.evidenceIds?.length).toBeGreaterThan(0);
        const linked = (rep.findings ?? []).filter((f) => check7.evidenceIds!.includes(f.id));
        expect(linked.some((f) => f.category === 'missing-rls')).toBe(true);
      }

      // 5. All 3 Check 13 OSV seeds fail Check 13 with linked vulnerable-dependency findings
      for (const seedName of ['seed-osv-critical', 'seed-osv-high', 'seed-osv-mal']) {
        const outDir = path.join(tmp, `out-${seedName}`);
        const repoDir = stageFixtureRepo(seedName);
        const code = await main([
          'run',
          '--profile',
          'grade-1',
          '--url',
          appUrl,
          '--repo',
          repoDir,
          '--no-model',
          '--out',
          outDir,
        ]);
        expect(code).toBe(1);
        const rep = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as Report;
        expect(schemaErrors('report', rep)).toEqual([]);
        const check13 = rep.readiness!.checks.find((c) => c.number === 13)!;
        expect(check13.verdict).toBe('fail');
        expect(check13.evidenceIds?.length).toBeGreaterThan(0);
        const linked = (rep.findings ?? []).filter((f) => check13.evidenceIds!.includes(f.id));
        expect(linked.some((f) => f.category === 'vulnerable-dependency')).toBe(true);
      }

      expect(trapHits).toBe(0);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevCache === undefined) delete process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY;
      else process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY = prevCache;
      if (prevOsvBase === undefined) delete process.env.OSV_DB_BASE_URL;
      else process.env.OSV_DB_BASE_URL = prevOsvBase;
    }
  }, 60_000);
});
