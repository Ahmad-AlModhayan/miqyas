// SPDX-License-Identifier: AGPL-3.0-only
// Unified model router configuration & credential resolution behind the Agent seam (Layer 2: agents).

import type { Agent, PayloadEntry } from './agent.js';
import { AnthropicAgent } from './anthropic.js';
import {
  DEFAULT_EFFORT,
  DEFAULT_ENDPOINT,
  isLocalOrPrivateHost,
  resolveModelChoice,
  sanitizeEndpointUrl,
  validateEffort,
  validateProviderName,
  validateTier,
  type EffortLevel,
  type ProviderName,
  type Tier,
} from './models.js';
import { OpenAIAgent } from './openai.js';
import type { SpendGuard } from './spend.js';

export class RouteUsageError extends Error {}
export class RouteEnvError extends Error {}

export interface RouteOptions {
  provider?: string;
  endpoint?: string;
  model?: string;
  tier?: string;
  effort?: string;
  env?: NodeJS.ProcessEnv;
  /** Throw RouteUsageError / RouteEnvError when required endpoint, model, or credentials are missing. */
  requireReady?: boolean;
}

export interface ResolvedRoute {
  provider: ProviderName;
  endpoint: string | null;
  endpointHost: string | null;
  customEndpoint: boolean;
  localPrivate: boolean;
  billed: boolean;
  requiresCredentials: boolean;
  hasCredentials: boolean;
  apiKey?: string;
  tier?: Tier;
  model?: string;
  effort: EffortLevel;
}

function normalizeProvider(opts: RouteOptions, env: NodeJS.ProcessEnv): ProviderName {
  if (opts.provider !== undefined) {
    try {
      return validateProviderName(opts.provider)!;
    } catch (e) {
      throw new RouteUsageError(`--${(e as Error).message}`);
    }
  }
  const envProvider = env.MIQYAS_PROVIDER?.trim();
  if (envProvider !== undefined && envProvider !== '') {
    try {
      return validateProviderName(envProvider)!;
    } catch (e) {
      throw new RouteEnvError(`MIQYAS_PROVIDER ${(e as Error).message.replace(/^provider /, '')}`);
    }
  }
  if (env.OPENAI_BASE_URL?.trim()) return 'openai';
  return 'anthropic';
}

function normalizeEffort(raw?: string): EffortLevel {
  const value = raw?.trim() || DEFAULT_EFFORT;
  try {
    return validateEffort(value)!;
  } catch (e) {
    throw new RouteUsageError((e as Error).message);
  }
}

function parseEndpointWithSource(cliEndpoint: string | undefined, envValue: string | undefined, envVarName: string) {
  const fromCli = cliEndpoint?.trim();
  const raw = fromCli || envValue?.trim() || '';
  if (!raw) return null;
  try {
    return sanitizeEndpointUrl(raw);
  } catch (e) {
    const msg = (e as Error).message;
    throw fromCli ? new RouteUsageError(`--endpoint ${msg}`) : new RouteEnvError(`${envVarName} ${msg}`);
  }
}

function resolveAnthropicRoute(opts: RouteOptions, env: NodeJS.ProcessEnv, effort: EffortLevel): ResolvedRoute {
  let chosen: { tier?: Tier; model: string };
  try {
    chosen = resolveModelChoice({
      ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
  } catch (e) {
    throw new RouteUsageError((e as Error).message);
  }

  const clean =
    parseEndpointWithSource(opts.endpoint, env.ANTHROPIC_BASE_URL, 'ANTHROPIC_BASE_URL') ??
    sanitizeEndpointUrl(DEFAULT_ENDPOINT);

  const hasCredentials = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  if (opts.requireReady && !hasCredentials) {
    throw new RouteEnvError(
      'ANTHROPIC_API_KEY is not set. Set it in your own environment (Miqyas never asks for it), or use --dry-run / --no-model.',
    );
  }

  return {
    provider: 'anthropic',
    endpoint: clean.endpoint,
    endpointHost: clean.host,
    customEndpoint: clean.endpoint !== DEFAULT_ENDPOINT,
    localPrivate: isLocalOrPrivateHost(clean.hostname),
    billed: true,
    requiresCredentials: true,
    hasCredentials,
    ...(chosen.tier ? { tier: chosen.tier } : {}),
    model: chosen.model,
    effort,
  };
}

function assertOpenAIReady(route: { endpoint: string | null; model?: string; requiresCredentials: boolean; apiKey?: string }): void {
  if (!route.endpoint) {
    throw new RouteEnvError(
      'OpenAI-compatible runs require OPENAI_BASE_URL or --endpoint (no external default endpoint is used).',
    );
  }
  if (!route.model) {
    throw new RouteUsageError('--provider openai requires --model <id> or OPENAI_MODEL.');
  }
  if (route.requiresCredentials && !route.apiKey) {
    throw new RouteEnvError(
      'OPENAI_API_KEY is not set for non-private OpenAI-compatible endpoint. Set it in your environment, or point --endpoint to a local/private server.',
    );
  }
}

function resolveOpenAIRoute(opts: RouteOptions, env: NodeJS.ProcessEnv, effort: EffortLevel): ResolvedRoute {
  try {
    validateTier(opts.tier);
  } catch (e) {
    throw new RouteUsageError((e as Error).message);
  }

  const model = opts.model?.trim() || env.OPENAI_MODEL?.trim() || undefined;
  if (opts.tier !== undefined && !model) {
    throw new RouteUsageError('--provider openai requires --model or OPENAI_MODEL (Claude --tier presets do not apply)');
  }

  const envEpName = env.OPENAI_BASE_URL?.trim() ? 'OPENAI_BASE_URL' : 'MIQYAS_MODEL_ENDPOINT';
  const clean = parseEndpointWithSource(opts.endpoint, env.OPENAI_BASE_URL?.trim() || env.MIQYAS_MODEL_ENDPOINT, envEpName);
  if (!clean) {
    const unconfigured: ResolvedRoute = {
      provider: 'openai',
      endpoint: null,
      endpointHost: null,
      customEndpoint: false,
      localPrivate: false,
      billed: false,
      requiresCredentials: false,
      hasCredentials: false,
      ...(model ? { model } : {}),
      effort,
    };
    if (opts.requireReady) assertOpenAIReady(unconfigured);
    return unconfigured;
  }

  const localPrivate = isLocalOrPrivateHost(clean.hostname);
  const apiKey = env.OPENAI_API_KEY?.trim() || undefined;
  const requiresCredentials = !localPrivate;
  const route: ResolvedRoute = {
    provider: 'openai',
    endpoint: clean.endpoint,
    endpointHost: clean.host,
    customEndpoint: true,
    localPrivate,
    billed: !localPrivate,
    requiresCredentials,
    hasCredentials: !requiresCredentials || Boolean(apiKey),
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    effort,
  };
  if (opts.requireReady) assertOpenAIReady(route);
  return route;
}

export function resolveRoute(opts: RouteOptions = {}): ResolvedRoute {
  const env = opts.env ?? process.env;
  const provider = normalizeProvider(opts, env);
  const effort = normalizeEffort(opts.effort);
  return provider === 'anthropic'
    ? resolveAnthropicRoute(opts, env, effort)
    : resolveOpenAIRoute(opts, env, effort);
}

export interface CreateRoutedAgentOptions {
  route: ResolvedRoute;
  log?: (e: PayloadEntry) => void;
  spend?: SpendGuard;
  env?: NodeJS.ProcessEnv;
  maxActTurns?: number;
  fetchImpl?: typeof fetch;
}

export function createRoutedAgent(opts: CreateRoutedAgentOptions): Agent {
  const { route } = opts;
  if (route.provider === 'anthropic') {
    return new AnthropicAgent({
      ...(route.tier ? { tier: route.tier } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(route.endpoint ? { endpoint: route.endpoint } : {}),
      effort: route.effort,
      ...(opts.maxActTurns !== undefined ? { maxActTurns: opts.maxActTurns } : {}),
      ...(opts.log ? { log: opts.log } : {}),
      ...(opts.spend ? { spend: opts.spend } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
  }
  assertOpenAIReady(route);
  return new OpenAIAgent({
    model: route.model!,
    endpoint: route.endpoint!,
    ...(route.apiKey ? { apiKey: route.apiKey } : {}),
    ...(opts.maxActTurns !== undefined ? { maxActTurns: opts.maxActTurns } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.spend ? { spend: opts.spend } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
