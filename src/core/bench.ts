// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Benchmarks: rebuild an app at a pinned commit, scrub it, run its plans and mutations, and sum it all up in one
// summary anyone can rerun. Terms follow the benchmark terms in docs/PRD.md: the mutation score is
// Stryker's, and every number here is a product KPI (our own plans and mutants), not a recognised benchmark suite.

import { excludedText, validity, type MutationSummary, type Outcome } from './mutate.js';
import { answeredBy, cell, code, renderMethod, TOOL_VERSION, type Method, type RunReport, type Usage } from './report.js';

export interface Bench {
  name: string;
  title: string;
  /** Default clone of the app, relative to the working directory. Read only: nothing is ever written inside it. */
  repo: string;
  /** The folder exported from the clone. */
  subdir: string;
  /** Default commit, and why it is the one. */
  commit: string;
  commitNote: string;
  /** Plans folder, relative to the Miqyas package. */
  plans: string;
  preset: string;
  scrub: string;
  /** `npm ci` arguments, then Vite arguments; NODE_ENV comes from the script, not a POSIX `VAR=x cmd` prefix. */
  build: { install: string[]; vite: string[]; env: Record<string, string>; outDir: string };
}

export const BENCHES: Record<string, Bench> = {
  'wasl-tray': {
    name: 'wasl-tray',
    title: "Wasl's tray window (dev mock)",
    repo: '../wasl',
    subdir: 'desktop',
    commit: '7704e0fd8a1383d820a2cd04c7f3636de36ee847',
    commitNote: 'the Wasl build TestSprite was measured on',
    plans: 'plans/wasl',
    preset: 'wasl-tray',
    scrub: 'wasl-scrub',
    build: {
      install: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      vite: ['build', '--mode', 'development', '--outDir', 'dist-mock', '--emptyOutDir'],
      env: { NODE_ENV: 'development' },
      outDir: 'dist-mock',
    },
  },
};

/** USD per million tokens, Anthropic's first-party list prices as of 2026-10-06. */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-fable-5-1': { input: 10, output: 50 },
};
export const PRICE_NOTE =
  "List prices of 2026-10-06; every input token at the uncached rate (Miqyas counts cache reads and writes as input), so it's an upper bound for input.";

/** Cost at list price, each call at the model that answered it (asked model when not recorded); null when a model
 * has no price on file. */
export function costEstimate(model: string | null, usage: Usage): number | null {
  let sum = 0;
  for (const [m, u] of Object.entries(byModel(model, usage))) {
    const p = PRICES[m];
    if (!p) return null;
    sum += (u.inputTokens * p.input + u.outputTokens * p.output) / 1e6;
  }
  return (model && PRICES[model]) || usage.byModel ? sum : null;
}

/** Usage by answering model; calls with no recorded model go to the asked one. */
function byModel(asked: string | null, u: Usage): NonNullable<Usage['byModel']> {
  if (u.byModel) return u.byModel;
  return u.calls && asked ? { [asked]: { calls: u.calls, inputTokens: u.inputTokens, outputTokens: u.outputTokens } } : {};
}

function addUsage(asked: string | null, ...us: Usage[]): Usage {
  const out: Usage & { byModel: NonNullable<Usage['byModel']> } = { calls: 0, inputTokens: 0, outputTokens: 0, byModel: {} };
  for (const u of us)
    for (const [m, x] of Object.entries(byModel(asked, u))) {
      const t = (out.byModel[m] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
      t.calls += x.calls;
      t.inputTokens += x.inputTokens;
      t.outputTokens += x.outputTokens;
    }
  for (const u of us) {
    out.calls += u.calls;
    out.inputTokens += u.inputTokens;
    out.outputTokens += u.outputTokens;
  }
  return out;
}

export interface BenchSummary {
  tool: 'miqyas';
  kind: 'bench';
  bench: string;
  version: string;
  dryRun: boolean;
  label: string;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  phasesMs: Record<'export' | 'build' | 'scrub' | 'run' | 'mutate', number>;
  /** `pinned`: the bench's default commit. Only then does the note apply and the baseline (measured on it) compare. */
  source: { subdir: string; commit: string; pinned: boolean; commitNote: string; export: string; build: string; unchanged: boolean };
  scrub: { replaced: number; files: number; remaining: number };
  verdict: RunReport['verdict'];
  /** `unresolved`: plans a dry run could not resolve or open (always 0 on a live run, where the verdicts say it). */
  plans: { total: number; passed: number; unresolved: number };
  assertions: { written: number; withVerdict: number; passed: number; failed: number; blocked: number; unverified: number; notChecked: number };
  mutations: {
    definition: string;
    total: number;
    valid: number;
    killed: number;
    survived: number;
    excluded: Partial<Record<Outcome, number>>;
    /** killed ÷ valid × 100; null when no mutant was valid (a dry run judges none). */
    mutationScore: number | null;
    /** The stricter count: the very assertion the mutant targets failed. */
    caughtByTarget: number;
    baseline?: MutationSummary['baseline'];
    results: { id: string; plan: string; assertion?: string; outcome: Outcome; caughtBy: string[] }[];
  };
  usage: Usage & { model: string | null; costUsd: number | null; priceNote: string };
  method: Method;
  runs: { run: string; mutate: string };
}

export interface BenchInput {
  bench: Bench;
  dryRun: boolean;
  startedAt: Date;
  finishedAt: Date;
  phasesMs: BenchSummary['phasesMs'];
  commit: string;
  unchanged: boolean;
  scrub: BenchSummary['scrub'];
  run: RunReport;
  mutation: { summary: MutationSummary; usage: Usage | null };
  /** Run folders, as they should appear in the summary (relative). */
  runs: BenchSummary['runs'];
}

export function buildBenchSummary(i: BenchInput): BenchSummary {
  const t = i.run.totals;
  const m = i.mutation.summary;
  const { killed, survived, excluded } = validity(m.results);
  const mu = i.mutation.usage ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
  const model = i.run.model?.model ?? null;
  const usage = addUsage(model, i.run.usage, mu);
  const b = i.bench;
  const pinned = i.commit === b.commit;
  const unresolved = i.dryRun ? i.run.plans.filter((p) => p.error && !p.error.startsWith('dry run')).length : 0;
  return {
    tool: 'miqyas',
    kind: 'bench',
    bench: b.name,
    version: TOOL_VERSION,
    dryRun: i.dryRun,
    label: 'Product KPI (docs/benchmarks.md): our plans and mutants on our app; the mutation score uses Stryker’s definition.',
    startedAt: i.startedAt.toISOString(),
    finishedAt: i.finishedAt.toISOString(),
    wallMs: i.finishedAt.getTime() - i.startedAt.getTime(),
    phasesMs: i.phasesMs,
    source: {
      subdir: b.subdir,
      commit: i.commit,
      pinned,
      commitNote: pinned ? b.commitNote : `given with --commit; the bench pins ${b.commit}, so the baseline isn't comparable and is left out`,
      export: `git -c core.autocrlf=false -c core.eol=lf -C <clone> archive ${i.commit} ${b.subdir} | tar -x -C <scratch>`,
      build: `npm ${b.build.install.join(' ')}; ${Object.entries(b.build.env).map(([k, v]) => `${k}=${v}`).join(' ')} vite ${b.build.vite.join(' ')}`,
      unchanged: i.unchanged,
    },
    scrub: i.scrub,
    verdict: i.run.verdict,
    plans: { total: t.plans, passed: t.plansPassed, unresolved },
    assertions: { written: t.assertions, withVerdict: t.passed + t.failed, passed: t.passed, failed: t.failed, blocked: t.blocked, unverified: t.unverified, notChecked: t.notChecked },
    mutations: {
      definition: 'Mutation score = killed ÷ valid × 100 (Stryker). Killed: an assertion failed on the mutant (detected, detected_elsewhere). Survived: the plan passed (missed). Excluded, as Stryker excludes invalid mutants: not effective, inconclusive (the plan fails on the clean build), run error, not run (dry run).',
      total: m.results.length,
      valid: killed + survived,
      killed,
      survived,
      excluded,
      mutationScore: killed + survived ? (killed / (killed + survived)) * 100 : null,
      caughtByTarget: m.detected,
      ...(m.baseline && pinned ? { baseline: m.baseline } : {}),
      results: m.results.map((r) => ({ id: r.id, plan: r.plan, ...(r.assertion ? { assertion: r.assertion } : {}), outcome: r.outcome, caughtBy: r.caughtBy })),
    },
    usage: { ...usage, model, costUsd: usage.calls ? costEstimate(model, usage) : 0, priceNote: PRICE_NOTE },
    method: { ...i.run.method, preset: m.preset },
    runs: i.runs,
  };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function renderBenchMarkdown(s: BenchSummary): string {
  const a = s.assertions;
  const m = s.mutations;
  const score = m.mutationScore === null ? 'n/a' : `${Math.round(m.mutationScore)} %`;
  const excluded = excludedText(m.excluded);
  // Named only where another model than the one asked answered some calls.
  const fallback = Object.keys(s.usage.byModel ?? {}).some((k) => k !== s.usage.model);
  // Every score carries its denominator, so 1 valid mutant can't pass for a full score.
  const scoreLine = `${score} (${m.killed} killed of ${m.valid} valid${excluded ? `; excluded: ${excluded}` : ''})`;
  const p = s.phasesMs;
  const lines = [
    `# Miqyas bench ${s.bench}${s.dryRun ? ' (dry run)' : ''}`,
    '',
    s.dryRun
      ? `**DRY RUN**: built, scrubbed, served, ${s.plans.unresolved ? `${s.plans.unresolved} of ${s.plans.total} plan(s) did NOT resolve` : 'plans resolved'} and mutations probed; no model call, so nothing was judged.` : `**${s.verdict.toUpperCase()}**: ${a.withVerdict} of ${a.written} assertions have a verdict; mutation score ${scoreLine}.`,
    '',
    `${s.label}`,
    '',
    '| | |',
    '|---|---|',
    `| Source | \`${s.source.subdir}/\` at \`${s.source.commit}\` (${cell(s.source.commitNote)}); clone ${s.source.unchanged ? 'unchanged' : '**CHANGED**'} after the run |`,
    `| Export | ${code(s.source.export)} |`,
    `| Build | ${code(s.source.build)} |`,
    `| Scrub | ${s.scrub.replaced} replacement(s) in ${s.scrub.files} file(s); re-scan ${s.scrub.remaining} hit(s) |`,
    `| Plans | ${s.plans.total}, ${s.dryRun ? (s.plans.unresolved ? `${s.plans.unresolved} did not resolve (see the run report)` : 'all resolved and opened') : `${s.plans.passed} passed`} |`,
    `| Assertions written | ${a.written} |`,
    `| With a verdict | ${a.withVerdict} (${a.passed} pass, ${a.failed} fail) |`,
    `| Without one | ${a.blocked} blocked, ${a.unverified} unverified, ${a.notChecked} not checked |`,
    `| Mutation score | ${score}: ${m.killed} killed of ${m.valid} valid (${m.total} mutant(s)${excluded ? `; excluded: ${excluded}` : ''}) |`,
    `| Caught by the targeted assertion | ${m.caughtByTarget} of ${m.valid} |`,
    ...(m.baseline ? [`| ${cell(m.baseline.tool)}, same mutants | ${m.baseline.detected} of ${m.baseline.of} (${cell(m.baseline.source)}) |`] : []),
    `| Model calls | ${s.usage.calls}${s.usage.model ? ` to ${s.usage.model}` : ''} (${s.usage.inputTokens} input, ${s.usage.outputTokens} output tokens)${fallback ? `; ${cell(answeredBy(s.usage))}` : ''} |`,
    `| Cost estimate | ${s.usage.costUsd === null ? 'no price on file for this model' : `$${s.usage.costUsd.toFixed(2)}`} (${cell(s.usage.priceNote)}) |`,
    `| Wall time | ${secs(s.wallMs)}: export ${secs(p.export)}, build ${secs(p.build)}, scrub ${secs(p.scrub)}, run ${secs(p.run)}, mutate ${secs(p.mutate)} |`,
    `| Raw runs | \`${s.runs.run}\`, \`${s.runs.mutate}\` (git-ignored, stay on this machine) |`,
    '',
    '## Mutations',
    '',
    m.definition,
    '',
    '| Mutant | Targets | Outcome | Caught by |',
    '|---|---|---|---|',
    ...m.results.map((r) => `| ${cell(r.id)} | ${cell(r.plan)}${r.assertion ? ` / ${r.assertion}` : ''} | ${r.outcome === 'ineffective' ? 'not effective' : r.outcome} | ${r.caughtBy.join(', ')} |`),
    '',
    ...renderMethod(s.method),
  ];
  return lines.join('\n');
}
