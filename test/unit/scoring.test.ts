// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CorpusError, parseCorpusManifest, parseKnownFindings } from '../../src/proof-core/corpus.js';
import type { Finding } from '../../src/proof-core/findings.js';
import type { PlanResult } from '../../src/proof-core/ledger.js';
import type { MutationResult } from '../../src/proof-core/mutate.js';
import {
  appendBenchHistory,
  detectBenchRegressions,
  loadBenchHistory,
  scoreCorpus,
  toHistoryEntry,
} from '../../src/proof-core/scoring.js';

let tmp = '';

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-scoring-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function sampleManifest() {
  return parseCorpusManifest({
    version: 1,
    target: 'mini-shop',
    cleanTwin: {
      buildDir: 'corpus/fixtures/mini-shop-clean',
      knownFindings: 'corpus/fixtures/mini-shop-clean/known-findings.json',
    },
    seeds: [
      {
        id: 'a-flow',
        title: 'Broken checkout text',
        part: 'asserted',
        category: 'broken-flow',
        plan: 'p1',
        assertion: 'a1',
        mutation: { kind: 'string-swap', from: 'Pay', to: 'Nope' },
        probe: { measure: 'text', expectClean: 'Pay', expectSeed: 'Nope' },
      },
      {
        id: 'a-css',
        title: 'Hidden error box',
        part: 'asserted',
        category: 'css-visibility',
        plan: 'p1',
        assertion: 'a2',
        mutation: { kind: 'css', css: '.err{display:none}' },
        probe: { measure: 'height', selector: '.err' },
      },
      {
        id: 'a-rtl',
        title: 'RTL direction broken',
        part: 'asserted',
        category: 'layout-rtl',
        plan: 'p2',
        assertion: 'a1',
        mutation: { kind: 'css', css: 'body{direction:ltr}' },
        probe: { measure: 'left', selector: 'nav' },
      },
      {
        id: 'u-secret',
        title: 'Exposed AWS key',
        part: 'unasserted',
        category: 'secret-leak',
        blindTokens: ['AKIAIOSFODNN7EXAMPLE'],
        mutation: { kind: 'string-swap', from: 'Ready', to: 'AKIAIOSFODNN7EXAMPLE' },
        probe: { measure: 'text', expectClean: 'Ready', expectSeed: 'AKIAIOSFODNN7EXAMPLE' },
      },
      {
        id: 'u-runtime',
        title: 'Unhandled runtime crash',
        part: 'unasserted',
        category: 'runtime-error',
        blindTokens: ['CRASH_SENTINEL'],
        mutation: { kind: 'string-swap', from: 'Ready', to: 'CRASH_SENTINEL' },
        probe: { measure: 'text', expectClean: 'Ready', expectSeed: 'CRASH_SENTINEL' },
      },
      {
        id: 'r-secret-check',
        title: 'Readiness secret leak seed',
        part: 'readiness',
        category: 'secret-leak',
        readinessCheck: 'grade-1/secrets',
        mutation: { kind: 'string-swap', from: 'Ready', to: 'AKIAIOSFODNN7EXAMPLE' },
        probe: { measure: 'text', expectClean: 'Ready', expectSeed: 'AKIAIOSFODNN7EXAMPLE' },
      },
    ],
  });
}

function sampleKnownFindings() {
  return parseKnownFindings({
    version: 1,
    target: 'mini-shop',
    buildId: 'clean-v1',
    reviewedAt: '2026-11-13T10:00:00Z',
    reviewer: 'Kahf Labs',
    entries: [
      {
        id: 'kf-dev-banner',
        category: 'console-info',
        evidencePattern: 'Mock mode enabled',
        rationale: 'Expected fixture notice in clean build',
      },
    ],
  });
}

describe('per-part corpus scoring and regression history (#15)', () => {
  it('scores asserted, unasserted, readiness, and clean-twin false positives per category and per part without blending', () => {
    const manifest = sampleManifest();
    const known = sampleKnownFindings();

    const p1CodePlan: PlanResult = {
      planId: 'p1',
      name: 'p1',
      verdict: 'fail',
      counts: { assertions: 3, passed: 1, failed: 2, notChecked: 0, blocked: 0, unverified: 0 },
      entries: [
        {
          kind: 'assertion',
          stepId: 'a1',
          text: 'Pay shown',
          verdict: 'fail',
          method: 'code',
          observation: 'missing Pay',
          evidence: { screenshot: 'x.png', nodes: [], url: 'http://127.0.0.1/', capturedAt: '2026-11-13T10:00:00Z' },
          durationMs: 10,
        },
        {
          kind: 'assertion',
          stepId: 'a3',
          text: 'Error shown',
          verdict: 'fail',
          method: 'ai',
          observation: 'hidden',
          evidence: { screenshot: 'y.png', nodes: [], url: 'http://127.0.0.1/', capturedAt: '2026-11-13T10:00:00Z' },
          durationMs: 12,
        },
      ],
      durationMs: 22,
    };

    const assertedResults: MutationResult[] = [
      { id: 'a-flow', title: 'Broken checkout text', kind: 'string-swap', plan: 'p1', assertion: 'a1', outcome: 'detected', detail: '', caughtBy: ['a1'] },
      { id: 'a-css', title: 'Hidden error box', kind: 'css', plan: 'p1', assertion: 'a2', outcome: 'detected_elsewhere', detail: '', caughtBy: ['a3'] },
      { id: 'a-rtl', title: 'RTL direction broken', kind: 'css', plan: 'p2', assertion: 'a1', outcome: 'missed', detail: '', caughtBy: [] },
    ];

    const unassertedFindings = new Map<string, Finding[]>([
      [
        'u-secret',
        [
          {
            id: 'secret-leak-1',
            category: 'secret-leak',
            title: 'AWS Key',
            severity: 'critical',
            source: 'code',
            confirmed: true,
            evidence: 'AKIAIOSFODNN7EXAMPLE',
          },
        ],
      ],
      ['u-runtime', []],
    ]);

    const readinessRuns = [
      { seedId: 'r-secret-check', detected: true },
    ];

    const cleanFindings: Finding[] = [
      {
        id: 'clean-known',
        category: 'console-info',
        title: 'Mock notice',
        severity: 'info',
        source: 'code',
        confirmed: true,
        evidence: 'Mock mode enabled in fixture',
      },
      {
        id: 'clean-fp',
        category: 'a11y',
        title: 'Bogus noise',
        severity: 'low',
        source: 'code',
        confirmed: true,
        evidence: 'Unexpected contrast alert',
      },
    ];

    const score = scoreCorpus({
      manifest,
      knownFindings: known,
      asserted: { results: assertedResults, seedPlans: { 'a-flow': [p1CodePlan], 'a-css': [p1CodePlan] } },
      unasserted: { findingsBySeed: unassertedFindings },
      readiness: { runs: readinessRuns },
      cleanTwin: { findings: cleanFindings },
    });

    // No blended combined score key exists
    expect('overallScore' in score).toBe(false);

    // Asserted part: 2 killed (1 targeted + 1 detected_elsewhere) / 3 valid = 66.67%, code vs judge tracked separately!
    expect(score.parts.asserted.valid).toBe(3);
    expect(score.parts.asserted.killed).toBe(2);
    expect(score.parts.asserted.detectedTarget).toBe(1);
    expect(score.parts.asserted.detectedElsewhere).toBe(1);
    expect(score.parts.asserted.caughtByCode).toBe(1);
    expect(score.parts.asserted.caughtByJudge).toBe(1);
    expect(score.parts.asserted.score).toBeCloseTo(66.67, 1);
    expect(score.parts.asserted.sufficientSample).toBe(false);
    expect(score.parts.asserted.byCategory['css-visibility']?.detectedElsewhere).toBe(1);

    // Unasserted recall: 1 / 2 = 50%
    expect(score.parts.unasserted).toMatchObject({ planted: 2, detected: 1, missed: 1, recall: 50, sufficientSample: false });

    // Readiness per check: clean-twin a11y false positive doesn't dirty grade-1/secrets unless matched, or cleanTwinFalsePositives records total 1
    expect(score.parts.readiness.byCheck['grade-1/secrets']).toMatchObject({
      placed: 1,
      caught: 1,
      recall: 100,
      cleanTwinQuiet: true,
    });
    expect(score.cleanTwin).toMatchObject({
      totalFindings: 2,
      suppressedKnown: 1,
      falsePositives: 1,
      quiet: false,
      falsePositivesByCategory: { a11y: 1 },
    });
  });

  it('tracks baseline summaries and names regressions in history.jsonl', async () => {
    const manifest = sampleManifest();
    const known = sampleKnownFindings();

    const strong = scoreCorpus({
      manifest,
      knownFindings: known,
      asserted: {
        results: [
          { id: 'a-flow', title: 't', kind: 'string-swap', plan: 'p1', assertion: 'a1', outcome: 'detected', detail: '', caughtBy: ['a1'] },
          { id: 'a-css', title: 't', kind: 'css', plan: 'p1', assertion: 'a2', outcome: 'detected', detail: '', caughtBy: ['a2'] },
          { id: 'a-rtl', title: 't', kind: 'css', plan: 'p2', assertion: 'a1', outcome: 'detected', detail: '', caughtBy: ['a1'] },
        ],
      },
      unasserted: {
        findingsBySeed: new Map([
          ['u-secret', [{ id: 'f1', category: 'secret-leak', title: 'k', severity: 'critical', source: 'code', confirmed: true, evidence: 'x' }]],
          ['u-runtime', [{ id: 'f2', category: 'runtime-error', title: 'r', severity: 'high', source: 'code', confirmed: true, evidence: 'y' }]],
        ]),
      },
      readiness: { runs: [{ seedId: 'r-secret-check', detected: true }] },
      cleanTwin: { findings: [] },
    });

    const regressed = scoreCorpus({
      manifest,
      knownFindings: known,
      asserted: {
        results: [
          { id: 'a-flow', title: 't', kind: 'string-swap', plan: 'p1', assertion: 'a1', outcome: 'detected', detail: '', caughtBy: ['a1'] },
          { id: 'a-css', title: 't', kind: 'css', plan: 'p1', assertion: 'a2', outcome: 'missed', detail: '', caughtBy: [] },
          { id: 'a-rtl', title: 't', kind: 'css', plan: 'p2', assertion: 'a1', outcome: 'detected', detail: '', caughtBy: ['a1'] },
        ],
      },
      unasserted: {
        findingsBySeed: new Map([
          ['u-secret', []],
          ['u-runtime', []],
        ]),
      },
      readiness: { runs: [{ seedId: 'r-secret-check', detected: false }] },
      cleanTwin: {
        findings: [{ id: 'fp', category: 'a11y', title: 'noise', severity: 'low', source: 'code', confirmed: true, evidence: 'unexpected' }],
      },
    });

    const baselineEntry = toHistoryEntry({ bench: 'mini-shop', commit: 'abc1234', dryRun: false, score: strong });
    const regressedEntry = toHistoryEntry({ bench: 'mini-shop', commit: 'def5678', dryRun: false, score: regressed });

    const regressions = detectBenchRegressions(regressedEntry, baselineEntry);
    expect(regressions.length).toBeGreaterThanOrEqual(4);
    expect(regressions.map((r) => r.metric)).toEqual(
      expect.arrayContaining([
        'asserted.score',
        'asserted.category.css-visibility',
        'unasserted.recall',
        'readiness.check.grade-1/secrets',
        'cleanTwin.falsePositives',
      ]),
    );

    const historyFile = path.join(tmp, 'bench', 'history.jsonl');
    await appendBenchHistory(historyFile, baselineEntry);
    await appendBenchHistory(historyFile, { ...regressedEntry, regressions });
    const history = await loadBenchHistory(historyFile);
    expect(history).toHaveLength(2);
    expect(history[1]!.regressions?.some((r) => r.metric === 'asserted.category.css-visibility')).toBe(true);
  });

  it('flags readiness clean-twin noise using detector aliases, reports dual regressions, and wraps corrupt history lines in CorpusError', async () => {
    const manifest = parseCorpusManifest({
      version: 1,
      target: 'mini-shop',
      cleanTwin: { buildDir: 'clean', knownFindings: 'known.json' },
      seeds: [
        {
          id: 'r-a11y',
          title: 'Readiness a11y',
          part: 'readiness',
          category: 'accessibility',
          readinessCheck: 'grade-1/a11y',
          mutation: { kind: 'string-swap', from: 'Pay Now', to: 'Missing' },
          probe: { measure: 'text', expectClean: 'Pay Now', expectSeed: 'Missing' },
        },
      ],
    });
    const known = sampleKnownFindings();
    const quietBaseline = scoreCorpus({
      manifest,
      knownFindings: known,
      readiness: { runs: [{ seedId: 'r-a11y', detected: true }] },
      cleanTwin: { findings: [] },
    });
    const noisyDrop = scoreCorpus({
      manifest,
      knownFindings: known,
      readiness: { runs: [{ seedId: 'r-a11y', detected: false }] },
      cleanTwin: {
        findings: [{ id: 'fp-a11y', category: 'a11y', title: 'axe noise', severity: 'low', source: 'code', confirmed: true, evidence: 'button-name' }],
      },
    });
    expect(noisyDrop.parts.readiness.byCheck['grade-1/a11y']).toMatchObject({
      cleanTwinQuiet: false,
      cleanTwinFalsePositives: 1,
      recall: 0,
    });
    const both = detectBenchRegressions(
      toHistoryEntry({ bench: 'mini-shop', commit: 'b', dryRun: false, score: noisyDrop }),
      toHistoryEntry({ bench: 'mini-shop', commit: 'a', dryRun: false, score: quietBaseline }),
    );
    expect(both.map((r) => r.metric)).toEqual(
      expect.arrayContaining(['readiness.check.grade-1/a11y', 'readiness.check.grade-1/a11y.cleanTwinQuiet']),
    );

    const corruptFile = path.join(tmp, 'corrupt.jsonl');
    await writeFile(corruptFile, '{"version":1}\n{not valid json\n', 'utf8');
    await expect(loadBenchHistory(corruptFile)).rejects.toThrow(CorpusError);
  });
});
