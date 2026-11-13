// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Always-on deterministic web surface detectors (FR-B7 / #13):
// runtime errors, same-origin HTTP 4xx/5xx & failed requests, served/DOM secret patterns,
// text/element clipping, axe-core accessibility violations (MPL-2.0 unmodified),
// keyboard focus traps, and off-origin canary open-redirect checks on seen URL params.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { BrowserContext, Page, Request, Response } from 'playwright';
import type { SurfaceFinding, SurfaceFindingSeverity } from '../session.js';
import { attachOriginIsolation } from './policy.js';

const require = createRequire(import.meta.url);
const AXE_MIN_JS = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

export const CANARY_HOST = 'canary.miqyas-probe.invalid';
const MAX_SCAN_BODY_BYTES = 512 * 1024;
const MAX_REDIRECT_PROBES_PER_SCREEN = 5;
const MAX_TAB_STEPS = 18;

const REDIRECT_PARAM_RE =
  /^(?:next|next_url|redirect|redirect_uri|redirect_url|return|return_to|returnTo|ret|url|dest|destination|to|continue|goto|callback|target|forward)$/i;

/** Curated provider-prefixed secret rules (MIT-licensed patterns derived from gitleaks; noisy generic rule omitted). */
const SECRET_PATTERNS: readonly { id: string; label: string; severity: SurfaceFindingSeverity; re: RegExp }[] = [
  { id: 'aws-access-key', label: 'AWS access key ID', severity: 'critical', re: /(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}/g },
  { id: 'github-pat', label: 'GitHub token', severity: 'critical', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/g },
  { id: 'github-fine-pat', label: 'GitHub fine-grained token', severity: 'critical', re: /\bgithub_pat_[0-9A-Za-z]{22}_[0-9A-Za-z]{59}\b/g },
  { id: 'anthropic-key', label: 'Anthropic API key', severity: 'critical', re: /\bsk-ant-api03-[0-9A-Za-z_-]{20,}\b/g },
  { id: 'stripe-live-key', label: 'Stripe live key', severity: 'critical', re: /\bsk_live_[0-9A-Za-z]{24,}\b/g },
  { id: 'private-key', label: 'Private key header', severity: 'critical', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
  { id: 'google-api-key', label: 'Google API key', severity: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'slack-token', label: 'Slack token', severity: 'high', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
];

const cut = (s: string, max = 220): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function maskSecretSample(raw: string, hide: (t: string) => string): string {
  const scrubbed = hide(raw);
  if (scrubbed !== raw) return scrubbed;
  if (raw.startsWith('-----BEGIN ')) return '[redacted PRIVATE KEY header]';
  const prefix = raw.slice(0, Math.min(4, raw.length));
  return `${prefix}*** (len ${raw.length})`;
}

/** Scan text (served JS/HTML, DOM, URL, or storage) for curated or configured secret values without leaking secrets. */
export function scanTextForSecrets(
  text: string,
  location: string,
  hide: (t: string) => string,
  knownSecrets?: RegExp,
  url?: string,
): SurfaceFinding[] {
  if (!text) return [];
  const findings: SurfaceFinding[] = [];
  const seenKeys = new Set<string>();
  const safeLocation = hide(location);

  const recordMatch = (id: string, title: string, severity: SurfaceFindingSeverity, raw: string, detailPrefix: string) => {
    const sample = maskSecretSample(raw, hide);
    const dedupeKey = `${id}|${sample}|${safeLocation}`;
    if (seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);
    findings.push({
      category: 'secret-exposure',
      title,
      severity,
      confirmed: true,
      ...(url ? { url: hide(url) } : {}),
      evidence: `${detailPrefix} (${sample}) present in ${safeLocation}`,
    });
  };

  for (const pat of SECRET_PATTERNS) {
    pat.re.lastIndex = 0;
    for (const m of text.matchAll(pat.re)) {
      recordMatch(pat.id, `${pat.label} exposed in ${safeLocation}`, pat.severity, m[0], pat.id);
    }
  }

  if (knownSecrets) {
    const all = new RegExp(knownSecrets.source, knownSecrets.flags.includes('g') ? knownSecrets.flags : `${knownSecrets.flags}g`);
    for (const m of text.matchAll(all)) {
      recordMatch('known', `Configured secret exposed in ${safeLocation}`, 'critical', m[0], 'Configured secret');
    }
  }

  return findings;
}

export interface FocusStep {
  key: string;
  tag: string;
  label: string;
  inModal: boolean;
}

/** Pure keyboard focus-trap analyzer over sequential `Tab` stops. */
export function detectFocusTrapFromTrace(
  steps: readonly FocusStep[],
  focusableCount: number,
  url?: string,
  hide: (t: string) => string = (t) => t,
): SurfaceFinding | null {
  if (focusableCount <= 0 || steps.length < 2) return null;

  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1]!;
    const curr = steps[i]!;
    // Pinned element: Tab never left a non-body element (e.g. onkeydown prevented Tab or onblur refocused).
    if (curr.key !== 'BODY' && curr.key === prev.key && (focusableCount >= 2 || i >= 2)) {
      return {
        category: 'focus-trap',
        title: 'Keyboard focus trap on element',
        severity: 'high',
        confirmed: true,
        ...(url ? { url: hide(url) } : {}),
        evidence: `Tab remained pinned on <${curr.tag.toLowerCase()}> "${hide(curr.label || curr.key)}" across consecutive Tab presses`,
      };
    }
  }

  // Non-modal subset cycle: focus stays trapped within <=2 non-modal stops across >=6 consecutive non-body Tabs.
  if (focusableCount >= 3 && steps.length >= 7) {
    const tail = steps.slice(-6);
    if (tail.every((s) => s.key !== 'BODY' && !s.inModal)) {
      const distinct = new Set(tail.map((s) => s.key));
      if (distinct.size <= 2 && distinct.size < focusableCount) {
        return {
          category: 'focus-trap',
          title: 'Keyboard focus trapped in subset of controls',
          severity: 'high',
          confirmed: true,
          ...(url ? { url: hide(url) } : {}),
          evidence: `6 consecutive Tab presses cycled only across [${hide([...distinct].join(', '))}] while ${focusableCount} controls exist`,
        };
      }
    }
  }

  return null;
}

export interface RedirectCandidate {
  sourceUrl: string;
  pathname: string;
  param: string;
  probeUrl: string;
}

/** Extract same-origin seen URLs carrying redirect-like query parameters for safe off-origin canary probing. */
export function findRedirectCandidates(urls: readonly string[], baseOrigin: string): RedirectCandidate[] {
  const out: RedirectCandidate[] = [];
  const seen = new Set<string>();
  const canaryUrl = `https://${CANARY_HOST}/miqyas-redirect-canary`;

  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw, baseOrigin);
    } catch {
      continue;
    }
    if (u.origin !== baseOrigin) continue;
    for (const [param, val] of u.searchParams.entries()) {
      const valueLooksLikeTarget = /^(?:\/[^/]|https?:\/\/)/i.test(val);
      if (!REDIRECT_PARAM_RE.test(param) && !valueLooksLikeTarget) continue;
      const dedupeKey = `${u.pathname}|${param}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const probe = new URL(u.href);
      probe.searchParams.set(param, canaryUrl);
      out.push({ sourceUrl: u.href, pathname: u.pathname, param, probeUrl: probe.href });
    }
  }
  return out;
}

interface ClipHit {
  role: string;
  tag: string;
  text: string;
  detail: string;
}

const CLIPPING_FN = String.raw`() => {
  const hits = [];
  const seen = new Set();
  const isHiddenOverflow = (v) => v === 'hidden' || v === 'clip';
  const pushHit = (el, txt, detail) => {
    const key = el.tagName + '|' + txt.slice(0, 60);
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ role: el.getAttribute('role') || el.tagName.toLowerCase(), tag: el.tagName, text: txt.slice(0, 80), detail });
  };
  const els = document.querySelectorAll('body *');
  for (let i = 0; i < els.length && hits.length < 15; i++) {
    const el = els[i];
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 4 || rect.height <= 4) continue;
    const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!txt) continue;

    const cs = getComputedStyle(el);
    const clipX = isHiddenOverflow(cs.overflowX) && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2;
    const clipY = isHiddenOverflow(cs.overflowY) && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2;
    const ellipsis = cs.textOverflow === 'ellipsis' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2;
    if (clipX || clipY || ellipsis) {
      const detail = ellipsis
        ? 'text-overflow ellipsis (' + el.scrollWidth + 'px > ' + el.clientWidth + 'px)'
        : clipX
          ? 'horizontal overflow clipped (' + el.scrollWidth + 'px > ' + el.clientWidth + 'px)'
          : 'vertical overflow clipped (' + el.scrollHeight + 'px > ' + el.clientHeight + 'px)';
      pushHit(el, txt, detail);
      continue;
    }

    // Ancestor overflow clipping on text leaf containers.
    let directText = '';
    for (let c = 0; c < el.childNodes.length; c++) {
      if (el.childNodes[c].nodeType === 3) directText += el.childNodes[c].nodeValue || '';
    }
    if (!directText.trim()) continue;
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      if (!isHiddenOverflow(pcs.overflowX) && !isHiddenOverflow(pcs.overflowY)) continue;
      const pr = p.getBoundingClientRect();
      if (pr.width <= 4 || pr.height <= 4) continue;
      if (
        (isHiddenOverflow(pcs.overflowX) && (rect.right > pr.right + 2 || rect.left < pr.left - 2)) ||
        (isHiddenOverflow(pcs.overflowY) && (rect.bottom > pr.bottom + 2 || rect.top < pr.top - 2))
      ) {
        pushHit(el, txt, 'clipped by ancestor <' + p.tagName.toLowerCase() + '>');
      }
      break;
    }
  }
  return hits;
}`;

const DOM_SECRET_AND_URLS_FN = String.raw`() => {
  const chunks = [];
  const push = (label, text) => {
    if (typeof text === 'string' && text.length > 0) chunks.push({ label, text: text.slice(0, 128000) });
  };
  push('page DOM text', document.body ? (document.body.innerText || '') : '');
  const scripts = document.querySelectorAll('script:not([src])');
  for (let i = 0; i < scripts.length; i++) push('inline script', scripts[i].textContent || '');
  const inputs = document.querySelectorAll('input, textarea');
  for (let i = 0; i < inputs.length; i++) {
    const el = inputs[i];
    if (el.value) push('form field value', String(el.value));
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) push('localStorage[' + k + ']', String(localStorage.getItem(k) || ''));
    }
  } catch {}
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k) push('sessionStorage[' + k + ']', String(sessionStorage.getItem(k) || ''));
    }
  } catch {}
  if (document.cookie) push('document.cookie', document.cookie);

  const links = [];
  const anchors = document.querySelectorAll('a[href]');
  for (let i = 0; i < anchors.length && links.length < 40; i++) {
    try { links.push(new URL(anchors[i].getAttribute('href') || '', location.href).href); } catch {}
  }
  return { url: location.href, chunks, links };
}`;

const ACTIVE_FOCUS_STATE_FN = String.raw`() => {
  const sel = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),summary';
  const list = document.querySelectorAll(sel);
  let focusableCount = 0;
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
    focusableCount++;
  }
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) {
    return { focusableCount, step: { key: 'BODY', tag: 'BODY', label: 'body', inModal: false } };
  }
  if (!window.__miqyasFMap) window.__miqyasFMap = new WeakMap();
  if (!window.__miqyasFMap.has(active)) {
    window.__miqyasFSeq = (window.__miqyasFSeq || 0) + 1;
    window.__miqyasFMap.set(active, active.tagName.toLowerCase() + '#' + (active.id || window.__miqyasFSeq));
  }
  const key = window.__miqyasFMap.get(active);
  const label = (active.getAttribute('aria-label') || active.innerText || active.getAttribute('name') || active.id || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const inModal = Boolean(active.closest('dialog[open],[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]'));
  return { focusableCount, step: { key, tag: active.tagName, label, inModal } };
}`;

interface AxeViolation {
  id: string;
  impact?: string | null;
  help?: string;
  nodes?: { target?: string[]; html?: string }[];
}

function axeSeverity(impact?: string | null): SurfaceFindingSeverity {
  if (impact === 'critical') return 'critical';
  if (impact === 'serious') return 'high';
  if (impact === 'moderate') return 'medium';
  if (impact === 'minor') return 'low';
  return 'medium';
}

const isTextContentType = (ct: string | undefined): boolean =>
  Boolean(ct && /(?:text\/|javascript|ecmascript|json|xml|svg)/i.test(ct));

export interface WebDetectorCollector {
  /** Run all active screen checks (secrets, clipping, axe-core, focus trap, open redirects) and drain pending event findings. */
  collect(): Promise<SurfaceFinding[]>;
}

/** Attach passive network/runtime listeners to `page` and provide on-capture active screen scanning. */
export function attachWebDetectors(
  context: BrowserContext,
  page: Page,
  opts: { baseOrigin: string; hide: (t: string) => string; knownSecrets?: RegExp; navTimeoutMs: number },
): WebDetectorCollector {
  const { baseOrigin, hide, knownSecrets, navTimeoutMs } = opts;
  const queued: SurfaceFinding[] = [];
  const pendingBodyScans = new Set<Promise<void>>();
  const probedRedirects = new Set<string>();

  const pushQueued = (f: SurfaceFinding) => {
    queued.push(f);
  };

  page.on('pageerror', (err) => {
    pushQueued({
      category: 'page-error',
      title: 'Uncaught page error',
      severity: 'high',
      confirmed: true,
      url: hide(page.url()),
      evidence: cut(hide(err.message || String(err))),
    });
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Skip Chromium's auto-emitted resource errors that duplicate http-error / request-failed detectors.
    if (
      /^Failed to load resource: the server responded with a status of \d+/i.test(text) ||
      /^Failed to load resource: net::ERR_/i.test(text)
    ) {
      return;
    }
    pushQueued({
      category: 'console-error',
      title: 'Console error logged',
      severity: 'medium',
      confirmed: true,
      url: hide(page.url()),
      evidence: cut(hide(text)),
    });
  });

  page.on('requestfailed', (req: Request) => {
    let u: URL;
    try {
      u = new URL(req.url());
    } catch {
      return;
    }
    if (u.origin !== baseOrigin) return;
    const reason = req.failure()?.errorText ?? 'request failed';
    if (reason === 'net::ERR_ABORTED') return;
    pushQueued({
      category: 'request-failed',
      title: 'Same-origin request failed',
      severity: 'medium',
      confirmed: true,
      url: hide(page.url()),
      evidence: `${req.method()} ${hide(u.pathname + u.search)}: ${hide(reason)}`,
    });
  });

  page.on('response', (res: Response) => {
    let u: URL;
    try {
      u = new URL(res.url());
    } catch {
      return;
    }
    if (u.origin !== baseOrigin) return;
    const status = res.status();
    if (status >= 400) {
      if (u.pathname === '/favicon.ico' && status === 404) return;
      pushQueued({
        category: 'http-error',
        title: `HTTP ${status} on ${hide(u.pathname)}`,
        severity: status >= 500 ? 'high' : 'medium',
        confirmed: true,
        url: hide(page.url()),
        evidence: `${status} ${res.statusText() || 'Error'} ${res.request().method()} ${hide(u.pathname + u.search)}`,
      });
      return;
    }

    const ct = res.headers()['content-type'];
    const lenHeader = Number(res.headers()['content-length'] ?? 0);
    if (status >= 200 && status < 400 && isTextContentType(ct) && (!lenHeader || lenHeader <= MAX_SCAN_BODY_BYTES)) {
      const task = (async () => {
        try {
          const body = await res.text();
          if (body.length > MAX_SCAN_BODY_BYTES) return;
          const kind = res.request().resourceType() === 'script' ? 'served script' : 'served response';
          for (const hit of scanTextForSecrets(body, `${kind} ${u.pathname}`, hide, knownSecrets, page.url())) {
            pushQueued(hit);
          }
        } catch {
          // Response body may be unavailable on redirects or closed targets.
        }
      })();
      pendingBodyScans.add(task);
      void task.finally(() => pendingBodyScans.delete(task));
    }
  });

  const scanSecretsAndLinks = async (): Promise<{ links: string[]; url: string }> => {
    const data = (await page.evaluate(`(${DOM_SECRET_AND_URLS_FN})()`).catch(() => null)) as
      | { url?: string; chunks?: { label: string; text: string }[]; links?: string[] }
      | null;
    if (!data) return { links: [], url: page.url() };
    const curUrl = data.url ?? page.url();
    const out: SurfaceFinding[] = [];
    out.push(...scanTextForSecrets(curUrl, 'page URL', hide, knownSecrets, curUrl));
    for (const chunk of data.chunks ?? []) {
      out.push(...scanTextForSecrets(chunk.text, chunk.label, hide, knownSecrets, curUrl));
    }
    for (const f of out) pushQueued(f);
    return { links: data.links ?? [], url: curUrl };
  };

  const scanClipping = async (curUrl: string): Promise<void> => {
    const hits = (await page.evaluate(`(${CLIPPING_FN})()`).catch(() => [])) as ClipHit[];
    for (const h of hits) {
      pushQueued({
        category: 'clipping',
        title: `Clipped content in ${hide(h.role)}`,
        severity: 'low',
        confirmed: true,
        url: hide(curUrl),
        evidence: `${hide(h.detail)}: "${cut(hide(h.text), 80)}"`,
      });
    }
  };

  const scanAxe = async (curUrl: string): Promise<void> => {
    try {
      const hasAxe = await page.evaluate('typeof window.axe?.run === "function"').catch(() => false);
      if (!hasAxe) await page.addScriptTag({ content: AXE_MIN_JS });
      const res = (await page.evaluate(
        'window.axe.run(document, { resultTypes: ["violations"] })',
      )) as { violations?: AxeViolation[] };
      for (const v of res.violations ?? []) {
        const targets = (v.nodes ?? [])
          .slice(0, 3)
          .map((n) => (n.target ?? []).join(' '))
          .filter(Boolean)
          .join(', ');
        pushQueued({
          category: 'a11y',
          title: `axe ${v.id}: ${hide(v.help ?? v.id)}`,
          severity: axeSeverity(v.impact),
          confirmed: true,
          url: hide(curUrl),
          evidence: `impact=${v.impact ?? 'moderate'}${targets ? `; targets=${hide(targets)}` : ''}`,
        });
      }
    } catch {
      // Page navigated or CSP prevented inline evaluation; ignore cleanly.
    }
  };

  const scanFocusTrap = async (curUrl: string): Promise<void> => {
    const startHandle = await page.evaluateHandle('document.activeElement').catch(() => null);
    try {
      const initial = (await page.evaluate(`(${ACTIVE_FOCUS_STATE_FN})()`).catch(() => null)) as
        | { focusableCount: number; step: FocusStep }
        | null;
      if (!initial || initial.focusableCount <= 0) return;

      const steps: FocusStep[] = [initial.step];
      const maxTabs = Math.min(MAX_TAB_STEPS, Math.max(4, initial.focusableCount + 3));
      const seenNonBody = new Set<string>(initial.step.key === 'BODY' ? [] : [initial.step.key]);

      for (let i = 0; i < maxTabs; i++) {
        if (page.url() !== curUrl) break;
        await page.keyboard.press('Tab').catch(() => {});
        const cur = (await page.evaluate(`(${ACTIVE_FOCUS_STATE_FN})()`).catch(() => null)) as
          | { focusableCount: number; step: FocusStep }
          | null;
        if (!cur) break;
        steps.push(cur.step);
        if (cur.step.key !== 'BODY') seenNonBody.add(cur.step.key);
        const trap = detectFocusTrapFromTrace(steps, initial.focusableCount, curUrl, hide);
        if (trap) {
          pushQueued(trap);
          return;
        }
        // Stop early once we have observed all focusable controls and cycled cleanly.
        if (steps.length > 2 && seenNonBody.size >= initial.focusableCount && cur.step.key === 'BODY') break;
      }
    } finally {
      if (startHandle) {
        await page
          .evaluate(
            (el) => {
              const cur = document.activeElement as HTMLElement | null;
              if (el && el !== document.body && el !== document.documentElement && typeof (el as HTMLElement).focus === 'function') {
                (el as HTMLElement).focus({ preventScroll: true });
              } else if (cur && cur !== document.body && typeof cur.blur === 'function') {
                cur.blur();
              }
            },
            startHandle,
          )
          .catch(() => {});
        await startHandle.dispose().catch(() => {});
      }
    }
  };

  const scanOpenRedirects = async (urls: readonly string[]): Promise<void> => {
    const candidates = findRedirectCandidates(urls, baseOrigin)
      .filter((c) => !probedRedirects.has(`${c.pathname}|${c.param}`))
      .slice(0, MAX_REDIRECT_PROBES_PER_SCREEN);
    if (!candidates.length) return;

    for (const c of candidates) {
      probedRedirects.add(`${c.pathname}|${c.param}`);
      const probePage = await context.newPage().catch(() => null);
      if (!probePage) continue;
      let hitDetail = '';
      try {
        await attachOriginIsolation(probePage, baseOrigin, {
          onBeforeRequest: async (route, reqUrl) => {
            try {
              if (new URL(reqUrl).hostname === CANARY_HOST) {
                hitDetail = `navigated toward ${CANARY_HOST}`;
                await route.abort('blockedbyclient');
                return true;
              }
            } catch {
              // Let attachOriginIsolation fail closed on invalid URLs.
            }
            return false;
          },
        });
        probePage.on('response', (res) => {
          if (hitDetail) return;
          if (res.status() >= 300 && res.status() < 400) {
            const loc = res.headers()['location'] ?? '';
            if (loc.includes(CANARY_HOST)) {
              hitDetail = `HTTP ${res.status()} Location redirected to ${CANARY_HOST}`;
            }
          }
        });
        await probePage.goto(c.probeUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(2500, navTimeoutMs) }).catch(() => {});
        await probePage.waitForTimeout(80).catch(() => {});
        if (!hitDetail && probePage.url().includes(CANARY_HOST)) {
          hitDetail = `final URL moved to ${CANARY_HOST}`;
        }
        if (hitDetail) {
          pushQueued({
            category: 'open-redirect',
            title: `Open redirect via query param "${hide(c.param)}"`,
            severity: 'high',
            confirmed: true,
            url: hide(c.sourceUrl),
            evidence: `${hide(c.pathname)}?${hide(c.param)}=<canary> (${hitDetail})`,
          });
        }
      } finally {
        await probePage.close().catch(() => {});
      }
    }
  };

  return {
    async collect(): Promise<SurfaceFinding[]> {
      if (pendingBodyScans.size) await Promise.all([...pendingBodyScans]);
      if (page.isClosed()) return queued.splice(0, queued.length);
      const { links, url } = await scanSecretsAndLinks();
      if (!page.isClosed()) await scanClipping(url);
      if (!page.isClosed()) await scanAxe(url);
      if (!page.isClosed()) await scanFocusTrap(url);
      if (!page.isClosed()) await scanOpenRedirects([url, ...links]);
      return queued.splice(0, queued.length);
    },
  };
}
