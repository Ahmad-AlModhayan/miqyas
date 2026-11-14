// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/entry/cli.js';
import type { BenchSummary } from '../../src/proof-core/bench.js';
import type { RunReport } from '../../src/proof-core/report.js';
import { serveDir } from '../../src/surfaces/web/server.js';
import { schemaErrors } from '../report-helpers.js';

let tmp = '';
let siteDir = '';
let server: { url: string; close(): Promise<void> };

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-e2e-21-'));
  siteDir = path.join(tmp, 'site');
  await mkdir(siteDir, { recursive: true });
  await writeFile(
    path.join(siteDir, 'index.html'),
    '<!doctype html><html><head><title>App</title></head><body><main><h1>Ready</h1></main></body></html>',
    'utf8',
  );
  server = await serveDir(siteDir);
});

afterAll(async () => {
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('report privacy hygiene, .miqyas/runs retention, and bench ordering E2E (#21)', () => {
  it('emits relative plans[].file without leaking machine paths in report.json and report.md', async () => {
    const work = path.join(tmp, 'hygiene-work');
    const repo = path.join(tmp, 'target-repo');
    const planInRepo = path.join(repo, 'plans', '01-smoke.json');
    const outDir = path.join(work, '.miqyas', 'runs', 'hygiene-run');
    await mkdir(path.dirname(planInRepo), { recursive: true });
    await mkdir(work, { recursive: true });
    await writeFile(
      planInRepo,
      JSON.stringify({
        format: 'miqyas-plan',
        version: 1,
        id: 'smoke',
        name: 'Smoke',
        start: '/',
        steps: [{ id: 'a1', type: 'assertion', text: 'Shows Ready heading' }],
      }),
      'utf8',
    );
    await writeFile(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'target-repo', version: '1.0.0', private: true }),
      'utf8',
    );

    const origCwd = process.cwd();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.chdir(work);
      const code = await main([
        'run',
        planInRepo,
        '--url',
        server.url,
        '--profile',
        'grade-1',
        '--repo',
        repo,
        '--dry-run',
        '--out',
        outDir,
      ]);
      expect(code).toBe(0);
    } finally {
      process.chdir(origCwd);
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    const reportJsonRaw = await readFile(path.join(outDir, 'report.json'), 'utf8');
    const reportMd = await readFile(path.join(outDir, 'report.md'), 'utf8');
    const report = JSON.parse(reportJsonRaw) as RunReport;
    expect(schemaErrors('report', report)).toEqual([]);
    const smokePlan = report.plans.find((p) => p.planId === 'smoke');
    expect(smokePlan?.file).toBe('plans/01-smoke.json');
    expect(reportJsonRaw).not.toContain(repo);
    expect(reportMd).toContain('plans/01-smoke.json');
    expect(reportMd).not.toContain(repo);
  }, 60_000);

  it('prunes expired .miqyas/runs entries on startup while preserving active and custom --out siblings', async () => {
    const work = path.join(tmp, 'retention-work');
    const runsDir = path.join(work, '.miqyas', 'runs');
    const expiredRun = path.join(runsDir, '20261001-010101-old1');
    const freshRun = path.join(runsDir, '20261113-010101-new1');
    const activeRun = path.join(runsDir, '20261001-010101-active');
    const customParent = path.join(tmp, 'custom-parent');
    const customSibling = path.join(customParent, 'keep-old-sibling');
    const customActive = path.join(customParent, 'active-custom');
    const planFile = path.join(work, 'plans', 'smoke.json');

    await mkdir(path.join(work, 'plans'), { recursive: true });
    await mkdir(expiredRun, { recursive: true });
    await mkdir(freshRun, { recursive: true });
    await mkdir(activeRun, { recursive: true });
    await mkdir(customSibling, { recursive: true });
    await writeFile(path.join(expiredRun, 'stale.txt'), 'old', 'utf8');
    await writeFile(
      planFile,
      JSON.stringify({
        format: 'miqyas-plan',
        version: 1,
        id: 'smoke-ret',
        start: '/',
        steps: [{ id: 'a1', type: 'assertion', text: 'Shows Ready heading' }],
      }),
      'utf8',
    );

    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const freshDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    await utimes(expiredRun, oldDate, oldDate);
    await utimes(activeRun, oldDate, oldDate);
    await utimes(freshRun, freshDate, freshDate);
    await utimes(customSibling, oldDate, oldDate);

    const origCwd = process.cwd();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.chdir(work);
      expect(
        await main([
          'run',
          planFile,
          '--url',
          server.url,
          '--dry-run',
          '--retention-days',
          '14',
          '--out',
          activeRun,
        ]),
      ).toBe(0);

      expect(existsSync(expiredRun)).toBe(false);
      expect(existsSync(freshRun)).toBe(true);
      expect(existsSync(activeRun)).toBe(true);
      expect(existsSync(path.join(activeRun, 'report.json'))).toBe(true);

      expect(
        await main([
          'run',
          planFile,
          '--url',
          server.url,
          '--dry-run',
          '--retention-days',
          '14',
          '--out',
          customActive,
        ]),
      ).toBe(0);
      expect(existsSync(customSibling)).toBe(true);
      expect(existsSync(path.join(customActive, 'report.json'))).toBe(true);
    } finally {
      process.chdir(origCwd);
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  }, 60_000);

  it('runs miqyas bench wasl-tray --dry-run --json offline without API keys and reports dry_run verdict', async () => {
    const cloneDir = path.join(tmp, 'wasl-clone');
    const desktopDir = path.join(cloneDir, 'desktop');
    const vendorViteBin = path.join(desktopDir, 'vendor', 'vite', 'bin');
    const benchWork = path.join(tmp, 'bench-work');
    await mkdir(vendorViteBin, { recursive: true });
    await mkdir(benchWork, { recursive: true });

    await writeFile(
      path.join(desktopDir, 'vendor', 'vite', 'package.json'),
      JSON.stringify({ name: 'vite', version: '5.0.0', bin: { vite: 'bin/vite.js' } }),
      'utf8',
    );
    await writeFile(
      path.join(vendorViteBin, 'vite.js'),
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const i = process.argv.indexOf('--outDir');",
        "const out = i !== -1 ? process.argv[i + 1] : 'dist-mock';",
        "fs.mkdirSync(path.join(out, 'assets'), { recursive: true });",
        "fs.copyFileSync('index.html', path.join(out, 'index.html'));",
        "fs.copyFileSync('app.js', path.join(out, 'assets', 'app.js'));",
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      path.join(desktopDir, 'package.json'),
      JSON.stringify({
        name: 'bench-fixture',
        version: '1.0.0',
        private: true,
        dependencies: { vite: 'file:./vendor/vite' },
      }),
      'utf8',
    );
    await writeFile(
      path.join(desktopDir, 'package-lock.json'),
      JSON.stringify({
        name: 'bench-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'bench-fixture', version: '1.0.0', dependencies: { vite: 'file:vendor/vite' } },
          'node_modules/vite': { resolved: 'vendor/vite', link: true },
          'vendor/vite': { version: '5.0.0' },
        },
      }),
      'utf8',
    );
    await writeFile(
      path.join(desktopDir, 'index.html'),
      [
        '<!doctype html>',
        '<html>',
        '<head>',
        '<meta charset="utf-8">',
        '<title>Fixture</title>',
        '<style>body{margin:0;display:flex}nav.side{width:180px}main{flex:1}</style>',
        '</head>',
        '<body>',
        '<nav class="side"><button type="button" id="bin-btn">Recycle bin</button></nav>',
        '<main><p id="msg"></p></main>',
        '<script src="/assets/app.js"></script>',
        '</body>',
        '</html>',
      ].join(''),
      'utf8',
    );
    await writeFile(
      path.join(desktopDir, 'app.js'),
      'var label = "The recycle bin is empty"; document.getElementById("msg").textContent = label;\n',
      'utf8',
    );

    gitIn(cloneDir, ['init']);
    gitIn(cloneDir, ['config', 'user.name', 'Test User']);
    gitIn(cloneDir, ['config', 'user.email', 'test@example.com']);
    gitIn(cloneDir, ['add', '.']);
    gitIn(cloneDir, ['commit', '-m', 'offline bench fixture']);
    const commit = gitIn(cloneDir, ['rev-parse', 'HEAD']);

    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const prevOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.OPENAI_API_KEY;

    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const origCwd = process.cwd();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      outChunks.push(String(c));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      errChunks.push(String(c));
      return true;
    });

    try {
      process.chdir(benchWork);
      const code = await main([
        'bench',
        'wasl-tray',
        '--repo',
        cloneDir,
        '--commit',
        commit,
        '--dry-run',
        '--json',
      ]);
      expect(code, `stderr: ${errChunks.join('')}`).toBe(0);
    } finally {
      process.chdir(origCwd);
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
      if (prevOpenAi !== undefined) process.env.OPENAI_API_KEY = prevOpenAi;
    }

    const summary = JSON.parse(outChunks.join('')) as BenchSummary;
    expect(summary.verdict).toBe('dry_run');
    expect(summary.source.commit).toBe(commit);
    expect(summary.source.unchanged).toBe(true);
    expect(summary.plans.total).toBeGreaterThan(0);
    expect(summary.plans.unresolved).toBe(0);
    expect(summary.usage.calls).toBe(0);

    const runReportRaw = await readFile(path.join(benchWork, summary.runs.run, 'report.json'), 'utf8');
    const runReport = JSON.parse(runReportRaw) as RunReport;
    expect(schemaErrors('report', runReport)).toEqual([]);
    expect(runReport.verdict).toBe('dry_run');
    for (const p of runReport.plans) {
      expect(p.file).toBeDefined();
      expect(path.isAbsolute(p.file!)).toBe(false);
    }
  }, 60_000);
});
