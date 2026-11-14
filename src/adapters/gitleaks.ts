// SPDX-License-Identifier: AGPL-3.0-only
// Gitleaks adapter (ADR 0005, FR-Q4): shells out to user-installed `gitleaks --redact` for served artifacts (Check 5)
// and repository + git history (Check 6), classifying known key formats (fail) vs generic hits (findings only).

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Adapter, AdapterContext, AdapterFinding, AdapterResult } from './adapter.js';

export type GitleaksMode = 'dir' | 'git';

export interface SecretHit {
  ruleId: string;
  description: string;
  knownFormat: boolean;
  severity: 'critical' | 'high' | 'medium';
  location: string;
  line?: number;
  commit?: string;
  evidence: string;
}

export interface GitleaksScanResult {
  status: 'ok' | 'missing' | 'error';
  mode: GitleaksMode;
  target: string;
  version: string | null;
  coverage: string;
  knownHits: SecretHit[];
  genericHits: SecretHit[];
  error?: string;
}

export interface GitleaksExecOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  hide?: (text: string) => string;
  extraArgs?: string[];
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Curated gitleaks rule IDs representing unambiguous secret key formats (fail-worthy); all other rules are generic. */
const KNOWN_GITLEAKS_RULES = new Set<string>([
  'aws-access-token',
  'aws-access-key',
  'aws-secret-key',
  'stripe-access-token',
  'stripe-live-key',
  'private-key',
  'rsa-private-key',
  'ec-private-key',
  'openssh-private-key',
  'pgp-private-key',
  'pkcs8-private-key',
  'github-pat',
  'github-fine-grained-pat',
  'github-oauth',
  'github-app-token',
  'github-refresh-token',
  'anthropic-api-key',
  'anthropic-admin-api-key',
  'openai-api-key',
  'slack-bot-token',
  'slack-user-token',
  'slack-app-token',
  'slack-config-access-token',
  'slack-config-refresh-token',
  'slack-webhook-url',
  'supabase-secret-key',
  'supabase-service-role-jwt',
  'sendgrid-api-token',
  'twilio-api-key',
]);

const KNOWN_RULE_PREFIXES = ['aws-access', 'stripe-access', 'private-key', 'github-', 'anthropic-', 'slack-', 'supabase-'];

const KNOWN_KEY_PATTERNS: readonly { id: string; label: string; severity: 'critical' | 'high'; re: RegExp }[] = [
  { id: 'supabase-secret-key', label: 'Supabase secret key', severity: 'critical', re: /\bsb_secret_[A-Za-z0-9_-]{12,}\b/g },
  { id: 'stripe-live-key', label: 'Stripe live key', severity: 'critical', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
  { id: 'aws-access-key', label: 'AWS access key ID', severity: 'critical', re: /(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}/g },
  { id: 'private-key', label: 'Private key block', severity: 'critical', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
  { id: 'github-pat', label: 'GitHub token', severity: 'critical', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/g },
  { id: 'github-fine-grained-pat', label: 'GitHub fine-grained token', severity: 'critical', re: /\bgithub_pat_[0-9A-Za-z]{22}_[0-9A-Za-z]{59}\b/g },
  { id: 'anthropic-api-key', label: 'Anthropic API key', severity: 'critical', re: /\bsk-ant-api03-[0-9A-Za-z_-]{20,}\b/g },
  { id: 'slack-bot-token', label: 'Slack token', severity: 'high', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
];

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g;

function maskRawSecret(raw: string, hide: (t: string) => string = (t) => t): string {
  // Always mask before passing through custom scrubbers so substring scrub rules never expose the remainder.
  const masked = raw.startsWith('-----BEGIN ')
    ? '[redacted PRIVATE KEY header]'
    : `${raw.slice(0, Math.min(4, raw.length))}*** (len ${raw.length})`;
  return hide(masked);
}

/** Safely inspect the payload `role` claim of a compact JWT; returns null on malformed tokens. */
export function decodeJwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const decoded = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const role = (parsed as Record<string, unknown>).role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

/** Classify whether a gitleaks RuleID belongs to curated unambiguous secret formats vs noisy/generic rules. */
export function classifyGitleaksRule(ruleId: string): 'known' | 'generic' {
  const norm = ruleId.trim().toLowerCase();
  if (!norm) return 'generic';
  if (norm === 'jwt' || norm.startsWith('generic')) return 'generic';
  if (KNOWN_GITLEAKS_RULES.has(norm)) return 'known';
  if (KNOWN_RULE_PREFIXES.some((p) => norm.startsWith(p))) return 'known';
  return 'generic';
}

/** Detect curated known secret key formats (including Supabase `sb_secret_` and `service_role` JWTs) without leaking secrets. */
export function detectKnownSecretFormats(
  text: string,
  location: string,
  hide: (t: string) => string = (t) => t,
): SecretHit[] {
  if (!text) return [];
  const hits: SecretHit[] = [];
  const seen = new Set<string>();
  const safeLoc = hide(location);

  const pushHit = (ruleId: string, description: string, severity: 'critical' | 'high', raw: string) => {
    const masked = maskRawSecret(raw, hide);
    const key = `${ruleId}|${safeLoc}|${masked}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({
      ruleId,
      description,
      knownFormat: true,
      severity,
      location: safeLoc,
      evidence: `${description} (${masked}) in ${safeLoc}`,
    });
  };

  for (const pat of KNOWN_KEY_PATTERNS) {
    pat.re.lastIndex = 0;
    for (const m of text.matchAll(pat.re)) {
      pushHit(pat.id, pat.label, pat.severity, m[0]);
    }
  }

  JWT_RE.lastIndex = 0;
  for (const m of text.matchAll(JWT_RE)) {
    const role = decodeJwtRole(m[0]);
    if (role === 'service_role') {
      pushHit('supabase-service-role-jwt', 'Supabase service_role JWT', 'critical', m[0]);
    }
  }

  return hits;
}

interface RawGitleaksFinding {
  RuleID?: unknown;
  Description?: unknown;
  File?: unknown;
  StartLine?: unknown;
  Commit?: unknown;
  Match?: unknown;
  Secret?: unknown;
}

interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  enoent: boolean;
  errorMessage?: string;
}

function execBinary(binary: string, args: readonly string[], opts: GitleaksExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      {
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr), enoent: false });
          return;
        }
        const errWithCode = err as NodeJS.ErrnoException & { status?: number };
        const enoent = errWithCode.code === 'ENOENT';
        const exitCode = typeof errWithCode.code === 'number' ? errWithCode.code : typeof errWithCode.status === 'number' ? errWithCode.status : null;
        resolve({
          exitCode,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          enoent,
          errorMessage: err.message.split('\n')[0],
        });
      },
    );
  });
}

/** Query `gitleaks version`; returns trimmed version string or `null` when binary is missing/unusable. */
export async function probeGitleaksVersion(opts: GitleaksExecOptions = {}): Promise<string | null> {
  const binary = opts.binary ?? 'gitleaks';
  const res = await execBinary(binary, ['version'], { ...opts, timeoutMs: opts.timeoutMs ?? 5_000 });
  if (res.enoent || res.exitCode !== 0) return null;
  const trimmed = res.stdout.trim().split('\n')[0]?.trim() ?? '';
  const cleaned = trimmed.replace(/^gitleaks\s+version\s+/i, '').trim();
  return cleaned || 'unknown';
}

function normalizeReportEntry(raw: RawGitleaksFinding, hide: (t: string) => string): SecretHit {
  const ruleId = typeof raw.RuleID === 'string' && raw.RuleID.trim() ? raw.RuleID.trim() : 'generic-secret';
  const description = typeof raw.Description === 'string' && raw.Description.trim() ? raw.Description.trim() : ruleId;
  const file = typeof raw.File === 'string' && raw.File.trim() ? hide(raw.File.trim()) : '(unknown file)';
  const line = typeof raw.StartLine === 'number' && Number.isInteger(raw.StartLine) && raw.StartLine > 0 ? raw.StartLine : undefined;
  const commit = typeof raw.Commit === 'string' && raw.Commit.trim() ? raw.Commit.trim().slice(0, 12) : undefined;
  // Wait until Secret/Match checks: --redact should already mask them, and we scrub defensively too.
  const secretRaw = typeof raw.Secret === 'string' ? raw.Secret : '';
  const isUnredactedServiceJwt = secretRaw ? decodeJwtRole(secretRaw) === 'service_role' : false;
  const ruleKind = isUnredactedServiceJwt ? 'known' : classifyGitleaksRule(ruleId);
  const knownFormat = ruleKind === 'known';
  const severity: SecretHit['severity'] = knownFormat ? 'critical' : 'medium';
  const loc = line !== undefined ? `${file}:${line}` : file;
  const commitNote = commit ? ` @ ${commit}` : '';
  return {
    ruleId,
    description: hide(description),
    knownFormat,
    severity,
    location: loc,
    ...(line !== undefined ? { line } : {}),
    ...(commit ? { commit } : {}),
    evidence: `${hide(description)} (${ruleId}) in ${loc}${commitNote} [redacted]`,
  };
}

async function runGitleaksScan(mode: GitleaksMode, target: string, opts: GitleaksExecOptions = {}): Promise<GitleaksScanResult> {
  const binary = opts.binary ?? 'gitleaks';
  const hide = opts.hide ?? ((t: string) => t);
  const version = await probeGitleaksVersion(opts);
  if (!version) {
    return {
      status: 'missing',
      mode,
      target,
      version: null,
      coverage: `${mode}: gitleaks not found on PATH`,
      knownHits: [],
      genericHits: [],
    };
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-gitleaks-'));
  const reportFile = path.join(tmpDir, 'report.json');
  try {
    const args = [
      mode,
      target,
      '--redact',
      '--report-format',
      'json',
      '--report-path',
      reportFile,
      '--no-banner',
      '--no-color',
      ...(opts.extraArgs ?? []),
    ];
    const execRes = await execBinary(binary, args, opts);
    if (execRes.enoent) {
      return {
        status: 'missing',
        mode,
        target,
        version: null,
        coverage: `${mode}: gitleaks not found on PATH`,
        knownHits: [],
        genericHits: [],
      };
    }
    if (execRes.exitCode !== 0 && execRes.exitCode !== 1) {
      return {
        status: 'error',
        mode,
        target,
        version,
        coverage: `${mode}: error`,
        knownHits: [],
        genericHits: [],
        error: hide(execRes.stderr.trim() || execRes.errorMessage || `gitleaks ${mode} exited with ${execRes.exitCode}`),
      };
    }

    let entries: RawGitleaksFinding[] = [];
    try {
      const rawText = await readFile(reportFile, 'utf8');
      const parsed = JSON.parse(rawText.trim() || '[]') as unknown;
      if (parsed !== null && !Array.isArray(parsed)) {
        throw new Error('report JSON root is not an array');
      }
      entries = Array.isArray(parsed) ? (parsed as RawGitleaksFinding[]) : [];
    } catch (e) {
      return {
        status: 'error',
        mode,
        target,
        version,
        coverage: `${mode}: invalid report output`,
        knownHits: [],
        genericHits: [],
        error: `gitleaks ${mode} produced invalid JSON report: ${(e as Error).message}`,
      };
    }

    const knownHits: SecretHit[] = [];
    const genericHits: SecretHit[] = [];
    for (const raw of entries) {
      const hit = normalizeReportEntry(raw, hide);
      if (hit.knownFormat) knownHits.push(hit);
      else genericHits.push(hit);
    }

    return {
      status: 'ok',
      mode,
      target,
      version,
      coverage: `${mode === 'dir' ? 'directory scan' : 'git history scan'} (${entries.length} raw rule match(es))`,
      knownHits,
      genericHits,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run `gitleaks dir --redact` on a filesystem directory (served build snapshot or repository working tree). */
export async function runGitleaksDir(targetDir: string, opts: GitleaksExecOptions = {}): Promise<GitleaksScanResult> {
  return runGitleaksScan('dir', targetDir, opts);
}

/** Run `gitleaks git --redact` on a repository's git history. */
export async function runGitleaksGit(repoDir: string, opts: GitleaksExecOptions = {}): Promise<GitleaksScanResult> {
  return runGitleaksScan('git', repoDir, opts);
}

const SKIP_REPO_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.nuxt', 'coverage']);
const BINARY_FILE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.pdf', '.zip', '.gz', '.wasm']);
const MAX_REPO_FILE_BYTES = 512 * 1024;
const MAX_REPO_FILES = 2000;

/** Determine whether a directory is inside a git work tree (supports standard repos and worktrees). */
export async function isGitRepo(repoPath: string): Promise<boolean> {
  if (existsSync(path.join(repoPath, '.git'))) return true;
  return new Promise<boolean>((resolve) => {
    execFile('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], { timeout: 5_000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === 'true');
    });
  });
}

export interface RepoKnownScanResult {
  hits: SecretHit[];
  gitHistoryError?: string;
}

/** Supplementary known-format scan (e.g. Supabase `sb_secret_` / `service_role` JWTs) over repo files & git history. */
export async function scanRepoKnownFormats(
  repoPath: string,
  hasGit: boolean,
  hide: (t: string) => string = (t) => t,
): Promise<RepoKnownScanResult> {
  const hits: SecretHit[] = [];
  const queue: string[] = [repoPath];
  let filesScanned = 0;

  while (queue.length > 0 && filesScanned < MAX_REPO_FILES) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (filesScanned >= MAX_REPO_FILES) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_REPO_DIRS.has(ent.name)) queue.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (BINARY_FILE_EXTS.has(path.extname(ent.name).toLowerCase())) continue;
      const st = await stat(full).catch(() => null);
      if (!st || st.size > MAX_REPO_FILE_BYTES) continue;
      filesScanned++;
      const text = await readFile(full, 'utf8').catch(() => '');
      if (text) {
        const rel = path.relative(repoPath, full).split(path.sep).join('/');
        hits.push(...detectKnownSecretFormats(text, rel, hide));
      }
    }
  }

  let gitHistoryError: string | undefined;
  if (hasGit) {
    const logRes = await new Promise<{ stdout: string; errMsg?: string }>((resolve) => {
      execFile(
        'git',
        ['-C', repoPath, 'log', '--all', '-p', '--no-color'],
        { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            resolve({ stdout: String(stdout ?? ''), errMsg: err.message.split('\n')[0] || 'git log failed' });
            return;
          }
          resolve({ stdout: String(stdout) });
        },
      );
    });
    if (logRes.errMsg) gitHistoryError = hide(logRes.errMsg);
    if (logRes.stdout) {
      let curCommit = '';
      let curFile = 'git-history';
      for (const line of logRes.stdout.split('\n')) {
        if (line.startsWith('commit ')) {
          curCommit = line.slice(7, 15).trim();
          continue;
        }
        if (line.startsWith('+++ b/')) {
          curFile = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('+') && !line.startsWith('+++')) {
          for (const h of detectKnownSecretFormats(line.slice(1), `${curFile} @ ${curCommit || 'history'}`, hide)) {
            hits.push(curCommit ? { ...h, commit: curCommit } : h);
          }
        }
      }
    }
  }

  return gitHistoryError ? { hits, gitHistoryError } : { hits };
}

export interface GitleaksAdapterOptions extends GitleaksExecOptions {
  mode?: GitleaksMode;
}

/** Adapter wrapper over `gitleaks --redact` following the ADR 0005 Adapter seam. */
export class GitleaksAdapter implements Adapter {
  readonly id = 'gitleaks';
  readonly kind = 'scanner' as const;
  readonly surfaces = ['web'] as const;

  constructor(private readonly opts: GitleaksAdapterOptions = {}) {}

  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const target = ctx.buildDir;
    if (!target) {
      return {
        adapterId: this.id,
        status: 'skipped',
        findings: [],
        detail: 'no filesystem target provided',
      };
    }
    const mode = this.opts.mode ?? 'dir';
    const scan = mode === 'git' ? await runGitleaksGit(target, this.opts) : await runGitleaksDir(target, this.opts);
    if (scan.status === 'missing') {
      return {
        adapterId: this.id,
        status: 'skipped',
        findings: [],
        coverage: scan.coverage,
        detail: 'gitleaks binary not found on PATH',
      };
    }
    if (scan.status === 'error') {
      return {
        adapterId: this.id,
        ...(scan.version ? { version: scan.version } : {}),
        coverage: scan.coverage,
        status: 'error',
        findings: [],
        ...(scan.error ? { error: scan.error } : {}),
      };
    }
    const allHits = [...scan.knownHits, ...scan.genericHits];
    const findings: AdapterFinding[] = allHits.map((h, i) => ({
      id: `gitleaks:${h.ruleId}:${i + 1}`,
      title: h.knownFormat ? `${h.description} (${h.ruleId})` : `Generic secret match (${h.ruleId})`,
      severity: h.severity,
      summary: h.evidence,
      source: 'gitleaks',
    }));
    return {
      adapterId: this.id,
      ...(scan.version ? { version: scan.version } : {}),
      coverage: scan.coverage,
      status: 'ok',
      findings,
    };
  }
}
