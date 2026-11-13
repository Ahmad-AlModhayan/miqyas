// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Spend guard: offline quotes, strict typed hard caps, persistent $20/day ledger in ~/.miqyas/,
// 25% findings share cutoff, and pessimistic pre-call budget gating.

import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentError, PRICES, PRICE_TABLE_MAX_AGE_DAYS, isPriceTableStale } from './models.js';

export const DAILY_CAP_USD = 20;
export const FINDINGS_BUDGET_SHARE = 0.25;
export const DEFAULT_MAX_TOKENS = 16000;
export const DEFAULT_MAX_ACT_TURNS = 12;
export const DEFAULT_MAX_JUDGE_TURNS = 5;

/** Conservative per-call overhead for system prompt + tool definitions (tokens). */
const SYSTEM_OVERHEAD_TOKENS = 2000;
/** Pessimistic upper-bound input tokens per image (covers high-res cropped captures). */
const IMAGE_TOKENS_UPPER_BOUND = 2000;
/** Conservative chars-per-token divisor for pessimistic input estimation. */
const CHARS_PER_TOKEN_LOWER_BOUND = 3;

/** Typical step turn/token expectations for free offline likely-cost estimates. */
const LIKELY_ACT_TURNS = 2;
const LIKELY_JUDGE_TURNS = 1;
const LIKELY_INPUT_TOKENS_PER_CALL = 3500;
const LIKELY_OUTPUT_TOKENS_PER_CALL = 250;
const WORST_INPUT_TOKENS_PER_CALL = 12000;

export class BudgetError extends AgentError {}
export class FindingsBudgetError extends BudgetError {}

export type SpendBucket = 'assert' | 'findings';

export interface QuotePlanInput {
  id: string;
  steps: readonly { type: 'action' | 'assertion'; check?: unknown }[];
}

export interface QuotePresetInput {
  mutations: readonly { plan: string }[];
}

export interface PlanQuote {
  planId: string;
  actionSteps: number;
  aiAssertionSteps: number;
  codeAssertionSteps: number;
  executions: number;
  likelyUsd: number | null;
  worstCaseUsd: number | null;
}

export interface RunQuote {
  model: string | null;
  noModel: boolean;
  knownPrice: boolean;
  priceDate: string;
  priceAgeDays: number;
  stalePriceTable: boolean;
  dailyCapUsd: number;
  spentTodayUsd: number;
  remainingDailyUsd: number;
  likelyUsd: number | null;
  worstCaseUsd: number | null;
  plans: PlanQuote[];
}

export function defaultSpendDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MIQYAS_HOME?.trim() || path.join(os.homedir(), '.miqyas');
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface DailySpendEntry {
  runId: string;
  at: string;
  model: string;
  usd: number;
}

interface DailySpendFile {
  version: 1;
  days: Record<string, { spentUsd: number; runs: DailySpendEntry[] }>;
}

function ledgerPath(spendDir: string): string {
  return path.join(spendDir, 'daily-spend.json');
}

function parseDailyFile(raw: string, file: string): DailySpendFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new BudgetError(`cannot read ${file} (corrupt daily-spend JSON): ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('days' in parsed)) {
    throw new BudgetError(`cannot read ${file}: invalid daily-spend schema`);
  }
  const days = (parsed as { days: unknown }).days;
  if (!days || typeof days !== 'object' || Array.isArray(days)) {
    throw new BudgetError(`cannot read ${file}: invalid daily-spend schema`);
  }
  return parsed as DailySpendFile;
}

export async function readDailySpend(spendDir = defaultSpendDir(), now = new Date()): Promise<number> {
  const file = ledgerPath(spendDir);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new BudgetError(`cannot read ${file}: ${(e as Error).message}`);
  }
  const data = parseDailyFile(raw, file);
  const entry = data.days[dayKey(now)];
  if (!entry) return 0;
  if (typeof entry.spentUsd !== 'number' || !Number.isFinite(entry.spentUsd) || entry.spentUsd < 0) {
    throw new BudgetError(`invalid daily-spend amount in ${file}`);
  }
  return entry.spentUsd;
}

export async function recordDailySpend(input: {
  spendDir?: string;
  runId: string;
  model: string;
  usd: number;
  now?: Date;
}): Promise<number> {
  const spendDir = input.spendDir ?? defaultSpendDir();
  const now = input.now ?? new Date();
  const key = dayKey(now);
  const file = ledgerPath(spendDir);

  let data: DailySpendFile = { version: 1, days: {} };
  try {
    const raw = await readFile(file, 'utf8');
    data = parseDailyFile(raw, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  // Retain last 14 days so the file stays tiny across long-term use.
  const cutoffMs = now.getTime() - 14 * 86_400_000;
  for (const k of Object.keys(data.days)) {
    const t = Date.parse(`${k}T00:00:00Z`);
    if (Number.isFinite(t) && t < cutoffMs) delete data.days[k];
  }

  const day = (data.days[key] ??= { spentUsd: 0, runs: [] });
  const existing = day.runs.find((r) => r.runId === input.runId && r.model === input.model);
  if (existing) {
    existing.usd += input.usd;
    existing.at = now.toISOString();
  } else {
    day.runs.push({ runId: input.runId, at: now.toISOString(), model: input.model, usd: input.usd });
  }
  day.spentUsd = Math.round((day.spentUsd + input.usd) * 1_000_000) / 1_000_000;

  await mkdir(spendDir, { recursive: true });
  const tmp = path.join(spendDir, `daily-spend.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
  return day.spentUsd;
}

export function quotePlans(input: {
  plans: readonly QuotePlanInput[];
  model: string | null;
  noModel?: boolean;
  preset?: QuotePresetInput;
  maxActTurns?: number;
  maxTokens?: number;
  maxJudgeTurns?: number;
  spentTodayUsd?: number;
  dailyCapUsd?: number;
  now?: Date;
}): RunQuote {
  const noModel = Boolean(input.noModel);
  const maxActTurns = input.maxActTurns ?? DEFAULT_MAX_ACT_TURNS;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxJudgeTurns = input.maxJudgeTurns ?? DEFAULT_MAX_JUDGE_TURNS;
  const dailyCapUsd = input.dailyCapUsd ?? DAILY_CAP_USD;
  const spentTodayUsd = input.spentTodayUsd ?? 0;
  const remainingDailyUsd = Math.max(0, Math.round((dailyCapUsd - spentTodayUsd) * 1_000_000) / 1_000_000);
  const { stale, ageDays, date } = isPriceTableStale(input.now);

  const price = input.model ? PRICES[input.model] : undefined;
  const knownPrice = noModel ? true : Boolean(price);

  const mutCounts = new Map<string, number>();
  if (input.preset) {
    for (const m of input.preset.mutations) mutCounts.set(m.plan, (mutCounts.get(m.plan) ?? 0) + 1);
  }

  let totalLikely: number | null = knownPrice ? 0 : null;
  let totalWorst: number | null = knownPrice ? 0 : null;

  const plans: PlanQuote[] = input.plans.map((p) => {
    const actionSteps = p.steps.filter((s) => s.type === 'action').length;
    const aiAssertionSteps = p.steps.filter((s) => s.type === 'assertion' && !s.check).length;
    const codeAssertionSteps = p.steps.filter((s) => s.type === 'assertion' && Boolean(s.check)).length;
    const executions = 1 + (mutCounts.get(p.id) ?? 0);

    if (noModel) {
      return { planId: p.id, actionSteps, aiAssertionSteps, codeAssertionSteps, executions, likelyUsd: 0, worstCaseUsd: 0 };
    }
    if (!price) {
      return { planId: p.id, actionSteps, aiAssertionSteps, codeAssertionSteps, executions, likelyUsd: null, worstCaseUsd: null };
    }

    const likelyCalls = (actionSteps * LIKELY_ACT_TURNS + aiAssertionSteps * LIKELY_JUDGE_TURNS) * executions;
    const worstCalls = (actionSteps * maxActTurns + aiAssertionSteps * maxJudgeTurns) * executions;

    const perLikely = (LIKELY_INPUT_TOKENS_PER_CALL * price.input + LIKELY_OUTPUT_TOKENS_PER_CALL * price.output) / 1e6;
    const perWorst = (WORST_INPUT_TOKENS_PER_CALL * price.input + maxTokens * price.output) / 1e6;

    const likelyUsd = likelyCalls * perLikely;
    const worstCaseUsd = worstCalls * perWorst;
    totalLikely! += likelyUsd;
    totalWorst! += worstCaseUsd;

    return { planId: p.id, actionSteps, aiAssertionSteps, codeAssertionSteps, executions, likelyUsd, worstCaseUsd };
  });

  return {
    model: noModel ? null : input.model,
    noModel,
    knownPrice,
    priceDate: date,
    priceAgeDays: ageDays,
    stalePriceTable: stale,
    dailyCapUsd,
    spentTodayUsd,
    remainingDailyUsd,
    likelyUsd: totalLikely,
    worstCaseUsd: totalWorst,
    plans,
  };
}

function fmtUsd(v: number | null): string {
  if (v === null) return 'unknown';
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function formatQuote(q: RunQuote): string {
  const lines: string[] = [];
  if (q.noModel) {
    lines.push(`Quote (--no-model): $0.00 (likely $0.00, worst case $0.00; ${q.plans.length} plan(s); code checks only).`);
  } else if (!q.knownPrice) {
    lines.push(`Quote (${q.model ?? 'none'}): unknown price — live billed runs fail closed when pricing is missing.`);
  } else {
    lines.push(`Quote (${q.model}): likely ${fmtUsd(q.likelyUsd)}, worst case ${fmtUsd(q.worstCaseUsd)} across ${q.plans.length} plan(s)`);
  }
  for (const p of q.plans) {
    const exec = p.executions > 1 ? ` x${p.executions}` : '';
    lines.push(
      `  ${p.planId}${exec}: ${p.actionSteps} action(s), ${p.aiAssertionSteps} AI assertion(s), ${p.codeAssertionSteps} code assertion(s) -> likely ${fmtUsd(p.likelyUsd)}, worst case ${fmtUsd(p.worstCaseUsd)}`,
    );
  }
  lines.push(
    `Daily cap: today ${fmtUsd(q.spentTodayUsd)} / $${q.dailyCapUsd.toFixed(2)} daily cap (remaining ${fmtUsd(q.remainingDailyUsd)}).`,
  );
  lines.push(
    q.stalePriceTable
      ? `WARNING: price table (${q.priceDate}) is ${q.priceAgeDays} days old (> ${PRICE_TABLE_MAX_AGE_DAYS} days); verify provider pricing before approving.`
      : `Price table date: ${q.priceDate} (${q.priceAgeDays}d old).`,
  );
  return lines.join('\n');
}

/**
 * Strictly parse a person's typed dollar hard cap. Rejects empty input, non-numeric answers,
 * zero/negative amounts, or any cap above what remains of today's $20 daily cap.
 */
export function parseTypedCap(raw: string, remainingDailyUsd: number): number {
  const trimmed = raw.trim().replace(/^\$\s*/, '');
  if (!trimmed || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) {
    throw new BudgetError('invalid hard cap: type a positive USD dollar amount (for example 2.50)');
  }
  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BudgetError('invalid hard cap: amount must be greater than $0');
  }
  if (amount > remainingDailyUsd + 1e-9) {
    throw new BudgetError(`hard cap $${amount.toFixed(2)} exceeds remaining daily cap ($${remainingDailyUsd.toFixed(2)})`);
  }
  return amount;
}

export function pessimisticInputTokens(inputChars: number, images: number): number {
  return SYSTEM_OVERHEAD_TOKENS + Math.ceil(Math.max(0, inputChars) / CHARS_PER_TOKEN_LOWER_BOUND) + Math.max(0, images) * IMAGE_TOKENS_UPPER_BOUND;
}

export interface SpendGuardOptions {
  runCapUsd: number;
  dailyCapUsd?: number;
  spentTodayUsd: number;
  spendDir?: string;
  runId?: string;
  now?: Date;
}

export class SpendGuard {
  readonly runCapUsd: number;
  readonly dailyCapUsd: number;
  readonly spentTodayUsd: number;
  readonly findingsCapUsd: number;
  actualUsd = 0;
  findingsUsd = 0;
  readonly byModelUsd: Record<string, number> = {};
  private persistChain: Promise<void> = Promise.resolve();
  private readonly spendDir?: string;
  private readonly runId?: string;
  private readonly now?: Date;

  constructor(opts: SpendGuardOptions) {
    if (!Number.isFinite(opts.runCapUsd) || opts.runCapUsd <= 0) {
      throw new BudgetError('budget cap must be a positive USD amount');
    }
    this.runCapUsd = opts.runCapUsd;
    this.dailyCapUsd = opts.dailyCapUsd ?? DAILY_CAP_USD;
    this.spentTodayUsd = opts.spentTodayUsd;
    this.findingsCapUsd = opts.runCapUsd * FINDINGS_BUDGET_SHARE;
    if (opts.spendDir !== undefined) this.spendDir = opts.spendDir;
    if (opts.runId !== undefined) this.runId = opts.runId;
    if (opts.now !== undefined) this.now = opts.now;
  }

  /** Pessimistic pre-call check. Fails closed on unknown pricing or exceeded run/findings/$20 daily cap. */
  beforeCall(input: { model: string; bucket?: SpendBucket; inputChars: number; images: number; maxOutputTokens: number }): number {
    const price = PRICES[input.model];
    if (!price) {
      throw new BudgetError(`budget cap: unknown price for model "${input.model}"`);
    }
    const estInput = pessimisticInputTokens(input.inputChars, input.images);
    const estUsd = (estInput * price.input + input.maxOutputTokens * price.output) / 1e6;
    const bucket = input.bucket ?? 'assert';

    if (bucket === 'findings' && this.findingsUsd + estUsd > this.findingsCapUsd + 1e-9) {
      throw new FindingsBudgetError(
        `findings budget cap reached ($${this.findingsUsd.toFixed(4)} + $${estUsd.toFixed(4)} > $${this.findingsCapUsd.toFixed(4)} 25% share)`,
      );
    }
    if (this.actualUsd + estUsd > this.runCapUsd + 1e-9) {
      throw new BudgetError(
        `budget cap: next call may cost $${estUsd.toFixed(4)} (run spend $${this.actualUsd.toFixed(4)} / cap $${this.runCapUsd.toFixed(4)})`,
      );
    }
    if (this.spentTodayUsd + this.actualUsd + estUsd > this.dailyCapUsd + 1e-9) {
      throw new BudgetError(
        `budget cap: next call would exceed $${this.dailyCapUsd.toFixed(2)} daily cap`,
      );
    }
    return estUsd;
  }

  recordUsage(input: { model: string; bucket?: SpendBucket; inputTokens: number; outputTokens: number }): number {
    const price = PRICES[input.model];
    if (!price) {
      throw new BudgetError(`budget cap: unknown price for answering model "${input.model}"`);
    }
    if (!Number.isFinite(input.inputTokens) || !Number.isFinite(input.outputTokens) || input.inputTokens < 0 || input.outputTokens < 0) {
      throw new BudgetError('budget cap: invalid token usage from model response');
    }
    const cost = (input.inputTokens * price.input + input.outputTokens * price.output) / 1e6;
    this.actualUsd += cost;
    if ((input.bucket ?? 'assert') === 'findings') this.findingsUsd += cost;
    this.byModelUsd[input.model] = (this.byModelUsd[input.model] ?? 0) + cost;
    return cost;
  }

  async recordAndPersist(input: { model: string; bucket?: SpendBucket; inputTokens: number; outputTokens: number }): Promise<number> {
    const cost = this.recordUsage(input);
    if (this.spendDir && this.runId) {
      const spendDir = this.spendDir;
      const runId = this.runId;
      const now = this.now ?? new Date();
      this.persistChain = this.persistChain.then(() =>
        recordDailySpend({ spendDir, runId, model: input.model, usd: cost, now }).then(() => undefined),
      );
      await this.persistChain;
    }
    return cost;
  }

  async flush(): Promise<void> {
    await this.persistChain;
  }
}

/** Convenience helper used cleanly in synchronous unit assertions or non-async checks if needed. */
export function hasDailySpendLedger(spendDir = defaultSpendDir()): boolean {
  try {
    readFileSync(ledgerPath(spendDir), 'utf8');
    return true;
  } catch {
    return false;
  }
}
