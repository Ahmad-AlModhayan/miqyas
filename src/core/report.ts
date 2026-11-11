// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Run reports: JSON (the ledger, machine-readable) and Markdown (for people). Same data, two renderings.

import { createRequire } from 'node:module';
import os from 'node:os';
import { countEntries, runVerdict, type PlanCounts, type PlanResult, type RunVerdict } from './ledger.js';

const require = createRequire(import.meta.url);
/** From package.json: src/core and dist/core both sit two levels below it. */
export const TOOL_VERSION: string = require('../../package.json').version;

export interface ModelInfo {
  provider: string;
  model: string;
  effort?: string;
}

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** By the model that answered (`res.model`): a server-side fallback can answer on another model than the one asked. */
  byModel?: Record<string, Omit<Usage, 'byModel'>>;
}

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
  };
  /** The mutation preset; null for a plain run. */
  preset: string | null;
  scrub: { file: string | null; sha256: string | null; terms: number };
}

/** The parts of the method block that come from this machine. */
export function environment(browser: string | null): Pick<Method, 'versions' | 'os'> {
  return {
    versions: { miqyas: TOOL_VERSION, node: process.versions.node, playwright: require('playwright/package.json').version, browser },
    os: { platform: process.platform, release: os.release(), arch: process.arch },
  };
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
  method: Method;
  screenshots: typeof SCREENSHOTS;
  plans: PlanResult[];
}

export function buildReport(input: {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  url: string;
  dryRun: boolean;
  model: ModelInfo | null;
  usage: Usage;
  method: Method;
  plans: PlanResult[];
}): RunReport {
  const totals = { plans: input.plans.length, plansPassed: 0, ...countEntries([]) };
  for (const p of input.plans) {
    if (p.verdict === 'pass') totals.plansPassed++;
    totals.assertions += p.counts.assertions;
    totals.passed += p.counts.passed;
    totals.failed += p.counts.failed;
    totals.notChecked += p.counts.notChecked;
    totals.blocked += p.counts.blocked;
    totals.unverified += p.counts.unverified;
  }
  return {
    tool: 'miqyas',
    version: TOOL_VERSION,
    runId: input.runId,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    target: { url: input.url },
    dryRun: input.dryRun,
    model: input.model,
    verdict: input.dryRun ? 'dry_run' : runVerdict(input.plans),
    totals,
    usage: input.usage,
    method: input.method,
    screenshots: SCREENSHOTS,
    plans: input.plans,
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

export function renderMarkdown(r: RunReport): string {
  const t = r.totals;
  const lines: string[] = [];
  lines.push(`# Miqyas run ${r.runId}`, '');
  lines.push(r.dryRun ? `**DRY RUN**: no assertion was judged (${t.notChecked} not checked); ${t.plans} plan(s) resolved and opened.` : `**${MARK[r.verdict]}**: ${t.plansPassed} of ${t.plans} plans passed; ${t.passed} of ${t.assertions} assertions have a recorded pass.`, '');
  lines.push('| | |', '|---|---|');
  lines.push(`| Target | ${cell(r.target.url)} |`);
  lines.push(`| Model | ${r.model ? cell(`${r.model.provider} ${r.model.model}${r.model.effort ? ` (effort ${r.model.effort})` : ''}`) : 'none'} |`);
  lines.push(`| Started | ${r.startedAt} |`);
  lines.push(`| Finished | ${r.finishedAt} |`);
  lines.push(`| Assertions | ${t.assertions}: ${t.passed} pass, ${t.failed} fail, ${t.unverified} unverified, ${t.blocked} blocked, ${t.notChecked} not checked |`);
  lines.push(`| Model calls | ${r.usage.calls} (${r.usage.inputTokens} input, ${r.usage.outputTokens} output tokens)${r.usage.byModel ? `; ${cell(answeredBy(r.usage))}` : ''} |`);
  lines.push(`| Screenshots | ${r.screenshots.note} |`, '');
  lines.push('A plan passes only when every assertion has a recorded pass with evidence. Unverified, blocked and not checked count as failures.', '');
  lines.push(...renderMethod(r.method));

  lines.push('## Plans', '', '| Plan | Verdict | Assertions passed | Time |', '|---|---|---|---|');
  for (const p of r.plans)
    lines.push(`| ${cell(p.planId)} | ${r.dryRun ? 'DRY' : MARK[p.verdict]} | ${p.counts.passed} / ${p.counts.assertions} | ${(p.durationMs / 1000).toFixed(1)} s |`);
  lines.push('');

  for (const p of r.plans) {
    lines.push(`## ${cell(p.planId)}: ${cell(p.name)}`, '');
    lines.push(`**${MARK[r.dryRun ? r.verdict : p.verdict]}**${p.file ? ` · ${code(p.file)}` : ''}`, '');
    if (p.error) lines.push(`Run error: ${cell(p.error)}`, '');
    lines.push('| Step | Type | Result | Method | What was seen | Evidence |', '|---|---|---|---|---|---|');
    for (const e of p.entries) {
      if (e.kind === 'action') {
        const did = e.actions.map((a) => (a.locator ? `${a.tool} ${a.locator}` : a.tool)).join('; ');
        const unmasked = [...new Set(e.actions.flatMap((a) => (a.unmasked ? [a.unmasked] : [])))].join('; ');
        lines.push(`| ${cell(e.stepId)} | action: ${cell(e.text)} | ${MARK[e.status]} | | ${cell(e.summary)}${did ? ` (${cell(did)})` : ''} | ${cell(unmasked)} |`);
      } else {
        const seen = [e.observation, e.reason ? `(${e.reason})` : ''].filter(Boolean).join(' ');
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
  return lines.join('\n');
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
    `| Model | ${m.model ? cell(`${m.model.provider} ${m.model.model}${m.model.effort ? `, effort ${m.model.effort}` : ''}, max ${m.model.maxTokens} tokens per reply, ${m.model.maxTurns} turns per action`) : 'none (dry run)'} |`,
    `| Settings | concurrency ${s.concurrency}, viewport ${s.viewport.width}x${s.viewport.height}, ${s.headed ? 'headed' : 'headless'}, other origins ${s.allowOtherOrigins ? 'allowed' : 'blocked'} |`,
    `| Timeouts | plan ${t.planMs / 1000} s, navigation ${t.navigationMs / 1000} s, action ${t.actionMs / 1000} s |`,
    `| Preset | ${m.preset ? cell(m.preset) : 'none'} |`,
    `| Scrub rules | ${m.scrub.file ? `${cell(m.scrub.file)}, SHA-256 \`${m.scrub.sha256}\`, ${m.scrub.terms} term(s)` : 'none'} |`,
    '',
  ];
}

/** Short terminal summary. */
export function renderHuman(r: RunReport): string {
  const out: string[] = [];
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
  out.push('');
  out.push(
    r.dryRun
      ? `DRY RUN: ${t.plans} plans, ${t.assertions} assertions resolved; nothing was judged.`
      : `${MARK[r.verdict]}: ${t.plansPassed}/${t.plans} plans, ${t.passed}/${t.assertions} assertions with a recorded pass.`,
  );
  return out.join('\n');
}
