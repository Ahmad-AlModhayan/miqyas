// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/entry/cli.js';
import type { RunReport } from '../../src/proof-core/report.js';
import { schemaErrors } from '../report-helpers.js';

const WEB_FIXTURES_DIR = path.resolve(import.meta.dirname, '../../corpus/fixtures/grade1-checks/web');

let tmp = '';

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'miqyas-e2e-crawl-checks-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function startWebFixtureServer(
  entryFixtureRelPath: string,
  extraRoutes: Record<string, { status: number; type: string; body: string }> = {},
): Promise<{
  url: string;
  getDestructiveHits: () => number;
  close: () => Promise<void>;
}> {
  let destructiveHits = 0;
  const entryHtml = readFileSync(path.join(WEB_FIXTURES_DIR, entryFixtureRelPath), 'utf8');

  const srv = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const extra = extraRoutes[pathname];
    if (extra) {
      res.writeHead(extra.status, { 'content-type': extra.type });
      res.end(extra.body);
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(entryHtml);
      return;
    }
    if (pathname === '/settings.html') {
      const html = readFileSync(path.join(WEB_FIXTURES_DIR, 'clean-twin/settings.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (pathname === '/sub-dead.html') {
      const html = readFileSync(path.join(WEB_FIXTURES_DIR, 'sub-dead.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (pathname === '/logout' || pathname === '/api/destroy') {
      destructiveHits += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('destructive endpoint hit');
      return;
    }
    if (pathname === '/api/boom-500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    if (pathname === '/api/missing-404') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"missing"}');
      return;
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    getDestructiveHits: () => destructiveHits,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

async function runGrade1AgainstUrl(url: string, label: string, extraArgs: string[] = []): Promise<RunReport> {
  const outDir = path.join(tmp, label);
  const code = await main(['run', '--profile', 'grade-1', '--url', url, '--no-model', '--out', outDir, ...extraArgs]);
  expect([0, 1]).toContain(code);
  const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as RunReport;
  expect(schemaErrors('report', report)).toEqual([]);
  expect(report.usage?.calls).toBe(0);
  return report;
}

describe('Grade 1 crawl-backed readiness checks (Checks 1, 2, 4)', () => {
  it('passes Checks 1, 2, and 4 on the clean twin while excluding destructive controls, and records 4xx findings without failing Check 1', async () => {
    const cleanSrv = await startWebFixtureServer('clean-twin/index.html');
    let report: RunReport;
    try {
      report = await runGrade1AgainstUrl(cleanSrv.url, 'clean-twin');
      expect(cleanSrv.getDestructiveHits()).toBe(0);
    } finally {
      await cleanSrv.close();
    }

    expect(report.findings ?? []).toEqual([]);
    const checks = report.readiness?.checks ?? [];
    const c1 = checks.find((c) => c.number === 1);
    const c2 = checks.find((c) => c.number === 2);
    const c4 = checks.find((c) => c.number === 4);
    expect(c1?.verdict).toBe('pass');
    expect(c1?.coverage).toContain('screen(s)');
    expect(c2?.verdict).toBe('pass');
    expect(c2?.coverage).toContain('Delete account');
    expect(c2?.coverage).toContain('Log out');
    expect(c4?.verdict).toBe('pass');

    const adapterIds = (report.method?.adapters ?? []).map((a) => a.id);
    expect(adapterIds).toEqual(expect.arrayContaining(['playwright', 'axe-core']));
    for (const adapter of report.method?.adapters ?? []) {
      if (adapter.id === 'playwright' || adapter.id === 'axe-core') {
        expect(adapter.version).toBeTruthy();
      }
    }

    // 4xx response should be recorded in findings without failing Check 1.
    const srv404 = await startWebFixtureServer('clean-twin/settings.html', {
      '/': {
        status: 200,
        type: 'text/html; charset=utf-8',
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>4xx Check</title></head><body><main><h1>Status</h1><p id="status">pending</p></main><script>fetch('/api/missing-404').then(r => { document.getElementById('status').textContent = String(r.status); }).catch(() => {});</script></body></html>`,
      },
    });
    let report404: RunReport;
    try {
      report404 = await runGrade1AgainstUrl(srv404.url, 'clean-404');
    } finally {
      await srv404.close();
    }
    const c1With404 = report404.readiness?.checks.find((c) => c.number === 1);
    expect(c1With404?.verdict).toBe('pass');
    expect(c1With404?.coverage).toContain('1 4xx finding(s)');
    expect((report404.findings ?? []).some((f) => f.category === 'http-error' && f.evidence.includes('404'))).toBe(true);
  }, 60_000);

  it('fails Check 1 across all three readiness seeds (pageerror, console.error, HTTP 5xx)', async () => {
    const seeds = [
      { file: 'seed-check1-pageerror.html', expectedCategory: 'page-error' },
      { file: 'seed-check1-console-error.html', expectedCategory: 'console-error' },
      { file: 'seed-check1-http5xx.html', expectedCategory: 'http-error' },
    ];

    for (const seed of seeds) {
      const srv = await startWebFixtureServer(seed.file);
      let report: RunReport;
      try {
        report = await runGrade1AgainstUrl(srv.url, seed.file.replace('.html', ''));
      } finally {
        await srv.close();
      }
      const c1 = report.readiness?.checks.find((c) => c.number === 1);
      expect(c1?.verdict, `${seed.file} should fail Check 1`).toBe('fail');
      expect((c1?.evidenceIds ?? []).length, `${seed.file} evidenceIds`).toBeGreaterThan(0);
      const byId = new Map((report.findings ?? []).map((f) => [f.id, f]));
      const linkedFindings = (c1?.evidenceIds ?? []).map((id) => byId.get(id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
      expect(linkedFindings.some((f) => f.category === seed.expectedCategory)).toBe(true);
    }
  }, 60_000);

  it('fails Check 2 across all three readiness seeds (dead button, dead tab, dead subpage)', async () => {
    const seeds = [
      'seed-check2-dead-button.html',
      'seed-check2-dead-tab.html',
      'seed-check2-dead-subpage.html',
    ];

    for (const seed of seeds) {
      const srv = await startWebFixtureServer(seed);
      let report: RunReport;
      try {
        report = await runGrade1AgainstUrl(srv.url, seed.replace('.html', ''));
      } finally {
        await srv.close();
      }
      const c2 = report.readiness?.checks.find((c) => c.number === 2);
      expect(c2?.verdict, `${seed} should fail Check 2`).toBe('fail');
      expect((c2?.evidenceIds ?? []).length, `${seed} evidenceIds`).toBeGreaterThan(0);
      const byId = new Map((report.findings ?? []).map((f) => [f.id, f]));
      const linked = (c2?.evidenceIds ?? []).map((id) => byId.get(id));
      expect(linked.some((f) => f?.category === 'dead-control')).toBe(true);
    }
  }, 60_000);

  it('fails Check 4 across all three axe-core readiness seeds with element evidence', async () => {
    const seeds = [
      { file: 'seed-check4-image-alt.html', selector: 'hero' },
      { file: 'seed-check4-unlabeled-input.html', selector: 'email-unlabeled' },
      { file: 'seed-check4-no-lang.html', selector: 'html' },
    ];

    for (const seed of seeds) {
      const srv = await startWebFixtureServer(seed.file);
      let report: RunReport;
      try {
        report = await runGrade1AgainstUrl(srv.url, seed.file.replace('.html', ''));
      } finally {
        await srv.close();
      }
      const c4 = report.readiness?.checks.find((c) => c.number === 4);
      expect(c4?.verdict, `${seed.file} should fail Check 4`).toBe('fail');
      expect((c4?.evidenceIds ?? []).length, `${seed.file} evidenceIds`).toBeGreaterThan(0);
      const byId = new Map((report.findings ?? []).map((f) => [f.id, f]));
      const linked = (c4?.evidenceIds ?? []).map((id) => byId.get(id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
      expect(linked.some((f) => f.category === 'a11y' && (f.severity === 'critical' || f.severity === 'high'))).toBe(true);
      expect(linked.some((f) => (f.nodes ?? []).some((n) => n.ref.includes(seed.selector) || n.name?.includes(seed.selector)))).toBe(true);
    }
  }, 60_000);

  it('preserves post-click errors on duplicate-fingerprint screens, redacts --scrub consistently without duplicate findings, and skips aria-disabled buttons', async () => {
    const scrubToken = 'TenantSecretAlpha99';
    const scrubFile = path.join(tmp, 'scrub-rules.json');
    writeFileSync(scrubFile, JSON.stringify({ terms: [{ from: scrubToken, to: '[TENANT]' }] }), 'utf8');
    // Clicking the button throws a runtime error containing `scrubToken` without altering any accessibility tree node (same fingerprint).
    const srv = await startWebFixtureServer('clean-twin/settings.html', {
      '/': {
        status: 200,
        type: 'text/html; charset=utf-8',
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dup Screen + Scrub</title></head><body><main><h1>Controls</h1><button type="button" id="boom-btn">Trigger action</button><button type="button" id="disabled-btn" aria-disabled="true">Disabled action</button></main><script>document.getElementById('boom-btn').addEventListener('click', () => { console.error('Crash for ${scrubToken}'); });</script></body></html>`,
      },
    });

    let report: RunReport;
    try {
      report = await runGrade1AgainstUrl(srv.url, 'dup-scrub', ['--scrub', scrubFile]);
    } finally {
      await srv.close();
    }

    const c1 = report.readiness?.checks.find((c) => c.number === 1);
    const c2 = report.readiness?.checks.find((c) => c.number === 2);
    expect(c1?.verdict).toBe('fail');
    // Check 2 skips aria-disabled="true" buttons rather than flagging them dead.
    expect((report.findings ?? []).some((f) => f.category === 'dead-control' && f.evidence.includes('Disabled action'))).toBe(false);
    expect(c2).toBeDefined();
    const consoleFindings = (report.findings ?? []).filter((f) => f.category === 'console-error');
    expect(consoleFindings).toHaveLength(1);
    const serialized = JSON.stringify(report.findings ?? []);
    expect(serialized).not.toContain(scrubToken);
  }, 60_000);
});
