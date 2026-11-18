// SPDX-License-Identifier: AGPL-3.0-only
// The `run` command around the run itself (docs/FOUNDATION.md §5): what it prints, and in what order against closing
// the browser, with and without --proof-bundle. Both paths run one sequence, handed its parts as plain functions here:
// a driver that only closes, a run that gives a report, a print that notes it. The kernel, the recorder, the bundle
// store, check 13 and verify are real.
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck13 } from '../../src/entry/check13.js';
import { type CurrentPathResult, type RunSteps, runBundled, runPrintClose } from '../../src/entry/run-command.js';
import { verifyBundle } from '../../src/entry/verify.js';

let tmp: string;
let events: string[];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-runcmd-'));
  events = [];
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const report: CurrentPathResult = { exitCode: 0, report: { verdict: 'pass', plans: [{ planId: 'p', verdict: 'pass' }] } };

/** The parts of a run as plain functions, each noting when it ran; `close` throws when given an error. */
function steps(options: { closeError?: Error; runError?: Error } = {}): RunSteps<{ close(): Promise<void> }, CurrentPathResult> {
  return {
    openDriver: async () => {
      events.push('open');
      return {
        close: async () => {
          events.push('close');
          if (options.closeError) throw options.closeError;
        },
      };
    },
    run: async () => {
      events.push('run');
      if (options.runError) throw options.runError;
      return report;
    },
    print: (result) => events.push(`print ${result.report.verdict}`),
  };
}

const bundled = (dir: string, judge: Parameters<typeof runBundled>[0]['judge'] = async () => []) => ({
  bundle: { dir, runId: 'run-1', open: { url: 'http://127.0.0.1:9/' }, now: () => new Date('2026-11-18T00:00:00Z') },
  judge: async (recorder: Parameters<typeof judge>[0]) => {
    events.push('judge');
    return await judge(recorder);
  },
  printHead: (line: string) => events.push(line.replace(/: .*/, '')),
});

const ledger = async (dir: string) => (await readFile(path.join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

describe('run without --proof-bundle', () => {
  it('opens the browser, runs, prints the report, then closes the browser', async () => {
    expect(await runPrintClose(steps())).toBe(report);
    expect(events).toEqual(['open', 'run', 'print pass', 'close']);
  });

  it('prints the report before it closes the browser, so a close that throws still leaves the report, then the error', async () => {
    await expect(runPrintClose(steps({ closeError: new Error('the browser would not close') }))).rejects.toThrow('the browser would not close');
    expect(events).toEqual(['open', 'run', 'print pass', 'close']);
  });

  it('closes the browser when the run throws, and prints nothing', async () => {
    await expect(runPrintClose(steps({ runError: new Error('the run broke') }))).rejects.toThrow('the run broke');
    expect(events).toEqual(['open', 'run', 'close']);
  });
});

describe('run with --proof-bundle', () => {
  it('runs the same sequence, then judges, then prints the head; seals the fold of its verdicts; the bundle verifies', async () => {
    const out = path.join(tmp, 'out');
    expect(await runBundled(bundled(out), steps())).toBe(0);
    expect(events).toEqual(['open', 'run', 'print pass', 'close', 'judge', 'proof bundle head']);

    const seal = (await ledger(out)).at(-1);
    expect(seal.t).toBe('run.seal');
    // No claim ran: the fold of no verdict is not known, never a pass.
    expect(seal.body.result).toEqual({ verdict: 'not_known', verdicts: 0, currentPath: { verdict: 'pass', exitCode: 0, plans: [{ id: 'p', verdict: 'pass' }] } });
    expect((await verifyBundle(out)).exitCode).toBe(0);
  });

  it('prints the report before it closes the browser, so a close that throws still leaves the report, then the error, unsealed', async () => {
    const out = path.join(tmp, 'out');
    await expect(runBundled(bundled(out), steps({ closeError: new Error('the browser would not close') }))).rejects.toThrow('the browser would not close');
    expect(events).toEqual(['open', 'run', 'print pass', 'close']);
    expect((await ledger(out)).some((r) => r.t === 'run.seal')).toBe(false);
  });

  it('seals check 13 on the new path; a copy of the bundle in another folder still verifies, and holds none of the paths it was given', async () => {
    const out = path.join(tmp, 'deep', 'run folder');
    expect(await runBundled(bundled(out, async (recorder) => [await runCheck13(recorder, { repoPath: tmp })]), steps())).toBe(0);
    const records = await ledger(out);
    expect(records.filter((r) => r.t === 'verdict').map((r) => r.body.verdict)).toEqual(['not_checked']);
    expect(records.at(-1).body.result).toMatchObject({ verdict: 'not_known', verdicts: 1 });

    const text = await readFile(path.join(out, 'ledger.jsonl'), 'utf8');
    expect(text).not.toContain(tmp);
    expect(text).not.toContain(path.basename(tmp));
    expect(text).not.toMatch(/(^|[^A-Za-z])[A-Za-z]:[\\/]/); // a drive, not the scheme of a URL

    const copy = path.join(await mkdtemp(path.join(os.tmpdir(), 'miqyas-runcmd-copy-')), 'moved');
    try {
      await cp(out, copy, { recursive: true });
      const verified = await verifyBundle(copy);
      expect(verified.lines.join('\n')).toContain('1. Intact? yes');
      expect(verified.exitCode).toBe(0);
    } finally {
      await rm(path.dirname(copy), { recursive: true, force: true });
    }
  });
});
