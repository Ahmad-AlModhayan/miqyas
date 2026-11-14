// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/entry/cli.js';
import type { BenchSummary } from '../../src/proof-core/bench.js';
import { CORPUS_CATEGORIES, lintCorpus, loadCorpusFromPath, verifyCorpusProbes } from '../../src/proof-core/corpus.js';
import { loadPlans } from '../../src/proof-core/plan.js';
import { loadBenchHistory } from '../../src/proof-core/scoring.js';
import { openWebSurfaceDriver } from '../../src/surfaces/web/driver.js';
import { serveDir } from '../../src/surfaces/web/server.js';

let tmp = '';

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-e2e-corpus-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('seeded corpus e2e across 10 categories, clean twin, and bench history (#15)', () => {
  it('lints mini-shop corpus cleanly and proves every seed code probe changes the served UI', async () => {
    const loaded = await loadCorpusFromPath('corpus/mini-shop');
    const plans = await loadPlans([path.join(loaded.baseDir, 'plans')]);
    lintCorpus(loaded.manifest, plans, loaded.knownFindings);

    const covered = new Set(loaded.manifest.seeds.map((s) => s.category));
    for (const cat of CORPUS_CATEGORIES) {
      expect(covered.has(cat), `missing corpus category ${cat}`).toBe(true);
    }

    const driver = await openWebSurfaceDriver({ headed: false, allowOtherOrigins: false });
    try {
      const results = await verifyCorpusProbes({
        manifest: loaded.manifest,
        cleanBuildDir: loaded.cleanBuildDir,
        baseRoot: process.cwd(),
        driver,
        serve: serveDir,
        workDir: path.join(tmp, 'probes'),
      });
      expect(results).toHaveLength(loaded.manifest.seeds.length);
      for (const r of results) {
        expect(r.effective, `probe ${r.id} should prove effective: ${r.detail}`).toBe(true);
      }
    } finally {
      await driver.close();
    }
  }, 120_000);

  it('runs miqyas lint --corpus and miqyas bench --corpus --no-model writing unblended summary and history.jsonl', async () => {
    expect(await main(['lint', '--corpus', 'corpus/mini-shop'])).toBe(0);

    const outDir = path.join(tmp, 'bench-out');
    const historyFile = path.join(tmp, 'bench-history', 'history.jsonl');
    const code = await main([
      'bench',
      '--corpus',
      'corpus/mini-shop',
      '--no-model',
      '--out',
      outDir,
      '--history',
      historyFile,
    ]);
    expect(code).toBe(0);
    expect(existsSync(path.join(outDir, 'summary.json'))).toBe(true);
    expect(existsSync(path.join(outDir, 'summary.md'))).toBe(true);

    const summary = JSON.parse(await readFile(path.join(outDir, 'summary.json'), 'utf8')) as BenchSummary;
    expect(summary.corpus).toBeDefined();
    expect('overallScore' in summary.corpus!).toBe(false);
    expect(summary.corpus!.parts.asserted.killed).toBe(2);
    expect(summary.corpus!.parts.asserted.caughtByCode).toBe(2);
    expect(summary.corpus!.parts.unasserted.planted).toBe(5);
    expect(summary.corpus!.parts.readiness.placed).toBe(2);
    expect(summary.corpus!.parts.readiness.caught).toBe(2);
    expect(summary.corpus!.parts.readiness.checksProven).toBe(2);
    expect(summary.corpus!.cleanTwin).toMatchObject({ quiet: true, falsePositives: 0 });

    const history = await loadBenchHistory(historyFile);
    expect(history).toHaveLength(1);
    expect(history[0]!.bench).toBe('mini-shop');
    expect(history[0]!.cleanTwin.quiet).toBe(true);

    const md = await readFile(path.join(outDir, 'summary.md'), 'utf8');
    expect(md).toContain('## Corpus Scores (Per-Part, Unblended)');
  }, 180_000);
});
