// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Artifact retention enforcement for `.miqyas/runs` (Layer 3: proof-core).

import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { safeRealpath } from './ledger.js';

export const DEFAULT_RUN_RETENTION_DAYS = 14;
const MS_PER_DAY = 86_400_000;

export class RetentionConfigError extends Error {}

function isSameOrAncestor(candidateDir: string, activeDir: string): boolean {
  const c = safeRealpath(candidateDir);
  const a = safeRealpath(activeDir);
  const rel = path.relative(c, a);
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isMiqyasRunsDir(dir: string): boolean {
  const resolved = path.resolve(dir);
  return path.basename(resolved) === 'runs' && path.basename(path.dirname(resolved)) === '.miqyas';
}

/**
 * Resolve the retention window in days from explicit config, `MIQYAS_RETENTION_DAYS`, or default 14 days.
 */
export function resolveRetentionDays(explicitDays?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (explicitDays !== undefined) {
    if (!Number.isFinite(explicitDays) || explicitDays < 0) {
      throw new RetentionConfigError(`retention days must be a non-negative number (got "${explicitDays}")`);
    }
    return explicitDays;
  }
  if (env.MIQYAS_RETENTION_DAYS !== undefined) {
    const raw = env.MIQYAS_RETENTION_DAYS.trim();
    if (!raw) {
      throw new RetentionConfigError('MIQYAS_RETENTION_DAYS must be a non-negative number (got "")');
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new RetentionConfigError(`MIQYAS_RETENTION_DAYS must be a non-negative number (got "${raw}")`);
    }
    return parsed;
  }
  return DEFAULT_RUN_RETENTION_DAYS;
}

/**
 * Resolve which `.miqyas/runs` root retention applies to without ever touching non-`.miqyas/runs` custom `--out` parents.
 */
export function resolveRetentionRunsDir(
  activeRunDir: string,
  explicitRunsDir?: string,
  cwd = process.cwd(),
): string {
  if (explicitRunsDir !== undefined) {
    const trimmed = explicitRunsDir.trim();
    if (!trimmed) {
      throw new RetentionConfigError('runsDir must be a non-empty directory path');
    }
    return path.resolve(cwd, trimmed);
  }
  const parent = path.dirname(path.resolve(activeRunDir));
  if (isMiqyasRunsDir(parent)) return parent;
  return path.resolve(cwd, '.miqyas', 'runs');
}

export interface RetentionCleanupResult {
  runsDir: string;
  retentionDays: number;
  deleted: string[];
  kept: string[];
}

/**
 * Enforce `.miqyas/runs` retention cleanup at the start of a run while never deleting the active run folder.
 */
export async function cleanupRunsRetention(opts: {
  activeRunDir: string;
  runsDir?: string;
  retentionDays?: number;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  cwd?: string;
}): Promise<RetentionCleanupResult> {
  const retentionDays = resolveRetentionDays(opts.retentionDays, opts.env);
  const runsDir = resolveRetentionRunsDir(opts.activeRunDir, opts.runsDir, opts.cwd);
  const nowMs = (opts.now ?? new Date()).getTime();
  const cutoffMs = nowMs - retentionDays * MS_PER_DAY;
  const deleted: string[] = [];
  const kept: string[] = [];

  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { runsDir, retentionDays, deleted, kept };
    }
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(runsDir, entry.name);
    if (isSameOrAncestor(entryPath, opts.activeRunDir)) {
      kept.push(entry.name);
      continue;
    }
    const st = await stat(entryPath).catch(() => null);
    if (!st) continue;
    const expired = retentionDays === 0 ? st.mtimeMs <= cutoffMs : st.mtimeMs < cutoffMs;
    if (expired) {
      await rm(entryPath, { recursive: true, force: true });
      deleted.push(entry.name);
    } else {
      kept.push(entry.name);
    }
  }

  return { runsDir, retentionDays, deleted, kept };
}
