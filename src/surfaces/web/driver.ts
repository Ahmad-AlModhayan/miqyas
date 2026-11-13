// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Playwright web surface driver: implements SurfaceDriver & SurfaceSession without importing Proof Core or agents.

import { createRequire } from 'node:module';
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright';

const require = createRequire(import.meta.url);
export const PLAYWRIGHT_VERSION: string = require('playwright/package.json').version;
import type {
  ActTool,
  Check,
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
import { observe, type ObserveOptions } from './observe.js';
import { originProxy } from './proxy.js';

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
export const PLAN_TIMEOUT_MS = 10 * 60_000;
export const NAV_TIMEOUT_MS = 30_000;
export const ACTION_TIMEOUT_MS = 5000;
const QUIET_MS = 400;
const OBSERVE_TRIES = 2;

async function settle(page: Page, capMs = 2000, quietMs = QUIET_MS): Promise<void> {
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
export async function observeSettled(page: Page, navs: NavTracker, opts: ObserveOptions = {}, look = observe): Promise<Observation> {
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

async function newContext(browser: Browser, opts: SurfaceSessionOptions): Promise<BrowserContext> {
  const base = { viewport: opts.viewport ?? DEFAULT_VIEWPORT, serviceWorkers: 'block' as const };
  if (opts.allowOtherOrigins) return browser.newContext(base);
  const origin = new URL(opts.url).origin;
  // The floor of the block. ctx.route and ctx.routeWebSocket hook the page, and a worker's WebSocket passes them
  // both; a proxy sees every request the context makes, from the page, its frames and its workers. Chromium skips
  // the proxy for loopback unless told '<-loopback>' (Playwright adds it too, unless an env var says not to).
  const proxy = await originProxy(origin);
  const ctx = await browser.newContext({ ...base, proxy: { server: proxy.server, bypass: '<-loopback>' } }).catch(async (e) => {
    await proxy.close();
    throw e;
  });
  ctx.on('close', () => void proxy.close());
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('data:') || u.startsWith('blob:') || new URL(u).origin === origin) return route.continue();
    return route.abort('blockedbyclient');
  });
  // Above the proxy, the same rule in the page: a refused socket closes with 1008 and a reason. ws: and wss: are
  // compared as http: and https:.
  await ctx.routeWebSocket(/.*/, (ws) => {
    const u = new URL(ws.url());
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    if (u.origin === origin) return void ws.connectToServer();
    return ws.close({ code: 1008, reason: `blocked: not ${origin}` });
  });
  return ctx;
}

function playwrightLocator(page: Page, loc: Locator) {
  if (loc.testId) return page.getByTestId(loc.testId);
  if (loc.role) return page.getByRole(loc.role as Parameters<Page['getByRole']>[0], loc.name ? { name: loc.name } : {});
  if (loc.label) return page.getByLabel(loc.label);
  return page.getByText(loc.text!);
}

/** Deterministic check. Visible means the element made it into the rendered snapshot (it carries a ref). */
async function evaluateCheck(page: Page, check: Check, obs: Observation): Promise<SurfaceCheckResult> {
  const refs = await playwrightLocator(page, check.locator).evaluateAll((els) => els.map((e) => e.getAttribute('data-miqyas-ref')));
  const byRef = new Map(obs.nodes.map((n) => [n.ref, n]));
  const nodes = refs.map((r) => (r ? byRef.get(r) : undefined)).filter((n): n is SnapNode => !!n);
  const what = JSON.stringify(check.locator);
  const e = check.expect;
  if (e === 'visible') return { pass: nodes.length > 0, observation: `${nodes.length} rendered match(es) of ${what} (${refs.length} in the DOM)`, nodes };
  if (e === 'hidden') return { pass: nodes.length === 0, observation: `${nodes.length} rendered match(es) of ${what} (${refs.length} in the DOM)`, nodes };
  if ('count' in e) return { pass: nodes.length === e.count, observation: `${nodes.length} rendered match(es) of ${what}, expected ${e.count}`, nodes };
  const hit = nodes.filter((n) => n.name.toLowerCase().includes(e.text.toLowerCase()));
  return { pass: hit.length > 0, observation: hit.length ? `"${hit[0]!.name}" rendered` : `no rendered match of ${what} contains "${e.text}"`, nodes: hit.length ? hit : nodes };
}

/** Reach the probe's screen on a served build and measure it (mutation effectiveness check, SRS FR-M2). */
export async function measureProbe(browser: Browser, url: string, probe: Probe): Promise<Reading> {
  const page = await browser.newPage();
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
    await page.close();
  }
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
      const snap = () => observeSettled(page, navs, look);

      let latest: Observation | undefined;
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
          latest = await snap();
          return latest;
        },
        async act(a: ActTool, resolveText?: (raw: string) => string): Promise<SurfaceActionResult> {
          await ensureLoaded();
          let ok = true;
          let message = 'ok';
          let locator: string | undefined;
          let error: string | undefined;
          try {
            if ('ref' in a && a.ref) {
              const node = latest?.nodes.find((n) => n.ref === a.ref);
              if (!node) throw new Error(`no node ${a.ref} in capture ${latest?.capture ?? 0}; use refs from the latest capture`);
              if (node.locator) locator = hide(node.locator);
            }
            const el = 'ref' in a && a.ref ? page.locator(`[data-miqyas-ref="${a.ref}"]`) : undefined;
            switch (a.tool) {
              case 'click':
                await el!.click({ timeout: actionTimeoutMs }).catch(async (e: Error) => {
                  // Styled radios and checkboxes: the input sits under its label, which takes the click.
                  if (!/intercepts pointer events/.test(e.message)) throw e;
                  const label = el!.locator('xpath=ancestor::label[1]');
                  if ((await label.count()) === 0) throw e;
                  await label.click({ timeout: actionTimeoutMs });
                  message = 'ok (clicked its label, which covers it)';
                });
                break;
              case 'fill': {
                const resolved = resolveText ? resolveText(a.text) : a.text;
                await el!.fill(resolved, { timeout: actionTimeoutMs });
                break;
              }
              case 'select_option':
                await el!.selectOption({ label: a.option }, { timeout: actionTimeoutMs }).catch(() => el!.selectOption(a.option, { timeout: actionTimeoutMs }));
                break;
              case 'press':
                await page.keyboard.press(a.key);
                break;
              case 'scroll':
                if (el) await el.scrollIntoViewIfNeeded({ timeout: actionTimeoutMs });
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
          latest = await snap();
          return {
            ok,
            message,
            observation: latest,
            ...(locator ? { locator } : {}),
            ...(error ? { error } : {}),
            ...(latest.unmasked ? { unmasked: latest.unmasked } : {}),
          };
        },
        async check(check: Check, obs: Observation): Promise<SurfaceCheckResult> {
          return evaluateCheck(page, check, obs);
        },
        async wait(seconds: number): Promise<Observation> {
          await page.waitForTimeout(Math.min(5, Math.max(1, seconds)) * 1000);
          latest = await snap();
          return latest;
        },
        async close() {
          await context.close().catch(() => {});
        },
      };
    },
    async measureProbe(url: string, probe: Probe): Promise<Reading> {
      return measureProbe(browser, url, probe);
    },
    async close() {
      await browser.close();
    },
  };
}
