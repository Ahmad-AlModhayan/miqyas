// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnv, cloneState, exportTree, resolveCommit, SourceError } from '../../src/bench/source.js';

function repo(): { dir: string; sha: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'miqyas-clone-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  mkdirSync(path.join(dir, 'desktop'));
  writeFileSync(path.join(dir, 'desktop', 'index.html'), '<html></html>');
  writeFileSync(path.join(dir, 'other.txt'), 'not exported');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'c');
  return { dir, sha: git('rev-parse', 'HEAD') };
}

describe('bench source', () => {
  it('exports one folder at a commit and leaves the clone as it was', async () => {
    const { dir, sha } = repo();
    const before = await cloneState(dir);
    expect(await resolveCommit(dir, 'HEAD')).toBe(sha);
    const dest = mkdtempSync(path.join(os.tmpdir(), 'miqyas-export-'));
    await exportTree(dir, sha, 'desktop', dest);
    expect(readFileSync(path.join(dest, 'desktop', 'index.html'), 'utf8')).toBe('<html></html>');
    expect(() => readFileSync(path.join(dest, 'other.txt'))).toThrow();
    expect(await cloneState(dir)).toBe(before);
  });

  // GNU tar reads `C:\…` as `host:path`; Git for Windows ships one in usr/bin. Put it first on PATH so PowerShell runs
  // catch a drive-letter regression too, not only Git Bash ones.
  const gnuTarDir = process.platform === 'win32' ? path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../usr/bin') : '';
  it.skipIf(!gnuTarDir || !existsSync(path.join(gnuTarDir, 'tar.exe')))('exports to a drive-letter path with GNU tar first on PATH', async () => {
    const { dir, sha } = repo();
    const dest = mkdtempSync(path.join(os.tmpdir(), 'miqyas-export-'));
    expect(dest).toMatch(/^[A-Z]:\\/i);
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const saved = process.env[key];
    process.env[key] = `${gnuTarDir}${path.delimiter}${saved}`;
    try {
      await exportTree(dir, sha, 'desktop', dest);
    } finally {
      process.env[key] = saved;
    }
    expect(readFileSync(path.join(dest, 'desktop', 'index.html'), 'utf8')).toBe('<html></html>');
  });

  it('stops on a commit the clone lacks instead of fetching it', async () => {
    const { dir } = repo();
    await expect(resolveCommit(dir, '0123456789abcdef0123456789abcdef01234567')).rejects.toBeInstanceOf(SourceError);
  });

  it("keeps the model key and plan secrets out of the app's build", () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, pass: process.env.MIQYAS_SECRET_PASS };
    process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
    process.env.MIQYAS_SECRET_PASS = 'x';
    try {
      const env = childEnv({ NODE_ENV: 'development' });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.MIQYAS_SECRET_PASS).toBeUndefined();
      expect(env.NODE_ENV).toBe('development');
      // Windows stores it as Path; process.env is case-insensitive there, a plain object isn't.
      expect(Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1]).toBe(process.env.PATH);
    } finally {
      for (const [k, v] of [['ANTHROPIC_API_KEY', saved.key], ['MIQYAS_SECRET_PASS', saved.pass]] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });
});
