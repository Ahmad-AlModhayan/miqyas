// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Deterministic offline Chromium fixture tests for all 7 always-on screen detectors and --fail-on CLI gating (#13).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import type { RunReport } from '../../src/proof-core/report.js';
import { openWebSurfaceDriver } from '../../src/surfaces/web/driver.js';
import { NO_SCRUB } from '../../src/scrub/scrub.js';
import { schemaErrors } from '../report-helpers.js';

const FAKE_GH_TOKEN = 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz';
const FAKE_AWS_KEY = 'AKIA234567ABCDEFGHJK';

interface FixtureServer {
  url: string;
  externalHits: () => number;
  close(): Promise<void>;
}

async function startDetectorFixtureServer(): Promise<FixtureServer> {
  let externalCanaryHits = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.headers.host?.includes('canary.miqyas-probe.invalid')) externalCanaryHits += 1;

    if (u.pathname === '/clean') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Clean App</title></head>
        <body><main><h1>Clean App</h1><button type="button">Continue</button></main></body></html>`);
      return;
    }

    if (u.pathname === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(`window.__CFG = { gh: "${FAKE_GH_TOKEN}", aws: "${FAKE_AWS_KEY}" };\nconsole.error("runtime console failure");`);
      return;
    }

    if (u.pathname === '/api/fail500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'server boom' }));
      return;
    }

    if (u.pathname === '/api/missing404') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    if (u.pathname === '/bounce') {
      const next = u.searchParams.get('next') ?? '/clean';
      res.writeHead(302, { location: next });
      res.end();
      return;
    }

    if (u.pathname === '/broken') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Broken Screen</title>
        <style>
          .clipped { width: 60px; overflow: hidden; white-space: nowrap; }
          .low-contrast { color: #999999; background: #aaaaaa; }
        </style></head>
        <body>
          <h1>Fixture Loaded</h1>
          <div class="clipped">Very long heading text that overflows its 60px container</div>
          <p class="low-contrast">Hard to read</p>
          <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
          <button id="icon-btn"></button>
          <button id="trap" onkeydown="if(event.key==='Tab'){event.preventDefault();}">Trapped Button</button>
          <a href="/bounce?next=%2Fclean">Return</a>
          <script src="/bundle.js"></script>
          <script>
            fetch('/api/fail500').catch(() => {});
            fetch('/api/missing404').catch(() => {});
            setTimeout(() => { throw new Error('uncaught page boom'); }, 10);
          </script>
        </body></html>`);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    externalHits: () => externalCanaryHits,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

let tmp: string;
let srv: FixtureServer;
const saved = { ...process.env };

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-detectors-'));
  srv = await startDetectorFixtureServer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  process.env = saved;
  await srv.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('Always-on screen detectors & --fail-on threshold (#13)', () => {
  it('captures runtime errors, 4xx/5xx, bundle secrets (masked), clipping, axe-core, focus trap, and open redirects offline', async () => {
    const driver = await openWebSurfaceDriver();
    try {
      const session = await driver.openSession({ url: `${srv.url}/broken`, observe: {} });
      try {
        await new Promise((r) => setTimeout(r, 80));
        const obs = await session.observe();
        const categories = new Set((obs.findings ?? []).map((f) => f.category));
        expect(categories.has('console-error')).toBe(true);
        expect(categories.has('page-error')).toBe(true);
        expect(categories.has('http-error')).toBe(true);
        expect(categories.has('secret-exposure')).toBe(true);
        expect(categories.has('clipping')).toBe(true);
        expect(categories.has('a11y')).toBe(true);
        expect(categories.has('focus-trap')).toBe(true);
        expect(categories.has('open-redirect')).toBe(true);

        const joinedEvidence = (obs.findings ?? []).map((f) => `${f.title} ${f.evidence}`).join('\n');
        expect(joinedEvidence).not.toContain(FAKE_GH_TOKEN);
        expect(joinedEvidence).not.toContain(FAKE_AWS_KEY);
        expect(srv.externalHits()).toBe(0);
      } finally {
        await session.close();
      }
    } finally {
      await driver.close();
    }
  }, 30_000);

  it('keeps plans green by default (--fail-on none) and fails via CLI only when confirmed findings reach --fail-on', async () => {
    const planFile = path.join(tmp, 'plan.json');
    await writeFile(
      planFile,
      JSON.stringify({
        format: 'miqyas-plan',
        version: 1,
        id: 'detectors-flow',
        steps: [
          {
            id: 'a1',
            type: 'assertion',
            text: "'Fixture Loaded' heading is shown",
            check: { locator: { role: 'heading', name: 'Fixture Loaded' }, expect: 'visible' },
          },
        ],
      }),
    );

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const outDefault = path.join(tmp, 'out-default');
    const codeDefault = await main(['run', planFile, '--url', `${srv.url}/broken`, '--no-model', '--out', outDefault]);
    expect(codeDefault).toBe(0);
    const defaultReport = JSON.parse(await readFile(path.join(outDefault, 'report.json'), 'utf8')) as RunReport;
    expect(defaultReport.verdict).toBe('pass');
    expect(defaultReport.plans[0]!.verdict).toBe('pass');
    expect(defaultReport.findings?.length).toBeGreaterThanOrEqual(7);
    expect(schemaErrors('report', defaultReport)).toEqual([]);
    const defaultReportStr = JSON.stringify(defaultReport);
    expect(defaultReportStr).not.toContain(FAKE_GH_TOKEN);
    expect(defaultReportStr).not.toContain(FAKE_AWS_KEY);

    const outHigh = path.join(tmp, 'out-high');
    const codeHigh = await main(['run', planFile, '--url', `${srv.url}/broken`, '--no-model', '--fail-on', 'high', '--out', outHigh]);
    expect(codeHigh).toBe(1);
    const highReport = JSON.parse(await readFile(path.join(outHigh, 'report.json'), 'utf8')) as RunReport;
    expect(highReport.verdict).toBe('fail');
    expect(highReport.totals.plansPassed).toBe(1);
    expect(highReport.plans[0]!.verdict).toBe('pass');
    expect(highReport.method.settings.failOn).toBe('high');
    expect(schemaErrors('report', highReport)).toEqual([]);

    // Clean accessible page reports zero high/critical findings under --fail-on low.
    const cleanPlan = path.join(tmp, 'clean-plan.json');
    await writeFile(
      cleanPlan,
      JSON.stringify({
        format: 'miqyas-plan',
        version: 1,
        id: 'clean-flow',
        steps: [
          {
            id: 'a1',
            type: 'assertion',
            text: "'Clean App' heading is shown",
            check: { locator: { role: 'heading', name: 'Clean App' }, expect: 'visible' },
          },
        ],
      }),
    );
    const outClean = path.join(tmp, 'out-clean');
    const codeClean = await main(['run', cleanPlan, '--url', `${srv.url}/clean`, '--no-model', '--fail-on', 'low', '--out', outClean]);
    expect(codeClean).toBe(0);
  }, 45_000);
});
