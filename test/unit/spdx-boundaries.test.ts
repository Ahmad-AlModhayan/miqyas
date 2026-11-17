// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSourceImports } from '../../scripts/check-boundaries.mjs';
import { checkSpdxHeaders, expectedSpdxForFile } from '../../scripts/check-spdx.mjs';

/** The first line of a source file that declares the licence `id`. */
const header = (id: string) => `// SPDX-License-Identifier: ${id}`;

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

  it('fails a file in a foundation folder that carries the wrong header', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'miqyas-spdx-'));
    try {
      await mkdir(path.join(root, 'src', 'kernel'), { recursive: true });
      await mkdir(path.join(root, 'src', 'gate'), { recursive: true });
      await writeFile(path.join(root, 'vitest.config.ts'), header('AGPL-3.0-only'));
      await writeFile(path.join(root, 'src', 'kernel', 'judge.ts'), header('Apache-2.0'));
      await writeFile(path.join(root, 'src', 'gate', 'decide.ts'), header('AGPL-3.0-only'));

      expect(await checkSpdxHeaders(root)).toEqual([
        {
          file: 'src/kernel/judge.ts',
          reason: 'Expected "SPDX-License-Identifier: AGPL-3.0-only", found "Apache-2.0".',
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Every folder that FOUNDATION §14 adds grows out of the core, so it takes the core's licence.
  it.each([
    'kernel',
    'gate',
    'engine',
    'model',
    'experiment',
    'capsule',
    'measure',
    'explore',
    'assure',
    'diagnose',
    'collectors',
    'claims',
    'bench',
  ])('expects the AGPL header in src/%s/', (folder) => {
    expect(expectedSpdxForFile(`src/${folder}/a.ts`)).toBe('AGPL-3.0-only');
  });

  it('expects the same headers as before in the folders that were already there', () => {
    expect(expectedSpdxForFile('src/protocol/a.ts')).toBe('Apache-2.0');
    expect(expectedSpdxForFile('src/scrub/a.ts')).toBe('Apache-2.0');
    expect(expectedSpdxForFile('src/surfaces/a.ts')).toBe('Apache-2.0');
    expect(expectedSpdxForFile('src/cli.ts')).toBe('Apache-2.0');
    expect(expectedSpdxForFile('src/adapters/a.ts')).toBe('AGPL-3.0-only');
    expect(expectedSpdxForFile('src/agents/a.ts')).toBe('AGPL-3.0-only');
    expect(expectedSpdxForFile('src/proof-core/a.ts')).toBe('AGPL-3.0-only');
    expect(expectedSpdxForFile('src/entry/a.ts')).toBe('AGPL-3.0-only');
  });

  it('lets a folder with the Apache header import only folders with the Apache header', () => {
    const folders = [
      'kernel',
      'protocol',
      'scrub',
      'surfaces',
      'gate',
      'engine',
      'model',
      'experiment',
      'capsule',
      'measure',
      'explore',
      'assure',
      'diagnose',
      'collectors',
      'claims',
      'agents',
      'bench',
      'entry',
      'adapters',
      'proof-core',
    ];
    const importsByApacheFolders: string[] = [];
    for (const from of folders) {
      if (expectedSpdxForFile(`src/${from}/a.ts`) !== 'Apache-2.0') continue;
      for (const to of folders) {
        if (to === from) continue;
        const refused = checkSourceImports(`src/${from}/a.ts`, `import { b } from '../${to}/b.js';`);
        if (refused.length === 0) importsByApacheFolders.push(`${from} -> ${to}`);
      }
    }
    expect(importsByApacheFolders).toEqual(['surfaces -> protocol', 'surfaces -> scrub']);
  });
});
