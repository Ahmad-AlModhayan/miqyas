// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Offline E2E readiness suite for Grade 1 Checks 11, 12, 3 and time-limit drop order (#20):
// active inert parameter probes, spending-route auth checks (--allow-writes off test hosts),
// built-in sign-up/log-in templates (--no-model graceful skip), and 12 -> 11 -> 3 drop order.

import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActContext, ActOutcome, Agent, JudgeContext, JudgeOutcome } from '../../src/agents/agent.js';
import { main } from '../../src/entry/cli.js';
import { runVerification } from '../../src/proof-core/orchestrator.js';
import {
  READINESS_DROP_ORDER,
  SECURITY_NOTICE,
  TIME_LIMIT_DROP_REASON,
} from '../../src/proof-core/readiness.js';
import type { RunReport } from '../../src/proof-core/report.js';
import { NO_SCRUB } from '../../src/scrub/scrub.js';
import type { CrawlResult, SurfaceDriver } from '../../src/surfaces/session.js';
import { schemaErrors } from '../report-helpers.js';

const FIXTURES_DIR = path.resolve('corpus/fixtures/grade1-checks/param-spend-auth');

type ScenarioMode =
  | 'clean-twin'
  | 'seed-check11-xss'
  | 'seed-check11-redirect'
  | 'seed-check11-form-xss'
  | 'seed-check12-llm-open'
  | 'seed-check12-sms-open'
  | 'seed-check12-email-open'
  | 'seed-check3-broken-signup'
  | 'seed-check3-broken-login'
  | 'seed-check3-missing-auth-ui';

const TEST_ACCOUNTS_ENV = {
  MIQYAS_SECRET_ACCOUNT_A_EMAIL: 'alice-e2e@example.com',
  MIQYAS_SECRET_ACCOUNT_A_PASSWORD: 'e2e-password-alice-911',
  MIQYAS_SECRET_ACCOUNT_B_EMAIL: 'bob-e2e@example.com',
  MIQYAS_SECRET_ACCOUNT_B_PASSWORD: 'e2e-password-bob-822',
} as const;

class AuthFlowAgent implements Agent {
  readonly info = { provider: 'scripted', model: 'auth-flow-e2e' };
  readonly usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

  async act(ctx: ActContext): Promise<ActOutcome> {
    const navMatch = /Navigate to (\S+)/i.exec(ctx.step.text);
    if (navMatch?.[1]) {
      const res = await ctx.execute({ tool: 'navigate', path: navMatch[1] });
      return res.ok ? { status: 'done', summary: `navigated to ${navMatch[1]}` } : { status: 'failed', summary: res.message };
    }

    const emailMatch = /'([^']+)'/.exec(ctx.step.text);
    const passMatches = [...ctx.step.text.matchAll(/\$\{secret\.([^}]+)\}/g)].map((m) => m[0]);
    const emailVal = emailMatch?.[1];
    const passToken = passMatches[0];
    if (!emailVal || !passToken) {
      return { status: 'failed', summary: 'step missing credentials' };
    }

    const emailBox = ctx.observation.nodes.find((n) => n.role === 'textbox' && /email|user/i.test(n.name));
    if (!emailBox) {
      return { status: 'failed', summary: 'auth email field missing from page' };
    }

    const f1 = await ctx.execute({ tool: 'fill', ref: emailBox.ref, text: emailVal });
    if (!f1.ok) return { status: 'failed', summary: f1.message };
    const passBox = f1.observation.nodes.find((n) => n.role === 'textbox' && /password/i.test(n.name));
    if (!passBox) {
      return { status: 'failed', summary: 'auth password field missing from page' };
    }
    const f2 = await ctx.execute({ tool: 'fill', ref: passBox.ref, text: passToken });
    if (!f2.ok) return { status: 'failed', summary: f2.message };
    const submitBtn = f2.observation.nodes.find((n) => n.role === 'button');
    if (!submitBtn) {
      return { status: 'failed', summary: 'auth submit button missing from page' };
    }
    const clickRes = await ctx.execute({ tool: 'click', ref: submitBtn.ref });
    return clickRes.ok
      ? { status: 'done', summary: 'submitted auth form' }
      : { status: 'failed', summary: clickRes.message };
  }

  async judge(ctx: JudgeContext): Promise<JudgeOutcome> {
    const errNode = ctx.current.nodes.find(
      (n) => n.role === 'alert' || /error|invalid|failed/i.test(n.name),
    );
    if (errNode) {
      return {
        verdict: 'fail',
        observation: `Auth flow showed error: ${errNode.name}`,
        evidenceRefs: [errNode.ref],
      };
    }
    const dashNode = ctx.current.nodes.find(
      (n) => /authenticated dashboard|welcome|signed in/i.test(n.name),
    );
    if (dashNode) {
      return {
        verdict: 'pass',
        observation: `Authenticated view rendered: ${dashNode.name}`,
        evidenceRefs: [dashNode.ref],
      };
    }
    const fallbackRef = ctx.current.nodes[0]?.ref;
    return {
      verdict: 'fail',
      observation: `Expected authenticated view after submit on ${ctx.current.url}`,
      evidenceRefs: fallbackRef ? [fallbackRef] : [],
    };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function collectReportTexts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectReportTexts(full));
    else if (/\.(json|jsonl|md|txt|log)$/i.test(entry)) out.push(readFileSync(full, 'utf8'));
  }
  return out;
}

describe('Checks 11, 12, 3 and time-limit drop order E2E (#20)', () => {
  let tmp = '';
  const servers: http.Server[] = [];
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'miqyas-psa-e2e-'));
    for (const [k, v] of Object.entries(TEST_ACCOUNTS_ENV)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
  });

  afterEach(async () => {
    for (const [k, prev] of savedEnv.entries()) {
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
    savedEnv.clear();
    for (const srv of servers.splice(0)) {
      await new Promise<void>((r) => srv.close(() => r()));
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  async function startScenarioServer(initialMode: ScenarioMode): Promise<{
    baseUrl: string;
    setMode: (mode: ScenarioMode) => void;
    probedPaths: string[];
  }> {
    let mode: ScenarioMode = initialMode;
    let port = 0;
    const probedPaths: string[] = [];

    const readBody = (req: http.IncomingMessage) =>
      new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });

    const sendHtml = (res: http.ServerResponse, status: number, html: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const srv = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const pathname = reqUrl.pathname;
      const method = (req.method ?? 'GET').toUpperCase();
      probedPaths.push(`${method} ${pathname}${reqUrl.search}`);

      if (pathname === '/' || pathname === '/index.html') {
        const fileMap: Record<ScenarioMode, string> = {
          'clean-twin': path.join(FIXTURES_DIR, 'clean-twin/index.html'),
          'seed-check11-xss': path.join(FIXTURES_DIR, 'seed-check11-xss.html'),
          'seed-check11-redirect': path.join(FIXTURES_DIR, 'seed-check11-redirect.html'),
          'seed-check11-form-xss': path.join(FIXTURES_DIR, 'seed-check11-form-xss.html'),
          'seed-check12-llm-open': path.join(FIXTURES_DIR, 'seed-check12-llm-open.html'),
          'seed-check12-sms-open': path.join(FIXTURES_DIR, 'seed-check12-sms-open.html'),
          'seed-check12-email-open': path.join(FIXTURES_DIR, 'seed-check12-email-open.html'),
          'seed-check3-broken-signup': path.join(FIXTURES_DIR, 'seed-check3-broken-signup.html'),
          'seed-check3-broken-login': path.join(FIXTURES_DIR, 'seed-check3-broken-login.html'),
          'seed-check3-missing-auth-ui': path.join(FIXTURES_DIR, 'seed-check3-missing-auth-ui.html'),
        };
        sendHtml(res, 200, readFileSync(fileMap[mode], 'utf8'));
        return;
      }

      if (pathname === '/search') {
        const q = reqUrl.searchParams.get('q') ?? '';
        const body = mode === 'seed-check11-xss' ? q : escapeHtml(q);
        sendHtml(res, 200, `<!doctype html><html><body><h1>Search</h1><p>${body}</p></body></html>`);
        return;
      }

      if (pathname === '/filter') {
        const tag = reqUrl.searchParams.get('tag') ?? '';
        const body = mode === 'seed-check11-form-xss' ? tag : escapeHtml(tag);
        sendHtml(res, 200, `<!doctype html><html><body><h1>Filter</h1><p>${body}</p></body></html>`);
        return;
      }

      if (pathname === '/redir') {
        const next = reqUrl.searchParams.get('next') ?? '/dashboard';
        if (mode === 'seed-check11-redirect') {
          res.writeHead(302, { location: next });
          res.end();
          return;
        }
        const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
        res.writeHead(302, { location: safe });
        res.end();
        return;
      }

      if (pathname === '/api/chat' || pathname === '/api/send-sms' || pathname === '/api/send-email') {
        const openModes: Partial<Record<ScenarioMode, string>> = {
          'seed-check12-llm-open': '/api/chat',
          'seed-check12-sms-open': '/api/send-sms',
          'seed-check12-email-open': '/api/send-email',
        };
        if (openModes[mode] === pathname) {
          sendJson(res, 200, { ok: true, sent: pathname });
          return;
        }
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }

      if (pathname === '/signup') {
        if (method === 'GET') {
          if (mode === 'seed-check3-missing-auth-ui') {
            sendHtml(res, 200, '<!doctype html><html><body><h1>Sign Up Disabled</h1><p>No form controls rendered</p></body></html>');
            return;
          }
          sendHtml(res, 200, readFileSync(path.join(FIXTURES_DIR, 'clean-twin/signup.html'), 'utf8'));
          return;
        }
        await readBody(req);
        if (mode === 'seed-check3-broken-signup') {
          sendHtml(
            res,
            200,
            '<!doctype html><html><body><div role="alert">Registration error: signup failed</div></body></html>',
          );
          return;
        }
        res.writeHead(302, { location: '/dashboard', 'set-cookie': 'miqyas_e2e_sess=ok; Path=/' });
        res.end();
        return;
      }

      if (pathname === '/login') {
        if (method === 'GET') {
          sendHtml(res, 200, readFileSync(path.join(FIXTURES_DIR, 'clean-twin/login.html'), 'utf8'));
          return;
        }
        await readBody(req);
        if (mode === 'seed-check3-broken-login') {
          sendHtml(
            res,
            200,
            '<!doctype html><html><body><div role="alert">Invalid credentials</div></body></html>',
          );
          return;
        }
        res.writeHead(302, { location: '/dashboard', 'set-cookie': 'miqyas_e2e_sess=ok; Path=/' });
        res.end();
        return;
      }

      if (pathname === '/dashboard') {
        sendHtml(
          res,
          200,
          '<!doctype html><html><body><h1>Authenticated Dashboard</h1><p>Welcome signed in user</p></body></html>',
        );
        return;
      }

      sendHtml(res, 404, '<!doctype html><html><body><p>Not found</p></body></html>');
    });

    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    port = (srv.address() as { port: number }).port;
    servers.push(srv);
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      setMode: (next) => {
        mode = next;
      },
      probedPaths,
    };
  }

  function readReport(outDir: string): RunReport {
    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as RunReport;
    expect(schemaErrors('report', report)).toEqual([]);
    return report;
  }

  it('passes Checks 11, 12, and 3 on clean-twin with model active and skips Check 3 under --no-model', async () => {
    const srv = await startScenarioServer('clean-twin');
    const outActive = path.join(tmp, 'clean-active');
    const code = await main(
      ['run', '--url', srv.baseUrl, '--profile', 'grade-1', '--active', '--max-rps', '100', '--json', '--out', outActive],
      { agent: new AuthFlowAgent() },
    );
    expect([0, 1]).toContain(code);
    const report = readReport(outActive);
    const c3 = report.readiness?.checks.find((c) => c.number === 3);
    const c11 = report.readiness?.checks.find((c) => c.number === 11);
    const c12 = report.readiness?.checks.find((c) => c.number === 12);
    expect(c3?.verdict).toBe('pass');
    expect(c11?.verdict).toBe('pass');
    expect(c11?.securityNotice).toBe(SECURITY_NOTICE);
    expect(c12?.verdict).toBe('pass');
    expect((report.findings ?? []).filter((f) => f.category === 'secret-exposure')).toEqual([]);
    expect(report.plans.map((p) => p.planId)).toEqual(
      expect.arrayContaining(['grade-1/check-3-signup', 'grade-1/check-3-login', 'grade-1']),
    );
    // Secret passwords must never appear in persisted reports or markdown logs.
    for (const txt of collectReportTexts(outActive)) {
      expect(txt).not.toContain(TEST_ACCOUNTS_ENV.MIQYAS_SECRET_ACCOUNT_A_PASSWORD);
      expect(txt).not.toContain(TEST_ACCOUNTS_ENV.MIQYAS_SECRET_ACCOUNT_B_PASSWORD);
    }

    // Under --no-model: Check 3 must be not_checked, while Checks 11 and 12 still pass.
    const outNoModel = path.join(tmp, 'clean-nomodel');
    await main([
      'run',
      '--url',
      srv.baseUrl,
      '--profile',
      'grade-1',
      '--active',
      '--no-model',
      '--max-rps',
      '100',
      '--json',
      '--out',
      outNoModel,
    ]);
    const nmReport = readReport(outNoModel);
    expect(nmReport.readiness?.checks.find((c) => c.number === 3)?.verdict).toBe('not_checked');
    expect(nmReport.readiness?.checks.find((c) => c.number === 11)?.verdict).toBe('pass');
    expect(nmReport.readiness?.checks.find((c) => c.number === 12)?.verdict).toBe('pass');
  }, 60_000);

  it('catches all 3 Check 11 seeds (XSS URL param, open redirect, form XSS) with tagged probes', async () => {
    const srv = await startScenarioServer('seed-check11-xss');
    for (const seed of ['seed-check11-xss', 'seed-check11-redirect', 'seed-check11-form-xss'] as const) {
      srv.setMode(seed);
      const outDir = path.join(tmp, seed);
      const code = await main([
        'run',
        '--url',
        srv.baseUrl,
        '--profile',
        'grade-1',
        '--active',
        '--no-model',
        '--max-rps',
        '100',
        '--json',
        '--out',
        outDir,
      ]);
      expect(code).toBe(1);
      const report = readReport(outDir);
      const c11 = report.readiness?.checks.find((c) => c.number === 11);
      expect(c11?.verdict, seed).toBe('fail');
      expect(c11?.securityNotice).toBe(SECURITY_NOTICE);
      const expectedCategory = seed === 'seed-check11-redirect' ? 'open-redirect' : 'reflected-xss';
      const matching = (report.findings ?? []).filter(
        (f) => f.category === expectedCategory && f.planId === 'readiness' && f.stepId === 'check-11',
      );
      expect(matching.length, seed).toBeGreaterThanOrEqual(1);
      expect(matching[0]?.evidence).toContain(`miqyas-probe-${report.runId}`);
      expect(srv.probedPaths.some((p) => p.includes(`miqyas-probe-${report.runId}`)), seed).toBe(true);
    }
  }, 60_000);

  it('catches all 3 Check 12 spending-route seeds and keeps Check 12 blocked off test hosts without --allow-writes', async () => {
    const srv = await startScenarioServer('seed-check12-llm-open');
    for (const seed of ['seed-check12-llm-open', 'seed-check12-sms-open', 'seed-check12-email-open'] as const) {
      srv.setMode(seed);
      const outDir = path.join(tmp, seed);
      const code = await main([
        'run',
        '--url',
        srv.baseUrl,
        '--profile',
        'grade-1',
        '--active',
        '--no-model',
        '--max-rps',
        '100',
        '--json',
        '--out',
        outDir,
      ]);
      expect(code).toBe(1);
      const report = readReport(outDir);
      const c12 = report.readiness?.checks.find((c) => c.number === 12);
      expect(c12?.verdict, seed).toBe('fail');
      expect(
        (report.findings ?? []).some((f) => f.category === 'unauthenticated-spending-route'),
        seed,
      ).toBe(true);
    }

    // CLI guard: --allow-writes without --active fails cleanly with UsageError (exit code 2)
    await expect(
      main(['run', '--url', srv.baseUrl, '--allow-writes', '--no-model', '--out', path.join(tmp, 'bad-writes')]),
    ).resolves.toBe(2);

    // Off test hosts without --allow-writes: passive + read checks succeed while Check 12 stays not_checked
    srv.setMode('seed-check12-llm-open');
    const localBase = new URL(srv.baseUrl);
    const stubDriver: SurfaceDriver = {
      surface: 'web',
      version: 'stub',
      async openSession() {
        throw new Error('openSession should not run when plans are empty and --no-model is set');
      },
      async crawl() {
        const emptyObs = {
          capture: 1,
          url: 'https://app.example/',
          title: 'Owned App',
          lang: 'en',
          dir: 'ltr',
          viewport: { width: 1280, height: 800 },
          nodes: [],
          truncated: false,
          png: Buffer.alloc(0),
          capturedAt: new Date(),
          findings: [],
        };
        const c: CrawlResult = {
          screens: [{ url: 'https://app.example/search?q=safe', depth: 0, title: 'Owned', observation: emptyObs }],
          skippedControls: 0,
          skippedOffOriginLinks: 0,
          servedArtifacts: [
            {
              name: 'index.html',
              kind: 'response',
              url: 'https://app.example/',
              text: '<script>fetch("/api/chat")</script>',
            },
          ],
        };
        return c;
      },
      async close() {},
    };
    const validHostToken = 'miqyas-verify-0123456789abcdef';
    const rewriteFetch: typeof fetch = (input, init) => {
      const target = new URL(String(input));
      if (target.hostname === 'app.example' && target.pathname === '/.well-known/miqyas.txt') {
        return Promise.resolve(new Response(`${validHostToken}\n`, { status: 200 }));
      }
      if (target.hostname === 'app.example') {
        target.protocol = localBase.protocol;
        target.host = localBase.host;
      }
      return fetch(target.href, init);
    };

    const offHostBlocked = await runVerification({
      runId: 'offhost-no-writes',
      url: 'https://app.example/',
      plans: [],
      runDir: path.join(tmp, 'offhost-no-writes'),
      driver: stubDriver,
      agent: null,
      noModel: true,
      scrub: NO_SCRUB,
      scrubMethod: { file: null, sha256: null, terms: 0 },
      settings: { profile: 'grade-1', active: true, allowHost: 'app.example', hostToken: validHostToken, maxRps: 100 },
      probeFetch: rewriteFetch,
      hostPolicyDeps: { fetchImpl: rewriteFetch },
      env: {},
    });
    expect(offHostBlocked.readiness?.checks.find((c) => c.number === 11)?.verdict).toBe('pass');
    const c12OffBlocked = offHostBlocked.readiness?.checks.find((c) => c.number === 12);
    expect(c12OffBlocked?.verdict).toBe('not_checked');
    expect(c12OffBlocked?.reason).toContain('--allow-writes');

    const offHostAllowed = await runVerification({
      runId: 'offhost-with-writes',
      url: 'https://app.example/',
      plans: [],
      runDir: path.join(tmp, 'offhost-with-writes'),
      driver: stubDriver,
      agent: null,
      noModel: true,
      scrub: NO_SCRUB,
      scrubMethod: { file: null, sha256: null, terms: 0 },
      settings: {
        profile: 'grade-1',
        active: true,
        allowWrites: true,
        allowHost: 'app.example',
        hostToken: validHostToken,
        maxRps: 100,
      },
      probeFetch: rewriteFetch,
      hostPolicyDeps: { fetchImpl: rewriteFetch },
      env: {},
    });
    expect(offHostAllowed.readiness?.checks.find((c) => c.number === 12)?.verdict).toBe('fail');
  }, 60_000);

  it('catches all 3 Check 3 auth seeds and drops checks in order 12 -> 11 -> 3 under --max-time', async () => {
    expect(READINESS_DROP_ORDER).toEqual([12, 11, 3]);
    const srv = await startScenarioServer('seed-check3-broken-signup');
    for (const seed of [
      'seed-check3-broken-signup',
      'seed-check3-broken-login',
      'seed-check3-missing-auth-ui',
    ] as const) {
      srv.setMode(seed);
      const outDir = path.join(tmp, seed);
      const code = await main(
        ['run', '--url', srv.baseUrl, '--profile', 'grade-1', '--active', '--max-rps', '100', '--json', '--out', outDir],
        { agent: new AuthFlowAgent() },
      );
      expect(code, seed).toBe(1);
      const report = readReport(outDir);
      const c3 = report.readiness?.checks.find((c) => c.number === 3);
      expect(c3?.verdict, seed).toBe('fail');
      expect((report.findings ?? []).some((f) => f.category === 'auth-flow'), seed).toBe(true);
    }

    // --max-time 0 on clean-twin drops all 3 (12, 11, 3) strictly as not_checked (never pass)
    srv.setMode('clean-twin');
    const outZeroBudget = path.join(tmp, 'max-time-zero');
    await main(
      [
        'run',
        '--url',
        srv.baseUrl,
        '--profile',
        'grade-1',
        '--active',
        '--max-rps',
        '100',
        '--max-time',
        '0',
        '--json',
        '--out',
        outZeroBudget,
      ],
      { agent: new AuthFlowAgent() },
    );
    const zeroReport = readReport(outZeroBudget);
    expect(zeroReport.method.settings.maxTimeMs).toBe(0);
    expect(readFileSync(path.join(outZeroBudget, 'report.md'), 'utf8')).toContain('max time 0.0 s');
    for (const num of [12, 11, 3]) {
      const check = zeroReport.readiness?.checks.find((c) => c.number === num);
      expect(check?.verdict, `check ${num}`).toBe('not_checked');
      expect(check?.reason, `check ${num}`).toBe(TIME_LIMIT_DROP_REASON);
    }

    // Constrained clock expiring after Check 3 drops 12 and 11 while keeping Check 3 passing
    const baseAgent = new AuthFlowAgent();
    let fakeNow = 0;
    const outDrop12And11 = path.join(tmp, 'max-time-drop-12-11');
    const advancingAgent: Agent = {
      info: baseAgent.info,
      usage: baseAgent.usage,
      act: (ctx) => baseAgent.act(ctx),
      judge: async (ctx) => {
        const res = await baseAgent.judge(ctx);
        if (ctx.plan.id === 'grade-1/check-3-login') {
          fakeNow = 20_000;
        }
        return res;
      },
    };
    await main(
      [
        'run',
        '--url',
        srv.baseUrl,
        '--profile',
        'grade-1',
        '--active',
        '--max-rps',
        '100',
        '--max-time',
        '10',
        '--json',
        '--out',
        outDrop12And11,
      ],
      { agent: advancingAgent, clock: () => fakeNow },
    );
    const dropReport = readReport(outDrop12And11);
    expect(dropReport.method.settings.maxTimeMs).toBe(10_000);
    expect(dropReport.readiness?.checks.find((c) => c.number === 3)?.verdict).toBe('pass');
    expect(dropReport.readiness?.checks.find((c) => c.number === 11)?.verdict).toBe('not_checked');
    expect(dropReport.readiness?.checks.find((c) => c.number === 12)?.verdict).toBe('not_checked');
  }, 60_000);
});
