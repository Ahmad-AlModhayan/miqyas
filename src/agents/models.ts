// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Maintained model tier table, first-party USD pricing, staleness checks, and Anthropic endpoint resolution.
// Layer 2 (`agents`): single source of truth used by agents, proof-core reports/benchmarks, and CLI.

export type Tier = 'low' | 'medium' | 'high';

export const DEFAULT_TIER: Tier = 'low';

/** Maintained mapping from `--tier` to model id (ADR 0001, SRS FR-B4). One tier both acts and judges. */
export const MODEL_TIERS: Record<Tier, string> = {
  low: 'claude-haiku-5-5',
  medium: 'claude-sonnet-5-5',
  high: 'claude-opus-5-5',
};

export const DEFAULT_ENDPOINT = 'https://api.anthropic.com';

/** Date of the maintained price list below, checked for >90 day staleness during quote & runs. */
export const PRICE_TABLE_DATE = '2026-10-06';
export const PRICE_TABLE_MAX_AGE_DAYS = 90;

/** USD per million tokens, first-party list prices as of PRICE_TABLE_DATE. */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-fable-5-1': { input: 10, output: 50 },
};

export const PRICE_NOTE =
  `List prices of ${PRICE_TABLE_DATE}; every input token at the uncached rate (Miqyas counts cache reads and writes as input), so it's an upper bound for input.`;

export interface ModelUsageCounts {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  byModel?: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
}

/** Usage by answering model; calls with no recorded model go to the asked one. */
export function usageByModel(asked: string | null, u: ModelUsageCounts): NonNullable<ModelUsageCounts['byModel']> {
  if (u.byModel) return u.byModel;
  return u.calls && asked ? { [asked]: { calls: u.calls, inputTokens: u.inputTokens, outputTokens: u.outputTokens } } : {};
}

/** Cost at list price, each call at the model that answered it (asked model when not recorded); null when unknown. */
export function costEstimate(model: string | null, usage: ModelUsageCounts): number | null {
  let sum = 0;
  for (const [m, u] of Object.entries(usageByModel(model, usage))) {
    const p = PRICES[m];
    if (!p) return null;
    sum += (u.inputTokens * p.input + u.outputTokens * p.output) / 1e6;
  }
  return (model && PRICES[model]) || usage.byModel ? sum : null;
}

export function isPriceTableStale(now = new Date()): { stale: boolean; ageDays: number; date: string } {
  const tableMs = Date.parse(`${PRICE_TABLE_DATE}T00:00:00Z`);
  const ageDays = Math.max(0, Math.floor((now.getTime() - tableMs) / 86_400_000));
  return { stale: ageDays > PRICE_TABLE_MAX_AGE_DAYS, ageDays, date: PRICE_TABLE_DATE };
}

export function resolveModelChoice(opts: { tier?: string; model?: string }): { tier?: Tier; model: string } {
  if (opts.tier !== undefined) {
    if (opts.tier !== 'low' && opts.tier !== 'medium' && opts.tier !== 'high') {
      throw new Error(`--tier must be low, medium or high (got "${opts.tier}")`);
    }
  }
  if (opts.model) return { model: opts.model };
  const tier = (opts.tier as Tier | undefined) ?? DEFAULT_TIER;
  return { tier, model: MODEL_TIERS[tier] };
}

export function resolveEndpoint(env: NodeJS.ProcessEnv = process.env): { endpoint: string; host: string; custom: boolean } {
  const raw = env.ANTHROPIC_BASE_URL?.trim();
  const endpoint = raw && raw.length > 0 ? raw : DEFAULT_ENDPOINT;
  const custom = Boolean(raw && raw.replace(/\/+$/, '') !== DEFAULT_ENDPOINT);
  try {
    const u = new URL(endpoint);
    return { endpoint, host: u.host || endpoint, custom };
  } catch {
    return { endpoint, host: endpoint, custom: true };
  }
}

/**
 * Error from a model provider, refused payload, or spend cap: the plan ends as an error, never a pass (exit 3).
 */
export class AgentError extends Error {}
