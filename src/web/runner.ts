// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Web runner: Playwright Chromium drives the app; the agent acts and judges; the ledger records one verdict per
// assertion, at its position in the plan, before the next action.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright';
import { PlanLedger, settleJudgement, type ActionLog, type Evidence, type PlanResult } from '../core/ledger.js';
import { resolveSecrets, secretNames, type Check, type Locator, type Plan } from '../core/plan.js';
import { anyTerm, NO_SCRUB, ruleHits, scrubText, withSecrets, type ScrubRules } from '../core/scrub.js';
import type { ActTool, Agent, StepHistory, ToolExecution } from '../model/agent.js';
import type { Probe, Reading } from '../core/mutate.js';
import { originProxy } from './proxy.js';
import { cropPng, observe, toEvidenceNode, type Observation, type ObserveOptions, type SnapNode } from './observe.js';

export interface RunOptions {
  url: string;
  /** null runs dry: pages are opened and observed once, nothing is acted on or judged. */
  agent: Agent | null;
  runDir: string;
  scrub: ScrubRules;
  env?: Record<string, string | undefined>;
  concurrency?: number;
  headed?: boolean;
  /** Let the app load resources from other origins (blocked by default: nothing leaves but model calls). */
  allowOtherOrigins?: boolean;
  viewport?: { width: number; height: number };
  planTimeoutMs?: number;
  /** How long a navigation may stay pending before the page is observed as it is (default NAV_TIMEOUT_MS). */
  navTimeoutMs?: number;
  /** Called after each plan finishes. */
  onPlan?: (r: PlanResult) => void;
  /** Called once with the launched browser's version, for the report's method block. */
  onBrowser?: (version: string) => void;
}

/** Run defaults, recorded in the report's method block. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
export const PLAN_TIMEOUT_MS = 10 * 60_000;
export const NAV_TIMEOUT_MS = 30_000;
export const ACTION_TIMEOUT_MS = 5000;

// Settle = no DOM mutation for QUIET_MS, capped (an animated progress bar never goes quiet).
const QUIET_MS = 400;

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

/** Main-frame navigations whose document hasn't committed: Enter in a GET form or a router's late `location.assign`
 * starts one that nothing waits for. Playwright's evaluate and screenshot stall until it commits, then die with the old
 * document; one that never commits stalls them for good. */
export interface NavTracker {
  /** Wait for every pending navigation to commit and load, at most `timeoutMs`; what is still pending then. */
  idle(): Promise<string[]>;
  readonly timeoutMs: number;
}

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

/** One re-observe: a navigation that commits mid-observe anyway is waited out and observed again once. */
const OBSERVE_TRIES = 2;

/** Observe once no navigation is in flight. One still pending after the wait is an error: the observe would stall
 * on it, and the old page can't be read meanwhile. */
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

function rel(runDir: string, file: string): string {
  return path.relative(runDir, file).split(path.sep).join('/');
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

/** `blockOtherOrigins`: WebRTC sends UDP straight from the network stack, past any proxy, so with the block on
 * Chromium may send none that isn't proxied. Only then: with other origins allowed, an app's WebRTC works as is. */
export async function launch(headed = false, blockOtherOrigins = false): Promise<Browser> {
  return chromium.launch({ headless: !headed, ...(blockOtherOrigins ? { args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] } : {}) });
}

async function newContext(browser: Browser, opts: RunOptions): Promise<BrowserContext> {
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
async function runCheck(page: Page, check: Check, obs: Observation): Promise<{ pass: boolean; observation: string; nodes: SnapNode[] }> {
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

/** `hide` masks secret values in node names, states and the URL: a secret typed into a plain field shows in its
 * value, and a GET form (the HTML default) puts it in the query string. */
async function saveEvidence(runDir: string, planId: string, stepId: string, obs: Observation, nodes: SnapNode[], hide: (t: string) => string): Promise<Evidence> {
  const dir = path.join(runDir, 'evidence', safe(planId));
  await mkdir(dir, { recursive: true });
  const screen = path.join(dir, `${safe(stepId)}-c${obs.capture}.png`);
  await writeFile(screen, obs.png);
  const ev: Evidence = { screenshot: rel(runDir, screen), nodes: nodes.map((n) => toEvidenceNode({ ...n, name: hide(n.name), state: hide(n.state) })), url: hide(obs.url), capturedAt: obs.capturedAt.toISOString() };
  if (obs.unmasked) ev.unmasked = obs.unmasked;
  const crop = cropPng(obs.png, nodes.map((n) => n.box));
  if (crop) {
    const cropFile = path.join(dir, `${safe(stepId)}-crop.png`);
    await writeFile(cropFile, crop);
    ev.crop = rel(runDir, cropFile);
  }
  return ev;
}

async function runPlan(browser: Browser, plan: Plan, opts: RunOptions): Promise<PlanResult> {
  const started = Date.now();
  const ledger = new PlanLedger(plan);
  const env = opts.env ?? process.env;
  // Secret values are scrubbed back to their placeholders before any text reaches the model.
  const names = plan.steps.flatMap((s) => secretNames(s.text));
  const rules = withSecrets(opts.scrub, names, env);
  const scrub = (t: string) => scrubText(t, rules);
  const rescan = (t: string) => ruleHits(t, rules);
  // Evidence, the ledger and the reports stay on this machine, so only secret values are masked there.
  const secrets = withSecrets(NO_SCRUB, names, env);
  const hide = (t: string) => scrubText(t, secrets);
  // And painted over on the page before every screenshot, which goes to the model and into the evidence.
  const mask = anyTerm(secrets);
  const look = mask ? { secrets: mask, hide } : {};

  const context = await newContext(browser, opts);
  // The context owns its proxy: close it if the page never opens.
  const page = await context.newPage().catch(async (e) => {
    await context.close().catch(() => {});
    throw e;
  });
  const navs = inFlight(page, opts.navTimeoutMs);
  const snap = () => observeSettled(page, navs, look);
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = async () => {
      await page.goto(opts.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
      await settleLoad(page);
      let latest = await snap();
      if (!opts.agent) {
        ledger.fail(`dry run (${latest.nodes.length} rendered nodes observed at ${hide(latest.url)})`);
        return;
      }
      const agent = opts.agent;
      const history: StepHistory[] = [];
      let postAction: Observation | undefined;
      const planRef = { id: plan.id, name: plan.name };

      for (const step of plan.steps) {
        const t0 = Date.now();
        if (step.type === 'action') {
          const missing = secretNames(step.text).filter((n) => env[`MIQYAS_SECRET_${n}`] === undefined).map((n) => `MIQYAS_SECRET_${n}`);
          if (missing.length) {
            ledger.recordAction({ stepId: step.id, status: 'blocked', summary: `missing secret(s): ${missing.join(', ')}`, actions: [] });
            ledger.block(`blocked: ${missing.join(', ')} not set`);
            return;
          }
          const log: ActionLog[] = [];
          postAction = undefined;
          const execute = async (a: ActTool): Promise<ToolExecution> => {
            const entry: ActionLog = { tool: a.tool, input: { ...a }, ok: true };
            let message = 'ok';
            try {
              if ('ref' in a && a.ref) {
                const node = latest.nodes.find((n) => n.ref === a.ref);
                if (!node) throw new Error(`no node ${a.ref} in capture ${latest.capture}; use refs from the latest capture`);
                if (node.locator) entry.locator = hide(node.locator);
              }
              const el = 'ref' in a && a.ref ? page.locator(`[data-miqyas-ref="${a.ref}"]`) : undefined;
              switch (a.tool) {
                case 'click':
                  await el!.click({ timeout: ACTION_TIMEOUT_MS }).catch(async (e: Error) => {
                    // Styled radios and checkboxes: the input sits under its label, which takes the click.
                    if (!/intercepts pointer events/.test(e.message)) throw e;
                    const label = el!.locator('xpath=ancestor::label[1]');
                    if ((await label.count()) === 0) throw e;
                    await label.click({ timeout: ACTION_TIMEOUT_MS });
                    message = 'ok (clicked its label, which covers it)';
                  });
                  break;
                case 'fill': {
                  // Only the step's own secrets: masking and scrubbing cover those, not the rest of the environment.
                  const named = [...new Set(secretNames(step.text))];
                  const foreign = [...new Set(secretNames(a.text))].filter((n) => !named.includes(n));
                  const list = (ns: string[]) => ns.map((n) => `\${secret.${n}}`).join(', ');
                  if (foreign.length) throw new Error(`${list(foreign)} ${foreign.length > 1 ? 'are' : 'is'} not named by this step; ${named.length ? `type only ${list(named)}` : 'it names no secret'}`);
                  const text = resolveSecrets(a.text, env);
                  if (text === undefined) throw new Error('a secret in the text is not set');
                  await el!.fill(text, { timeout: ACTION_TIMEOUT_MS });
                  break;
                }
                case 'select_option':
                  await el!.selectOption({ label: a.option }, { timeout: ACTION_TIMEOUT_MS }).catch(() => el!.selectOption(a.option, { timeout: ACTION_TIMEOUT_MS }));
                  break;
                case 'press':
                  await page.keyboard.press(a.key);
                  break;
                case 'scroll':
                  if (el) await el.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
                  else await page.mouse.wheel(0, a.direction === 'down' ? 600 : -600);
                  break;
                case 'wait':
                  await page.waitForTimeout(Math.min(10, Math.max(1, a.seconds)) * 1000);
                  break;
                case 'navigate': {
                  const target = new URL(a.path, opts.url);
                  if (target.origin !== new URL(opts.url).origin) throw new Error(`navigation outside ${new URL(opts.url).origin} is not allowed`);
                  await page.goto(target.href, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
                  await settleLoad(page);
                  break;
                }
              }
            } catch (e) {
              entry.ok = false;
              // Playwright errors can quote the page's URL or text.
              entry.error = hide((e as Error).message.split('\n')[0]!);
              message = `error: ${entry.error}`;
            }
            log.push(entry);
            await settle(page);
            latest = await snap();
            if (latest.unmasked) entry.unmasked = latest.unmasked;
            if (a.tool !== 'wait' || !postAction) postAction = latest;
            return { ok: entry.ok, message, observation: latest };
          };
          const outcome = await agent.act({ plan: planRef, step, history, observation: latest, scrub, rescan, signal: abort.signal, execute });
          ledger.recordAction({ stepId: step.id, status: outcome.status, summary: outcome.summary, actions: log, durationMs: Date.now() - t0 });
          history.push({ stepId: step.id, type: 'action', text: step.text, result: outcome.status === 'done' ? `done: ${outcome.summary}` : `FAILED: ${outcome.summary}` });
          if (outcome.status === 'failed') return;
          continue;
        }

        // Assertion: judged now, at its position, before the next action.
        const current = await snap();
        latest = current;
        if (step.check) {
          const r = await runCheck(page, step.check, current);
          const evidence = await saveEvidence(opts.runDir, plan.id, step.id, current, r.nodes, hide);
          ledger.recordAssertion({ stepId: step.id, verdict: r.pass ? 'pass' : 'fail', method: 'code', observation: hide(r.observation), evidence, durationMs: Date.now() - t0 });
          history.push({ stepId: step.id, type: 'assertion', text: step.text, result: r.pass ? 'pass' : 'fail' });
          continue;
        }
        const captures = new Map<number, Observation>([[current.capture, current]]);
        if (postAction) captures.set(postAction.capture, postAction);
        const lookAgain = async (seconds: number) => {
          await page.waitForTimeout(Math.min(5, Math.max(1, seconds)) * 1000);
          latest = await snap();
          captures.set(latest.capture, latest);
          return latest;
        };
        const j = await agent.judge({ plan: planRef, step, history, ...(postAction ? { postAction } : {}), current, scrub, rescan, signal: abort.signal, lookAgain });
        if (j.verdict === 'none') {
          const evidence = await saveEvidence(opts.runDir, plan.id, step.id, latest, [], hide);
          ledger.recordAssertion({ stepId: step.id, verdict: 'not_checked', method: 'ai', observation: '', reason: j.reason, evidence, durationMs: Date.now() - t0 });
          history.push({ stepId: step.id, type: 'assertion', text: step.text, result: 'not checked' });
          continue;
        }
        // Resolve cited refs to nodes; evidence comes from the capture of the first resolved ref.
        const resolved: { obs: Observation; node: SnapNode }[] = [];
        const unresolved: string[] = [];
        for (const ref of j.evidenceRefs) {
          const m = /^c(\d+)e\d+$/.exec(ref);
          const obs = m ? captures.get(Number(m[1])) : undefined;
          const node = obs?.nodes.find((n) => n.ref === ref);
          if (obs && node) resolved.push({ obs, node });
          else unresolved.push(ref);
        }
        const evObs = resolved[0]?.obs ?? latest;
        const evNodes = resolved.filter((r) => r.obs === evObs).map((r) => r.node);
        const settled = settleJudgement({ verdict: j.verdict, observation: j.observation, nodes: evNodes, unresolvedRefs: unresolved });
        const evidence = await saveEvidence(opts.runDir, plan.id, step.id, evObs, evNodes, hide);
        const entry = { stepId: step.id, verdict: settled.verdict, method: 'ai' as const, observation: j.observation, evidence, durationMs: Date.now() - t0 };
        ledger.recordAssertion(settled.reason ? { ...entry, reason: settled.reason } : entry);
        history.push({ stepId: step.id, type: 'assertion', text: step.text, result: settled.verdict });
      }
    };
    const limit = opts.planTimeoutMs ?? PLAN_TIMEOUT_MS;
    await Promise.race([
      work(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`plan timed out after ${Math.round(limit / 1000)} s`));
          abort.abort();
        }, limit);
      }),
    ]);
  } catch (e) {
    ledger.fail(hide((e as Error).message.split('\n')[0]!));
  } finally {
    if (timer) clearTimeout(timer);
    await context.close().catch(() => {});
  }
  const result = ledger.close(Date.now() - started);
  return result;
}

export async function runPlans(plans: Plan[], opts: RunOptions): Promise<PlanResult[]> {
  await mkdir(opts.runDir, { recursive: true });
  const browser = await launch(opts.headed, !opts.allowOtherOrigins);
  opts.onBrowser?.(browser.version());
  try {
    const results: PlanResult[] = new Array(plans.length);
    let next = 0;
    const worker = async () => {
      while (next < plans.length) {
        const i = next++;
        const r = await runPlan(browser, plans[i]!, opts);
        results[i] = r;
        opts.onPlan?.(r);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, plans.length)) }, worker));
    return results;
  } finally {
    await browser.close();
  }
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
