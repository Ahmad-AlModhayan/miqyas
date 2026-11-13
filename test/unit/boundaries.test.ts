// SPDX-License-Identifier: PolyForm-Shield-1.0.0
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
