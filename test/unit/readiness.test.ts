// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dedupeFindings } from '../../src/proof-core/findings.js';
import { buildCheck3AuthTemplates } from '../../src/proof-core/auth-templates.js';
import type { PlanResult } from '../../src/proof-core/ledger.js';
import {
  applyTimeLimitDropOrder,
  buildReadinessReport,
  evaluateCheck1LoadErrors,
  evaluateCheck2Controls,
  evaluateCheck3AuthTemplates,
  evaluateCheck4Accessibility,
  evaluateCheck5ServedSecrets,
  evaluateCheck6RepoSecrets,
  evaluateCheck7MigrationRls,
  evaluateCheck8BackendAccess,
  evaluateCheck9TwoAccountIdor,
  evaluateCheck10SessionAuth,
  evaluateCheck11ParamProbes,
  evaluateCheck12SpendingRoutes,
  evaluateCheck13Dependencies,
  evaluateGrade1Profile,
  GRADE_1_CHECKS,
  linkReadinessEvidenceIds,
  parseReadinessProfile,
  READINESS_DROP_ORDER,
  READINESS_PILLARS,
  recordReadinessInLedger,
  SECURITY_NOTICE,
  TIME_LIMIT_DROP_REASON,
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

  it('evaluates Check 7 (SQL migration RLS via libpg-query): not_checked, pass, and fail with missing-rls finding', async () => {
    expect((await evaluateCheck7MigrationRls({})).check.verdict).toBe('not_checked');

    const dir = makeTmpDir();
    const emptyRepo = path.join(dir, 'empty');
    mkdirSync(emptyRepo, { recursive: true });
    expect((await evaluateCheck7MigrationRls({ repoPath: emptyRepo })).check.verdict).toBe('not_checked');

    const cleanRepo = path.join(dir, 'clean');
    mkdirSync(path.join(cleanRepo, 'supabase/migrations'), { recursive: true });
    writeFileSync(
      path.join(cleanRepo, 'supabase/migrations/001_init.sql'),
      'CREATE TABLE public.orders (id uuid primary key);\nALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;\n',
    );
    const passRes = await evaluateCheck7MigrationRls({ repoPath: cleanRepo });
    expect(passRes.check.verdict).toBe('pass');
    expect(passRes.check.adapter).toBe('libpg-query');
    expect(passRes.check.coverage).toContain('1 public table(s) parsed');
    expect(passRes.findings).toHaveLength(0);

    const leakyRepo = path.join(dir, 'leaky');
    mkdirSync(path.join(leakyRepo, 'supabase/migrations'), { recursive: true });
    writeFileSync(
      path.join(leakyRepo, 'supabase/migrations/001_init.sql'),
      'CREATE TABLE public.orders (id uuid primary key);\nALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;\nCREATE TABLE public.secrets (id serial primary key, val text);\n',
    );
    const failRes = await evaluateCheck7MigrationRls({ repoPath: leakyRepo });
    expect(failRes.check.verdict).toBe('fail');
    expect(failRes.findings).toHaveLength(1);
    expect(failRes.findings[0]).toMatchObject({ category: 'missing-rls', severity: 'high' });
    expect(failRes.findings[0]?.evidence).toContain('secrets');
  });

  it('evaluates Check 13 (osv-scanner): fails on critical/high/MAL-, records medium/low on pass, not_checked when unavailable', async () => {
    expect((await evaluateCheck13Dependencies({})).check.verdict).toBe('not_checked');

    const dir = makeTmpDir();
    const repoDir = path.join(dir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      path.join(repoDir, 'package-lock.json'),
      JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: { '': { name: 'app' }, 'node_modules/badpkg': { version: '1.0.0' } },
      }),
    );

    const noBinEnv = { ...process.env, PATH: dir };
    expect((await evaluateCheck13Dependencies({ repoPath: repoDir, osv: { env: noBinEnv } })).check.verdict).toBe('not_checked');

    const makeOsvEnv = (vulns: Array<{ id: string; severity: string }>, exitCode = 1, stderr = '') => {
      const binDir = path.join(dir, `bin-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(binDir, { recursive: true });
      const shim = path.join(binDir, 'osv-scanner');
      const report = vulns.length
        ? {
            results: [
              {
                source: { path: path.join(repoDir, 'package-lock.json'), type: 'lockfile' },
                packages: [
                  {
                    package: { name: 'badpkg', version: '1.0.0', ecosystem: 'npm' },
                    vulnerabilities: vulns.map((v) => ({
                      id: v.id,
                      summary: `${v.id} issue`,
                      database_specific: { severity: v.severity },
                    })),
                  },
                ],
              },
            ],
          }
        : { results: [] };
      writeFileSync(
        shim,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.7.0'); process.exit(0); }
const stderr = ${JSON.stringify(stderr)};
if (stderr) process.stderr.write(stderr);
process.stdout.write(${JSON.stringify(JSON.stringify(report))});
process.exit(${exitCode});
`,
      );
      chmodSync(shim, 0o755);
      return { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
    };

    const dbMiss = await evaluateCheck13Dependencies({
      repoPath: repoDir,
      osv: { env: makeOsvEnv([], 127, 'no local databases found') },
    });
    expect(dbMiss.check.verdict).toBe('not_checked');

    const medOnly = await evaluateCheck13Dependencies({
      repoPath: repoDir,
      osv: { env: makeOsvEnv([{ id: 'GHSA-med-1', severity: 'MODERATE' }], 1) },
    });
    expect(medOnly.check.verdict).toBe('pass');
    expect(medOnly.findings).toHaveLength(1);
    expect(medOnly.findings[0]?.severity).toBe('medium');

    const malFail = await evaluateCheck13Dependencies({
      repoPath: repoDir,
      osv: { env: makeOsvEnv([{ id: 'MAL-2026-0001', severity: 'LOW' }], 1) },
    });
    expect(malFail.check.verdict).toBe('fail');
    expect(malFail.findings[0]?.category).toBe('vulnerable-dependency');
    expect(malFail.findings[0]?.severity).toBe('critical');

    // Full grade-1 profile wires Check 7 and Check 13 adapters into method.adapters
    const profileRes = await evaluateGrade1Profile({
      dryRun: false,
      noModel: true,
      repoPath: cleanRepoWithLock(dir),
      crawl: makeFakeCrawl(),
      osv: { env: makeOsvEnv([], 0) },
    });
    expect(profileRes.adapters.map((a) => a.id)).toEqual(expect.arrayContaining(['libpg-query', 'osv-scanner', 'playwright', 'axe-core']));
    expect(profileRes.readiness.checks.find((c) => c.number === 1)?.verdict).toBe('pass');
    expect(profileRes.readiness.checks.find((c) => c.number === 2)?.verdict).toBe('pass');
    expect(profileRes.readiness.checks.find((c) => c.number === 4)?.verdict).toBe('pass');
    expect(profileRes.readiness.checks.find((c) => c.number === 7)?.verdict).toBe('pass');
    expect(profileRes.readiness.checks.find((c) => c.number === 13)?.verdict).toBe('pass');
  });

  it('evaluates Check 1 (page/console/5xx vs 4xx findings): not_checked, pass with 4xx, and fail on 5xx or runtime errors', () => {
    expect(evaluateCheck1LoadErrors({}).check.verdict).toBe('not_checked');

    const crawl404 = makeFakeCrawl();
    crawl404.playwrightVersion = '1.64.1';
    crawl404.screens[0]!.observation.findings = [
      { category: 'http-error', title: 'HTTP 404 on /missing', severity: 'medium', confirmed: true, evidence: '404 Not Found GET /missing' },
    ];
    const res404 = evaluateCheck1LoadErrors({ crawl: crawl404 });
    expect(res404.check.verdict).toBe('pass');
    expect(res404.check.coverage).toContain('1 screen(s)');
    expect(res404.check.coverage).toContain('1 4xx finding(s)');
    expect(res404.findings).toHaveLength(1);
    expect(res404.blockingKeys).toEqual([]);

    const crawlFail = makeFakeCrawl();
    crawlFail.screens[0]!.observation.findings = [
      { category: 'page-error', title: 'Uncaught page error', severity: 'high', confirmed: true, evidence: 'TypeError: boom' },
    ];
    crawlFail.crawlErrors = [
      { category: 'http-error', title: 'HTTP 503 on /api', severity: 'high', confirmed: true, evidence: '503 Unavailable GET /api' },
    ];
    const resFail = evaluateCheck1LoadErrors({ crawl: crawlFail });
    expect(resFail.check.verdict).toBe('fail');
    expect(resFail.blockingKeys).toHaveLength(2);
    expect(resFail.check.evidenceIds).toHaveLength(2);
  });

  it('evaluates Check 2 (non-destructive controls & destructive exclusions): pass vs fail on unchanged control', () => {
    expect(evaluateCheck2Controls({}).check.verdict).toBe('not_checked');

    const cleanCrawl = makeFakeCrawl();
    cleanCrawl.skippedControls = 2;
    cleanCrawl.controlChecks = [
      { screenUrl: 'http://127.0.0.1:4173/', label: 'Details tab', tagName: 'button', status: 'changed' },
      { screenUrl: 'http://127.0.0.1:4173/', label: 'Delete account', tagName: 'button', status: 'skipped-destructive' },
      { screenUrl: 'http://127.0.0.1:4173/', label: 'Pay now', tagName: 'button', status: 'skipped-destructive' },
    ];
    const passRes = evaluateCheck2Controls({ crawl: cleanCrawl });
    expect(passRes.check.verdict).toBe('pass');
    expect(passRes.check.coverage).toContain('Delete account');
    expect(passRes.check.coverage).toContain('Pay now');
    expect(passRes.findings).toEqual([]);

    const deadCrawl = makeFakeCrawl();
    deadCrawl.controlChecks = [
      { screenUrl: 'http://127.0.0.1:4173/', label: 'Details tab', tagName: 'button', status: 'changed' },
      { screenUrl: 'http://127.0.0.1:4173/', label: 'Broken Save', tagName: 'button', status: 'unchanged' },
    ];
    const failRes = evaluateCheck2Controls({ crawl: deadCrawl });
    expect(failRes.check.verdict).toBe('fail');
    expect(failRes.findings).toHaveLength(1);
    expect(failRes.findings[0]).toMatchObject({ category: 'dead-control', severity: 'medium' });
  });

  it('evaluates Check 4 (axe-core critical/serious aggregation): passes moderate/minor and fails critical/serious with node evidence', () => {
    expect(evaluateCheck4Accessibility({}).check.verdict).toBe('not_checked');

    const advCrawl = makeFakeCrawl();
    advCrawl.axeVersion = '4.14.0';
    advCrawl.screens[0]!.observation.findings = [
      { category: 'a11y', title: 'axe region: Landmarks', severity: 'medium', confirmed: true, evidence: 'impact=moderate; targets=div' },
    ];
    const advRes = evaluateCheck4Accessibility({ crawl: advCrawl });
    expect(advRes.check.verdict).toBe('pass');
    expect(advRes.check.adapterVersion).toBe('4.14.0');
    expect(advRes.findings).toHaveLength(1);
    expect(advRes.blockingKeys).toEqual([]);

    const failCrawl = makeFakeCrawl();
    failCrawl.axeVersion = '4.14.0';
    failCrawl.screens[0]!.observation.findings = [
      {
        category: 'a11y',
        title: 'axe image-alt: Images must have alternative text',
        severity: 'critical',
        confirmed: true,
        evidence: 'impact=critical; targets=img#hero',
        nodes: [{ ref: 'img#hero', role: 'img', name: 'img#hero', box: { x: 0, y: 0, width: 100, height: 50 } }],
      },
    ];
    const failRes = evaluateCheck4Accessibility({ crawl: failCrawl });
    expect(failRes.check.verdict).toBe('fail');
    expect(failRes.blockingKeys).toHaveLength(1);
    expect(failRes.findings[0]?.nodes?.[0]?.ref).toBe('img#hero');
  });

  it('evaluates Checks 8, 9, 10 with --active gating, host policy, zero row leakage, and SECURITY_NOTICE', async () => {
    expect((await evaluateCheck8BackendAccess({ url: 'http://127.0.0.1:4173/' })).check.verdict).toBe('not_checked');
    expect((await evaluateCheck9TwoAccountIdor({ url: 'http://127.0.0.1:4173/' })).check.verdict).toBe('not_checked');
    expect((await evaluateCheck10SessionAuth({ url: 'http://127.0.0.1:4173/' })).check.verdict).toBe('not_checked');

    await expect(
      evaluateCheck8BackendAccess({ url: 'https://unowned-target.example/', active: true }),
    ).rejects.toThrow(/--allow-host|host/i);

    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url');
    const anonJwt = `${header}.${payload}.sig`;
    const crawl = makeFakeCrawl();
    crawl.servedArtifacts = [
      {
        name: 'app.js',
        kind: 'bundle',
        url: 'http://127.0.0.1:4173/app.js',
        text: `const sb = createClient("http://127.0.0.1:4173", "${anonJwt}"); sb.from("users").select("*");`,
      },
    ];

    const c8Fail = await evaluateCheck8BackendAccess({
      active: true,
      url: 'http://127.0.0.1:4173/',
      maxRps: 100,
      crawl,
      fetchImpl: async () =>
        new Response(JSON.stringify([{ id: 1, secretColumnVal: 'ROW_LEAK_SENTINEL_881' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    expect(c8Fail.check.verdict).toBe('fail');
    expect(c8Fail.check.securityNotice).toBe(SECURITY_NOTICE);
    expect(c8Fail.findings[0]?.title).toContain(SECURITY_NOTICE);
    expect(JSON.stringify(c8Fail)).not.toContain('ROW_LEAK_SENTINEL_881');

    const c8Pass = await evaluateCheck8BackendAccess({
      active: true,
      url: 'http://127.0.0.1:4173/',
      maxRps: 100,
      crawl,
      fetchImpl: async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    expect(c8Pass.check.verdict).toBe('pass');
    expect(c8Pass.check.securityNotice).toBe(SECURITY_NOTICE);

    // Check 9 with < 2 accounts -> not_checked
    const c9MissingAcc = await evaluateCheck9TwoAccountIdor({
      active: true,
      url: 'http://127.0.0.1:4173/',
      accounts: [{ name: 'A', bearerToken: 'tok-a', protectedRoutes: ['/api/orders'] }],
    });
    expect(c9MissingAcc.check.verdict).toBe('not_checked');
    expect(c9MissingAcc.check.securityNotice).toBe(SECURITY_NOTICE);

    const apiMock: typeof fetch = async (input, init) => {
      const u = new URL(String(input));
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
      if (u.pathname === '/api/orders') {
        if (!auth) return new Response('unauthorized', { status: 401 });
        return auth === 'Bearer tok-a'
          ? new Response(JSON.stringify([{ id: 'ord-1', total: 'ROW_ORDER_SECRET' }]), { status: 200, headers: { 'content-type': 'application/json' } })
          : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.pathname === '/api/orders/ord-1') {
        if (!auth) return new Response('unauthorized', { status: 401 });
        return new Response(JSON.stringify({ id: 'ord-1', total: 'ROW_ORDER_SECRET' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.pathname === '/api/private') {
        return new Response(JSON.stringify({ secret: 'UNAUTH_ROW_SECRET' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    };

    const accounts = [
      { name: 'A' as const, bearerToken: 'tok-a', protectedRoutes: ['/api/orders', '/api/private'] },
      { name: 'B' as const, bearerToken: 'tok-b', protectedRoutes: ['/api/orders', '/api/private'] },
    ];
    const c9Fail = await evaluateCheck9TwoAccountIdor({
      active: true,
      url: 'http://127.0.0.1:4173/',
      maxRps: 100,
      accounts,
      fetchImpl: apiMock,
    });
    expect(c9Fail.check.verdict).toBe('fail');
    expect(c9Fail.check.securityNotice).toBe(SECURITY_NOTICE);
    expect(c9Fail.findings[0]?.category).toBe('idor-read');
    expect(JSON.stringify(c9Fail)).not.toContain('ROW_ORDER_SECRET');

    const c10Fail = await evaluateCheck10SessionAuth({
      active: true,
      url: 'http://127.0.0.1:4173/',
      maxRps: 100,
      accounts,
      fetchImpl: apiMock,
    });
    expect(c10Fail.check.verdict).toBe('fail');
    expect(c10Fail.check.securityNotice).toBe(SECURITY_NOTICE);
    expect(c10Fail.findings[0]?.category).toBe('unauthenticated-route');
    expect(JSON.stringify(c10Fail)).not.toContain('UNAUTH_ROW_SECRET');

    const c10Pass = await evaluateCheck10SessionAuth({
      active: true,
      url: 'http://127.0.0.1:4173/',
      maxRps: 100,
      protectedRoutes: ['/api/orders'],
      fetchImpl: apiMock,
    });
    expect(c10Pass.check.verdict).toBe('pass');

    // FR-Q2: early 429/503 halt with 0 findings cannot claim pass -> must return not_checked
    const c8RateLimited = await evaluateCheck8BackendAccess({
      active: true,
      url: 'http://127.0.0.1:4173/',
      maxRps: 100,
      crawl,
      fetchImpl: async () => new Response('rate limit', { status: 429 }),
    });
    expect(c8RateLimited.check.verdict).toBe('not_checked');
    expect(c8RateLimited.check.verdict).toBe('not_checked');
    expect(c8RateLimited.check.reason).toContain('rate-limit');
  });

  it('evaluates Check 11, Check 12 (with --allow-writes off test host), and Check 3 auth templates', async () => {
    const crawl = makeFakeCrawl();
    crawl.screens[0]!.url = 'http://127.0.0.1:4173/?q=home';
    crawl.servedArtifacts = [
      {
        name: 'index.html',
        kind: 'response',
        url: 'http://127.0.0.1:4173/',
        text: '<form action="/signup"></form><a href="/login">Login</a><a href="/search?term=hi">Search</a><script>fetch("/api/chat")</script>',
      },
    ];

    const c11Fail = await evaluateCheck11ParamProbes({
      active: true,
      url: 'http://127.0.0.1:4173/',
      runId: 'u11',
      maxRps: 100,
      crawl,
      probeUrls: ['http://127.0.0.1:4173/redir?next=/home'],
      fetchImpl: async (input) => {
        const u = new URL(String(input));
        const q = u.searchParams.get('q');
        if (q?.includes('miqyas-probe-u11')) {
          return new Response(`<div>${q}</div>`, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        const nextParam = u.searchParams.get('next');
        if (nextParam?.includes('canary.miqyas-probe.invalid')) {
          return new Response('', { status: 302, headers: { location: nextParam } });
        }
        return new Response('<p>ok</p>', { status: 200, headers: { 'content-type': 'text/html' } });
      },
    });
    expect(c11Fail.check.verdict).toBe('fail');
    expect(c11Fail.check.securityNotice).toBe(SECURITY_NOTICE);
    expect(c11Fail.findings.map((f) => f.category).sort()).toEqual(['open-redirect', 'reflected-xss']);

    const c12OffHostBlocked = await evaluateCheck12SpendingRoutes({
      active: true,
      allowWrites: false,
      url: 'https://staging.example.com/',
      allowHost: 'staging.example.com',
      crawl,
      spendingRoutes: ['/api/chat'],
    });
    expect(c12OffHostBlocked.check.verdict).toBe('not_checked');
    expect(c12OffHostBlocked.check.reason).toContain('--allow-writes');

    const c12Fail = await evaluateCheck12SpendingRoutes({
      active: true,
      url: 'http://127.0.0.1:4173/',
      maxRps: 100,
      spendingRoutes: ['/api/chat', '/api/send-sms'],
      fetchImpl: async (input) => {
        const u = new URL(String(input));
        if (u.pathname === '/api/chat') {
          return new Response(JSON.stringify({ reply: 'unauthed-llm' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('unauthorized', { status: 401 });
      },
    });
    expect(c12Fail.check.verdict).toBe('fail');
    expect(c12Fail.findings).toHaveLength(1);
    expect(c12Fail.findings[0]?.category).toBe('unauthenticated-spending-route');

    const twoAccounts = [
      { name: 'A' as const, credentials: { email: 'alice@example.com', password: 'secret-a' } },
      { name: 'B' as const, credentials: { email: 'bob@example.com', password: 'secret-b' } },
    ];
    const bundle = buildCheck3AuthTemplates({ targetUrl: 'http://127.0.0.1:4173/', crawl, accounts: twoAccounts });
    expect(bundle).not.toBeNull();
    expect(bundle?.plans.map((p) => p.id)).toEqual(['grade-1/check-3-signup', 'grade-1/check-3-login']);
    expect(bundle?.env.MIQYAS_SECRET_ACCOUNT_A_PASSWORD).toBe('secret-a');
    expect(bundle?.env.MIQYAS_SECRET_ACCOUNT_A_EMAIL).toBeUndefined();

    expect((await evaluateCheck3AuthTemplates({ url: 'http://127.0.0.1:4173/', noModel: true, modelActive: true, accounts: twoAccounts })).check.verdict).toBe('not_checked');

    const fakePlan = (planId: string, verdict: 'pass' | 'fail'): PlanResult => ({
      planId,
      name: planId,
      verdict,
      counts: { assertions: 1, passed: verdict === 'pass' ? 1 : 0, failed: verdict === 'fail' ? 1 : 0, notChecked: 0, blocked: 0, unverified: 0 },
      entries: [
        {
          kind: 'assertion',
          stepId: 'a1',
          text: 'auth succeeded',
          verdict,
          method: 'ai',
          observation: verdict === 'pass' ? 'signed in' : 'login form rejected credentials',
        },
      ],
      durationMs: 10,
    });
    const c3Fail = await evaluateCheck3AuthTemplates({
      url: 'http://127.0.0.1:4173/',
      crawl,
      modelActive: true,
      accounts: twoAccounts,
      runCheck3Templates: async () => [fakePlan('grade-1/check-3-signup', 'pass'), fakePlan('grade-1/check-3-login', 'fail')],
    });
    expect(c3Fail.check.verdict).toBe('fail');
    expect(c3Fail.findings[0]?.category).toBe('auth-flow');

    const c3Pass = await evaluateCheck3AuthTemplates({
      url: 'http://127.0.0.1:4173/',
      crawl,
      modelActive: true,
      accounts: twoAccounts,
      runCheck3Templates: async () => [fakePlan('grade-1/check-3-signup', 'pass'), fakePlan('grade-1/check-3-login', 'pass')],
    });
    expect(c3Pass.check.verdict).toBe('pass');
  });

  it('drops constrained runs strictly in order 12 -> 11 -> 3 as not_checked (never pass)', async () => {
    expect(READINESS_DROP_ORDER).toEqual([12, 11, 3]);
    const allPassing: ReadinessCheckResult[] = GRADE_1_CHECKS.map((spec) => ({
      number: spec.number,
      id: spec.id,
      stepId: spec.stepId,
      pillar: spec.pillar,
      title: spec.title,
      mode: spec.mode,
      verdict: 'pass',
      method: 'code',
      coverage: 'full',
      observation: 'ok',
    }));
    const dropped1 = applyTimeLimitDropOrder(allPassing, 1);
    expect(dropped1.filter((c) => c.verdict === 'not_checked').map((c) => c.number)).toEqual([12]);
    const dropped2 = applyTimeLimitDropOrder(allPassing, 2);
    expect(dropped2.filter((c) => c.verdict === 'not_checked').map((c) => c.number)).toEqual([11, 12]);
    const dropped3 = applyTimeLimitDropOrder(allPassing, 3);
    expect(dropped3.filter((c) => c.verdict === 'not_checked').map((c) => c.number)).toEqual([3, 11, 12]);
    expect(dropped3.find((c) => c.number === 12)?.reason).toBe(TIME_LIMIT_DROP_REASON);

    // Runtime evaluateGrade1Profile drops in order 12 -> 11 -> 3 as fake clock reaches deadlineMs
    const crawl = makeFakeCrawl();
    crawl.screens[0]!.url = 'http://127.0.0.1:4173/search?q=x';
    crawl.servedArtifacts = [];
    const accounts = [
      { name: 'A' as const, credentials: { email: 'a@example.com', password: 'pa' } },
      { name: 'B' as const, credentials: { email: 'b@example.com', password: 'pb' } },
    ];
    const passPlan = (planId: string): PlanResult => ({
      planId,
      name: planId,
      verdict: 'pass',
      counts: { assertions: 1, passed: 1, failed: 0, notChecked: 0, blocked: 0, unverified: 0 },
      entries: [{ kind: 'assertion', stepId: 'a1', text: 'ok', verdict: 'pass', method: 'ai', observation: 'ok' }],
      durationMs: 5,
    });
    const fetchSafe: typeof fetch = async () => new Response('unauthorized', { status: 401 });

    // Budget expires right after Check 3 + Check 11 -> drops ONLY Check 12
    let t = 0;
    const drop12Only = await evaluateGrade1Profile({
      dryRun: false,
      active: true,
      fallbackUrl: 'http://127.0.0.1:4173/',
      crawl,
      maxRps: 100,
      modelActive: true,
      accounts,
      spendingRoutes: ['/api/chat'],
      fetchImpl: fetchSafe,
      deadlineMs: 50,
      now: () => t,
      runCheck3Templates: async () => {
        t = 20;
        return [passPlan('grade-1/check-3-signup'), passPlan('grade-1/check-3-login')];
      },
      // Advance clock right before Check 12 by wrapping fetchImpl for Check 11 response
    });
    expect(drop12Only.readiness.checks.find((c) => c.number === 3)?.verdict).toBe('pass');
    expect(drop12Only.readiness.checks.find((c) => c.number === 11)?.verdict).toBe('pass');

    let t2 = 0;
    const drop12Clock = await evaluateGrade1Profile({
      dryRun: false,
      active: true,
      fallbackUrl: 'http://127.0.0.1:4173/',
      crawl,
      maxRps: 100,
      modelActive: true,
      accounts,
      probeUrls: ['http://127.0.0.1:4173/search?q=1'],
      spendingRoutes: ['/api/chat'],
      deadlineMs: 50,
      now: () => t2,
      fetchImpl: async (input) => {
        if (String(input).includes('canary.miqyas-probe.invalid')) {
          t2 = 60;
        }
        return new Response('<p>safe</p>', { status: 200, headers: { 'content-type': 'text/html' } });
      },
      runCheck3Templates: async () => {
        t2 = 20;
        return [passPlan('grade-1/check-3-signup'), passPlan('grade-1/check-3-login')];
      },
    });
    expect(drop12Clock.readiness.checks.find((c) => c.number === 3)?.verdict).toBe('pass');
    expect(drop12Clock.readiness.checks.find((c) => c.number === 11)?.verdict).toBe('pass');
    expect(drop12Clock.readiness.checks.find((c) => c.number === 12)?.verdict).toBe('not_checked');
    expect(drop12Clock.readiness.checks.find((c) => c.number === 12)?.reason).toBe(TIME_LIMIT_DROP_REASON);

    // Budget expires right after Check 3 -> drops Checks 11 AND 12
    let t3 = 0;
    const drop11And12 = await evaluateGrade1Profile({
      dryRun: false,
      active: true,
      fallbackUrl: 'http://127.0.0.1:4173/',
      crawl,
      maxRps: 100,
      modelActive: true,
      accounts,
      spendingRoutes: ['/api/chat'],
      deadlineMs: 50,
      now: () => t3,
      fetchImpl: fetchSafe,
      runCheck3Templates: async () => {
        t3 = 60;
        return [passPlan('grade-1/check-3-signup'), passPlan('grade-1/check-3-login')];
      },
    });
    expect(drop11And12.readiness.checks.find((c) => c.number === 3)?.verdict).toBe('pass');
    expect(drop11And12.readiness.checks.find((c) => c.number === 11)?.verdict).toBe('not_checked');
    expect(drop11And12.readiness.checks.find((c) => c.number === 12)?.verdict).toBe('not_checked');

    // Zero budget -> drops 12, 11, AND 3
    const dropAllThree = await evaluateGrade1Profile({
      dryRun: false,
      active: true,
      fallbackUrl: 'http://127.0.0.1:4173/',
      crawl,
      maxRps: 100,
      modelActive: true,
      accounts,
      spendingRoutes: ['/api/chat'],
      fetchImpl: fetchSafe,
      maxTimeMs: 0,
      runCheck3Templates: async () => [passPlan('grade-1/check-3-signup'), passPlan('grade-1/check-3-login')],
    });
    for (const num of [3, 11, 12]) {
      const c = dropAllThree.readiness.checks.find((x) => x.number === num);
      expect(c?.verdict).toBe('not_checked');
      expect(c?.reason).toBe(TIME_LIMIT_DROP_REASON);
    }

    // Overrun mid-Check-3 (partial/error after deadline) also cleanly reports Check 3 as dropped (not_checked)
    let t4 = 0;
    const dropMid3 = await evaluateGrade1Profile({
      dryRun: false,
      active: true,
      fallbackUrl: 'http://127.0.0.1:4173/',
      crawl,
      maxRps: 100,
      modelActive: true,
      accounts,
      spendingRoutes: ['/api/chat'],
      fetchImpl: fetchSafe,
      deadlineMs: 50,
      now: () => t4,
      runCheck3Templates: async () => {
        t4 = 60;
        const partial = passPlan('grade-1/check-3-signup');
        return [partial, { ...passPlan('grade-1/check-3-login'), verdict: 'error', counts: { ...partial.counts, passed: 0, notChecked: 1 }, error: 'plan timed out' }];
      },
    });
    for (const num of [3, 11, 12]) {
      const c = dropMid3.readiness.checks.find((x) => x.number === num);
      expect(c?.verdict).toBe('not_checked');
      expect(c?.reason).toBe(TIME_LIMIT_DROP_REASON);
    }
  });
});

function cleanRepoWithLock(dir: string): string {
  const repo = path.join(dir, 'full-clean-repo');
  mkdirSync(path.join(repo, 'supabase/migrations'), { recursive: true });
  writeFileSync(
    path.join(repo, 'supabase/migrations/001.sql'),
    'CREATE TABLE public.items (id uuid primary key);\nALTER TABLE public.items ENABLE ROW LEVEL SECURITY;\n',
  );
  writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: 'ok', lockfileVersion: 3, packages: { '': {} } }));
  return repo;
}
