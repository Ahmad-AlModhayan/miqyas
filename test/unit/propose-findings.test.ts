// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, ActContext, JudgeContext, PayloadEntry, ProposeFindingsContext, ProposedFinding } from '../../src/agents/agent.js';
import { OpenAIAgent } from '../../src/agents/openai.js';
import { parseProposedFindings } from '../../src/agents/protocol.js';
import { FindingsBudgetError, SpendGuard } from '../../src/agents/spend.js';
import { dedupeFindings } from '../../src/proof-core/findings.js';
import { runVerification } from '../../src/proof-core/orchestrator.js';
import { parsePlan } from '../../src/proof-core/plan.js';
import { buildReport } from '../../src/proof-core/report.js';
import { NO_SCRUB } from '../../src/scrub/scrub.js';
import type { Observation, SurfaceDriver, SurfaceSession } from '../../src/surfaces/session.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function obs(capture: number, url: string, text = 'Welcome'): Observation {
  return {
    capture,
    url,
    title: `Screen ${capture}`,
    lang: 'en',
    dir: 'ltr',
    viewport: { width: 1280, height: 800 },
    nodes: [
      {
        ref: `c${capture}e1`,
        role: 'heading',
        name: text,
        depth: 0,
        box: { x: 10, y: 10, width: 200, height: 30 },
        state: '',
        locator: `getByRole('heading', { name: '${text}' })`,
      },
    ],
    truncated: false,
    png: PNG,
    capturedAt: new Date('2026-11-13T10:00:00Z'),
  };
}

describe('capped unconfirmed model-proposed findings (FR-B10 / FR-B3)', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-propose-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('requires valid node refs and matching screenshot capture or drops proposals, and keeps them unconfirmed', () => {
    const o = obs(3, 'http://127.0.0.1:4173/checkout');
    const shown = new Set(['c3e1']);
    const parsed = parseProposedFindings(
      {
        findings: [
          {
            category: 'ux',
            title: 'Missing node citation',
            severity: 'medium',
            evidence: 'No node ref',
            evidence_refs: [],
            screenshot_capture: 3,
          },
          {
            category: 'ux',
            title: 'Bogus node ref',
            severity: 'high',
            evidence: 'Fake node',
            evidence_refs: ['c3e999'],
            screenshot_capture: 3,
          },
          {
            category: 'ux',
            title: 'Wrong screenshot capture',
            severity: 'high',
            evidence: 'Stale capture',
            evidence_refs: ['c3e1'],
            screenshot_capture: 2,
          },
          {
            category: 'layout',
            title: 'Truncated heading on SECRET_TOKEN screen',
            severity: 'low',
            evidence: 'Heading c3e1 overlaps container',
            evidence_refs: ['c3e1'],
            screenshot_capture: 3,
          },
        ],
      },
      o,
      shown,
      (s) => s.replaceAll('SECRET_TOKEN', '[scrubbed]'),
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      category: 'layout',
      title: 'Truncated heading on [scrubbed] screen',
      severity: 'low',
      confirmed: false,
      screenshotCapture: 3,
      nodes: [{ ref: 'c3e1', role: 'heading', name: 'Welcome' }],
    });
  });

  it('bills OpenAIAgent.proposeFindings to the findings bucket and throws FindingsBudgetError above 25% of run cap', async () => {
    const logs: PayloadEntry[] = [];
    // Run cap $0.20 -> findings cap $0.05 (25%). Pessimistic claude-opus-5-5 call > $0.05 or gpt-4o call:
    // Use SpendGuard with known priced model claude-sonnet-5-5 ($2/M in, $10/M out -> 16k output = $0.16 > $0.10 share).
    const spend = new SpendGuard({ runCapUsd: 0.4, spentTodayUsd: 0 }); // findingsCapUsd = $0.10
    let fetchCalls = 0;
    const agent = new OpenAIAgent({
      model: 'claude-sonnet-5-5',
      endpoint: 'https://api.example.test',
      apiKey: 'sk-test',
      spend,
      log: (e) => logs.push(e),
      fetchImpl: async () => {
        fetchCalls++;
        return new Response(
          JSON.stringify({
            model: 'claude-sonnet-5-5',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'tc1',
                      type: 'function',
                      function: {
                        name: 'propose_findings',
                        arguments: JSON.stringify({ findings: [] }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 100 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(
      agent.proposeFindings!({
        screenKey: 'screen-1',
        plan: { id: 'p1', name: 'P1' },
        step: { id: 'propose-1', text: 'Inspect screen' },
        observation: obs(1, 'http://127.0.0.1:4173/'),
        scrub: (t) => t,
        rescan: () => [],
      }),
    ).rejects.toThrow(FindingsBudgetError);
    expect(fetchCalls).toBe(0);
    expect(logs).toHaveLength(0);
  });

  it('calls proposeFindings at most once per screen and lets assertions finish when the 25% findings cap hits', async () => {
    const screen1 = obs(1, 'http://127.0.0.1:4173/one', 'Screen One');
    const screen2 = obs(2, 'http://127.0.0.1:4173/two', 'Screen Two');
    const spend = new SpendGuard({ runCapUsd: 1.0, spentTodayUsd: 0 }); // findingsCap = $0.25
    let proposedCalls = 0;
    let judgeCalls = 0;

    const agent: Agent = {
      info: { provider: 'mock', model: 'claude-haiku-4-5' },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      async act(_ctx: ActContext) {
        return { status: 'done', summary: 'ok' };
      },
      async judge(ctx: JudgeContext) {
        judgeCalls++;
        return { verdict: 'pass', observation: 'Verified', evidenceRefs: [ctx.current.nodes[0]!.ref] };
      },
      async proposeFindings(ctx: ProposeFindingsContext): Promise<ProposedFinding[]> {
        proposedCalls++;
        // First screen works, second hits FindingsBudgetError at SpendGuard (25% cap reached).
        if (proposedCalls >= 2) {
          throw new FindingsBudgetError('findings budget cap reached');
        }
        expect(spend.findingsCapUsd).toBe(0.25);
        return [
          {
            category: 'accessibility',
            title: 'Suspected low contrast text',
            severity: 'medium',
            confirmed: false,
            url: ctx.observation.url,
            evidence: 'Heading contrast looks faint',
            nodes: [
              {
                ref: ctx.observation.nodes[0]!.ref,
                role: ctx.observation.nodes[0]!.role,
                name: ctx.observation.nodes[0]!.name,
                box: ctx.observation.nodes[0]!.box,
              },
            ],
            screenshotCapture: ctx.observation.capture,
          },
        ];
      },
    };

    let sessionIndex = 0;
    const driver: SurfaceDriver = {
      surface: 'web',
      version: 'mock',
      async openSession(): Promise<SurfaceSession> {
        const current = sessionIndex++ === 0 ? screen1 : screen2;
        return {
          observe: async () => current,
          act: async () => ({ ok: true, message: 'ok', observation: current }),
          check: async () => ({ pass: true, observation: 'ok', nodes: current.nodes }),
          wait: async () => current,
          close: async () => {},
        };
      },
      async close() {},
    };

    const p1 = parsePlan(
      {
        format: 'miqyas-plan',
        version: 1,
        id: 'p1',
        steps: [
          { id: 'a1', type: 'assertion', text: 'One is shown' },
          { id: 'a2', type: 'assertion', text: 'One still shown on same screen' },
        ],
      },
      'p1',
    );
    const p2 = parsePlan(
      {
        format: 'miqyas-plan',
        version: 1,
        id: 'p2',
        steps: [{ id: 'a1', type: 'assertion', text: 'Two is shown' }],
      },
      'p2',
    );

    const result = await runVerification({
      runId: 'propose-budget-test',
      url: 'http://127.0.0.1:4173/one',
      plans: [p1, p2],
      runDir: tmp,
      driver,
      agent,
      spendGuard: spend,
      scrub: NO_SCRUB,
      scrubMethod: { file: null, sha256: null, terms: 0 },
      settings: { concurrency: 1, failOn: 'critical', proposeFindings: true },
    });

    // Screen 1 was observed across two assertions -> proposeFindings called at most once for screen 1,
    // once for screen 2 (which threw FindingsBudgetError), and NEVER prevented assertions from finishing!
    expect(proposedCalls).toBe(2);
    expect(judgeCalls).toBe(3);
    expect(result.verdict).toBe('pass');
    expect(result.report.totals.passed).toBe(3);
    expect(result.findings?.length).toBe(1);
    expect(result.findings![0]).toMatchObject({
      category: 'accessibility',
      source: 'model',
      confirmed: false,
      severity: 'medium',
    });
  });

  it('requires same-or-higher severity to corroborate model proposals and fails halted crawl-only reports', () => {
    const deduped = dedupeFindings([
      {
        id: 'a11y:1',
        category: 'a11y',
        title: 'Minor label note',
        severity: 'low',
        source: 'code',
        confirmed: true,
        url: 'http://127.0.0.1:4173/',
        evidence: 'Missing aria-label',
      },
      {
        id: 'a11y:2',
        category: 'a11y',
        title: 'Critical claim',
        severity: 'critical',
        source: 'model',
        confirmed: false,
        url: 'http://127.0.0.1:4173/',
        evidence: 'Model guessed critical issue',
      },
    ]);
    expect(deduped.find((f) => f.source === 'model')?.confirmed).toBe(false);

    const haltedReport = buildReport({
      runId: 'crawl-halted',
      startedAt: new Date('2026-11-13T10:00:00Z'),
      finishedAt: new Date('2026-11-13T10:00:01Z'),
      url: 'http://127.0.0.1:4173/',
      dryRun: false,
      model: null,
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      method: {
        versions: { miqyas: '0.1.0', node: '20.0.0', playwright: '1.50.0', browser: null },
        os: { platform: 'linux', release: '6.0.0', arch: 'x64' },
        model: null,
        settings: {
          concurrency: 1,
          viewport: { width: 1280, height: 800 },
          timeouts: { planMs: 60000, navigationMs: 10000, actionMs: 5000 },
          allowOtherOrigins: false,
          headed: false,
          crawl: true,
        },
        preset: null,
        scrub: { file: null, sha256: null, terms: 0 },
      },
      crawl: { screensVisited: 0, skippedControls: 0, skippedOffOriginLinks: 0, haltedReason: 'http-429' },
      plans: [],
    });
    expect(haltedReport.verdict).toBe('fail');
  });
});
