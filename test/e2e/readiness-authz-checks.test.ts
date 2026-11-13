// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Offline E2E readiness suite for Grade 1 Checks 8, 9, and 10 (#19):
// backend public-key probes, two-account read-only IDOR, and unauthenticated route replay.

import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/entry/cli.js';
import type { RunReport } from '../../src/proof-core/report.js';
import { SECURITY_NOTICE } from '../../src/proof-core/readiness.js';
import { schemaErrors } from '../report-helpers.js';

const AUTHZ_FIXTURES = path.resolve('corpus/fixtures/grade1-checks/authz');

const ROW_SENTINELS = [
  'ROW_SENTINEL_TOP_SECRET_SUPA_911',
  'ROW_SENTINEL_TOP_SECRET_RTDB_922',
  'ROW_SENTINEL_TOP_SECRET_FS_933',
  'ROW_SENTINEL_TOP_SECRET_IDOR_1',
  'ROW_SENTINEL_TOP_SECRET_IDOR_2',
  'ROW_SENTINEL_TOP_SECRET_IDOR_3',
  'ROW_SENTINEL_TOP_SECRET_UNAUTH_1',
  'ROW_SENTINEL_TOP_SECRET_UNAUTH_2',
  'ROW_SENTINEL_TOP_SECRET_UNAUTH_3',
  'CLEAN_ROW_SECRET_NOT_EXPOSED',
];

const SECRET_ACCOUNT_VALUES = ['tok-e2e-account-a-999', 'tok-e2e-account-b-888'];

type AuthzMode =
  | 'clean-twin'
  | 'seed-c8-supabase'
  | 'seed-c8-rtdb'
  | 'seed-c8-firestore'
  | 'seed-c9-idor-path'
  | 'seed-c9-idor-query'
  | 'seed-c9-idor-invoice'
  | 'seed-c10-unauth-api'
  | 'seed-c10-unauth-dashboard'
  | 'seed-c10-unauth-settings';

function collectAllTextFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectAllTextFiles(full));
    } else if (/\.(json|jsonl|md|txt|log)$/i.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

function assertZeroLeakageInDir(outDir: string): void {
  for (const file of collectAllTextFiles(outDir)) {
    const content = readFileSync(file, 'utf8');
    for (const sentinel of ROW_SENTINELS) {
      expect(content, `${path.basename(file)} must never contain row sentinel ${sentinel}`).not.toContain(sentinel);
    }
    for (const secret of SECRET_ACCOUNT_VALUES) {
      expect(content, `${path.basename(file)} must never contain test account secret`).not.toContain(secret);
    }
  }
}

describe('Checks 8, 9, 10 backend & authz readiness E2E (#19)', () => {
  let tmp = '';
  const servers: http.Server[] = [];
  const methodsSeen: { mode: AuthzMode; method: string; url: string }[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'miqyas-authz-e2e-'));
  });

  afterEach(async () => {
    for (const srv of servers.splice(0)) {
      await new Promise<void>((r) => srv.close(() => r()));
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    methodsSeen.length = 0;
  });

  async function startAuthzServer(initialMode: AuthzMode): Promise<{
    baseUrl: string;
    setMode: (mode: AuthzMode) => void;
  }> {
    let mode: AuthzMode = initialMode;
    let port = 0;

    const srv = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const pathname = reqUrl.pathname;
      const auth = req.headers.authorization ?? '';
      methodsSeen.push({ mode, method: req.method ?? 'GET', url: reqUrl.pathname + reqUrl.search });

      const sendJson = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const sendHtml = (status: number, html: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      };

      // Static HTML & JS bundle serving per active scenario
      if (pathname === '/' || pathname === '/index.html') {
        if (mode === 'seed-c8-supabase') {
          return sendHtml(200, readFileSync(path.join(AUTHZ_FIXTURES, 'seed-check8-supabase-open.html'), 'utf8'));
        }
        if (mode === 'seed-c8-rtdb') {
          return sendHtml(200, readFileSync(path.join(AUTHZ_FIXTURES, 'seed-check8-firebase-rtdb.html'), 'utf8'));
        }
        if (mode === 'seed-c8-firestore') {
          return sendHtml(200, readFileSync(path.join(AUTHZ_FIXTURES, 'seed-check8-firestore-open.html'), 'utf8'));
        }
        if (mode.startsWith('seed-c9-')) {
          return sendHtml(200, readFileSync(path.join(AUTHZ_FIXTURES, 'seed-check9-idor.html'), 'utf8'));
        }
        if (mode.startsWith('seed-c10-')) {
          return sendHtml(200, readFileSync(path.join(AUTHZ_FIXTURES, 'seed-check10-unauth.html'), 'utf8'));
        }
        return sendHtml(200, readFileSync(path.join(AUTHZ_FIXTURES, 'clean-twin', 'index.html'), 'utf8'));
      }

      if (pathname === '/app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
        return res.end(readFileSync(path.join(AUTHZ_FIXTURES, 'clean-twin', 'app.js'), 'utf8'));
      }

      if (pathname === '/rtdb-config.js') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
        return res.end(
          `window.__FB__ = { apiKey: "AIzaSyFakeRtdbTestKey1234567890", databaseURL: "http://127.0.0.1:${port}/rtdb", projectId: "demo-rtdb" };`,
        );
      }

      if (pathname === '/login') {
        return sendHtml(200, '<!doctype html><html lang="en"><body><form><input type="password" /></form></body></html>');
      }

      // Check 8 mock BaaS endpoints
      if (pathname === '/rest/v1/') {
        if (mode === 'clean-twin') return sendJson(200, { paths: { '/profiles': {} } });
        if (mode === 'seed-c8-supabase') return sendJson(200, { paths: { '/customers': {} } });
        return sendJson(404, { message: 'not found' });
      }
      if (pathname === '/rest/v1/profiles') {
        return sendJson(200, []); // RLS blocks anon reads in clean-twin
      }
      if (pathname === '/rest/v1/customers') {
        if (mode === 'seed-c8-supabase') {
          return sendJson(200, [{ id: 1, customerEmail: ROW_SENTINELS[0], billingTier: 'pro' }]);
        }
        return sendJson(401, { error: 'unauthorized' });
      }
      if (pathname === '/rtdb/.json' || pathname === '/rtdb/records.json') {
        if (mode === 'seed-c8-rtdb') {
          return sendJson(200, { item1: true, secret: ROW_SENTINELS[1] });
        }
        return sendJson(401, { error: 'permission denied' });
      }
      if (pathname === '/v1/projects/demo-app/databases/(default)/documents/invoices') {
        if (mode === 'seed-c8-firestore') {
          return sendJson(200, {
            documents: [
              {
                name: 'projects/demo-app/databases/(default)/documents/invoices/inv-1',
                fields: { secretNote: { stringValue: ROW_SENTINELS[2] } },
              },
            ],
          });
        }
        return sendJson(403, { error: { code: 403, message: 'Missing permissions' } });
      }

      // Check 9 & Check 10 multi-account API/web routes
      if (pathname === '/api/orders') {
        if (!auth) return sendJson(401, { error: 'unauthorized' });
        if (auth === `Bearer ${SECRET_ACCOUNT_VALUES[0]}`) {
          return sendJson(200, [{ id: 'ord-a-101', secretVal: ROW_SENTINELS[3] }]);
        }
        return sendJson(200, []);
      }
      if (pathname === '/api/orders/ord-a-101') {
        if (!auth) return sendJson(401, { error: 'unauthorized' });
        if (auth === `Bearer ${SECRET_ACCOUNT_VALUES[0]}` || mode === 'seed-c9-idor-path') {
          return sendJson(200, { id: 'ord-a-101', owner: 'user-a', secretVal: ROW_SENTINELS[3] });
        }
        return sendJson(403, { error: 'forbidden' });
      }

      if (pathname === '/rest/v1/notes') {
        if (!auth) return sendJson(401, { error: 'unauthorized' });
        if (reqUrl.searchParams.get('id') === 'eq.note-a-202') {
          if (auth === `Bearer ${SECRET_ACCOUNT_VALUES[0]}` || mode === 'seed-c9-idor-query') {
            return sendJson(200, [{ id: 'note-a-202', body: ROW_SENTINELS[4] }]);
          }
          return sendJson(403, { error: 'forbidden' });
        }
        if (auth === `Bearer ${SECRET_ACCOUNT_VALUES[0]}`) {
          return sendJson(200, [{ id: 'note-a-202', body: ROW_SENTINELS[4] }]);
        }
        return sendJson(200, []);
      }

      if (pathname === '/api/invoices') {
        if (!auth) return sendJson(401, { error: 'unauthorized' });
        if (auth === `Bearer ${SECRET_ACCOUNT_VALUES[0]}`) {
          return sendJson(200, [{ id: 'inv-a-303', pdfToken: ROW_SENTINELS[5] }]);
        }
        return sendJson(200, []);
      }
      if (pathname === '/api/invoices/inv-a-303') {
        if (!auth) return sendJson(401, { error: 'unauthorized' });
        if (auth === `Bearer ${SECRET_ACCOUNT_VALUES[0]}` || mode === 'seed-c9-idor-invoice') {
          return sendJson(200, { id: 'inv-a-303', pdfToken: ROW_SENTINELS[5] });
        }
        return sendJson(403, { error: 'forbidden' });
      }

      if (pathname === '/api/admin/export') {
        if (!auth) {
          if (mode === 'seed-c10-unauth-api') {
            return sendJson(200, { exportUrl: 'https://internal.test/dump', token: ROW_SENTINELS[6] });
          }
          return sendJson(401, { error: 'unauthorized' });
        }
        return sendJson(200, { exportUrl: 'ok' });
      }

      if (pathname === '/dashboard') {
        if (!auth) {
          if (mode === 'seed-c10-unauth-dashboard') {
            return sendHtml(200, `<!doctype html><html lang="en"><body><main><h1>Dashboard</h1><p>${ROW_SENTINELS[7]}</p></main></body></html>`);
          }
          res.writeHead(302, { location: '/login' });
          return res.end();
        }
        return sendHtml(200, '<!doctype html><html lang="en"><body><main><h1>Dashboard</h1></main></body></html>');
      }

      if (pathname === '/settings') {
        if (!auth) {
          if (mode === 'seed-c10-unauth-settings') {
            return sendJson(200, { billingKey: ROW_SENTINELS[8] });
          }
          return sendJson(403, { error: 'session required' });
        }
        return sendJson(200, { theme: 'dark', privateNote: 'CLEAN_ROW_SECRET_NOT_EXPOSED' });
      }

      res.writeHead(404);
      res.end('not found');
    });

    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    port = (srv.address() as { port: number }).port;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      setMode: (next) => {
        mode = next;
      },
    };
  }

  async function withAccountEnv(
    overrides: Record<string, string | undefined>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const keys = [
      'MIQYAS_SECRET_ACCOUNT_A_TOKEN',
      'MIQYAS_SECRET_ACCOUNT_A_ROUTES',
      'MIQYAS_SECRET_ACCOUNT_B_TOKEN',
      'MIQYAS_SECRET_ACCOUNT_B_ROUTES',
    ];
    const prev: Record<string, string | undefined> = {};
    for (const k of keys) {
      prev[k] = process.env[k];
      if (overrides[k] === undefined) delete process.env[k];
      else process.env[k] = overrides[k];
    }
    try {
      await fn();
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

  it('passes clean twin, catches all 9 Check 8/9/10 seeds offline with zero row leakage, and handles <2 accounts & host policy', async () => {
    const { baseUrl, setMode } = await startAuthzServer('clean-twin');
    const fullAccountEnv = {
      MIQYAS_SECRET_ACCOUNT_A_TOKEN: SECRET_ACCOUNT_VALUES[0],
      MIQYAS_SECRET_ACCOUNT_A_ROUTES: '/api/orders,/rest/v1/notes,/api/invoices,/api/admin/export,/dashboard,/settings',
      MIQYAS_SECRET_ACCOUNT_B_TOKEN: SECRET_ACCOUNT_VALUES[1],
      MIQYAS_SECRET_ACCOUNT_B_ROUTES: '/api/orders,/rest/v1/notes,/api/invoices,/dashboard',
    };

    // 1. Clean twin passes Checks 8, 9, and 10 with --active and two test accounts
    await withAccountEnv(fullAccountEnv, async () => {
      const cleanOut = path.join(tmp, 'out-clean-twin');
      const code = await main([
        'run',
        '--profile',
        'grade-1',
        '--active',
        '--max-rps',
        '100',
        '--url',
        baseUrl,
        '--no-model',
        '--out',
        cleanOut,
      ]);
      expect([0, 1]).toContain(code);
      const report = JSON.parse(readFileSync(path.join(cleanOut, 'report.json'), 'utf8')) as RunReport;
      expect(schemaErrors('report', report)).toEqual([]);
      for (const num of [8, 9, 10]) {
        const chk = report.readiness?.checks.find((c) => c.number === num);
        expect(chk?.verdict, `clean-twin check ${num} should pass`).toBe('pass');
        expect(chk?.securityNotice).toBe(SECURITY_NOTICE);
      }
      expect(report.method.adapters?.some((a) => a.id === 'miqyas-probe' && a.status === 'ok')).toBe(true);
      const md = readFileSync(path.join(cleanOut, 'report.md'), 'utf8');
      expect(md).toContain(SECURITY_NOTICE);
      assertZeroLeakageInDir(cleanOut);
    });

    // 2. Check 8 seeds (3 distinct backends: Supabase, Firebase RTDB, Firestore)
    for (const mode of ['seed-c8-supabase', 'seed-c8-rtdb', 'seed-c8-firestore'] as const) {
      setMode(mode);
      await withAccountEnv(fullAccountEnv, async () => {
        const outDir = path.join(tmp, `out-${mode}`);
        await main([
          'run',
          '--profile',
          'grade-1',
          '--active',
          '--max-rps',
          '100',
          '--url',
          baseUrl,
          '--no-model',
          '--out',
          outDir,
        ]);
        const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as RunReport;
        expect(schemaErrors('report', report)).toEqual([]);
        const c8 = report.readiness?.checks.find((c) => c.number === 8)!;
        expect(c8.verdict, `${mode} should fail Check 8`).toBe('fail');
        expect(c8.securityNotice).toBe(SECURITY_NOTICE);
        expect(c8.evidenceIds?.length).toBeGreaterThanOrEqual(1);
        const linked = (report.findings ?? []).filter((f) => c8.evidenceIds?.includes(f.id));
        expect(linked.some((f) => f.category === 'backend-public-read' && f.title.includes(SECURITY_NOTICE))).toBe(true);
        assertZeroLeakageInDir(outDir);
      });
    }

    // 3. Check 9 seeds (3 distinct IDOR patterns, all verified GET-only)
    for (const mode of ['seed-c9-idor-path', 'seed-c9-idor-query', 'seed-c9-idor-invoice'] as const) {
      setMode(mode);
      await withAccountEnv(fullAccountEnv, async () => {
        const outDir = path.join(tmp, `out-${mode}`);
        await main([
          'run',
          '--profile',
          'grade-1',
          '--active',
          '--max-rps',
          '100',
          '--url',
          baseUrl,
          '--no-model',
          '--out',
          outDir,
        ]);
        const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as RunReport;
        expect(schemaErrors('report', report)).toEqual([]);
        const c9 = report.readiness?.checks.find((c) => c.number === 9)!;
        expect(c9.verdict, `${mode} should fail Check 9`).toBe('fail');
        expect(c9.securityNotice).toBe(SECURITY_NOTICE);
        expect(c9.evidenceIds?.length).toBeGreaterThanOrEqual(1);
        const linked = (report.findings ?? []).filter((f) => c9.evidenceIds?.includes(f.id));
        expect(linked.some((f) => f.category === 'idor-read' && f.title.includes(SECURITY_NOTICE))).toBe(true);
        const modeMethods = methodsSeen.filter((m) => m.mode === mode).map((m) => m.method);
        expect(modeMethods.every((m) => m === 'GET' || m === 'HEAD')).toBe(true);
        assertZeroLeakageInDir(outDir);
      });
    }

    // 4. Check 10 seeds (3 distinct unauthenticated route leaks)
    for (const mode of ['seed-c10-unauth-api', 'seed-c10-unauth-dashboard', 'seed-c10-unauth-settings'] as const) {
      setMode(mode);
      await withAccountEnv(fullAccountEnv, async () => {
        const outDir = path.join(tmp, `out-${mode}`);
        await main([
          'run',
          '--profile',
          'grade-1',
          '--active',
          '--max-rps',
          '100',
          '--url',
          baseUrl,
          '--no-model',
          '--out',
          outDir,
        ]);
        const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as RunReport;
        expect(schemaErrors('report', report)).toEqual([]);
        const c10 = report.readiness?.checks.find((c) => c.number === 10)!;
        expect(c10.verdict, `${mode} should fail Check 10`).toBe('fail');
        expect(c10.securityNotice).toBe(SECURITY_NOTICE);
        expect(c10.evidenceIds?.length).toBeGreaterThanOrEqual(1);
        const linked = (report.findings ?? []).filter((f) => c10.evidenceIds?.includes(f.id));
        expect(linked.some((f) => f.category === 'unauthenticated-route' && f.title.includes(SECURITY_NOTICE))).toBe(true);
        assertZeroLeakageInDir(outDir);
      });
    }

    // 5. Missing second account on clean-twin marks Check 9 as not_checked while Check 10 still runs
    setMode('clean-twin');
    await withAccountEnv(
      {
        MIQYAS_SECRET_ACCOUNT_A_TOKEN: SECRET_ACCOUNT_VALUES[0],
        MIQYAS_SECRET_ACCOUNT_A_ROUTES: '/api/orders,/dashboard,/settings',
      },
      async () => {
        const singleOut = path.join(tmp, 'out-single-account');
        await main([
          'run',
          '--profile',
          'grade-1',
          '--active',
          '--max-rps',
          '100',
          '--url',
          baseUrl,
          '--no-model',
          '--out',
          singleOut,
        ]);
        const report = JSON.parse(readFileSync(path.join(singleOut, 'report.json'), 'utf8')) as RunReport;
        const c9 = report.readiness?.checks.find((c) => c.number === 9)!;
        const c10 = report.readiness?.checks.find((c) => c.number === 10)!;
        expect(c9.verdict).toBe('not_checked');
        expect(c9.whatToAdd).toContain('MIQYAS_SECRET_ACCOUNT');
        expect(c9.securityNotice).toBe(SECURITY_NOTICE);
        expect(c10.verdict).toBe('pass');
      },
    );

    // 6. Active flag off test hosts refuses cleanly (exit code 2) without verified --allow-host
    const refusedOut = path.join(tmp, 'out-refused-host');
    const refusedCode = await main([
      'run',
      '--profile',
      'grade-1',
      '--active',
      '--url',
      'https://unowned-victim.example/',
      '--no-model',
      '--out',
      refusedOut,
    ]);
    expect(refusedCode).toBe(2);
    expect(() => readFileSync(path.join(refusedOut, 'report.json'), 'utf8')).toThrow();
  }, 60000);
});
