// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Bounded code-driven same-origin crawler (FR-B8 / #14):
// Follows reachable same-origin links, tabs, menus, and safe non-form controls up to 50 screens / depth 3 / 2 req/s.
// Never submits forms, skips English & Arabic destructive controls, enforces same-origin isolation, and halts on 429/503.

import type { BrowserContext, Page } from 'playwright';
import type { CrawlOptions, CrawlResult, CrawlScreen, Observation, ServedArtifact } from '../session.js';
import { attachWebDetectors } from './detectors.js';
import { observe, type ObserveOptions } from './observe.js';
import { hasCaptchaOrWafSignal, isDestructiveControl, type ControlDescriptor } from './policy.js';

export const DEFAULT_CRAWL_MAX_SCREENS = 50;
export const DEFAULT_CRAWL_DEPTH = 3;
export const DEFAULT_CRAWL_RPS = 2;

const CONTROL_SELECTOR =
  'button:not([disabled]), [role="tab"]:not([aria-disabled="true"]), [role="menuitem"]:not([aria-disabled="true"]), [aria-haspopup]:not([disabled]), summary';

export interface DiscoveredLink extends ControlDescriptor {
  href: string;
}

export interface DiscoveredControl extends ControlDescriptor {
  selectorIndex: number;
}

export interface RawCrawlDiscovery {
  links: DiscoveredLink[];
  controls: DiscoveredControl[];
}

export interface FilteredCrawlTargets {
  links: string[];
  controlIndices: number[];
  skippedOffOriginLinks: number;
  skippedControls: number;
}

/** Normalize a candidate anchor href within `baseOrigin`; returns null for off-origin or non-HTTP(S) URLs. */
export function normalizeCrawlUrl(rawHref: string, currentUrl: string, baseOrigin: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('mailto:') || lower.startsWith('tel:') || lower.startsWith('data:')) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed, currentUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.origin !== baseOrigin) return null;
  // Preserve client-side hash routes (#/... or #!/...), drop plain same-page anchor fragments (#section).
  if (parsed.hash && !parsed.hash.startsWith('#/') && !parsed.hash.startsWith('#!/')) {
    parsed.hash = '';
  }
  return parsed.href;
}

/** Rate limiter capping crawl actions/requests to `maxRps` requests per second. */
export function createRateLimiter(
  maxRps: number,
  now: () => number = () => Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): { acquire(): Promise<void> } {
  const safeRps = Number.isFinite(maxRps) && maxRps > 0 ? maxRps : DEFAULT_CRAWL_RPS;
  const minIntervalMs = Math.ceil(1000 / safeRps);
  let lastAt: number | null = null;
  return {
    async acquire(): Promise<void> {
      const t = now();
      if (lastAt !== null) {
        const waitMs = minIntervalMs - (t - lastAt);
        if (waitMs > 0) await sleep(waitMs);
      }
      lastAt = now();
    },
  };
}

/** Validate and filter DOM-discovered links/controls entirely in Node against same-origin and destructive rules. */
export function filterCrawlTargets(raw: RawCrawlDiscovery, currentUrl: string, baseOrigin: string): FilteredCrawlTargets {
  const links: string[] = [];
  const seenLinks = new Set<string>();
  let skippedOffOriginLinks = 0;
  let skippedControls = 0;

  for (const link of raw.links) {
    if (isDestructiveControl({ ...link, tagName: link.tagName ?? 'a' })) {
      skippedControls++;
      continue;
    }
    const normalized = normalizeCrawlUrl(link.href, currentUrl, baseOrigin);
    if (!normalized) {
      if (link.href.trim() && /^(?:https?:|\/\/)/i.test(link.href.trim())) skippedOffOriginLinks++;
      continue;
    }
    if (!seenLinks.has(normalized)) {
      seenLinks.add(normalized);
      links.push(normalized);
    }
  }

  const controlIndices: number[] = [];
  for (const ctrl of raw.controls) {
    if (isDestructiveControl(ctrl)) {
      skippedControls++;
      continue;
    }
    controlIndices.push(ctrl.selectorIndex);
  }

  return { links, controlIndices, skippedOffOriginLinks, skippedControls };
}

/** Wait until DOM mutations settle or `capMs` elapses. */
export async function settleDom(page: Page, capMs = 1500, quietMs = 300): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page
    .evaluate(
      `new Promise((resolve) => {
        let t = setTimeout(done, ${quietMs});
        const cap = setTimeout(done, ${capMs});
        const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, ${quietMs}); });
        mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
        function done() { mo.disconnect(); clearTimeout(t); clearTimeout(cap); resolve(); }
      })`,
    )
    .catch(() => {});
}

async function inspectPageTargets(page: Page, controlSelector: string): Promise<RawCrawlDiscovery> {
  return page
    .evaluate((sel) => {
      const vis = (el: Element): boolean => {
        const html = el as HTMLElement;
        if (typeof html.checkVisibility === 'function' && !html.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      };
      const formOf = (el: Element): HTMLFormElement | null => {
        const fAttr = el.getAttribute('form');
        if (fAttr) {
          const linked = document.getElementById(fAttr);
          if (linked && linked.tagName === 'FORM') return linked as HTMLFormElement;
        }
        return el.closest('form');
      };
      const metaFor = (el: Element) => {
        const form = formOf(el);
        const rawMethod = el.getAttribute('formmethod') || form?.getAttribute('method') || '';
        return {
          tagName: el.tagName.toLowerCase(),
          type: el.getAttribute('type') ?? '',
          formMethod: rawMethod.toLowerCase(),
          inForm: Boolean(form),
          label: ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          ariaLabel: el.getAttribute('aria-label') ?? '',
          title: el.getAttribute('title') ?? '',
          name: el.getAttribute('name') ?? '',
        };
      };

      const links: DiscoveredLink[] = [];
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        if (!vis(a)) continue;
        links.push({ ...metaFor(a), href: a.getAttribute('href') ?? '' });
      }
      const controls: DiscoveredControl[] = [];
      const allCtrls = Array.from(document.querySelectorAll(sel));
      for (let i = 0; i < allCtrls.length; i++) {
        const c = allCtrls[i]!;
        if (!vis(c)) continue;
        controls.push({ ...metaFor(c), selectorIndex: i });
      }
      return { links, controls };
    }, controlSelector)
    .catch(() => ({ links: [], controls: [] }));
}

function screenFingerprint(obs: Observation): string {
  const sig = obs.nodes
    .slice(0, 15)
    .map((n) => `${n.role}:${n.name}`)
    .join('|');
  return `${obs.url}\n${obs.title}\n${sig}`;
}

export interface RunCrawlerDeps {
  openContext: (url: string, viewport?: { width: number; height: number }) => Promise<BrowserContext>;
  defaultViewport?: { width: number; height: number };
  navTimeoutMs?: number;
  actionTimeoutMs?: number;
}

interface QueueItem {
  url: string;
  depth: number;
  trigger?: string;
}

const MAX_ARTIFACT_BYTES = 512 * 1024;
const MAX_ARTIFACTS_COUNT = 200;
const MAX_TOTAL_ARTIFACT_BYTES = 4 * 1024 * 1024;

function extractSourceMapUrls(body: string, headerVal: string | undefined, resourceUrl: string, baseOrigin: string): string[] {
  const refs: string[] = [];
  if (headerVal?.trim()) refs.push(headerVal.trim());
  for (const m of body.matchAll(/(?:\/\/[@#]|\/\*#)\s*sourceMappingURL=([^\s*]+)/g)) {
    if (m[1]) refs.push(m[1].trim());
  }
  const out: string[] = [];
  for (const raw of refs) {
    if (/^(?:data|blob|javascript):/i.test(raw)) continue;
    try {
      const u = new URL(raw, resourceUrl);
      if (u.origin === baseOrigin && (u.protocol === 'http:' || u.protocol === 'https:')) {
        out.push(u.href);
      }
    } catch {
      // ignore invalid sourceMappingURL
    }
  }
  return out;
}

const COLLECT_SCREEN_ARTIFACTS_FN = `() => {
  const domParts = [];
  if (document.body && document.body.innerText) domParts.push(document.body.innerText.slice(0, 128000));
  const scripts = document.querySelectorAll('script:not([src])');
  for (let i = 0; i < scripts.length; i++) {
    const t = scripts[i].textContent || '';
    if (t) domParts.push(t.slice(0, 128000));
  }
  const inputs = document.querySelectorAll('input, textarea');
  for (let i = 0; i < inputs.length; i++) {
    const v = inputs[i].value;
    if (v) domParts.push(String(v).slice(0, 8192));
  }
  const storageLines = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) storageLines.push('localStorage.' + k + '=' + String(localStorage.getItem(k) || ''));
    }
  } catch {}
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k) storageLines.push('sessionStorage.' + k + '=' + String(sessionStorage.getItem(k) || ''));
    }
  } catch {}
  if (document.cookie) storageLines.push('cookie=' + document.cookie);
  return { url: location.href, dom: domParts.join('\\n'), storage: storageLines.join('\\n') };
}`;

/** Execute bounded code-driven same-origin crawl under isolated proxy context. */
export async function crawlWebApp(opts: CrawlOptions, deps: RunCrawlerDeps): Promise<CrawlResult> {
  const maxScreens = opts.maxScreens ?? DEFAULT_CRAWL_MAX_SCREENS;
  const maxDepth = opts.maxDepth ?? DEFAULT_CRAWL_DEPTH;
  const maxRps = opts.maxRps ?? DEFAULT_CRAWL_RPS;
  const navTimeoutMs = opts.navTimeoutMs ?? deps.navTimeoutMs ?? 30_000;
  const actionTimeoutMs = opts.actionTimeoutMs ?? deps.actionTimeoutMs ?? 5000;
  const hide = opts.hide ?? ((t: string) => t);
  const startUrl = new URL(opts.url);
  const baseOrigin = startUrl.origin;
  const rootUrl = normalizeCrawlUrl(opts.url, opts.url, baseOrigin) ?? startUrl.href;

  const viewport = opts.viewport ?? deps.defaultViewport ?? { width: 1280, height: 800 };
  const context = await deps.openContext(rootUrl, viewport);
  const page = await context.newPage().catch(async (e) => {
    await context.close().catch(() => {});
    throw e;
  });

  let haltedReason: CrawlResult['haltedReason'];
  let lastHttpStatus: number | undefined;
  const queuedUrls = new Set<string>([rootUrl]);
  const visitedUrls = new Set<string>();
  const seenScreenKeys = new Set<string>();
  const queue: QueueItem[] = [{ url: rootUrl, depth: 0 }];
  const screens: CrawlScreen[] = [];
  let skippedControls = 0;
  let skippedOffOriginLinks = 0;

  const servedArtifacts: ServedArtifact[] = [];
  const seenArtifactKeys = new Set<string>();
  const fetchedSourceMaps = new Set<string>();
  const pendingArtifactTasks = new Set<Promise<void>>();
  let artifactBytes = 0;
  let truncatedArtifacts = 0;

  const atArtifactCap = () =>
    servedArtifacts.length >= MAX_ARTIFACTS_COUNT || artifactBytes >= MAX_TOTAL_ARTIFACT_BYTES;

  const pushArtifact = (art: ServedArtifact) => {
    if (!opts.collectServedArtifacts || !art.text) return;
    if (atArtifactCap()) {
      truncatedArtifacts++;
      return;
    }
    let textToStore = art.text;
    if (textToStore.length > MAX_ARTIFACT_BYTES) {
      truncatedArtifacts++;
      const half = Math.floor(MAX_ARTIFACT_BYTES / 2);
      textToStore = `${textToStore.slice(0, half)}\n/* ...truncated... */\n${textToStore.slice(-half)}`;
    }
    const key = `${art.kind}|${art.url}|${art.name}`;
    if (seenArtifactKeys.has(key)) return;
    seenArtifactKeys.add(key);
    artifactBytes += textToStore.length;
    servedArtifacts.push({ ...art, text: textToStore });
  };

  try {
    // Safety floor inside the page: never submit non-GET/HEAD top-frame form navigations during crawl.
    await page.route('**/*', (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && !['GET', 'HEAD'].includes(req.method().toUpperCase())) {
        return route.abort('blockedbyclient');
      }
      return route.fallback();
    });

    page.on('response', (res) => {
      const st = res.status();
      if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) {
        lastHttpStatus = st;
      }
      if (st === 429 && !haltedReason) haltedReason = 'http-429';
      else if (st === 503 && !haltedReason) haltedReason = 'http-503';

      if (!opts.collectServedArtifacts || st < 200 || st >= 400 || atArtifactCap()) return;
      let u: URL;
      try {
        u = new URL(res.url());
      } catch {
        return;
      }
      if (u.origin !== baseOrigin) return;
      const ct = res.headers()['content-type'] ?? '';
      if (!/(?:text\/|javascript|ecmascript|json|xml|svg)/i.test(ct) && !u.pathname.endsWith('.map')) return;
      const task = (async () => {
        try {
          if (atArtifactCap()) return;
          const body = await res.text();
          if (!body) return;
          const isMap = u.pathname.endsWith('.map');
          const rtype = res.request().resourceType();
          const kind: ServedArtifact['kind'] = isMap ? 'source-map' : rtype === 'script' || rtype === 'stylesheet' ? 'bundle' : 'response';
          pushArtifact({ kind, name: u.pathname || '/', url: u.href, text: body });
          const mapHeader = res.headers().sourcemap ?? res.headers()['x-sourcemap'];
          for (const mapUrl of extractSourceMapUrls(body, mapHeader, u.href, baseOrigin)) {
            if (fetchedSourceMaps.has(mapUrl) || atArtifactCap()) continue;
            fetchedSourceMaps.add(mapUrl);
            try {
              const mapRes = await context.request.get(mapUrl, { maxRedirects: 0, timeout: Math.min(navTimeoutMs, 5000) });
              if (mapRes.ok()) {
                const resolvedMapUrl = new URL(mapRes.url());
                if (resolvedMapUrl.origin === baseOrigin) {
                  const mapText = await mapRes.text();
                  if (mapText) {
                    pushArtifact({
                      kind: 'source-map',
                      name: resolvedMapUrl.pathname || 'source.map',
                      url: resolvedMapUrl.href,
                      text: mapText,
                    });
                  }
                }
              }
            } catch {
              // ignore unreachable optional source map
            }
          }
        } catch {
          // ignore unreadable closed response bodies
        }
      })();
      pendingArtifactTasks.add(task);
      void task.finally(() => pendingArtifactTasks.delete(task));
    });

    const look: ObserveOptions & { hide?: (t: string) => string } = {
      hide,
      ...(opts.knownSecrets ? { secrets: opts.knownSecrets } : {}),
    };
    const detectors = attachWebDetectors(context, page, {
      baseOrigin,
      hide,
      ...(opts.knownSecrets ? { knownSecrets: opts.knownSecrets } : {}),
      navTimeoutMs,
    });

    const limiter = createRateLimiter(maxRps);

    const captureScreen = async (depth: number, trigger?: string): Promise<Observation | null> => {
      await settleDom(page);
      const bodyInfo = await page
        .evaluate(() => ({
          title: document.title,
          text: document.body?.innerText?.slice(0, 64_000) ?? '',
          html: document.documentElement?.innerHTML?.slice(0, 64_000) ?? '',
        }))
        .catch(() => ({ title: '', text: '', html: '' }));
      const captchaHit = hasCaptchaOrWafSignal({
        ...(lastHttpStatus !== undefined ? { status: lastHttpStatus } : {}),
        title: bodyInfo.title,
        bodyText: bodyInfo.text,
        html: bodyInfo.html,
      });
      if (captchaHit) {
        haltedReason = 'captcha-or-waf';
        return null;
      }

      const baseObs = await observe(page, look);
      const findings = haltedReason ? [] : await detectors.collect();
      const obs: Observation = findings.length ? { ...baseObs, findings } : baseObs;
      const key = screenFingerprint(obs);
      if (seenScreenKeys.has(key)) return null;
      seenScreenKeys.add(key);

      if (opts.collectServedArtifacts && !haltedReason) {
        const snapArt = (await page.evaluate(`(${COLLECT_SCREEN_ARTIFACTS_FN})()`).catch(() => null)) as
          | { url?: string; dom?: string; storage?: string }
          | null;
        if (snapArt) {
          const curUrl = snapArt.url || baseObs.url;
          let pathname = '/';
          try {
            pathname = new URL(curUrl).pathname || '/';
          } catch {
            // keep default path label
          }
          const screenSeq = screens.length + 1;
          pushArtifact({ kind: 'url', name: `url-${screenSeq}`, url: curUrl, text: curUrl });
          if (snapArt.dom) pushArtifact({ kind: 'dom', name: `dom-${screenSeq}-${pathname}`, url: curUrl, text: snapArt.dom });
          if (snapArt.storage) pushArtifact({ kind: 'storage', name: `storage-${screenSeq}-${pathname}`, url: curUrl, text: snapArt.storage });
        }
      }

      screens.push({
        url: obs.url,
        depth,
        title: obs.title,
        ...(trigger ? { trigger } : {}),
        observation: obs,
      });
      await opts.onScreen?.(obs);
      if (screens.length >= maxScreens && !haltedReason) haltedReason = 'max-screens';
      return obs;
    };

    const enqueueDiscovered = (filtered: FilteredCrawlTargets, nextDepth: number) => {
      skippedOffOriginLinks += filtered.skippedOffOriginLinks;
      skippedControls += filtered.skippedControls;
      if (nextDepth > maxDepth) return;
      for (const nextUrl of filtered.links) {
        if (!visitedUrls.has(nextUrl) && !queuedUrls.has(nextUrl)) {
          queuedUrls.add(nextUrl);
          queue.push({ url: nextUrl, depth: nextDepth });
        }
      }
    };

    while (queue.length > 0 && screens.length < maxScreens && !haltedReason) {
      const item = queue.shift()!;
      if (item.depth > maxDepth || visitedUrls.has(item.url)) continue;
      visitedUrls.add(item.url);

      await limiter.acquire();
      if (haltedReason) break;
      lastHttpStatus = undefined;
      let navOk = true;
      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs }).catch(() => {
        navOk = false;
      });
      if (haltedReason) break;
      const loadedUrl = page.url();
      if (!navOk || !loadedUrl || loadedUrl === 'about:blank' || loadedUrl.startsWith('chrome-error://')) continue;

      const obs = await captureScreen(item.depth, item.trigger);
      if (haltedReason || !obs || screens.length >= maxScreens) break;
      if (item.depth >= maxDepth) continue;

      const raw = await inspectPageTargets(page, CONTROL_SELECTOR);
      const filtered = filterCrawlTargets(raw, page.url() || item.url, baseOrigin);
      enqueueDiscovered(filtered, item.depth + 1);

      // Probe safe non-destructive interactive controls (tabs/menus/dialogs) at this depth without submitting forms.
      for (const idx of filtered.controlIndices) {
        if (haltedReason || screens.length >= maxScreens) break;
        const current = normalizeCrawlUrl(page.url(), item.url, baseOrigin);
        if (current !== item.url) {
          await limiter.acquire();
          if (haltedReason) break;
          await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs }).catch(() => {});
          await settleDom(page);
          if (haltedReason) break;
        }
        const ctrl = page.locator(CONTROL_SELECTOR).nth(idx);
        const visible = await ctrl.isVisible().catch(() => false);
        if (!visible) continue;
        // Re-check live control properties immediately before clicking in case an earlier control mutated the DOM.
        const liveCtrl = await ctrl
          .evaluate((el) => {
            const form = el.closest('form');
            return {
              tagName: el.tagName.toLowerCase(),
              type: (el.getAttribute('type') ?? '').toLowerCase(),
              formMethod: (el.getAttribute('formmethod') ?? form?.getAttribute('method') ?? '').toLowerCase(),
              inForm: Boolean(form),
              label: (el.textContent ?? '').trim().slice(0, 120),
              ariaLabel: el.getAttribute('aria-label') ?? '',
              title: el.getAttribute('title') ?? '',
              name: el.getAttribute('name') ?? '',
              href: el.getAttribute('href') ?? '',
            };
          })
          .catch(() => null);
        if (!liveCtrl || isDestructiveControl(liveCtrl)) {
          if (liveCtrl) skippedControls++;
          continue;
        }
        await limiter.acquire();
        if (haltedReason) break;
        await ctrl.click({ timeout: actionTimeoutMs }).catch(() => {});
        if (haltedReason) break;

        const subObs = await captureScreen(item.depth + 1, `control:${idx}`);
        if (haltedReason || screens.length >= maxScreens) break;
        if (subObs && item.depth + 1 < maxDepth) {
          const afterRaw = await inspectPageTargets(page, CONTROL_SELECTOR);
          const afterFiltered = filterCrawlTargets(afterRaw, page.url() || item.url, baseOrigin);
          enqueueDiscovered(afterFiltered, item.depth + 2);
        }
      }
    }
    if (pendingArtifactTasks.size > 0) {
      await Promise.allSettled([...pendingArtifactTasks]);
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }

  return {
    screens,
    skippedControls,
    skippedOffOriginLinks,
    ...(haltedReason ? { haltedReason } : {}),
    ...(opts.collectServedArtifacts ? { servedArtifacts } : {}),
    ...(truncatedArtifacts > 0 ? { truncatedArtifacts } : {}),
  };
}
