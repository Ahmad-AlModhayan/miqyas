#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Thin CLI launcher: delegates to the core engine entrypoint over a process boundary.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveEntryPath(here: string): { entry: string; preserveExecArgv: boolean } {
  const dir = path.dirname(here);
  const ext = path.extname(here);
  if (ext && ext !== '.js') {
    const sameExt = path.join(dir, 'entry', `cli${ext}`);
    if (existsSync(sameExt)) return { entry: sameExt, preserveExecArgv: true };
  }
  return { entry: path.join(dir, 'entry', 'cli.js'), preserveExecArgv: false };
}

export function runCliLauncher(argv = process.argv.slice(2)): number {
  const here = fileURLToPath(import.meta.url);
  const { entry, preserveExecArgv } = resolveEntryPath(here);
  const execArgs = preserveExecArgv ? [...process.execArgv, entry, ...argv] : [entry, ...argv];
  const result = spawnSync(process.execPath, execArgs, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`miqyas: failed to launch engine entry (${entry}): ${result.error.message}\n`);
    return 3;
  }
  if (result.signal) {
    return 1;
  }
  return result.status ?? 1;
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(self);
  }
}

if (isDirectExecution()) {
  process.exit(runCliLauncher());
}
