// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { describe, expect, it } from 'vitest';
import { PlanLedger } from '../../src/proof-core/ledger.js';
import { parsePlan } from '../../src/proof-core/plan.js';
import { readFileSync } from 'node:fs';
import { buildReport, cell, renderHuman, renderMarkdown, TOOL_VERSION } from '../../src/proof-core/report.js';
import { schemaErrors, testMethod } from '../report-helpers.js';

function result(verdict: 'pass' | 'fail') {
  const plan = parsePlan(
    { format: 'miqyas-plan', version: 1, id: 'nav', name: 'Navigation | sidebar', steps: [{ id: 's1', type: 'action', text: 'Click Views' }, { id: 'a1', type: 'assertion', text: "Heading 'Views'" }] },
    'nav',
  );
  const l = new PlanLedger(plan);
  l.recordAction({ stepId: 's1', status: 'done', summary: 'clicked', actions: [{ tool: 'click', input: { ref: 'c1e2' }, locator: "getByRole('link', { name: 'Views' })", ok: true }] });
  l.recordAssertion({
    stepId: 'a1',
    verdict,
    method: 'ai',
    observation: verdict === 'pass' ? 'Heading "Views" at the top' : 'Heading still reads "Folder pairs"',
    evidence: { crop: 'evidence/nav/a1-crop.png', screenshot: 'evidence/nav/a1-c2.png', nodes: [{ ref: 'c2e1', role: 'heading', name: 'Views', box: { x: 1, y: 2, width: 3, height: 4 } }] },
  });
  return l.close(1500);
}

const base = { runId: 'r1', startedAt: new Date('2026-10-29T10:00:00Z'), finishedAt: new Date('2026-10-29T10:01:00Z'), url: 'http://127.0.0.1:4173/', dryRun: false, model: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium' }, usage: { calls: 3, inputTokens: 100, outputTokens: 20 }, method: testMethod({ terms: 6 }) };

describe('report', () => {
  it('totals the ledger and derives the run verdict', () => {
    const r = buildReport({ ...base, plans: [result('pass'), result('fail')] });
    expect(r.verdict).toBe('fail');
    expect(r.totals).toMatchObject({ plans: 2, plansPassed: 1, assertions: 2, passed: 1, failed: 1 });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('gives a dry run its own verdict, never pass, and says no assertion was judged', () => {
    const plan = parsePlan({ format: 'miqyas-plan', version: 1, id: 'nav', steps: [{ id: 's1', type: 'action', text: 'Click Views' }, { id: 'a1', type: 'assertion', text: "Heading 'Views'" }] }, 'nav');
    const l = new PlanLedger(plan);
    l.fail('dry run (12 rendered nodes observed at http://127.0.0.1:4173/)');
    const r = buildReport({ ...base, dryRun: true, model: null, usage: { calls: 0, inputTokens: 0, outputTokens: 0 }, plans: [l.close(10)] });
    expect(r.verdict).toBe('dry_run');
    expect(r.totals).toMatchObject({ assertions: 1, passed: 0, notChecked: 1 });
    const md = renderMarkdown(r);
    expect(md).toContain('**DRY RUN**: no assertion was judged (1 not checked); 1 plan(s) resolved and opened.');
    expect(md).not.toMatch(/\*\*(PASS|ERROR)\*\*/);
  });

  it('renders every assertion with its verdict, method and evidence in Markdown', () => {
    const md = renderMarkdown(buildReport({ ...base, plans: [result('fail')] }));
    expect(md).toContain('**FAIL**');
    expect(md).toContain('| a1 | assertion: Heading \'Views\' | FAIL | ai | Heading still reads "Folder pairs" | [crop](evidence/nav/a1-crop.png)');
    expect(md).toContain('Navigation \\| sidebar');
    expect(md).toContain("getByRole('link', { name: 'Views' })");
  });

  it('lists failing assertions in the human summary', () => {
    const h = renderHuman(buildReport({ ...base, plans: [result('fail')] }));
    expect(h).toMatch(/^FAIL {3}nav/);
    expect(h).toContain('FAIL a1');
    expect(h).toContain('0/1 assertions');
  });

  it('marks a dry run as such', () => {
    const r = buildReport({ ...base, dryRun: true, model: null, plans: [result('pass')] });
    expect(renderHuman(r)).toContain('DRY RUN');
    expect(renderMarkdown(r)).toContain('**DRY RUN**');
  });

  it('escapes table cells', () => {
    expect(cell('a|b\nc')).toBe('a\\|b c');
  });

  it('shows markdown and HTML from the page literally: node names and observations are escaped', () => {
    const plan = parsePlan({ format: 'miqyas-plan', version: 1, id: 'x', steps: [{ id: 'a1', type: 'assertion', text: "'Saved' is shown" }] }, 'x');
    const l = new PlanLedger(plan);
    const hostile = '<img src=x onerror=alert(1)> **bold** [link](http://evil) `code` _em_ ~del~ &amp;';
    l.recordAssertion({ stepId: 'a1', verdict: 'fail', method: 'ai', observation: hostile, evidence: { crop: 'evidence/x/a1-crop.png', nodes: [{ ref: 'c1e1', role: 'button', name: hostile, box: { x: 0, y: 0, width: 1, height: 1 } }] } });
    const md = renderMarkdown(buildReport({ ...base, plans: [l.close(1)] }));
    const row = md.split('\n').find((s) => s.startsWith('| a1 '))!;
    // No markup character from the page is left unescaped (the row's own evidence link aside).
    expect(row.replace('[crop](evidence/x/a1-crop.png)', '')).not.toMatch(/(^|[^\\])[<>*[\]`_~&]/);
    expect(row).toContain('\\<img src=x onerror=alert(1)\\> \\*\\*bold\\*\\* \\[link\\](http://evil) \\`code\\` \\_em\\_ \\~del\\~ \\&amp;');
    // Our own evidence links still render as links.
    expect(row).toContain('[crop](evidence/x/a1-crop.png)');
  });
});

describe('report method and schema', () => {
  const sha256 = 'a'.repeat(64);
  const method = {
    ...testMethod({ file: 'wasl-scrub.json', sha256, terms: 6 }),
    model: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium', maxTokens: 16000, maxTurns: 12 },
    preset: 'wasl-tray',
  };

  it('reads the Miqyas version from package.json', () => {
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(TOOL_VERSION).toBe(version);
    expect(buildReport({ ...base, method, plans: [] }).method.versions.miqyas).toBe(version);
  });

  it('validates a live and a dry-run report against schema/report.schema.json', () => {
    expect(schemaErrors('report', buildReport({ ...base, method, plans: [result('pass'), result('fail')] }))).toEqual([]);
    expect(schemaErrors('report', buildReport({ ...base, dryRun: true, model: null, method: testMethod(), plans: [result('pass')] }))).toEqual([]);
  });

  it('rejects a report that carries scrub terms or misses its method block', () => {
    const r = JSON.parse(JSON.stringify(buildReport({ ...base, method, plans: [] })));
    r.method.scrub.terms = [{ from: 'Zubaydah Holdings', to: 'Example Org' }];
    expect(schemaErrors('report', r)).toContain('/method/scrub/terms must be integer');
    r.method.model.terms = ['Zubaydah'];
    expect(schemaErrors('report', r)).toContain('/method/model must NOT have unevaluated properties');
    delete r.method;
    expect(schemaErrors('report', r)).toContain("/ must have required property 'method'");
  });

  it('renders the method in Markdown: versions, model settings, run settings, preset and scrub hash', () => {
    const md = renderMarkdown(buildReport({ ...base, method, plans: [result('pass')] }));
    expect(md).toContain('## Method');
    expect(md).toContain(`Miqyas ${TOOL_VERSION}, Node ${process.versions.node}, Playwright `);
    expect(md).toContain('anthropic claude-opus-5-5, effort medium, max 16000 tokens per reply, 12 turns per action');
    expect(md).toContain('concurrency 1, viewport 1280x800, headless, other origins blocked');
    expect(md).toContain('plan 600 s, navigation 30 s, action 5 s');
    expect(md).toContain('| Preset | wasl-tray |');
    expect(md).toContain(`wasl-scrub.json, SHA-256 \`${sha256}\`, 6 term(s)`);
    expect(renderMarkdown(buildReport({ ...base, dryRun: true, model: null, method: testMethod(), plans: [] }))).toContain('| Scrub rules | none |');
  });
});
