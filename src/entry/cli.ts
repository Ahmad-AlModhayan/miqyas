// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// miqyas CLI entry point: handles only args, environment, prompts/output formatting, and exit codes.
// Verification, mutation suites, surface execution, and model calls are delegated to Proof Core / drivers / agents.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { buildApp, cloneState, exportTree, resolveCommit, SourceError } from '../adapters/bench-source.js';
import type { Agent, PayloadEntry } from '../agents/agent.js';
import { AnthropicAgent, DEFAULT_EFFORT, DEFAULT_MODEL } from '../agents/anthropic.js';
import { resolveEndpoint, resolveModelChoice, type Tier } from '../agents/models.js';
import {
  BudgetError,
  DAILY_CAP_USD,
  SpendGuard,
  defaultSpendDir,
  formatQuote,
  parseTypedCap,
  quotePlans,
  readDailySpend,
  type RunQuote,
} from '../agents/spend.js';
import { BENCHES, buildBenchSummary, renderBenchMarkdown, type BenchSummary } from '../proof-core/bench.js';
import { reportPath } from '../proof-core/ledger.js';
import { BuildChangedError, parsePreset } from '../proof-core/mutate.js';
import { runMutations, runVerification } from '../proof-core/orchestrator.js';
import { lintPlan, loadPlanFile, loadPlans, PlanError, resolvePlanFiles, serializePlan, type Plan } from '../proof-core/plan.js';
import { renderHuman, type Method, type RunReport } from '../proof-core/report.js';
import { NO_SCRUB, parseScrubRules, scrubDir, scrubText, type ScrubRules } from '../scrub/scrub.js';
import { openWebSurfaceDriver } from '../surfaces/web/driver.js';
import { serveDir } from '../surfaces/web/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** src/entry and dist/entry both sit two levels below the package root. */
const ROOT = path.resolve(HERE, '../..');
const PRESETS = path.join(ROOT, 'presets');

class UsageError extends Error {}
class EnvError extends Error {}

const HELP = `miqyas: AI testing that proves what it checked. PolyForm Shield 1.0.0.

Usage:
  miqyas run <plans...> --url <url> [options]      run plans (files or folders) against a web app
  miqyas mutate <plans...> --build <dir> --preset <name|file> [options]
                                                   break copies of a build on purpose, report the detection rate
  miqyas quote <plans...> [--tier <level>] [--model <id>] [--no-model] [--preset <name|file>]
                                                   print a free offline cost quote and stop
  miqyas lint <plans...>                           check plans offline
  miqyas import testsprite <plans...> --out <dir>  convert TestSprite plans, assigning stable step ids
  miqyas scrub <dir> --rules <name|file> [--check] replace configured terms in a built app, then re-scan
  miqyas bench <name> [--repo <clone>] [--commit <ref>] [--dry-run]
                                                   export, build, scrub, run and mutate a pinned app; write
                                                   bench/<date>-<commit>/summary.md and summary.json (benches: ${Object.keys(BENCHES).join(', ')})
  miqyas doctor                                    check Node, the browser, endpoint and whether a model key is set

Options:
  --json                 print the JSON report instead of the summary
  --out <dir>            run folder (default .miqyas/runs/<id>)
  --dry-run              resolve plans, open pages and probe mutations; no model call
  --no-model             run code-judged checks without calling a model ($0, works in CI)
  --tier <level>         low | medium | high (default low -> ${DEFAULT_MODEL})
  --model <id>           pin a specific model id (overrides --tier)
  --effort <level>       low | medium | high | xhigh | max (default ${DEFAULT_EFFORT})
  --concurrency <n>      plans in parallel (default 3)
  --scrub <name|file>    scrub rules applied to every text sent to the model
  --headed               show the browser
  --allow-other-origins  let the app load from other origins (blocked by default)

Live billed runs print a quote, require an interactive terminal cap <= $${DAILY_CAP_USD} daily cap, and need ANTHROPIC_API_KEY in your own environment. Secrets in plans are written \${secret.NAME} and read
from MIQYAS_SECRET_NAME.`;

const OPTIONS = {
  url: { type: 'string' },
  json: { type: 'boolean', default: false },
  out: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'no-model': { type: 'boolean', default: false },
  tier: { type: 'string' },
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

function hasCredentials(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Tests hand `main` a scripted agent, TTY state, prompt stub, spend directory, or clock. */
export interface Injected {
  agent?: Agent;
  isTTY?: boolean;
  promptCap?: (quote: RunQuote) => Promise<string>;
  spendDir?: string;
  now?: () => Date;
  spendGuard?: SpendGuard;
  quote?: RunQuote;
}

function resolveTierAndEffort(o: Opts): { tier?: Tier; model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } {
  let chosen: { tier?: Tier; model: string };
  try {
    chosen = resolveModelChoice({
      ...(o.tier !== undefined ? { tier: o.tier } : {}),
      ...(o.model !== undefined ? { model: o.model } : {}),
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const effort = (o.effort ?? DEFAULT_EFFORT) as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new UsageError(`--effort must be low, medium, high, xhigh or max`);
  return { ...chosen, effort };
}

async function promptTerminalCap(quote: RunQuote): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(`Type hard cap in USD (max $${quote.remainingDailyUsd.toFixed(2)} remaining today): `);
  } finally {
    rl.close();
  }
}

async function prepareExecution(opts: {
  o: Opts;
  plans: Plan[];
  runId: string;
  runDir: string;
  inject: Injected;
  preset?: { mutations: readonly { plan: string }[] };
}): Promise<{ agent: Agent | null; noModel: boolean; spendGuard?: SpendGuard; quote?: RunQuote }> {
  const { o, plans, runId: id, runDir, inject, preset } = opts;
  if (o['dry-run']) return { agent: null, noModel: false };
  if (o['no-model']) {
    const now = inject.now?.() ?? new Date();
    const spendDir = inject.spendDir ?? defaultSpendDir();
    const spentTodayUsd = await readDailySpend(spendDir, now);
    const quote = quotePlans({ plans, model: null, noModel: true, ...(preset ? { preset } : {}), spentTodayUsd, now });
    return { agent: null, noModel: true, quote };
  }
  if (inject.agent) {
    return {
      agent: inject.agent,
      noModel: false,
      ...(inject.spendGuard ? { spendGuard: inject.spendGuard } : {}),
      ...(inject.quote ? { quote: inject.quote } : {}),
    };
  }

  const chosen = resolveTierAndEffort(o);
  if (!hasCredentials())
    throw new EnvError('ANTHROPIC_API_KEY is not set. Set it in your own environment (Miqyas never asks for it), or use --dry-run / --no-model.');

  const spendGuard = await confirmLiveSpend({ o, plans, preset, runId: id, inject, chosenModel: chosen.model });
  let quote = inject.quote;
  if (!quote) {
    const now = inject.now?.() ?? new Date();
    const spendDir = inject.spendDir ?? defaultSpendDir();
    const spentTodayUsd = await readDailySpend(spendDir, now);
    quote = quotePlans({ plans, model: chosen.model, ...(preset ? { preset } : {}), spentTodayUsd, now });
  }

  const payloads = path.join(runDir, 'payloads.jsonl');
  const agent = new AnthropicAgent({
    ...(chosen.tier ? { tier: chosen.tier } : {}),
    model: chosen.model,
    effort: chosen.effort,
    spend: spendGuard,
    log: (e: PayloadEntry) => appendFileSync(payloads, JSON.stringify(e) + '\n', 'utf8'),
  });
  return { agent, noModel: false, spendGuard, ...(quote ? { quote } : {}) };
}

async function confirmLiveSpend(opts: {
  o: Opts;
  plans: Plan[];
  preset?: { mutations: readonly { plan: string }[] } | undefined;
  runId: string;
  inject: Injected;
  chosenModel: string;
}): Promise<SpendGuard> {
  if (opts.inject.spendGuard) return opts.inject.spendGuard;
  const now = opts.inject.now?.() ?? new Date();
  const spendDir = opts.inject.spendDir ?? defaultSpendDir();
  const spentTodayUsd = await readDailySpend(spendDir, now);
  const quote = quotePlans({
    plans: opts.plans,
    model: opts.chosenModel,
    ...(opts.preset ? { preset: opts.preset } : {}),
    spentTodayUsd,
    now,
  });
  process.stderr.write(formatQuote(quote) + '\n');
  if (!quote.knownPrice) {
    throw new EnvError(`unknown price for model "${opts.chosenModel}": billed cloud API runs fail closed without maintained pricing`);
  }
  if (quote.remainingDailyUsd <= 0) {
    throw new EnvError(`$${DAILY_CAP_USD.toFixed(2)} daily cap reached on this device; try again tomorrow or use --no-model`);
  }
  const interactive = Boolean(opts.inject.promptCap) || (opts.inject.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (!interactive) {
    throw new EnvError('billed live model runs require an interactive terminal; non-TTY CI allows --no-model or --dry-run');
  }
  const answer = opts.inject.promptCap ? await opts.inject.promptCap(quote) : await promptTerminalCap(quote);
  const runCapUsd = parseTypedCap(answer, quote.remainingDailyUsd);
  opts.inject.quote = quote;
  return new SpendGuard({ runCapUsd, dailyCapUsd: DAILY_CAP_USD, spentTodayUsd, spendDir, runId: opts.runId, now });
}

function dryRunStatus(error?: string, verdict?: string): string {
  return error?.startsWith('dry run') ? 'resolved' : `not reached: ${error ?? verdict}`;
}

function concurrency(o: Opts): number {
  const n = Number(o.concurrency ?? 3);
  if (!Number.isInteger(n) || n < 1) throw new UsageError('--concurrency must be a positive integer');
  return n;
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
  const settings = { concurrency: concurrency(o), allowOtherOrigins: o['allow-other-origins'], headed: o.headed };
  // Credentials, pricing, quote, and cap confirmation run first so a refused start leaves no empty folder.
  const exec = await prepareExecution({ o, plans, runId: id, runDir, inject });
  const { rules: scrub, method: scrubMethod } = await scrubRules(o, 'scrub');
  const modeLabel = o['dry-run'] ? ' (dry run)' : exec.noModel ? ' (--no-model)' : ` with ${exec.agent?.info?.model}`;
  if (!o.json) process.stderr.write(`miqyas: ${plans.length} plan(s) against ${o.url}${modeLabel}; run folder ${runDir}\n`);

  const driver = await openWebSurfaceDriver({ headed: settings.headed, allowOtherOrigins: settings.allowOtherOrigins });
  try {
    const result = await runVerification({
      runId: id,
      url: o.url,
      plans,
      runDir,
      driver,
      agent: exec.agent,
      noModel: exec.noModel,
      ...(exec.spendGuard ? { spendGuard: exec.spendGuard } : {}),
      ...(exec.quote ? { quote: exec.quote } : {}),
      scrub,
      scrubMethod,
      settings,
      onPlan: (r) => !o.json && process.stderr.write(`  ${r.planId}: ${o['dry-run'] ? dryRunStatus(r.error, r.verdict) : r.verdict} (${(r.durationMs / 1000).toFixed(1)} s)\n`),
    });
    process.stdout.write(o.json ? JSON.stringify(result.report, null, 2) + '\n' : renderHuman(result.report) + `\nReport: ${path.join(runDir, 'report.md')}\n`);
    return result.exitCode;
  } finally {
    await driver.close();
  }
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
  const preset = parsePreset(JSON.parse(await readFile(presetPath(o.preset), 'utf8')), o.preset);
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
  const exec = await prepareExecution({ o, plans, runId: id, runDir, inject, preset });
  const { rules: scrub, method: scrubMethod } = await scrubRules(o, 'scrub');
  const say = (s: string) => !o.json && process.stderr.write(s + '\n');
  say(`miqyas mutate: preset ${preset.name}, ${preset.mutations.length} mutation(s), ${plans.length} plan(s); run folder ${runDir}`);

  const driver = await openWebSurfaceDriver();
  try {
    const res = await runMutations({
      runId: id,
      buildDir: o.build,
      preset,
      plans,
      runDir,
      driver,
      serve: serveDir,
      agent: exec.agent,
      noModel: exec.noModel,
      ...(exec.spendGuard ? { spendGuard: exec.spendGuard } : {}),
      ...(exec.quote ? { quote: exec.quote } : {}),
      scrub,
      scrubMethod,
      concurrency: runConcurrency,
      onLog: say,
    });
    process.stdout.write(o.json ? JSON.stringify(res.report, null, 2) + '\n' : res.markdown + `\nReport: ${path.join(runDir, 'mutation-report.md')}\n`);
    return res.exitCode;
  } finally {
    await driver.close();
  }
}

async function cmdBench(args: string[], o: Opts, inject: Injected): Promise<number> {
  const bench = BENCHES[args[0] ?? ''];
  if (!bench || args.length > 1) throw new UsageError(`usage: miqyas bench <${Object.keys(BENCHES).join('|')}> [--repo <clone>] [--commit <ref>] [--dry-run]`);
  for (const k of ['url', 'build', 'preset', 'scrub', 'out'] as const) if (o[k]) throw new UsageError(`bench sets --${k} itself`);
  const chosen = resolveTierAndEffort(o);
  // Stop before a long build when a live run can't start anyway.
  if (!o['dry-run'] && !o['no-model'] && !inject.agent && !hasCredentials())
    throw new EnvError('ANTHROPIC_API_KEY is not set. Set it in your own environment (Miqyas never asks for it), or use --dry-run / --no-model.');
  const repo = path.resolve(o.repo ?? bench.repo);
  if (!existsSync(path.join(repo, '.git'))) throw new UsageError(`${repo} is not a git clone; pass --repo <clone>`);
  const say = (s: string) => process.stderr.write(s + '\n');
  const startedAt = new Date();
  const plans = path.join(ROOT, bench.plans);
  let benchInject = inject;
  if (!o['dry-run'] && !o['no-model'] && !inject.agent && !inject.spendGuard) {
    const benchPlans = await loadPlans([plans]);
    const preset = parsePreset(JSON.parse(await readFile(presetPath(bench.preset), 'utf8')), bench.preset);
    const carrier: Injected = { ...inject };
    const spendGuard = await confirmLiveSpend({ o, plans: benchPlans, preset, runId: `bench-${bench.name}`, inject: carrier, chosenModel: chosen.model });
    benchInject = { ...carrier, spendGuard };
  }
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

  const runDir = path.join(work, 'run');
  const mutateDir = path.join(work, 'mutate');
  const shared = { ...o, scrub: bench.scrub, json: false };
  const runCode = await timed('run', async () => {
    const served = await serveDir(dist);
    try {
      return await cmdRun([plans], { ...shared, url: served.url, out: runDir }, benchInject);
    } finally {
      await served.close();
    }
  });
  const mutateCode = await timed('mutate', () => cmdMutate([plans], { ...shared, build: dist, preset: bench.preset, out: mutateDir }, benchInject));
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

async function cmdQuote(args: string[], o: Opts, inject: Injected): Promise<number> {
  if (!args.length) throw new UsageError('usage: miqyas quote <plans...> [--tier <level>] [--model <id>] [--no-model] [--preset <name|file>]');
  const plans = await loadPlans(args);
  checkLint(plans);
  const preset = o.preset ? parsePreset(JSON.parse(await readFile(presetPath(o.preset), 'utf8')), o.preset) : undefined;
  const chosen = o['no-model'] ? null : resolveTierAndEffort(o);
  const now = inject.now?.() ?? new Date();
  const spendDir = inject.spendDir ?? defaultSpendDir();
  const spentTodayUsd = await readDailySpend(spendDir, now);
  const quote = quotePlans({
    plans,
    model: chosen?.model ?? null,
    noModel: o['no-model'],
    ...(preset ? { preset } : {}),
    spentTodayUsd,
    now,
  });
  process.stdout.write(o.json ? JSON.stringify(quote, null, 2) + '\n' : formatQuote(quote) + '\n');
  return 0;
}

async function cmdDoctor(): Promise<number> {
  const major = Number(process.versions.node.split('.')[0]);
  process.stdout.write(`node ${process.versions.node}: ${major >= 20 ? 'ok' : 'needs 20+'}\n`);
  let browserOk = false;
  try {
    const driver = await openWebSurfaceDriver();
    process.stdout.write(`chromium ${driver.version}: ok\n`);
    await driver.close();
    browserOk = true;
  } catch (e) {
    process.stdout.write(`chromium: missing (${(e as Error).message.split('\n')[0]}); run: npx playwright install chromium\n`);
  }
  const ep = resolveEndpoint();
  process.stdout.write(`model key: ${hasCredentials() ? 'set in the environment' : 'not set (live runs stop; --dry-run, --no-model, quote, lint and tests work)'}\n`);
  process.stdout.write(`model endpoint: ${ep.endpoint}${ep.custom ? ` (custom host ${ep.host})` : ''}\n`);
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
      case 'quote':
        return await cmdQuote(args, o, inject);
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
  if (e instanceof EnvError || e instanceof BudgetError || e instanceof BuildChangedError || e instanceof SourceError) {
    process.stderr.write(`miqyas: ${e.message}\n`);
    return 3;
  }
  process.stderr.write(`miqyas: ${(e as Error).stack ?? String(e)}\n`);
  return 3;
}

export function loadCliEnv(): void {
  // A git-ignored .env in the working directory may hold the key and plan secrets, nothing else: a stray
  // ANTHROPIC_BASE_URL or proxy setting there could redirect the payloads. Variables already set in the shell win.
  if (existsSync('.env')) {
    for (const [k, v] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) {
      if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|MIQYAS_SECRET_\w+)$/.test(k) && process.env[k] === undefined) process.env[k] = v;
    }
  }
}

export async function runCliProcess(argv = process.argv.slice(2)): Promise<never> {
  loadCliEnv();
  const code = await main(argv);
  process.exit(code);
}
