// SPDX-License-Identifier: AGPL-3.0-only
// Proof Core orchestrator seam tests (no Chromium, no CLI, no Anthropic API).

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../../src/adapters/adapter.js';
import type { Agent, ActContext, ActOutcome, JudgeContext, JudgeOutcome } from '../../src/agents/agent.js';
import { BudgetError, SpendGuard, quotePlans } from '../../src/agents/spend.js';
import { parsePlan } from '../../src/proof-core/plan.js';
import { parsePreset } from '../../src/proof-core/mutate.js';
import { runMutations, runVerification } from '../../src/proof-core/orchestrator.js';
import { parseScrubRules } from '../../src/scrub/scrub.js';
import type { Observation, Probe, Reading, SurfaceDriver, SurfaceSession } from '../../src/surfaces/session.js';

const temps: string[] = [];
afterEach(async () => {
  while (temps.length) await rm(temps.pop()!, { recursive: true, force: true });
});

function tinyPng(): Buffer {
  const png = new PNG({ width: 20, height: 20 });
  png.data.fill(200);
  return PNG.sync.write(png);
}

function makeObservation(capture: number, text: string, url = 'http://app.local/'): Observation {
  return {
    capture,
    url,
    title: 'App',
    lang: 'en',
    dir: 'ltr',
    viewport: { width: 1280, height: 800 },
    nodes: [
      { ref: `c${capture}e1`, role: 'heading', name: text, depth: 1, box: { x: 0, y: 0, width: 120, height: 24 }, state: '', locator: `getByRole('heading', { name: '${text}' })` },
      { ref: `c${capture}e2`, role: 'button', name: 'Save', depth: 1, box: { x: 0, y: 40, width: 80, height: 32 }, state: '', locator: `getByRole('button', { name: 'Save' })` },
    ],
    truncated: false,
    png: tinyPng(),
    capturedAt: new Date('2026-11-13T10:00:00Z'),
  };
}

function fakeDriver(opts: { initialText?: string; probeReadings?: (url: string, probe: Probe) => Reading } = {}): {
  driver: SurfaceDriver;
  actions: string[];
  closedCount: () => number;
} {
  let capture = 0;
  let closed = 0;
  let text = opts.initialText ?? 'Dashboard';
  const actions: string[] = [];
  const driver: SurfaceDriver = {
    surface: 'web',
    version: 'fake-1.0',
    async openSession(sessionOpts): Promise<SurfaceSession> {
      return {
        async observe() {
          capture += 1;
          return makeObservation(capture, text, sessionOpts.url);
        },
        async act(a, resolveText) {
          const val = 'text' in a && resolveText ? resolveText(a.text) : undefined;
          actions.push(`${a.tool}${val ? `:${val}` : ''}`);
          if (a.tool === 'click') text = 'Saved';
          capture += 1;
          return { ok: true, message: 'ok', observation: makeObservation(capture, text, sessionOpts.url) };
        },
        async check(check) {
          if (check.expect === 'visible') {
            return { pass: text === 'Saved', observation: `heading is "${text}"`, nodes: makeObservation(capture, text).nodes };
          }
          return { pass: false, observation: 'unexpected check', nodes: [] };
        },
        async wait(s) {
          actions.push(`wait:${s}`);
          capture += 1;
          return makeObservation(capture, text, sessionOpts.url);
        },
        async close() {
          closed += 1;
        },
      };
    },
    async measureProbe(url, probe) {
      if (opts.probeReadings) return opts.probeReadings(url, probe);
      return url.includes('mutant') ? 0 : 24;
    },
    async close() {},
  };
  return { driver, actions, closedCount: () => closed };
}

function fakeAgent(): Agent {
  return {
    info: { provider: 'fake', model: 'fake-model' },
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    async act(ctx: ActContext): Promise<ActOutcome> {
      const btn = ctx.observation.nodes.find((n) => n.role === 'button') ?? ctx.observation.nodes[0]!;
      await ctx.execute({ tool: 'click', ref: btn.ref });
      return { status: 'done', summary: 'clicked element' };
    },
    async judge(ctx: JudgeContext): Promise<JudgeOutcome> {
      const ref = ctx.current.nodes[0]!.ref;
      return { verdict: 'pass', observation: 'Verified state change', evidenceRefs: [ref] };
    },
  };
}

describe('Proof Core orchestrator', () => {
  it('coordinates normalized plans, SurfaceSession, Adapters, and Agent into one unified RunResult', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-orch-'));
    temps.push(dir);
    const plan = parsePlan(
      {
        format: 'miqyas-plan',
        version: 1,
        id: 'save-flow',
        name: 'Save flow',
        steps: [
          { id: 's1', type: 'action', text: 'Click Save' },
          { id: 'a1', type: 'assertion', text: 'Saved heading visible', check: { locator: { role: 'heading', name: 'Saved' }, expect: 'visible' } },
          { id: 'a2', type: 'assertion', text: 'AI confirms Saved state' },
        ],
      },
      'save-flow',
    );
    const scrub = parseScrubRules({ terms: [{ from: 'SecretAcme', to: '[APP]' }] });
    const { driver, actions, closedCount } = fakeDriver();
    const adapterRan: string[] = [];
    const adapter: Adapter = {
      id: 'stub-scan',
      kind: 'scanner',
      surfaces: ['web'],
      async run(ctx) {
        adapterRan.push(`${ctx.surface}:${ctx.url}`);
        return {
          adapterId: 'stub-scan',
          status: 'ok',
          findings: [{ id: 'f1', title: 'No secrets leaked', severity: 'info', summary: 'Clean' }],
        };
      },
    };

    const result = await runVerification({
      runId: 'run-1',
      url: 'http://app.local/',
      plans: [plan],
      runDir: dir,
      driver,
      agent: fakeAgent(),
      scrub,
      scrubMethod: { file: null, sha256: null, terms: scrub.terms.length },
      adapters: [adapter],
    });

    expect(result.runId).toBe('run-1');
    expect(result.surface).toBe('web');
    expect(result.verdict).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]!.counts).toMatchObject({ assertions: 2, passed: 2, failed: 0 });
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]!.findings[0]!.id).toBe('f1');
    expect(adapterRan).toEqual(['web:http://app.local/']);
    expect(actions).toEqual(['click']);
    expect(closedCount()).toBe(1);
    const reportJson = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'));
    expect(reportJson.verdict).toBe('pass');
  });

  it('captures failing adapter cleanly without breaking run report generation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-orch-adapter-err-'));
    temps.push(dir);
    const plan = parsePlan({ format: 'miqyas-plan', version: 1, id: 'p1', steps: [{ id: 'a1', type: 'assertion', text: 'check', check: { locator: { role: 'heading' }, expect: 'visible' } }] }, 'p1');
    const { driver } = fakeDriver({ initialText: 'Saved' });
    const broken: Adapter = {
      id: 'broken-tool',
      kind: 'scanner',
      surfaces: ['web'],
      async run() {
        throw new Error('binary missing');
      },
    };

    const result = await runVerification({
      runId: 'run-err',
      url: 'http://app.local/',
      plans: [plan],
      runDir: dir,
      driver,
      agent: fakeAgent(),
      scrub: parseScrubRules({ terms: [] }),
      scrubMethod: { file: null, sha256: null, terms: 0 },
      adapters: [broken],
    });

    expect(result.verdict).toBe('pass');
    expect(result.adapters).toEqual([{ adapterId: 'broken-tool', status: 'error', error: 'binary missing', findings: [] }]);
  });

  it('coordinates dry-run mutation suite probes through Proof Core without Playwright or CLI', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-orch-mut-'));
    temps.push(dir);
    const buildDir = path.join(dir, 'build');
    const outDir = path.join(dir, 'out');
    await mkdir(buildDir, { recursive: true });
    await writeFile(path.join(buildDir, 'index.html'), '<head></head><body><h1>Dashboard</h1></body>', 'utf8');

    const plan = parsePlan({ format: 'miqyas-plan', version: 1, id: 'p1', steps: [{ id: 'a1', type: 'assertion', text: 'Title visible' }] }, 'p1');
    const preset = parsePreset({
      name: 'demo',
      mutations: [{ id: 'm1', title: 'hide h1', kind: 'css', css: 'h1{display:none}', plan: 'p1', assertion: 'a1', probe: { measure: 'height', selector: 'h1' } }],
    });
    const { driver } = fakeDriver({ probeReadings: (url) => (url.includes('clean') ? 32 : 0) });

    let serverSeq = 0;
    const result = await runMutations({
      runId: 'mut-1',
      buildDir,
      preset,
      plans: [plan],
      runDir: outDir,
      driver,
      serve: async (servedDir) => {
        const tag = servedDir === buildDir ? 'clean' : `mutant-${++serverSeq}`;
        return { url: `http://${tag}.local/`, async close() {} };
      },
      agent: null,
      scrub: parseScrubRules({ terms: [] }),
      scrubMethod: { file: null, sha256: null, terms: 0 },
    });

    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.results[0]!.outcome).toBe('not_run');
    expect(JSON.parse(await readFile(path.join(outDir, 'mutation-report.json'), 'utf8')).mode).toBe('mutate');
  });

  it('records unreachable start page / session failures into PlanResult and exits 3 in dry-run mode', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-orch-fail-'));
    temps.push(dir);
    const plan = parsePlan({ format: 'miqyas-plan', version: 1, id: 'dead', steps: [{ id: 'a1', type: 'assertion', text: 'check' }] }, 'dead');
    const seen: string[] = [];
    const unreachableDriver: SurfaceDriver = {
      surface: 'web',
      version: 'fake-1.0',
      async openSession() {
        return {
          async observe() {
            throw new Error('net::ERR_CONNECTION_REFUSED');
          },
          async act() {
            throw new Error('unreachable');
          },
          async check() {
            throw new Error('unreachable');
          },
          async wait() {
            throw new Error('unreachable');
          },
          async close() {},
        };
      },
      async close() {},
    };

    const result = await runVerification({
      runId: 'run-dead',
      url: 'http://127.0.0.1:9/',
      plans: [plan],
      runDir: dir,
      driver: unreachableDriver,
      agent: null,
      scrub: parseScrubRules({ terms: [] }),
      scrubMethod: { file: null, sha256: null, terms: 0 },
      onPlan: (r) => seen.push(`${r.planId}:${r.error}`),
    });

    expect(result.verdict).toBe('dry_run');
    expect(result.exitCode).toBe(3);
    expect(seen).toEqual(['dead:net::ERR_CONNECTION_REFUSED']);
  });

  it('executes code-judged assertions in --no-model mode at $0 without falling back to dry_run', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-orch-nomodel-'));
    temps.push(dir);
    const plan = parsePlan(
      {
        format: 'miqyas-plan',
        version: 1,
        id: 'code-only',
        steps: [{ id: 'a1', type: 'assertion', text: 'Heading visible', check: { locator: { role: 'heading', name: 'Saved' }, expect: 'visible' } }],
      },
      'code-only',
    );
    const { driver } = fakeDriver({ initialText: 'Saved' });
    const quote = quotePlans({ plans: [plan], model: null, noModel: true });

    const result = await runVerification({
      runId: 'run-nomodel',
      url: 'http://app.local/',
      plans: [plan],
      runDir: dir,
      driver,
      agent: null,
      noModel: true,
      quote,
      scrub: parseScrubRules({ terms: [] }),
      scrubMethod: { file: null, sha256: null, terms: 0 },
    });

    expect(result.dryRun).toBe(false);
    expect(result.verdict).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.report.spend).toMatchObject({ actualUsd: 0, quote: { likelyUsd: 0, worstCaseUsd: 0 } });
  });

  it('ends plan with budget cap error (exit 3) when SpendGuard trips inside agent and records quote beside actual cost', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-orch-cap-'));
    temps.push(dir);
    const plan = parsePlan(
      { format: 'miqyas-plan', version: 1, id: 'p1', steps: [{ id: 's1', type: 'action', text: 'Open' }, { id: 'a1', type: 'assertion', text: 'Visible' }] },
      'p1',
    );
    const { driver } = fakeDriver();
    const spendGuard = new SpendGuard({ runCapUsd: 1, spentTodayUsd: 0 });
    const quote = quotePlans({ plans: [plan], model: 'claude-haiku-5-5', spentTodayUsd: 0 });
    const budgetAgent: Agent = {
      info: { provider: 'anthropic', model: 'claude-haiku-5-5', tier: 'low' },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      async act() {
        throw new BudgetError('budget cap: exceeded $1.00 cap');
      },
      async judge() {
        throw new Error('should not be called');
      },
    };

    const result = await runVerification({
      runId: 'run-cap',
      url: 'http://app.local/',
      plans: [plan],
      runDir: dir,
      driver,
      agent: budgetAgent,
      spendGuard,
      quote,
      scrub: parseScrubRules({ terms: [] }),
      scrubMethod: { file: null, sha256: null, terms: 0 },
    });

    expect(result.verdict).toBe('error');
    expect(result.exitCode).toBe(3);
    expect(result.plans[0]!.error).toContain('budget cap');
    const saved = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'));
    expect(saved.spend).toMatchObject({ capUsd: 1, actualUsd: 0, quote: { likelyUsd: quote.likelyUsd, worstCaseUsd: quote.worstCaseUsd } });
  });
});
