// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dedupeFindings } from '../../src/proof-core/findings.js';
import {
  buildReadinessReport,
  evaluateCheck5ServedSecrets,
  evaluateCheck6RepoSecrets,
  evaluateGrade1Profile,
  GRADE_1_CHECKS,
  linkReadinessEvidenceIds,
  parseReadinessProfile,
  READINESS_PILLARS,
  recordReadinessInLedger,
  SECURITY_NOTICE,
  type ReadinessCheckResult,
} from '../../src/proof-core/readiness.js';
import { buildReport, renderHuman, renderMarkdown } from '../../src/proof-core/report.js';
import type { CrawlResult } from '../../src/surfaces/session.js';
import { schemaErrors, testMethod } from '../report-helpers.js';

const temps: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'miqyas-readiness-unit-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function writeGitleaksShim(binDir: string, findingsForDir: unknown[], findingsForGit: unknown[] = []): void {
  mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'gitleaks');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'version') { process.stdout.write('8.30.1-test\\n'); process.exit(0); }
const rpIdx = args.indexOf('--report-path');
const rp = rpIdx >= 0 ? args[rpIdx + 1] : null;
const list = args[0] === 'git' ? ${JSON.stringify(findingsForGit)} : ${JSON.stringify(findingsForDir)};
if (rp) fs.writeFileSync(rp, JSON.stringify(list));
process.exit(list.length ? 1 : 0);
`;
  writeFileSync(shimPath, script, 'utf8');
  chmodSync(shimPath, 0o755);
}

function makeFakeCrawl(servedArtifacts: NonNullable<CrawlResult['servedArtifacts']> = []): CrawlResult {
  return {
    screens: [
      {
        url: 'http://127.0.0.1:4173/',
        depth: 0,
        title: 'App',
        observation: {
          capture: 1,
          url: 'http://127.0.0.1:4173/',
          title: 'App',
          lang: 'en',
          dir: 'ltr',
          viewport: { width: 1280, height: 800 },
          nodes: [],
          truncated: false,
          png: Buffer.alloc(0),
          capturedAt: new Date(),
        },
      },
    ],
    skippedControls: 0,
    skippedOffOriginLinks: 0,
    servedArtifacts,
  };
}

function syntheticChecks(
  overrides: Partial<Record<number, Partial<ReadinessCheckResult>>> = {},
): ReadinessCheckResult[] {
  return GRADE_1_CHECKS.map((spec) => ({
    number: spec.number,
    id: spec.id,
    stepId: spec.stepId,
    pillar: spec.pillar,
    title: spec.title,
    mode: spec.mode,
    verdict: 'pass',
    method: 'code',
    adapter: spec.runner,
    coverage: '1/1 verified',
    observation: `${spec.title} verified`,
    ...(spec.securityCheck ? { securityNotice: SECURITY_NOTICE } : {}),
    ...overrides[spec.number],
  }));
}

const baseReportInput = {
  runId: 'g1-test',
  startedAt: new Date('2026-11-13T12:00:00Z'),
  finishedAt: new Date('2026-11-13T12:00:10Z'),
  url: 'http://127.0.0.1:4173/',
  dryRun: false,
  model: null,
  usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
  method: {
    ...testMethod(),
    adapters: [{ id: 'gitleaks', version: '8.30.1', coverage: 'directory + git history', status: 'ok' as const }],
  },
};

describe('readiness profile core', () => {
  it('defines the eight canonical pillars and thirteen Grade 1 checks', () => {
    expect(READINESS_PILLARS).toHaveLength(8);
    expect(READINESS_PILLARS.map((p) => p.id)).toEqual([
      'code-and-logic',
      'ui-states-and-flows',
      'data-and-money',
      'apis-and-third-parties',
      'security-and-tenant-isolation',
      'performance-and-cost',
      'operations',
      'ai-and-compliance',
    ]);
    expect(GRADE_1_CHECKS).toHaveLength(13);
    expect(parseReadinessProfile('grade-1')).toBe('grade-1');
    expect(() => parseReadinessProfile('grade-9')).toThrow(/grade-1/);
  });

  it('reports Grade 1: ready only when every check records a pass, and records them in the ledger', () => {
    const checks = syntheticChecks();
    const readiness = buildReadinessReport(checks);
    expect(readiness.status).toBe('ready');
    expect(readiness.summary).toBe('Grade 1: ready (13 of 13 pass)');
    expect(readiness.counts).toEqual({ total: 13, passed: 13, failed: 0, notChecked: 0 });
    expect(readiness.whatToAdd).toEqual([]);

    const ledgerPlan = recordReadinessInLedger(checks);
    expect(ledgerPlan.verdict).toBe('pass');
    expect(ledgerPlan.counts).toMatchObject({ assertions: 13, passed: 13, failed: 0, notChecked: 0 });

    const report = buildReport({ ...baseReportInput, readiness, plans: [ledgerPlan] });
    expect(report.verdict).toBe('pass');
    expect(schemaErrors('report', report)).toEqual([]);
  });

  it('reports Grade 1: not ready when any check fails or is not_checked, fails the ledger, and preserves security notices', () => {
    const checks = syntheticChecks({
      5: { verdict: 'fail', method: 'code', observation: 'Known secret key exposed in bundle', coverage: '2 screens scanned' },
      6: { verdict: 'fail', method: 'code', observation: 'Known secret key in git history', coverage: 'repo + git history' },
      7: { verdict: 'not_checked', method: 'none', observation: '', reason: '--repo not provided', whatToAdd: 'Pass --repo <path>' },
    });
    const readiness = buildReadinessReport(checks);
    expect(readiness.status).toBe('not_ready');
    expect(readiness.summary).toBe('Grade 1: not ready (10 of 13 pass, 2 fail, 1 not checked)');
    expect(readiness.whatToAdd).toEqual(['Pass --repo <path>']);

    for (const c of readiness.checks) {
      if ([5, 6, 8, 9, 10, 11].includes(c.number)) {
        expect(c.securityNotice).toBe('not a penetration test');
      }
    }

    const ledgerPlan = recordReadinessInLedger(checks);
    expect(ledgerPlan.verdict).toBe('fail');
    const report = buildReport({ ...baseReportInput, readiness, plans: [ledgerPlan] });
    expect(report.verdict).toBe('fail');
    expect(schemaErrors('report', report)).toEqual([]);

    const md = renderMarkdown(report);
    expect(md.indexOf('Grade 1: not ready (10 of 13 pass, 2 fail, 1 not checked)')).toBeLessThan(md.indexOf('## Plans'));
    expect(md).toContain('## Readiness');
    expect(md).toContain('Security and tenant isolation');
    expect(md).toContain('not a penetration test');
    expect(md).toContain('What to add');
    expect(md).toContain('Pass --repo \\<path\\>');
    expect(md).toContain('gitleaks 8.30.1');
    expect(md).not.toMatch(/\/100\b|out of 100/i);

    const human = renderHuman(report);
    expect(human).toContain('Grade 1: not ready (10 of 13 pass, 2 fail, 1 not checked)');
    expect(human).not.toMatch(/\/100\b|out of 100/i);
  });

  it('marks Checks 5 & 6 not_checked with setup guidance when gitleaks or --repo is missing', async () => {
    const emptyPathDir = makeTmpDir();
    const envMissing = { ...process.env, PATH: emptyPathDir };
    const crawl = makeFakeCrawl([{ kind: 'bundle', name: 'app.js', url: 'http://127.0.0.1:4173/app.js', text: 'console.log(1);' }]);

    const c5 = await evaluateCheck5ServedSecrets({ crawl, gitleaks: { env: envMissing } });
    expect(c5.check.verdict).toBe('not_checked');
    expect(c5.check.whatToAdd).toMatch(/gitleaks/i);
    expect(c5.check.securityNotice).toBe('not a penetration test');

    const c6NoRepo = await evaluateCheck6RepoSecrets({ gitleaks: { env: envMissing } });
    expect(c6NoRepo.check.verdict).toBe('not_checked');
    expect(c6NoRepo.check.whatToAdd).toMatch(/--repo/);
  });

  it('evaluates Check 5 & Check 6 via gitleaks shim: passes on generic hits (kept as findings) and fails on known formats', async () => {
    const dir = makeTmpDir();
    const binDir = path.join(dir, 'bin');
    const repoDir = path.join(dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'ci@kahflabs.example'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'CI'], { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(path.join(repoDir, 'index.js'), 'export const ok = true;\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

    writeGitleaksShim(
      binDir,
      [{ RuleID: 'generic-api-key', Description: 'Generic API Key', File: '0001-bundle-app.js.txt', StartLine: 1, Match: 'REDACTED', Secret: 'REDACTED' }],
      [{ RuleID: 'aws-access-token', Description: 'AWS', File: '.env', StartLine: 2, Commit: '11112222', Match: 'REDACTED', Secret: 'REDACTED' }],
    );
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
    const crawl = makeFakeCrawl([
      { kind: 'source-map', name: 'app.js.map', url: 'http://127.0.0.1:4173/app.js.map', text: '{"version":3}' },
    ]);

    const res = await evaluateGrade1Profile({
      dryRun: false,
      noModel: true,
      crawl,
      repoPath: repoDir,
      gitleaks: { env },
    });

    const check5 = res.readiness.checks.find((c) => c.number === 5)!;
    const check6 = res.readiness.checks.find((c) => c.number === 6)!;
    expect(check5.verdict).toBe('pass');
    expect(check5.adapterVersion).toBe('8.30.1-test');
    expect(check6.verdict).toBe('fail');
    expect(res.findings.some((f) => f.title.includes('generic gitleaks match'))).toBe(true);
    expect(res.findings.some((f) => f.title.includes('Check 6'))).toBe(true);
    expect(res.adapters[0]).toMatchObject({ id: 'gitleaks', version: '8.30.1-test', status: 'ok' });

    // Known sb_secret_ inside served storage fails Check 5 even without shim rule matching
    const sbSecret = ['sb', 'secret', 'dummy0123456789abcdef'].join('_');
    const c5Leak = await evaluateCheck5ServedSecrets({
      crawl: makeFakeCrawl([
        {
          kind: 'storage',
          name: 'localStorage.tok',
          url: `http://127.0.0.1:4173/?secret_param=leakedQueryVal123#access_token=${sbSecret}`,
          text: sbSecret,
        },
      ]),
      gitleaks: { env },
    });
    expect(c5Leak.check.verdict).toBe('fail');
    expect(c5Leak.findings[0]?.evidence).not.toContain(sbSecret);
    expect(c5Leak.findings[0]?.evidence).not.toContain('leakedQueryVal123');
    expect(c5Leak.findings[0]?.evidence).not.toContain('access_token=');
  });

  it('aligns readiness evidenceIds with post-dedupe finding IDs and marks dryRun ledger non-broken', async () => {
    const dryRes = await evaluateGrade1Profile({ dryRun: true });
    expect(dryRes.ledgerPlan.error).toMatch(/^dry run/);
    expect(dryRes.readiness.checks.every((c) => c.verdict === 'not_checked')).toBe(true);

    const dir = makeTmpDir();
    const binDir = path.join(dir, 'bin');
    writeGitleaksShim(
      binDir,
      [{ RuleID: 'generic-api-key', Description: 'Generic API Key', File: '0001-bundle-_app.js.txt', StartLine: 1, Match: 'REDACTED', Secret: 'REDACTED' }],
      [],
    );
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
    const crawl = makeFakeCrawl([{ kind: 'bundle', name: '/app.js', url: 'http://127.0.0.1:4173/app.js', text: 'const x = 1;' }]);
    const res = await evaluateGrade1Profile({ dryRun: false, noModel: true, crawl, gitleaks: { env } });
    const deduped = dedupeFindings(res.findings);
    const linked = linkReadinessEvidenceIds(res.readiness, res.checkFindingKeys, deduped);
    const c5 = linked.checks.find((c) => c.number === 5)!;
    expect(c5.evidenceIds).toEqual(deduped.map((f) => f.id));
    expect(deduped[0]?.id).toMatch(/^secret-exposure-/);
  });
});
