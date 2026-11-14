// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/entry/cli.js';
import { launch, measureProbe, openWebSurfaceDriver } from '../../src/surfaces/web/driver.js';
import { schemaErrors } from '../report-helpers.js';

describe('crawler + unified origin proxy e2e (#14)', () => {
  let appSrv: Server;
  let offOriginSrv: Server;
  let appUrl = '';
  let offOriginUrl = '';
  let formSubmits = 0;
  let destructiveHits = 0;
  let depth4Hits = 0;
  let offOriginHits = 0;

  beforeAll(async () => {
    offOriginSrv = createServer((req, res) => {
      offOriginHits++;
      res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>External</h1>');
    });
    await new Promise<void>((r) => offOriginSrv.listen(0, '127.0.0.1', r));
    const offPort = (offOriginSrv.address() as { port: number }).port;
    offOriginUrl = `http://127.0.0.1:${offPort}`;

    appSrv = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/submit') {
        formSubmits++;
        res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Submitted</h1>');
        return;
      }
      if (path === '/logout' || path === '/delete-hit') {
        destructiveHits++;
        res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Destroyed</h1>');
        return;
      }
      if (path === '/depth4') {
        depth4Hits++;
        res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Depth 4</h1>');
        return;
      }
      if (path === '/too-many') {
        res.writeHead(429, { 'content-type': 'text/plain' }).end('Slow down');
        return;
      }
      if (path === '/unavailable') {
        res.writeHead(503, { 'content-type': 'text/plain' }).end('Unavailable');
        return;
      }
      const html = (title: string, body: string) =>
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
          html(
            'Home',
            `
            <nav>
              <a href="/depth1">Level 1</a>
              <a href="/tabs">Tabs View</a>
              <a href="${offOriginUrl}/leak">Off Origin</a>
              <a href="/logout">Logout</a>
            </nav>
            <form method="post" action="/submit">
              <input name="q" value="abc">
              <button type="submit">Submit Form</button>
              <button type="button" onclick="fetch('/delete-hit')">Safe Label Post Form</button>
            </form>
            <button type="button" onclick="fetch('/delete-hit')">حذف الحساب</button>
            <button type="button" onclick="fetch('/delete-hit')">Pay now</button>
            `,
          ),
        );
        return;
      }
      if (path === '/depth1') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(html('Depth 1', '<a href="/depth2">Level 2</a>'));
        return;
      }
      if (path === '/depth2') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(html('Depth 2', '<a href="/depth3">Level 3</a>'));
        return;
      }
      if (path === '/depth3') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(html('Depth 3', '<a href="/depth4">Level 4</a>'));
        return;
      }
      if (path === '/tabs') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(
          html(
            'Tabs Page',
            `
            <button type="button" role="tab" onclick="document.getElementById('panel').innerHTML='<h2>Details Tab</h2>'">Details</button>
            <div id="panel">Initial panel</div>
            `,
          ),
        );
        return;
      }
      if (path === '/rate-seed') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(
          html('Rate Seed', '<a href="/too-many">Hit 429</a><a href="/never-after-429">Never Visited</a>'),
        );
        return;
      }
      if (path === '/probe-leak') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(
          `<!doctype html><title>Probe Isolation</title>
           <div id="box">clean</div>
           <iframe src="${offOriginUrl}/iframe-leak"></iframe>
           <script>fetch('${offOriginUrl}/fetch-leak').catch(()=>{});</script>`,
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(html('Other', `<p>${path}</p>`));
    });
    await new Promise<void>((r) => appSrv.listen(0, '127.0.0.1', r));
    const appPort = (appSrv.address() as { port: number }).port;
    appUrl = `http://127.0.0.1:${appPort}`;
  });

  afterAll(async () => {
    appSrv.closeAllConnections();
    offOriginSrv.closeAllConnections();
    await Promise.all([
      new Promise((r) => appSrv.close(r)),
      new Promise((r) => offOriginSrv.close(r)),
    ]);
  });

  it('crawls same-origin links & tabs within depth 3, skips submits and EN/AR destructive controls, and stays on origin', async () => {
    formSubmits = 0;
    destructiveHits = 0;
    depth4Hits = 0;
    offOriginHits = 0;
    const driver = await openWebSurfaceDriver();
    try {
      const res = await driver.crawl!({
        url: `${appUrl}/`,
        maxDepth: 3,
        maxScreens: 50,
        maxRps: 20,
      });
      const titles = res.screens.map((s) => s.title);
      expect(titles).toContain('Home');
      expect(titles).toContain('Depth 1');
      expect(titles).toContain('Depth 2');
      expect(titles).toContain('Depth 3');
      expect(res.screens.some((s) => s.observation.renderedText?.includes('Details Tab'))).toBe(true);
      expect(formSubmits).toBe(0);
      expect(destructiveHits).toBe(0);
      expect(depth4Hits).toBe(0);
      expect(offOriginHits).toBe(0);
      expect(res.skippedOffOriginLinks).toBeGreaterThanOrEqual(1);
      expect(res.skippedControls).toBeGreaterThanOrEqual(4);
    } finally {
      await driver.close();
    }
  }, 30_000);

  it('halts immediately on the first 429 or 503 response', async () => {
    const driver = await openWebSurfaceDriver();
    try {
      const res429 = await driver.crawl!({
        url: `${appUrl}/rate-seed`,
        maxDepth: 3,
        maxScreens: 50,
        maxRps: 20,
      });
      expect(res429.haltedReason).toBe('http-429');
      expect(res429.screens.some((s) => s.url.includes('/never-after-429'))).toBe(false);

      const res503 = await driver.crawl!({
        url: `${appUrl}/unavailable`,
        maxDepth: 3,
        maxScreens: 50,
        maxRps: 20,
      });
      expect(res503.haltedReason).toBe('http-503');
    } finally {
      await driver.close();
    }
  }, 30_000);

  it('blocks off-origin iframe/fetch traffic in mutation measureProbe via the shared origin proxy policy', async () => {
    offOriginHits = 0;
    const browser = await launch(false, true);
    try {
      const reading = await measureProbe(browser, `${appUrl}/probe-leak`, { measure: 'text' });
      expect(String(reading)).toContain('clean');
      expect(offOriginHits).toBe(0);
    } finally {
      await browser.close();
    }
  }, 20_000);

  it('runs CLI miqyas run --crawl --no-model with zero plan arguments and produces a schema-valid report', async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-crawl-cli-'));
    try {
      const code = await main([
        'run',
        '--crawl',
        '--max-screens',
        '10',
        '--max-depth',
        '2',
        '--max-rps',
        '20',
        '--url',
        `${appUrl}/`,
        '--no-model',
        '--out',
        outDir,
      ]);
      expect(code).toBe(0);
      const report = JSON.parse(await readFile(path.join(outDir, 'report.json'), 'utf8'));
      expect(schemaErrors('report', report)).toEqual([]);
      expect(report.verdict).toBe('pass');
      expect(report.method.settings).toMatchObject({
        crawl: true,
        maxScreens: 10,
        maxDepth: 2,
        maxRps: 20,
        allowOtherOrigins: false,
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});
