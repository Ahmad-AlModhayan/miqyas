// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { describe, expect, it } from 'vitest';
import { BENCHES, buildBenchSummary, costEstimate, renderBenchMarkdown, type BenchInput } from '../../src/proof-core/bench.js';
import type { PlanResult } from '../../src/proof-core/ledger.js';
import { summarize, type MutationResult } from '../../src/proof-core/mutate.js';
import { buildReport } from '../../src/proof-core/report.js';
import { testMethod } from '../report-helpers.js';

const bench = BENCHES['wasl-tray']!;

function plan(id: string, counts: Partial<PlanResult['counts']>, verdict: PlanResult['verdict']): PlanResult {
  return { planId: id, name: id, verdict, counts: { assertions: 0, passed: 0, failed: 0, notChecked: 0, blocked: 0, unverified: 0, ...counts }, entries: [], durationMs: 1000 };
}

const mutant = (id: string, outcome: MutationResult['outcome'], caughtBy: string[] = []): MutationResult => ({ id, title: id, kind: 'css', plan: `p-${id}`, assertion: 'a1', outcome, detail: '', caughtBy });

function input(over: { dryRun?: boolean; plans?: PlanResult[]; results?: MutationResult[]; model?: string; commit?: string } = {}): BenchInput {
  const dryRun = over.dryRun ?? false;
  const model = dryRun ? null : { provider: 'anthropic', model: over.model ?? 'claude-opus-5-5', effort: 'medium' };
  const run = buildReport({
    runId: 'r1',
    startedAt: new Date('2026-11-01T10:00:00Z'),
    finishedAt: new Date('2026-11-01T10:05:00Z'),
    url: 'http://127.0.0.1:5000/',
    dryRun,
    model,
    usage: dryRun ? { calls: 0, inputTokens: 0, outputTokens: 0 } : { calls: 40, inputTokens: 1_000_000, outputTokens: 50_000 },
    method: testMethod(),
    plans: over.plans ?? [plan('01', { assertions: 20, passed: 18, failed: 1, blocked: 1 }, 'fail'), plan('02', { assertions: 14, passed: 14 }, 'pass')],
  });
  const results = over.results ?? [mutant('m1', 'detected', ['a1']), mutant('m2', 'detected_elsewhere', ['a3']), mutant('m3', 'missed'), mutant('m4', 'ineffective')];
  return {
    bench,
    dryRun,
    startedAt: new Date('2026-11-01T10:00:00Z'),
    finishedAt: new Date('2026-11-01T10:12:30Z'),
    phasesMs: { export: 1000, build: 20_000, scrub: 500, run: 300_000, mutate: 400_000 },
    commit: over.commit ?? bench.commit,
    unchanged: true,
    scrub: { replaced: 58, files: 2, remaining: 0 },
    run,
    mutation: { summary: summarize('wasl-tray', results, { tool: 'TestSprite', detected: 3, of: 4, source: 'TestSprite evaluation' }), usage: dryRun ? null : { calls: 10, inputTokens: 250_000, outputTokens: 10_000 } },
    runs: { run: '.miqyas/bench/x/run', mutate: '.miqyas/bench/x/mutate' },
  };
}

describe('bench summary', () => {
  it('counts assertions written and with a verdict (pass or fail), and the rest apart', () => {
    const s = buildBenchSummary(input());
    expect(s.assertions).toEqual({ written: 34, withVerdict: 33, passed: 32, failed: 1, blocked: 1, unverified: 0, notChecked: 0 });
    expect(s.plans).toEqual({ total: 2, passed: 1, unresolved: 0 });
    expect(s.verdict).toBe('fail');
  });

  it('scores mutants the way Stryker does: killed ÷ valid, with not-effective mutants excluded', () => {
    const m = buildBenchSummary(input()).mutations;
    expect(m).toMatchObject({ total: 4, valid: 3, killed: 2, survived: 1, excluded: { ineffective: 1 }, caughtByTarget: 1 });
    expect(m.mutationScore).toBeCloseTo(66.67, 1);
    expect(m.results.map((r) => [r.id, r.caughtBy])).toEqual([['m1', ['a1']], ['m2', ['a3']], ['m3', []], ['m4', []]]);
    expect(m.baseline).toEqual({ tool: 'TestSprite', detected: 3, of: 4, source: 'TestSprite evaluation' });
  });

  it('counts valid mutants the same way as the mutation report, and shows valid and excluded beside the score', () => {
    const i = input({ results: [mutant('m1', 'detected', ['a1']), mutant('m2', 'missed'), mutant('m3', 'error'), mutant('m4', 'inconclusive')] });
    const s = buildBenchSummary(i);
    expect(s.mutations).toMatchObject({ valid: i.mutation.summary.valid, killed: 1, survived: 1, excluded: { error: 1, inconclusive: 1 }, mutationScore: 50 });
    expect(renderBenchMarkdown(s)).toContain('mutation score 50 % (1 killed of 2 valid; excluded: 1 error, 1 inconclusive).');
  });

  it('sums model calls and tokens over the run and the mutation run, and prices them', () => {
    const u = buildBenchSummary(input()).usage;
    expect(u).toMatchObject({ calls: 50, inputTokens: 1_250_000, outputTokens: 60_000, model: 'claude-opus-5-5' });
    expect(u.costUsd).toBeCloseTo(1.25 * 4 + 0.06 * 20, 6);
    expect(buildBenchSummary(input({ model: 'some-other-model' })).usage.costUsd).toBeNull();
  });

  it('prices each call at the model that answered it, when a fallback answered some', () => {
    const i = input();
    i.run.usage = { calls: 40, inputTokens: 1_000_000, outputTokens: 50_000, byModel: { 'claude-opus-5-5': { calls: 30, inputTokens: 500_000, outputTokens: 25_000 }, 'claude-sonnet-5-5': { calls: 10, inputTokens: 500_000, outputTokens: 25_000 } } };
    const u = buildBenchSummary(i).usage;
    expect(u.byModel).toEqual({ 'claude-opus-5-5': { calls: 40, inputTokens: 750_000, outputTokens: 35_000 }, 'claude-sonnet-5-5': { calls: 10, inputTokens: 500_000, outputTokens: 25_000 } });
    expect(u.costUsd).toBeCloseTo(0.75 * 4 + 0.035 * 20 + 0.5 * 2 + 0.025 * 10, 6);
    expect(renderBenchMarkdown(buildBenchSummary(i))).toContain('answered by claude-opus-5-5 40, claude-sonnet-5-5 10');
  });

  it('a dry run: 34 assertions written, none with a verdict, no score, no calls, no cost', () => {
    const s = buildBenchSummary(input({ dryRun: true, plans: [plan('01', { assertions: 34, notChecked: 34 }, 'fail')], results: [mutant('m1', 'not_run'), mutant('m2', 'not_run')] }));
    expect(s.verdict).toBe('dry_run');
    expect(s.assertions).toMatchObject({ written: 34, withVerdict: 0, notChecked: 34 });
    expect(s.mutations).toMatchObject({ valid: 0, mutationScore: null, excluded: { not_run: 2 } });
    expect(s.usage).toMatchObject({ calls: 0, costUsd: 0 });
    const md = renderBenchMarkdown(s);
    expect(md).toContain('**DRY RUN**');
    expect(md).toContain('| Assertions written | 34 |');
    expect(md).toContain('| Mutation score | n/a');
  });

  it('records the pinned commit, the export and the time per phase; the method block names the preset', () => {
    const s = buildBenchSummary(input());
    expect(s.source.commit).toBe('7704e0fd8a1383d820a2cd04c7f3636de36ee847');
    expect(s.source.export).toBe(`git -c core.autocrlf=false -c core.eol=lf -C <clone> archive ${bench.commit} desktop | tar -x -C <scratch>`);
    expect(s.wallMs).toBe(750_000);
    expect(s.method.preset).toBe('wasl-tray');
    const md = renderBenchMarkdown(s);
    expect(md).toContain('| Mutation score | 67 %: 2 killed of 3 valid (4 mutant(s); excluded: 1 not effective) |');
    expect(md).toContain('| Caught by the targeted assertion | 1 of 3 |');
    expect(md).toContain('| TestSprite, same mutants | 3 of 4 (TestSprite evaluation) |');
    expect(md).toContain('| Cost estimate | $6.20');
    expect(md).toContain('| m2 | p-m2 / a1 | detected_elsewhere | a3 |');
    expect(md).toContain('## Method');
  });

  it('with another commit, drops the pinned note and the baseline measured on the pinned build', () => {
    const s = buildBenchSummary(input({ commit: '1111111111111111111111111111111111111111' }));
    expect(s.source).toMatchObject({ pinned: false, commit: '1111111111111111111111111111111111111111' });
    expect(s.source.commitNote).toContain('given with --commit');
    expect(s.mutations.baseline).toBeUndefined();
    const md = renderBenchMarkdown(s);
    expect(md).not.toContain('TestSprite was measured on');
    expect(md).not.toContain('| TestSprite, same mutants');
    expect(buildBenchSummary(input()).source.pinned).toBe(true);
  });

  it('a dry run says which plans did not resolve', () => {
    const broken = { ...plan('02', { assertions: 14, notChecked: 14 }, 'error'), error: 'page.goto: net::ERR_CONNECTION_REFUSED' };
    const ok = { ...plan('01', { assertions: 20, notChecked: 20 }, 'fail'), error: 'dry run: plan resolved, nothing judged' };
    const s = buildBenchSummary(input({ dryRun: true, plans: [ok, broken], results: [] }));
    expect(s.plans.unresolved).toBe(1);
    const md = renderBenchMarkdown(s);
    expect(md).toContain('1 of 2 plan(s) did NOT resolve');
    expect(md).toContain('| Plans | 2, 1 did not resolve');
  });

  it('flags a clone that changed', () => {
    expect(renderBenchMarkdown(buildBenchSummary({ ...input(), unchanged: false }))).toContain('clone **CHANGED** after the run');
  });
});

describe('costEstimate', () => {
  it('uses list prices per million tokens', () => {
    expect(costEstimate('claude-opus-5-5', { calls: 1, inputTokens: 1e6, outputTokens: 1e6 })).toBe(24);
    expect(costEstimate(null, { calls: 0, inputTokens: 0, outputTokens: 0 })).toBeNull();
    // An unpriced model has no cost on file, even with no calls: null, never $0.00.
    expect(costEstimate('some-other-model', { calls: 0, inputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});

describe('corpus bench summary rendering (#15)', () => {
  it('renders per-part corpus scores and named regressions without blending', () => {
    const s = buildBenchSummary({
      ...input(),
      corpus: {
        tool: 'miqyas',
        kind: 'corpus-score',
        target: 'mini-shop',
        timestamp: '2026-11-13T12:00:00Z',
        sampleThreshold: { categoryValidMin: 10, partValidMin: 50 },
        parts: {
          asserted: {
            total: 2,
            valid: 2,
            killed: 1,
            survived: 1,
            excluded: 0,
            detectedTarget: 1,
            detectedElsewhere: 0,
            caughtByCode: 1,
            caughtByJudge: 0,
            score: 50,
            sufficientSample: false,
            byCategory: {
              'broken-flow': {
                total: 2,
                valid: 2,
                killed: 1,
                survived: 1,
                excluded: 0,
                detectedTarget: 1,
                detectedElsewhere: 0,
                caughtByCode: 1,
                caughtByJudge: 0,
                score: 50,
                sufficientSample: false,
              },
            },
          },
          unasserted: {
            planted: 1,
            detected: 1,
            missed: 0,
            confirmedCount: 1,
            unconfirmedCount: 0,
            recall: 100,
            sufficientSample: false,
            byCategory: {},
          },
          readiness: {
            placed: 1,
            caught: 1,
            recall: 100,
            checksTotal: 1,
            checksProven: 1,
            sufficientSample: false,
            byCheck: {
              'grade-1/secrets': { check: 'grade-1/secrets', placed: 1, caught: 1, recall: 100, cleanTwinQuiet: true, cleanTwinFalsePositives: 0 },
            },
            byCategory: {},
          },
        },
        cleanTwin: {
          totalFindings: 0,
          suppressedKnown: 0,
          falsePositives: 0,
          planFalseFailures: 0,
          quiet: true,
          falsePositivesByCategory: {},
        },
      },
      regressions: [
        { metric: 'asserted.category.broken-flow', baseline: 100, current: 50, delta: -50, detail: 'Asserted [broken-flow] dropped from 100% to 50%' },
      ],
    });
    const md = renderBenchMarkdown(s);
    expect(md).toContain('## Corpus Scores (Per-Part, Unblended)');
    expect(md).toContain('| Asserted | 50.0 % |');
    expect(md).toContain('| Unasserted | 100.0 % |');
    expect(md).toContain('| grade-1/secrets | 100.0 % | 1/1 | yes |');
    expect(md).toContain('## Regressions');
    expect(md).toContain('asserted.category.broken-flow');
  });
});
