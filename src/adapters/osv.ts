// SPDX-License-Identifier: AGPL-3.0-only
// OSV vulnerability & malicious-package adapter (ADR 0005, FR-Q4, FR-Q6, Check 13):
// - `updateOsvDatabase`: explicit opt-in download (`miqyas update-db`) printing & logging contacted endpoints.
// - `runOsvScannerOffline`: strictly offline `--offline --format=json` execution with zero network calls during runs.

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { appendFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Adapter, AdapterContext, AdapterFinding, AdapterResult } from './adapter.js';

export const OSV_DEFAULT_BASE_URL = 'https://osv-vulnerabilities.storage.googleapis.com';
export const OSV_DEFAULT_ECOSYSTEMS = ['npm', 'PyPI'] as const;

const DEFAULT_TIMEOUT_MS = 60_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.nuxt', 'coverage', '.venv', '__pycache__']);
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'requirements.txt',
  'poetry.lock',
  'pipfile.lock',
  'pdm.lock',
  'uv.lock',
  'pylock.toml',
  'cargo.lock',
  'go.mod',
  'gemfile.lock',
  'composer.lock',
]);

export interface OsvExecOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  cacheDir?: string;
  extraArgs?: readonly string[];
  hide?: (text: string) => string;
}

export interface OsvVulnHit {
  id: string;
  aliases: string[];
  isMalicious: boolean;
  failsCheck: boolean;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  maxCvss: number | null;
  packageName: string;
  packageVersion: string;
  ecosystem: string;
  sourcePath: string;
  summary: string;
  fixedVersions: string[];
}

export interface OsvScanResult {
  status: 'ok' | 'missing' | 'no_lockfiles' | 'db_missing' | 'error';
  version: string | null;
  lockfiles: string[];
  packageCount: number;
  hits: OsvVulnHit[];
  coverage: string;
  cacheDir: string;
  error?: string;
}

export class OsvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OsvValidationError';
  }
}

export interface UpdateOsvOptions {
  ecosystems?: readonly string[];
  cacheDir?: string;
  logFile?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  hide?: (text: string) => string;
  onProgress?: (msg: string) => void;
}

export interface UpdateOsvLogEntry {
  timestamp: string;
  ecosystem: string;
  url: string;
  destination: string;
  bytes: number;
  status: 'ok' | 'error';
  error?: string;
}

export interface UpdateOsvResult {
  cacheDir: string;
  logFile: string;
  entries: UpdateOsvLogEntry[];
  totalBytes: number;
}

/** Resolve local OSV offline DB cache directory (respecting `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY`). */
export function defaultOsvCacheDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const override = env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY?.trim();
  return override || path.join(home, '.miqyas', 'osv-db');
}

/** Return true when at least one ecosystem `all.zip` is present under `<cacheDir>/osv-scanner`. */
export function hasPopulatedOsvCache(cacheDir = defaultOsvCacheDir()): boolean {
  const root = path.join(cacheDir, 'osv-scanner');
  if (!existsSync(root)) return false;
  try {
    return readdirSync(root, { withFileTypes: true }).some(
      (ent) => ent.isDirectory() && existsSync(path.join(root, ent.name, 'all.zip')),
    );
  } catch {
    return false;
  }
}

/** Walk `repoDir` (skipping vendor/VCS directories) and list lockfiles supported by osv-scanner. */
export async function findRepoLockfiles(repoDir: string, maxFiles = 2000): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [repoDir];
  let visited = 0;

  while (queue.length > 0 && visited < maxFiles) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (visited >= maxFiles) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) queue.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      visited++;
      if (LOCKFILE_NAMES.has(ent.name.toLowerCase())) {
        out.push(path.relative(repoDir, full).split(path.sep).join('/'));
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  enoent: boolean;
  errorMessage?: string;
}

function execBinary(binary: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      {
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr), enoent: false });
          return;
        }
        const e = err as NodeJS.ErrnoException & { status?: number };
        const enoent = e.code === 'ENOENT';
        const exitCode = typeof e.code === 'number' ? e.code : typeof e.status === 'number' ? e.status : null;
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

/** Query `osv-scanner --version`; returns trimmed version string or `null` when missing/unusable. */
export async function probeOsvScannerVersion(opts: OsvExecOptions = {}): Promise<string | null> {
  const binary = opts.binary ?? 'osv-scanner';
  const res = await execBinary(binary, ['--version'], {
    ...(opts.env ? { env: opts.env } : {}),
    timeoutMs: opts.timeoutMs ?? 5_000,
  });
  if (res.enoent || res.exitCode !== 0) return null;
  const first = res.stdout.trim().split('\n')[0]?.trim() ?? '';
  const match = /\b(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?)\b/.exec(first);
  return match?.[1] ?? (first || 'unknown');
}

/** Explicitly download OSV offline databases (`miqyas update-db`), printing and logging every contacted endpoint. */
export async function updateOsvDatabase(opts: UpdateOsvOptions = {}): Promise<UpdateOsvResult> {
  const env = opts.env ?? process.env;
  const cacheDir = path.resolve(opts.cacheDir ?? defaultOsvCacheDir(env));
  const logFile = path.resolve(opts.logFile ?? path.join(cacheDir, 'update-db.log.jsonl'));
  const ecosystems = (opts.ecosystems?.length ? opts.ecosystems : OSV_DEFAULT_ECOSYSTEMS).map((e) => e.trim());
  for (const eco of ecosystems) {
    if (eco === '.' || eco === '..' || !/^[A-Za-z0-9._-]+$/.test(eco)) {
      throw new OsvValidationError(`invalid OSV ecosystem name "${eco}"`);
    }
  }
  const baseUrl = (opts.baseUrl ?? env.OSV_DB_BASE_URL ?? OSV_DEFAULT_BASE_URL).replace(/\/+$/, '');
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new OsvValidationError(`invalid OSV base URL "${baseUrl}"`);
  }
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    throw new OsvValidationError(`OSV base URL must use http or https: "${baseUrl}"`);
  }

  const fetchFn = opts.fetchFn ?? fetch;
  const hide = opts.hide ?? ((t: string) => t);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await mkdir(path.dirname(logFile), { recursive: true });

  const entries: UpdateOsvLogEntry[] = [];
  let totalBytes = 0;

  for (const eco of ecosystems) {
    const url = `${baseUrl}/${encodeURIComponent(eco)}/all.zip`;
    const destDir = path.join(cacheDir, 'osv-scanner', eco);
    const destPath = path.join(destDir, 'all.zip');
    const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
    const timestamp = new Date().toISOString();
    opts.onProgress?.(`contacting ${url} -> ${destPath}`);
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(destDir, { recursive: true });
      await writeFile(tmpPath, buf);
      await rename(tmpPath, destPath);
      const entry: UpdateOsvLogEntry = { timestamp, ecosystem: eco, url, destination: destPath, bytes: buf.length, status: 'ok' };
      entries.push(entry);
      totalBytes += buf.length;
      await appendFile(logFile, JSON.stringify(entry) + '\n', 'utf8');
      opts.onProgress?.(`downloaded ${eco}: ${buf.length} bytes`);
    } catch (e) {
      await rm(tmpPath, { force: true }).catch(() => {});
      const errMsg = hide((e as Error).message.split('\n')[0] || 'download failed');
      const entry: UpdateOsvLogEntry = { timestamp, ecosystem: eco, url, destination: destPath, bytes: 0, status: 'error', error: errMsg };
      entries.push(entry);
      await appendFile(logFile, JSON.stringify(entry) + '\n', 'utf8');
      throw new Error(`update-db failed contacting ${url}: ${errMsg}`);
    }
  }

  return { cacheDir, logFile, entries, totalBytes };
}

interface RawOsvJson {
  results?: {
    source?: { path?: string; type?: string };
    packages?: {
      package?: { name?: string; version?: string; ecosystem?: string };
      vulnerabilities?: {
        id?: string;
        summary?: string;
        aliases?: string[];
        database_specific?: { severity?: string };
        severity?: { type?: string; score?: string }[];
        affected?: { ranges?: { events?: { fixed?: string }[] }[] }[];
      }[];
      groups?: { ids?: string[]; max_severity?: string }[];
    }[];
  }[];
}

function classifyOsvSeverity(opts: {
  isMalicious: boolean;
  dbSeverity?: string;
  groupMaxSeverity?: string;
  vulnSeverities?: { type?: string; score?: string }[];
}): { severity: OsvVulnHit['severity']; maxCvss: number | null } {
  const candidates: number[] = [];
  if (opts.groupMaxSeverity !== undefined) {
    const n = Number(opts.groupMaxSeverity);
    if (Number.isFinite(n) && n >= 0) candidates.push(n);
  }
  for (const s of opts.vulnSeverities ?? []) {
    if (s.score !== undefined) {
      const n = Number(s.score);
      if (Number.isFinite(n) && n >= 0) candidates.push(n);
    }
  }
  const maxCvss = candidates.length > 0 ? Math.max(...candidates) : null;

  // Known malicious packages (`MAL-`) always carry critical severity regardless of auxiliary DB score fields.
  if (opts.isMalicious) return { severity: 'critical', maxCvss };
  const dbSev = opts.dbSeverity?.trim().toUpperCase();
  if (dbSev === 'CRITICAL') return { severity: 'critical', maxCvss };
  if (dbSev === 'HIGH') return { severity: 'high', maxCvss };
  if (maxCvss !== null) {
    if (maxCvss >= 9.0) return { severity: 'critical', maxCvss };
    if (maxCvss >= 7.0) return { severity: 'high', maxCvss };
    if (maxCvss >= 4.0) return { severity: 'medium', maxCvss };
    return { severity: 'low', maxCvss };
  }
  if (dbSev === 'MODERATE' || dbSev === 'MEDIUM') return { severity: 'medium', maxCvss };
  if (dbSev === 'LOW') return { severity: 'low', maxCvss };
  return { severity: 'medium', maxCvss };
}

function parseOsvJsonReport(raw: RawOsvJson, repoDir: string): { hits: OsvVulnHit[]; packageCount: number; sourcePaths: string[] } {
  const hits: OsvVulnHit[] = [];
  const seenPackages = new Set<string>();
  const sourcePaths = new Set<string>();

  for (const res of raw.results ?? []) {
    const rawSource = res.source?.path ?? '';
    const relSource = rawSource ? path.relative(repoDir, path.resolve(repoDir, rawSource)).split(path.sep).join('/') : 'lockfile';
    const cleanSource = relSource && !relSource.startsWith('..') ? relSource : path.basename(rawSource || 'lockfile');
    sourcePaths.add(cleanSource);

    for (const pkgEntry of res.packages ?? []) {
      const pkg = pkgEntry.package;
      const pkgName = pkg?.name?.trim() || 'unknown-package';
      const pkgVer = pkg?.version?.trim() || '0.0.0';
      const ecosystem = pkg?.ecosystem?.trim() || 'unknown';
      seenPackages.add(`${ecosystem}:${pkgName}@${pkgVer}:${cleanSource}`);

      const groupScoreById = new Map<string, string>();
      for (const grp of pkgEntry.groups ?? []) {
        if (!grp.max_severity) continue;
        for (const gid of grp.ids ?? []) groupScoreById.set(gid, grp.max_severity);
      }

      for (const v of pkgEntry.vulnerabilities ?? []) {
        const id = v.id?.trim() || 'OSV-UNKNOWN';
        const aliases = (v.aliases ?? []).filter((a): a is string => typeof a === 'string');
        const isMalicious = id.startsWith('MAL-') || aliases.some((a) => a.startsWith('MAL-'));
        const { severity, maxCvss } = classifyOsvSeverity({
          isMalicious,
          ...(v.database_specific?.severity ? { dbSeverity: v.database_specific.severity } : {}),
          ...(groupScoreById.get(id) ? { groupMaxSeverity: groupScoreById.get(id) } : {}),
          ...(v.severity ? { vulnSeverities: v.severity } : {}),
        });
        const fixedSet = new Set<string>();
        for (const aff of v.affected ?? []) {
          for (const range of aff.ranges ?? []) {
            for (const ev of range.events ?? []) {
              if (typeof ev.fixed === 'string' && ev.fixed.trim()) fixedSet.add(ev.fixed.trim());
            }
          }
        }
        hits.push({
          id,
          aliases,
          isMalicious,
          failsCheck: isMalicious || severity === 'critical' || severity === 'high',
          severity,
          maxCvss,
          packageName: pkgName,
          packageVersion: pkgVer,
          ecosystem,
          sourcePath: cleanSource,
          summary: v.summary?.trim() || `${id} affecting ${pkgName}`,
          fixedVersions: [...fixedSet],
        });
      }
    }
  }

  return { hits, packageCount: seenPackages.size, sourcePaths: [...sourcePaths] };
}

/** Execute `osv-scanner --offline --format=json` on `repoDir` with zero network calls during verification. */
export async function runOsvScannerOffline(repoDir: string, opts: OsvExecOptions = {}): Promise<OsvScanResult> {
  const baseEnv = opts.env ?? process.env;
  const cacheDir = path.resolve(opts.cacheDir ?? defaultOsvCacheDir(baseEnv));
  const hide = opts.hide ?? ((t: string) => t);

  const lockfiles = await findRepoLockfiles(repoDir);
  if (lockfiles.length === 0) {
    return {
      status: 'no_lockfiles',
      version: null,
      lockfiles: [],
      packageCount: 0,
      hits: [],
      coverage: '0 supported lockfiles found',
      cacheDir,
    };
  }

  const version = await probeOsvScannerVersion(opts);
  if (!version) {
    return {
      status: 'missing',
      version: null,
      lockfiles,
      packageCount: 0,
      hits: [],
      coverage: `${lockfiles.length} lockfile(s) discovered; osv-scanner not found on PATH`,
      cacheDir,
    };
  }

  const majorMatch = /^(\d+)\./.exec(version);
  const major = majorMatch ? Number(majorMatch[1]) : 2;
  const baseArgs = major >= 2
    ? ['scan', 'source', '--offline', '--all-packages', '--format=json', '-r', repoDir]
    : ['--offline', '--all-packages', '--format=json', '-r', repoDir];
  const args = [...baseArgs, ...(opts.extraArgs ?? [])];
  const execEnv: NodeJS.ProcessEnv = { ...baseEnv, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: cacheDir };

  const execRes = await execBinary(opts.binary ?? 'osv-scanner', args, {
    env: execEnv,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (execRes.enoent) {
    return {
      status: 'missing',
      version: null,
      lockfiles,
      packageCount: 0,
      hits: [],
      coverage: `${lockfiles.length} lockfile(s) discovered; osv-scanner not found on PATH`,
      cacheDir,
    };
  }

  // Exit codes other than 0 (clean) and 1 (vulnerabilities found) indicate execution/database failure,
  // even when osv-scanner also writes partial JSON (e.g., `{"results":null}`) on stdout.
  if (execRes.exitCode !== 0 && execRes.exitCode !== 1) {
    const errText = hide((execRes.stderr || execRes.errorMessage || execRes.stdout || '').trim());
    if (/no local databases?|no offline version|offline database|no databases? found|cache.*empty/i.test(errText)) {
      return {
        status: 'db_missing',
        version,
        lockfiles,
        packageCount: 0,
        hits: [],
        coverage: `${lockfiles.length} lockfile(s) discovered; local OSV DB not populated at ${cacheDir}`,
        cacheDir,
        error: errText || 'offline OSV database not populated',
      };
    }
    return {
      status: 'error',
      version,
      lockfiles,
      packageCount: 0,
      hits: [],
      coverage: `${lockfiles.length} lockfile(s) discovered; osv-scanner exited with ${execRes.exitCode}`,
      cacheDir,
      error: errText || `osv-scanner exited with ${execRes.exitCode}`,
    };
  }

  let parsed: RawOsvJson | null = null;
  if (execRes.stdout.trim().startsWith('{')) {
    try {
      parsed = JSON.parse(execRes.stdout) as RawOsvJson;
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    const errText = hide((execRes.stderr || execRes.errorMessage || '').trim());
    return {
      status: 'error',
      version,
      lockfiles,
      packageCount: 0,
      hits: [],
      coverage: `${lockfiles.length} lockfile(s) discovered; osv-scanner produced unreadable JSON`,
      cacheDir,
      error: errText || 'unreadable JSON output from osv-scanner',
    };
  }

  const { hits, packageCount } = parseOsvJsonReport(parsed, repoDir);
  const lockfileList = lockfiles.slice(0, 5).join(', ') + (lockfiles.length > 5 ? `, +${lockfiles.length - 5} more` : '');
  const coverage = `${lockfiles.length} lockfile(s) (${lockfileList}), ${packageCount} package(s) scanned offline via osv-scanner ${version}`;
  return { status: 'ok', version, lockfiles, packageCount, hits, coverage, cacheDir };
}

/** Adapter wrapper for Check 13 (`osv-scanner --offline`). */
export class OsvScannerAdapter implements Adapter {
  readonly id = 'osv-scanner';
  readonly kind = 'scanner' as const;
  readonly surfaces = ['web'] as const;

  constructor(private readonly opts: OsvExecOptions = {}) {}

  async run(ctx: AdapterContext): Promise<AdapterResult> {
    if (!ctx.buildDir) {
      return { adapterId: this.id, status: 'skipped', findings: [], detail: 'no repository path provided' };
    }
    const scan = await runOsvScannerOffline(ctx.buildDir, this.opts);
    if (scan.status === 'missing' || scan.status === 'no_lockfiles' || scan.status === 'db_missing') {
      return {
        adapterId: this.id,
        ...(scan.version ? { version: scan.version } : {}),
        coverage: scan.coverage,
        status: 'skipped',
        findings: [],
        detail: scan.error ?? scan.coverage,
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
    const findings: AdapterFinding[] = scan.hits.map((h, i) => ({
      id: `osv:${h.id}:${i + 1}`,
      title: `${h.id} in ${h.packageName}@${h.packageVersion} (${h.ecosystem})`,
      severity: h.severity,
      summary: `${h.sourcePath}: ${h.summary}${h.fixedVersions.length ? ` (fixed in ${h.fixedVersions.join(', ')})` : ''}`,
      source: 'osv-scanner',
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
