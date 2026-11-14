// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentError, type PayloadEntry } from '../../src/agents/agent.js';
import { AnthropicAgent } from '../../src/agents/anthropic.js';
import { parsePlan } from '../../src/proof-core/plan.js';
import { parsePreset } from '../../src/proof-core/mutate.js';
import { NO_SCRUB } from '../../src/scrub/scrub.js';
import type { Observation } from '../../src/surfaces/session.js';
import {
  DEFAULT_TIER,
  MODEL_TIERS,
  PRICES,
  PRICE_TABLE_DATE,
  costEstimate,
  isPriceTableStale,
  resolveEndpoint,
  resolveModelChoice,
} from '../../src/agents/models.js';
import {
  BudgetError,
  DAILY_CAP_USD,
  FINDINGS_BUDGET_SHARE,
  FindingsBudgetError,
  SpendGuard,
  formatQuote,
  parseTypedCap,
  quotePlans,
  readDailySpend,
  recordDailySpend,
} from '../../src/agents/spend.js';

const temps: string[] = [];
afterEach(async () => {
  while (temps.length) await rm(temps.pop()!, { recursive: true, force: true });
});

describe('maintained model table, tiers, and pricing staleness', () => {
  it('maps low, medium, high tiers to Haiku, Sonnet, Opus and defaults to low', () => {
    expect(DEFAULT_TIER).toBe('low');
    expect(MODEL_TIERS).toEqual({
      low: 'claude-haiku-5-5',
      medium: 'claude-sonnet-5-5',
      high: 'claude-opus-5-5',
    });
    expect(resolveModelChoice({})).toEqual({ tier: 'low', model: 'claude-haiku-5-5' });
    expect(resolveModelChoice({ tier: 'medium' })).toEqual({ tier: 'medium', model: 'claude-sonnet-5-5' });
    expect(resolveModelChoice({ tier: 'high' })).toEqual({ tier: 'high', model: 'claude-opus-5-5' });
    expect(resolveModelChoice({ model: 'claude-fable-5-1' })).toEqual({ model: 'claude-fable-5-1' });
    expect(resolveModelChoice({ tier: 'low', model: 'custom-model' })).toEqual({ model: 'custom-model' });
    expect(() => resolveModelChoice({ tier: 'ultra' })).toThrow(/tier/i);
  });

  it('detects when the price table is older than 90 days', () => {
    expect(PRICE_TABLE_DATE).toBe('2026-10-06');
    const fresh = isPriceTableStale(new Date('2026-12-01T00:00:00Z'));
    expect(fresh.stale).toBe(false);
    const edge = isPriceTableStale(new Date('2027-01-04T00:00:00Z')); // exactly 90 days after 2026-10-06
    expect(edge.ageDays).toBe(90);
    expect(edge.stale).toBe(false);
    const stale = isPriceTableStale(new Date('2027-01-05T00:00:00Z')); // 91 days
    expect(stale.ageDays).toBe(91);
    expect(stale.stale).toBe(true);
  });

  it('computes cost estimates and returns null for unknown models', () => {
    expect(PRICES['claude-haiku-5-5']).toEqual({ input: 0.1, output: 0.5 });
    expect(costEstimate('claude-opus-5-5', { calls: 1, inputTokens: 1e6, outputTokens: 1e6 })).toBe(24);
    expect(costEstimate('unknown-model', { calls: 1, inputTokens: 1000, outputTokens: 500 })).toBeNull();
  });

  it('resolves default and custom Anthropic endpoints with host extraction', () => {
    expect(resolveEndpoint({})).toEqual({ endpoint: 'https://api.anthropic.com', host: 'api.anthropic.com', custom: false });
    expect(resolveEndpoint({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8000/v1' })).toEqual({
      endpoint: 'http://127.0.0.1:8000/v1',
      host: '127.0.0.1:8000',
      custom: true,
    });
  });
});

describe('offline quotes', () => {
  const mixedPlan = parsePlan(
    {
      format: 'miqyas-plan',
      version: 1,
      id: 'checkout',
      steps: [
        { id: 's1', type: 'action', text: 'Click Pay' },
        { id: 'a1', type: 'assertion', text: 'Total shows $10' },
        { id: 'a2', type: 'assertion', text: 'Receipt badge visible', check: { locator: { role: 'status' }, expect: 'visible' } },
      ],
    },
    'checkout',
  );

  it('quotes likely and worst-case USD per plan and total offline, scaling with tier and skipping code checks', () => {
    const low = quotePlans({ plans: [mixedPlan], model: 'claude-haiku-5-5', spentTodayUsd: 1.5, now: new Date('2026-11-15T00:00:00Z') });
    const high = quotePlans({ plans: [mixedPlan], model: 'claude-opus-5-5', spentTodayUsd: 1.5, now: new Date('2026-11-15T00:00:00Z') });
    expect(low.knownPrice).toBe(true);
    expect(low.plans).toHaveLength(1);
    expect(low.plans[0]).toMatchObject({ planId: 'checkout', actionSteps: 1, aiAssertionSteps: 1, codeAssertionSteps: 1 });
    expect(low.likelyUsd!).toBeGreaterThan(0);
    expect(low.worstCaseUsd!).toBeGreaterThan(low.likelyUsd!);
    expect(high.worstCaseUsd!).toBeCloseTo(low.worstCaseUsd! * 40, 4);
    expect(low.remainingDailyUsd).toBe(18.5);
    expect(low.stalePriceTable).toBe(false);

    const formatted = formatQuote(low);
    expect(formatted).toContain('checkout');
    expect(formatted).toContain('today $1.50 / $20.00 daily cap');
    expect(formatted).toContain('2026-10-06');
    expect(formatted).not.toContain('WARNING');
  });

  it('warns when the price table is past 90 days and quotes $0 for --no-model', () => {
    const stale = quotePlans({ plans: [mixedPlan], model: 'claude-haiku-5-5', now: new Date('2027-02-01T00:00:00Z') });
    expect(stale.stalePriceTable).toBe(true);
    expect(formatQuote(stale)).toMatch(/90 days|stale/i);

    const noModel = quotePlans({ plans: [mixedPlan], model: null, noModel: true, now: new Date('2026-11-15T00:00:00Z') });
    expect(noModel.likelyUsd).toBe(0);
    expect(noModel.worstCaseUsd).toBe(0);
    expect(formatQuote(noModel)).toContain('--no-model');
    expect(formatQuote(noModel)).toContain('$0.00');
  });

  it('marks unknown-price models cleanly and accounts for mutation presets', () => {
    const unknown = quotePlans({ plans: [mixedPlan], model: 'claude-unknown-9' });
    expect(unknown.knownPrice).toBe(false);
    expect(unknown.likelyUsd).toBeNull();
    expect(unknown.worstCaseUsd).toBeNull();
    expect(formatQuote(unknown)).toContain('unknown price');

    const preset = parsePreset({
      name: 'p',
      mutations: [
        { id: 'm1', title: 't1', kind: 'css', css: 'h1{display:none}', plan: 'checkout', assertion: 'a1', probe: { measure: 'height', selector: 'h1' } },
        { id: 'm2', title: 't2', kind: 'css', css: 'h2{display:none}', plan: 'checkout', assertion: 'a2', probe: { measure: 'height', selector: 'h2' } },
      ],
    });
    const mut = quotePlans({ plans: [mixedPlan], model: 'claude-haiku-5-5', preset });
    const single = quotePlans({ plans: [mixedPlan], model: 'claude-haiku-5-5' });
    expect(mut.worstCaseUsd!).toBeCloseTo(single.worstCaseUsd! * 3, 6);
  });
});

describe('typed hard cap, persistent $20 daily cap, and 25% findings share', () => {
  it('parses strictly positive dollar amounts up to remaining daily cap and rejects everything else', () => {
    expect(parseTypedCap('2.50', 10)).toBe(2.5);
    expect(parseTypedCap(' $5 ', 10)).toBe(5);
    expect(parseTypedCap('10', 10)).toBe(10);
    expect(() => parseTypedCap('', 10)).toThrow();
    expect(() => parseTypedCap('yes', 10)).toThrow();
    expect(() => parseTypedCap('0', 10)).toThrow();
    expect(() => parseTypedCap('-1', 10)).toThrow();
    expect(() => parseTypedCap('$5abc', 10)).toThrow();
    expect(() => parseTypedCap('10.01', 10)).toThrow(/daily cap/i);
  });

  it('persists daily spend in ~/.miqyas-style directory, rolls over days, and fails closed on corrupt ledger', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-daily-'));
    temps.push(dir);
    const day1 = new Date('2026-11-13T10:00:00Z');
    const day2 = new Date('2026-11-14T10:00:00Z');

    expect(await readDailySpend(dir, day1)).toBe(0);
    await recordDailySpend({ spendDir: dir, runId: 'r1', model: 'claude-haiku-5-5', usd: 3.25, now: day1 });
    await recordDailySpend({ spendDir: dir, runId: 'r2', model: 'claude-haiku-5-5', usd: 1.75, now: day1 });
    expect(await readDailySpend(dir, day1)).toBeCloseTo(5, 6);
    expect(await readDailySpend(dir, day2)).toBe(0);

    await writeFile(path.join(dir, 'daily-spend.json'), '{not-json', 'utf8');
    await expect(readDailySpend(dir, day1)).rejects.toThrow(/daily-spend/i);
    await writeFile(path.join(dir, 'daily-spend.json'), '{"days":null}', 'utf8');
    await expect(readDailySpend(dir, day1)).rejects.toThrow(/daily-spend/i);
    await writeFile(path.join(dir, 'daily-spend.json'), '{"days":[]}', 'utf8');
    await expect(readDailySpend(dir, day1)).rejects.toThrow(/daily-spend/i);
  });

  it('blocks pre-call when pessimistic estimate exceeds run cap, $20 daily cap, or unknown pricing', () => {
    const guard = new SpendGuard({ runCapUsd: 0.05, dailyCapUsd: DAILY_CAP_USD, spentTodayUsd: 0 });
    expect(() => guard.recordUsage({ model: 'claude-haiku-5-5', inputTokens: -1, outputTokens: 0 })).toThrow(/invalid token usage/i);
    // Opus pessimistic call with maxTokens=16000 is at least 16000*20/1e6 = $0.32 > $0.05 runCapUsd
    expect(() => guard.beforeCall({ model: 'claude-opus-5-5', bucket: 'assert', inputChars: 1000, images: 1, maxOutputTokens: 16000 })).toThrow(BudgetError);
    expect(() => guard.beforeCall({ model: 'claude-opus-5-5', bucket: 'assert', inputChars: 1000, images: 1, maxOutputTokens: 16000 })).toThrow(/budget cap/);

    // Unknown pricing fails closed
    expect(() => guard.beforeCall({ model: 'mystery-model', bucket: 'assert', inputChars: 10, images: 0, maxOutputTokens: 100 })).toThrow(BudgetError);

    // Daily cap enforcement even when runCapUsd were larger
    const dailyGuard = new SpendGuard({ runCapUsd: 5, dailyCapUsd: DAILY_CAP_USD, spentTodayUsd: 19.9 });
    expect(() => dailyGuard.beforeCall({ model: 'claude-opus-5-5', bucket: 'assert', inputChars: 1000, images: 1, maxOutputTokens: 16000 })).toThrow(/daily cap|budget cap/);
  });

  it('caps crawl and model-proposed findings at 25% of run cap while letting assertions continue', () => {
    expect(FINDINGS_BUDGET_SHARE).toBe(0.25);
    const guard = new SpendGuard({ runCapUsd: 1.0, dailyCapUsd: DAILY_CAP_USD, spentTodayUsd: 0 });
    // Spend $0.24 on findings (within 25% = $0.25 share)
    guard.recordUsage({ model: 'claude-opus-5-5', bucket: 'findings', inputTokens: 0, outputTokens: 12_000 }); // 12k * $20/1M = $0.24
    // Next Opus findings call with maxOutputTokens=16000 ($0.32 pessimistic) pushes findings past $0.25
    expect(() => guard.beforeCall({ model: 'claude-opus-5-5', bucket: 'findings', inputChars: 500, images: 0, maxOutputTokens: 16000 })).toThrow(FindingsBudgetError);
    // Assertion work still has $0.76 of total cap remaining, enough for a Haiku or Sonnet assertion call
    expect(() => guard.beforeCall({ model: 'claude-haiku-5-5', bucket: 'assert', inputChars: 500, images: 1, maxOutputTokens: 16000 })).not.toThrow();
    expect(guard.actualUsd).toBeCloseTo(0.24, 6);
    expect(guard.findingsUsd).toBeCloseTo(0.24, 6);
  });

  it('persists incremental daily spend when spendDir is configured', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-guard-persist-'));
    temps.push(dir);
    const now = new Date('2026-11-13T12:00:00Z');
    const guard = new SpendGuard({ runCapUsd: 5, dailyCapUsd: DAILY_CAP_USD, spentTodayUsd: 0, spendDir: dir, runId: 'run-x', now });
    await guard.recordAndPersist({ model: 'claude-opus-5-5', bucket: 'assert', inputTokens: 100_000, outputTokens: 10_000 }); // 0.4 + 0.2 = $0.60
    const raw = JSON.parse(await readFile(path.join(dir, 'daily-spend.json'), 'utf8'));
    expect(raw.days['2026-11-13'].spentUsd).toBeCloseTo(0.6, 6);
  });
});

const tinyPng = PNG.sync.write(new PNG({ width: 4, height: 4 }));
function obs(capture: number): Observation {
  return {
    capture,
    url: 'http://app.local/',
    title: 'App',
    lang: 'en',
    dir: 'ltr',
    viewport: { width: 1280, height: 800 },
    nodes: [{ ref: `c${capture}e1`, role: 'heading', name: 'Ready', depth: 0, box: { x: 0, y: 0, width: 10, height: 10 }, state: '', locator: '' }],
    truncated: false,
    png: tinyPng,
    capturedAt: new Date(),
  };
}

describe('AnthropicAgent spend guard, tiers, and server-side fallback off', () => {
  const stepPlan = parsePlan(
    { format: 'miqyas-plan', version: 1, id: 'p1', steps: [{ id: 's1', type: 'action', text: 'Click' }, { id: 'a1', type: 'assertion', text: "'Ready'" }] },
    'p1',
  );

  it('defaults to low tier (Haiku), supports tiers and custom endpoint metadata, and disables server-side fallback', async () => {
    const sentParams: Record<string, unknown>[] = [];
    const client = {
      beta: {
        messages: {
          create: async (params: Record<string, unknown>) => {
            sentParams.push(params);
            return {
              model: 'claude-haiku-5-5',
              content: [{ type: 'tool_use', id: 't1', name: 'step_done', input: { summary: 'ok' } }],
              stop_reason: 'tool_use',
              usage: { input_tokens: 100, output_tokens: 50 },
            };
          },
        },
      },
    } as unknown as Anthropic;

    const agent = new AnthropicAgent({ client, env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com/v1' } });
    expect(agent.info).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      effort: 'medium',
      tier: 'low',
      endpoint: 'https://proxy.example.com/v1',
      endpointHost: 'proxy.example.com',
    });

    await agent.act({
      plan: { id: 'p1', name: 'p1' },
      step: stepPlan.steps[0]!,
      history: [],
      observation: obs(1),
      scrub: (t) => t,
      rescan: () => [],
      execute: async () => ({ ok: true, message: 'ok', observation: obs(2) }),
    });

    expect(sentParams).toHaveLength(1);
    expect(sentParams[0]!.betas).toBeUndefined();
    expect(sentParams[0]!.fallbacks).toBeUndefined();
    expect(new AnthropicAgent({ client, tier: 'high' }).info.model).toBe('claude-opus-5-5');
    expect(new AnthropicAgent({ client, tier: 'high', model: 'claude-sonnet-5-5' }).info.model).toBe('claude-sonnet-5-5');
  });

  it('refuses calls before network send or payload log when SpendGuard pessimistic estimate exceeds cap', async () => {
    let calls = 0;
    const client = {
      beta: {
        messages: {
          create: async () => {
            calls++;
            return { model: 'claude-opus-5-5', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
          },
        },
      },
    } as unknown as Anthropic;
    const log: PayloadEntry[] = [];
    const spend = new SpendGuard({ runCapUsd: 0.05, spentTodayUsd: 0 });
    const agent = new AnthropicAgent({ client, tier: 'high', spend, log: (e) => log.push(e) });

    await expect(
      agent.judge({
        plan: { id: 'p1', name: 'p1' },
        step: stepPlan.steps[1]!,
        history: [],
        current: obs(1),
        scrub: (t) => t,
        rescan: () => [],
        lookAgain: async () => obs(2),
      }),
    ).rejects.toThrow(/budget cap/);

    expect(calls).toBe(0);
    expect(log).toHaveLength(0);
  });

  it('fails closed when API response omits usage metrics', async () => {
    const client = {
      beta: {
        messages: {
          create: async () => ({
            model: 'claude-haiku-5-5',
            content: [{ type: 'tool_use', id: 't1', name: 'step_done', input: { summary: 'ok' } }],
            stop_reason: 'tool_use',
          }),
        },
      },
    } as unknown as Anthropic;
    const spend = new SpendGuard({ runCapUsd: 1, spentTodayUsd: 0 });
    const agent = new AnthropicAgent({ client, spend });

    await expect(
      agent.act({
        plan: { id: 'p1', name: 'p1' },
        step: stepPlan.steps[0]!,
        history: [],
        observation: obs(1),
        scrub: (t) => t,
        rescan: () => [],
        execute: async () => ({ ok: true, message: 'ok', observation: obs(2) }),
      }),
    ).rejects.toThrow(AgentError);
  });
});
