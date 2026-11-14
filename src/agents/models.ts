// SPDX-License-Identifier: AGPL-3.0-only
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

export type ProviderName = 'anthropic' | 'openai';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const DEFAULT_EFFORT: EffortLevel = 'medium';
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function sanitizeEndpointUrl(raw: string): { endpoint: string; host: string; protocol: 'http:' | 'https:'; hostname: string } {
  const u = new URL(raw.trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`endpoint must use http or https (got "${u.protocol}")`);
  }
  u.username = '';
  u.password = '';
  const rawHref = u.href;
  const endpoint = rawHref.endsWith('/') ? rawHref.slice(0, -1) : rawHref;
  return { endpoint, host: u.host, protocol: u.protocol, hostname: u.hostname };
}

/**
 * True only for loopback, RFC1918 IPv4, ULA IPv6 (fc00::/7), or explicit `.local` / `.internal` names.
 * Excludes link-local metadata ranges (`169.254.0.0/16`) and all public hosts.
 */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^f[cd]00::/i.test(host)) return true;

  const parts = host.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

export function validateProviderName(provider?: string): ProviderName | undefined {
  if (provider === undefined) return undefined;
  const trimmed = provider.trim();
  if (trimmed === 'anthropic') return 'anthropic';
  if (trimmed === 'openai' || trimmed === 'openai-compatible') return 'openai';
  throw new Error(`provider must be anthropic or openai (got "${provider}")`);
}

export function validateEffort(effort?: string): EffortLevel | undefined {
  if (effort === undefined) return undefined;
  const trimmed = effort.trim();
  if ((EFFORT_LEVELS as readonly string[]).includes(trimmed)) return trimmed as EffortLevel;
  throw new Error('--effort must be low, medium, high, xhigh or max');
}

export function validateTier(tier?: string): Tier | undefined {
  if (tier === undefined) return undefined;
  if (tier !== 'low' && tier !== 'medium' && tier !== 'high') {
    throw new Error(`--tier must be low, medium or high (got "${tier}")`);
  }
  return tier;
}

export function resolveModelChoice(opts: { tier?: string; model?: string }): { tier?: Tier; model: string } {
  const validTier = validateTier(opts.tier);
  if (opts.model) return { model: opts.model };
  const tier = validTier ?? DEFAULT_TIER;
  return { tier, model: MODEL_TIERS[tier] };
}

export function resolveEndpoint(env: NodeJS.ProcessEnv = process.env): { endpoint: string; host: string; custom: boolean } {
  const raw = env.ANTHROPIC_BASE_URL?.trim();
  const candidate = raw && raw.length > 0 ? raw : DEFAULT_ENDPOINT;
  const custom = Boolean(raw && raw.replace(/\/+$/, '') !== DEFAULT_ENDPOINT);
  try {
    const clean = sanitizeEndpointUrl(candidate);
    return { endpoint: clean.endpoint, host: clean.host, custom };
  } catch {
    return { endpoint: candidate, host: candidate, custom: true };
  }
}

/**
 * Error from a model provider, refused payload, or spend cap: the plan ends as an error, never a pass (exit 3).
 */
export class AgentError extends Error {}
