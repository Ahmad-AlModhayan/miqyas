// SPDX-License-Identifier: Apache-2.0
// Unified web target policy (Layer 1: surfaces): same-origin isolation rules across pages/frames/workers/probes,
// Test-host vs verified Owned-host gating for active checks and writes, and non-negotiable never-do guards.

import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Route } from 'playwright';

export class HostPolicyError extends Error {}

export type ProbeKind = 'passive' | 'active-read' | 'active-write';

export interface HostVerificationResult {
  classification: 'test-host' | 'owned-host' | 'public-passive';
  verifiedVia?: 'well-known' | 'dns-txt';
  token?: string;
}

export interface HostOwnershipOptions {
  url: string;
  allowHost?: string;
  active: boolean;
  allowWrites: boolean;
  probeKind: ProbeKind;
  expectedToken?: string;
  spendDir?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  resolveTxtImpl?: (hostname: string) => Promise<string[][]>;
}

export const bareHost = (host: string): string => host.trim().replace(/^\[|\]$/g, '').toLowerCase();

export function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Normalized `host:port` with default HTTP(S)/WS(S) ports applied. */
export function hostPort(u: URL): string {
  const defaultPort = u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80';
  return `${u.hostname.toLowerCase()}:${u.port || defaultPort}`;
}

/** Strict HTTP(S) proxy URL check (no `data:` or `blob:` over the TCP/HTTP proxy). */
export function isAllowedHttpProxyUrl(rawUrl: string, allowedOrigin: string): boolean {
  const u = tryParseUrl(rawUrl);
  return u !== null && (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === allowedOrigin;
}

/** Shared HTTP(S)/subresource/iframe URL isolation check: permits same origin, `data:`, and same-origin `blob:`. */
export function isAllowedRequestUrl(rawUrl: string, allowedOrigin: string): boolean {
  if (rawUrl.startsWith('data:')) return true;
  if (rawUrl.startsWith('blob:')) {
    const inner = tryParseUrl(rawUrl.slice('blob:'.length));
    return inner !== null && inner.origin === allowedOrigin;
  }
  const u = tryParseUrl(rawUrl);
  if (!u) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.origin === allowedOrigin;
}

/** Shared WebSocket origin check: requires matching scheme (`http`<->`ws`, `https`<->`wss`) and exact `host:port`. */
export function isAllowedWebSocketUrl(rawUrl: string, allowedOrigin: string): boolean {
  const u = tryParseUrl(rawUrl);
  const allowed = tryParseUrl(allowedOrigin);
  if (!u || !allowed) return false;
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return false;
  const expectedProto = allowed.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.protocol === expectedProto && hostPort(u) === hostPort(allowed);
}

/** Shared proxy CONNECT tunnel check: permits only the target `host:port`. */
export function isAllowedConnectHostPort(authority: string, allowedOrigin: string): boolean {
  const u = tryParseUrl(`http://${authority}`);
  const allowed = tryParseUrl(allowedOrigin);
  if (!u || !allowed) return false;
  return hostPort(u) === hostPort(allowed);
}

/** Attach route + WebSocket isolation handlers using one shared origin policy. */
export async function attachOriginIsolation(
  target: BrowserContext | Page,
  allowedOrigin: string,
  opts: { onBeforeRequest?: (route: Route, reqUrl: string) => boolean | void | Promise<boolean | void> } = {},
): Promise<void> {
  await target.route('**/*', async (route) => {
    const reqUrl = route.request().url();
    if (opts.onBeforeRequest) {
      const handled = await opts.onBeforeRequest(route, reqUrl);
      if (handled === true) return;
    }
    if (isAllowedRequestUrl(reqUrl, allowedOrigin)) return route.continue();
    return route.abort('blockedbyclient');
  });

  if ('routeWebSocket' in target && typeof target.routeWebSocket === 'function') {
    await target.routeWebSocket(/.*/, (ws) => {
      if (isAllowedWebSocketUrl(ws.url(), allowedOrigin)) return void ws.connectToServer();
      return ws.close({ code: 1008, reason: `blocked: not ${allowedOrigin}` });
    });
  }
}

/**
 * True only for loopback, RFC1918 IPv4, ULA IPv6, and explicit `.test` / `.local` / `.internal` hostnames.
 * Link-local metadata ranges (`169.254.0.0/16`) and all public hostnames return false.
 */
export function isTestHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (host.endsWith('.test') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^f[cd]00::/i.test(host)) return true;

  const parts = host.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

export function normalizeHostname(hostOrUrl: string): string {
  const trimmed = hostOrUrl.trim();
  const parsed = trimmed.includes('://') ? tryParseUrl(trimmed) : tryParseUrl(`https://${trimmed}`);
  if (!parsed || !parsed.hostname) throw new HostPolicyError(`invalid host "${hostOrUrl}"`);
  return bareHost(parsed.hostname);
}

interface HostTokensFile {
  version: 1;
  hosts: Record<string, string>;
}

function defaultPolicyDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MIQYAS_HOME?.trim() || path.join(os.homedir(), '.miqyas');
}

const HOST_TOKEN_RE = /^miqyas-verify-[a-f0-9]{16,}$/i;

function assertValidHostToken(token: string, sourceLabel: string): string {
  if (!HOST_TOKEN_RE.test(token)) {
    throw new HostPolicyError(
      `invalid host verification token from ${sourceLabel}: expected a generated "miqyas-verify-<hex>" token (>=16 hex chars)`,
    );
  }
  return token;
}

export async function resolveOrCreateHostToken(
  hostname: string,
  opts: { spendDir?: string; env?: NodeJS.ProcessEnv; explicitToken?: string } = {},
): Promise<{ token: string; source: 'flag' | 'env' | 'store' | 'generated' }> {
  const host = bareHost(hostname);
  const env = opts.env ?? process.env;
  const flagToken = opts.explicitToken?.trim();
  if (flagToken) return { token: assertValidHostToken(flagToken, '--host-token'), source: 'flag' };
  const envToken = env.MIQYAS_HOST_TOKEN?.trim();
  if (envToken) return { token: assertValidHostToken(envToken, 'MIQYAS_HOST_TOKEN'), source: 'env' };

  const dir = opts.spendDir ?? defaultPolicyDir(env);
  const file = path.join(dir, 'host-tokens.json');
  let store: HostTokensFile = { version: 1, hosts: {} };
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<HostTokensFile>;
    if (raw && raw.version === 1 && raw.hosts && typeof raw.hosts === 'object') {
      store = { version: 1, hosts: { ...raw.hosts } };
    }
  } catch {
    // First token on this device.
  }
  const existing = store.hosts[host];
  if (existing) return { token: existing, source: 'store' };

  const token = `miqyas-verify-${randomBytes(12).toString('hex')}`;
  store.hosts[host] = token;
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
  return { token, source: 'generated' };
}

function tokenMatches(candidate: string, expectedToken: string): boolean {
  const lines = candidate
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.some(
    (line) =>
      line === expectedToken ||
      line === `miqyas-verify=${expectedToken}` ||
      line.split(/\s+/).includes(expectedToken) ||
      line.split(/\s+/).includes(`miqyas-verify=${expectedToken}`),
  );
}

/**
 * Enforce Test-host vs verified Owned-host authorization for passive, active-read, and active-write probes.
 * Plan files are never consulted; host consent and write permission come strictly from CLI/runtime flags.
 */
export async function verifyHostOwnership(opts: HostOwnershipOptions): Promise<HostVerificationResult> {
  const target = tryParseUrl(opts.url);
  if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
    throw new HostPolicyError(`target URL "${opts.url}" must use http: or https:`);
  }
  const host = bareHost(target.hostname);
  if (opts.probeKind === 'passive') {
    return { classification: isTestHost(host) ? 'test-host' : 'public-passive' };
  }

  if (!opts.active) {
    throw new HostPolicyError('refused active check: pass --active to enable inert active probes');
  }
  if (isTestHost(host)) {
    return { classification: 'test-host' };
  }

  if (!opts.allowHost) {
    throw new HostPolicyError(
      `refused active check on non-test host "${host}": pass --allow-host ${host} and verify host ownership`,
    );
  }
  const allowedHost = normalizeHostname(opts.allowHost);
  if (allowedHost !== host) {
    throw new HostPolicyError(
      `refused active check: --allow-host "${allowedHost}" does not match target host "${host}"`,
    );
  }
  if (opts.probeKind === 'active-write' && !opts.allowWrites) {
    throw new HostPolicyError(
      `refused state-mutating active probe on non-test host "${host}": pass --allow-writes in addition to --active and --allow-host`,
    );
  }

  const { token } = await resolveOrCreateHostToken(host, {
    ...(opts.spendDir !== undefined ? { spendDir: opts.spendDir } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.expectedToken !== undefined ? { explicitToken: opts.expectedToken } : {}),
  });

  const wellKnownUrl = `${target.origin}/.well-known/miqyas.txt`;
  const fetchFn = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(wellKnownUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (res.ok && !contentType.includes('html')) {
      const body = (await res.text()).slice(0, 4096);
      if (tokenMatches(body, token)) {
        return { classification: 'owned-host', verifiedVia: 'well-known', token };
      }
    }
  } catch {
    // Fall through to DNS TXT verification.
  }

  const dnsName = `_miqyas.${host}`;
  const resolveDns = opts.resolveTxtImpl ?? resolveTxt;
  try {
    const records = await resolveDns(dnsName);
    for (const chunks of records) {
      if (tokenMatches(chunks.join(''), token)) {
        return { classification: 'owned-host', verifiedVia: 'dns-txt', token };
      }
    }
  } catch {
    // Unverified host if DNS lookup fails or returns NXDOMAIN.
  }

  throw new HostPolicyError(
    `refused active check on non-test host "${host}": ownership token not verified. Place "${token}" at ${wellKnownUrl} or in a DNS TXT record for ${dnsName}`,
  );
}

const EN_DESTRUCTIVE_RE =
  /\b(delete|remove|destroy|erase|purge|wipe|revoke|cancel|terminate|pay|purchase|buy|checkout|charge|billing|transfer|send|submit|publish|post|logout|log\s+out|sign\s+out|signout|disconnect|deactivate|close\s+account|reset)\b/i;

const AR_DESTRUCTIVE_RE =
  /(?:حذف|إزالة|ازالة|مسح|إلغاء|الغاء|دفع|شراء|إتمام\s+الشراء|اتمام\s+الشراء|تحويل|إرسال|ارسال|أرسل|ارسل|نشر|خروج|تسجيل\s+الخروج|تعطيل|إغلاق\s+الحساب|اغلاق\s+الحساب|حظر)/;

export interface ControlDescriptor {
  tagName?: string;
  type?: string;
  formMethod?: string;
  inForm?: boolean;
  label?: string;
  ariaLabel?: string;
  title?: string;
  name?: string;
  href?: string;
}

/** True if a UI control could submit a form, invoke a mutating HTTP method, or trigger an EN/AR destructive action. */
export function isDestructiveControl(ctrl: ControlDescriptor): boolean {
  const tag = (ctrl.tagName ?? '').toLowerCase();
  const type = (ctrl.type ?? '').toLowerCase();
  const formMethod = (ctrl.formMethod ?? '').toLowerCase();

  if (type === 'submit' || type === 'image') return true;
  if (ctrl.inForm && tag === 'button' && (!type || type === 'submit')) return true;
  if (formMethod === 'post' || formMethod === 'put' || formMethod === 'delete' || formMethod === 'patch') return true;

  const texts = [ctrl.label, ctrl.ariaLabel, ctrl.title, ctrl.name, ctrl.href]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());

  return texts.some((t) => EN_DESTRUCTIVE_RE.test(t) || AR_DESTRUCTIVE_RE.test(t));
}

const CAPTCHA_WAF_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'Cloudflare Turnstile / challenge', re: /\b(?:cf-turnstile|cloudflare\s+turnstile|checking your browser|just a moment\.\.\.)\b/i },
  { name: 'reCAPTCHA', re: /\b(?:g-recaptcha|recaptcha\/api\.js)\b/i },
  { name: 'hCaptcha', re: /\b(?:h-captcha|hcaptcha\.com\/1\/api\.js)\b/i },
  { name: 'WAF block page', re: /\b(?:attention required!\s*\|\s*cloudflare|web application firewall|request blocked by waf)\b/i },
];

/** Detect CAPTCHA or WAF challenge signals so Miqyas stops and reports instead of attempting bypass. */
export function hasCaptchaOrWafSignal(input: { status?: number; bodyText?: string; html?: string; title?: string }): string | null {
  const haystack = [input.title ?? '', input.bodyText ?? '', input.html ?? ''].join('\n');
  for (const p of CAPTCHA_WAF_PATTERNS) {
    if (p.re.test(haystack)) return p.name;
  }
  return null;
}

/** Never-do guard: Miqyas must never upload a file that the executing plan step did not explicitly declare. */
export function assertPlanUploadAllowed(filePath: string, declaredUploads: readonly string[]): void {
  const normalized = path.normalize(filePath);
  const allowed = declaredUploads.some((d) => path.normalize(d) === normalized);
  if (!allowed) {
    throw new HostPolicyError(`refused file upload "${filePath}": file is not declared in the plan`);
  }
}
