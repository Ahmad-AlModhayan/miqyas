// SPDX-License-Identifier: AGPL-3.0-only
// Layer boundary checks (architecture rule): lower layers never import Proof Core, model providers, or entry points.

import { describe, expect, it } from 'vitest';
import { checkProjectBoundaries, checkSourceImports } from '../../scripts/check-boundaries.mjs';

describe('import boundaries', () => {
  it('flags low-level scrub imports from surfaces, adapters, agents, proof-core, or entry', () => {
    const violations = checkSourceImports(
      'src/scrub/scrub.ts',
      [
        "import { foo } from '../surfaces/session.js';",
        "import type { Bar } from '../proof-core/ledger.js';",
        "import { main } from '../entry/cli.js';",
      ].join('\n'),
    );
    expect(violations).toHaveLength(3);
  });

  it('flags surface driver imports from proof-core, agents, adapters, entry, or model SDKs', () => {
    const violations = checkSourceImports(
      'src/surfaces/web/driver.ts',
      [
        "import { PlanLedger } from '../../proof-core/ledger.js';",
        "import type { Agent } from '../../agents/agent.js';",
        "import type { Adapter } from '../../adapters/adapter.js';",
        "import { main } from '../../entry/cli.js';",
        "import Anthropic from '@anthropic-ai/sdk';",
      ].join('\n'),
    );
    expect(violations).toHaveLength(5);
  });

  it('flags adapters and agents importing proof-core or entry, and proof-core importing entry or vendor drivers', () => {
    expect(
      checkSourceImports('src/adapters/a.ts', "import { buildReport } from '../proof-core/report.js';\nimport { AnthropicAgent } from '../agents/anthropic.js';"),
    ).toHaveLength(2);
    expect(
      checkSourceImports('src/agents/a.ts', "import { PlanLedger } from '../proof-core/ledger.js';\nimport { chromium } from 'playwright';"),
    ).toHaveLength(2);
    expect(
      checkSourceImports('src/proof-core/orchestrator.ts', "import { main } from '../entry/cli.js';\nimport { chromium } from 'playwright';\nimport Anthropic from '@anthropic-ai/sdk';"),
    ).toHaveLength(3);
  });

  it('ignores comments and string mentions while catching dynamic import and re-exports', () => {
    const clean = [
      "// import { PlanLedger } from '../../proof-core/ledger.js';",
      '/* import { main } from "../../entry/cli.js"; */',
      'const doc = "see ../proof-core/ledger.js";',
      "import { scrubText } from '../../scrub/scrub.js';",
    ].join('\n');
    expect(checkSourceImports('src/surfaces/web/observe.ts', clean)).toEqual([]);

    const dynamicAndReexport = [
      "export { PlanLedger } from '../../proof-core/ledger.js';",
      "const mod = await import('../../entry/cli.js');",
      'const interpolated = `${(await import("../../agents/anthropic.js")).DEFAULT_MODEL}`;',
    ].join('\n');
    expect(checkSourceImports('src/surfaces/web/driver.ts', dynamicAndReexport)).toHaveLength(3);
  });

  it('passes for the live miqyas src tree with zero violations', async () => {
    const violations = await checkProjectBoundaries();
    expect(violations).toEqual([]);
  });
});

/** What the check says when a file in one folder under `src/` imports a file in another. */
function importing(from: string, to: string) {
  return checkSourceImports(`src/${from}/a.ts`, `import { b } from '../${to}/b.js';`);
}

/** The single violation the check gives when `from` may not import `to`. */
function refusal(from: string, to: string) {
  return [
    {
      file: `src/${from}/a.ts`,
      specifier: `../${to}/b.js`,
      reason: expect.stringContaining(`layer "${from}" cannot import layer "${to}"`),
    },
  ];
}

describe('import boundaries of the foundation folders (FOUNDATION §14)', () => {
  it('lets the kernel import the protocol and nothing else', () => {
    expect(importing('kernel', 'protocol')).toEqual([]);
    expect(importing('kernel', 'scrub')).toEqual(refusal('kernel', 'scrub'));
  });

  // One row per folder that §14 lists below the base four, in §14's order:
  // the folder, the one listed just above it (allowed), the one listed just below it (refused).
  it.each([
    ['gate', 'kernel', 'engine'],
    ['engine', 'gate', 'model'],
    ['model', 'engine', 'experiment'],
    ['experiment', 'model', 'capsule'],
    ['capsule', 'experiment', 'measure'],
    ['measure', 'capsule', 'explore'],
    ['explore', 'measure', 'assure'],
    ['assure', 'explore', 'diagnose'],
    ['diagnose', 'assure', 'collectors'],
    ['collectors', 'diagnose', 'claims'],
    ['claims', 'collectors', 'agents'],
    ['agents', 'claims', 'bench'],
    ['bench', 'agents', 'entry'],
  ])('lets %s import %s, listed above it, and not %s, listed below it', (folder, above, below) => {
    expect(importing(folder, above)).toEqual([]);
    expect(importing(folder, below)).toEqual(refusal(folder, below));
  });

  it.each([
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
  ])('lets %s import the base four: protocol, scrub, surfaces and kernel', (folder) => {
    for (const base of ['protocol', 'scrub', 'surfaces', 'kernel']) {
      expect(importing(folder, base)).toEqual([]);
    }
  });

  it('lets protocol and scrub import nothing outside their own folder', () => {
    expect(importing('protocol', 'protocol')).toEqual([]);
    expect(importing('protocol', 'kernel')).toEqual(refusal('protocol', 'kernel'));
    expect(importing('scrub', 'scrub')).toEqual([]);
    expect(importing('scrub', 'protocol')).toEqual(refusal('scrub', 'protocol'));
  });

  it('lets surfaces import protocol and scrub, and neither the kernel nor the gate', () => {
    expect(importing('surfaces', 'protocol')).toEqual([]);
    expect(importing('surfaces', 'scrub')).toEqual([]);
    expect(importing('surfaces', 'kernel')).toEqual(refusal('surfaces', 'kernel'));
    expect(importing('surfaces', 'gate')).toEqual(refusal('surfaces', 'gate'));
  });

  it('lets the thin CLI import the protocol and not the kernel', () => {
    expect(checkSourceImports('src/cli.ts', "import { hello } from './protocol/control.js';")).toEqual([]);
    expect(checkSourceImports('src/cli.ts', "import { verify } from './kernel/verify.js';")).toEqual([
      {
        file: 'src/cli.ts',
        specifier: './kernel/verify.js',
        reason: expect.stringContaining('layer "cli" cannot import layer "kernel"'),
      },
    ]);
  });

  it('lets the entry folder import the folders listed above it, and not the thin CLI', () => {
    expect(importing('entry', 'bench')).toEqual([]);
    expect(importing('entry', 'gate')).toEqual([]);
    expect(checkSourceImports('src/entry/a.ts', "import { run } from '../cli.js';")).toEqual([
      {
        file: 'src/entry/a.ts',
        specifier: '../cli.js',
        reason: expect.stringContaining('layer "entry" cannot import layer "cli"'),
      },
    ]);
  });

  it('keeps the earlier folders apart from the new ones until their code moves', () => {
    // `adapters` and `proof-core` are not in §14: no new folder imports them, and they import no new folder.
    expect(importing('engine', 'proof-core')).toEqual(refusal('engine', 'proof-core'));
    expect(importing('collectors', 'adapters')).toEqual(refusal('collectors', 'adapters'));
    expect(importing('proof-core', 'kernel')).toEqual(refusal('proof-core', 'kernel'));
    expect(importing('adapters', 'collectors')).toEqual(refusal('adapters', 'collectors'));
    // `agents` and `entry` are in both layouts and keep the rules they had.
    expect(importing('agents', 'proof-core')).toEqual(refusal('agents', 'proof-core'));
    expect(importing('agents', 'adapters')).toEqual(refusal('agents', 'adapters'));
    expect(importing('entry', 'proof-core')).toEqual([]);
    expect(importing('entry', 'adapters')).toEqual([]);
  });

  it('refuses a file in a folder that §14 does not list, and names the folders it knows', () => {
    expect(checkSourceImports('src/plugins/a.ts', '')).toEqual([
      {
        file: 'src/plugins/a.ts',
        specifier: '',
        reason: expect.stringMatching(/outside the declared layers \(.*\bkernel\b.*\bgate\b.*\bentry\b.*\)/),
      },
    ]);
  });
});
