// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupRunsRetention,
  DEFAULT_RUN_RETENTION_DAYS,
  resolveRetentionDays,
  resolveRetentionRunsDir,
  RetentionConfigError,
} from '../../src/proof-core/retention.js';

let tmp = '';

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-retention-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('retention configuration & cleanup (#21)', () => {
  it('defaults to 14 days and validates explicit values and MIQYAS_RETENTION_DAYS', () => {
    expect(DEFAULT_RUN_RETENTION_DAYS).toBe(14);
    expect(resolveRetentionDays(undefined, {})).toBe(14);
    expect(resolveRetentionDays(7, { MIQYAS_RETENTION_DAYS: '30' })).toBe(7);
    expect(resolveRetentionDays(undefined, { MIQYAS_RETENTION_DAYS: '0' })).toBe(0);
    expect(resolveRetentionDays(undefined, { MIQYAS_RETENTION_DAYS: '3.5' })).toBe(3.5);

    expect(() => resolveRetentionDays(-1, {})).toThrow(RetentionConfigError);
    expect(() => resolveRetentionDays(Number.NaN, {})).toThrow(RetentionConfigError);
    expect(() => resolveRetentionDays(undefined, { MIQYAS_RETENTION_DAYS: 'abc' })).toThrow(RetentionConfigError);
    expect(() => resolveRetentionDays(undefined, { MIQYAS_RETENTION_DAYS: '-2' })).toThrow(RetentionConfigError);
    expect(() => resolveRetentionDays(undefined, { MIQYAS_RETENTION_DAYS: '   ' })).toThrow(RetentionConfigError);
  });

  it('targets .miqyas/runs for cleanup and never targets parent directories of arbitrary --out paths', () => {
    const work = path.join(tmp, 'scope-check');
    const defaultRunsDir = path.join(work, '.miqyas', 'runs');
    expect(resolveRetentionRunsDir(path.join(defaultRunsDir, 'r1'), undefined, work)).toBe(path.resolve(defaultRunsDir));
    expect(resolveRetentionRunsDir(path.join(tmp, 'custom-out', 'r1'), undefined, work)).toBe(
      path.resolve(defaultRunsDir),
    );
    expect(resolveRetentionRunsDir(path.join(work, 'r1'), path.join(work, 'injected-runs'), work)).toBe(
      path.resolve(work, 'injected-runs'),
    );
  });

  it('deletes expired run folders at run startup while preserving active, non-expired, and file entries', async () => {
    const base = path.join(tmp, 'prune-case');
    const runsDir = path.join(base, '.miqyas', 'runs');
    const active = path.join(runsDir, '20261114-active');
    const expired = path.join(runsDir, '20261001-expired');
    const fresh = path.join(runsDir, '20261110-fresh');
    const noteFile = path.join(runsDir, 'README.txt');
    await mkdir(active, { recursive: true });
    await mkdir(expired, { recursive: true });
    await mkdir(fresh, { recursive: true });
    await writeFile(path.join(expired, 'report.json'), '{}', 'utf8');
    await writeFile(noteFile, 'keep me', 'utf8');

    const now = new Date('2026-11-14T12:00:00.000Z');
    const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    await utimes(expired, twentyDaysAgo, twentyDaysAgo);
    await utimes(fresh, fiveDaysAgo, fiveDaysAgo);
    await utimes(noteFile, twentyDaysAgo, twentyDaysAgo);

    const res1 = await cleanupRunsRetention({ activeRunDir: active, cwd: base, retentionDays: 14, now });
    expect(res1.deleted).toEqual(['20261001-expired']);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(noteFile)).toBe(true);

    // Passing an old folder itself as activeRunDir must never delete it.
    const expiredActive = path.join(runsDir, '20261001-active-old');
    await mkdir(expiredActive, { recursive: true });
    await utimes(expiredActive, twentyDaysAgo, twentyDaysAgo);
    const res2 = await cleanupRunsRetention({ activeRunDir: expiredActive, cwd: base, retentionDays: 14, now });
    expect(res2.deleted).toEqual([]);
    expect(existsSync(expiredActive)).toBe(true);
  });

  it('prunes all non-active .miqyas/runs entries on retentionDays 0 and never touches siblings of custom --out dirs', async () => {
    const base = path.join(tmp, 'custom-out-case');
    const customParent = path.join(base, 'custom-artifacts');
    const customOut = path.join(customParent, 'run-now');
    const siblingOld = path.join(customParent, 'keep-old-sibling');
    await mkdir(siblingOld, { recursive: true });

    const now = new Date('2026-11-14T12:00:00.000Z');
    const longAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    await utimes(siblingOld, longAgo, longAgo);

    const r = await cleanupRunsRetention({ activeRunDir: customOut, cwd: base, retentionDays: 14, now });
    expect(r.deleted).toEqual([]);
    expect(existsSync(siblingOld)).toBe(true);

    const runsDir = path.join(base, '.miqyas', 'runs');
    const oldDefault = path.join(runsDir, 'old-run');
    const activeDefault = path.join(runsDir, 'active-run');
    await mkdir(oldDefault, { recursive: true });
    await mkdir(activeDefault, { recursive: true });
    await utimes(oldDefault, now, now);

    const purgeAll = await cleanupRunsRetention({ activeRunDir: activeDefault, cwd: base, retentionDays: 0, now });
    expect(purgeAll.deleted).toEqual(['old-run']);
    expect(existsSync(oldDefault)).toBe(false);
    expect(existsSync(activeDefault)).toBe(true);
    expect(existsSync(siblingOld)).toBe(true);
  });

  it('preserves nested non-existent activeRunDir under symlinked runs root and rejects blank explicit runsDir', async () => {
    const base = path.join(tmp, 'symlink-retention');
    const realRoot = path.join(base, 'real-work');
    const linkRoot = path.join(base, 'link-work');
    const realRuns = path.join(realRoot, '.miqyas', 'runs');
    const expiredGroup = path.join(realRuns, 'group');
    const staleSibling = path.join(realRuns, 'stale-sibling');
    await mkdir(expiredGroup, { recursive: true });
    await mkdir(staleSibling, { recursive: true });
    await symlink(realRoot, linkRoot);

    const now = new Date('2026-11-14T12:00:00.000Z');
    const oldDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await utimes(expiredGroup, oldDate, oldDate);
    await utimes(staleSibling, oldDate, oldDate);

    // Non-existent nested activeRunDir reached through a symlink must protect its existing ancestor directory (`group`).
    const nestedActiveViaSymlink = path.join(linkRoot, '.miqyas', 'runs', 'group', 'sub-run');
    const res = await cleanupRunsRetention({ activeRunDir: nestedActiveViaSymlink, cwd: linkRoot, retentionDays: 14, now });
    expect(res.deleted).toEqual(['stale-sibling']);
    expect(existsSync(expiredGroup)).toBe(true);
    expect(existsSync(staleSibling)).toBe(false);

    expect(() => resolveRetentionRunsDir(nestedActiveViaSymlink, '   ', linkRoot)).toThrow(RetentionConfigError);
  });
});
