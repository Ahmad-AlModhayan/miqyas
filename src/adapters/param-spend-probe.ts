// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Active inert parameter probes (Check 11: reflected XSS & open redirect) and
// unauthenticated spending-route probes (Check 12: LLM/SMS/email auth guard) (Layer 2: adapters).

import type { CrawlResult } from '../surfaces/session.js';
import { createRateLimiter, DEFAULT_CRAWL_RPS } from '../surfaces/web/crawler.js';
import { CANARY_HOST } from '../surfaces/web/detectors.js';
import {
  bareHost,
  HostPolicyError,
  isTestHost,
  tryParseUrl,
  verifyHostOwnership,
} from '../surfaces/web/policy.js';
import {
  AUTH_PATH_RE,
  cleanEndpointUrl,
  DESTRUCTIVE_PATH_RE,
  preflightActiveProbe,
  PROBE_ADAPTER_ID,
  PROBE_ADAPTER_VERSION,
  responseHasMeaningfulPayload,
  safeGetText,
  safeRequestText,
  safeSameOriginUrl,
  type ActiveProbeBaseOptions,
} from './backend-probe.js';

export { PROBE_ADAPTER_ID, PROBE_ADAPTER_VERSION };

const MAX_PARAM_PROBES = 25;
const MAX_SPEND_PROBES = 20;
const SKIP_PARAM_RE = /^(?:password|passwd|pwd|pass|secret|token|csrf|_csrf|xsrf|auth|apikey|api_key)$/i;
const SPENDING_PATH_RE =
  /\/(?:api\/)?(?:chat|completions|generate|ai|llm|openai|anthropic|gemini|embed|embeddings|tts|transcribe|sms|otp|twilio|send[-_]?sms|email|mail|send[-_]?email|resend|postmark|sendgrid|notify|billing|charge|checkout|pay|payment|stripe)\b/i;
const NON_SPENDING_DESTRUCTIVE_RE = /(?:logout|log-out|signout|sign-out|delete|destroy|remove|cancel)\b/i;
const XSS_END_SENTINEL = 'mqend';
const DROP_REASON_MESSAGE = 'dropped due to run time budget (drop order 12 -> 11 -> 3)';

export type ProbeHaltReason = 'rate-limit' | 'max-probes' | 'time-limit' | 'write-policy';

export interface ParamCandidate {
  baseUrl: string;
  param: string;
  source: 'url' | 'form';
}

export interface ParamSecurityIssue {
  kind: 'reflected-xss' | 'open-redirect';
  endpoint: string;
  param: string;
  probeTag: string;
  status: number;
  detail: string;
}

export interface Check11ParamProbeResult {
  executed: boolean;
  reason?: string;
  haltedReason?: ProbeHaltReason;
  probeTag: string;
  candidatesCount: number;
  probedCount: number;
  issues: ParamSecurityIssue[];
  coverage: string;
}

export interface SpendingRouteRecord {
  endpoint: string;
  method: 'POST' | 'GET';
  statusNoSession: number;
  refused: boolean;
  detail: string;
}

export interface Check12SpendProbeResult {
  executed: boolean;
  reason?: string;
  haltedReason?: ProbeHaltReason;
  probedCount: number;
  records: SpendingRouteRecord[];
  unprotectedRoutes: SpendingRouteRecord[];
  coverage: string;
}

function sanitizeProbeTag(runId: string | undefined): string {
  const clean = (runId ?? 'run').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'run';
  return `miqyas-probe-${clean}`;
}

function addQueryParamsFromUrl(
  u: URL,
  targetOrigin: string,
  source: 'url' | 'form',
  seen: Set<string>,
  out: ParamCandidate[],
): void {
  if (u.origin !== targetOrigin || DESTRUCTIVE_PATH_RE.test(u.pathname)) return;
  const cleanBase = `${u.origin}${u.pathname}`;
  for (const param of u.searchParams.keys()) {
    const cleanParam = param.trim();
    if (!cleanParam || SKIP_PARAM_RE.test(cleanParam)) continue;
    const key = `${cleanBase}|${cleanParam}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ baseUrl: cleanBase, param: cleanParam, source });
    }
  }
}

/** Collect observed same-origin query parameters and HTML form input names from crawled artifacts. */
export function discoverParamCandidates(
  targetOrigin: string,
  crawl?: CrawlResult,
  extraUrls: readonly string[] = [],
): ParamCandidate[] {
  const seen = new Set<string>();
  const out: ParamCandidate[] = [];

  for (const raw of extraUrls) {
    const u = safeSameOriginUrl(raw, targetOrigin);
    if (u) addQueryParamsFromUrl(u, targetOrigin, 'url', seen, out);
  }
  for (const s of crawl?.screens ?? []) {
    const u = safeSameOriginUrl(s.url, targetOrigin);
    if (u) addQueryParamsFromUrl(u, targetOrigin, 'url', seen, out);
  }

  for (const art of crawl?.servedArtifacts ?? []) {
    const artPageUrl = safeSameOriginUrl(art.url, targetOrigin);
    if (artPageUrl) addQueryParamsFromUrl(artPageUrl, targetOrigin, 'url', seen, out);
    if (art.kind === 'url') continue;

    // Inline links / fetch URLs with query parameters
    for (const m of art.text.matchAll(/(?:href|src|action|url)\s*=\s*['"]([^'"]+\?[^'"]+)['"]|['"`](\/[A-Za-z0-9_./-]+\?[^'"`\s]+)['"`]/gi)) {
      const candidate = m[1] ?? m[2];
      const u = candidate ? safeSameOriginUrl(candidate, targetOrigin) : null;
      if (u) addQueryParamsFromUrl(u, targetOrigin, 'url', seen, out);
    }

    // HTML forms: extract <form ...> ... </form> action + input/select/textarea names
    if (art.kind === 'dom' || art.kind === 'response') {
      const pageBase = safeSameOriginUrl(art.url, targetOrigin)?.href ?? targetOrigin;
      for (const fm of art.text.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
        const attrs = fm[1] ?? '';
        const body = fm[2] ?? '';
        const actionMatch = attrs.match(/\baction\s*=\s*['"]([^'"]*)['"]/i);
        const resolvedAction = safeSameOriginUrl(actionMatch?.[1] || pageBase, targetOrigin);
        if (!resolvedAction || DESTRUCTIVE_PATH_RE.test(resolvedAction.pathname)) continue;
        const cleanBase = `${resolvedAction.origin}${resolvedAction.pathname}`;
        for (const inp of body.matchAll(/<(?:input|select|textarea)\b[^>]*\bname\s*=\s*['"]([A-Za-z0-9_.-]+)['"]/gi)) {
          const cleanParam = inp[1]?.trim() ?? '';
          if (!cleanParam || SKIP_PARAM_RE.test(cleanParam)) continue;
          const key = `${cleanBase}|${cleanParam}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ baseUrl: cleanBase, param: cleanParam, source: 'form' });
          }
        }
      }
    }
  }

  return out;
}

function hasUnescapedReflectedTag(htmlBody: string, tagPrefix: string): boolean {
  let pos = 0;
  while (pos < htmlBody.length) {
    const idx = htmlBody.indexOf(tagPrefix, pos);
    if (idx < 0) return false;
    const endIdx = htmlBody.indexOf(XSS_END_SENTINEL, idx + tagPrefix.length);
    if (endIdx > idx && endIdx - (idx + tagPrefix.length) <= 32) {
      // Unescaped quotes or angle brackets inside our bounded canary bookends confirm raw reflection.
      const between = htmlBody.slice(idx + tagPrefix.length, endIdx);
      if (between.includes('"') || between.includes('<')) return true;
    }
    pos = idx + tagPrefix.length;
  }
  return false;
}

function detectOpenRedirectSignal(
  res: { status: number; location: string; contentType: string; text: string },
  requestUrl: string,
): string | null {
  if (res.status >= 300 && res.status < 400 && res.location) {
    try {
      const target = new URL(res.location, requestUrl);
      if (bareHost(target.hostname) === CANARY_HOST) {
        return `HTTP ${res.status} Location redirected to ${CANARY_HOST}`;
      }
    } catch {
      if (res.location.includes(CANARY_HOST)) return `HTTP ${res.status} Location reflected ${CANARY_HOST}`;
    }
  }
  if (res.status >= 200 && res.status < 300 && res.contentType.includes('text/html') && res.text.includes(CANARY_HOST)) {
    const metaRe = /<meta[^>]+http-equiv\s*=\s*['"]?refresh['"]?[^>]+canary\.miqyas-probe\.invalid/i;
    const jsRe = /(?:location(?:\.href|\.replace|\.assign)?|window\.open)[^\n;]{0,120}canary\.miqyas-probe\.invalid/i;
    if (metaRe.test(res.text)) return `HTML meta-refresh targeted ${CANARY_HOST}`;
    if (jsRe.test(res.text)) return `HTML client redirect targeted ${CANARY_HOST}`;
  }
  return null;
}

/** Check 11 implementation: inert reflected XSS and open-redirect parameter probes under `--active` + host policy. */
export async function probeParamSecurity(
  opts: ActiveProbeBaseOptions & {
    crawl?: CrawlResult;
    probeUrls?: readonly string[];
    runId?: string;
    deadlineMs?: number;
    now?: () => number;
  },
): Promise<Check11ParamProbeResult> {
  const probeTag = sanitizeProbeTag(opts.runId);
  const targetUrl = await preflightActiveProbe(opts);
  if (!targetUrl) {
    return {
      executed: false,
      reason: '--active was not passed',
      probeTag,
      candidatesCount: 0,
      probedCount: 0,
      issues: [],
      coverage: '0 URL/form parameter probes',
    };
  }

  const now = opts.now ?? (() => Date.now());
  const candidates = discoverParamCandidates(targetUrl.origin, opts.crawl, opts.probeUrls);
  if (candidates.length === 0) {
    return {
      executed: false,
      reason: '0 URL or form parameters observed to probe',
      probeTag,
      candidatesCount: 0,
      probedCount: 0,
      issues: [],
      coverage: '0 observed URL/form parameters',
    };
  }

  if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
    return {
      executed: false,
      haltedReason: 'time-limit',
      reason: DROP_REASON_MESSAGE,
      probeTag,
      candidatesCount: candidates.length,
      probedCount: 0,
      issues: [],
      coverage: '0 URL/form parameter probes (dropped: time-limit)',
    };
  }

  const fetchFn = opts.fetchImpl ?? fetch;
  const limiter = createRateLimiter(opts.maxRps ?? DEFAULT_CRAWL_RPS);
  const xssProbeValue = `${probeTag}"<${XSS_END_SENTINEL}`;
  const redirectProbeValue = `https://${CANARY_HOST}/${probeTag}`;

  const issues: ParamSecurityIssue[] = [];
  let haltedReason: ProbeHaltReason | undefined;
  let attemptedCount = 0;
  let respondedCount = 0;

  for (const cand of candidates) {
    if (haltedReason) break;
    if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
      haltedReason = 'time-limit';
      break;
    }
    if (attemptedCount >= MAX_PARAM_PROBES) {
      haltedReason = 'max-probes';
      break;
    }

    // 1. Inert reflected XSS GET probe
    const xssUrl = new URL(cand.baseUrl);
    xssUrl.searchParams.set(cand.param, xssProbeValue);
    await limiter.acquire();
    attemptedCount++;
    const xssRes = await safeGetText(fetchFn, xssUrl.href, {}, 'manual');
    if (xssRes) {
      if (xssRes.status === 429 || xssRes.status === 503) {
        haltedReason = 'rate-limit';
        break;
      }
      respondedCount++;
      if (
        xssRes.status >= 200 &&
        xssRes.status < 300 &&
        xssRes.contentType.includes('text/html') &&
        hasUnescapedReflectedTag(xssRes.text, probeTag)
      ) {
        issues.push({
          kind: 'reflected-xss',
          endpoint: cleanEndpointUrl(cand.baseUrl),
          param: cand.param,
          probeTag,
          status: xssRes.status,
          detail: `inert probe "${probeTag}" reflected unescaped HTML delimiters in ${xssRes.status} response`,
        });
      }
    }

    if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
      haltedReason = 'time-limit';
      break;
    }
    if (attemptedCount >= MAX_PARAM_PROBES) {
      haltedReason = 'max-probes';
      break;
    }

    // 2. Open-redirect GET probe (`redirect: 'manual'`)
    const redirUrl = new URL(cand.baseUrl);
    redirUrl.searchParams.set(cand.param, redirectProbeValue);
    await limiter.acquire();
    attemptedCount++;
    const redirRes = await safeGetText(fetchFn, redirUrl.href, {}, 'manual');
    if (redirRes) {
      if (redirRes.status === 429 || redirRes.status === 503) {
        haltedReason = 'rate-limit';
        break;
      }
      respondedCount++;
      const redirDetail = detectOpenRedirectSignal(redirRes, redirUrl.href);
      if (redirDetail) {
        issues.push({
          kind: 'open-redirect',
          endpoint: cleanEndpointUrl(cand.baseUrl),
          param: cand.param,
          probeTag,
          status: redirRes.status,
          detail: `[${probeTag}] ${redirDetail}`,
        });
      }
    }
  }

  const haltSuffix = haltedReason ? ` (stopped early: ${haltedReason})` : '';
  const allFailed = attemptedCount > 0 && respondedCount === 0 && !haltedReason;
  return {
    executed: respondedCount > 0,
    ...(haltedReason === 'time-limit'
      ? { reason: DROP_REASON_MESSAGE }
      : haltedReason === 'rate-limit'
        ? { reason: 'rate-limit encountered (429/503) during parameter probing' }
        : allFailed
          ? { reason: 'all parameter probe requests failed or timed out' }
          : {}),
    ...(haltedReason ? { haltedReason } : {}),
    probeTag,
    candidatesCount: candidates.length,
    probedCount: respondedCount,
    issues,
    coverage: `${respondedCount} inert param probe(s) across ${candidates.length} observed URL/form param(s)${haltSuffix}`,
  };
}

/** Collect observed same-origin spending routes (LLM, SMS, email, billing/charge endpoints). */
export function discoverSpendingRoutes(
  targetOrigin: string,
  crawl?: CrawlResult,
  explicitRoutes: readonly string[] = [],
): string[] {
  const routes = new Set<string>();
  const addIfSpending = (raw: string, isExplicit = false) => {
    const u = safeSameOriginUrl(raw, targetOrigin);
    if (!u || AUTH_PATH_RE.test(u.pathname)) return;
    if (NON_SPENDING_DESTRUCTIVE_RE.test(u.pathname)) return;
    if (!isExplicit && DESTRUCTIVE_PATH_RE.test(u.pathname) && !SPENDING_PATH_RE.test(u.pathname)) return;
    if (isExplicit || SPENDING_PATH_RE.test(u.pathname)) {
      routes.add(`${u.origin}${u.pathname}`);
    }
  };

  for (const r of explicitRoutes) addIfSpending(r, true);
  for (const s of crawl?.screens ?? []) addIfSpending(s.url);
  for (const art of crawl?.servedArtifacts ?? []) {
    if (art.kind === 'url') {
      addIfSpending(art.url);
      continue;
    }
    for (const m of art.text.matchAll(/['"`](\/[A-Za-z0-9_./-]+)['"`]/g)) {
      if (m[1]) addIfSpending(m[1]);
    }
    for (const fm of art.text.matchAll(/<form\b[^>]*\baction\s*=\s*['"]([^'"]+)['"]/gi)) {
      if (fm[1]) addIfSpending(fm[1]);
    }
  }
  return [...routes];
}

/** Check 12 implementation: unauthenticated replay against LLM/SMS/email spending routes; requires `--allow-writes` off test hosts. */
export async function probeSpendingRoutes(
  opts: ActiveProbeBaseOptions & {
    allowWrites?: boolean;
    crawl?: CrawlResult;
    spendingRoutes?: readonly string[];
    runId?: string;
    deadlineMs?: number;
    now?: () => number;
  },
): Promise<Check12SpendProbeResult> {
  if (!opts.active) {
    return {
      executed: false,
      reason: '--active was not passed',
      probedCount: 0,
      records: [],
      unprotectedRoutes: [],
      coverage: '0 spending routes probed',
    };
  }
  const targetUrl = tryParseUrl(opts.url);
  if (!targetUrl || (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:')) {
    throw new HostPolicyError(`invalid target URL "${opts.url}"`);
  }

  const onTestHost = isTestHost(bareHost(targetUrl.hostname));
  if (!onTestHost && !opts.allowWrites) {
    return {
      executed: false,
      haltedReason: 'write-policy',
      reason: 'Check 12 requires --allow-writes off test hosts',
      probedCount: 0,
      records: [],
      unprotectedRoutes: [],
      coverage: '0 spending routes probed (--allow-writes not passed off test hosts)',
    };
  }

  await verifyHostOwnership({
    url: opts.url,
    ...(opts.allowHost ? { allowHost: opts.allowHost } : {}),
    active: true,
    allowWrites: Boolean(opts.allowWrites),
    probeKind: onTestHost ? 'active-read' : 'active-write',
    ...(opts.hostToken ? { expectedToken: opts.hostToken } : {}),
    ...opts.hostPolicyDeps,
  });

  const now = opts.now ?? (() => Date.now());
  const candidates = discoverSpendingRoutes(targetUrl.origin, opts.crawl, opts.spendingRoutes);
  if (candidates.length === 0) {
    return {
      executed: false,
      reason: '0 spending routes (LLM, SMS, email) detected in crawled artifacts',
      probedCount: 0,
      records: [],
      unprotectedRoutes: [],
      coverage: '0 spending routes detected',
    };
  }

  if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
    return {
      executed: false,
      haltedReason: 'time-limit',
      reason: DROP_REASON_MESSAGE,
      probedCount: 0,
      records: [],
      unprotectedRoutes: [],
      coverage: '0 spending routes probed (dropped: time-limit)',
    };
  }

  const fetchFn = opts.fetchImpl ?? fetch;
  const limiter = createRateLimiter(opts.maxRps ?? DEFAULT_CRAWL_RPS);
  const probeTag = sanitizeProbeTag(opts.runId);
  const probeBody = JSON.stringify({ probe: probeTag });
  const records: SpendingRouteRecord[] = [];
  let haltedReason: ProbeHaltReason | undefined;

  for (const href of candidates) {
    if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
      haltedReason = 'time-limit';
      break;
    }
    if (records.length >= MAX_SPEND_PROBES) {
      haltedReason = 'max-probes';
      break;
    }

    await limiter.acquire();
    let method: 'POST' | 'GET' = 'POST';
    let res = await safeRequestText(
      fetchFn,
      'POST',
      href,
      { 'content-type': 'application/json' },
      probeBody,
      'manual',
    );
    if (res && res.status === 405) {
      if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
        haltedReason = 'time-limit';
        break;
      }
      await limiter.acquire();
      method = 'GET';
      res = await safeGetText(fetchFn, href, {}, 'manual');
    }
    if (!res) continue;
    if (res.status === 429 || res.status === 503) {
      haltedReason = 'rate-limit';
      break;
    }
    if (res.status === 404 || res.status === 410 || res.status >= 500) continue;

    const isRedirectToAuth = res.status >= 300 && res.status < 400 && AUTH_PATH_RE.test(res.location);
    const isUnauthorized = res.status === 401 || res.status === 403 || isRedirectToAuth;
    const isHtmlResponse = res.contentType.includes('text/html');
    const isHtmlLogin = res.status === 200 && isHtmlResponse && /type=["']?password["']?/i.test(res.text);
    if (res.status >= 200 && res.status < 300 && isHtmlResponse && !isHtmlLogin) continue;
    const openSuccess =
      !isUnauthorized &&
      !isHtmlResponse &&
      (res.status === 202 ||
        res.status === 204 ||
        (res.status >= 200 && res.status < 300 && responseHasMeaningfulPayload(res.text)));
    const refused = isUnauthorized || isHtmlLogin || !openSuccess;

    records.push({
      endpoint: cleanEndpointUrl(href),
      method,
      statusNoSession: res.status,
      refused,
      detail: refused
        ? isRedirectToAuth
          ? `redirected unauthenticated ${method} (${res.status})`
          : `refused unauthenticated ${method} (HTTP ${res.status})`
        : `accepted unauthenticated ${method} (HTTP ${res.status})`,
    });
  }

  const unprotectedRoutes = records.filter((r) => !r.refused);
  const haltSuffix = haltedReason ? ` (stopped early: ${haltedReason})` : '';
  if (records.length === 0) {
    return {
      executed: false,
      ...(haltedReason ? { haltedReason } : {}),
      reason:
        haltedReason === 'time-limit'
          ? DROP_REASON_MESSAGE
          : haltedReason === 'rate-limit'
            ? 'rate-limit encountered (429/503) during spending-route probing'
            : '0 spending routes responded cleanly to replay',
      probedCount: 0,
      records: [],
      unprotectedRoutes: [],
      coverage: `0 spending routes replayed${haltSuffix}`,
    };
  }

  return {
    executed: true,
    ...(haltedReason ? { haltedReason } : {}),
    ...(haltedReason === 'time-limit'
      ? { reason: DROP_REASON_MESSAGE }
      : {}),
    probedCount: records.length,
    records,
    unprotectedRoutes,
    coverage: `${records.length} spending route(s) replayed without session${haltSuffix}`,
  };
}
