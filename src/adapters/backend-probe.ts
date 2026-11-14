// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Active read-only backend & authorization probe adapter (Layer 2: adapters).
// Implements Grade 1 Checks 8 (public-key BaaS table read probe), 9 (two-account IDOR replay),
// and 10 (sessionless protected-route replay). Strictly gated behind `--active` + host ownership
// policy, never mutates data (GET/HEAD only except test-account login), stops on 429/503, and
// NEVER persists or returns row field values (FR-B9, FR-Q7).

import { createHash } from 'node:crypto';
import type { CrawlResult, ServedArtifact } from '../surfaces/session.js';
import { createRateLimiter, DEFAULT_CRAWL_RPS } from '../surfaces/web/crawler.js';
import {
  bareHost,
  HostPolicyError,
  isTestHost,
  tryParseUrl,
  verifyHostOwnership,
  type HostOwnershipOptions,
} from '../surfaces/web/policy.js';

export const PROBE_ADAPTER_ID = 'miqyas-probe';
export const PROBE_ADAPTER_VERSION = '0.1.0';
const MAX_BACKEND_PROBES = 25;
const MAX_ROUTE_PROBES = 25;
const PROBE_TIMEOUT_MS = 5000;

export type BackendProvider = 'supabase' | 'firebase-rtdb' | 'firebase-firestore';

export interface DetectedBackendTarget {
  provider: BackendProvider;
  baseUrl: string;
  publicKey?: string;
  tables: string[];
}

export interface BackendTableProbeResult {
  provider: BackendProvider;
  /** Origin + pathname ONLY (never carries query tokens or row values). */
  endpoint: string;
  table: string;
  status: number;
  hasRows: boolean;
  /** Column / field keys ONLY — row values are never persisted. */
  columns: string[];
}

export interface Check8BackendProbeResult {
  executed: boolean;
  reason?: string;
  haltedReason?: 'rate-limit' | 'max-probes';
  targets: DetectedBackendTarget[];
  probes: BackendTableProbeResult[];
  exposedTables: BackendTableProbeResult[];
  coverage: string;
}

export interface TestAccountSpec {
  name: 'A' | 'B';
  headers?: Record<string, string>;
  cookie?: string;
  bearerToken?: string;
  loginUrl?: string;
  credentials?: Record<string, string>;
  resourceUrls?: string[];
  protectedRoutes?: string[];
}

export interface IdorProbeRecord {
  endpoint: string;
  resourceLabel: string;
  statusA: number;
  statusB: number;
  leakedToB: boolean;
}

export interface Check9IdorProbeResult {
  executed: boolean;
  reason?: string;
  haltedReason?: 'rate-limit' | 'max-probes';
  probedCount: number;
  records: IdorProbeRecord[];
  idorLeaks: IdorProbeRecord[];
  coverage: string;
}

export interface AuthRouteProbeRecord {
  endpoint: string;
  statusNoSession: number;
  statusWithSession?: number;
  refused: boolean;
  detail: string;
}

export interface Check10AuthProbeResult {
  executed: boolean;
  reason?: string;
  haltedReason?: 'rate-limit' | 'max-probes';
  probedCount: number;
  records: AuthRouteProbeRecord[];
  unprotectedRoutes: AuthRouteProbeRecord[];
  coverage: string;
}

export interface ActiveProbeBaseOptions {
  url: string;
  active: boolean;
  allowHost?: string;
  hostToken?: string;
  maxRps?: number;
  fetchImpl?: typeof fetch;
  hostPolicyDeps?: Pick<HostOwnershipOptions, 'spendDir' | 'env' | 'fetchImpl' | 'resolveTxtImpl'>;
}

const KNOWN_BAAS_SUFFIXES = ['.supabase.co', '.supabase.in', '.firebaseio.com', '.firebasedatabase.app'];
export const AUTH_PATH_RE = /(?:login|signin|sign-in|sign_in|auth|sso|oauth)/i;
const PROTECTED_PATH_RE = /\/(?:api|rest\/v\d+|account|dashboard|profile|settings|orders|notes|billing|admin|me)\b/i;
export const DESTRUCTIVE_PATH_RE = /(?:logout|log-out|signout|sign-out|delete|destroy|remove|cancel|checkout|pay)\b/i;

export function cleanEndpointUrl(rawUrl: string): string {
  const u = tryParseUrl(rawUrl);
  return u ? `${u.origin}${u.pathname}` : rawUrl.split(/[?#]/)[0] ?? rawUrl;
}

export function safeSameOriginUrl(rawPathOrUrl: string, targetOrigin: string): URL | null {
  try {
    const u = new URL(rawPathOrUrl, targetOrigin);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === targetOrigin) return u;
  } catch {
    // ignore malformed URL
  }
  return null;
}

const PROBE_ADAPTER_VERSION_INTERNAL = PROBE_ADAPTER_VERSION;
void PROBE_ADAPTER_VERSION_INTERNAL;
const MAX_PROBE_RESPONSE_CHARS = 512 * 1024;

function normalizeHttpOriginPath(rawUrl: string): string | null {
  const u = tryParseUrl(rawUrl);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  const cleanPath = u.pathname.replace(/\/+$/, '');
  return cleanPath === '' ? u.origin : `${u.origin}${cleanPath}`;
}

function isAllowedBackendProbeHost(backendUrl: URL, targetUrl: URL): boolean {
  if (backendUrl.protocol !== 'http:' && backendUrl.protocol !== 'https:') return false;
  const host = bareHost(backendUrl.hostname);
  if (!host || host === '169.254.169.254' || host.startsWith('169.254.')) return false;
  if (backendUrl.origin === targetUrl.origin) return true;
  if (isTestHost(bareHost(targetUrl.hostname)) && isTestHost(host)) return true;
  if (host === 'firestore.googleapis.com') return true;
  return KNOWN_BAAS_SUFFIXES.some((s) => host.endsWith(s));
}

function decodeJwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const raw = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { role?: unknown };
    return typeof parsed.role === 'string' ? parsed.role.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isPublicClientKey(token: string): boolean {
  if (!token || token.startsWith('sb_secret_')) return false;
  if (token.startsWith('sb_publishable_')) return true;
  if (!token.startsWith('eyJ')) return false;
  const role = decodeJwtRole(token);
  if (role === 'service_role') return false;
  return role === 'anon' || role === null;
}

export async function preflightActiveProbe(opts: ActiveProbeBaseOptions): Promise<URL | null> {
  if (!opts.active) return null;
  const targetUrl = tryParseUrl(opts.url);
  if (!targetUrl || (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:')) {
    throw new HostPolicyError(`invalid target URL "${opts.url}"`);
  }
  await verifyHostOwnership({
    url: opts.url,
    ...(opts.allowHost ? { allowHost: opts.allowHost } : {}),
    active: true,
    allowWrites: false,
    probeKind: 'active-read',
    ...(opts.hostToken ? { expectedToken: opts.hostToken } : {}),
    ...opts.hostPolicyDeps,
  });
  return targetUrl;
}

/** Discover Supabase and Firebase backend endpoints, public keys, and table/collection names from crawl artifacts. */
export function detectBackendTargets(
  crawl?: CrawlResult,
  extraSources: { text: string; url?: string }[] = [],
): DetectedBackendTarget[] {
  const artifacts: Pick<ServedArtifact, 'url' | 'text' | 'kind'>[] = [
    ...(crawl?.servedArtifacts ?? []),
    ...extraSources.map((s) => ({ kind: 'bundle' as const, url: s.url ?? '', text: s.text })),
  ];
  for (const s of crawl?.screens ?? []) {
    artifacts.push({ kind: 'url', url: s.url, text: s.url });
  }

  const supabaseBases = new Map<string, { publicKey?: string; tables: Set<string> }>();
  const rtdbBases = new Map<string, Set<string>>();
  const firestoreBases = new Map<string, { publicKey?: string; tables: Set<string> }>();

  const ensureSupa = (base: string) => {
    const clean = normalizeHttpOriginPath(base) ?? base.replace(/\/+$/, '');
    let entry = supabaseBases.get(clean);
    if (!entry) {
      entry = { tables: new Set() };
      supabaseBases.set(clean, entry);
    }
    return entry;
  };
  const ensureRtdb = (base: string) => {
    const clean = normalizeHttpOriginPath(base) ?? base.replace(/\/+$/, '');
    let tables = rtdbBases.get(clean);
    if (!tables) {
      tables = new Set();
      rtdbBases.set(clean, tables);
    }
    return tables;
  };
  const ensureFs = (base: string) => {
    const clean = normalizeHttpOriginPath(base) ?? base.replace(/\/+$/, '');
    let entry = firestoreBases.get(clean);
    if (!entry) {
      entry = { tables: new Set() };
      firestoreBases.set(clean, entry);
    }
    return entry;
  };

  for (const art of artifacts) {
    const text = art.text ?? '';
    const artUrl = art.url ?? '';

    // 1. URL-level detections in artifact URL and body
    for (const rawUrlStr of [artUrl, ...Array.from(text.matchAll(/https?:\/\/[^\s'"`)<>]+/g), (m) => m[0])]) {
      const u = tryParseUrl(rawUrlStr.replace(/[;,\]\\]+$/, ''));
      if (!u) continue;
      const host = bareHost(u.hostname);
      if (host.endsWith('.supabase.co') || host.endsWith('.supabase.in')) {
        ensureSupa(u.origin);
      }
      const restIdx = u.pathname.indexOf('/rest/v1');
      if (restIdx >= 0) {
        const prefix = u.pathname.slice(0, restIdx);
        const entry = ensureSupa(`${u.origin}${prefix}`);
        const after = u.pathname.slice(restIdx + '/rest/v1'.length).replace(/^\/+/, '');
        const table = after.split('/')[0];
        if (table && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(table)) entry.tables.add(table);
      }
      if (host.endsWith('.firebaseio.com') || host.endsWith('.firebasedatabase.app')) {
        const tables = ensureRtdb(u.origin);
        const seg = u.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] ?? '';
        if (seg.endsWith('.json')) {
          const col = seg.slice(0, -'.json'.length);
          if (col) tables.add(col);
        }
      }
      const fsMatch = u.pathname.match(/^(\/v1\/projects\/[^/]+\/databases\/\(default\)\/documents)(?:\/([A-Za-z0-9_-]+))?/);
      if (fsMatch) {
        const entry = ensureFs(`${u.origin}${fsMatch[1]}`);
        const apiKey = u.searchParams.get('key');
        if (apiKey && !entry.publicKey) entry.publicKey = apiKey;
        if (fsMatch[2]) entry.tables.add(fsMatch[2]);
      }
    }

    // 2. Relative /rest/v1/<table> or /v1/projects/... paths inside JS/HTML
    for (const m of text.matchAll(/['"`]((?:https?:\/\/[^'"`]+)?\/rest\/v1\/([A-Za-z_][A-Za-z0-9_-]*))[^'"`]*['"`]/g)) {
      const baseOrigin = tryParseUrl(artUrl)?.origin;
      const resolved = m[1]?.startsWith('http') ? tryParseUrl(m[1]) : baseOrigin ? safeSameOriginUrl(m[1]!, baseOrigin) : null;
      if (resolved) {
        const idx = resolved.pathname.indexOf('/rest/v1');
        const entry = ensureSupa(`${resolved.origin}${resolved.pathname.slice(0, idx)}`);
        if (m[2]) entry.tables.add(m[2]);
      }
    }
    for (const m of text.matchAll(/['"`]((?:https?:\/\/[^'"`]+)?\/v1\/projects\/([^/'"`]+)\/databases\/\(default\)\/documents(?:\/([A-Za-z0-9_-]+))?)[^'"`]*['"`]/g)) {
      const baseOrigin = tryParseUrl(artUrl)?.origin;
      const resolved = m[1]?.startsWith('http') ? tryParseUrl(m[1]) : baseOrigin ? safeSameOriginUrl(m[1]!, baseOrigin) : null;
      if (resolved) {
        const docPrefix = `/v1/projects/${m[2]}/databases/(default)/documents`;
        const entry = ensureFs(`${resolved.origin}${docPrefix}`);
        if (m[3]) entry.tables.add(m[3]);
      }
    }

    // 3. Supabase createClient(url, key) & config keys
    for (const m of text.matchAll(/createClient\s*\(\s*['"](https?:\/\/[^'"]+)['"]\s*,\s*['"]([A-Za-z0-9._-]+)['"]/g)) {
      if (m[1] && m[2]) {
        const entry = ensureSupa(m[1]);
        if (isPublicClientKey(m[2])) entry.publicKey ??= m[2];
      }
    }
    const supaUrlMatch = text.match(/(?:SUPABASE_URL|supabaseUrl)\s*[:=]\s*['"](https?:\/\/[^'"]+)['"]/);
    if (supaUrlMatch?.[1]) {
      ensureSupa(supaUrlMatch[1]);
    }
    const anonKeyMatch = text.match(
      /(?:SUPABASE_ANON_KEY|SUPABASE_PUBLISHABLE_KEY|supabaseAnonKey|anonKey)\s*[:=]\s*['"]((?:sb_publishable_|eyJ)[A-Za-z0-9._-]+)['"]/,
    );
    const anonCandidate = anonKeyMatch?.[1] && isPublicClientKey(anonKeyMatch[1]) ? anonKeyMatch[1] : undefined;
    const anonKey =
      anonCandidate ??
      text.match(/\bsb_publishable_[A-Za-z0-9_-]{12,}\b/)?.[0] ??
      Array.from(text.matchAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g))
        .map((m) => m[0])
        .find((tok) => decodeJwtRole(tok) === 'anon');
    if (anonKey && supabaseBases.size > 0) {
      for (const entry of supabaseBases.values()) {
        entry.publicKey ??= anonKey;
      }
    }
    for (const m of text.matchAll(/\.from\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_-]*)['"]\s*\)/g)) {
      if (m[1]) {
        for (const entry of supabaseBases.values()) entry.tables.add(m[1]);
      }
    }

    // 4. Firebase config object detection (databaseURL, projectId, apiKey, collection names)
    const dbUrlMatch = text.match(/databaseURL\s*[:=]\s*['"](https?:\/\/[^'"]+)['"]/);
    if (dbUrlMatch?.[1]) {
      ensureRtdb(dbUrlMatch[1].replace(/\/\.json.*$/, ''));
    }
    const projectIdMatch = text.match(/\bprojectId\s*[:=]\s*['"]([a-z0-9-]+)['"]/);
    const fbApiKey = text.match(/\bapiKey\s*[:=]\s*['"](AIza[0-9A-Za-z_-]{20,})['"]/)?.[1];
    if (projectIdMatch?.[1] && (fbApiKey || text.includes('firestore') || text.includes('firebase'))) {
      const origin = tryParseUrl(artUrl)?.origin;
      const fsBase =
        origin && text.includes(`/v1/projects/${projectIdMatch[1]}`)
          ? `${origin}/v1/projects/${projectIdMatch[1]}/databases/(default)/documents`
          : `https://firestore.googleapis.com/v1/projects/${projectIdMatch[1]}/databases/(default)/documents`;
      const fsEntry = ensureFs(fsBase);
      if (fbApiKey) fsEntry.publicKey ??= fbApiKey;
    }
    for (const m of text.matchAll(/(?:\.collection\s*\(|collection\s*\(\s*[A-Za-z_$][A-Za-z0-9_$.]*\s*,)\s*['"]([A-Za-z_][A-Za-z0-9_-]*)['"]/g)) {
      if (m[1]) {
        for (const entry of firestoreBases.values()) entry.tables.add(m[1]);
        for (const tables of rtdbBases.values()) tables.add(m[1]);
      }
    }
  }

  const out: DetectedBackendTarget[] = [];
  for (const [baseUrl, info] of supabaseBases) {
    out.push({
      provider: 'supabase',
      baseUrl,
      ...(info.publicKey ? { publicKey: info.publicKey } : {}),
      tables: [...info.tables],
    });
  }
  for (const [baseUrl, tables] of rtdbBases) {
    out.push({ provider: 'firebase-rtdb', baseUrl, tables: [...tables] });
  }
  for (const [baseUrl, info] of firestoreBases) {
    out.push({
      provider: 'firebase-firestore',
      baseUrl,
      ...(info.publicKey ? { publicKey: info.publicKey } : {}),
      tables: [...info.tables],
    });
  }
  return out;
}

/** Parse response body in isolation, discarding ALL row scalar values and returning only row presence + column keys. */
export function summarizeBackendResponseZeroValues(
  provider: BackendProvider,
  rawText: string,
  status: number,
): { hasRows: boolean; columns: string[] } {
  if (status < 200 || status >= 300) return { hasRows: false, columns: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { hasRows: false, columns: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { hasRows: false, columns: [] };

  if (provider === 'supabase') {
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return { hasRows: false, columns: [] };
      const first = parsed[0];
      const cols =
        first && typeof first === 'object' && !Array.isArray(first)
          ? Object.keys(first as Record<string, unknown>).slice(0, 30)
          : [];
      return { hasRows: true, columns: cols };
    }
    return { hasRows: false, columns: [] };
  }

  if (provider === 'firebase-firestore') {
    const obj = parsed as { documents?: unknown; error?: unknown };
    if (obj.error) return { hasRows: false, columns: [] };
    if (Array.isArray(obj.documents) && obj.documents.length > 0) {
      const first = obj.documents[0] as { fields?: unknown } | undefined;
      const cols =
        first?.fields && typeof first.fields === 'object' && !Array.isArray(first.fields)
          ? Object.keys(first.fields as Record<string, unknown>).slice(0, 30)
          : [];
      return { hasRows: true, columns: cols };
    }
    return { hasRows: false, columns: [] };
  }

  // Firebase RTDB (?shallow=true returns { "<docOrKey>": true })
  const rtdbObj = parsed as Record<string, unknown>;
  if ('error' in rtdbObj) return { hasRows: false, columns: [] };
  const keys = Object.keys(rtdbObj);
  return { hasRows: keys.length > 0, columns: [] };
}

function parseOpenApiTables(rawText: string): string[] {
  try {
    const doc = JSON.parse(rawText) as { paths?: Record<string, unknown>; definitions?: Record<string, unknown> };
    const names = new Set<string>();
    for (const p of Object.keys(doc.paths ?? {})) {
      const seg = p.replace(/^\/+/, '').split('/')[0] ?? '';
      if (seg && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(seg) && seg !== 'rpc') names.add(seg);
    }
    for (const def of Object.keys(doc.definitions ?? {})) {
      if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(def)) names.add(def);
    }
    return [...names];
  } catch {
    return [];
  }
}

export async function safeRequestText(
  fetchFn: typeof fetch,
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body?: string,
  redirect: 'manual' | 'follow' = 'manual',
): Promise<{ status: number; location: string; contentType: string; text: string } | null> {
  try {
    const res = await fetchFn(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const rawText = await res.text().catch(() => '');
    const text = rawText.length > MAX_PROBE_RESPONSE_CHARS ? rawText.slice(0, MAX_PROBE_RESPONSE_CHARS) : rawText;
    return {
      status: res.status,
      location: res.headers.get('location') ?? '',
      contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
      text,
    };
  } catch {
    return null;
  }
}

export async function safeGetText(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  redirect: 'manual' | 'follow' = 'manual',
): Promise<{ status: number; location: string; contentType: string; text: string } | null> {
  return safeRequestText(fetchFn, 'GET', url, headers, undefined, redirect);
}

/** Check 8 implementation: gated active GET-only probe against detected Supabase/Firebase endpoints. */
export async function probeBackendPublicAccess(
  opts: ActiveProbeBaseOptions & { crawl?: CrawlResult; targets?: DetectedBackendTarget[] },
): Promise<Check8BackendProbeResult> {
  const targetUrl = await preflightActiveProbe(opts);
  if (!targetUrl) {
    return { executed: false, reason: '--active was not passed', targets: [], probes: [], exposedTables: [], coverage: '0 backend targets probed' };
  }

  const targets = opts.targets ?? detectBackendTargets(opts.crawl);
  if (targets.length === 0) {
    return {
      executed: false,
      reason: 'no Supabase or Firebase backend targets detected in crawl artifacts',
      targets: [],
      probes: [],
      exposedTables: [],
      coverage: '0 backend targets detected',
    };
  }

  const fetchFn = opts.fetchImpl ?? fetch;
  const limiter = createRateLimiter(opts.maxRps ?? DEFAULT_CRAWL_RPS);
  const probes: BackendTableProbeResult[] = [];
  let haltedReason: 'rate-limit' | 'max-probes' | undefined;

  for (const target of targets) {
    if (haltedReason) break;
    const baseParsed = tryParseUrl(target.baseUrl);
    if (!baseParsed || !isAllowedBackendProbeHost(baseParsed, targetUrl)) continue;

    if (target.provider === 'supabase') {
      const headers: Record<string, string> = {};
      if (target.publicKey) {
        headers.apikey = target.publicKey;
        headers.authorization = `Bearer ${target.publicKey}`;
      }
      const discoveredTables = new Set(target.tables);
      // Query PostgREST OpenAPI root when available (1 GET, no row data).
      if (probes.length < MAX_BACKEND_PROBES) {
        await limiter.acquire();
        const rootRes = await safeGetText(fetchFn, `${target.baseUrl}/rest/v1/`, headers);
        if (rootRes) {
          if (rootRes.status === 429 || rootRes.status === 503) {
            haltedReason = 'rate-limit';
            break;
          }
          if (rootRes.status >= 200 && rootRes.status < 300) {
            for (const t of parseOpenApiTables(rootRes.text)) discoveredTables.add(t);
          }
        }
      }
      for (const table of discoveredTables) {
        if (probes.length >= MAX_BACKEND_PROBES) {
          haltedReason = 'max-probes';
          break;
        }
        await limiter.acquire();
        const reqUrl = `${target.baseUrl}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`;
        const res = await safeGetText(fetchFn, reqUrl, headers);
        if (!res) continue;
        if (res.status === 429 || res.status === 503) {
          haltedReason = 'rate-limit';
          break;
        }
        const meta = summarizeBackendResponseZeroValues('supabase', res.text, res.status);
        probes.push({
          provider: 'supabase',
          endpoint: cleanEndpointUrl(reqUrl),
          table,
          status: res.status,
          hasRows: meta.hasRows,
          columns: meta.columns,
        });
      }
    } else if (target.provider === 'firebase-rtdb') {
      const collections = new Set(target.tables);
      if (collections.size === 0 && probes.length < MAX_BACKEND_PROBES) {
        await limiter.acquire();
        const rootUrl = `${target.baseUrl}/.json?shallow=true`;
        const res = await safeGetText(fetchFn, rootUrl, {});
        if (res) {
          if (res.status === 429 || res.status === 503) {
            haltedReason = 'rate-limit';
            break;
          }
          const meta = summarizeBackendResponseZeroValues('firebase-rtdb', res.text, res.status);
          probes.push({
            provider: 'firebase-rtdb',
            endpoint: cleanEndpointUrl(rootUrl),
            table: '(root)',
            status: res.status,
            hasRows: meta.hasRows,
            columns: [],
          });
        }
      }
      for (const col of collections) {
        if (probes.length >= MAX_BACKEND_PROBES) {
          haltedReason = 'max-probes';
          break;
        }
        await limiter.acquire();
        const reqUrl = `${target.baseUrl}/${encodeURIComponent(col)}.json?shallow=true`;
        const res = await safeGetText(fetchFn, reqUrl, {});
        if (!res) continue;
        if (res.status === 429 || res.status === 503) {
          haltedReason = 'rate-limit';
          break;
        }
        const meta = summarizeBackendResponseZeroValues('firebase-rtdb', res.text, res.status);
        probes.push({
          provider: 'firebase-rtdb',
          endpoint: cleanEndpointUrl(reqUrl),
          table: col,
          status: res.status,
          hasRows: meta.hasRows,
          columns: [],
        });
      }
    } else if (target.provider === 'firebase-firestore') {
      for (const col of target.tables) {
        if (probes.length >= MAX_BACKEND_PROBES) {
          haltedReason = 'max-probes';
          break;
        }
        await limiter.acquire();
        const q = target.publicKey ? `?pageSize=1&key=${encodeURIComponent(target.publicKey)}` : '?pageSize=1';
        const reqUrl = `${target.baseUrl}/${encodeURIComponent(col)}${q}`;
        const res = await safeGetText(fetchFn, reqUrl, {});
        if (!res) continue;
        if (res.status === 429 || res.status === 503) {
          haltedReason = 'rate-limit';
          break;
        }
        const meta = summarizeBackendResponseZeroValues('firebase-firestore', res.text, res.status);
        probes.push({
          provider: 'firebase-firestore',
          endpoint: cleanEndpointUrl(reqUrl),
          table: col,
          status: res.status,
          hasRows: meta.hasRows,
          columns: meta.columns,
        });
      }
    }
  }

  if (probes.length === 0) {
    return {
      executed: false,
      ...(haltedReason ? { haltedReason } : {}),
      reason:
        haltedReason === 'rate-limit'
          ? 'rate-limit encountered (429/503) before any backend table could be probed'
          : 'backend endpoints detected but 0 tables/collections could be probed',
      targets,
      probes: [],
      exposedTables: [],
      coverage:
        haltedReason === 'rate-limit'
          ? '0 backend tables/collections probed (stopped early: rate-limit)'
          : '0 backend tables/collections probed',
    };
  }

  const exposedTables = probes.filter((p) => p.hasRows);
  const haltSuffix = haltedReason ? ` (stopped early: ${haltedReason})` : '';
  return {
    executed: true,
    ...(haltedReason ? { haltedReason } : {}),
    targets,
    probes,
    exposedTables,
    coverage: `${probes.length} table/collection probe(s) across ${targets.length} backend target(s)${haltSuffix}`,
  };
}

function parseAccountFromEnv(env: Record<string, string | undefined>, slot: 'A' | 'B'): TestAccountSpec | undefined {
  const prefixes = [`MIQYAS_SECRET_ACCOUNT_${slot}`, `MIQYAS_SECRET_TEST_${slot}`];
  for (const prefix of prefixes) {
    const rawJson = env[prefix] ?? env[`${prefix}_SESSION`];
    if (rawJson?.trim()) {
      try {
        const parsed = JSON.parse(rawJson) as Record<string, unknown>;
        return {
          name: slot,
          ...(typeof parsed.bearerToken === 'string'
            ? { bearerToken: parsed.bearerToken }
            : typeof parsed.token === 'string'
              ? { bearerToken: parsed.token }
              : {}),
          ...(typeof parsed.cookie === 'string' ? { cookie: parsed.cookie } : {}),
          ...(parsed.headers && typeof parsed.headers === 'object' && !Array.isArray(parsed.headers)
            ? { headers: parsed.headers as Record<string, string> }
            : {}),
          ...(typeof parsed.loginUrl === 'string' ? { loginUrl: parsed.loginUrl } : {}),
          ...(parsed.credentials && typeof parsed.credentials === 'object' && !Array.isArray(parsed.credentials)
            ? { credentials: parsed.credentials as Record<string, string> }
            : {}),
          ...(Array.isArray(parsed.resourceUrls) ? { resourceUrls: parsed.resourceUrls.map(String) } : {}),
          ...(Array.isArray(parsed.protectedRoutes) ? { protectedRoutes: parsed.protectedRoutes.map(String) } : {}),
        };
      } catch {
        // ignore invalid JSON wrapper and inspect discrete keys below
      }
    }
    const token = env[`${prefix}_TOKEN`]?.trim();
    const cookie = env[`${prefix}_COOKIE`]?.trim();
    const rawHeader = env[`${prefix}_HEADER`]?.trim();
    const loginUrl = env[`${prefix}_LOGIN_URL`]?.trim();
    const email = env[`${prefix}_EMAIL`]?.trim();
    const username = env[`${prefix}_USERNAME`]?.trim();
    const password = env[`${prefix}_PASSWORD`];
    const routesRaw = env[`${prefix}_ROUTES`]?.trim();
    const resourcesRaw = env[`${prefix}_RESOURCES`]?.trim();

    let headers: Record<string, string> | undefined;
    if (rawHeader) {
      const idx = rawHeader.indexOf(':');
      if (idx > 0) headers = { [rawHeader.slice(0, idx).trim()]: rawHeader.slice(idx + 1).trim() };
    }
    const credentials: Record<string, string> = {};
    if (email) credentials.email = email;
    if (username) credentials.username = username;
    if (password !== undefined) credentials.password = password;
    const routes = routesRaw ? routesRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const resources = resourcesRaw ? resourcesRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

    if (token || cookie || headers || Object.keys(credentials).length > 0 || routes?.length || resources?.length) {
      return {
        name: slot,
        ...(token ? { bearerToken: token } : {}),
        ...(cookie ? { cookie } : {}),
        ...(headers ? { headers } : {}),
        ...(loginUrl ? { loginUrl } : {}),
        ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
        ...(resources?.length ? { resourceUrls: resources } : {}),
        ...(routes?.length ? { protectedRoutes: routes } : {}),
      };
    }
  }
  return undefined;
}

/** Resolve test account A & B sessions/credentials strictly from `MIQYAS_SECRET_*` env vars. */
export function resolveTestAccountsFromEnv(env: Record<string, string | undefined>): TestAccountSpec[] {
  const out: TestAccountSpec[] = [];
  const a = parseAccountFromEnv(env, 'A');
  const b = parseAccountFromEnv(env, 'B');
  if (a) out.push(a);
  if (b) out.push(b);
  return out;
}

async function resolveAccountHeaders(
  account: TestAccountSpec,
  targetOrigin: string,
  fetchFn: typeof fetch,
): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...(account.headers ?? {}) };
  if (account.cookie) out.cookie = account.cookie;
  if (account.bearerToken) out.authorization = `Bearer ${account.bearerToken}`;
  if (Object.keys(out).length === 0 && account.loginUrl && account.credentials) {
    const u = safeSameOriginUrl(account.loginUrl, targetOrigin);
    if (!u) return out;
    try {
      const res = await fetchFn(u.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(account.credentials),
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        out.cookie = setCookie.split(';')[0] ?? setCookie;
      }
      if (!out.authorization && res.headers.get('content-type')?.includes('json')) {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        const tok =
          (typeof body?.access_token === 'string' && body.access_token) ||
          (typeof body?.token === 'string' && body.token) ||
          '';
        if (tok) out.authorization = `Bearer ${tok}`;
      }
    } catch {
      // Login failure leaves empty headers -> caller skips probing
    }
  }
  return out;
}

export function responseHasMeaningfulPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.length > 0;
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const keys = Object.keys(obj);
        if (keys.length === 0) return false;
        if (typeof obj.error === 'string' || obj.ok === false) return false;
        if (Array.isArray(obj.data) && obj.data.length === 0) return false;
        if (Array.isArray(obj.items) && obj.items.length === 0) return false;
        return true;
      }
      return parsed !== null && parsed !== false;
    } catch {
      return true;
    }
  }
  return trimmed.length > 0;
}

function payloadDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function extractCandidateIdUrls(rawText: string, baseUrl: string, targetOrigin: string): string[] {
  const urls: string[] = [];
  try {
    const parsed = JSON.parse(rawText) as unknown;
    const base = tryParseUrl(baseUrl);
    if (!base) return [];
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
        ? ((parsed as { items: unknown[] }).items)
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)
          ? ((parsed as { data: unknown[] }).data)
          : [parsed];
    for (const item of items.slice(0, 5)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const id = (item as Record<string, unknown>).id;
      if (typeof id === 'string' || typeof id === 'number') {
        const s = String(id).trim();
        if (!s || s === '.' || s === '..' || s.includes('/') || s.includes('\\')) continue;
        if (base.pathname.includes('/rest/v1/')) {
          const u = safeSameOriginUrl(`${base.origin}${base.pathname}?id=eq.${encodeURIComponent(s)}&select=*`, targetOrigin);
          if (u) urls.push(u.href);
        } else {
          const cleanPath = base.pathname.replace(/\/+$/, '');
          if (!cleanPath.endsWith(`/${s}`)) {
            const u = safeSameOriginUrl(`${base.origin}${cleanPath}/${encodeURIComponent(s)}`, targetOrigin);
            if (u) urls.push(u.href);
          }
        }
      }
    }
  } catch {
    // Non-JSON responses don't yield JSON record IDs
  }
  return urls;
}

/** Check 9 implementation: verify Account B cannot GET Account A's observed resource IDs (zero enumeration, zero row values persisted). */
export async function probeTwoAccountIdor(
  opts: ActiveProbeBaseOptions & {
    crawl?: CrawlResult;
    accounts?: readonly TestAccountSpec[];
  },
): Promise<Check9IdorProbeResult> {
  const targetUrl = await preflightActiveProbe(opts);
  if (!targetUrl) {
    return { executed: false, reason: '--active was not passed', probedCount: 0, records: [], idorLeaks: [], coverage: '0 IDOR probes' };
  }

  const accA = opts.accounts?.[0];
  const accB = opts.accounts?.[1];
  if (!accA || !accB) {
    return {
      executed: false,
      reason: 'two test accounts were not provided',
      probedCount: 0,
      records: [],
      idorLeaks: [],
      coverage: '0 IDOR probes (two test accounts missing)',
    };
  }

  const fetchFn = opts.fetchImpl ?? fetch;
  const headersA = await resolveAccountHeaders(accA, targetUrl.origin, fetchFn);
  const headersB = await resolveAccountHeaders(accB, targetUrl.origin, fetchFn);
  if (Object.keys(headersA).length === 0 || Object.keys(headersB).length === 0) {
    return {
      executed: false,
      reason: 'could not establish authenticated headers/sessions for both test accounts',
      probedCount: 0,
      records: [],
      idorLeaks: [],
      coverage: '0 IDOR probes (account session missing)',
    };
  }

  const limiter = createRateLimiter(opts.maxRps ?? DEFAULT_CRAWL_RPS);
  const candidateUrls = new Set<string>();
  for (const r of [...(accA.resourceUrls ?? []), ...(accA.protectedRoutes ?? [])]) {
    const u = safeSameOriginUrl(r, targetUrl.origin);
    if (u && !DESTRUCTIVE_PATH_RE.test(u.pathname)) candidateUrls.add(u.href);
  }
  for (const s of opts.crawl?.screens ?? []) {
    const u = safeSameOriginUrl(s.url, targetUrl.origin);
    if (u && PROTECTED_PATH_RE.test(u.pathname) && !DESTRUCTIVE_PATH_RE.test(u.pathname) && !AUTH_PATH_RE.test(u.pathname)) {
      candidateUrls.add(u.href);
    }
  }
  // Discover same-origin API/object links seen during crawl.
  for (const art of opts.crawl?.servedArtifacts ?? []) {
    if (art.kind === 'url') {
      const u = safeSameOriginUrl(art.url, targetUrl.origin);
      if (u && PROTECTED_PATH_RE.test(u.pathname) && !DESTRUCTIVE_PATH_RE.test(u.pathname) && !AUTH_PATH_RE.test(u.pathname)) {
        candidateUrls.add(u.href);
      }
      continue;
    }
    for (const m of art.text.matchAll(/['"`](\/(?:api|rest\/v\d+)\/[A-Za-z0-9_./?=&-]+)['"`]/g)) {
      const u = m[1] ? safeSameOriginUrl(m[1], targetUrl.origin) : null;
      if (u && !DESTRUCTIVE_PATH_RE.test(u.pathname) && !AUTH_PATH_RE.test(u.pathname)) candidateUrls.add(u.href);
    }
  }

  // Phase 1: Observe Account A's own resources (GET only, manual redirects).
  const observedA: { url: URL; statusA: number; digestA: string }[] = [];
  const seenUrls = new Set<string>();
  const seedList = [...candidateUrls];
  let haltedReason: 'rate-limit' | 'max-probes' | undefined;
  let requestsIssued = 0;

  for (const rawUrl of seedList) {
    if (haltedReason || observedA.length >= MAX_ROUTE_PROBES) break;
    if (requestsIssued >= MAX_ROUTE_PROBES * 2) {
      haltedReason = 'max-probes';
      break;
    }
    if (seenUrls.has(rawUrl)) continue;
    seenUrls.add(rawUrl);
    const u = tryParseUrl(rawUrl);
    if (!u || u.origin !== targetUrl.origin) continue;

    await limiter.acquire();
    requestsIssued++;
    const resA = await safeGetText(fetchFn, u.href, headersA, 'manual');
    if (!resA) continue;
    if (resA.status === 429 || resA.status === 503) {
      haltedReason = 'rate-limit';
      break;
    }
    if (resA.status >= 200 && resA.status < 300 && responseHasMeaningfulPayload(resA.text)) {
      // If URL already targets an object/record (?id= or /<id>) or explicit resourceUrl, record it directly.
      const hasObjectRef =
        Boolean(accA.resourceUrls?.some((r) => safeSameOriginUrl(r, targetUrl.origin)?.href === u.href)) ||
        /\/\d+\b|\/[0-9a-f]{8}-[0-9a-f-]{27}\b|[?&]id=/i.test(`${u.pathname}${u.search}`);
      if (hasObjectRef) {
        observedA.push({ url: u, statusA: resA.status, digestA: payloadDigest(resA.text) });
      }
      // Also derive observed item GET URLs from Account A's collection response (zero enumeration).
      for (const childHref of extractCandidateIdUrls(resA.text, u.href, targetUrl.origin)) {
        if (haltedReason || observedA.length >= MAX_ROUTE_PROBES) break;
        if (requestsIssued >= MAX_ROUTE_PROBES * 2) {
          haltedReason = 'max-probes';
          break;
        }
        if (!seenUrls.has(childHref)) {
          seenUrls.add(childHref);
          await limiter.acquire();
          requestsIssued++;
          const childResA = await safeGetText(fetchFn, childHref, headersA, 'manual');
          if (!childResA) continue;
          if (childResA.status === 429 || childResA.status === 503) {
            haltedReason = 'rate-limit';
            break;
          }
          if (childResA.status >= 200 && childResA.status < 300 && responseHasMeaningfulPayload(childResA.text)) {
            const cu = tryParseUrl(childHref);
            if (cu) observedA.push({ url: cu, statusA: childResA.status, digestA: payloadDigest(childResA.text) });
          }
        }
      }
    }
  }

  if (observedA.length === 0) {
    return {
      executed: false,
      reason:
        haltedReason === 'rate-limit'
          ? 'rate-limit encountered (429/503) while discovering account-A resources'
          : '0 object-scoped resource references observed in first test account traffic',
      ...(haltedReason ? { haltedReason } : {}),
      probedCount: 0,
      records: [],
      idorLeaks: [],
      coverage:
        haltedReason === 'rate-limit'
          ? '0 observed account-A resource references replayed as account B (stopped early: rate-limit)'
          : '0 observed account-A resource references replayed as account B',
    };
  }

  // Phase 2: Replay Account A's exact GET URLs using Account B (read-only, manual redirect).
  const records: IdorProbeRecord[] = [];
  for (const item of observedA) {
    if (haltedReason) break;
    if (records.length >= MAX_ROUTE_PROBES) {
      haltedReason = 'max-probes';
      break;
    }
    await limiter.acquire();
    const resB = await safeGetText(fetchFn, item.url.href, headersB, 'manual');
    if (!resB) continue;
    if (resB.status === 429 || resB.status === 503) {
      haltedReason = 'rate-limit';
      break;
    }
    const leaked =
      resB.status >= 200 &&
      resB.status < 300 &&
      !AUTH_PATH_RE.test(resB.location) &&
      responseHasMeaningfulPayload(resB.text) &&
      (payloadDigest(resB.text) === item.digestA || item.url.pathname.includes('/api/') || item.url.pathname.includes('/rest/'));
    records.push({
      endpoint: cleanEndpointUrl(item.url.href),
      resourceLabel: `${item.url.pathname}${item.url.search}`,
      statusA: item.statusA,
      statusB: resB.status,
      leakedToB: leaked,
    });
  }

  const idorLeaks = records.filter((r) => r.leakedToB);
  const haltSuffix = haltedReason ? ` (stopped early: ${haltedReason})` : '';
  if (records.length === 0) {
    return {
      executed: false,
      reason:
        haltedReason === 'rate-limit'
          ? 'rate-limit encountered (429/503) before account B replay completed'
          : 'no account-A resource URLs could be replayed as account B',
      ...(haltedReason ? { haltedReason } : {}),
      probedCount: 0,
      records: [],
      idorLeaks: [],
      coverage: `0 account-A resource URL(s) replayed read-only as account B${haltSuffix}`,
    };
  }
  return {
    executed: true,
    ...(haltedReason ? { haltedReason } : {}),
    probedCount: records.length,
    records,
    idorLeaks,
    coverage: `${records.length} account-A resource URL(s) replayed read-only as account B${haltSuffix}`,
  };
}

/** Check 10 implementation: replay observed routes behind login without session credentials (`redirect: 'manual'`). */
export async function probeUnauthenticatedRoutes(
  opts: ActiveProbeBaseOptions & {
    crawl?: CrawlResult;
    accounts?: readonly TestAccountSpec[];
    protectedRoutes?: readonly string[];
  },
): Promise<Check10AuthProbeResult> {
  const targetUrl = await preflightActiveProbe(opts);
  if (!targetUrl) {
    return {
      executed: false,
      reason: '--active was not passed',
      probedCount: 0,
      records: [],
      unprotectedRoutes: [],
      coverage: '0 protected routes probed',
    };
  }

  const accA = opts.accounts?.[0];
  const explicitProtected = [...(opts.protectedRoutes ?? []), ...(accA?.protectedRoutes ?? [])];
  if (!accA && explicitProtected.length === 0) {
    return {
      executed: false,
      reason: 'one test account (or authenticated routes) was not provided',
      probedCount: 0,
      records: [],
      unprotectedRoutes: [],
      coverage: '0 protected routes probed (test account missing)',
    };
  }

  const fetchFn = opts.fetchImpl ?? fetch;
  const headersA = accA ? await resolveAccountHeaders(accA, targetUrl.origin, fetchFn) : {};
  const limiter = createRateLimiter(opts.maxRps ?? DEFAULT_CRAWL_RPS);

  const candidates = new Set<string>();
  for (const r of explicitProtected) {
    const u = safeSameOriginUrl(r, targetUrl.origin);
    if (u && !DESTRUCTIVE_PATH_RE.test(u.pathname)) candidates.add(u.href);
  }
  if (accA && Object.keys(headersA).length > 0) {
    for (const s of opts.crawl?.screens ?? []) {
      const u = safeSameOriginUrl(s.url, targetUrl.origin);
      if (u && PROTECTED_PATH_RE.test(u.pathname) && !AUTH_PATH_RE.test(u.pathname)) candidates.add(u.href);
    }
    for (const art of opts.crawl?.servedArtifacts ?? []) {
      for (const m of art.text.matchAll(/['"`](\/[A-Za-z0-9_./?=&-]+)['"`]/g)) {
        const u = m[1] ? safeSameOriginUrl(m[1], targetUrl.origin) : null;
        if (u && PROTECTED_PATH_RE.test(u.pathname) && !AUTH_PATH_RE.test(u.pathname) && !DESTRUCTIVE_PATH_RE.test(u.pathname)) {
          candidates.add(u.href);
        }
      }
    }
  }

  if (candidates.size === 0) {
    return {
      executed: false,
      reason: '0 protected/authenticated routes observed to replay without session',
      probedCount: 0,
      records: [],
      unprotectedRoutes: [],
      coverage: '0 authenticated routes observed',
    };
  }

  const records: AuthRouteProbeRecord[] = [];
  let haltedReason: 'rate-limit' | 'max-probes' | undefined;
  let requestsIssued = 0;
  let rejectedAccountARoutes = 0;

  for (const href of candidates) {
    if (haltedReason || records.length >= MAX_ROUTE_PROBES) break;
    if (requestsIssued >= MAX_ROUTE_PROBES * 2) {
      haltedReason = 'max-probes';
      break;
    }
    let statusWithSession: number | undefined;
    let bodyWithSession = '';
    if (Object.keys(headersA).length > 0) {
      await limiter.acquire();
      requestsIssued++;
      const resAuth = await safeGetText(fetchFn, href, headersA, 'manual');
      if (resAuth) {
        if (resAuth.status === 429 || resAuth.status === 503) {
          haltedReason = 'rate-limit';
          break;
        }
        statusWithSession = resAuth.status;
        bodyWithSession = resAuth.text;
        const authRejected =
          resAuth.status === 401 ||
          resAuth.status === 403 ||
          (resAuth.status >= 300 && resAuth.status < 400 && AUTH_PATH_RE.test(resAuth.location));
        if (authRejected) {
          rejectedAccountARoutes++;
          continue;
        }
        // Skip candidate paths that don't exist even when authenticated.
        if (resAuth.status === 404 && !explicitProtected.some((p) => safeSameOriginUrl(p, targetUrl.origin)?.href === href)) {
          continue;
        }
      }
    }

    await limiter.acquire();
    requestsIssued++;
    const resAnon = await safeGetText(fetchFn, href, {}, 'manual');
    if (!resAnon) continue;
    if (resAnon.status === 429 || resAnon.status === 503) {
      haltedReason = 'rate-limit';
      break;
    }

    const isRedirectToAuth = resAnon.status >= 300 && resAnon.status < 400 && AUTH_PATH_RE.test(resAnon.location);
    const isUnauthorizedStatus = resAnon.status === 401 || resAnon.status === 403 || isRedirectToAuth;
    const isHtmlLoginGate =
      resAnon.status === 200 &&
      resAnon.contentType.includes('text/html') &&
      /type=["']?password["']?/i.test(resAnon.text) &&
      (!bodyWithSession || payloadDigest(resAnon.text) !== payloadDigest(bodyWithSession));
    const hasAnonData = resAnon.status >= 200 && resAnon.status < 300 && responseHasMeaningfulPayload(resAnon.text) && !isHtmlLoginGate;

    const refused = isUnauthorizedStatus || isHtmlLoginGate || !hasAnonData;
    records.push({
      endpoint: cleanEndpointUrl(href),
      statusNoSession: resAnon.status,
      ...(statusWithSession !== undefined ? { statusWithSession } : {}),
      refused,
      detail: refused
        ? isRedirectToAuth
          ? `redirected unauthenticated request (${resAnon.status})`
          : `refused unauthenticated access (HTTP ${resAnon.status})`
        : `returned HTTP ${resAnon.status} without session credentials`,
    });
  }

  if (records.length === 0) {
    const reason =
      haltedReason === 'rate-limit'
        ? 'rate-limit encountered (429/503) before sessionless route replay completed'
        : rejectedAccountARoutes > 0
          ? 'test account A session was rejected on candidate protected routes (HTTP 401/403/redirect-to-login)'
          : '0 live authenticated routes found to replay without session';
    return {
      executed: false,
      reason,
      ...(haltedReason ? { haltedReason } : {}),
      probedCount: 0,
      records: [],
      unprotectedRoutes: [],
      coverage: haltedReason === 'rate-limit' ? '0 authenticated routes replayed (stopped early: rate-limit)' : '0 authenticated routes replayed',
    };
  }

  const unprotectedRoutes = records.filter((r) => !r.refused);
  const haltSuffix = haltedReason ? ` (stopped early: ${haltedReason})` : '';
  return {
    executed: true,
    ...(haltedReason ? { haltedReason } : {}),
    probedCount: records.length,
    records,
    unprotectedRoutes,
    coverage: `${records.length} authenticated route(s) replayed without session${haltSuffix}`,
  };
}
