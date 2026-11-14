// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findRepoLockfiles,
  hasPopulatedOsvCache,
  OsvScannerAdapter,
  probeOsvScannerVersion,
  runOsvScannerOffline,
  updateOsvDatabase,
} from '../../src/adapters/osv.js';

const temps: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'miqyas-osv-unit-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('osv-scanner adapter and update-db (Check 13, #17)', () => {
  it('downloads ecosystem zips into cacheDir, prints progress, and writes JSONL log entries', async () => {
    const dir = makeTmpDir();
    const cacheDir = path.join(dir, 'osv-cache');
    const logFile = path.join(cacheDir, 'update-db.log.jsonl');
    const requestedPaths: string[] = [];

    const srv = http.createServer((req, res) => {
      requestedPaths.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(Buffer.from(`PK-mock-osv-zip-${req.url}`));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const addr = srv.address() as { port: number };
    const progress: string[] = [];

    try {
      const res = await updateOsvDatabase({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        cacheDir,
        logFile,
        onProgress: (m) => progress.push(m),
      });
      expect(requestedPaths).toEqual(['/npm/all.zip', '/PyPI/all.zip']);
      expect(res.entries).toHaveLength(2);
      expect(hasPopulatedOsvCache(cacheDir)).toBe(true);

      const customOnlyDir = path.join(dir, 'custom-go-cache');
      mkdirSync(path.join(customOnlyDir, 'osv-scanner', 'Go'), { recursive: true });
      writeFileSync(path.join(customOnlyDir, 'osv-scanner', 'Go', 'all.zip'), 'PK');
      expect(hasPopulatedOsvCache(customOnlyDir)).toBe(true);
      await expect(updateOsvDatabase({ cacheDir, ecosystems: ['..'] })).rejects.toThrow(/invalid OSV ecosystem name/);
      expect(progress.some((p) => p.includes('/npm/all.zip'))).toBe(true);
      const logLines = readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { url: string; ecosystem: string; status: string });
      expect(logLines.map((l) => l.ecosystem)).toEqual(['npm', 'PyPI']);
      expect(logLines.every((l) => l.status === 'ok' && l.url.startsWith(`http://127.0.0.1:${addr.port}`))).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('discovers repo lockfiles, runs osv-scanner strictly with --offline, and classifies MAL/critical/high vs medium/low', async () => {
    const dir = makeTmpDir();
    const binDir = path.join(dir, 'bin');
    const cacheDir = path.join(dir, 'osv-cache');
    const repoDir = path.join(dir, 'repo');
    const argsLog = path.join(dir, 'osv-args.log');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(path.join(repoDir, 'node_modules', 'ignored'), { recursive: true });

    writeFileSync(path.join(repoDir, 'package-lock.json'), '{"name":"app","lockfileVersion":3}');
    writeFileSync(path.join(repoDir, 'node_modules', 'ignored', 'package-lock.json'), '{}');
    expect(await findRepoLockfiles(repoDir)).toEqual(['package-lock.json']);

    const shimPath = path.join(binDir, 'osv-scanner');
    writeFileSync(
      shimPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  process.stdout.write('osv-scanner version: 2.7.0\\n');
  process.exit(0);
}
const report = {
  results: [
    {
      source: { path: ${JSON.stringify(path.join(repoDir, 'package-lock.json'))}, type: 'lockfile' },
      packages: [
        {
          package: { name: 'evil-slopsquat', version: '1.0.0', ecosystem: 'npm' },
          vulnerabilities: [{ id: 'MAL-2026-0001', summary: 'Malicious install script', database_specific: { severity: 'LOW' }, aliases: [] }]
        },
        {
          package: { name: 'mild-pkg', version: '2.0.0', ecosystem: 'npm' },
          vulnerabilities: [{ id: 'GHSA-1111', summary: 'Moderate issue', database_specific: { severity: 'MODERATE' } }],
          groups: [{ ids: ['GHSA-1111'], max_severity: '5.3' }]
        },
        {
          package: { name: 'clean-pkg', version: '3.0.0', ecosystem: 'npm' },
          vulnerabilities: []
        }
      ]
    }
  ]
};
process.stdout.write(JSON.stringify(report));
process.exit(1);
`,
      'utf8',
    );
    chmodSync(shimPath, 0o755);

    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
    expect(await probeOsvScannerVersion({ env })).toBe('2.7.0');

    const res = await runOsvScannerOffline(repoDir, { env, cacheDir });
    expect(res.status).toBe('ok');
    expect(res.version).toBe('2.7.0');
    expect(res.lockfiles).toEqual(['package-lock.json']);
    expect(res.packageCount).toBe(3);
    expect(res.hits).toHaveLength(2);
    expect(res.hits[0]).toMatchObject({ id: 'MAL-2026-0001', isMalicious: true, failsCheck: true, severity: 'critical' });
    expect(res.hits[1]).toMatchObject({ id: 'GHSA-1111', isMalicious: false, failsCheck: false, severity: 'medium' });

    const loggedArgs = readFileSync(argsLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    const scanArgs = loggedArgs.find((a) => a.includes('--offline'))!;
    expect(scanArgs).toContain('--offline');
    expect(scanArgs).toContain('--all-packages');
    expect(scanArgs).toContain('--format=json');
    expect(scanArgs).not.toContain('--download-offline-databases');

    const adapterOut = await new OsvScannerAdapter({ env, cacheDir }).run({
      surface: 'web',
      url: 'http://127.0.0.1:3000/',
      runDir: dir,
      buildDir: repoDir,
    });
    expect(adapterOut.status).toBe('ok');
    expect(adapterOut.findings).toHaveLength(2);
  });

  it('reports missing binary, db_missing, and no_lockfiles cleanly', async () => {
    const dir = makeTmpDir();
    const repoWithLock = path.join(dir, 'with-lock');
    const emptyRepo = path.join(dir, 'empty-repo');
    mkdirSync(repoWithLock, { recursive: true });
    mkdirSync(emptyRepo, { recursive: true });
    writeFileSync(path.join(repoWithLock, 'requirements.txt'), 'flask==2.0.0\n');

    expect((await runOsvScannerOffline(emptyRepo, { env: { ...process.env, PATH: dir } })).status).toBe('no_lockfiles');
    expect((await runOsvScannerOffline(repoWithLock, { env: { ...process.env, PATH: dir } })).status).toBe('missing');

    const dbMissingBin = path.join(dir, 'bin-dbmiss');
    mkdirSync(dbMissingBin, { recursive: true });
    const shim = path.join(dbMissingBin, 'osv-scanner');
    writeFileSync(
      shim,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.7.0'); process.exit(0); }
process.stdout.write('{"results":null}');
console.error('no offline version of the OSV database is available');
process.exit(127);
`,
      'utf8',
    );
    chmodSync(shim, 0o755);
    const dbMissRes = await runOsvScannerOffline(repoWithLock, { env: { ...process.env, PATH: `${dbMissingBin}:${process.env.PATH ?? ''}` } });
    expect(dbMissRes.status).toBe('db_missing');
  });
});
