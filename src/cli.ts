#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// miqyas CLI. Exit codes: 0 pass, 1 fail, 2 plan or usage error, 3 blocked or environment.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { BENCHES, buildBenchSummary, renderBenchMarkdown, type BenchSummary } from './core/bench.js';
import { exitCodeFor, reportPath, type PlanResult } from './core/ledger.js';
import { applyMutation, BuildChangedError, classify, judgeProbe, keepUnchanged, MutationError, parsePreset, renderMutationMarkdown, summarize, type MutationPreset, type MutationResult } from './core/mutate.js';
import { lintPlan, loadPlanFile, loadPlans, PlanError, resolvePlanFiles, serializePlan, type Plan } from './core/plan.js';
import { buildReport, environment, renderHuman, renderMarkdown, renderMethod, SCREENSHOTS, TOOL_VERSION, type Method, type RunReport } from './core/report.js';
import { NO_SCRUB, parseScrubRules, scrubDir, scrubText, type ScrubRules } from './core/scrub.js';
import type { Agent, PayloadEntry } from './model/agent.js';
import { AnthropicAgent, DEFAULT_EFFORT, DEFAULT_MAX_ACT_TURNS, DEFAULT_MODEL, MAX_TOKENS } from './model/anthropic.js';
import { ACTION_TIMEOUT_MS, DEFAULT_VIEWPORT, launch, measureProbe, NAV_TIMEOUT_MS, PLAN_TIMEOUT_MS, runPlans } from './web/runner.js';
import { serveDir } from './web/server.js';
import { buildApp, cloneState, exportTree, resolveCommit, SourceError } from './bench/source.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PRESETS = path.join(ROOT, 'presets');

class UsageError extends Error {}
class EnvError extends Error {}

const HELP = `miqyas: AI testing that proves what it checked. PolyForm Shield 1.0.0.

Usage:
  miqyas run <plans...> --url <url> [options]      run plans (files or folders) against a web app
  miqyas mutate <plans...> --build <dir> --preset <name|file> [options]
                                                   break copies of a build on purpose, report the detection rate
  miqyas lint <plans...>                           check plans offline
  miqyas import testsprite <plans...> --out <dir>  convert TestSprite plans, assigning stable step ids
  miqyas scrub <dir> --rules <name|file> [--check] replace configured terms in a built app, then re-scan
  miqyas bench <name> [--repo <clone>] [--commit <ref>] [--dry-run]
                                                   export, build, scrub, run and mutate a pinned app; write
                                                   bench/<date>-<commit>/summary.md and summary.json (benches: ${Object.keys(BENCHES).join(', ')})
  miqyas doctor                                    check Node, the browser and whether a model key is set

Options:
  --json                 print the JSON report instead of the summary
  --out <dir>            run folder (default .miqyas/runs/<id>)
  --dry-run              resolve plans, open pages and probe mutations; no model call
  --model <id>           model (default ${DEFAULT_MODEL})
  --effort <level>       low | medium | high | xhigh | max (default ${DEFAULT_EFFORT})
  --concurrency <n>      plans in parallel (default 3)
  --scrub <name|file>    scrub rules applied to every text sent to the model
  --headed               show the browser
  --allow-other-origins  let the app load from other origins (blocked by default)

Live runs need ANTHROPIC_API_KEY in your own environment. Secrets in plans are written \${secret.NAME} and read
from MIQYAS_SECRET_NAME.`;

const OPTIONS = {
  url: { type: 'string' },
  json: { type: 'boolean', default: false },
  out: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  model: { type: 'string' },
  effort: { type: 'string' },
  concurrency: { type: 'string' },
  scrub: { type: 'string' },
  rules: { type: 'string' },
  check: { type: 'boolean', default: false },
  headed: { type: 'boolean', default: false },
  'allow-other-origins': { type: 'boolean', default: false },
  build: { type: 'string' },
  preset: { type: 'string' },
  repo: { type: 'string' },
  commit: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

type Opts = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A preset name (presets/<name>.json) or a path. */
function presetPath(nameOrFile: string): string {
  return /[\\/]|\.json$/.test(nameOrFile) ? nameOrFile : path.join(PRESETS, `${nameOrFile}.json`);
}

/** The rules, and what the method block records of them: file name (itself scrubbed), SHA-256 and term count, never the terms. */
async function scrubRules(o: Opts, key: 'scrub' | 'rules'): Promise<{ rules: ScrubRules; method: Method['scrub'] }> {
  const v = o[key];
  if (!v) return { rules: NO_SCRUB, method: { file: null, sha256: null, terms: 0 } };
  const file = presetPath(v);
  const bytes = await readFile(file);
  const rules = parseScrubRules(JSON.parse(bytes.toString('utf8')), file);
  return { rules, method: { file: scrubText(path.basename(file), rules), sha256: createHash('sha256').update(bytes).digest('hex'), terms: rules.terms.length } };
}

function methodOf(agent: Agent | null, browser: string | null, scrub: Method['scrub'], preset: string | null, run: { concurrency: number; allowOtherOrigins: boolean; headed: boolean }): Method {
  return {
    ...environment(browser),
    model: agent?.info ? { ...agent.info, maxTokens: MAX_TOKENS, maxTurns: DEFAULT_MAX_ACT_TURNS } : null,
    settings: { ...run, viewport: DEFAULT_VIEWPORT, timeouts: { planMs: PLAN_TIMEOUT_MS, navigationMs: NAV_TIMEOUT_MS, actionMs: ACTION_TIMEOUT_MS } },
    preset,
    scrub,
  };
}

function hasCredentials(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Tests hand `main` a scripted agent; the CLI itself always builds the Anthropic one. */
export interface Injected {
  agent?: Agent;
}

function makeAgent(o: Opts, runDir: string, inject: Injected): Agent | null {
  if (o['dry-run']) return null;
  if (inject.agent) return inject.agent;
  if (!hasCredentials())
    throw new EnvError('ANTHROPIC_API_KEY is not set. Set it in your own environment (Miqyas never asks for it), or use --dry-run.');
  const effort = (o.effort ?? DEFAULT_EFFORT) as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new UsageError(`--effort must be low, medium, high, xhigh or max`);
  const payloads = path.join(runDir, 'payloads.jsonl');
  return new AnthropicAgent({
    model: o.model ?? DEFAULT_MODEL,
    effort,
    log: (e: PayloadEntry) => appendFileSync(payloads, JSON.stringify(e) + '\n', 'utf8'),
  });
}

/** A dry run resolves a plan only when its start page loaded; otherwise say what stopped it. */
function dryRunStatus(r: PlanResult): string {
  return r.error?.startsWith('dry run') ? 'resolved' : `not reached: ${r.error ?? r.verdict}`;
}

function concurrency(o: Opts): number {
  const n = Number(o.concurrency ?? 3);
  if (!Number.isInteger(n) || n < 1) throw new UsageError('--concurrency must be a positive integer');
  return n;
}

async function writeReport(runDir: string, report: RunReport): Promise<void> {
  await writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  await writeFile(path.join(runDir, 'report.md'), renderMarkdown(report), 'utf8');
}

function checkLint(plans: Plan[]): void {
  const errors = plans.flatMap((p) => lintPlan(p).filter((i) => i.level === 'error').map((i) => `${p.source.file ?? p.id}: ${i.message}`));
  if (errors.length) throw new PlanError(errors.join('\n'));
}

async function cmdRun(args: string[], o: Opts, inject: Injected): Promise<number> {
  if (!o.url) throw new UsageError('run needs --url');
  try {
    new URL(o.url);
  } catch {
    throw new UsageError(`--url "${o.url}" is not a URL`);
  }
  const plans = await loadPlans(args);
  checkLint(plans);
  const id = runId();
  const runDir = path.resolve(o.out ?? path.join('.miqyas', 'runs', id));
  // The key is checked first, so a run that can't start leaves no empty folder.
  const agent = makeAgent(o, runDir, inject);
  await mkdir(runDir, { recursive: true });
  const { rules: scrub, method: scrubMethod } = await scrubRules(o, 'scrub');
  const settings = { concurrency: concurrency(o), allowOtherOrigins: o['allow-other-origins'], headed: o.headed };
  let browser: string | null = null;
  const startedAt = new Date();
  if (!o.json) process.stderr.write(`miqyas: ${plans.length} plan(s) against ${o.url}${agent ? ` with ${agent.info?.model}` : ' (dry run)'}; run folder ${runDir}\n`);
  const results = await runPlans(plans, {
    url: o.url,
    agent,
    runDir,
    scrub,
    ...settings,
    onBrowser: (v) => (browser = v),
    onPlan: (r) => !o.json && process.stderr.write(`  ${r.planId}: ${o['dry-run'] ? dryRunStatus(r) : r.verdict} (${(r.durationMs / 1000).toFixed(1)} s)\n`),
  });
  const report = buildReport({
    runId: id,
    startedAt,
    finishedAt: new Date(),
    url: o.url,
    dryRun: o['dry-run'],
    model: agent?.info ?? null,
    usage: agent?.usage ?? { calls: 0, inputTokens: 0, outputTokens: 0 },
    method: methodOf(agent, browser, scrubMethod, null, settings),
    plans: results,
  });
  await writeReport(runDir, report);
  if (report.verdict === 'dry_run') {
    const broken = results.filter((r) => !r.error?.startsWith('dry run'));
    process.stdout.write(o.json ? JSON.stringify(report, null, 2) + '\n' : renderHuman(report) + `\nReport: ${path.join(runDir, 'report.md')}\n`);
    return broken.length ? 3 : 0;
  }
  process.stdout.write(o.json ? JSON.stringify(report, null, 2) + '\n' : renderHuman(report) + `\nReport: ${path.join(runDir, 'report.md')}\n`);
  return exitCodeFor(report.verdict);
}

async function cmdLint(args: string[]): Promise<number> {
  const files = await resolvePlanFiles(args);
  let errors = 0;
  for (const f of files) {
    try {
      const plan = await loadPlanFile(f);
      const issues = lintPlan(plan);
      const n = plan.steps.filter((s) => s.type === 'assertion').length;
      process.stdout.write(`${issues.some((i) => i.level === 'error') ? 'ERROR' : 'ok   '} ${f}  (${plan.steps.length} steps, ${n} assertions)\n`);
      for (const i of issues) process.stdout.write(`      ${i.level}: ${i.message}\n`);
      errors += issues.filter((i) => i.level === 'error').length;
    } catch (e) {
      errors++;
      process.stdout.write(`ERROR ${(e as Error).message}\n`);
    }
  }
  return errors ? 2 : 0;
}

async function cmdImport(args: string[], o: Opts): Promise<number> {
  const [kind, ...rest] = args;
  if (kind !== 'testsprite') throw new UsageError('usage: miqyas import testsprite <plans...> --out <dir>');
  if (!o.out) throw new UsageError('import needs --out <dir>');
  const plans = await loadPlans(rest);
  await mkdir(o.out, { recursive: true });
  let assertions = 0;
  for (const p of plans) {
    if (p.source.kind !== 'testsprite') throw new PlanError('not a TestSprite plan', p.source.file);
    const file = path.join(o.out, `${p.id}.json`);
    await writeFile(file, serializePlan(p), 'utf8');
    const n = p.steps.filter((s) => s.type === 'assertion').length;
    assertions += n;
    process.stdout.write(`${file}  (${p.steps.length} steps, ${n} assertions)\n`);
  }
  process.stdout.write(`Imported ${plans.length} plan(s), ${assertions} assertions. Step ids are now stored; edit plans freely.\n`);
  return 0;
}

async function cmdScrub(args: string[], o: Opts): Promise<number> {
  const [dir] = args;
  if (!dir || !o.rules) throw new UsageError('usage: miqyas scrub <dir> --rules <name|file> [--check]');
  const { rules } = await scrubRules(o, 'rules');
  const r = await scrubDir(dir, rules, o.check);
  if (!o.check) process.stdout.write(`Replaced ${r.replaced} occurrence(s) in ${r.filesChanged.length} file(s).\n`);
  for (const h of r.remaining) process.stdout.write(`  ${o.check ? 'found' : 'STILL PRESENT'}: "${h.term}" ×${h.count} in ${h.file}\n`);
  process.stdout.write(r.remaining.length ? `Re-scan: ${r.remaining.length} hit(s).\n` : `Re-scan: 0 hits for ${rules.terms.length} term(s).\n`);
  return r.remaining.length ? 1 : 0;
}

async function cmdMutate(args: string[], o: Opts, inject: Injected): Promise<number> {
  if (!o.build || !o.preset) throw new UsageError('usage: miqyas mutate <plans...> --build <dir> --preset <name|file>');
  const preset: MutationPreset = parsePreset(JSON.parse(await readFile(presetPath(o.preset), 'utf8')), o.preset);
  const all = await loadPlans(args);
  checkLint(all);
  const byId = new Map(all.map((p) => [p.id, p]));
  for (const m of preset.mutations) {
    const plan = byId.get(m.plan);
    if (!plan) throw new UsageError(`mutation ${m.id} targets plan "${m.plan}", which is not among the plans given`);
    if (m.assertion && !plan.steps.some((s) => s.id === m.assertion && s.type === 'assertion'))
      throw new UsageError(`mutation ${m.id} targets assertion "${m.assertion}", which plan "${m.plan}" doesn't have`);
  }
  const plans = [...new Set(preset.mutations.map((m) => m.plan))].map((id) => byId.get(id)!);
  const runConcurrency = concurrency(o);
  const id = runId();
  const runDir = path.resolve(o.out ?? path.join('.miqyas', 'runs', `${id}-mutate`));
  const agent = makeAgent(o, runDir, inject);
  await mkdir(runDir, { recursive: true });
  const { rules: scrub, method: scrubMethod } = await scrubRules(o, 'scrub');
  const say = (s: string) => !o.json && process.stderr.write(s + '\n');
  say(`miqyas mutate: preset ${preset.name}, ${preset.mutations.length} mutation(s), ${plans.length} plan(s); run folder ${runDir}`);

  let browserVersion: string | null = null;
  const results: MutationResult[] = [];
  const runs: Record<string, PlanResult[]> = {};
  // FR-M1: mutants are copies; the clean build must come out byte for byte the same.
  const build = o.build;
  await keepUnchanged(build, async () => {
    const clean = await serveDir(build);
    const browser = await launch(false);
    browserVersion = browser.version();
    try {
      // Baseline: the targeted plans must pass on the clean build, or a failure on a mutant proves nothing.
      let baseline: PlanResult[] = [];
      if (agent) {
        say(`  baseline on the clean build (${clean.url})`);
        baseline = await runPlans(plans, { url: clean.url, agent, runDir: path.join(runDir, 'baseline'), scrub, concurrency: runConcurrency });
        runs.baseline = baseline;
        for (const b of baseline) say(`    ${b.planId}: ${b.verdict}`);
      }
      for (const m of preset.mutations) {
        const dir = path.join(runDir, 'builds', m.id);
        await rm(dir, { recursive: true, force: true });
        let detail: string;
        try {
          detail = (await applyMutation(m, build, dir)).detail;
        } catch (e) {
          if (!(e instanceof MutationError)) throw e;
          results.push({ id: m.id, title: m.title, kind: m.kind, plan: m.plan, outcome: 'ineffective', detail: e.message, caughtBy: [] });
          say(`  ${m.id}: not applicable (${e.message})`);
          continue;
        }
        const served = await serveDir(dir);
        try {
          // Effectiveness probe: the mutation must change what renders, and the clean build must not show it.
          let effective = false;
          try {
            const j = judgeProbe(m, await measureProbe(browser, clean.url, m.probe), await measureProbe(browser, served.url, m.probe));
            effective = j.effective;
            detail += `; ${j.detail}`;
          } catch (e) {
            detail += `; probe failed: ${(e as Error).message.split('\n')[0]}`;
          }
          if (!agent) {
            results.push({ id: m.id, title: m.title, kind: m.kind, plan: m.plan, ...(m.assertion ? { assertion: m.assertion } : {}), outcome: effective ? 'not_run' : 'ineffective', detail: `${detail}; dry run, not judged`, caughtBy: [] });
            say(`  ${m.id}: ${effective ? 'applied and effective' : 'NOT EFFECTIVE'} (${detail})`);
            continue;
          }
          const plan = byId.get(m.plan)!;
          const [mutated] = effective ? await runPlans([plan], { url: served.url, agent, runDir: path.join(runDir, m.id), scrub }) : [undefined];
          if (mutated) runs[m.id] = [mutated];
          const r = classify(m, effective, baseline.find((b) => b.planId === m.plan), mutated, detail);
          results.push(r);
          say(`  ${m.id}: ${r.outcome}${r.caughtBy.length ? ` (failed: ${r.caughtBy.join(', ')})` : ''}`);
        } finally {
          await served.close();
        }
      }
    } finally {
      await browser.close();
      await clean.close();
    }
  });
  // The preset name is free text from the user: scrubbed like everything else that reaches a report.
  const presetName = scrubText(preset.name, scrub);
  const summary = summarize(presetName, results, preset.baseline);
  const method = methodOf(agent, browserVersion, scrubMethod, presetName, { concurrency: runConcurrency, allowOtherOrigins: false, headed: false });
  const report = { tool: 'miqyas', mode: 'mutate', version: TOOL_VERSION, runId: id, dryRun: o['dry-run'], model: agent?.info ?? null, usage: agent?.usage ?? null, method, screenshots: SCREENSHOTS, summary, runs };
  await writeFile(path.join(runDir, 'mutation-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  const md = [renderMutationMarkdown(summary, { runId: id, dryRun: o['dry-run'] }), `Screenshots: ${SCREENSHOTS.note}`, '', ...renderMethod(method)].join('\n');
  await writeFile(path.join(runDir, 'mutation-report.md'), md, 'utf8');
  process.stdout.write(o.json ? JSON.stringify(report, null, 2) + '\n' : md + `\nReport: ${path.join(runDir, 'mutation-report.md')}\n`);
  if (o['dry-run']) return results.some((r) => r.outcome === 'ineffective') ? 3 : 0;
  // A run error is out of the rate (Stryker) but still fails the gate: a mutant that couldn't be judged isn't caught.
  return summary.valid > 0 && summary.detected === summary.valid && !summary.excluded.error ? 0 : 1;
}

async function cmdBench(args: string[], o: Opts, inject: Injected): Promise<number> {
  const bench = BENCHES[args[0] ?? ''];
  if (!bench || args.length > 1) throw new UsageError(`usage: miqyas bench <${Object.keys(BENCHES).join('|')}> [--repo <clone>] [--commit <ref>] [--dry-run]`);
  for (const k of ['url', 'build', 'preset', 'scrub', 'out'] as const) if (o[k]) throw new UsageError(`bench sets --${k} itself`);
  // Stop before a long build when a live run can't start anyway.
  if (!o['dry-run'] && !inject.agent && !hasCredentials())
    throw new EnvError('ANTHROPIC_API_KEY is not set. Set it in your own environment (Miqyas never asks for it), or use --dry-run.');
  const repo = path.resolve(o.repo ?? bench.repo);
  if (!existsSync(path.join(repo, '.git'))) throw new UsageError(`${repo} is not a git clone; pass --repo <clone>`);
  const say = (s: string) => process.stderr.write(s + '\n');
  const startedAt = new Date();
  const before = await cloneState(repo);
  const commit = await resolveCommit(repo, o.commit ?? bench.commit);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const id = `${startedAt.getFullYear()}-${p2(startedAt.getMonth() + 1)}-${p2(startedAt.getDate())}-${commit.slice(0, 7)}${o['dry-run'] ? '-dry-run' : ''}`;
  const work = path.resolve('.miqyas', 'bench', id);
  const outDir = path.resolve('bench', id);
  // Both folders sit in the working directory, so it must lie outside the clone: real paths (symlinks resolved), and
  // case folded on macOS, whose disks ignore case (path.relative already does on Windows).
  const real = (p: string) => (process.platform === 'darwin' ? realpathSync.native(p).toLowerCase() : realpathSync.native(p));
  const rel = path.relative(real(repo), real(process.cwd()));
  if (!rel || !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))) throw new UsageError(`run the bench from outside ${repo}: it writes ${work} and ${outDir}, and never writes inside the clone`);
  await rm(work, { recursive: true, force: true });
  const phasesMs = { export: 0, build: 0, scrub: 0, run: 0, mutate: 0 };
  const timed = async <T>(phase: keyof typeof phasesMs, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      phasesMs[phase] = Date.now() - t;
    }
  };
  say(`miqyas bench ${bench.name}: ${bench.subdir}/ at ${commit}${o['dry-run'] ? ' (dry run)' : ''}; work folder ${work}`);

  const src = path.join(work, 'src');
  await timed('export', () => exportTree(repo, commit, bench.subdir, src));
  say(`  exported ${bench.subdir}/ (read only)`);
  const appDir = path.join(src, bench.subdir);
  // Only the build is needed from here on: keep it, and remove the unscrubbed source and node_modules, also on failure.
  const dist = path.join(work, bench.build.outDir);
  try {
    const built = await timed('build', () => buildApp(appDir, bench.build, say));
    // Windows may hold fresh files for a moment (Defender, the indexer); copying is the fallback.
    await rename(built, dist).catch(() => cp(built, dist, { recursive: true }));
  } finally {
    await rm(src, { recursive: true, force: true, maxRetries: 5 });
  }
  say(`  built ${bench.build.outDir}`);

  const scrubbed = await timed('scrub', async () => {
    const { rules } = await scrubRules({ ...o, rules: bench.scrub }, 'rules');
    const r = await scrubDir(dist, rules);
    const rescan = await scrubDir(dist, rules, true);
    const left = r.remaining.length + rescan.remaining.length;
    if (left) throw new EnvError(`scrub left ${left} hit(s) in ${dist}; stopping before anything is served or sent`);
    return { replaced: r.replaced, files: r.filesChanged.length, remaining: 0 };
  });
  say(`  scrubbed: ${scrubbed.replaced} replacement(s) in ${scrubbed.files} file(s); re-scan 0 hits`);

  const plans = path.join(ROOT, bench.plans);
  const runDir = path.join(work, 'run');
  const mutateDir = path.join(work, 'mutate');
  const shared = { ...o, scrub: bench.scrub, json: false };
  const runCode = await timed('run', async () => {
    const served = await serveDir(dist);
    try {
      return await cmdRun([plans], { ...shared, url: served.url, out: runDir }, inject);
    } finally {
      await served.close();
    }
  });
  const mutateCode = await timed('mutate', () => cmdMutate([plans], { ...shared, build: dist, preset: bench.preset, out: mutateDir }, inject));
  const run = JSON.parse(await readFile(path.join(runDir, 'report.json'), 'utf8')) as RunReport;
  const mutation = JSON.parse(await readFile(path.join(mutateDir, 'mutation-report.json'), 'utf8'));
  const unchanged = (await cloneState(repo)) === before;

  const summary: BenchSummary = buildBenchSummary({
    bench,
    dryRun: o['dry-run'],
    startedAt,
    finishedAt: new Date(),
    phasesMs,
    commit,
    unchanged,
    scrub: scrubbed,
    run,
    mutation: { summary: mutation.summary, usage: mutation.usage },
    runs: { run: reportPath(runDir), mutate: reportPath(mutateDir) },
  });
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  const md = renderBenchMarkdown(summary);
  await writeFile(path.join(outDir, 'summary.md'), md, 'utf8');
  process.stdout.write(`\n${md}\nSummary: ${path.join(outDir, 'summary.md')}\n`);
  if (!unchanged) {
    process.stderr.write(`miqyas: the clone at ${repo} changed during the run (HEAD or git status); check it\n`);
    return 3;
  }
  return Math.max(runCode, mutateCode);
}

async function cmdDoctor(): Promise<number> {
  const major = Number(process.versions.node.split('.')[0]);
  process.stdout.write(`node ${process.versions.node}: ${major >= 20 ? 'ok' : 'needs 20+'}\n`);
  let browserOk = false;
  try {
    const b = await launch(false);
    process.stdout.write(`chromium ${b.version()}: ok\n`);
    await b.close();
    browserOk = true;
  } catch (e) {
    process.stdout.write(`chromium: missing (${(e as Error).message.split('\n')[0]}); run: npx playwright install chromium\n`);
  }
  process.stdout.write(`model key: ${hasCredentials() ? 'set in the environment' : 'not set (live runs stop; --dry-run, lint, mutate --dry-run and tests work)'}\n`);
  return major >= 20 && browserOk ? 0 : 3;
}

export async function main(argv: string[], inject: Injected = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}\n`);
    return 2;
  }
  const [cmd, ...args] = parsed.positionals;
  const o = parsed.values;
  if (!cmd || o.help) {
    process.stdout.write(HELP + '\n');
    return cmd ? 0 : 2;
  }
  try {
    switch (cmd) {
      case 'run':
        return await cmdRun(args, o, inject);
      case 'mutate':
        return await cmdMutate(args, o, inject);
      case 'lint':
        return await cmdLint(args);
      case 'import':
        return await cmdImport(args, o);
      case 'scrub':
        return await cmdScrub(args, o);
      case 'bench':
        return await cmdBench(args, o, inject);
      case 'doctor':
        return await cmdDoctor();
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    return errorExit(e);
  }
}

/** Print a command's error and return its exit code: 2 for usage and plan errors, 3 for the environment and the rest. */
export function errorExit(e: unknown): number {
  if (e instanceof UsageError || e instanceof PlanError) {
    process.stderr.write(`miqyas: ${e.message}\n`);
    return 2;
  }
  if (e instanceof EnvError || e instanceof BuildChangedError || e instanceof SourceError) {
    process.stderr.write(`miqyas: ${e.message}\n`);
    return 3;
  }
  process.stderr.write(`miqyas: ${(e as Error).stack ?? String(e)}\n`);
  return 3;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // A git-ignored .env in the working directory may hold the key and plan secrets, nothing else: a stray
  // ANTHROPIC_BASE_URL or proxy setting there could redirect the payloads. Variables already set in the shell win.
  if (existsSync('.env')) {
    for (const [k, v] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) {
      if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|MIQYAS_SECRET_\w+)$/.test(k) && process.env[k] === undefined) process.env[k] = v;
    }
  }
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
