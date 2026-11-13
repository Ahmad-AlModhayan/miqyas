// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Grade 1 readiness profile & 8-pillar ledger evaluation (ADR 0004, SRS §3.12 FR-Q1..FR-Q8, PRD §6).

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  detectKnownSecretFormats,
  isGitRepo,
  probeGitleaksVersion,
  runGitleaksDir,
  runGitleaksGit,
  scanRepoKnownFormats,
  type GitleaksExecOptions,
  type SecretHit,
} from '../adapters/gitleaks.js';
import { analyzeMigrationsRls, LIBPG_QUERY_VERSION } from '../adapters/migrations.js';
import { runOsvScannerOffline, type OsvExecOptions } from '../adapters/osv.js';
import type { CrawlResult, ServedArtifact } from '../surfaces/session.js';
import { findingDedupeKey, type Finding } from './findings.js';
import { PlanLedger, type PlanResult } from './ledger.js';
import { parsePlan, type Plan } from './plan.js';
import type { AdapterMethodInfo } from './report.js';

export type ReadinessProfile = 'grade-1';
export type ReadinessStatus = 'ready' | 'not_ready';
export type ReadinessCheckStatus = 'pass' | 'fail' | 'not_checked';

export type PillarId =
  | 'code-and-logic'
  | 'ui-states-and-flows'
  | 'data-and-money'
  | 'apis-and-third-parties'
  | 'security-and-tenant-isolation'
  | 'performance-and-cost'
  | 'operations'
  | 'ai-and-compliance';

export interface ReadinessPillarSpec {
  id: PillarId;
  name: string;
  order: number;
  applicableAtGrade1: boolean;
}

export interface ReadinessCheckSpec {
  number: number;
  id: string;
  stepId: string;
  pillar: PillarId;
  title: string;
  runner: string;
  needs: string;
  mode: 'passive' | 'active';
  securityCheck: boolean;
  minCoverage: string;
}

export interface ReadinessCheckResult {
  number: number;
  id: string;
  stepId: string;
  pillar: PillarId;
  title: string;
  mode: 'passive' | 'active';
  verdict: ReadinessCheckStatus;
  method: 'code' | 'none';
  adapter?: string;
  adapterVersion?: string | null;
  coverage: string;
  observation: string;
  reason?: string;
  whatToAdd?: string;
  securityNotice?: string;
  evidenceIds?: string[];
}

export interface ReadinessPillarSummary {
  id: PillarId;
  name: string;
  applicableAtGrade: boolean;
  total: number;
  passed: number;
  failed: number;
  notChecked: number;
}

export interface ReadinessReport {
  profile: ReadinessProfile;
  status: ReadinessStatus;
  summary: string;
  counts: {
    total: number;
    passed: number;
    failed: number;
    notChecked: number;
  };
  pillars: ReadinessPillarSummary[];
  checks: ReadinessCheckResult[];
  whatToAdd: string[];
}

export const SECURITY_NOTICE = 'not a penetration test';

/** The eight canonical readiness pillars in CHARTER.md order. */
export const READINESS_PILLARS: readonly ReadinessPillarSpec[] = [
  { id: 'code-and-logic', name: 'Code and logic', order: 1, applicableAtGrade1: true },
  { id: 'ui-states-and-flows', name: 'UI states and flows', order: 2, applicableAtGrade1: true },
  { id: 'data-and-money', name: 'Data and money', order: 3, applicableAtGrade1: true },
  { id: 'apis-and-third-parties', name: 'APIs and third parties', order: 4, applicableAtGrade1: false },
  { id: 'security-and-tenant-isolation', name: 'Security and tenant isolation', order: 5, applicableAtGrade1: true },
  { id: 'performance-and-cost', name: 'Performance and cost', order: 6, applicableAtGrade1: true },
  { id: 'operations', name: 'Operations', order: 7, applicableAtGrade1: false },
  { id: 'ai-and-compliance', name: 'AI and compliance', order: 8, applicableAtGrade1: false },
];

/** The 13 Grade 1 early-access checks defined in PRD §6. */
export const GRADE_1_CHECKS: readonly ReadinessCheckSpec[] = [
  {
    number: 1,
    id: 'grade-1/check-1',
    stepId: 'check-1',
    pillar: 'ui-states-and-flows',
    title: 'Every screen the crawl reaches loads with no page error, uncaught console error or same-origin 5xx',
    runner: 'playwright',
    needs: '--url',
    mode: 'passive',
    securityCheck: false,
    minCoverage: '>= 1 crawled screen',
  },
  {
    number: 2,
    id: 'grade-1/check-2',
    stepId: 'check-2',
    pillar: 'ui-states-and-flows',
    title: 'Every control the crawl clicks does something; destructive ones listed as not clicked',
    runner: 'playwright',
    needs: '--url',
    mode: 'passive',
    securityCheck: false,
    minCoverage: '>= 1 crawled screen',
  },
  {
    number: 3,
    id: 'grade-1/check-3',
    stepId: 'check-3',
    pillar: 'ui-states-and-flows',
    title: 'Sign-up and log-in work',
    runner: 'agent+code',
    needs: 'model + two test accounts',
    mode: 'passive',
    securityCheck: false,
    minCoverage: 'sign-up and log-in flows verified',
  },
  {
    number: 4,
    id: 'grade-1/check-4',
    stepId: 'check-4',
    pillar: 'ui-states-and-flows',
    title: 'No critical or serious violation on any screen reached',
    runner: 'axe-core',
    needs: '--url',
    mode: 'passive',
    securityCheck: false,
    minCoverage: '>= 1 crawled screen',
  },
  {
    number: 5,
    id: 'grade-1/check-5',
    stepId: 'check-5',
    pillar: 'security-and-tenant-isolation',
    title: 'No secret key in the served bundle, source maps, URLs, DOM or storage',
    runner: 'gitleaks',
    needs: '--url and gitleaks binary',
    mode: 'passive',
    securityCheck: true,
    minCoverage: '>= 1 crawled screen with served/DOM/storage artifacts scanned',
  },
  {
    number: 6,
    id: 'grade-1/check-6',
    stepId: 'check-6',
    pillar: 'security-and-tenant-isolation',
    title: 'No secret key in repo files or git history',
    runner: 'gitleaks',
    needs: '--repo and gitleaks binary',
    mode: 'passive',
    securityCheck: true,
    minCoverage: 'repository working tree and git history scanned',
  },
  {
    number: 7,
    id: 'grade-1/check-7',
    stepId: 'check-7',
    pillar: 'data-and-money',
    title: 'Every public table in the migrations has RLS on',
    runner: 'libpg-query',
    needs: '--repo',
    mode: 'passive',
    securityCheck: false,
    minCoverage: 'SQL migrations parsed',
  },
  {
    number: 8,
    id: 'grade-1/check-8',
    stepId: 'check-8',
    pillar: 'security-and-tenant-isolation',
    title: "The public key can't read the backend's tables (Supabase, Firebase)",
    runner: 'miqyas-probe',
    needs: '--active and an owned host off test hosts',
    mode: 'active',
    securityCheck: true,
    minCoverage: 'detected backend targets probed',
  },
  {
    number: 9,
    id: 'grade-1/check-9',
    stepId: 'check-9',
    pillar: 'security-and-tenant-isolation',
    title: "One test account can't read the other's records",
    runner: 'miqyas-probe',
    needs: '--active and two test accounts',
    mode: 'active',
    securityCheck: true,
    minCoverage: 'two-account IDOR replay probes executed',
  },
  {
    number: 10,
    id: 'grade-1/check-10',
    stepId: 'check-10',
    pillar: 'security-and-tenant-isolation',
    title: 'Routes seen behind log-in refuse a request with no session',
    runner: 'miqyas-probe',
    needs: '--active and one test account',
    mode: 'active',
    securityCheck: true,
    minCoverage: 'authenticated routes replayed without session',
  },
  {
    number: 11,
    id: 'grade-1/check-11',
    stepId: 'check-11',
    pillar: 'security-and-tenant-isolation',
    title: 'No reflected XSS or open redirect on the params seen',
    runner: 'miqyas-probe',
    needs: '--active',
    mode: 'active',
    securityCheck: true,
    minCoverage: 'observed URL/form params probed',
  },
  {
    number: 12,
    id: 'grade-1/check-12',
    stepId: 'check-12',
    pillar: 'performance-and-cost',
    title: 'Routes that spend money (LLM, SMS, email) refuse a request with no session',
    runner: 'miqyas-probe',
    needs: '--active, --allow-writes off test hosts, and an owned host',
    mode: 'active',
    securityCheck: false,
    minCoverage: 'spending routes replayed without session',
  },
  {
    number: 13,
    id: 'grade-1/check-13',
    stepId: 'check-13',
    pillar: 'code-and-logic',
    title: 'No critical, high or malicious dependency in the lockfile',
    runner: 'osv-scanner',
    needs: '--repo, osv-scanner binary, and `miqyas update-db`',
    mode: 'passive',
    securityCheck: false,
    minCoverage: 'lockfiles scanned offline against OSV DB',
  },
];

/** Validate `--profile <name>` flag values. */
export function parseReadinessProfile(raw: string): ReadinessProfile {
  const norm = raw.trim().toLowerCase();
  if (norm === 'grade-1') return 'grade-1';
  throw new Error(`--profile must be "grade-1" (got "${raw}")`);
}

/** Build the synthetic Plan containing all 13 Grade 1 assertions written by Miqyas itself (ADR 0004). */
export function createGrade1Plan(): Plan {
  return parsePlan(
    {
      format: 'miqyas-plan',
      version: 1,
      id: 'grade-1',
      name: 'Grade 1 readiness profile',
      surface: 'web',
      steps: GRADE_1_CHECKS.map((c) => ({
        id: c.stepId,
        type: 'assertion',
        text: `Check ${c.number}: ${c.title}`,
      })),
    },
    'grade-1',
  );
}

/** Compute the structured ReadinessReport block without arbitrary scores out of 100. */
export function buildReadinessReport(
  checks: readonly ReadinessCheckResult[],
  profile: ReadinessProfile = 'grade-1',
): ReadinessReport {
  const sorted = [...checks].sort((a, b) => a.number - b.number);
  const total = sorted.length;
  const passed = sorted.filter((c) => c.verdict === 'pass').length;
  const failed = sorted.filter((c) => c.verdict === 'fail').length;
  const notChecked = sorted.filter((c) => c.verdict === 'not_checked').length;
  const status: ReadinessStatus = total > 0 && passed === total && failed === 0 && notChecked === 0 ? 'ready' : 'not_ready';
  const summary =
    status === 'ready'
      ? `Grade 1: ready (${passed} of ${total} pass)`
      : `Grade 1: not ready (${passed} of ${total} pass, ${failed} fail, ${notChecked} not checked)`;

  const pillars: ReadinessPillarSummary[] = READINESS_PILLARS.map((p) => {
    const pc = sorted.filter((c) => c.pillar === p.id);
    return {
      id: p.id,
      name: p.name,
      applicableAtGrade: p.applicableAtGrade1,
      total: pc.length,
      passed: pc.filter((c) => c.verdict === 'pass').length,
      failed: pc.filter((c) => c.verdict === 'fail').length,
      notChecked: pc.filter((c) => c.verdict === 'not_checked').length,
    };
  });

  const whatToAdd = [...new Set(sorted.filter((c) => c.verdict === 'not_checked' && c.whatToAdd).map((c) => c.whatToAdd!))];

  return {
    profile,
    status,
    summary,
    counts: { total, passed, failed, notChecked },
    pillars,
    checks: sorted,
    whatToAdd,
  };
}

/** Record all Grade 1 readiness checks into a closed PlanLedger so PASS === conjunction of recorded passes. */
export function recordReadinessInLedger(
  checks: readonly ReadinessCheckResult[],
  opts: { dryRun?: boolean } = {},
): PlanResult {
  const ledger = new PlanLedger(createGrade1Plan());
  for (const c of checks) {
    ledger.recordAssertion({
      stepId: c.stepId,
      verdict: c.verdict,
      method: c.method,
      observation: c.observation,
      ...(c.reason ? { reason: c.reason } : {}),
    });
  }
  if (opts.dryRun) ledger.fail('dry run: readiness checks not executed');
  return ledger.close(0);
}

function stripLocationLine(loc: string): string {
  return loc.replace(/:\d+$/, '');
}

function sanitizeArtifactUrl(rawUrl: string, hide: (t: string) => string): string {
  try {
    const u = new URL(rawUrl);
    return hide(`${u.origin}${u.pathname}`);
  } catch {
    return hide(rawUrl.split(/[?#]/)[0] ?? rawUrl);
  }
}

function knownSecretFamily(ruleId: string): string {
  const r = ruleId.toLowerCase();
  if (r.includes('stripe')) return 'stripe';
  if (r.includes('aws')) return 'aws';
  if (r.includes('github') || /^gh[pouhr]_/.test(r)) return 'github';
  if (r.includes('anthropic')) return 'anthropic';
  if (r.includes('slack')) return 'slack';
  if (r.includes('private-key') || r.includes('private_key') || r.includes('asymmetric')) return 'private-key';
  if (r.includes('supabase')) return 'supabase';
  return r;
}

/** Deduplicate hits across gitleaks and supplementary known-format detectors without double-counting the same key. */
function dedupeSecretHits(hits: readonly SecretHit[]): SecretHit[] {
  const gitleaksCounts = new Map<string, number>();
  for (const h of hits) {
    if (h.knownFormat && h.line !== undefined) {
      const fk = `${knownSecretFamily(h.ruleId)}|${stripLocationLine(h.location)}|${h.commit ?? ''}`;
      gitleaksCounts.set(fk, (gitleaksCounts.get(fk) ?? 0) + 1);
    }
  }
  const seen = new Set<string>();
  const out: SecretHit[] = [];
  // Process lined (gitleaks) hits first so supplementary hits don't shadow line-numbered ones.
  const ordered = [...hits.filter((h) => h.line !== undefined), ...hits.filter((h) => h.line === undefined)];
  for (const hit of ordered) {
    if (hit.knownFormat && hit.line === undefined) {
      const fk = `${knownSecretFamily(hit.ruleId)}|${stripLocationLine(hit.location)}|${hit.commit ?? ''}`;
      const remaining = gitleaksCounts.get(fk) ?? 0;
      if (remaining > 0) {
        gitleaksCounts.set(fk, remaining - 1);
        continue;
      }
    }
    const key = `${hit.ruleId}|${hit.location}|${hit.knownFormat}|${hit.commit ?? ''}|${hit.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function hitsToFindings(hits: readonly SecretHit[], prefix: string, checkNumber: number, hide: (t: string) => string): Finding[] {
  return dedupeSecretHits(hits).map((hit, i) => ({
    id: `${prefix}:${i + 1}`,
    category: 'secret-exposure',
    title: hit.knownFormat
      ? `Check ${checkNumber}: ${hit.description}`
      : `Check ${checkNumber}: generic gitleaks match (${hit.ruleId})`,
    severity: hit.severity,
    source: 'code',
    confirmed: true,
    evidence: hide(hit.evidence),
  }));
}

function safeArtifactFilename(index: number, art: ServedArtifact): string {
  const clean = art.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'artifact';
  return `${String(index + 1).padStart(4, '0')}-${art.kind}-${clean}.txt`;
}

function secretCheckNotChecked(
  spec: ReadinessCheckSpec,
  opts: {
    coverage: string;
    reason: string;
    whatToAdd: string;
    adapter?: string;
    adapterVersion?: string | null;
    adapterInfo?: AdapterMethodInfo;
  },
): { check: ReadinessCheckResult; findings: Finding[]; adapterInfo?: AdapterMethodInfo } {
  return {
    check: {
      number: spec.number,
      id: spec.id,
      stepId: spec.stepId,
      pillar: spec.pillar,
      title: spec.title,
      mode: spec.mode,
      verdict: 'not_checked',
      method: 'none',
      adapter: opts.adapter ?? 'gitleaks',
      ...(opts.adapterVersion !== undefined ? { adapterVersion: opts.adapterVersion } : {}),
      coverage: opts.coverage,
      observation: '',
      reason: opts.reason,
      whatToAdd: opts.whatToAdd,
      ...(spec.securityCheck ? { securityNotice: SECURITY_NOTICE } : {}),
    },
    findings: [],
    ...(opts.adapterInfo ? { adapterInfo: opts.adapterInfo } : {}),
  };
}

/** Check 5: No secret key in served bundle, source maps, URLs, DOM or storage (gitleaks --redact + known formats). */
export async function evaluateCheck5ServedSecrets(opts: {
  crawl?: CrawlResult;
  hide?: (t: string) => string;
  gitleaks?: GitleaksExecOptions;
}): Promise<{
  check: ReadinessCheckResult;
  findings: Finding[];
  adapterInfo?: AdapterMethodInfo;
}> {
  const spec = GRADE_1_CHECKS[4]!;
  const hide = opts.hide ?? ((t: string) => t);
  const gitleaksOpts: GitleaksExecOptions = { hide, ...opts.gitleaks };
  const screensCount = opts.crawl?.screens.length ?? 0;

  if (!opts.crawl || screensCount < 1) {
    return secretCheckNotChecked(spec, {
      coverage: '0 screens scanned',
      reason: 'crawl did not reach at least 1 screen',
      whatToAdd: 'Run against a reachable --url so passive crawl inspects >= 1 screen',
    });
  }

  const version = await probeGitleaksVersion(gitleaksOpts);
  if (!version) {
    return secretCheckNotChecked(spec, {
      adapterVersion: null,
      coverage: `${screensCount} screen(s) crawled; gitleaks binary missing`,
      reason: 'gitleaks binary not found on PATH',
      whatToAdd: 'Install gitleaks (https://github.com/gitleaks/gitleaks) and ensure it is on PATH',
      adapterInfo: {
        id: 'gitleaks',
        version: null,
        coverage: 'gitleaks binary missing on PATH',
        status: 'skipped',
        detail: 'Check 5 marked not_checked because gitleaks was not found',
      },
    });
  }

  const artifacts = opts.crawl.servedArtifacts ?? [];
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-check5-'));
  const knownHits: SecretHit[] = [];
  const genericHits: SecretHit[] = [];
  try {
    const artifactFiles = new Map<string, string>();
    for (let i = 0; i < artifacts.length; i++) {
      const art = artifacts[i]!;
      const fileName = safeArtifactFilename(i, art);
      const label = `${art.kind} ${hide(art.name)} (${sanitizeArtifactUrl(art.url, hide)})`;
      artifactFiles.set(fileName, label);
      await writeFile(path.join(tmpDir, fileName), art.text, 'utf8');
      knownHits.push(...detectKnownSecretFormats(art.text, label, hide));
    }

    const dirScan = await runGitleaksDir(tmpDir, gitleaksOpts);
    if (dirScan.status === 'missing') {
      return secretCheckNotChecked(spec, {
        adapterVersion: null,
        coverage: `${screensCount} screen(s) crawled; gitleaks unavailable`,
        reason: 'gitleaks binary not found on PATH',
        whatToAdd: 'Install gitleaks (https://github.com/gitleaks/gitleaks) and ensure it is on PATH',
        adapterInfo: { id: 'gitleaks', version: null, coverage: 'gitleaks binary missing on PATH', status: 'skipped' },
      });
    }
    if (dirScan.status === 'error') {
      return secretCheckNotChecked(spec, {
        adapterVersion: version,
        coverage: `${screensCount} screen(s), ${artifacts.length} artifact(s)`,
        reason: dirScan.error ?? 'gitleaks dir scan failed',
        whatToAdd: 'Ensure `gitleaks dir --redact` succeeds on served bundle artifacts',
        adapterInfo: {
          id: 'gitleaks',
          version,
          coverage: `${screensCount} screen(s), ${artifacts.length} served artifact(s)`,
          status: 'error',
          ...(dirScan.error ? { detail: dirScan.error } : {}),
        },
      });
    }

    const remapLoc = (hit: SecretHit): SecretHit => {
      const base = path.basename(stripLocationLine(hit.location));
      const label = artifactFiles.get(base);
      if (!label) return hit;
      const remappedLoc = hit.line !== undefined ? `${label}:${hit.line}` : label;
      return { ...hit, location: remappedLoc, evidence: hit.evidence.replace(hit.location, remappedLoc) };
    };
    knownHits.push(...dirScan.knownHits.map(remapLoc));
    genericHits.push(...dirScan.genericHits.map(remapLoc));
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const dedupedKnown = dedupeSecretHits(knownHits);
  const dedupedGeneric = dedupeSecretHits(genericHits);
  const findings = hitsToFindings([...dedupedKnown, ...dedupedGeneric], 'gitleaks-check5', 5, hide);
  const truncCount = opts.crawl.truncatedArtifacts ?? 0;
  const truncNote = truncCount > 0 ? `; ${truncCount} oversized/capped artifact(s) sliced` : '';
  const coverage = `${screensCount} screen(s), ${artifacts.length} served/source-map/DOM/storage artifact(s) scanned via gitleaks ${version} (--redact)${truncNote}`;

  if (dedupedKnown.length > 0) {
    return {
      check: {
        number: spec.number,
        id: spec.id,
        stepId: spec.stepId,
        pillar: spec.pillar,
        title: spec.title,
        mode: spec.mode,
        verdict: 'fail',
        method: 'code',
        adapter: 'gitleaks',
        adapterVersion: version,
        coverage,
        observation: `${dedupedKnown.length} known secret key format(s) exposed in served surface (${dedupedGeneric.length} generic match(es) recorded as findings)`,
        securityNotice: SECURITY_NOTICE,
        evidenceIds: findings.map((f) => f.id),
      },
      findings,
      adapterInfo: { id: 'gitleaks', version, coverage, status: 'ok' },
    };
  }

  return {
    check: {
      number: spec.number,
      id: spec.id,
      stepId: spec.stepId,
      pillar: spec.pillar,
      title: spec.title,
      mode: spec.mode,
      verdict: 'pass',
      method: 'code',
      adapter: 'gitleaks',
      adapterVersion: version,
      coverage,
      observation:
        dedupedGeneric.length > 0
          ? `0 known secret key formats found across ${artifacts.length} artifact(s) (${dedupedGeneric.length} generic match(es) recorded as findings)`
          : `0 secret keys found across ${artifacts.length} served/source-map/DOM/storage artifact(s)`,
      securityNotice: SECURITY_NOTICE,
      ...(findings.length ? { evidenceIds: findings.map((f) => f.id) } : {}),
    },
    findings,
    adapterInfo: { id: 'gitleaks', version, coverage, status: 'ok' },
  };
}

/** Check 6: No secret key in repository files or git history (gitleaks --redact + known formats). */
export async function evaluateCheck6RepoSecrets(opts: {
  repoPath?: string;
  hide?: (t: string) => string;
  gitleaks?: GitleaksExecOptions;
}): Promise<{
  check: ReadinessCheckResult;
  findings: Finding[];
  adapterInfo?: AdapterMethodInfo;
}> {
  const spec = GRADE_1_CHECKS[5]!;
  const hide = opts.hide ?? ((t: string) => t);
  const gitleaksOpts: GitleaksExecOptions = { hide, ...opts.gitleaks };

  if (!opts.repoPath) {
    return secretCheckNotChecked(spec, {
      coverage: 'no --repo provided',
      reason: '--repo was not provided',
      whatToAdd: 'Pass --repo <path> to scan repository files and git history',
    });
  }

  const resolvedRepo = path.resolve(opts.repoPath);
  const repoStat = await stat(resolvedRepo).catch(() => null);
  if (!repoStat || !repoStat.isDirectory()) {
    return secretCheckNotChecked(spec, {
      coverage: 'invalid --repo directory',
      reason: '--repo directory does not exist',
      whatToAdd: 'Pass a valid directory path to --repo <path>',
    });
  }

  const version = await probeGitleaksVersion(gitleaksOpts);
  if (!version) {
    return secretCheckNotChecked(spec, {
      adapterVersion: null,
      coverage: 'gitleaks binary missing on PATH',
      reason: 'gitleaks binary not found on PATH',
      whatToAdd: 'Install gitleaks (https://github.com/gitleaks/gitleaks) and ensure it is on PATH',
      adapterInfo: {
        id: 'gitleaks',
        version: null,
        coverage: 'gitleaks binary missing on PATH',
        status: 'skipped',
        detail: 'Check 6 marked not_checked because gitleaks was not found',
      },
    });
  }

  const hasGit = await isGitRepo(resolvedRepo);
  const dirScan = await runGitleaksDir(resolvedRepo, gitleaksOpts);
  if (dirScan.status === 'error') {
    return secretCheckNotChecked(spec, {
      adapterVersion: version,
      coverage: 'gitleaks dir scan errored',
      reason: dirScan.error ?? 'gitleaks dir scan failed',
      whatToAdd: 'Ensure `gitleaks dir --redact` completes cleanly on --repo',
      adapterInfo: {
        id: 'gitleaks',
        version,
        coverage: 'repo scan failed',
        status: 'error',
        ...(dirScan.error ? { detail: dirScan.error } : {}),
      },
    });
  }

  const gitScan = hasGit ? await runGitleaksGit(resolvedRepo, gitleaksOpts) : null;
  if (gitScan && gitScan.status === 'error') {
    return secretCheckNotChecked(spec, {
      adapterVersion: version,
      coverage: 'gitleaks git scan errored',
      reason: gitScan.error ?? 'gitleaks git scan failed',
      whatToAdd: 'Ensure `gitleaks git --redact` completes cleanly on --repo',
      adapterInfo: {
        id: 'gitleaks',
        version,
        coverage: 'repo git scan failed',
        status: 'error',
        ...(gitScan.error ? { detail: gitScan.error } : {}),
      },
    });
  }

  const curScan = await scanRepoKnownFormats(resolvedRepo, hasGit, hide);
  const dedupedKnown = dedupeSecretHits([...dirScan.knownHits, ...(gitScan?.knownHits ?? []), ...curScan.hits]);
  const dedupedGeneric = dedupeSecretHits([...dirScan.genericHits, ...(gitScan?.genericHits ?? [])]);
  const findings = hitsToFindings([...dedupedKnown, ...dedupedGeneric], 'gitleaks-check6', 6, hide);
  const coverage = hasGit
    ? `repo files + git history scanned via gitleaks ${version} (--redact)`
    : `repo files scanned via gitleaks ${version} (--redact); no .git history`;

  if (dedupedKnown.length > 0) {
    return {
      check: {
        number: spec.number,
        id: spec.id,
        stepId: spec.stepId,
        pillar: spec.pillar,
        title: spec.title,
        mode: spec.mode,
        verdict: 'fail',
        method: 'code',
        adapter: 'gitleaks',
        adapterVersion: version,
        coverage,
        observation: `${dedupedKnown.length} known secret key match(es) detected in repository (${dedupedGeneric.length} generic match(es) recorded as findings)`,
        securityNotice: SECURITY_NOTICE,
        evidenceIds: findings.map((f) => f.id),
      },
      findings,
      adapterInfo: { id: 'gitleaks', version, coverage, status: 'ok' },
    };
  }

  if (curScan.gitHistoryError) {
    return {
      ...secretCheckNotChecked(spec, {
        adapterVersion: version,
        coverage,
        reason: `supplementary git history scan incomplete (${curScan.gitHistoryError})`,
        whatToAdd: 'Ensure git log --all -p succeeds cleanly on --repo',
        adapterInfo: {
          id: 'gitleaks',
          version,
          coverage,
          status: 'error',
          detail: curScan.gitHistoryError,
        },
      }),
      findings,
    };
  }

  if (!hasGit) {
    return {
      check: {
        number: spec.number,
        id: spec.id,
        stepId: spec.stepId,
        pillar: spec.pillar,
        title: spec.title,
        mode: spec.mode,
        verdict: 'not_checked',
        method: 'none',
        adapter: 'gitleaks',
        adapterVersion: version,
        coverage,
        observation: '',
        reason: 'repository has no .git history to scan',
        whatToAdd: 'Point --repo at a git repository to cover git history in Check 6',
        securityNotice: SECURITY_NOTICE,
      },
      findings,
      adapterInfo: { id: 'gitleaks', version, coverage, status: 'ok' },
    };
  }

  return {
    check: {
      number: spec.number,
      id: spec.id,
      stepId: spec.stepId,
      pillar: spec.pillar,
      title: spec.title,
      mode: spec.mode,
      verdict: 'pass',
      method: 'code',
      adapter: 'gitleaks',
      adapterVersion: version,
      coverage,
      observation:
        dedupedGeneric.length > 0
          ? `0 known secret key formats found in repo files or git history (${dedupedGeneric.length} generic match(es) recorded as findings)`
          : '0 secret keys found in repository files or git history',
      securityNotice: SECURITY_NOTICE,
      ...(findings.length ? { evidenceIds: findings.map((f) => f.id) } : {}),
    },
    findings,
    adapterInfo: { id: 'gitleaks', version, coverage, status: 'ok' },
  };
}

/** Check 7: Every permanent table in public migrations has RLS enabled (libpg-query). */
export async function evaluateCheck7MigrationRls(opts: {
  repoPath?: string;
  hide?: (t: string) => string;
}): Promise<{
  check: ReadinessCheckResult;
  findings: Finding[];
  adapterInfo?: AdapterMethodInfo;
}> {
  const spec = GRADE_1_CHECKS[6]!;
  const hide = opts.hide ?? ((t: string) => t);
  if (!opts.repoPath) {
    return secretCheckNotChecked(spec, {
      adapter: 'libpg-query',
      adapterVersion: LIBPG_QUERY_VERSION,
      coverage: 'no --repo provided',
      reason: '--repo was not provided',
      whatToAdd: 'Pass --repo <path> containing SQL migrations to verify public-table RLS',
    });
  }

  const resolvedRepo = path.resolve(opts.repoPath);
  const repoStat = await stat(resolvedRepo).catch(() => null);
  if (!repoStat || !repoStat.isDirectory()) {
    return secretCheckNotChecked(spec, {
      adapter: 'libpg-query',
      adapterVersion: LIBPG_QUERY_VERSION,
      coverage: 'invalid --repo directory',
      reason: '--repo directory does not exist',
      whatToAdd: 'Pass a valid directory path to --repo <path>',
    });
  }

  const analysis = await analyzeMigrationsRls(resolvedRepo);
  if (analysis.status === 'no_migrations') {
    return secretCheckNotChecked(spec, {
      adapter: 'libpg-query',
      adapterVersion: analysis.version,
      coverage: analysis.coverage,
      reason: 'no SQL migration files found under --repo',
      whatToAdd: 'Place SQL migrations under supabase/migrations/ or migrations/ in --repo',
      adapterInfo: {
        id: 'libpg-query',
        version: analysis.version,
        coverage: analysis.coverage,
        status: 'skipped',
        detail: 'no SQL migration files found',
      },
    });
  }

  if (analysis.status === 'error') {
    return secretCheckNotChecked(spec, {
      adapter: 'libpg-query',
      adapterVersion: analysis.version,
      coverage: analysis.coverage,
      reason: `SQL migration parse failed (${hide(analysis.error ?? 'unknown syntax error')})`,
      whatToAdd: 'Fix invalid PostgreSQL syntax in repository SQL migrations',
      adapterInfo: {
        id: 'libpg-query',
        version: analysis.version,
        coverage: analysis.coverage,
        status: 'error',
        ...(analysis.error ? { detail: hide(analysis.error) } : {}),
      },
    });
  }

  const findings: Finding[] = analysis.missingRlsTables.map((t, i) => ({
    id: `libpg-query-check7:${i + 1}`,
    category: 'missing-rls',
    title: `Check 7: public table "${hide(`${t.schema}.${t.table}`)}" has RLS disabled`,
    severity: 'high',
    source: 'code',
    confirmed: true,
    evidence: hide(`${t.createdInFile}: CREATE TABLE ${t.schema}.${t.table} lacks active ENABLE ROW LEVEL SECURITY`),
  }));

  if (findings.length > 0) {
    return {
      check: {
        number: spec.number,
        id: spec.id,
        stepId: spec.stepId,
        pillar: spec.pillar,
        title: spec.title,
        mode: spec.mode,
        verdict: 'fail',
        method: 'code',
        adapter: 'libpg-query',
        adapterVersion: analysis.version,
        coverage: analysis.coverage,
        observation: `${findings.length} of ${analysis.publicTables.length} public table(s) lack RLS`,
        evidenceIds: findings.map((f) => f.id),
      },
      findings,
      adapterInfo: { id: 'libpg-query', version: analysis.version, coverage: analysis.coverage, status: 'ok' },
    };
  }

  return {
    check: {
      number: spec.number,
      id: spec.id,
      stepId: spec.stepId,
      pillar: spec.pillar,
      title: spec.title,
      mode: spec.mode,
      verdict: 'pass',
      method: 'code',
      adapter: 'libpg-query',
      adapterVersion: analysis.version,
      coverage: analysis.coverage,
      observation:
        analysis.publicTables.length > 0
          ? `${analysis.publicTables.length} public table(s) across ${analysis.files.length} migration file(s) all enable RLS`
          : `${analysis.files.length} migration file(s) parsed; 0 public tables created`,
    },
    findings: [],
    adapterInfo: { id: 'libpg-query', version: analysis.version, coverage: analysis.coverage, status: 'ok' },
  };
}

/** Check 13: No critical, high, or `MAL-` malicious package in repository lockfiles (`osv-scanner --offline`). */
export async function evaluateCheck13Dependencies(opts: {
  repoPath?: string;
  hide?: (t: string) => string;
  osv?: OsvExecOptions;
}): Promise<{
  check: ReadinessCheckResult;
  findings: Finding[];
  adapterInfo?: AdapterMethodInfo;
}> {
  const spec = GRADE_1_CHECKS[12]!;
  const hide = opts.hide ?? ((t: string) => t);

  if (!opts.repoPath) {
    return secretCheckNotChecked(spec, {
      adapter: 'osv-scanner',
      coverage: 'no --repo provided',
      reason: '--repo was not provided',
      whatToAdd: 'Pass --repo <path> and run `miqyas update-db` to scan lockfiles offline',
    });
  }

  const resolvedRepo = path.resolve(opts.repoPath);
  const repoStat = await stat(resolvedRepo).catch(() => null);
  if (!repoStat || !repoStat.isDirectory()) {
    return secretCheckNotChecked(spec, {
      adapter: 'osv-scanner',
      coverage: 'invalid --repo directory',
      reason: '--repo directory does not exist',
      whatToAdd: 'Pass a valid directory path to --repo <path>',
    });
  }

  const osvOpts: OsvExecOptions = { hide, ...opts.osv };
  const scan = await runOsvScannerOffline(resolvedRepo, osvOpts);

  if (scan.status === 'no_lockfiles') {
    return secretCheckNotChecked(spec, {
      adapter: 'osv-scanner',
      coverage: scan.coverage,
      reason: 'no supported lockfiles found in --repo',
      whatToAdd: 'Commit a supported lockfile (e.g. package-lock.json, pnpm-lock.yaml, requirements.txt) in --repo',
      adapterInfo: { id: 'osv-scanner', version: null, coverage: scan.coverage, status: 'skipped', detail: 'no lockfiles found' },
    });
  }

  if (scan.status === 'missing') {
    return secretCheckNotChecked(spec, {
      adapter: 'osv-scanner',
      adapterVersion: null,
      coverage: scan.coverage,
      reason: 'osv-scanner binary not found on PATH',
      whatToAdd: 'Install osv-scanner (https://github.com/google/osv-scanner) and run `miqyas update-db`',
      adapterInfo: { id: 'osv-scanner', version: null, coverage: scan.coverage, status: 'skipped', detail: 'osv-scanner binary missing' },
    });
  }

  if (scan.status === 'db_missing') {
    return secretCheckNotChecked(spec, {
      adapter: 'osv-scanner',
      adapterVersion: scan.version,
      coverage: scan.coverage,
      reason: 'offline OSV vulnerability database is not populated',
      whatToAdd: 'Run `miqyas update-db` to download offline OSV databases',
      adapterInfo: { id: 'osv-scanner', version: scan.version, coverage: scan.coverage, status: 'skipped', detail: 'offline DB not populated' },
    });
  }

  if (scan.status === 'error') {
    return secretCheckNotChecked(spec, {
      adapter: 'osv-scanner',
      adapterVersion: scan.version,
      coverage: scan.coverage,
      reason: scan.error ?? 'osv-scanner offline scan failed',
      whatToAdd: 'Run `miqyas update-db` and ensure `osv-scanner --offline` completes cleanly on --repo',
      adapterInfo: {
        id: 'osv-scanner',
        version: scan.version,
        coverage: scan.coverage,
        status: 'error',
        ...(scan.error ? { detail: scan.error } : {}),
      },
    });
  }

  const findings: Finding[] = scan.hits.map((h, i) => ({
    id: `osv-check13:${i + 1}`,
    category: 'vulnerable-dependency',
    title: `Check 13: ${h.id} in ${hide(h.packageName)}@${h.packageVersion} (${h.ecosystem})`,
    severity: h.severity,
    source: 'code',
    confirmed: true,
    evidence: hide(
      `${h.sourcePath}: ${h.packageName}@${h.packageVersion} (${h.id})${h.fixedVersions.length ? ` — fixed in ${h.fixedVersions.join(', ')}` : ''}: ${h.summary}`,
    ),
  }));

  const failing = scan.hits.filter((h) => h.failsCheck);
  const nonFailingCount = scan.hits.length - failing.length;

  if (failing.length > 0) {
    return {
      check: {
        number: spec.number,
        id: spec.id,
        stepId: spec.stepId,
        pillar: spec.pillar,
        title: spec.title,
        mode: spec.mode,
        verdict: 'fail',
        method: 'code',
        adapter: 'osv-scanner',
        adapterVersion: scan.version,
        coverage: scan.coverage,
        observation: `${failing.length} critical/high/MAL- issue(s) across ${scan.lockfiles.length} lockfile(s), ${scan.packageCount} package(s)${nonFailingCount ? ` (${nonFailingCount} medium/low recorded as findings)` : ''}`,
        evidenceIds: findings.map((f) => f.id),
      },
      findings,
      adapterInfo: { id: 'osv-scanner', version: scan.version, coverage: scan.coverage, status: 'ok' },
    };
  }

  return {
    check: {
      number: spec.number,
      id: spec.id,
      stepId: spec.stepId,
      pillar: spec.pillar,
      title: spec.title,
      mode: spec.mode,
      verdict: 'pass',
      method: 'code',
      adapter: 'osv-scanner',
      adapterVersion: scan.version,
      coverage: scan.coverage,
      observation:
        nonFailingCount > 0
          ? `0 critical, high, or MAL- vulnerabilities across ${scan.lockfiles.length} lockfile(s), ${scan.packageCount} package(s) (${nonFailingCount} medium/low recorded as findings)`
          : `0 critical, high, or MAL- vulnerabilities across ${scan.lockfiles.length} lockfile(s), ${scan.packageCount} package(s)`,
      ...(findings.length ? { evidenceIds: findings.map((f) => f.id) } : {}),
    },
    findings,
    adapterInfo: { id: 'osv-scanner', version: scan.version, coverage: scan.coverage, status: 'ok' },
  };
}

function defaultNotChecked(
  spec: ReadinessCheckSpec,
  opts: { dryRun: boolean; repoPath?: string; noModel?: boolean; active?: boolean },
): ReadinessCheckResult {
  let reason = `Check ${spec.number} (${spec.runner}) is not enabled in this build`;
  let whatToAdd = `Enable Check ${spec.number} (${spec.runner})`;
  if (opts.dryRun) {
    reason = 'dry run: readiness check was not executed';
    whatToAdd = 'Run without --dry-run (pass --no-model for offline code-judged checks)';
  } else if (spec.number === 3 && opts.noModel) {
    reason = '--no-model skips Check 3 (sign-up and log-in need a model and two test accounts)';
    whatToAdd = 'Run with a model and two test accounts to cover Check 3';
  } else if ([8, 9, 10, 11, 12].includes(spec.number) && !opts.active) {
    reason = '--active was not passed';
    whatToAdd = `Pass --active (${spec.needs})`;
  }
  return {
    number: spec.number,
    id: spec.id,
    stepId: spec.stepId,
    pillar: spec.pillar,
    title: spec.title,
    mode: spec.mode,
    verdict: 'not_checked',
    method: 'none',
    adapter: spec.runner,
    coverage: 'not executed',
    observation: '',
    reason,
    whatToAdd,
    ...(spec.securityCheck ? { securityNotice: SECURITY_NOTICE } : {}),
  };
}

/** Remap readiness check evidenceIds to post-dedupe report.findings[].id so cross-references never dangle. */
export function linkReadinessEvidenceIds(
  readiness: ReadinessReport,
  checkFindingKeys: ReadonlyMap<number, ReadonlySet<string>>,
  dedupedFindings: readonly Finding[],
): ReadinessReport {
  if (checkFindingKeys.size === 0 || dedupedFindings.length === 0) return readiness;
  const keyToId = new Map<string, string>();
  for (const f of dedupedFindings) {
    keyToId.set(findingDedupeKey(f), f.id);
  }
  return {
    ...readiness,
    checks: readiness.checks.map((c) => {
      const keys = checkFindingKeys.get(c.number);
      if (!keys || keys.size === 0) return c;
      const linkedIds: string[] = [];
      for (const k of keys) {
        const id = keyToId.get(k);
        if (id && !linkedIds.includes(id)) linkedIds.push(id);
      }
      return linkedIds.length > 0 ? { ...c, evidenceIds: linkedIds } : c;
    }),
  };
}

/** Evaluate all 13 Grade 1 readiness checks, returning ledger plan result, ReadinessReport, findings, and adapter info. */
export async function evaluateGrade1Profile(opts: {
  dryRun: boolean;
  noModel?: boolean;
  crawl?: CrawlResult;
  repoPath?: string;
  active?: boolean;
  hide?: (t: string) => string;
  gitleaks?: GitleaksExecOptions;
  osv?: OsvExecOptions;
}): Promise<{
  readiness: ReadinessReport;
  ledgerPlan: PlanResult;
  findings: Finding[];
  adapters: AdapterMethodInfo[];
  checkFindingKeys: Map<number, Set<string>>;
}> {
  const hide = opts.hide ?? ((t: string) => t);
  const findings: Finding[] = [];
  const adapters: AdapterMethodInfo[] = [];
  const checkFindingKeys = new Map<number, Set<string>>();

  if (opts.dryRun) {
    const checks = GRADE_1_CHECKS.map((spec) => defaultNotChecked(spec, opts));
    const readiness = buildReadinessReport(checks);
    return {
      readiness,
      ledgerPlan: recordReadinessInLedger(checks, { dryRun: true }),
      findings,
      adapters,
      checkFindingKeys,
    };
  }

  const c5 = await evaluateCheck5ServedSecrets({
    ...(opts.crawl ? { crawl: opts.crawl } : {}),
    hide,
    ...(opts.gitleaks ? { gitleaks: opts.gitleaks } : {}),
  });
  findings.push(...c5.findings);
  if (c5.findings.length > 0) {
    checkFindingKeys.set(5, new Set(c5.findings.map((f) => findingDedupeKey(f))));
  }

  const c6 = await evaluateCheck6RepoSecrets({
    ...(opts.repoPath ? { repoPath: opts.repoPath } : {}),
    hide,
    ...(opts.gitleaks ? { gitleaks: opts.gitleaks } : {}),
  });
  findings.push(...c6.findings);
  if (c6.findings.length > 0) {
    checkFindingKeys.set(6, new Set(c6.findings.map((f) => findingDedupeKey(f))));
  }

  const c7 = await evaluateCheck7MigrationRls({
    ...(opts.repoPath ? { repoPath: opts.repoPath } : {}),
    hide,
  });
  findings.push(...c7.findings);
  if (c7.findings.length > 0) {
    checkFindingKeys.set(7, new Set(c7.findings.map((f) => findingDedupeKey(f))));
  }

  const c13 = await evaluateCheck13Dependencies({
    ...(opts.repoPath ? { repoPath: opts.repoPath } : {}),
    hide,
    ...(opts.osv ? { osv: opts.osv } : {}),
  });
  findings.push(...c13.findings);
  if (c13.findings.length > 0) {
    checkFindingKeys.set(13, new Set(c13.findings.map((f) => findingDedupeKey(f))));
  }

  // Merge gitleaks adapter reporting cleanly into method.adapters (combining Checks 5 & 6 coverage).
  const glInfos = [c5.adapterInfo, c6.adapterInfo].filter((x): x is AdapterMethodInfo => Boolean(x));
  if (glInfos.length > 0) {
    const okInfo = glInfos.find((x) => x.status === 'ok');
    const errInfo = glInfos.find((x) => x.status === 'error');
    const version = glInfos.find((x) => x.version !== null)?.version ?? null;
    adapters.push({
      id: 'gitleaks',
      version,
      coverage: glInfos.map((x) => x.coverage).join(' | '),
      status: errInfo ? 'error' : okInfo ? 'ok' : 'skipped',
      ...(errInfo?.detail ? { detail: errInfo.detail } : {}),
    });
  }
  if (c7.adapterInfo) adapters.push(c7.adapterInfo);
  if (c13.adapterInfo) adapters.push(c13.adapterInfo);

  const checks: ReadinessCheckResult[] = GRADE_1_CHECKS.map((spec) => {
    if (spec.number === 5) return c5.check;
    if (spec.number === 6) return c6.check;
    if (spec.number === 7) return c7.check;
    if (spec.number === 13) return c13.check;
    return defaultNotChecked(spec, opts);
  });

  const readiness = buildReadinessReport(checks);
  const ledgerPlan = recordReadinessInLedger(checks);
  return { readiness, ledgerPlan, findings, adapters, checkFindingKeys };
}
