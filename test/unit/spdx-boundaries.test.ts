// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { checkSourceImports } from '../../scripts/check-boundaries.mjs';
import { checkSpdxHeaders } from '../../scripts/check-spdx.mjs';

describe('open-core boundary and SPDX enforcement', () => {
  it('blocks cli and protocol from importing AGPL core modules', () => {
    expect(checkSourceImports('src/cli.ts', "import { main } from './entry/cli.js';")).not.toEqual([]);
    expect(
      checkSourceImports('src/protocol/worker.ts', "import type { Observation } from '../surfaces/session.js';"),
    ).not.toEqual([]);
    expect(
      checkSourceImports('src/protocol/worker.ts', "import type { Verdict } from '../proof-core/ledger.js';"),
    ).not.toEqual([]);
  });

  it('allows cli to import protocol and node built-ins only', () => {
    expect(
      checkSourceImports(
        'src/cli.ts',
        "import { spawnSync } from 'node:child_process';\nimport { WORKER_PROTOCOL_VERSION } from './protocol/worker.js';",
      ),
    ).toEqual([]);
  });

  it('verifies every file carries its layer SPDX identifier', async () => {
    const violations = await checkSpdxHeaders();
    expect(violations).toEqual([]);
  });
});
