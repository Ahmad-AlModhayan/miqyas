// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// miqyas CLI entry point: handles only args, environment, prompts/output formatting, and exit codes.
// Verification, mutation suites, surface execution, and model calls are delegated to Proof Core / drivers / agents.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { buildApp, cloneState, exportTree, resolveCommit, SourceError } from '../adapters/bench-source.js';
import { probeGitleaksVersion } from '../adapters/gitleaks.js';
import {
  defaultOsvCacheDir,
  hasPopulatedOsvCache,
  OsvValidationError,
  probeOsvScannerVersion,
  updateOsvDatabase,
} from '../adapters/osv.js';
import { AgentError, type Agent, type PayloadEntry } from '../agents/agent.js';
import { DEFAULT_MODEL } from '../agents/anthropic.js';
import { RecordingAgent, ReplayAgent } from '../agents/cassette.js';
import { DEFAULT_EFFORT, validateEffort, validateProviderName, validateTier } from '../agents/models.js';
import {
  createRoutedAgent,
  resolveRoute,
  RouteEnvError,
  RouteUsageError,
  type ResolvedRoute,
} from '../agents/router.js';
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
import { CorpusError, lintCorpus, loadCorpusFromPath, resolveContainedCorpusPath, seedToMutation, verifyCorpusProbes, type CorpusManifest, type CorpusSeed } from '../proof-core/corpus.js';
import { parseFailOn, type FailOnThreshold, type Finding } from '../proof-core/findings.js';
import { reportPath, type PlanResult } from '../proof-core/ledger.js';
import { applyMutation, BuildChangedError, classify, parsePreset, summarize, type Mutation, type MutationPreset, type MutationResult } from '../proof-core/mutate.js';
import { executePlans, runMutations, runVerification } from '../proof-core/orchestrator.js';
import { lintPlan, loadPlanFile, loadPlans, PlanError, resolvePlanFiles, serializePlan, type Plan } from '../proof-core/plan.js';
import { parseReadinessProfile, type ReadinessProfile } from '../proof-core/readiness.js';
import { renderHuman, type Method, type RunReport } from '../proof-core/report.js';
import {
  appendBenchHistory,
  detectBenchRegressions,
  loadBenchHistory,
  matchesKnownFinding,
  scoreCorpus,
  seedMatchesFinding,
  toHistoryEntry,
  type BenchRegression,
} from '../proof-core/scoring.js';
import { NO_SCRUB, parseScrubRules, scrubDir, scrubText, type ScrubRules } from '../scrub/scrub.js';
import { openWebSurfaceDriver } from '../surfaces/web/driver.js';
import { DEFAULT_CRAWL_DEPTH, DEFAULT_CRAWL_MAX_SCREENS, DEFAULT_CRAWL_RPS } from '../surfaces/web/crawler.js';
import { HostPolicyError, verifyHostOwnership, type HostOwnershipOptions } from '../surfaces/web/policy.js';
import { serveDir } from '../surfaces/web/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** src/entry and dist/entry both sit two levels below the package root. */
const ROOT = path.resolve(HERE, '../..');
const PRESETS = path.join(ROOT, 'presets');

class UsageError extends Error {}
class EnvError extends Error {}

const HELP = `miqyas: AI testing that proves what it checked. PolyForm Shield 1.0.0.

Usage:
  miqyas run [plans...] --url <url> [options]      run plans, --crawl, or --profile grade-1 against a web app
  miqyas mutate <plans...> --build <dir> --preset <name|file> [options]
                                                   break copies of a build on purpose, report the detection rate
  miqyas quote <plans...> [--tier <level>] [--model <id>] [--no-model] [--preset <name|file>]
                                                   print a free offline cost quote and stop
  miqyas lint <plans...> [--corpus <dir|seeds.json>]
                                                   check plans and/or corpus offline
  miqyas import testsprite <plans...> --out <dir>  convert TestSprite plans, assigning stable step ids
  miqyas scrub <dir> --rules <name|file> [--check] replace configured terms in a built app, then re-scan
  miqyas bench <name> [--repo <clone>] [--commit <ref>] [--dry-run]
  miqyas bench --corpus <dir|seeds.json> [--out <dir>] [--history <file>] [--no-model|--dry-run]
                                                   run benchmark suite, score parts & track regressions in history.jsonl (benches: ${Object.keys(BENCHES).join(', ')})
  miqyas update-db [--ecosystems npm,PyPI] [--db-dir <dir>]
                                                   explicitly download offline OSV vulnerability databases (prints & logs endpoints)
  miqyas doctor                                    check Node, the browser, endpoint and whether a model key is set

Options:
  --json                 print the JSON report instead of the summary
  --out <dir>            run folder (default .miqyas/runs/<id>)
  --dry-run              resolve plans, open pages and probe mutations; no model call
  --no-model             run code-judged checks without calling a model ($0, works in CI)
  --provider <name>      anthropic (default) | openai (OpenAI-compatible vLLM / Ollama)
  --endpoint <url>       custom model base URL (overrides ANTHROPIC_BASE_URL / OPENAI_BASE_URL)
  --tier <level>         low | medium | high (default low -> ${DEFAULT_MODEL})
  --model <id>           pin a specific model id (overrides --tier; required for openai)
  --effort <level>       low | medium | high | xhigh | max (default ${DEFAULT_EFFORT})
  --record <file>        record model interactions to cassette.jsonl
  --replay <file>        replay recorded cassette.jsonl offline (zero network, works in CI)
  --concurrency <n>      plans in parallel (default 3)
  --scrub <name|file>    scrub rules applied to every text sent to the model
  --headed               show the browser
  --allow-other-origins  let the app load from other origins (blocked by default)
  --crawl                explore same-origin reachable views safely (read-only, skips forms/destructive controls)
  --max-screens <n>      maximum crawled screens (default ${DEFAULT_CRAWL_MAX_SCREENS})
  --max-depth <n>        maximum crawl link depth (default ${DEFAULT_CRAWL_DEPTH})
  --max-rps <n>          maximum crawl request rate (default ${DEFAULT_CRAWL_RPS} req/s)
  --active               enable active probes (test hosts only, unless --allow-host + verified token)
  --allow-host <host>    explicitly targeted non-test host requiring ownership token verification
  --allow-writes         allow write/mutation active probes (requires --active and host authorization)
  --host-token <token>   expected ownership token when verifying /.well-known/miqyas.txt or DNS _miqyas.<host>
  --strict               require cite/quoted-text match on every AI pass (reject model-only passes)
  --fail-on <severity>   fail run on confirmed findings >= severity (none | info | low | medium | high | critical; default none)
  --corpus <path>        seeded corpus directory or seeds.json manifest (for lint / bench)
  --history <file>       regression history JSONL file (default bench/history.jsonl)
  --profile <name>       readiness profile to evaluate (grade-1)
  --repo <path>          repository path for readiness code/secret/migration/dependency checks (Checks 6, 7, 13)
  --ecosystems <list>    comma-separated OSV ecosystems for update-db (default npm,PyPI)
  --db-dir <dir>         override local OSV cache directory for update-db

Live billed runs print a quote, require an interactive terminal cap <= $${DAILY_CAP_USD} daily cap, and need a provider key in your environment. Unbilled local/private OpenAI-compatible endpoints work non-interactively. Secrets in plans are written \${secret.NAME} and read
from MIQYAS_SECRET_NAME.`;

const OPTIONS = {
  url: { type: 'string' },
  json: { type: 'boolean', default: false },
  out: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'no-model': { type: 'boolean', default: false },
  provider: { type: 'string' },
  endpoint: { type: 'string' },
  tier: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  record: { type: 'string' },
  replay: { type: 'string' },
  concurrency: { type: 'string' },
  scrub: { type: 'string' },
  rules: { type: 'string' },
  check: { type: 'boolean', default: false },
  headed: { type: 'boolean', default: false },
  'allow-other-origins': { type: 'boolean', default: false },
  crawl: { type: 'boolean', default: false },
  'max-screens': { type: 'string' },
  'max-depth': { type: 'string' },
  'max-rps': { type: 'string' },
  active: { type: 'boolean', default: false },
  'allow-writes': { type: 'boolean', default: false },
  'allow-host': { type: 'string' },
  'host-token': { type: 'string' },
  strict: { type: 'boolean', default: false },
  'fail-on': { type: 'string' },
  build: { type: 'string' },
  preset: { type: 'string' },
  repo: { type: 'string' },
  commit: { type: 'string' },
  corpus: { type: 'string' },
  history: { type: 'string' },
  profile: { type: 'string' },
  ecosystems: { type: 'string' },
  'db-dir': { type: 'string' },
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

/** Tests hand `main` a scripted agent, TTY state, prompt stub, spend directory, or clock. */
export interface Injected {
  agent?: Agent;
  isTTY?: boolean;
  promptCap?: (quote: RunQuote) => Promise<string>;
  spendDir?: string;
  now?: () => Date;
  spendGuard?: SpendGuard;
  quote?: RunQuote;
  hostPolicyDeps?: Pick<HostOwnershipOptions, 'spendDir' | 'fetchImpl' | 'resolveTxtImpl'>;
  osvFetch?: typeof fetch;
  osvBaseUrl?: string;
}

function resolveCliRoute(o: Opts, requireReady: boolean): ResolvedRoute {
  return resolveRoute({
    ...(o.provider !== undefined ? { provider: o.provider } : {}),
    ...(o.endpoint !== undefined ? { endpoint: o.endpoint } : {}),
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(o.tier !== undefined ? { tier: o.tier } : {}),
    ...(o.effort !== undefined ? { effort: o.effort } : {}),
    requireReady,
  });
}

async function promptTerminalCap(quote: RunQuote): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(`Type hard cap in USD (max $${quote.remainingDailyUsd.toFixed(2)} remaining today): `);
  } finally {
    rl.close();
  }
}

function validateCassetteFlags(o: Opts): void {
  if (o.record !== undefined && !o.record.trim()) throw new UsageError('--record requires a cassette file path');
  if (o.replay !== undefined && !o.replay.trim()) throw new UsageError('--replay requires a cassette file path');
  if (o.record && o.replay) throw new UsageError('--record and --replay cannot be combined');
  if (o.replay && o.endpoint) throw new UsageError('--endpoint cannot be combined with --replay');
  if (o.replay && (o['dry-run'] || o['no-model'])) throw new UsageError('--replay cannot be combined with --dry-run or --no-model');
  if (o.record && (o['dry-run'] || o['no-model'])) throw new UsageError('--record cannot be combined with --dry-run or --no-model');
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
  validateCassetteFlags(o);
  if (o['dry-run']) return { agent: null, noModel: false };
  if (o['no-model']) {
    const now = inject.now?.() ?? new Date();
    const spendDir = inject.spendDir ?? defaultSpendDir();
    const spentTodayUsd = await readDailySpend(spendDir, now);
    const quote = quotePlans({ plans, model: null, noModel: true, ...(preset ? { preset } : {}), spentTodayUsd, now });
    return { agent: null, noModel: true, quote };
  }
  if (o.replay) {
    let validTier;
    let validProvider;
    let validEffort;
    try {
      validTier = validateTier(o.tier);
      validProvider = validateProviderName(o.provider);
      validEffort = o.effort !== undefined ? validateEffort(o.effort.trim()) : undefined;
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const agent = await ReplayAgent.fromFile(o.replay, {
      ...(validTier ? { tier: validTier } : {}),
      ...(o.model ? { model: o.model } : {}),
      ...(validProvider ? { provider: validProvider } : {}),
      ...(validEffort ? { effort: validEffort } : {}),
    });
    return { agent, noModel: false };
  }
  const wrapRecord = (base: Agent): Agent => (o.record ? new RecordingAgent(base, { cassettePath: o.record }) : base);
  if (inject.agent) {
    return {
      agent: wrapRecord(inject.agent),
      noModel: false,
      ...(inject.spendGuard ? { spendGuard: inject.spendGuard } : {}),
      ...(inject.quote ? { quote: inject.quote } : {}),
    };
  }

  const route = resolveCliRoute(o, true);
  let spendGuard = inject.spendGuard;
  let quote = inject.quote;
  if (route.billed) {
    spendGuard = await confirmLiveSpend({ o, plans, preset, runId: id, inject, chosenModel: route.model! });
    if (!quote) {
      const now = inject.now?.() ?? new Date();
      const spendDir = inject.spendDir ?? defaultSpendDir();
      const spentTodayUsd = await readDailySpend(spendDir, now);
      quote = quotePlans({ plans, model: route.model!, ...(preset ? { preset } : {}), spentTodayUsd, now });
    }
  }

  const payloads = path.join(runDir, 'payloads.jsonl');
  const baseAgent = createRoutedAgent({
    route,
    ...(spendGuard ? { spend: spendGuard } : {}),
    log: (e: PayloadEntry) => appendFileSync(payloads, JSON.stringify(e) + '\n', 'utf8'),
  });
  return { agent: wrapRecord(baseAgent), noModel: false, ...(spendGuard ? { spendGuard } : {}), ...(quote ? { quote } : {}) };
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

function failOnSetting(o: Opts): FailOnThreshold {
  try {
    return parseFailOn(o['fail-on']);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function positiveIntOption(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive integer`);
  return n;
}

function nonNegativeIntOption(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${flag} must be a non-negative integer`);
  return n;
}

function positiveNumberOption(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number`);
  return n;
}

function checkLint(plans: Plan[]): void {
  const errors = plans.flatMap((p) => lintPlan(p).filter((i) => i.level === 'error').map((i) => `${p.source.file ?? p.id}: ${i.message}`));
  if (errors.length) throw new PlanError(errors.join('\n'));
}

function profileSetting(o: Opts): ReadinessProfile | undefined {
  if (o.profile === undefined) return undefined;
  try {
    return parseReadinessProfile(o.profile);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function repoSetting(o: Opts): string | undefined {
  if (o.repo === undefined) return undefined;
  const trimmed = o.repo.trim();
  if (!trimmed) throw new UsageError('--repo requires a directory path');
  const resolved = path.resolve(trimmed);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new UsageError(`--repo directory does not exist: ${trimmed}`);
  }
  return resolved;
}

async function cmdRun(args: string[], o: Opts, inject: Injected): Promise<number> {
  if (!o.url) throw new UsageError('run needs --url');
  try {
    new URL(o.url);
  } catch {
    throw new UsageError(`--url "${o.url}" is not a URL`);
  }
  const profile = profileSetting(o);
  const repoPath = profile ? repoSetting(o) : undefined;
  const crawlEnabled = Boolean(o.crawl || profile === 'grade-1');
  if (o['allow-writes'] && !o.active) {
    throw new UsageError('--allow-writes requires --active');
  }
  if ((crawlEnabled || o.active) && o['allow-other-origins']) {
    throw new UsageError('--allow-other-origins cannot be used with --crawl, --profile grade-1, or --active');
  }
  const maxScreens = positiveIntOption(o['max-screens'], DEFAULT_CRAWL_MAX_SCREENS, '--max-screens');
  const maxDepth = nonNegativeIntOption(o['max-depth'], DEFAULT_CRAWL_DEPTH, '--max-depth');
  const maxRps = positiveNumberOption(o['max-rps'], DEFAULT_CRAWL_RPS, '--max-rps');
  if (o.active) {
    await verifyHostOwnership({
      url: o.url,
      ...(o['allow-host'] ? { allowHost: o['allow-host'] } : {}),
      active: true,
      allowWrites: o['allow-writes'],
      probeKind: o['allow-writes'] ? 'active-write' : 'active-read',
      ...(o['host-token'] ? { expectedToken: o['host-token'] } : {}),
      ...inject.hostPolicyDeps,
    });
  }
  const plans = crawlEnabled && args.length === 0 ? [] : await loadPlans(args);
  if (plans.length) checkLint(plans);
  const id = runId();
  const runDir = path.resolve(o.out ?? path.join('.miqyas', 'runs', id));
  const failOn = failOnSetting(o);
  const settings = {
    concurrency: concurrency(o),
    allowOtherOrigins: crawlEnabled || o.active ? false : o['allow-other-origins'],
    headed: o.headed,
    ...(o.strict ? { strict: true } : {}),
    ...(failOn !== 'none' ? { failOn } : {}),
    ...(profile ? { profile } : {}),
    ...(repoPath ? { repoProvided: true } : {}),
    ...(crawlEnabled ? { crawl: true, maxScreens, maxDepth, maxRps } : {}),
    ...(o.active ? { active: true } : {}),
    ...(o['allow-writes'] ? { allowWrites: true } : {}),
    ...(o['allow-host'] ? { allowHost: o['allow-host'] } : {}),
    ...(o['host-token'] ? { hostToken: o['host-token'] } : {}),
  };
  // Credentials, pricing, quote, and cap confirmation run first so a refused start leaves no empty folder.
  const exec = await prepareExecution({ o, plans, runId: id, runDir, inject });
  const { rules: scrub, method: scrubMethod } = await scrubRules(o, 'scrub');
  const modeLabel = o['dry-run']
    ? ' (dry run)'
    : exec.noModel
      ? ' (--no-model)'
      : o.replay
        ? ` (replay ${path.basename(o.replay)})`
        : ` with ${exec.agent?.info?.model}${exec.agent?.info?.endpointHost && exec.agent.info.provider !== 'anthropic' ? ` (${exec.agent.info.provider} @ ${exec.agent.info.endpointHost})` : ''}`;
  const scopeLabel = profile ? ` + profile ${profile}` : crawlEnabled ? ' + crawl' : '';
  if (exec.noModel && exec.quote && !o.json) process.stderr.write(formatQuote(exec.quote) + '\n');
  if (!o.json) process.stderr.write(`miqyas: ${plans.length} plan(s)${scopeLabel} against ${o.url}${modeLabel}; run folder ${runDir}\n`);

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
      ...(repoPath ? { repoPath } : {}),
      ...(inject.hostPolicyDeps ? { hostPolicyDeps: inject.hostPolicyDeps } : {}),
      onPlan: (r) => !o.json && process.stderr.write(`  ${r.planId}: ${o['dry-run'] ? dryRunStatus(r.error, r.verdict) : r.verdict} (${(r.durationMs / 1000).toFixed(1)} s)\n`),
    });
    process.stdout.write(o.json ? JSON.stringify(result.report, null, 2) + '\n' : renderHuman(result.report) + `\nReport: ${path.join(runDir, 'report.md')}\n`);
    return result.exitCode;
  } finally {
    await driver.close();
  }
}

async function resolveCorpusPlansArg(baseDir: string, explicitArgs: string[]): Promise<string[]> {
  if (explicitArgs.length) return explicitArgs;
  const defaultDir = path.join(baseDir, 'plans');
  if (!existsSync(defaultDir)) return [];
  try {
    return await resolvePlanFiles([defaultDir]);
  } catch (e) {
    if (e instanceof PlanError && e.message.includes('no plan files')) return [];
    throw e;
  }
}

async function cmdLint(args: string[], o: Opts): Promise<number> {
  let errors = 0;
  let loadedCorpus: Awaited<ReturnType<typeof loadCorpusFromPath>> | null = null;
  let planInputs = args;

  if (o.corpus !== undefined) {
    if (!o.corpus.trim()) throw new UsageError('--corpus requires a directory or seeds.json path');
    try {
      loadedCorpus = await loadCorpusFromPath(o.corpus);
      planInputs = await resolveCorpusPlansArg(loadedCorpus.baseDir, args);
    } catch (e) {
      if (e instanceof CorpusError || e instanceof PlanError) {
        process.stdout.write(`ERROR corpus: ${e.message}\n`);
        return 2;
      }
      throw e;
    }
  }

  const files = planInputs.length ? await resolvePlanFiles(planInputs) : loadedCorpus ? [] : await resolvePlanFiles(args);
  const loadedPlans: Plan[] = [];
  for (const f of files) {
    try {
      const plan = await loadPlanFile(f);
      loadedPlans.push(plan);
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
  if (loadedCorpus) {
    try {
      if (!existsSync(loadedCorpus.cleanBuildDir)) {
        throw new CorpusError(`clean twin buildDir not found: ${loadedCorpus.cleanBuildDir}`);
      }
      lintCorpus(loadedCorpus.manifest, loadedPlans, loadedCorpus.knownFindings);
      process.stdout.write(
        `ok    corpus ${loadedCorpus.manifest.target} (${loadedCorpus.manifest.seeds.length} seeds, ${loadedCorpus.knownFindings.entries.length} known findings)\n`,
      );
    } catch (e) {
      errors++;
      process.stdout.write(`ERROR corpus (${loadedCorpus.manifestPath}): ${(e as Error).message}\n`);
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
      ...(o.strict ? { strict: true } : {}),
      onLog: say,
    });
    process.stdout.write(o.json ? JSON.stringify(res.report, null, 2) + '\n' : res.markdown + `\nReport: ${path.join(runDir, 'mutation-report.md')}\n`);
    return res.exitCode;
  } finally {
    await driver.close();
  }
}

function buildAssertedPreset(manifest: CorpusManifest): MutationPreset {
  const mutations = manifest.seeds
    .filter((s) => s.part === 'asserted')
    .map((s) => seedToMutation(s))
    .filter((m): m is Mutation => m !== null);
  return { name: manifest.target, mutations };
}

async function runFixtureAssertedSeeds(opts: {
  seeds: CorpusSeed[];
  plans: Plan[];
  cleanResults: PlanResult[];
  allowedRoots: string[];
  runId: string;
  work: string;
  driver: Awaited<ReturnType<typeof openWebSurfaceDriver>>;
  exec: Awaited<ReturnType<typeof prepareExecution>>;
  scrub: ScrubRules;
  strict: boolean;
}): Promise<{ results: MutationResult[]; seedPlans: Record<string, PlanResult[]> }> {
  const results: MutationResult[] = [];
  const seedPlans: Record<string, PlanResult[]> = {};
  const byPlanId = new Map(opts.plans.map((p) => [p.id, p]));
  for (const seed of opts.seeds) {
    if (!seed.fixtureDir || seed.mutation) continue;
    const plan = seed.plan ? byPlanId.get(seed.plan) : undefined;
    if (!plan) continue;
    const seedDir = await resolveContainedCorpusPath(seed.fixtureDir, opts.allowedRoots, `seed "${seed.id}" fixtureDir`);
    const srv = await serveDir(seedDir);
    try {
      const [mutated] = await executePlans([plan], {
        url: srv.url,
        driver: opts.driver,
        agent: opts.exec.agent,
        ...(opts.exec.noModel ? { noModel: true } : {}),
        runDir: path.join(opts.work, 'fixture-asserted', seed.id),
        scrub: opts.scrub,
        ...(opts.strict ? { strict: true } : {}),
      });
      if (mutated) seedPlans[seed.id] = [mutated];
      const base = opts.cleanResults.find((p) => p.planId === plan.id);
      const spec: Mutation = {
        id: seed.id,
        title: seed.title,
        kind: 'css',
        css: '',
        plan: plan.id,
        ...(seed.assertion ? { assertion: seed.assertion } : {}),
        probe: seed.probe,
      };
      results.push(classify(spec, true, base, mutated, `fixture ${seed.fixtureDir}`));
    } finally {
      await srv.close();
    }
  }
  return { results, seedPlans };
}

async function runBlindCorpusSeeds(opts: {
  loaded: Awaited<ReturnType<typeof loadCorpusFromPath>>;
  allowedRoots: string[];
  id: string;
  work: string;
  driver: Awaited<ReturnType<typeof openWebSurfaceDriver>>;
  exec: Awaited<ReturnType<typeof prepareExecution>>;
  scrub: ScrubRules;
  scrubMethod: Method['scrub'];
  headed: boolean;
}): Promise<{ findingsBySeed: Map<string, Finding[]>; readinessRuns: { seedId: string; detected: boolean }[] }> {
  const findingsBySeed = new Map<string, Finding[]>();
  const readinessRuns: { seedId: string; detected: boolean }[] = [];
  const blindSeeds = opts.loaded.manifest.seeds.filter((s) => s.part === 'unasserted' || s.part === 'readiness');
  for (const seed of blindSeeds) {
    let targetDir: string;
    if (seed.fixtureDir) {
      targetDir = await resolveContainedCorpusPath(seed.fixtureDir, opts.allowedRoots, `seed "${seed.id}" fixtureDir`);
    } else {
      targetDir = path.join(opts.work, 'seeds', seed.id);
      await rm(targetDir, { recursive: true, force: true });
      const mut = seedToMutation(seed, 'corpus');
      if (mut) await applyMutation(mut, opts.loaded.cleanBuildDir, targetDir);
    }
    const srv = await serveDir(targetDir);
    try {
      const res = await runVerification({
        runId: `${opts.id}-${seed.id}`,
        url: srv.url,
        plans: [],
        runDir: path.join(opts.work, 'seed-runs', seed.id),
        driver: opts.driver,
        agent: opts.exec.agent,
        noModel: opts.exec.noModel,
        ...(opts.exec.spendGuard ? { spendGuard: opts.exec.spendGuard } : {}),
        ...(opts.exec.quote ? { quote: opts.exec.quote } : {}),
        scrub: opts.scrub,
        scrubMethod: opts.scrubMethod,
        settings: { concurrency: 1, allowOtherOrigins: false, headed: opts.headed, crawl: true },
      });
      const novel = (res.report.findings ?? []).filter(
        (f) => !matchesKnownFinding(f, opts.loaded.knownFindings) && seedMatchesFinding(seed, f),
      );
      if (seed.part === 'unasserted') findingsBySeed.set(seed.id, novel);
      else readinessRuns.push({ seedId: seed.id, detected: novel.length > 0 });
    } finally {
      await srv.close();
    }
  }
  return { findingsBySeed, readinessRuns };
}

async function runCorpusBench(args: string[], o: Opts, inject: Injected): Promise<number> {
  if (!o.corpus?.trim()) throw new UsageError('--corpus requires a directory or seeds.json path');
  if (o.history !== undefined && !o.history.trim()) throw new UsageError('--history requires a file path');
  for (const k of ['url', 'build', 'preset', 'record', 'replay', 'repo'] as const) {
    if (o[k]) throw new UsageError(`bench --corpus does not support --${k}`);
  }
  validateCassetteFlags(o);
  const loaded = await loadCorpusFromPath(o.corpus, process.cwd());
  if (!existsSync(loaded.cleanBuildDir)) throw new EnvError(`clean twin buildDir not found: ${loaded.cleanBuildDir}`);
  const planArgs = await resolveCorpusPlansArg(loaded.baseDir, args);
  const plans = planArgs.length ? await loadPlans(planArgs) : [];
  checkLint(plans);
  lintCorpus(loaded.manifest, plans, loaded.knownFindings);

  const preset = buildAssertedPreset(loaded.manifest);
  const id = runId();
  const startedAt = new Date();
  const work = path.resolve('.miqyas', 'bench', id);
  const outDir = path.resolve(o.out ?? path.join('bench', id));
  const historyPath = path.resolve(o.history ?? path.join('bench', 'history.jsonl'));
  const allowedRoots = [process.cwd(), loaded.baseDir];
  const say = (s: string) => process.stderr.write(s + '\n');
  const exec = await prepareExecution({ o, plans, runId: id, runDir: path.join(work, 'run'), inject, preset });
  const { rules: scrub, method: scrubMethod } = await scrubRules(o, 'scrub');

  const phasesMs = { export: 0, build: 0, scrub: 0, run: 0, mutate: 0 };
  const driver = await openWebSurfaceDriver({ headed: o.headed, allowOtherOrigins: false });
  try {
    const probes = await verifyCorpusProbes({
      manifest: loaded.manifest,
      cleanBuildDir: loaded.cleanBuildDir,
      baseRoot: process.cwd(),
      baseDir: loaded.baseDir,
      driver,
      serve: serveDir,
      workDir: path.join(work, 'probes'),
    });
    const failedProbes = probes.filter((p) => !p.effective);
    if (failedProbes.length) {
      throw new CorpusError(`corpus code probes failed for: ${failedProbes.map((p) => `${p.id} (${p.detail})`).join('; ')}`);
    }

    const tRun = Date.now();
    const cleanSrv = await serveDir(loaded.cleanBuildDir);
    let cleanReport: RunReport;
    try {
      const cleanRes = await runVerification({
        runId: `${id}-clean`,
        url: cleanSrv.url,
        plans,
        runDir: path.join(work, 'clean'),
        driver,
        agent: exec.agent,
        noModel: exec.noModel,
        ...(exec.spendGuard ? { spendGuard: exec.spendGuard } : {}),
        ...(exec.quote ? { quote: exec.quote } : {}),
        scrub,
        scrubMethod,
        settings: { concurrency: concurrency(o), allowOtherOrigins: false, headed: o.headed, crawl: !o['dry-run'] },
        ...(o.strict ? { strict: true } : {}),
      });
      cleanReport = cleanRes.report;
    } finally {
      await cleanSrv.close();
    }
    phasesMs.run = Date.now() - tRun;

    const tMut = Date.now();
    let assertedResults: MutationResult[] = [];
    let seedPlans: Record<string, PlanResult[]> = {};
    let mutSummary = summarize('corpus', []);
    let mutUsage = null;
    if (preset.mutations.length && plans.length) {
      const mutRes = await runMutations({
        runId: `${id}-mut`,
        buildDir: loaded.cleanBuildDir,
        preset,
        plans,
        runDir: path.join(work, 'mutate'),
        driver,
        serve: serveDir,
        agent: exec.agent,
        noModel: exec.noModel,
        ...(exec.spendGuard ? { spendGuard: exec.spendGuard } : {}),
        ...(exec.quote ? { quote: exec.quote } : {}),
        scrub,
        scrubMethod,
        concurrency: concurrency(o),
        ...(o.strict ? { strict: true } : {}),
        onLog: say,
      });
      assertedResults = mutRes.results;
      seedPlans = mutRes.runs;
      mutSummary = mutRes.report.summary;
      mutUsage = mutRes.report.usage;
    }

    const fixtureAsserted = !o['dry-run']
      ? await runFixtureAssertedSeeds({
          seeds: loaded.manifest.seeds.filter((s) => s.part === 'asserted' && s.fixtureDir && !s.mutation),
          plans,
          cleanResults: cleanReport.plans,
          allowedRoots,
          runId: id,
          work,
          driver,
          exec,
          scrub,
          strict: o.strict,
        })
      : { results: [], seedPlans: {} };
    assertedResults = [...assertedResults, ...fixtureAsserted.results];
    seedPlans = { ...seedPlans, ...fixtureAsserted.seedPlans };

    let score: ReturnType<typeof scoreCorpus> | undefined;
    let regressions: BenchRegression[] | undefined;
    if (!o['dry-run']) {
      const blind = await runBlindCorpusSeeds({ loaded, allowedRoots, id, work, driver, exec, scrub, scrubMethod, headed: o.headed });
      score = scoreCorpus({
        manifest: loaded.manifest,
        knownFindings: loaded.knownFindings,
        asserted: { results: assertedResults, seedPlans },
        unasserted: { findingsBySeed: blind.findingsBySeed },
        readiness: { runs: blind.readinessRuns },
        cleanTwin: {
          findings: cleanReport.findings ?? [],
          planFalseFailures: cleanReport.plans.filter((p) => p.verdict === 'fail').length,
        },
      });
      const commit = o.commit ?? loaded.knownFindings.buildId;
      const prevHistory = await loadBenchHistory(historyPath);
      const baseline =
        [...prevHistory].reverse().find((e) => e.bench === loaded.manifest.target && !e.dryRun) ??
        [...prevHistory].reverse().find((e) => e.bench === loaded.manifest.target);
      const draftEntry = toHistoryEntry({ bench: loaded.manifest.target, commit, dryRun: false, score });
      regressions = baseline ? detectBenchRegressions(draftEntry, baseline) : [];
      await appendBenchHistory(historyPath, toHistoryEntry({ bench: loaded.manifest.target, commit, dryRun: false, score, regressions }));
    }
    phasesMs.mutate = Date.now() - tMut;

    const commit = o.commit ?? loaded.knownFindings.buildId;
    const relOut = path.relative(process.cwd(), outDir) || '.';
    const summary = buildBenchSummary({
      bench: {
        name: loaded.manifest.target,
        title: loaded.manifest.target,
        repo: '.',
        subdir: loaded.manifest.cleanTwin.buildDir,
        commit,
        commitNote: `corpus baseline ${loaded.knownFindings.buildId}`,
        plans: path.relative(process.cwd(), path.join(loaded.baseDir, 'plans')) || '.',
        preset: 'corpus',
        scrub: 'none',
        build: { install: [], vite: [], env: {}, outDir: loaded.manifest.cleanTwin.buildDir },
      },
      dryRun: o['dry-run'],
      startedAt,
      finishedAt: new Date(),
      phasesMs,
      commit,
      unchanged: true,
      scrub: { replaced: 0, files: 0, remaining: 0 },
      run: cleanReport,
      mutation: { summary: mutSummary, usage: mutUsage },
      runs: { run: path.join(relOut, 'summary.json'), mutate: path.join(relOut, 'summary.json') },
      ...(score ? { corpus: score } : {}),
      ...(regressions ? { regressions } : {}),
    });
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    const md = renderBenchMarkdown(summary);
    await writeFile(path.join(outDir, 'summary.md'), md, 'utf8');
    process.stdout.write(
      o.json
        ? JSON.stringify(summary, null, 2) + '\n'
        : `\n${md}\nSummary: ${path.join(outDir, 'summary.md')}${o['dry-run'] ? '' : `\nHistory: ${historyPath}`}\n`,
    );
    return 0;
  } finally {
    await driver.close();
    await rm(work, { recursive: true, force: true });
  }
}

async function cmdBench(args: string[], o: Opts, inject: Injected): Promise<number> {
  if (o.corpus) return await runCorpusBench(args, o, inject);
  const bench = BENCHES[args[0] ?? ''];
  if (!bench || args.length > 1) throw new UsageError(`usage: miqyas bench <${Object.keys(BENCHES).join('|')}> | miqyas bench --corpus <dir|seeds.json>`);
  for (const k of ['url', 'build', 'preset', 'scrub', 'out', 'record', 'replay'] as const) {
    if (o[k]) throw new UsageError(k === 'record' || k === 'replay' ? `bench does not support --${k}` : `bench sets --${k} itself`);
  }
  validateCassetteFlags(o);
  const needsModel = !o['dry-run'] && !o['no-model'] && !inject.agent;
  // Stop before a long build when a live run can't start anyway.
  const route = resolveCliRoute(o, needsModel);
  const repo = path.resolve(o.repo ?? bench.repo);
  if (!existsSync(path.join(repo, '.git'))) throw new UsageError(`${repo} is not a git clone; pass --repo <clone>`);
  const say = (s: string) => process.stderr.write(s + '\n');
  const startedAt = new Date();
  const plans = path.join(ROOT, bench.plans);
  let benchInject = inject;
  if (needsModel && !inject.spendGuard && route.billed) {
    const benchPlans = await loadPlans([plans]);
    const preset = parsePreset(JSON.parse(await readFile(presetPath(bench.preset), 'utf8')), bench.preset);
    const carrier: Injected = { ...inject };
    const spendGuard = await confirmLiveSpend({ o, plans: benchPlans, preset, runId: `bench-${bench.name}`, inject: carrier, chosenModel: route.model! });
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
  const route = o['no-model'] ? null : resolveCliRoute(o, false);
  const now = inject.now?.() ?? new Date();
  const spendDir = inject.spendDir ?? defaultSpendDir();
  const spentTodayUsd = await readDailySpend(spendDir, now);
  const quote = quotePlans({
    plans,
    model: route?.model ?? null,
    noModel: o['no-model'],
    ...(preset ? { preset } : {}),
    spentTodayUsd,
    now,
  });
  process.stdout.write(o.json ? JSON.stringify(quote, null, 2) + '\n' : formatQuote(quote) + '\n');
  return 0;
}

async function cmdDoctor(o: Opts): Promise<number> {
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
  const route = resolveCliRoute(o, false);
  process.stdout.write(`model provider: ${route.provider}\n`);
  const keyStatus =
    route.provider === 'openai' && !route.requiresCredentials && route.endpoint
      ? route.apiKey
        ? 'set in the environment (optional on local/private endpoint)'
        : 'optional on local/private endpoint (set OPENAI_API_KEY if required by your server)'
      : route.hasCredentials
        ? 'set in the environment'
        : 'not set (live runs stop; --dry-run, --no-model, quote, lint and tests work)';
  process.stdout.write(`model key: ${keyStatus}\n`);
  process.stdout.write(
    `model endpoint: ${
      route.endpoint
        ? `${route.endpoint}${route.customEndpoint && route.endpointHost ? ` (custom host ${route.endpointHost})` : ''}`
        : 'not set (set OPENAI_BASE_URL or --endpoint)'
    }\n`,
  );
  const gitleaksVer = await probeGitleaksVersion();
  process.stdout.write(
    gitleaksVer
      ? `gitleaks ${gitleaksVer}: ok\n`
      : 'gitleaks: missing (optional; install gitleaks for Grade 1 Checks 5-6)\n',
  );
  const osvVer = await probeOsvScannerVersion();
  const osvDir = defaultOsvCacheDir();
  const osvReady = hasPopulatedOsvCache(osvDir);
  const osvCacheNote = `offline DB ${osvReady ? 'populated' : 'not populated; run: miqyas update-db'} at ${osvDir}`;
  process.stdout.write(
    osvVer
      ? `osv-scanner ${osvVer}: ok (${osvCacheNote})\n`
      : `osv-scanner: missing (optional; install osv-scanner and run \`miqyas update-db\` for Grade 1 Check 13; ${osvCacheNote})\n`,
  );
  return major >= 20 && browserOk ? 0 : 3;
}

async function cmdUpdateDb(args: string[], o: Opts, inject: Injected): Promise<number> {
  if (args.length > 0) throw new UsageError('usage: miqyas update-db [--ecosystems npm,PyPI] [--db-dir <dir>] [--json]');
  const ecosystems = o.ecosystems !== undefined
    ? o.ecosystems.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  if (o.ecosystems !== undefined && (!ecosystems || ecosystems.length === 0)) {
    throw new UsageError('--ecosystems requires a non-empty comma-separated list');
  }
  if (o['db-dir'] !== undefined && !o['db-dir'].trim()) {
    throw new UsageError('--db-dir requires a non-empty path');
  }
  const cacheDir = o['db-dir'] ? path.resolve(o['db-dir'].trim()) : undefined;
  try {
    const res = await updateOsvDatabase({
      ...(ecosystems ? { ecosystems } : {}),
      ...(cacheDir ? { cacheDir } : {}),
      ...(inject.osvBaseUrl ? { baseUrl: inject.osvBaseUrl } : {}),
      ...(inject.osvFetch ? { fetchFn: inject.osvFetch } : {}),
      onProgress: (msg) => {
        if (!o.json) process.stderr.write(`miqyas update-db: ${msg}\n`);
      },
    });
    if (o.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else {
      process.stdout.write(
        `OSV DB updated (${res.entries.length} ecosystem(s), ${res.totalBytes} bytes) at ${res.cacheDir}\nLog: ${res.logFile}\n`,
      );
    }
    return 0;
  } catch (e) {
    if (e instanceof OsvValidationError) throw new UsageError(e.message);
    throw new EnvError((e as Error).message);
  }
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
  if (o.corpus !== undefined && cmd !== 'lint' && cmd !== 'bench') {
    process.stderr.write(`miqyas: --corpus is only supported on lint and bench\n`);
    return 2;
  }
  if (o.history !== undefined && cmd !== 'bench') {
    process.stderr.write(`miqyas: --history is only supported on bench\n`);
    return 2;
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
        return await cmdLint(args, o);
      case 'import':
        return await cmdImport(args, o);
      case 'scrub':
        return await cmdScrub(args, o);
      case 'bench':
        return await cmdBench(args, o, inject);
      case 'update-db':
        return await cmdUpdateDb(args, o, inject);
      case 'doctor':
        return await cmdDoctor(o);
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    return errorExit(e);
  }
}

/** Print a command's error and return its exit code: 2 for usage and plan errors, 3 for the environment and the rest. */
export function errorExit(e: unknown): number {
  if (
    e instanceof UsageError ||
    e instanceof RouteUsageError ||
    e instanceof PlanError ||
    e instanceof HostPolicyError ||
    e instanceof CorpusError
  ) {
    process.stderr.write(`miqyas: ${e.message}\n`);
    return 2;
  }
  if (
    e instanceof EnvError ||
    e instanceof RouteEnvError ||
    e instanceof AgentError ||
    e instanceof BudgetError ||
    e instanceof BuildChangedError ||
    e instanceof SourceError
  ) {
    process.stderr.write(`miqyas: ${e.message}\n`);
    return 3;
  }
  process.stderr.write(`miqyas: ${(e as Error).stack ?? String(e)}\n`);
  return 3;
}

export function loadCliEnv(): void {
  // A git-ignored .env in the working directory may hold keys and plan secrets, nothing else: a stray
  // ANTHROPIC_BASE_URL, OPENAI_BASE_URL, or proxy setting there could redirect the payloads. Shell variables win.
  if (existsSync('.env')) {
    for (const [k, v] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) {
      if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|MIQYAS_SECRET_\w+)$/.test(k) && process.env[k] === undefined) {
        process.env[k] = v;
      }
    }
  }
}

export async function runCliProcess(argv = process.argv.slice(2)): Promise<never> {
  loadCliEnv();
  const code = await main(argv);
  process.exit(code);
}
