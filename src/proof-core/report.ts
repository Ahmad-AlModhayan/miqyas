// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Run reports: JSON (the ledger, machine-readable) and Markdown (for people). Same data, two renderings.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import type { ModelInfo, Usage } from '../agents/agent.js';
import { costEstimate } from '../agents/models.js';
import type { RunQuote, SpendGuard } from '../agents/spend.js';
import { PLAYWRIGHT_VERSION } from '../surfaces/web/driver.js';
import type { FailOnThreshold, Finding } from './findings.js';
import { findingsExceedThreshold } from './findings.js';
import { countEntries, reportPath, runVerdict, type PlanCounts, type PlanResult, type RunVerdict } from './ledger.js';
import type { ReadinessProfile, ReadinessReport } from './readiness.js';

export type { ModelInfo, Usage } from '../agents/agent.js';

/** From package.json: src/proof-core and dist/proof-core both sit two levels below it. */
export const TOOL_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

/** "answered by claude-opus-5-5 3, claude-sonnet-5-5 1", or '' when no call recorded its model. */
export function answeredBy(u: Usage): string {
  const e = Object.entries(u.byModel ?? {});
  return e.length ? `answered by ${e.map(([m, x]) => `${m} ${x.calls}`).join(', ')}` : '';
}

/** Model text is scrubbed and re-scanned before each call; in screenshots only typed secrets are masked (M1). */
export const SCREENSHOTS = {
  secretsMasked: true,
  redacted: false,
  note: 'Typed secrets were masked on the page before each screenshot; other screenshot content was sent to the model as captured, not redacted; only the served build was scrubbed.',
} as const;

export interface AdapterMethodInfo {
  id: string;
  version: string | null;
  coverage: string;
  status: 'ok' | 'skipped' | 'error';
  detail?: string;
}

/** How a run was made, so anyone can reproduce it. Records the scrub rules file and its hash, never the terms. */
export interface Method {
  versions: { miqyas: string; node: string; playwright: string; browser: string | null };
  os: { platform: string; release: string; arch: string };
  model: (ModelInfo & { maxTokens: number; maxTurns: number }) | null;
  settings: {
    concurrency: number;
    viewport: { width: number; height: number };
    timeouts: { planMs: number; navigationMs: number; actionMs: number };
    allowOtherOrigins: boolean;
    headed: boolean;
    strict?: boolean;
    failOn?: FailOnThreshold;
    crawl?: boolean;
    maxScreens?: number;
    maxDepth?: number;
    maxRps?: number;
    maxTimeMs?: number;
    active?: boolean;
    allowWrites?: boolean;
    allowHost?: string;
    profile?: ReadinessProfile;
    repoProvided?: boolean;
    noModel?: boolean;
  };
  /** The mutation preset; null for a plain run. */
  preset: string | null;
  scrub: { file: string | null; sha256: string | null; terms: number };
  adapters?: AdapterMethodInfo[];
}

/** The parts of the method block that come from this machine. */
export function environment(browser: string | null): Pick<Method, 'versions' | 'os'> {
  return {
    versions: { miqyas: TOOL_VERSION, node: process.versions.node, playwright: PLAYWRIGHT_VERSION, browser },
    os: { platform: process.platform, release: os.release(), arch: process.arch },
  };
}

export interface SpendReport {
  currency: 'USD';
  capUsd: number | null;
  dailyCapUsd: number;
  dailySpentBeforeUsd: number;
  quote: {
    likelyUsd: number | null;
    worstCaseUsd: number | null;
    priceDate: string;
    stalePriceTable: boolean;
  } | null;
  actualUsd: number | null;
}

export function buildSpendReport(opts: {
  spendGuard?: SpendGuard | undefined;
  quote?: RunQuote | undefined;
  model: ModelInfo | null;
  usage: Usage | null;
  noModel?: boolean;
}): SpendReport | undefined {
  if (!opts.spendGuard && !opts.quote) return undefined;
  const actualUsd = opts.noModel
    ? 0
    : opts.spendGuard
      ? Math.round(opts.spendGuard.actualUsd * 1_000_000) / 1_000_000
      : opts.model && opts.usage
        ? costEstimate(opts.model.model, opts.usage)
        : null;
  return {
    currency: 'USD',
    capUsd: opts.spendGuard?.runCapUsd ?? (opts.noModel ? 0 : null),
    dailyCapUsd: opts.spendGuard?.dailyCapUsd ?? opts.quote?.dailyCapUsd ?? 20,
    dailySpentBeforeUsd: opts.spendGuard?.spentTodayUsd ?? opts.quote?.spentTodayUsd ?? 0,
    quote: opts.quote
      ? {
          likelyUsd: opts.quote.likelyUsd,
          worstCaseUsd: opts.quote.worstCaseUsd,
          priceDate: opts.quote.priceDate,
          stalePriceTable: opts.quote.stalePriceTable,
        }
      : null,
    actualUsd,
  };
}

export interface CrawlReportSummary {
  screensVisited: number;
  skippedControls: number;
  skippedOffOriginLinks: number;
  haltedReason?: 'http-429' | 'http-503' | 'captcha-or-waf' | 'max-screens';
}

export interface RunReport {
  tool: 'miqyas';
  version: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  target: { url: string };
  dryRun: boolean;
  model: ModelInfo | null;
  /** `dry_run` when nothing was judged: a dry run never reads as a pass. */
  verdict: RunVerdict | 'dry_run';
  totals: PlanCounts & { plans: number; plansPassed: number };
  usage: Usage;
  spend?: SpendReport;
  method: Method;
  screenshots: typeof SCREENSHOTS;
  crawl?: CrawlReportSummary;
  readiness?: ReadinessReport;
  plans: PlanResult[];
  findings?: Finding[];
}

export function buildReport(input: {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  url: string;
  dryRun: boolean;
  model: ModelInfo | null;
  usage: Usage;
  spend?: SpendReport;
  method: Method;
  plans: PlanResult[];
  crawl?: CrawlReportSummary;
  readiness?: ReadinessReport;
  findings?: Finding[];
  failOn?: FailOnThreshold;
  reportBases?: readonly string[];
}): RunReport {
  const plans = input.plans.map((p) => (p.file ? { ...p, file: reportPath(p.file, input.reportBases) } : p));
  const totals = { plans: plans.length, plansPassed: 0, ...countEntries([]) };
  for (const p of plans) {
    if (p.verdict === 'pass') totals.plansPassed++;
    totals.assertions += p.counts.assertions;
    totals.passed += p.counts.passed;
    totals.failed += p.counts.failed;
    totals.notChecked += p.counts.notChecked;
    totals.blocked += p.counts.blocked;
    totals.unverified += p.counts.unverified;
    totals.modelOnly = (totals.modelOnly ?? 0) + (p.counts.modelOnly ?? 0);
  }
  const failOn = input.failOn ?? input.method.settings.failOn;
  const crawlHaltedEarly = Boolean(input.crawl?.haltedReason && input.crawl.haltedReason !== 'max-screens');
  const ledgerVerdict =
    plans.length === 0 && input.method.settings.crawl
      ? (crawlHaltedEarly ? 'fail' : 'pass')
      : runVerdict(plans);
  const failedByFindings =
    !input.dryRun &&
    ledgerVerdict === 'pass' &&
    findingsExceedThreshold(input.findings ?? [], failOn).length > 0;
  return {
    tool: 'miqyas',
    version: TOOL_VERSION,
    runId: input.runId,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    target: { url: input.url },
    dryRun: input.dryRun,
    model: input.model,
    verdict: input.dryRun ? 'dry_run' : crawlHaltedEarly || failedByFindings ? 'fail' : ledgerVerdict,
    totals,
    usage: input.usage,
    ...(input.spend ? { spend: input.spend } : {}),
    method: input.method,
    screenshots: SCREENSHOTS,
    ...(input.crawl ? { crawl: input.crawl } : {}),
    ...(input.readiness ? { readiness: input.readiness } : {}),
    plans,
    ...(input.findings?.length ? { findings: input.findings } : {}),
  };
}

/** Escape text for a Markdown table cell. Page text lands here too, so markdown and HTML in it show literally. */
export function cell(s: string): string {
  return s.replace(/[\\`*_[\]<>&~|]/g, '\\$&').replace(/\r?\n/g, ' ').trim();
}

/** Text as a code span in a table cell: only pipes need escaping there, and backslashes would show. */
export function code(s: string): string {
  return `\`${s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()}\``;
}

const MARK: Record<string, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  error: 'ERROR',
  not_checked: 'NOT CHECKED',
  blocked: 'BLOCKED',
  unverified: 'UNVERIFIED',
  dry_run: 'DRY RUN',
  done: 'done',
  failed: 'FAILED',
};

function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'n/a';
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function formatSpendSummary(s: SpendReport): string {
  const q = s.quote;
  const qText = q ? `quote likely ${fmtUsd(q.likelyUsd)} / worst ${fmtUsd(q.worstCaseUsd)}; ` : '';
  return `${qText}cap ${fmtUsd(s.capUsd)}; actual ${fmtUsd(s.actualUsd)} (today before ${fmtUsd(s.dailySpentBeforeUsd)} / $${s.dailyCapUsd.toFixed(2)})`;
}

export function renderReadinessMarkdown(r: ReadinessReport): string[] {
  const lines: string[] = ['## Readiness', '', `**${cell(r.summary)}**`, ''];
  for (const pillar of r.pillars) {
    lines.push(`### ${cell(pillar.name)} (${pillar.passed}/${pillar.total} pass)`);
    const pChecks = r.checks.filter((c) => c.pillar === pillar.id);
    if (pChecks.length === 0) {
      lines.push('', pillar.applicableAtGrade ? '_No checks assigned._' : '_Starts at Grade 2._', '');
      continue;
    }
    lines.push('', '| Check | Mode | Verdict | Coverage | Evidence | Notes |', '|---|---|---|---|---|---|');
    for (const c of pChecks) {
      const ev = c.observation || c.reason || '';
      const notes = [c.securityNotice ?? '', c.whatToAdd ? `Add: ${c.whatToAdd}` : ''].filter(Boolean).join('; ');
      lines.push(
        `| ${c.number}. ${cell(c.title)} | ${c.mode} | ${MARK[c.verdict] ?? c.verdict} | ${cell(c.coverage)} | ${cell(ev)} | ${cell(notes)} |`,
      );
    }
    lines.push('');
  }
  if (r.whatToAdd.length > 0) {
    lines.push('### What to add', '');
    for (const item of r.whatToAdd) {
      lines.push(`- ${cell(item)}`);
    }
    lines.push('');
  }
  return lines;
}

export function renderMarkdown(r: RunReport): string {
  const t = r.totals;
  const lines: string[] = [];
  const failOnHits = findingsExceedThreshold(r.findings ?? [], r.method.settings.failOn).length;
  const failOnNote = failOnHits > 0 ? ` Failed by \`--fail-on ${r.method.settings.failOn}\` (${failOnHits} confirmed finding(s) at or above threshold).` : '';
  lines.push(`# Miqyas run ${r.runId}`, '');
  if (r.readiness) {
    lines.push(`**${cell(r.readiness.summary)}**`, '');
  }
  lines.push(r.dryRun ? `**DRY RUN**: no assertion was judged (${t.notChecked} not checked); ${t.plans} plan(s) resolved and opened.` : `**${MARK[r.verdict]}**: ${t.plansPassed} of ${t.plans} plans passed; ${t.passed} of ${t.assertions} assertions have a recorded pass.${failOnNote}`, '');
  lines.push('| | |', '|---|---|');
  lines.push(`| Target | ${cell(r.target.url)} |`);
  lines.push(`| Model | ${r.model ? cell(`${r.model.provider} ${r.model.model}${r.model.effort ? ` (effort ${r.model.effort})` : ''}`) : 'none'} |`);
  lines.push(`| Started | ${r.startedAt} |`);
  lines.push(`| Finished | ${r.finishedAt} |`);
  const modelOnlySuffix = (t.modelOnly ?? 0) > 0 ? `, ${t.modelOnly} model-only` : '';
  lines.push(`| Assertions | ${t.assertions}: ${t.passed} pass${modelOnlySuffix}, ${t.failed} fail, ${t.unverified} unverified, ${t.blocked} blocked, ${t.notChecked} not checked |`);
  lines.push(`| Model calls | ${r.usage.calls} (${r.usage.inputTokens} input, ${r.usage.outputTokens} output tokens)${r.usage.byModel ? `; ${cell(answeredBy(r.usage))}` : ''} |`);
  if (r.spend) lines.push(`| Spend | ${formatSpendSummary(r.spend)} |`);
  lines.push(`| Screenshots | ${r.screenshots.note} |`, '');
  lines.push('A plan passes only when every assertion has a recorded pass with evidence. Unverified, blocked and not checked count as failures.', '');
  if (r.readiness) {
    lines.push(...renderReadinessMarkdown(r.readiness));
  }
  lines.push(...renderMethod(r.method));

  lines.push('## Plans', '', '| Plan | Verdict | Assertions passed | Time |', '|---|---|---|---|');
  for (const p of r.plans)
    lines.push(`| ${cell(p.planId)} | ${r.dryRun ? 'DRY' : MARK[p.verdict]} | ${p.counts.passed} / ${p.counts.assertions} | ${(p.durationMs / 1000).toFixed(1)} s |`);
  lines.push('');

  for (const p of r.plans) {
    lines.push(`## ${cell(p.planId)}: ${cell(p.name)}`, '');
    const fileLabel = p.file ? reportPath(p.file) : '';
    lines.push(`**${MARK[r.dryRun ? r.verdict : p.verdict]}**${fileLabel ? ` · ${code(fileLabel)}` : ''}`, '');
    if (p.error) lines.push(`Run error: ${cell(p.error)}`, '');
    lines.push('| Step | Type | Result | Method | What was seen | Evidence |', '|---|---|---|---|---|---|');
    for (const e of p.entries) {
      if (e.kind === 'action') {
        const did = e.actions.map((a) => (a.locator ? `${a.tool} ${a.locator}` : a.tool)).join('; ');
        const unmasked = [...new Set(e.actions.flatMap((a) => (a.unmasked ? [a.unmasked] : [])))].join('; ');
        lines.push(`| ${cell(e.stepId)} | action: ${cell(e.text)} | ${MARK[e.status]} | | ${cell(e.summary)}${did ? ` (${cell(did)})` : ''} | ${cell(unmasked)} |`);
      } else {
        const seen = [e.observation, e.modelOnly ? '(model-only)' : '', e.reason ? `(${e.reason})` : ''].filter(Boolean).join(' ');
        // Our evidence links stay links; the node names and the rest come from the page and are escaped.
        const ev = e.evidence
          ? [e.evidence.crop ? `[crop](${e.evidence.crop})` : '', e.evidence.screenshot ? `[screen](${e.evidence.screenshot})` : '', cell(e.evidence.nodes.map((n) => `${n.role} "${n.name}"`).join(', ')), cell(e.evidence.unmasked ?? '')]
              .filter(Boolean)
              .join(' · ')
          : '';
        lines.push(`| ${cell(e.stepId)} | assertion: ${cell(e.text)} | ${MARK[e.verdict]} | ${e.method} | ${cell(seen)} | ${ev} |`);
      }
    }
    lines.push('');
  }
  if (r.crawl) {
    lines.push(
      '## Crawl',
      '',
      `- Screens visited: ${r.crawl.screensVisited}`,
      `- Controls skipped (forms / destructive): ${r.crawl.skippedControls}`,
      `- Off-origin links skipped: ${r.crawl.skippedOffOriginLinks}`,
      ...(r.crawl.haltedReason ? [`- Halted: ${cell(r.crawl.haltedReason)}`] : []),
      '',
    );
  }
  if (r.findings?.length) {
    lines.push('## Findings', '', '| ID | Severity | Category | Source | URL | Evidence |', '|---|---|---|---|---|---|');
    for (const f of r.findings) {
      const sourceLabel = `${f.source}${f.confirmed ? '' : ' (unconfirmed)'}`;
      lines.push(`| ${cell(f.id)} | ${f.severity} | ${cell(f.category)} | ${sourceLabel} | ${cell(f.url ?? '')} | ${cell(f.evidence)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatMethodModel(m: NonNullable<Method['model']>): string {
  const parts = [
    `${m.provider} ${m.model}${m.effort ? `, effort ${m.effort}` : ''}`,
    `max ${m.maxTokens} tokens per reply`,
    `${m.maxTurns} turns per action`,
  ];
  if (m.tier) parts.push(`tier ${m.tier}`);
  if (m.endpoint) parts.push(`endpoint ${m.endpointHost && m.endpointHost !== 'api.anthropic.com' ? `${m.endpoint} (host ${m.endpointHost})` : m.endpoint}`);
  if (m.replay) parts.push(`replay ${m.replay.cassette} (${m.replay.hits} hits, ${m.replay.misses} misses, ${m.replay.imageMismatches} visual mismatch(es))`);
  return cell(parts.join(', '));
}

function formatMethodAdapters(adapters: readonly AdapterMethodInfo[]): string {
  return cell(
    adapters
      .map((a) => `${a.id} ${a.version ?? 'not installed'} (${a.status}; ${a.coverage})`)
      .join('; '),
  );
}

/** The method section, shared by run and mutation reports. */
export function renderMethod(m: Method): string[] {
  const v = m.versions;
  const s = m.settings;
  const t = s.timeouts;
  return [
    '## Method',
    '',
    '| | |',
    '|---|---|',
    `| Versions | Miqyas ${v.miqyas}, Node ${v.node}, Playwright ${v.playwright}, Chromium ${v.browser ?? 'not launched'} |`,
    `| OS | ${m.os.platform} ${m.os.release} (${m.os.arch}) |`,
    `| Model | ${m.model ? formatMethodModel(m.model) : s.noModel ? 'none (--no-model)' : 'none (dry run)'} |`,
    `| Settings | concurrency ${s.concurrency}, viewport ${s.viewport.width}x${s.viewport.height}, ${s.headed ? 'headed' : 'headless'}, other origins ${s.allowOtherOrigins ? 'allowed' : 'blocked'}${s.strict ? ', strict' : ''}${s.failOn && s.failOn !== 'none' ? `, fail-on ${s.failOn}` : ''}${s.profile ? `, profile ${s.profile}` : ''}${s.repoProvided ? ', repo' : ''}${s.crawl ? `, crawl (screens ${s.maxScreens ?? 50}, depth ${s.maxDepth ?? 3}, ${s.maxRps ?? 2} req/s)` : ''}${s.maxTimeMs !== undefined ? `, max time ${(s.maxTimeMs / 1000).toFixed(1)} s` : ''}${s.active ? `, active${s.allowWrites ? ' + writes' : ''}${s.allowHost ? ` (allow-host ${cell(s.allowHost)})` : ''}` : ''} |`,
    `| Timeouts | plan ${t.planMs / 1000} s, navigation ${t.navigationMs / 1000} s, action ${t.actionMs / 1000} s |`,
    `| Preset | ${m.preset ? cell(m.preset) : 'none'} |`,
    `| Scrub rules | ${m.scrub.file ? `${cell(m.scrub.file)}, SHA-256 \`${m.scrub.sha256}\`, ${m.scrub.terms} term(s)` : 'none'} |`,
    ...(m.adapters?.length ? [`| Adapters | ${formatMethodAdapters(m.adapters)} |`] : []),
    '',
  ];
}

/** Short terminal summary. */
export function renderHuman(r: RunReport): string {
  const out: string[] = [];
  if (r.readiness) {
    out.push(r.readiness.summary);
    if (r.readiness.whatToAdd.length) {
      out.push(`What to add: ${r.readiness.whatToAdd.join('; ')}`);
    }
    out.push('');
  }
  for (const p of r.plans) {
    if (r.dryRun) {
      out.push(`DRY    ${p.planId}  (${p.entries.length} steps, ${p.counts.assertions} assertions)${p.error ? `: ${p.error}` : ''}`);
      continue;
    }
    out.push(`${(MARK[p.verdict] ?? p.verdict).padEnd(6)} ${p.planId}  (${p.counts.passed}/${p.counts.assertions} assertions)`);
    if (p.error) out.push(`       error: ${p.error}`);
    for (const e of p.entries) {
      if (e.kind === 'assertion' && e.verdict !== 'pass' && !r.dryRun)
        out.push(`       ${MARK[e.verdict]} ${e.stepId}: ${e.text}\n         ${e.observation || ''}${e.reason ? ` (${e.reason})` : ''}`);
      if (e.kind === 'action' && e.status === 'failed') out.push(`       action ${e.stepId} failed: ${e.summary}`);
    }
  }
  const t = r.totals;
  const modelOnlyNote = (t.modelOnly ?? 0) > 0 ? ` (${t.modelOnly} model-only)` : '';
  const crawlNote = r.crawl
    ? ` Crawl: ${r.crawl.screensVisited} screen(s)${r.crawl.haltedReason ? ` (halted: ${r.crawl.haltedReason})` : ''}.`
    : '';
  const findingsCount = r.findings?.length ?? 0;
  const triggeredCount = findingsExceedThreshold(r.findings ?? [], r.method.settings.failOn).length;
  const findingsNote = findingsCount
    ? ` Findings: ${findingsCount}${triggeredCount > 0 ? ` (${triggeredCount} >= fail-on ${r.method.settings.failOn})` : ''}.`
    : '';
  out.push('');
  out.push(
    r.dryRun
      ? `DRY RUN: ${t.plans} plans, ${t.assertions} assertions resolved; nothing was judged.`
      : `${MARK[r.verdict]}: ${t.plansPassed}/${t.plans} plans, ${t.passed}/${t.assertions} assertions with a recorded pass${modelOnlyNote}.${crawlNote}${findingsNote}`,
  );
  return out.join('\n');
}
