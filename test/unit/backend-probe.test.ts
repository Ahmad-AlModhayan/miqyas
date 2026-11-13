// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { describe, expect, it } from 'vitest';
import {
  detectBackendTargets,
  probeBackendPublicAccess,
  probeTwoAccountIdor,
  probeUnauthenticatedRoutes,
  resolveTestAccountsFromEnv,
  summarizeBackendResponseZeroValues,
} from '../../src/adapters/backend-probe.js';
import type { CrawlResult } from '../../src/surfaces/session.js';
import { HostPolicyError } from '../../src/surfaces/web/policy.js';

function fakeJwt(role: string): string {
  const hdr = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const pay = Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url');
  return `${hdr}.${pay}.sig`;
}

function makeCrawl(artifacts: { kind: 'bundle' | 'dom' | 'response' | 'url'; url: string; text: string }[]): CrawlResult {
  return {
    screens: [
      {
        url: 'http://127.0.0.1:4173/',
        depth: 0,
        title: 'App',
        observation: {
          capture: 1,
          url: 'http://127.0.0.1:4173/',
          title: 'App',
          lang: 'en',
          dir: 'ltr',
          viewport: { width: 1280, height: 800 },
          nodes: [],
          truncated: false,
          png: Buffer.alloc(0),
          capturedAt: new Date(0),
        },
      },
    ],
    skippedControls: 0,
    skippedOffOriginLinks: 0,
    servedArtifacts: artifacts.map((a, i) => ({ kind: a.kind, name: `art-${i}`, url: a.url, text: a.text })),
  };
}

describe('backend-probe adapter (#19 Checks 8, 9, 10)', () => {
  it('detects Supabase anon keys (ignoring service_role) and Firebase RTDB/Firestore targets', () => {
    const anonJwt = fakeJwt('anon');
    const serviceJwt = fakeJwt('service_role');
    const crawl = makeCrawl([
      {
        kind: 'bundle',
        url: 'http://127.0.0.1:4173/app.js',
        text: `
          const sb = createClient("http://127.0.0.1:54321", "${anonJwt}");
          const leakedAdmin = "${serviceJwt}";
          sb.from("profiles").select("*");
          const fbConfig = { apiKey: "AIzaSyTestFakeKey1234567890123", databaseURL: "https://demo-app.firebaseio.com", projectId: "demo-app" };
          firestore.collection("invoices");
        `,
      },
    ]);

    const targets = detectBackendTargets(crawl);
    const supa = targets.find((t) => t.provider === 'supabase');
    const rtdb = targets.find((t) => t.provider === 'firebase-rtdb');
    const fs = targets.find((t) => t.provider === 'firebase-firestore');
    expect(supa).toMatchObject({ baseUrl: 'http://127.0.0.1:54321', publicKey: anonJwt });
    expect(supa?.tables).toContain('profiles');
    expect(rtdb?.baseUrl).toBe('https://demo-app.firebaseio.com');
    expect(fs?.tables).toContain('invoices');
  });

  it('never retains row field values when summarizing Supabase or Firestore responses', () => {
    const sentinel = 'ROW_SECRET_EMAIL_DO_NOT_SAVE_9911@example.test';
    const supaMeta = summarizeBackendResponseZeroValues(
      'supabase',
      JSON.stringify([{ id: 1, email: sentinel, phone: '+966500000001' }]),
      200,
    );
    expect(supaMeta).toEqual({ hasRows: true, columns: ['id', 'email', 'phone'] });
    expect(JSON.stringify(supaMeta)).not.toContain(sentinel);

    const fsMeta = summarizeBackendResponseZeroValues(
      'firebase-firestore',
      JSON.stringify({ documents: [{ name: 'projects/p/databases/(default)/documents/users/1', fields: { email: { stringValue: sentinel } } }] }),
      200,
    );
    expect(fsMeta).toEqual({ hasRows: true, columns: ['email'] });
    expect(JSON.stringify(fsMeta)).not.toContain(sentinel);
  });

  it('gates Check 8 behind --active + host policy and stops on 429/503', async () => {
    const crawl = makeCrawl([
      {
        kind: 'bundle',
        url: 'http://127.0.0.1:4173/app.js',
        text: `fetch("http://127.0.0.1:4173/rest/v1/profiles"); fetch("http://169.254.169.254/rest/v1/metadata");`,
      },
    ]);

    const inactive = await probeBackendPublicAccess({ url: 'http://127.0.0.1:4173/', active: false, crawl });
    expect(inactive.executed).toBe(false);

    await expect(
      probeBackendPublicAccess({ url: 'https://unowned-victim.example/', active: true, crawl }),
    ).rejects.toThrow(HostPolicyError);

    const fetchedUrls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const u = String(input);
      fetchedUrls.push(u);
      if (u.endsWith('/rest/v1/')) {
        return new Response(JSON.stringify({ paths: { '/profiles': {}, '/audit': {} } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/rest/v1/profiles')) {
        return new Response(JSON.stringify([{ id: 1, email: 'SECRET_ROW_VALUE' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('rate limit', { status: 429 });
    };

    const res = await probeBackendPublicAccess({
      url: 'http://127.0.0.1:4173/',
      active: true,
      maxRps: 100,
      crawl,
      fetchImpl: mockFetch,
    });
    expect(res.executed).toBe(true);
    expect(res.haltedReason).toBe('rate-limit');
    expect(res.exposedTables).toHaveLength(1);
    expect(res.exposedTables[0]?.columns).toEqual(['id', 'email']);
    expect(JSON.stringify(res)).not.toContain('SECRET_ROW_VALUE');
    expect(fetchedUrls.some((u) => u.includes('169.254.169.254'))).toBe(false);
  });

  it('resolves two test accounts from MIQYAS_SECRET_* and runs read-only IDOR (Check 9) and unauthenticated replay (Check 10)', async () => {
    const accounts = resolveTestAccountsFromEnv({
      MIQYAS_SECRET_ACCOUNT_A_TOKEN: 'tok-user-a',
      MIQYAS_SECRET_ACCOUNT_A_ROUTES: '/api/orders,/api/profile',
      MIQYAS_SECRET_ACCOUNT_B_TOKEN: 'tok-user-b',
    });
    expect(accounts).toHaveLength(2);

    const methods: string[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      methods.push(init?.method ?? 'GET');
      const url = new URL(String(input));
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';

      if (url.pathname === '/api/orders') {
        if (!auth) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
        if (auth === 'Bearer tok-user-a') {
          return new Response(JSON.stringify([{ id: 'ord-a-42', secretVal: 'SECRET_A_ORDER' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname === '/api/orders/ord-a-42') {
        if (!auth) return new Response('nope', { status: 401 });
        // Simulate IDOR: user B can read user A's order record!
        return new Response(JSON.stringify({ id: 'ord-a-42', secretVal: 'SECRET_A_ORDER' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/api/profile') {
        // Missing auth check on /api/profile -> 200 even with no auth!
        return new Response(JSON.stringify({ email: 'LEAKED_PROFILE_EMAIL' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const idor = await probeTwoAccountIdor({
      url: 'http://127.0.0.1:4173/',
      active: true,
      maxRps: 100,
      accounts,
      fetchImpl: mockFetch,
    });
    expect(idor.executed).toBe(true);
    expect(idor.idorLeaks).toHaveLength(1);
    expect(idor.idorLeaks[0]?.resourceLabel).toBe('/api/orders/ord-a-42');
    expect(methods.every((m) => m === 'GET')).toBe(true);
    expect(JSON.stringify(idor)).not.toContain('SECRET_A_ORDER');

    const authCheck = await probeUnauthenticatedRoutes({
      url: 'http://127.0.0.1:4173/',
      active: true,
      maxRps: 100,
      accounts,
      fetchImpl: mockFetch,
    });
    expect(authCheck.executed).toBe(true);
    expect(authCheck.unprotectedRoutes).toHaveLength(1);
    expect(authCheck.unprotectedRoutes[0]?.endpoint).toBe('http://127.0.0.1:4173/api/profile');
    expect(JSON.stringify(authCheck)).not.toContain('LEAKED_PROFILE_EMAIL');
  });

  it('rejects sb_secret_/service_role public keys, enforces redirect manual & test-host SSRF boundary, stops IDOR on 429, and rejects unauthenticated Account A', async () => {
    const serviceJwt = fakeJwt('service_role');
    const taintedTargets = detectBackendTargets(undefined, [
      {
        url: 'https://app.owned.example/app.js',
        text: `
          const sb1 = createClient("https://db.supabase.co?x=1", "sb_secret_NEVER_USE_999");
          const SUPABASE_ANON_KEY = "${serviceJwt}";
          sb1.from("secrets").select("*");
        `,
      },
    ]);
    const supaTarget = taintedTargets.find((t) => t.provider === 'supabase');
    expect(supaTarget?.baseUrl).toBe('https://db.supabase.co');
    expect(supaTarget?.publicKey).toBeUndefined();

    const redirectsUsed: (string | undefined)[] = [];
    const fetchedHosts: string[] = [];
    const ssrfRes = await probeBackendPublicAccess({
      url: 'https://app.owned.example/',
      active: true,
      allowHost: 'app.owned.example',
      hostToken: 'miqyas-verify-0123456789abcdef',
      maxRps: 100,
      hostPolicyDeps: { resolveTxtImpl: async () => [['miqyas-verify=miqyas-verify-0123456789abcdef']] },
      targets: [
        { provider: 'supabase', baseUrl: 'http://127.0.0.1:54321', tables: ['users'] },
        { provider: 'supabase', baseUrl: 'http://10.0.0.5:8080', tables: ['users'] },
        { provider: 'supabase', baseUrl: 'https://app.owned.example', publicKey: 'sb_publishable_ok_123', tables: ['public_items'] },
      ],
      fetchImpl: async (input, init) => {
        redirectsUsed.push(init?.redirect);
        fetchedHosts.push(new URL(String(input)).hostname);
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    expect(ssrfRes.executed).toBe(true);
    expect(fetchedHosts.every((h) => h === 'app.owned.example')).toBe(true);
    expect(redirectsUsed.every((r) => r === 'manual')).toBe(true);

    // Check 9 stops on 429 during child discovery and respects '.' / '..' ID filtering
    const idorCalls: string[] = [];
    const idor429 = await probeTwoAccountIdor({
      url: 'http://127.0.0.1:4173/',
      active: true,
      maxRps: 100,
      accounts: [
        { name: 'A', bearerToken: 'tok-a', protectedRoutes: ['/api/docs'] },
        { name: 'B', bearerToken: 'tok-b' },
      ],
      fetchImpl: async (input) => {
        const u = new URL(String(input)).pathname;
        idorCalls.push(u);
        if (u === '/api/docs') {
          return new Response(JSON.stringify([{ id: '..' }, { id: 'doc-1' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('rate limited', { status: 429 });
      },
    });
    expect(idor429.executed).toBe(false);
    expect(idor429.haltedReason).toBe('rate-limit');
    expect(idorCalls).toEqual(['/api/docs', '/api/docs/doc-1']);

    // Check 10 does not pass when Account A's own session is rejected with 401
    const c10BadSession = await probeUnauthenticatedRoutes({
      url: 'http://127.0.0.1:4173/',
      active: true,
      maxRps: 100,
      accounts: [{ name: 'A', bearerToken: 'expired-tok', protectedRoutes: ['/dashboard'] }],
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    });
    expect(c10BadSession.executed).toBe(false);
    expect(c10BadSession.reason).toContain('session was rejected');
  });
});
