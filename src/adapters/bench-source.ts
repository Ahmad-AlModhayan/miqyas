// SPDX-License-Identifier: AGPL-3.0-only
// Getting a bench's app: a read-only export from the user's clone and a build that runs the same on macOS, Linux and
// Windows. Nothing here writes inside the clone: `git archive` and `rev-parse` only read, and `status` runs without
// optional locks so it doesn't refresh the index.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
export interface BuildSpec {
  install: string[];
  vite: string[];
  env: Record<string, string>;
  outDir: string;
}

export class SourceError extends Error {}

/** The environment for the app's own tools: no model key or plan secret reaches npm, its packages or Vite. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(ANTHROPIC_|MIQYAS_SECRET_)/i.test(k)) env[k] = v;
  return { ...env, ...extra };
}

function exited(child: ChildProcess, what: string, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new SourceError(`${what}: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new SourceError(`${what} exited ${code}${stderr() ? `: ${stderr().trim().split('\n').slice(-5).join('\n')}` : ''}`))));
  });
}

function collect(child: ChildProcess): () => string {
  let err = '';
  child.stderr?.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-4000)));
  return () => err;
}

async function git(repo: string, args: string[]): Promise<string> {
  const child = spawn('git', ['--no-optional-locks', '-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
  await exited(child, `git ${args[0]}`, collect(child));
  return out;
}

/** The full SHA of a commit the clone already has. Fetching would write inside the clone, so a missing commit stops. */
export async function resolveCommit(repo: string, ref: string): Promise<string> {
  try {
    return (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
  } catch {
    throw new SourceError(`commit ${ref} is not in ${repo}; fetch it there yourself (Miqyas never writes inside the clone)`);
  }
}

/** HEAD and `git status`, to show the clone is the same after a run. */
export async function cloneState(repo: string): Promise<string> {
  return `${(await git(repo, ['rev-parse', 'HEAD'])).trim()}\n${await git(repo, ['status', '--porcelain=v1'])}`;
}

/** `git -C <repo> archive <commit> <subdir> | tar -x -C <dest>`, with Node doing the pipe so it runs the same everywhere.
 * Line endings stay as committed (no autocrlf), so the Mac and Windows build the same bytes. */
export async function exportTree(repo: string, commit: string, subdir: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const archive = spawn('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-C', repo, 'archive', '--format=tar', commit, subdir], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
  // tar runs inside dest and gets no path: GNU tar (Git Bash's) reads `C:\…` as `host:path`, bsdtar doesn't.
  const tar = spawn('tar', ['-x', '-f', '-'], { cwd: dest, stdio: ['pipe', 'ignore', 'pipe'], env: childEnv() });
  // A missing or failing tar surfaces through its exit, not as an unhandled EPIPE on the pipe.
  tar.stdin!.on('error', () => {});
  archive.stdout!.pipe(tar.stdin!);
  await Promise.all([exited(archive, 'git archive', collect(archive)), exited(tar, 'tar -x', collect(tar))]);
}

/** `npm ci`, then Vite through Node itself with the bench's env: no shell syntax, so Windows cmd runs it too. */
export async function buildApp(appDir: string, build: BuildSpec, log: (s: string) => void): Promise<string> {
  const win = process.platform === 'win32';
  // On Windows npm is a .cmd shim, which Node only starts through a shell; the arguments are the bench's constants.
  const npm = spawn(win ? 'npm.cmd' : 'npm', build.install, { cwd: appDir, stdio: ['ignore', 'ignore', 'pipe'], env: childEnv(), shell: win });
  log(`    npm ${build.install.join(' ')}`);
  await exited(npm, 'npm ci', collect(npm));
  const vite = path.join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
  log(`    vite ${build.vite.join(' ')}`);
  const child = spawn(process.execPath, [vite, ...build.vite], { cwd: appDir, stdio: ['ignore', 'ignore', 'pipe'], env: childEnv(build.env) });
  await exited(child, 'vite build', collect(child));
  return path.join(appDir, build.outDir);
}
