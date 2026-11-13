// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Per-part corpus scoring and regression tracking (FR-B12, #15).
// Scores asserted mutation-kill, blind unasserted recall, readiness checks,
// and clean-twin false positives separately without ever blending into one number.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  compileKnownPattern,
  CorpusError,
  type CorpusCategory,
  type CorpusManifest,
  type CorpusSeed,
  type KnownFindingsBaseline,
} from './corpus.js';
import type { Finding } from './findings.js';
import type { PlanResult } from './ledger.js';
import type { MutationResult } from './mutate.js';

export const CATEGORY_SAMPLE_MIN = 10;
export const PART_SAMPLE_MIN = 50;

export interface AssertedCategoryScore {
  total: number;
  valid: number;
  killed: number;
  survived: number;
  excluded: number;
  detectedTarget: number;
  detectedElsewhere: number;
  caughtByCode: number;
  caughtByJudge: number;
  score: number | null;
  sufficientSample: boolean;
}

export interface AssertedPartScore extends AssertedCategoryScore {
  byCategory: Record<string, AssertedCategoryScore>;
}

export interface UnassertedCategoryScore {
  planted: number;
  detected: number;
  missed: number;
  confirmedCount: number;
  unconfirmedCount: number;
  recall: number | null;
  sufficientSample: boolean;
}

export interface UnassertedPartScore extends UnassertedCategoryScore {
  byCategory: Record<string, UnassertedCategoryScore>;
}

export interface ReadinessCheckScore {
  check: string;
  placed: number;
  caught: number;
  recall: number | null;
  cleanTwinQuiet: boolean;
  cleanTwinFalsePositives: number;
}

export interface ReadinessCategoryScore {
  placed: number;
  caught: number;
  recall: number | null;
  sufficientSample: boolean;
}

export interface ReadinessPartScore {
  placed: number;
  caught: number;
  recall: number | null;
  checksTotal: number;
  checksProven: number;
  sufficientSample: boolean;
  byCheck: Record<string, ReadinessCheckScore>;
  byCategory: Record<string, ReadinessCategoryScore>;
}

export interface CleanTwinScore {
  totalFindings: number;
  suppressedKnown: number;
  falsePositives: number;
  planFalseFailures: number;
  quiet: boolean;
  falsePositivesByCategory: Record<string, number>;
}

export interface CorpusScoreReport {
  tool: 'miqyas';
  kind: 'corpus-score';
  target: string;
  timestamp: string;
  sampleThreshold: {
    categoryValidMin: number;
    partValidMin: number;
  };
  parts: {
    asserted: AssertedPartScore;
    unasserted: UnassertedPartScore;
    readiness: ReadinessPartScore;
  };
  cleanTwin: CleanTwinScore;
}

export interface ScoreCorpusInput {
  manifest: CorpusManifest;
  knownFindings: KnownFindingsBaseline;
  timestamp?: Date;
  asserted?: {
    results: MutationResult[];
    seedPlans?: Record<string, PlanResult[]>;
  };
  unasserted?: {
    findingsBySeed: Map<string, Finding[]> | Record<string, Finding[]>;
  };
  readiness?: {
    runs: { seedId: string; detected: boolean }[];
    cleanTwinByCheck?: Record<string, { quiet?: boolean; falsePositives?: number }>;
  };
  cleanTwin?: {
    findings: Finding[];
    planFalseFailures?: number;
  };
}

export interface BenchRegression {
  metric: string;
  baseline: number | boolean;
  current: number | boolean;
  delta?: number;
  detail: string;
}

export interface BenchHistoryEntry {
  version: 1;
  timestamp: string;
  bench: string;
  commit: string;
  dryRun: boolean;
  asserted: {
    score: number | null;
    valid: number;
    killed: number;
    caughtByCode: number;
    caughtByJudge: number;
    byCategory: Record<string, number | null>;
  };
  unasserted: {
    recall: number | null;
    planted: number;
    detected: number;
    byCategory: Record<string, number | null>;
  };
  readiness: {
    recall: number | null;
    placed: number;
    caught: number;
    checksProven: number;
    checksTotal: number;
    byCheck: Record<string, { recall: number | null; cleanTwinQuiet: boolean }>;
  };
  cleanTwin: {
    falsePositives: number;
    suppressedKnown: number;
    quiet: boolean;
  };
  regressions?: BenchRegression[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pct(num: number, den: number): number | null {
  return den > 0 ? round2((num / den) * 100) : null;
}

interface CompiledKnownEntry {
  category: string;
  evidenceRe: RegExp;
  urlRe?: RegExp;
}

const compiledBaselineCache = new WeakMap<KnownFindingsBaseline, CompiledKnownEntry[]>();

function getCompiledBaseline(baseline: KnownFindingsBaseline): CompiledKnownEntry[] {
  let cached = compiledBaselineCache.get(baseline);
  if (!cached) {
    cached = baseline.entries.map((entry, idx) => ({
      category: entry.category.toLowerCase(),
      evidenceRe: compileKnownPattern(entry.evidencePattern, `known-findings[${idx}].evidencePattern`),
      ...(entry.urlPattern
        ? { urlRe: compileKnownPattern(entry.urlPattern, `known-findings[${idx}].urlPattern`) }
        : {}),
    }));
    compiledBaselineCache.set(baseline, cached);
  }
  return cached;
}

/** Map `CorpusCategory` names to surface/propose detector category equivalents. */
export function matchesCorpusCategory(seedCategory: CorpusCategory, findingCategory: string): boolean {
  const fCat = findingCategory.toLowerCase();
  if (fCat === seedCategory.toLowerCase()) return true;
  switch (seedCategory) {
    case 'secret-leak':
      return fCat === 'secret-exposure';
    case 'accessibility':
      return fCat === 'a11y';
    case 'css-visibility':
      return fCat === 'clipping';
    case 'xss-injection':
      return fCat.includes('xss');
    case 'runtime-error':
      return fCat.includes('runtime') || fCat.includes('console') || fCat.includes('page-error') || fCat.includes('error');
    default:
      return false;
  }
}

/** Match a finding against a corpus seed via canonical category equivalents or blind tokens. */
export function seedMatchesFinding(seed: Pick<CorpusSeed, 'category' | 'blindTokens'>, f: Finding): boolean {
  if (matchesCorpusCategory(seed.category, f.category)) return true;
  const hay = `${f.evidence ?? ''} ${f.title ?? ''} ${f.url ?? ''}`.toLowerCase();
  return (seed.blindTokens ?? []).some((tok) => hay.includes(tok.toLowerCase()));
}

export function matchesKnownFinding(finding: Finding, baseline: KnownFindingsBaseline): boolean {
  const haystacks = [finding.evidence, finding.title].filter((v): v is string => Boolean(v));
  const fCat = finding.category.toLowerCase();
  for (const entry of getCompiledBaseline(baseline)) {
    if (entry.category !== fCat) continue;
    if (entry.urlRe && (!finding.url || !entry.urlRe.test(finding.url))) continue;
    if (haystacks.some((h) => entry.evidenceRe.test(h))) return true;
  }
  return false;
}

function classifyCatchSource(result: MutationResult, seedPlans?: Record<string, PlanResult[]>): 'code' | 'judge' | 'unknown' {
  const plans = seedPlans?.[result.id];
  if (!plans?.length || !result.caughtBy.length) return 'unknown';
  const ordered = [
    ...plans.filter((p) => p.planId === result.plan || p.name === result.plan),
    ...plans.filter((p) => p.planId !== result.plan && p.name !== result.plan),
  ];
  const caught = new Set(result.caughtBy);
  let sawAi = false;
  for (const plan of ordered) {
    for (const entry of plan.entries) {
      if (entry.kind !== 'assertion' || !caught.has(entry.stepId)) continue;
      if (entry.method === 'code') return 'code';
      if (entry.method === 'ai') sawAi = true;
    }
  }
  return sawAi ? 'judge' : 'unknown';
}

function emptyAssertedBucket(): AssertedCategoryScore {
  return {
    total: 0,
    valid: 0,
    killed: 0,
    survived: 0,
    excluded: 0,
    detectedTarget: 0,
    detectedElsewhere: 0,
    caughtByCode: 0,
    caughtByJudge: 0,
    score: null,
    sufficientSample: false,
  };
}

function finalizeAssertedBucket(b: AssertedCategoryScore, threshold: number): AssertedCategoryScore {
  return {
    ...b,
    score: pct(b.killed, b.valid),
    sufficientSample: b.valid >= threshold,
  };
}

function scoreAssertedPart(
  manifest: CorpusManifest,
  input?: ScoreCorpusInput['asserted'],
): AssertedPartScore {
  const seeds = manifest.seeds.filter((s) => s.part === 'asserted');
  const resultsById = new Map((input?.results ?? []).map((r) => [r.id, r]));
  const totalBucket = emptyAssertedBucket();
  const rawCats: Record<string, AssertedCategoryScore> = {};

  for (const seed of seeds) {
    const cat = (rawCats[seed.category] ??= emptyAssertedBucket());
    const r = resultsById.get(seed.id);
    if (!r) continue;
    totalBucket.total += 1;
    cat.total += 1;
    if (r.outcome === 'detected' || r.outcome === 'detected_elsewhere') {
      totalBucket.valid += 1;
      cat.valid += 1;
      totalBucket.killed += 1;
      cat.killed += 1;
      if (r.outcome === 'detected') {
        totalBucket.detectedTarget += 1;
        cat.detectedTarget += 1;
      } else {
        totalBucket.detectedElsewhere += 1;
        cat.detectedElsewhere += 1;
      }
      const src = classifyCatchSource(r, input?.seedPlans);
      if (src === 'code') {
        totalBucket.caughtByCode += 1;
        cat.caughtByCode += 1;
      } else if (src === 'judge') {
        totalBucket.caughtByJudge += 1;
        cat.caughtByJudge += 1;
      }
    } else if (r.outcome === 'missed') {
      totalBucket.valid += 1;
      cat.valid += 1;
      totalBucket.survived += 1;
      cat.survived += 1;
    } else {
      totalBucket.excluded += 1;
      cat.excluded += 1;
    }
  }

  const byCategory: Record<string, AssertedCategoryScore> = {};
  for (const [k, v] of Object.entries(rawCats)) {
    byCategory[k] = finalizeAssertedBucket(v, CATEGORY_SAMPLE_MIN);
  }
  return {
    ...finalizeAssertedBucket(totalBucket, PART_SAMPLE_MIN),
    byCategory,
  };
}

function readFindingsLookup(
  source?: Map<string, Finding[]> | Record<string, Finding[]>,
): Map<string, Finding[]> {
  if (!source) return new Map();
  if (source instanceof Map) return source;
  return new Map(Object.entries(source));
}

function scoreUnassertedPart(
  manifest: CorpusManifest,
  known: KnownFindingsBaseline,
  input?: ScoreCorpusInput['unasserted'],
): UnassertedPartScore {
  const seeds = manifest.seeds.filter((s) => s.part === 'unasserted');
  const lookup = readFindingsLookup(input?.findingsBySeed);
  const byCategory: Record<string, UnassertedCategoryScore> = {};
  let detected = 0;
  let missed = 0;
  let confirmedCount = 0;
  let unconfirmedCount = 0;

  const ensureCat = (c: string): UnassertedCategoryScore =>
    (byCategory[c] ??= {
      planted: 0,
      detected: 0,
      missed: 0,
      confirmedCount: 0,
      unconfirmedCount: 0,
      recall: null,
      sufficientSample: false,
    });

  for (const seed of seeds) {
    const bucket = ensureCat(seed.category);
    bucket.planted += 1;
    const raw = lookup.get(seed.id) ?? [];
    const novel = raw.filter((f) => !matchesKnownFinding(f, known));
    if (novel.length > 0) {
      detected += 1;
      bucket.detected += 1;
      if (novel.some((f) => f.confirmed)) {
        confirmedCount += 1;
        bucket.confirmedCount += 1;
      } else {
        unconfirmedCount += 1;
        bucket.unconfirmedCount += 1;
      }
    } else {
      missed += 1;
      bucket.missed += 1;
    }
  }

  for (const bucket of Object.values(byCategory)) {
    bucket.recall = pct(bucket.detected, bucket.planted);
    bucket.sufficientSample = bucket.planted >= CATEGORY_SAMPLE_MIN;
  }

  const planted = seeds.length;
  return {
    planted,
    detected,
    missed,
    confirmedCount,
    unconfirmedCount,
    recall: pct(detected, planted),
    sufficientSample: planted >= PART_SAMPLE_MIN,
    byCategory,
  };
}

function scoreCleanTwin(
  known: KnownFindingsBaseline,
  input?: ScoreCorpusInput['cleanTwin'],
): { summary: CleanTwinScore; falsePositiveFindings: Finding[] } {
  const findings = input?.findings ?? [];
  const planFalseFailures = input?.planFalseFailures ?? 0;
  let suppressedKnown = 0;
  const falsePositiveFindings: Finding[] = [];
  const falsePositivesByCategory: Record<string, number> = {};

  for (const f of findings) {
    if (matchesKnownFinding(f, known)) {
      suppressedKnown += 1;
    } else {
      falsePositiveFindings.push(f);
      falsePositivesByCategory[f.category] = (falsePositivesByCategory[f.category] ?? 0) + 1;
    }
  }

  const falsePositives = falsePositiveFindings.length + planFalseFailures;
  return {
    summary: {
      totalFindings: findings.length,
      suppressedKnown,
      falsePositives,
      planFalseFailures,
      quiet: falsePositives === 0,
      falsePositivesByCategory,
    },
    falsePositiveFindings,
  };
}

function scoreReadinessPart(
  manifest: CorpusManifest,
  falsePositiveFindings: Finding[],
  input?: ScoreCorpusInput['readiness'],
): ReadinessPartScore {
  const seeds = manifest.seeds.filter((s) => s.part === 'readiness');
  const runMap = new Map((input?.runs ?? []).map((r) => [r.seedId, r.detected]));
  const byCheckAccum: Record<string, { placed: number; caught: number; categories: Set<CorpusCategory> }> = {};
  const byCategory: Record<string, ReadinessCategoryScore> = {};
  let caught = 0;

  for (const seed of seeds) {
    const check = seed.readinessCheck ?? seed.category;
    const chk = (byCheckAccum[check] ??= { placed: 0, caught: 0, categories: new Set() });
    chk.placed += 1;
    chk.categories.add(seed.category);

    const cat = (byCategory[seed.category] ??= {
      placed: 0,
      caught: 0,
      recall: null,
      sufficientSample: false,
    });
    cat.placed += 1;

    if (runMap.get(seed.id)) {
      caught += 1;
      chk.caught += 1;
      cat.caught += 1;
    }
  }

  const byCheck: Record<string, ReadinessCheckScore> = {};
  let checksProven = 0;
  for (const [check, acc] of Object.entries(byCheckAccum)) {
    const override = input?.cleanTwinByCheck?.[check];
    const matchedFps = falsePositiveFindings.filter((f) =>
      [...acc.categories].some((cat) => matchesCorpusCategory(cat, f.category)),
    ).length;
    const cleanTwinFalsePositives = override?.falsePositives ?? (override?.quiet === false ? Math.max(1, matchedFps) : matchedFps);
    const cleanTwinQuiet = override?.quiet ?? cleanTwinFalsePositives === 0;
    const recall = pct(acc.caught, acc.placed);
    if (acc.placed > 0 && acc.caught === acc.placed && cleanTwinQuiet) {
      checksProven += 1;
    }
    byCheck[check] = {
      check,
      placed: acc.placed,
      caught: acc.caught,
      recall,
      cleanTwinQuiet,
      cleanTwinFalsePositives,
    };
  }

  for (const cat of Object.values(byCategory)) {
    cat.recall = pct(cat.caught, cat.placed);
    cat.sufficientSample = cat.placed >= CATEGORY_SAMPLE_MIN;
  }

  const placed = seeds.length;
  const checksTotal = Object.keys(byCheck).length;
  return {
    placed,
    caught,
    recall: pct(caught, placed),
    checksTotal,
    checksProven,
    sufficientSample: placed >= PART_SAMPLE_MIN,
    byCheck,
    byCategory,
  };
}

export function scoreCorpus(input: ScoreCorpusInput): CorpusScoreReport {
  const { summary: cleanTwin, falsePositiveFindings } = scoreCleanTwin(input.knownFindings, input.cleanTwin);
  return {
    tool: 'miqyas',
    kind: 'corpus-score',
    target: input.manifest.target,
    timestamp: (input.timestamp ?? new Date()).toISOString(),
    sampleThreshold: {
      categoryValidMin: CATEGORY_SAMPLE_MIN,
      partValidMin: PART_SAMPLE_MIN,
    },
    parts: {
      asserted: scoreAssertedPart(input.manifest, input.asserted),
      unasserted: scoreUnassertedPart(input.manifest, input.knownFindings, input.unasserted),
      readiness: scoreReadinessPart(input.manifest, falsePositiveFindings, input.readiness),
    },
    cleanTwin,
  };
}

export function toHistoryEntry(opts: {
  bench: string;
  commit: string;
  dryRun: boolean;
  score: CorpusScoreReport;
  timestamp?: Date;
  regressions?: BenchRegression[];
}): BenchHistoryEntry {
  const { score } = opts;
  const assertedCats: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(score.parts.asserted.byCategory)) {
    assertedCats[k] = v.score;
  }
  const unassertedCats: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(score.parts.unasserted.byCategory)) {
    unassertedCats[k] = v.recall;
  }
  const readinessChecks: Record<string, { recall: number | null; cleanTwinQuiet: boolean }> = {};
  for (const [k, v] of Object.entries(score.parts.readiness.byCheck)) {
    readinessChecks[k] = { recall: v.recall, cleanTwinQuiet: v.cleanTwinQuiet };
  }

  return {
    version: 1,
    timestamp: (opts.timestamp ?? new Date(score.timestamp)).toISOString(),
    bench: opts.bench,
    commit: opts.commit,
    dryRun: opts.dryRun,
    asserted: {
      score: score.parts.asserted.score,
      valid: score.parts.asserted.valid,
      killed: score.parts.asserted.killed,
      caughtByCode: score.parts.asserted.caughtByCode,
      caughtByJudge: score.parts.asserted.caughtByJudge,
      byCategory: assertedCats,
    },
    unasserted: {
      recall: score.parts.unasserted.recall,
      planted: score.parts.unasserted.planted,
      detected: score.parts.unasserted.detected,
      byCategory: unassertedCats,
    },
    readiness: {
      recall: score.parts.readiness.recall,
      placed: score.parts.readiness.placed,
      caught: score.parts.readiness.caught,
      checksProven: score.parts.readiness.checksProven,
      checksTotal: score.parts.readiness.checksTotal,
      byCheck: readinessChecks,
    },
    cleanTwin: {
      falsePositives: score.cleanTwin.falsePositives,
      suppressedKnown: score.cleanTwin.suppressedKnown,
      quiet: score.cleanTwin.quiet,
    },
    ...(opts.regressions?.length ? { regressions: opts.regressions } : {}),
  };
}

function pushDropRegression(
  out: BenchRegression[],
  metric: string,
  baseline: number | null | undefined,
  current: number | null | undefined,
  label: string,
): void {
  if (typeof baseline !== 'number' || typeof current !== 'number') return;
  if (current < baseline) {
    out.push({
      metric,
      baseline,
      current,
      delta: round2(current - baseline),
      detail: `${label} dropped from ${baseline}% to ${current}%`,
    });
  }
}

export function detectBenchRegressions(
  current: BenchHistoryEntry,
  baseline: BenchHistoryEntry,
): BenchRegression[] {
  const regressions: BenchRegression[] = [];

  pushDropRegression(regressions, 'asserted.score', baseline.asserted.score, current.asserted.score, 'Asserted score');
  for (const [cat, baseVal] of Object.entries(baseline.asserted.byCategory)) {
    pushDropRegression(regressions, `asserted.category.${cat}`, baseVal, current.asserted.byCategory[cat], `Asserted [${cat}]`);
  }

  pushDropRegression(regressions, 'unasserted.recall', baseline.unasserted.recall, current.unasserted.recall, 'Unasserted recall');
  for (const [cat, baseVal] of Object.entries(baseline.unasserted.byCategory)) {
    pushDropRegression(regressions, `unasserted.category.${cat}`, baseVal, current.unasserted.byCategory[cat], `Unasserted [${cat}]`);
  }

  pushDropRegression(regressions, 'readiness.recall', baseline.readiness.recall, current.readiness.recall, 'Readiness recall');
  for (const [chk, baseChk] of Object.entries(baseline.readiness.byCheck)) {
    const curChk = current.readiness.byCheck[chk];
    if (!curChk) continue;
    pushDropRegression(
      regressions,
      `readiness.check.${chk}`,
      baseChk.recall,
      curChk.recall,
      `Readiness check "${chk}" recall`,
    );
    if (baseChk.cleanTwinQuiet && !curChk.cleanTwinQuiet) {
      regressions.push({
        metric: `readiness.check.${chk}.cleanTwinQuiet`,
        baseline: true,
        current: false,
        detail: `Readiness check "${chk}" became noisy on the clean twin`,
      });
    }
  }

  if (current.cleanTwin.falsePositives > baseline.cleanTwin.falsePositives) {
    regressions.push({
      metric: 'cleanTwin.falsePositives',
      baseline: baseline.cleanTwin.falsePositives,
      current: current.cleanTwin.falsePositives,
      delta: current.cleanTwin.falsePositives - baseline.cleanTwin.falsePositives,
      detail: `Clean-twin false positives increased from ${baseline.cleanTwin.falsePositives} to ${current.cleanTwin.falsePositives}`,
    });
  }

  return regressions;
}

export async function appendBenchHistory(historyPath: string, entry: BenchHistoryEntry): Promise<void> {
  await mkdir(path.dirname(historyPath), { recursive: true });
  await appendFile(historyPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function loadBenchHistory(historyPath: string): Promise<BenchHistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(historyPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new CorpusError(`could not read bench history (${historyPath}): ${(err as Error).message}`);
  }
  const entries: BenchHistoryEntry[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as BenchHistoryEntry);
    } catch (err) {
      throw new CorpusError(`corrupt bench history at ${historyPath}:${i + 1}: ${(err as Error).message}`);
    }
  }
  return entries;
}
