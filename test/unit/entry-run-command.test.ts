// SPDX-License-Identifier: AGPL-3.0-only
// The `run` command around the run itself (docs/FOUNDATION.md §5): what it prints, where, and in what order against
// closing the browser, with and without --proof-bundle. The browser and the current run are stood in for, so that
// only what the command does around them is tested; the kernel, the recorder and the judge are real.
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driverState = vi.hoisted(() => ({ closeError: null as Error | null, events: [] as string[] }));

vi.mock('../../src/surfaces/web/driver.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    openWebSurfaceDriver: async () => ({
      close: async () => {
        driverState.events.push('close');
        if (driverState.closeError) throw driverState.closeError;
      },
    }),
  };
});

vi.mock('../../src/proof-core/orchestrator.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    runVerification: async () => {
      driverState.events.push('run');
      return {
        exitCode: 0,
        report: {
          verdict: 'pass',
          dryRun: false,
          plans: [],
          totals: { plans: 0, plansPassed: 0, assertions: 0, passed: 0 },
          method: { settings: { failOn: 'none' } },
          findings: [],
        },
      };
    },
  };
});

const { main } = await import('../../src/entry/cli.js');
const { verifyBundle } = await import('../../src/entry/verify.js');

let tmp: string;
let plan: string;
let written: { stream: 'out' | 'err'; text: string }[];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-runcmd-'));
  plan = path.join(tmp, 'plan.json');
  await writeFile(
    plan,
    JSON.stringify({ format: 'miqyas-plan', version: 1, id: 'p', steps: [{ id: 's1', type: 'action', text: 'Open' }, { id: 'a1', type: 'assertion', text: "'Hello'" }] }),
  );
  driverState.closeError = null;
  driverState.events = [];
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push({ stream: 'out', text: String(chunk) });
    driverState.events.push('stdout');
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    written.push({ stream: 'err', text: String(chunk) });
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

const runArgs = (out: string, ...extra: string[]) => ['run', plan, '--url', 'http://127.0.0.1:9/', '--no-model', '--out', out, ...extra];
const inject = () => ({ spendDir: path.join(tmp, 'spend'), runsDir: path.join(tmp, 'runs') });

describe('run without --proof-bundle', { timeout: 300_000 }, () => {
  it('prints the report before it closes the browser, so a close that throws still leaves the report, then the error', async () => {
    driverState.closeError = new Error('the browser would not close');
    const out = path.join(tmp, 'out');
    expect(await main(runArgs(out, '--json'), inject())).toBe(3);
    expect(driverState.events).toEqual(['run', 'stdout', 'close']);
    expect(written.filter((w) => w.stream === 'out').map((w) => JSON.parse(w.text).verdict)).toEqual(['pass']);
    const report = written.findIndex((w) => w.stream === 'out');
    const error = written.findIndex((w) => w.stream === 'err' && w.text.includes('the browser would not close'));
    expect(error).toBeGreaterThan(report);
  });

  it('writes no ledger and no checkpoint, and prints no head', async () => {
    const out = path.join(tmp, 'out');
    expect(await main(runArgs(out), inject())).toBe(0);
    const files = await readdir(out).catch(() => [] as string[]);
    expect(files).not.toContain('ledger.jsonl');
    expect(files).not.toContain('checkpoint');
    expect(written.some((w) => w.text.includes('proof bundle head'))).toBe(false);
  });
});

describe('run with --proof-bundle', { timeout: 300_000 }, () => {
  it('prints the head on stdout after the report, seals the fold of its verdicts, and the bundle verifies', async () => {
    const out = path.join(tmp, 'out');
    expect(await main(runArgs(out, '--proof-bundle'), inject())).toBe(0);
    const stdout = written.filter((w) => w.stream === 'out').map((w) => w.text);
    expect(stdout.at(-1)).toMatch(/^proof bundle head: \d+ records, root [A-Za-z0-9+/=]+\n$/);
    expect(written.filter((w) => w.stream === 'err').some((w) => w.text.includes('proof bundle head'))).toBe(false);

    const records = (await readFile(path.join(out, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const seal = records.at(-1);
    expect(seal.t).toBe('run.seal');
    // No profile, so no claim ran: the fold of no verdict is not known, never a pass.
    expect(seal.body.result).toEqual({ verdict: 'not_known', verdicts: 0, currentPath: { verdict: 'pass', exitCode: 0, plans: [] } });
    expect((await verifyBundle(out)).exitCode).toBe(0);
  });

  it('with --json prints the head on stderr and keeps stdout for the report alone', async () => {
    const out = path.join(tmp, 'out');
    expect(await main(runArgs(out, '--proof-bundle', '--json'), inject())).toBe(0);
    const stdout = written.filter((w) => w.stream === 'out').map((w) => w.text);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!).verdict).toBe('pass');
    expect(written.filter((w) => w.stream === 'err').some((w) => /^proof bundle head: /.test(w.text))).toBe(true);
  });

  it('a copy of the bundle in another folder still verifies, and the ledger holds none of the paths it was given', async () => {
    const out = path.join(tmp, 'deep', 'run folder');
    expect(await main(runArgs(out, '--proof-bundle', '--repo', tmp), inject())).toBe(0);
    const ledger = await readFile(path.join(out, 'ledger.jsonl'), 'utf8');
    expect(ledger).not.toContain(tmp);
    expect(ledger).not.toContain(path.basename(tmp));
    expect(ledger).not.toMatch(/(^|[^A-Za-z])[A-Za-z]:[\\/]/); // a drive, not the scheme of a URL

    const copy = path.join(await mkdtemp(path.join(os.tmpdir(), 'miqyas-runcmd-copy-')), 'moved');
    try {
      await cp(out, copy, { recursive: true });
      const report = await verifyBundle(copy);
      expect(report.lines.join('\n')).toContain('1. Intact? yes');
      expect(report.exitCode).toBe(0);
    } finally {
      await rm(path.dirname(copy), { recursive: true, force: true });
    }
  });
});
