// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { describe, expect, it } from 'vitest';
import type { CrawlResult } from '../../src/surfaces/session.js';
import { CANARY_HOST } from '../../src/surfaces/web/detectors.js';
import { HostPolicyError } from '../../src/surfaces/web/policy.js';
import {
  discoverParamCandidates,
  discoverSpendingRoutes,
  probeParamSecurity,
  probeSpendingRoutes,
} from '../../src/adapters/param-spend-probe.js';

function makeCrawl(artifacts: CrawlResult['servedArtifacts'], screenUrls: string[] = ['http://127.0.0.1:4173/']): CrawlResult {
  return {
    screens: screenUrls.map((url, idx) => ({
      url,
      depth: idx,
      title: `Screen ${idx}`,
      observation: {
        capture: idx,
        url,
        title: `Screen ${idx}`,
        lang: 'en',
        dir: 'ltr',
        viewport: { width: 1280, height: 800 },
        nodes: [],
        truncated: false,
        png: Buffer.alloc(0),
        capturedAt: new Date(0),
      },
    })),
    skippedControls: 0,
    skippedOffOriginLinks: 0,
    servedArtifacts: artifacts,
  };
}

describe('param-spend-probe adapter (#20 Checks 11 & 12)', () => {
  it('discovers URL query params and HTML form params cleanly', () => {
    const crawl = makeCrawl([
      {
        kind: 'dom',
        name: 'index.html',
        url: 'http://127.0.0.1:4173/',
        text: '<form action="/search"><input name="q" /><input name="password" /></form><a href="/go?next=/home">Go</a>',
      },
    ]);
    const cands = discoverParamCandidates('http://127.0.0.1:4173', crawl);
    expect(cands).toEqual([
      { baseUrl: 'http://127.0.0.1:4173/go', param: 'next', source: 'url' },
      { baseUrl: 'http://127.0.0.1:4173/search', param: 'q', source: 'form' },
    ]);
  });

  it('Check 11 runs inert miqyas-probe-<runId> probes, catches unescaped XSS & open redirects, ignores escaped HTML, and respects time limits', async () => {
    const crawl = makeCrawl([
      {
        kind: 'dom',
        name: 'index.html',
        url: 'http://127.0.0.1:4173/?q=hello',
        text: '<a href="/jump?next=/dash">Jump</a>',
      },
    ]);

    const inactive = await probeParamSecurity({ url: 'http://127.0.0.1:4173/', active: false, crawl, runId: 'r1' });
    expect(inactive.executed).toBe(false);

    await expect(
      probeParamSecurity({ url: 'https://unowned.example/?q=hi', active: true, crawl, runId: 'r1' }),
    ).rejects.toThrow(HostPolicyError);

    const seenUrls: string[] = [];
    const vulnRes = await probeParamSecurity({
      url: 'http://127.0.0.1:4173/',
      active: true,
      maxRps: 100,
      runId: 'test42',
      crawl,
      fetchImpl: async (input) => {
        const u = new URL(String(input));
        seenUrls.push(u.href);
        if (u.pathname === '/' && u.searchParams.get('q')?.includes('miqyas-probe-test42')) {
          return new Response(`<p>Search: ${u.searchParams.get('q')}</p>`, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        if (u.pathname === '/jump' && u.searchParams.get('next')?.includes(CANARY_HOST)) {
          return new Response(null, { status: 302, headers: { location: u.searchParams.get('next')! } });
        }
        return new Response('<p>Escaped</p>', { status: 200, headers: { 'content-type': 'text/html' } });
      },
    });
    expect(vulnRes.executed).toBe(true);
    expect(vulnRes.probeTag).toBe('miqyas-probe-test42');
    expect(vulnRes.issues.map((i) => i.kind)).toEqual(['reflected-xss', 'open-redirect']);
    expect(seenUrls.every((u) => !u.includes('<script') && !u.includes('onerror='))).toBe(true);

    // Escaped HTML response passes cleanly
    const cleanRes = await probeParamSecurity({
      url: 'http://127.0.0.1:4173/',
      active: true,
      maxRps: 100,
      runId: 'clean1',
      crawl,
      fetchImpl: async () =>
        new Response('<p>Search: miqyas-probe-clean1&quot;&lt;</p>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    expect(cleanRes.executed).toBe(true);
    expect(cleanRes.issues).toEqual([]);

    // Sanitized stripped HTML (no quotes or angle brackets inside canary bookends) does NOT false-positive
    const strippedRes = await probeParamSecurity({
      url: 'http://127.0.0.1:4173/',
      active: true,
      maxRps: 100,
      runId: 'cleanstrip',
      crawl,
      fetchImpl: async () =>
        new Response('<p>Search: miqyas-probe-cleanstripmqend</p>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    expect(strippedRes.executed).toBe(true);
    expect(strippedRes.issues).toEqual([]);

    // Partial HTML escaping leaving '<' unescaped before mqend DOES fail reflected XSS
    const partialEscapeRes = await probeParamSecurity({
      url: 'http://127.0.0.1:4173/',
      active: true,
      maxRps: 100,
      runId: 'partial',
      crawl,
      fetchImpl: async () =>
        new Response('<p>Search: miqyas-probe-partial&quot;<mqend</p>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    expect(partialEscapeRes.executed).toBe(true);
    expect(partialEscapeRes.issues.some((i) => i.kind === 'reflected-xss')).toBe(true);

    // Total network failure / timeout leaves executed: false so Check 11 stays not_checked
    const totalFailRes = await probeParamSecurity({
      url: 'http://127.0.0.1:4173/',
      active: true,
      maxRps: 100,
      runId: 'netfail',
      crawl,
      fetchImpl: async () => {
        throw new Error('simulated network timeout');
      },
    });
    expect(totalFailRes.executed).toBe(false);
    expect(totalFailRes.probedCount).toBe(0);
    expect(totalFailRes.reason).toBe('all parameter probe requests failed or timed out');

    // Expired deadline stops before sending requests
    const droppedRes = await probeParamSecurity({
      url: 'http://127.0.0.1:4173/',
      active: true,
      runId: 'drop1',
      crawl,
      deadlineMs: 100,
      now: () => 200,
    });
    expect(droppedRes.executed).toBe(false);
    expect(droppedRes.haltedReason).toBe('time-limit');
  });

  it('Check 12 blocks spending probes off test hosts unless --allow-writes + owned host, and flags unauthenticated 2xx', async () => {
    const crawl = makeCrawl([
      {
        kind: 'bundle',
        name: 'app.js',
        url: 'http://127.0.0.1:4173/app.js',
        text: 'fetch("/api/chat"); fetch("/api/send-sms"); fetch("/api/checkout"); fetch("/api/logout"); fetch("/api/chat-missing"); fetch("/api/email-err"); fetch("/api/ai-spa-fallback");',
      },
    ]);
    const discovered = discoverSpendingRoutes('http://127.0.0.1:4173', crawl);
    expect(discovered).toContain('http://127.0.0.1:4173/api/chat');
    expect(discovered).toContain('http://127.0.0.1:4173/api/send-sms');
    expect(discovered).toContain('http://127.0.0.1:4173/api/checkout');
    expect(discovered).not.toContain('http://127.0.0.1:4173/api/logout');

    // Off test host without --allow-writes stays blocked (write-policy), never throwing
    const offHostBlocked = await probeSpendingRoutes({
      url: 'https://owned.example/',
      active: true,
      allowHost: 'owned.example',
      allowWrites: false,
      crawl,
    });
    expect(offHostBlocked.executed).toBe(false);
    expect(offHostBlocked.haltedReason).toBe('write-policy');
    expect(offHostBlocked.reason).toContain('--allow-writes');

    // Off test host WITH --allow-writes still enforces host ownership token verification
    await expect(
      probeSpendingRoutes({
        url: 'https://owned.example/',
        active: true,
        allowWrites: true,
        crawl,
      }),
    ).rejects.toThrow(HostPolicyError);

    // On test host, catches unauthenticated /api/chat and /api/checkout (200 JSON), accepts 401 on /api/send-sms,
    // and skips 404, 500, and non-login SPA text/html 200 fallbacks
    const testHostRes = await probeSpendingRoutes({
      url: 'http://127.0.0.1:4173/',
      active: true,
      maxRps: 100,
      crawl,
      runId: 'spend1',
      fetchImpl: async (input) => {
        const p = new URL(String(input)).pathname;
        if (p === '/api/chat' || p === '/api/checkout') {
          return new Response(JSON.stringify({ reply: 'billed unauthenticated!' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (p === '/api/chat-missing') {
          return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
        }
        if (p === '/api/email-err') {
          return new Response('server error', { status: 500, headers: { 'content-type': 'text/plain' } });
        }
        if (p === '/api/ai-spa-fallback') {
          return new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(testHostRes.executed).toBe(true);
    expect(testHostRes.probedCount).toBe(3);
    expect(testHostRes.unprotectedRoutes.map((r) => r.endpoint).sort()).toEqual([
      'http://127.0.0.1:4173/api/chat',
      'http://127.0.0.1:4173/api/checkout',
    ]);
  });
});
