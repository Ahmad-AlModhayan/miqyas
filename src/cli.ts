#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Executable entry shim: delegates immediately to src/entry/cli.ts.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCliProcess } from './entry/cli.js';

export { errorExit, loadCliEnv, main, type Injected } from './entry/cli.js';

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void runCliProcess();
}
