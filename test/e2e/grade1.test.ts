// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import type { RunReport } from '../../src/proof-core/report.js';
import { schemaErrors } from '../report-helpers.js';

let tmp = '';

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'miqyas-e2e-grade1-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function startFixtureServer(
  routes: Record<string, { type: string; body: string; status?: number; headers?: Record<string, string> }>,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const srv = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const hit = routes[pathname];
    if (!hit) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(hit.status ?? 200, { 'content-type': hit.type, ...(hit.headers ?? {}) });
    res.end(hit.body);
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

function createGitRepo(baseDir: string, commitFiles: Record<string, string>, untracked: Record<string, string> = {}): string {
  mkdirSync(baseDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: baseDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'ci@kahflabs.example'], { cwd: baseDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Kahf CI'], { cwd: baseDir, stdio: 'ignore' });
  for (const [name, content] of Object.entries(commitFiles)) {
    const full = path.join(baseDir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  execFileSync('git', ['add', '.'], { cwd: baseDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: baseDir, stdio: 'ignore' });
  for (const [name, content] of Object.entries(untracked)) {
    const full = path.join(baseDir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return baseDir;
}

function createGitleaksShim(binDir: string, opts: { dirFindings?: unknown[]; gitFindings?: unknown[] }): string {
  mkdirSync(binDir, { recursive: true });
  const shim = path.join(binDir, 'gitleaks');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'version') {
  process.stdout.write('8.30.1\\n');
  process.exit(0);
}
if (!args.includes('--redact')) {
  process.stderr.write('expected --redact flag\\n');
  process.exit(2);
}
const rpIdx = args.indexOf('--report-path');
const rp = rpIdx >= 0 ? args[rpIdx + 1] : null;
const list = args[0] === 'git' ? ${JSON.stringify(opts.gitFindings ?? [])} : ${JSON.stringify(opts.dirFindings ?? [])};
if (rp) fs.writeFileSync(rp, JSON.stringify(list));
process.exit(list.length ? 1 : 0);
`;
  writeFileSync(shim, script, 'utf8');
  chmodSync(shim, 0o755);
  return binDir;
}

describe('Grade 1 readiness profile e2e (#16)', () => {
  it('marks Checks 5 & 6 not_checked with setup guidance when gitleaks binary is missing on PATH', async () => {
    const srv = await startFixtureServer({
      '/': { type: 'text/html', body: '<!doctype html><html><body><h1>Clean App</h1></body></html>' },
    });
    const repoDir = createGitRepo(path.join(tmp, 'repo-missing-bin'), { 'src/index.ts': 'export const ok = 1;\n' });
    const emptyBin = path.join(tmp, 'empty-bin');
    mkdirSync(emptyBin, { recursive: true });
    const outDir = path.join(tmp, 'run-missing-bin');
    const prevPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      const code = await main(['run', '--profile', 'grade-1', '--url', srv.url, '--repo', repoDir, '--no-model', '--out', outDir]);
      expect(code).toBe(1);
    } finally {
      process.env.PATH = prevPath;
      await srv.close();
    }

    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as RunReport;
    expect(schemaErrors('report', report)).toEqual([]);
    expect(report.readiness?.status).toBe('not_ready');
    const c5 = report.readiness?.checks.find((c) => c.number === 5);
    const c6 = report.readiness?.checks.find((c) => c.number === 6);
    expect(c5?.verdict).toBe('not_checked');
    expect(c6?.verdict).toBe('not_checked');
    expect(report.readiness?.whatToAdd.some((w) => /gitleaks/i.test(w))).toBe(true);
  }, 60_000);

  it('passes Checks 5 & 6 via gitleaks shim on clean bundle/source-map/repo, keeps generic hits as findings, and makes zero model calls under --no-model', async () => {
    let modelRequests = 0;
    const modelTrap = http.createServer((_req, res) => {
      modelRequests++;
      res.writeHead(500);
      res.end('should not be called');
    });
    await new Promise<void>((resolve) => modelTrap.listen(0, '127.0.0.1', () => resolve()));
    const trapPort = (modelTrap.address() as { port: number }).port;
    const trapUrl = `http://127.0.0.1:${trapPort}`;

    const srv = await startFixtureServer({
      '/': {
        type: 'text/html',
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notes</title></head><body><main><h1>Notes</h1></main><script src="/app.js"></script></body></html>',
      },
      '/app.js': {
        type: 'application/javascript',
        body: 'window.__ok = 1;\n//# sourceMappingURL=/app.js.map\n',
      },
      '/app.js.map': {
        type: 'application/json',
        body: '{"version":3,"sources":["app.ts"],"names":[],"mappings":"AAAA"}',
      },
    });
    const repoDir = createGitRepo(path.join(tmp, 'repo-clean-shim'), { 'app.ts': 'export const app = 1;\n' });
    const binDir = createGitleaksShim(path.join(tmp, 'bin-generic'), {
      dirFindings: [
        { RuleID: 'generic-api-key', Description: 'Generic API Key', File: 'app.js', StartLine: 1, Match: 'REDACTED', Secret: 'REDACTED' },
      ],
      gitFindings: [],
    });
    const outDir = path.join(tmp, 'run-clean-shim');

    const prevPath = process.env.PATH;
    const prevAntUrl = process.env.ANTHROPIC_BASE_URL;
    const prevOaiUrl = process.env.OPENAI_BASE_URL;
    const prevAntKey = process.env.ANTHROPIC_API_KEY;
    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    process.env.ANTHROPIC_BASE_URL = trapUrl;
    process.env.OPENAI_BASE_URL = trapUrl;
    process.env.ANTHROPIC_API_KEY = 'dummy-unused-under-no-model';

    try {
      const code = await main(['run', '--profile', 'grade-1', '--url', srv.url, '--repo', repoDir, '--no-model', '--out', outDir]);
      expect(code).toBe(1); // remaining 8 checks stay not_checked until #19-#21
    } finally {
      process.env.PATH = prevPath;
      if (prevAntUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prevAntUrl;
      if (prevOaiUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prevOaiUrl;
      if (prevAntKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAntKey;
      await srv.close();
      await new Promise<void>((resolve) => modelTrap.close(() => resolve()));
    }

    expect(modelRequests).toBe(0);
    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as RunReport;
    expect(schemaErrors('report', report)).toEqual([]);
    expect(report.usage).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
    expect(report.spend?.actualUsd).toBe(0);
    expect(report.method.adapters?.[0]).toMatchObject({ id: 'gitleaks', version: '8.30.1', status: 'ok' });
    expect(report.readiness?.counts).toEqual({ total: 13, passed: 5, failed: 0, notChecked: 8 });
    expect(report.readiness?.summary).toBe('Grade 1: not ready (5 of 13 pass, 0 fail, 8 not checked)');
    expect(report.readiness?.checks.find((c) => c.number === 5)?.verdict).toBe('pass');
    expect(report.readiness?.checks.find((c) => c.number === 6)?.verdict).toBe('pass');
    expect(report.findings?.some((f) => f.title.includes('generic gitleaks match'))).toBe(true);

    const md = readFileSync(path.join(outDir, 'report.md'), 'utf8');
    expect(md).toContain('Grade 1: not ready (5 of 13 pass, 0 fail, 8 not checked)');
    expect(md).toContain('gitleaks 8.30.1');
    expect(md).toContain('not a penetration test');
    expect(md).not.toMatch(/\/100\b|out of 100/i);
  }, 60_000);

  it('fails Check 5 when a known secret leaks in a served source map or localStorage and fails Check 6 when git history contains a known secret', async () => {
    const leakedMapKey = ['sk', 'live', '51TestFixtureKey1234567890abcdef'].join('_');
    const leakedRepoKey = ['sb', 'secret', 'RepoHistoryFixtureKey0123456'].join('_');

    const srv = await startFixtureServer({
      '/': {
        type: 'text/html',
        body: `<!doctype html><html><body><h1>Leak</h1><script>localStorage.setItem('tok', '${leakedMapKey}');</script><script src="/bundle.js"></script></body></html>`,
      },
      '/bundle.js': {
        type: 'application/javascript',
        body: 'console.log("ok");\n//# sourceMappingURL=/bundle.js.map\n',
      },
      '/bundle.js.map': {
        type: 'application/json',
        body: JSON.stringify({ version: 3, sourcesContent: [`const k = "${leakedMapKey}";`] }),
      },
    });
    const repoDir = createGitRepo(
      path.join(tmp, 'repo-leak'),
      { 'secrets.ts': `export const srv = "${leakedRepoKey}";\n` },
    );
    const binDir = createGitleaksShim(path.join(tmp, 'bin-clean'), { dirFindings: [], gitFindings: [] });
    const outDir = path.join(tmp, 'run-leaks');
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ''}`;

    try {
      const code = await main(['run', '--profile', 'grade-1', '--url', srv.url, '--repo', repoDir, '--no-model', '--out', outDir]);
      expect(code).toBe(1);
    } finally {
      process.env.PATH = prevPath;
      await srv.close();
    }

    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as RunReport;
    expect(schemaErrors('report', report)).toEqual([]);
    const check5 = report.readiness?.checks.find((c) => c.number === 5);
    const check6 = report.readiness?.checks.find((c) => c.number === 6);
    expect(check5?.verdict).toBe('fail');
    expect(check6?.verdict).toBe('fail');
    const findingIds = new Set((report.findings ?? []).map((f) => f.id));
    for (const eid of [...(check5?.evidenceIds ?? []), ...(check6?.evidenceIds ?? [])]) {
      expect(findingIds.has(eid)).toBe(true);
    }
    const rawReportText = readFileSync(path.join(outDir, 'report.json'), 'utf8');
    expect(rawReportText).not.toContain(leakedMapKey);
    expect(rawReportText).not.toContain(leakedRepoKey);
  }, 60_000);

  it('exits 0 on --profile grade-1 --dry-run and marks Check 5 not_checked on unreachable --url', async () => {
    const dryOut = path.join(tmp, 'dry-grade1');
    const dryCode = await main(['run', '--profile', 'grade-1', '--url', 'http://127.0.0.1:1', '--dry-run', '--out', dryOut]);
    expect(dryCode).toBe(0);
    const dryReport = JSON.parse(readFileSync(path.join(dryOut, 'report.json'), 'utf8')) as RunReport;
    expect(schemaErrors('report', dryReport)).toEqual([]);
    expect(dryReport.verdict).toBe('dry_run');
    expect(dryReport.readiness?.checks.every((c) => c.verdict === 'not_checked')).toBe(true);

    // Unreachable URL in non-dry-run must NOT falsely pass Check 5 (crawler skips failed navigation -> 0 screens).
    const binDir = createGitleaksShim(path.join(tmp, 'bin-unreach'), { dirFindings: [], gitFindings: [] });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    const unreachOut = path.join(tmp, 'unreach-grade1');
    try {
      const code = await main(['run', '--profile', 'grade-1', '--url', 'http://127.0.0.1:1', '--no-model', '--out', unreachOut]);
      expect(code).toBe(1);
    } finally {
      process.env.PATH = prevPath;
    }
    const unreachReport = JSON.parse(readFileSync(path.join(unreachOut, 'report.json'), 'utf8')) as RunReport;
    expect(schemaErrors('report', unreachReport)).toEqual([]);
    expect(unreachReport.readiness?.checks.find((c) => c.number === 5)?.verdict).toBe('not_checked');
  }, 60_000);

  it('scans oversized (>512KB) bundles & blocks off-origin source map redirects while catching leaked keys in SPA/bundles', async () => {
    const bigKey = ['sk', 'live', '51OversizedBundleKey1234567890'].join('_');
    const bigPadding = '/* pad */\n'.repeat(60_000); // > 600 KB
    const srv = await startFixtureServer({
      '/': {
        type: 'text/html',
        body: '<!doctype html><html><body><h1>Big Bundle</h1><script src="/big.js"></script><script src="/redir.js"></script></body></html>',
      },
      '/big.js': {
        type: 'application/javascript',
        body: `${bigPadding}\nconst tailKey = "${bigKey}";\n`,
      },
      '/redir.js': {
        type: 'application/javascript',
        body: 'console.log(1);\n//# sourceMappingURL=/off-origin.map\n',
      },
      '/off-origin.map': {
        type: 'text/plain',
        status: 302,
        headers: { location: 'http://example.invalid/leaked.map' },
        body: '',
      },
    });
    const binDir = createGitleaksShim(path.join(tmp, 'bin-big'), { dirFindings: [], gitFindings: [] });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ''}`;
    const outDir = path.join(tmp, 'run-big');
    try {
      const code = await main(['run', '--profile', 'grade-1', '--url', srv.url, '--no-model', '--out', outDir]);
      expect(code).toBe(1);
    } finally {
      process.env.PATH = prevPath;
      await srv.close();
    }
    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as RunReport;
    expect(schemaErrors('report', report)).toEqual([]);
    const check5 = report.readiness?.checks.find((c) => c.number === 5);
    expect(check5?.verdict).toBe('fail');
    expect(check5?.coverage).toMatch(/sliced/i);
  }, 60_000);
});
