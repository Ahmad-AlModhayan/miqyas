// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Playwright web surface driver: implements SurfaceDriver & SurfaceSession without importing Proof Core or agents.

import { createRequire } from 'node:module';
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Page, type Request } from 'playwright';

const require = createRequire(import.meta.url);
export const PLAYWRIGHT_VERSION: string = require('playwright/package.json').version;
import type {
  ActTool,
  Check,
  CrawlOptions,
  CrawlResult,
  Locator,
  Observation,
  Probe,
  Reading,
  SnapNode,
  SurfaceActionResult,
  SurfaceCheckResult,
  SurfaceDriver,
  SurfaceSession,
  SurfaceSessionOptions,
} from '../session.js';
import { crawlWebApp, settleDom } from './crawler.js';
import { attachWebDetectors } from './detectors.js';
import { observeWithHandles, type ObserveOptions, type SnapshotWithHandles } from './observe.js';
import { attachOriginIsolation } from './policy.js';
import { originProxy } from './proxy.js';

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
export const PLAN_TIMEOUT_MS = 10 * 60_000;
export const NAV_TIMEOUT_MS = 30_000;
export const ACTION_TIMEOUT_MS = 5000;
const QUIET_MS = 400;
const OBSERVE_TRIES = 2;
const MOVE_TOLERANCE_PX = 4;

const settle = (page: Page, capMs = 2000, quietMs = QUIET_MS) => settleDom(page, capMs, quietMs);

export interface NavTracker {
  idle(): Promise<string[]>;
  readonly timeoutMs: number;
}

/** Track top-frame navigations as Playwright reports them, so an action that triggers a load doesn't observe an
 * empty halfway document. Only the main frame can replace the page; iframes don't tear down its context. */
export function inFlight(page: Page, timeoutMs = NAV_TIMEOUT_MS): NavTracker {
  const navs = new Set<Request>();
  page.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navs.add(r);
  });
  page.on('requestfinished', (r) => navs.delete(r));
  page.on('requestfailed', (r) => navs.delete(r));
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navs.clear();
  });
  return {
    timeoutMs,
    async idle() {
      if (!navs.size) return [];
      const until = Date.now() + timeoutMs;
      while (navs.size && Date.now() < until) await page.waitForTimeout(50);
      // Settling evaluates in the page, which would stall behind a navigation still pending.
      if (navs.size) return [...navs].map((r) => r.url());
      await page.waitForLoadState('load', { timeout: Math.max(1, until - Date.now()) }).catch(() => {});
      await settle(page);
      return [];
    },
  };
}

/** Observe once no main-frame navigation is in flight, retrying if the context closes mid-observe on a redirect. */
export async function observeSettled(
  page: Page,
  navs: NavTracker,
  opts: ObserveOptions = {},
  look: (page: Page, opts: ObserveOptions) => Promise<Observation> = async (p, o) => {
    const { observation, handles } = await observeWithHandles(p, o);
    for (const h of handles.values()) await h.dispose().catch(() => {});
    return observation;
  },
): Promise<Observation> {
  for (let i = 1; ; i++) {
    const pending = await navs.idle();
    if (pending.length) throw new Error(`a navigation to ${(opts.hide ?? ((t) => t))(pending.join(', '))} was still pending after ${Math.round(navs.timeoutMs / 1000)} s`);
    try {
      return await look(page, opts);
    } catch (e) {
      if (i >= OBSERVE_TRIES || !/context was destroyed/i.test((e as Error).message)) throw e;
      await page.waitForLoadState('load', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    }
  }
}

async function observeSettledWithHandles(page: Page, navs: NavTracker, opts: ObserveOptions = {}): Promise<SnapshotWithHandles> {
  let out!: SnapshotWithHandles;
  await observeSettled(page, navs, opts, async (p, o) => {
    out = await observeWithHandles(p, o);
    return out.observation;
  });
  return out;
}

/** After a page load: wait for the app to finish starting (spinners, "connecting…" screens). */
async function settleLoad(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await settle(page, 6000, 1200);
}

/** `blockOtherOrigins`: WebRTC sends UDP straight from the network stack, past any proxy, so with the block on
 * Chromium may send none that isn't proxied. Only then: with other origins allowed, an app's WebRTC works as is. */
export async function launch(headed = false, blockOtherOrigins = false): Promise<Browser> {
  return chromium.launch({ headless: !headed, ...(blockOtherOrigins ? { args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] } : {}) });
}

export async function createIsolatedContext(
  browser: Browser,
  opts: {
    url: string;
    viewport?: { width: number; height: number };
    allowOtherOrigins?: boolean;
    enforceSameOrigin?: boolean;
  },
): Promise<BrowserContext> {
  const base = { viewport: opts.viewport ?? DEFAULT_VIEWPORT, serviceWorkers: 'block' as const };
  if (opts.allowOtherOrigins && !opts.enforceSameOrigin) return browser.newContext(base);
  const origin = new URL(opts.url).origin;
  // The floor of the block: proxy sits below pages, frames, and workers; route/routeWebSocket enforce the same policy above it.
  const proxy = await originProxy(origin);
  const ctx = await browser.newContext({ ...base, proxy: { server: proxy.server, bypass: '<-loopback>' } }).catch(async (e) => {
    await proxy.close();
    throw e;
  });
  ctx.on('close', () => void proxy.close());
  await attachOriginIsolation(ctx, origin);
  return ctx;
}

async function newContext(browser: Browser, opts: SurfaceSessionOptions): Promise<BrowserContext> {
  return createIsolatedContext(browser, {
    url: opts.url,
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    ...(opts.allowOtherOrigins !== undefined ? { allowOtherOrigins: opts.allowOtherOrigins } : {}),
  });
}

function playwrightLocator(page: Page, loc: Locator) {
  if (loc.testId) return page.getByTestId(loc.testId);
  if (loc.role) return page.getByRole(loc.role as Parameters<Page['getByRole']>[0], loc.name ? { name: loc.name } : {});
  if (loc.label) return page.getByLabel(loc.label);
  return page.getByText(loc.text!);
}

/** Deterministic check. Visible means the locator element resolves to a live locked handle captured at observation time. */
async function evaluateCheck(
  page: Page,
  check: Check,
  obs: Observation,
  handles: Map<string, ElementHandle<Element>>,
): Promise<SurfaceCheckResult> {
  const locHandles = await playwrightLocator(page, check.locator).elementHandles();
  const what = JSON.stringify(check.locator);
  let matchedRefs: (string | null)[] = [];
  try {
    if (locHandles.length > 0 && handles.size > 0) {
      const lockedEntries = [...handles.entries()];
      const lockedEls = lockedEntries.map(([, h]) => h);
      // Primitive indexed loop with strict object identity prevents Array.prototype.map/indexOf tampering in page realm.
      const indices = await page.evaluate(
        ({ targets, locked }) => {
          const out = new Array<number>(targets.length);
          for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            let found = -1;
            for (let j = 0; j < locked.length; j++) {
              if (locked[j] === t) {
                found = j;
                break;
              }
            }
            out[i] = found;
          }
          return out;
        },
        { targets: locHandles, locked: lockedEls },
      );
      matchedRefs = Array.isArray(indices)
        ? indices.map((idx) => (typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx < lockedEntries.length ? (lockedEntries[idx]?.[0] ?? null) : null))
        : [];
    }
  } finally {
    await Promise.all(locHandles.map((h) => h.dispose().catch(() => {})));
  }
  const byRef = new Map(obs.nodes.map((n) => [n.ref, n]));
  const nodes = matchedRefs.map((r) => (r ? byRef.get(r) : undefined)).filter((n): n is SnapNode => !!n);
  const e = check.expect;
  if (e === 'visible') return { pass: nodes.length > 0, observation: `${nodes.length} rendered match(es) of ${what} (${locHandles.length} in the DOM)`, nodes };
  if (e === 'hidden') return { pass: nodes.length === 0, observation: `${nodes.length} rendered match(es) of ${what} (${locHandles.length} in the DOM)`, nodes };
  if ('count' in e) return { pass: nodes.length === e.count, observation: `${nodes.length} rendered match(es) of ${what}, expected ${e.count}`, nodes };
  const hit = nodes.filter((n) => n.name.toLowerCase().includes(e.text.toLowerCase()));
  return { pass: hit.length > 0, observation: hit.length ? `"${hit[0]!.name}" rendered` : `no rendered match of ${what} contains "${e.text}"`, nodes: hit.length ? hit : nodes };
}

/** Reach the probe's screen on a served build and measure it under full same-origin proxy isolation (FR-M2 / #14). */
export async function measureProbe(browser: Browser, url: string, probe: Probe): Promise<Reading> {
  const context = await createIsolatedContext(browser, { url, enforceSameOrigin: true });
  const page = await context.newPage().catch(async (e) => {
    await context.close().catch(() => {});
    throw e;
  });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await settleLoad(page);
    for (const step of probe.steps ?? []) {
      await page.click(step, { timeout: 5000 });
      await settle(page, 3000, 300);
    }
    return await page.evaluate(
      ({ html, rootAttrs, selector, measure }) => {
        for (const [k, v] of Object.entries(rootAttrs ?? {})) document.documentElement.setAttribute(k, v);
        if (html) {
          const box = document.createElement('div');
          box.innerHTML = html;
          document.body.appendChild(box);
        }
        if (measure === 'text') return document.body.innerText;
        const el = selector ? document.querySelector(selector) : null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return Math.round(measure === 'height' ? r.height : r.left);
      },
      { html: probe.html, rootAttrs: probe.rootAttrs, selector: probe.selector, measure: probe.measure },
    );
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function verifyHandleFresh(handle: ElementHandle<Element>, node: SnapNode): Promise<void> {
  const visible = await handle.isVisible().catch(() => false);
  const check = await handle
    .evaluate(
      (el, { origBox, tolerance }) => {
        if (!el.isConnected) return 'detached from DOM';
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return 'no longer visible';
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + window.scrollX);
        const y = Math.round(r.top + window.scrollY);
        const w = Math.round(r.width);
        const h = Math.round(r.height);
        if (w <= 1 || h <= 1) return 'collapsed';
        const moved =
          Math.abs(x - origBox.x) > tolerance ||
          Math.abs(y - origBox.y) > tolerance ||
          Math.abs(w - origBox.width) > tolerance ||
          Math.abs(h - origBox.height) > tolerance;
        if (moved) return `moved or resized (was @${origBox.x},${origBox.y} ${origBox.width}x${origBox.height}, now @${x},${y} ${w}x${h})`;
        return '';
      },
      { origBox: node.box, tolerance: MOVE_TOLERANCE_PX },
    )
    .catch(() => 'detached from DOM');
  if (!visible || check) {
    throw new Error(`ref ${node.ref} is stale or moved (${check || 'not visible'}); observe again before acting`);
  }
}

async function disposeHandles(handles: Map<string, ElementHandle<Element>>): Promise<void> {
  await Promise.all([...handles.values()].map((h) => h.dispose().catch(() => {})));
  handles.clear();
}

/** Open a Playwright-backed web SurfaceDriver. Caller is responsible for closing it. */
export async function openWebSurfaceDriver(opts: { headed?: boolean; allowOtherOrigins?: boolean } = {}): Promise<SurfaceDriver> {
  const browser = await launch(opts.headed, !opts.allowOtherOrigins);
  const version = browser.version();
  return {
    surface: 'web',
    version,
    defaults: { viewport: DEFAULT_VIEWPORT, planTimeoutMs: PLAN_TIMEOUT_MS, navTimeoutMs: NAV_TIMEOUT_MS, actionTimeoutMs: ACTION_TIMEOUT_MS },
    async openSession(sessionOpts: SurfaceSessionOptions): Promise<SurfaceSession> {
      const navTimeoutMs = sessionOpts.navTimeoutMs ?? NAV_TIMEOUT_MS;
      const actionTimeoutMs = sessionOpts.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
      const hide = sessionOpts.hide ?? ((t: string) => t);
      const look: ObserveOptions & { hide?: (t: string) => string } = { ...sessionOpts.observe, hide };
      const context = await newContext(browser, sessionOpts);
      // The context owns its proxy: close it if the page never opens.
      const page = await context.newPage().catch(async (e) => {
        await context.close().catch(() => {});
        throw e;
      });
      const navs = inFlight(page, navTimeoutMs);
      const detectors = attachWebDetectors(context, page, {
        baseOrigin: new URL(sessionOpts.url).origin,
        hide,
        ...(look.secrets ? { knownSecrets: look.secrets } : {}),
        navTimeoutMs,
      });

      let latest: Observation | undefined;
      let latestHandles = new Map<string, ElementHandle<Element>>();
      const snap = async (): Promise<Observation> => {
        const next = await observeSettledWithHandles(page, navs, look);
        const screenFindings = await detectors.collect();
        const observation = screenFindings.length ? { ...next.observation, findings: screenFindings } : next.observation;
        const prev = latestHandles;
        latest = observation;
        latestHandles = next.handles;
        await disposeHandles(prev);
        return observation;
      };
      let loaded = false;
      const gotoOrigin = async (pathOrUrl: string) => {
        const baseOrigin = new URL(sessionOpts.url).origin;
        const target = new URL(pathOrUrl, sessionOpts.url);
        if (target.origin !== baseOrigin) throw new Error(`navigation outside ${baseOrigin} is not allowed`);
        loaded = true;
        await page.goto(target.href, { waitUntil: 'load', timeout: navTimeoutMs });
        await settleLoad(page);
      };
      const ensureLoaded = async () => {
        if (!loaded) await gotoOrigin(sessionOpts.url);
      };

      return {
        async observe() {
          await ensureLoaded();
          return snap();
        },
        async act(a: ActTool, resolveText?: (raw: string) => string): Promise<SurfaceActionResult> {
          await ensureLoaded();
          let ok = true;
          let message = 'ok';
          let locator: string | undefined;
          let error: string | undefined;
          try {
            let handle: ElementHandle<Element> | undefined;
            if ('ref' in a && a.ref) {
              const node = latest?.nodes.find((n) => n.ref === a.ref);
              if (!node) throw new Error(`no node ${a.ref} in capture ${latest?.capture ?? 0}; use refs from the latest capture`);
              if (node.locator) locator = hide(node.locator);
              handle = latestHandles.get(a.ref);
              if (!handle) throw new Error(`ref ${a.ref} has no locked element handle`);
              await verifyHandleFresh(handle, node);
            }
            switch (a.tool) {
              case 'click':
                await handle!.click({ timeout: actionTimeoutMs }).catch(async (e: Error) => {
                  // Styled radios and checkboxes: the input sits under its label, which takes the click.
                  if (!/intercepts pointer events/.test(e.message)) throw e;
                  const labelHandle = await handle!.evaluateHandle((el) => el.closest('label'));
                  try {
                    const label = labelHandle.asElement();
                    if (!label) throw e;
                    await label.click({ timeout: actionTimeoutMs });
                    message = 'ok (clicked its label, which covers it)';
                  } finally {
                    await labelHandle.dispose().catch(() => {});
                  }
                });
                break;
              case 'fill': {
                const resolved = resolveText ? resolveText(a.text) : a.text;
                await handle!.fill(resolved, { timeout: actionTimeoutMs });
                break;
              }
              case 'select_option':
                await handle!.selectOption({ label: a.option }, { timeout: actionTimeoutMs }).catch(() => handle!.selectOption(a.option, { timeout: actionTimeoutMs }));
                break;
              case 'press':
                await page.keyboard.press(a.key);
                break;
              case 'scroll':
                if (handle) await handle.scrollIntoViewIfNeeded({ timeout: actionTimeoutMs });
                else await page.mouse.wheel(0, a.direction === 'down' ? 600 : -600);
                break;
              case 'wait':
                await page.waitForTimeout(Math.min(10, Math.max(1, a.seconds)) * 1000);
                break;
              case 'navigate':
                await gotoOrigin(a.path);
                break;
            }
          } catch (e) {
            ok = false;
            // Playwright errors can quote the page's URL or text.
            error = hide((e as Error).message.split('\n')[0]!);
            message = `error: ${error}`;
          }
          await settle(page);
          const after = await snap();
          return {
            ok,
            message,
            observation: after,
            ...(locator ? { locator } : {}),
            ...(error ? { error } : {}),
            ...(after.unmasked ? { unmasked: after.unmasked } : {}),
          };
        },
        async check(check: Check, obs: Observation): Promise<SurfaceCheckResult> {
          return evaluateCheck(page, check, obs, latestHandles);
        },
        async wait(seconds: number): Promise<Observation> {
          await page.waitForTimeout(Math.min(5, Math.max(1, seconds)) * 1000);
          return snap();
        },
        async close() {
          await disposeHandles(latestHandles);
          await context.close().catch(() => {});
        },
      };
    },
    async crawl(crawlOpts: CrawlOptions): Promise<CrawlResult> {
      return crawlWebApp(crawlOpts, {
        openContext: (url, viewport) =>
          createIsolatedContext(browser, {
            url,
            ...(viewport ? { viewport } : {}),
            enforceSameOrigin: true,
          }),
        defaultViewport: DEFAULT_VIEWPORT,
        navTimeoutMs: NAV_TIMEOUT_MS,
        actionTimeoutMs: ACTION_TIMEOUT_MS,
      });
    },
    async measureProbe(url: string, probe: Probe): Promise<Reading> {
      return measureProbe(browser, url, probe);
    },
    async close() {
      await browser.close();
    },
  };
}
