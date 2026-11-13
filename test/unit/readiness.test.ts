// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dedupeFindings } from '../../src/proof-core/findings.js';
import {
  buildReadinessReport,
  evaluateCheck1LoadErrors,
  evaluateCheck2Controls,
  evaluateCheck4Accessibility,
  evaluateCheck5ServedSecrets,
  evaluateCheck6RepoSecrets,
  evaluateCheck7MigrationRls,
  evaluateCheck13Dependencies,
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
