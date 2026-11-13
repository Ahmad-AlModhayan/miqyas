// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Proof Core orchestrator: the single seam coordinating normalized plans, SurfaceSession boundaries, Adapters,
// and Agents into unified ledger verdicts, evidence artifacts, and RunResult / MutationRunResult outputs.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runAdapters, type Adapter, type AdapterResult } from '../adapters/adapter.js';
import type { ActTool, Agent, ModelInfo, StepHistory, ToolExecution, Usage } from '../agents/agent.js';
import { anyTerm, NO_SCRUB, ruleHits, scrubText, withSecrets, type ScrubRules } from '../scrub/scrub.js';
import type { Observation, SnapNode, SurfaceDriver, SurfaceSession } from '../surfaces/session.js';
import {
  ACTION_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
  NAV_TIMEOUT_MS,
  PLAN_TIMEOUT_MS,
  openWebSurfaceDriver,
} from '../surfaces/web/driver.js';
import { cropPng, toEvidenceNode } from '../surfaces/web/observe.js';
import { exitCodeFor, PlanLedger, settleJudgement, type ActionLog, type Evidence, type PlanResult } from './ledger.js';
import {
  applyMutation,
  classify,
  judgeProbe,
  keepUnchanged,
  MutationError,
  renderMutationMarkdown,
  summarize,
  type MutationPreset,
  type MutationResult,
  type MutationSummary,
} from './mutate.js';
import { resolveSecrets, secretNames, type Plan } from './plan.js';
import { buildReport, environment, renderMarkdown, renderMethod, SCREENSHOTS, TOOL_VERSION, type Method, type RunReport } from './report.js';

export interface RunSettings {
  concurrency?: number;
  headed?: boolean;
  allowOtherOrigins?: boolean;
  viewport?: { width: number; height: number };
  planTimeoutMs?: number;
  navTimeoutMs?: number;
}

export interface RunOptions extends RunSettings {
  url: string;
  /** Omit or pass null for a dry run: opens the page, takes one settled snapshot and ends. */
  agent?: Agent | null;
  runDir: string;
  scrub: ScrubRules;
  env?: NodeJS.ProcessEnv;
  onBrowser?: (version: string) => void;
  onPlan?: (result: PlanResult) => void;
}

export interface ExecutePlansOptions extends RunSettings {
  url: string;
  driver: SurfaceDriver;
  agent?: Agent | null;
  runDir: string;
  scrub: ScrubRules;
  env?: NodeJS.ProcessEnv;
  onPlan?: (result: PlanResult) => void;
}

export interface VerificationRunOptions {
  runId: string;
  url: string;
  plans: Plan[];
  runDir: string;
  driver: SurfaceDriver;
  agent: Agent | null;
  scrub: ScrubRules;
  scrubMethod: Method['scrub'];
  adapters?: Adapter[];
  settings?: RunSettings;
  env?: NodeJS.ProcessEnv;
  writeReports?: boolean;
  startedAt?: Date;
  onPlan?: (result: PlanResult) => void;
}

export interface RunResult {
  runId: string;
  surface: string;
  url: string;
  dryRun: boolean;
  verdict: RunReport['verdict'];
  exitCode: number;
  plans: PlanResult[];
  adapters: AdapterResult[];
  report: RunReport;
  durationMs: number;
}

export interface MutationServer {
  url: string;
  close(): Promise<void>;
}

export interface MutationRunOptions {
  runId: string;
  buildDir: string;
  preset: MutationPreset;
  plans: Plan[];
  runDir: string;
  driver: SurfaceDriver;
  serve: (dir: string) => Promise<MutationServer>;
  agent: Agent | null;
  scrub: ScrubRules;
  scrubMethod: Method['scrub'];
  adapters?: Adapter[];
  concurrency?: number;
  env?: NodeJS.ProcessEnv;
  writeReports?: boolean;
  onLog?: (line: string) => void;
}

export interface MutationRunResult {
  runId: string;
  dryRun: boolean;
  exitCode: number;
  summary: MutationSummary;
  results: MutationResult[];
  runs: Record<string, PlanResult[]>;
  adapters: AdapterResult[];
  method: Method;
  report: {
    tool: 'miqyas';
    mode: 'mutate';
    version: string;
    runId: string;
    dryRun: boolean;
    model: ModelInfo | null;
    usage: Usage | null;
    method: Method;
    screenshots: typeof SCREENSHOTS;
    summary: MutationSummary;
    runs: Record<string, PlanResult[]>;
  };
  markdown: string;
}

function rel(runDir: string, file: string): string {
  return path.relative(runDir, file).split(path.sep).join('/');
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

const DEFAULT_LIMITS = { maxTokens: 16000, maxTurns: 12 };

function pickRunSettings(s?: RunSettings): RunSettings {
  if (!s) return {};
  return {
    ...(s.concurrency !== undefined ? { concurrency: s.concurrency } : {}),
    ...(s.headed !== undefined ? { headed: s.headed } : {}),
    ...(s.allowOtherOrigins !== undefined ? { allowOtherOrigins: s.allowOtherOrigins } : {}),
    ...(s.viewport !== undefined ? { viewport: s.viewport } : {}),
    ...(s.planTimeoutMs !== undefined ? { planTimeoutMs: s.planTimeoutMs } : {}),
    ...(s.navTimeoutMs !== undefined ? { navTimeoutMs: s.navTimeoutMs } : {}),
  };
}

export function buildMethodMetadata(
  agent: Agent | null,
  driver: Pick<SurfaceDriver, 'version' | 'defaults'>,
  scrub: Method['scrub'],
  preset: string | null,
  settings: RunSettings = {},
): Method {
  const defaults = driver.defaults ?? {
    viewport: DEFAULT_VIEWPORT,
    planTimeoutMs: PLAN_TIMEOUT_MS,
    navTimeoutMs: NAV_TIMEOUT_MS,
    actionTimeoutMs: ACTION_TIMEOUT_MS,
  };
  return {
    ...environment(driver.version),
    model: agent?.info ? { ...agent.info, ...(agent.limits ?? DEFAULT_LIMITS) } : null,
    settings: {
      concurrency: settings.concurrency ?? 3,
      allowOtherOrigins: settings.allowOtherOrigins ?? false,
      headed: settings.headed ?? false,
      viewport: settings.viewport ?? defaults.viewport,
      timeouts: {
        planMs: settings.planTimeoutMs ?? defaults.planTimeoutMs,
        navigationMs: settings.navTimeoutMs ?? defaults.navTimeoutMs,
        actionMs: defaults.actionTimeoutMs,
      },
    },
    preset,
    scrub,
  };
}

/** Mask secret values in node names, states, and the URL; crop element boxes when resolved. */
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

async function runSinglePlan(driver: SurfaceDriver, plan: Plan, opts: ExecutePlansOptions): Promise<PlanResult> {
  const started = Date.now();
  const ledger = new PlanLedger(plan);
  const env = opts.env ?? process.env;
  // Secret values are scrubbed back to their placeholders before any text reaches the model.
  const names = plan.steps.flatMap((s) => secretNames(s.text));
  const rules = withSecrets(opts.scrub, names, env);
  const scrub = (t: string) => scrubText(t, rules);
  const rescan = (t: string) => ruleHits(t, rules);
  // Evidence, the ledger, and the reports stay on this machine, so only secret values are masked there.
  const secrets = withSecrets(NO_SCRUB, names, env);
  const hide = (t: string) => scrubText(t, secrets);
  const mask = anyTerm(secrets);

  let session: SurfaceSession | undefined;
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = async () => {
      session = await driver.openSession({
        url: opts.url,
        ...(opts.allowOtherOrigins !== undefined ? { allowOtherOrigins: opts.allowOtherOrigins } : {}),
        viewport: opts.viewport ?? DEFAULT_VIEWPORT,
        navTimeoutMs: opts.navTimeoutMs ?? NAV_TIMEOUT_MS,
        actionTimeoutMs: ACTION_TIMEOUT_MS,
        observe: mask ? { secrets: mask, hide } : { hide },
        hide,
      });
      let latest = await session.observe();
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
            const res = await session!.act(a, (raw) => {
              // Only the step's own secrets: masking and scrubbing cover those, not the rest of the environment.
              const named = [...new Set(secretNames(step.text))];
              const foreign = [...new Set(secretNames(raw))].filter((n) => !named.includes(n));
              const list = (ns: string[]) => ns.map((n) => `\${secret.${n}}`).join(', ');
              if (foreign.length) throw new Error(`${list(foreign)} ${foreign.length > 1 ? 'are' : 'is'} not named by this step; ${named.length ? `type only ${list(named)}` : 'it names no secret'}`);
              const text = resolveSecrets(raw, env);
              if (text === undefined) throw new Error('a secret in the text is not set');
              return text;
            });
            entry.ok = res.ok;
            if (res.locator) entry.locator = res.locator;
            if (res.error) entry.error = res.error;
            if (res.unmasked) entry.unmasked = res.unmasked;
            log.push(entry);
            latest = res.observation;
            if (a.tool !== 'wait' || !postAction) postAction = latest;
            return { ok: res.ok, message: res.message, observation: latest };
          };
          const outcome = await agent.act({ plan: planRef, step, history, observation: latest, scrub, rescan, signal: abort.signal, execute });
          ledger.recordAction({ stepId: step.id, status: outcome.status, summary: outcome.summary, actions: log, durationMs: Date.now() - t0 });
          history.push({ stepId: step.id, type: 'action', text: step.text, result: outcome.status === 'done' ? `done: ${outcome.summary}` : `FAILED: ${outcome.summary}` });
          if (outcome.status === 'failed') return;
          continue;
        }

        // Assertion: judged now, at its position, before the next action.
        const current = await session!.observe();
        latest = current;
        if (step.check) {
          const r = await session!.check(step.check, current);
          const evidence = await saveEvidence(opts.runDir, plan.id, step.id, current, r.nodes, hide);
          ledger.recordAssertion({ stepId: step.id, verdict: r.pass ? 'pass' : 'fail', method: 'code', observation: hide(r.observation), evidence, durationMs: Date.now() - t0 });
          history.push({ stepId: step.id, type: 'assertion', text: step.text, result: r.pass ? 'pass' : 'fail' });
          continue;
        }
        const captures = new Map<number, Observation>([[current.capture, current]]);
        if (postAction) captures.set(postAction.capture, postAction);
        const lookAgain = async (seconds: number) => {
          latest = await session!.wait(seconds);
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
    await session?.close().catch(() => {});
  }
  return ledger.close(Date.now() - started);
}

/** Run normalized plans against any SurfaceDriver + Agent with bounded concurrency. */
export async function executePlans(plans: Plan[], opts: ExecutePlansOptions): Promise<PlanResult[]> {
  await mkdir(opts.runDir, { recursive: true });
  const results: PlanResult[] = new Array(plans.length);
  let next = 0;
  const worker = async () => {
    while (next < plans.length) {
      const i = next++;
      const r = await runSinglePlan(opts.driver, plans[i]!, opts);
      results[i] = r;
      opts.onPlan?.(r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, plans.length)) }, worker));
  return results;
}

/** Central Proof Core orchestrator: coordinates plans, SurfaceSession driver, Adapters, and Agent into one RunResult. */
export async function runVerification(opts: VerificationRunOptions): Promise<RunResult> {
  const startedAt = opts.startedAt ?? new Date();
  const dryRun = opts.agent === null;
  await mkdir(opts.runDir, { recursive: true });

  const planResults = await executePlans(opts.plans, {
    url: opts.url,
    driver: opts.driver,
    agent: opts.agent,
    runDir: opts.runDir,
    scrub: opts.scrub,
    ...pickRunSettings(opts.settings),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.onPlan !== undefined ? { onPlan: opts.onPlan } : {}),
  });

  const adapterOutputs = opts.adapters?.length
    ? await runAdapters(opts.adapters, { surface: opts.driver.surface, url: opts.url, runDir: opts.runDir })
    : [];

  const finishedAt = new Date();
  const method = buildMethodMetadata(opts.agent, opts.driver, opts.scrubMethod, null, opts.settings);

  const report = buildReport({
    runId: opts.runId,
    startedAt,
    finishedAt,
    url: opts.url,
    dryRun,
    model: opts.agent?.info ?? null,
    usage: opts.agent?.usage ?? { calls: 0, inputTokens: 0, outputTokens: 0 },
    method,
    plans: planResults,
  });

  if (opts.writeReports !== false) {
    await writeFile(path.join(opts.runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    await writeFile(path.join(opts.runDir, 'report.md'), renderMarkdown(report), 'utf8');
  }

  let exitCode: number;
  if (report.verdict === 'dry_run') {
    const broken = planResults.filter((r) => !r.error?.startsWith('dry run'));
    exitCode = broken.length ? 3 : 0;
  } else {
    exitCode = exitCodeFor(report.verdict);
  }

  return {
    runId: opts.runId,
    surface: opts.driver.surface,
    url: opts.url,
    dryRun,
    verdict: report.verdict,
    exitCode,
    plans: planResults,
    adapters: adapterOutputs,
    report,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
}

/** Web-driver convenience wrapper: opens a Playwright SurfaceDriver, runs plans via Proof Core, and closes it. */
export async function runPlans(plans: Plan[], opts: RunOptions): Promise<PlanResult[]> {
  const driver = await openWebSurfaceDriver({
    ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
    ...(opts.allowOtherOrigins !== undefined ? { allowOtherOrigins: opts.allowOtherOrigins } : {}),
  });
  if (driver.version) opts.onBrowser?.(driver.version);
  try {
    return await executePlans(plans, {
      url: opts.url,
      driver,
      agent: opts.agent ?? null,
      runDir: opts.runDir,
      scrub: opts.scrub,
      ...pickRunSettings(opts),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.onPlan !== undefined ? { onPlan: opts.onPlan } : {}),
    });
  } finally {
    await driver.close();
  }
}

/** Proof Core mutation preset coordinator: proves mutation effectiveness before verifying detection through Proof Core. */
export async function runMutations(opts: MutationRunOptions): Promise<MutationRunResult> {
  await mkdir(opts.runDir, { recursive: true });
  const dryRun = opts.agent === null;
  const concurrency = opts.concurrency ?? 3;
  const byId = new Map(opts.plans.map((p) => [p.id, p]));
  const results: MutationResult[] = [];
  const runs: Record<string, PlanResult[]> = {};
  const say = opts.onLog ?? (() => {});

  // FR-M1: mutants are copies; the clean build must come out byte for byte the same.
  await keepUnchanged(opts.buildDir, async () => {
    const clean = await opts.serve(opts.buildDir);
    try {
      // Baseline: the targeted plans must pass on the clean build, or a failure on a mutant proves nothing.
      let baseline: PlanResult[] = [];
      if (opts.agent) {
        say(`  baseline on the clean build (${clean.url})`);
        baseline = await executePlans(opts.plans, {
          url: clean.url,
          driver: opts.driver,
          agent: opts.agent,
          runDir: path.join(opts.runDir, 'baseline'),
          scrub: opts.scrub,
          concurrency,
          ...(opts.env !== undefined ? { env: opts.env } : {}),
        });
        runs.baseline = baseline;
        for (const b of baseline) say(`    ${b.planId}: ${b.verdict}`);
      }
      for (const m of opts.preset.mutations) {
        const dir = path.join(opts.runDir, 'builds', m.id);
        await rm(dir, { recursive: true, force: true });
        let detail: string;
        try {
          detail = (await applyMutation(m, opts.buildDir, dir)).detail;
        } catch (e) {
          if (!(e instanceof MutationError)) throw e;
          results.push({ id: m.id, title: m.title, kind: m.kind, plan: m.plan, outcome: 'ineffective', detail: e.message, caughtBy: [] });
          say(`  ${m.id}: not applicable (${e.message})`);
          continue;
        }
        const served = await opts.serve(dir);
        try {
          // Effectiveness probe: the mutation must change what renders, and the clean build must not show it.
          let effective = false;
          try {
            if (!opts.driver.measureProbe) throw new Error(`surface "${opts.driver.surface}" does not support probes`);
            const j = judgeProbe(
              m,
              await opts.driver.measureProbe(clean.url, m.probe),
              await opts.driver.measureProbe(served.url, m.probe),
            );
            effective = j.effective;
            detail += `; ${j.detail}`;
          } catch (e) {
            detail += `; probe failed: ${(e as Error).message.split('\n')[0]}`;
          }
          if (!opts.agent) {
            results.push({
              id: m.id,
              title: m.title,
              kind: m.kind,
              plan: m.plan,
              ...(m.assertion ? { assertion: m.assertion } : {}),
              outcome: effective ? 'not_run' : 'ineffective',
              detail: `${detail}; dry run, not judged`,
              caughtBy: [],
            });
            say(`  ${m.id}: ${effective ? 'applied and effective' : 'NOT EFFECTIVE'} (${detail})`);
            continue;
          }
          const plan = byId.get(m.plan)!;
          const [mutated] = effective
            ? await executePlans([plan], {
                url: served.url,
                driver: opts.driver,
                agent: opts.agent,
                runDir: path.join(opts.runDir, m.id),
                scrub: opts.scrub,
                ...(opts.env !== undefined ? { env: opts.env } : {}),
              })
            : [undefined];
          if (mutated) runs[m.id] = [mutated];
          const r = classify(m, effective, baseline.find((b) => b.planId === m.plan), mutated, detail);
          results.push(r);
          say(`  ${m.id}: ${r.outcome}${r.caughtBy.length ? ` (failed: ${r.caughtBy.join(', ')})` : ''}`);
        } finally {
          await served.close();
        }
      }
    } finally {
      await clean.close();
    }
  });

  const adapterOutputs = opts.adapters?.length
    ? await runAdapters(opts.adapters, { surface: opts.driver.surface, url: opts.buildDir, runDir: opts.runDir, buildDir: opts.buildDir })
    : [];

  // The preset name is free text from the user: scrubbed like everything else that reaches a report.
  const presetName = scrubText(opts.preset.name, opts.scrub);
  const summary = summarize(presetName, results, opts.preset.baseline);
  const method = buildMethodMetadata(opts.agent, opts.driver, opts.scrubMethod, presetName, { concurrency, allowOtherOrigins: false, headed: false });
  const report = {
    tool: 'miqyas' as const,
    mode: 'mutate' as const,
    version: TOOL_VERSION,
    runId: opts.runId,
    dryRun,
    model: opts.agent?.info ?? null,
    usage: opts.agent?.usage ?? null,
    method,
    screenshots: SCREENSHOTS,
    summary,
    runs,
  };
  const markdown = [renderMutationMarkdown(summary, { runId: opts.runId, dryRun }), `Screenshots: ${SCREENSHOTS.note}`, '', ...renderMethod(method)].join('\n');
  if (opts.writeReports !== false) {
    await writeFile(path.join(opts.runDir, 'mutation-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    await writeFile(path.join(opts.runDir, 'mutation-report.md'), markdown, 'utf8');
  }
  const exitCode = dryRun
    ? results.some((r) => r.outcome === 'ineffective')
      ? 3
      : 0
    : summary.valid > 0 && summary.detected === summary.valid && !summary.excluded.error
      ? 0
      : 1;

  return { runId: opts.runId, dryRun, exitCode, summary, results, runs, adapters: adapterOutputs, method, report, markdown };
}
