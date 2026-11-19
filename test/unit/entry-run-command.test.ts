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
import type { Verdict } from '../../src/kernel/judge.js';

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

describe('run without --proof-bundle keeps the exit code of the current path', () => {
  it('gives back the result of the current path untouched, its exit code included', async () => {
    const failing: CurrentPathResult = { exitCode: 1, report: { verdict: 'fail', plans: [] } };
    const unknown: CurrentPathResult = { exitCode: 1, report: { verdict: 'not_checked', plans: [] } };
    for (const result of [report, failing, unknown]) {
      expect((await runPrintClose({ ...steps(), run: async () => result })).exitCode).toBe(result.exitCode);
    }
  });
});

/** A judge that records verdict records naming these words, as a claim on the new path would. */
const recording = (words: string[]) => async (recorder: Parameters<Parameters<typeof runBundled>[0]['judge']>[0]) => {
  const verdicts = words.map((verdict, i) => ({ claim: `c${i + 1}@1`, verdict }) as unknown as Verdict);
  for (const v of verdicts) await recorder.record('verdict', v as never);
  return verdicts;
};

describe('run with --proof-bundle seals the fold of its verdicts (FOUNDATION §4), whatever the current path gave', () => {
  it.each([
    [['pass'], 0],
    [['pass', 'pass'], 0],
    [['pass', 'fail'], 1],
    [['fail', 'blocked'], 1],
    [['pass', 'not_checked'], 3],
    [['blocked'], 3],
    [['unverified', 'pass'], 3],
  ])('%j seals exit %i, and keeps what the current path gave apart', async (words, exit) => {
    const out = path.join(tmp, 'out');
    const failing: CurrentPathResult = { exitCode: 1, report: { verdict: 'fail', plans: [] } };
    await runBundled(bundled(out, recording(words)), { ...steps(), run: async () => failing });
    const seal = (await ledger(out)).at(-1);
    expect(seal.body.result).toMatchObject({ verdicts: words.length, exit, currentPath: { exitCode: 1 } });
    expect((await verifyBundle(out)).exitCode).toBe(0);
  });
});

describe('run with --proof-bundle never exits greener than the current path', () => {
  // Until plans and the other checks are judged on the new path: 1 if the current path gave 1 or the fold fails;
  // otherwise 3 if the fold is not known; otherwise the current path's code; 2 only when neither path judged anything.
  const FOLDS = { pass: ['pass'], fail: ['pass', 'fail'], not_known: ['pass', 'not_checked'], none: [] as string[] };
  type Fold = keyof typeof FOLDS;
  const TABLE: [number, Fold, number][] = [
    [0, 'pass', 0],
    [0, 'fail', 1],
    [0, 'not_known', 3],
    [0, 'none', 0],
    [1, 'pass', 1],
    [1, 'fail', 1],
    [1, 'not_known', 1],
    [1, 'none', 1],
    [3, 'pass', 3],
    [3, 'fail', 1],
    [3, 'not_known', 3],
    [3, 'none', 3],
    [2, 'pass', 2],
    [2, 'fail', 1],
    [2, 'not_known', 3],
    [2, 'none', 2],
  ];

  it.each(TABLE)('the current path exits %i with a plan judged, the fold is %s: the run exits %i', async (current, fold, exit) => {
    const out = path.join(tmp, 'out');
    const notes: string[] = [];
    const result: CurrentPathResult = { exitCode: current, report: { verdict: current === 0 ? 'pass' : 'fail', plans: [{ planId: 'p', verdict: 'x' }] } };
    expect(await runBundled({ ...bundled(out, recording(FOLDS[fold])), printNote: (l) => notes.push(l) }, { ...steps(), run: async () => result })).toBe(exit);
    expect(notes).toEqual([]);
    // The seal's exit is the bundle's own fold, which verify recomputes; the process exit also takes the current path in.
    const seal = (await ledger(out)).at(-1);
    expect(seal.body.result).toMatchObject({ exit: fold === 'none' ? 2 : fold === 'pass' ? 0 : fold === 'fail' ? 1 : 3, currentPath: { exitCode: current } });
    expect((await verifyBundle(out)).exitCode).toBe(0);
  });

  it('neither path judged anything: exit 2, and a message that says so', async () => {
    const out = path.join(tmp, 'out');
    const notes: string[] = [];
    const nothing: CurrentPathResult = { exitCode: 0, report: { verdict: 'pass', plans: [] } };
    expect(await runBundled({ ...bundled(out), printNote: (l) => notes.push(l) }, { ...steps(), run: async () => nothing })).toBe(2);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/nothing was judged/);
  });

  it('a current path with readiness checks and no plan has judged something; with no claim on the new path, its code stands', async () => {
    const out = path.join(tmp, 'out');
    const checks = { exitCode: 3, report: { verdict: 'not_checked', plans: [], readiness: { checks: [] } } } as CurrentPathResult;
    expect(await runBundled({ ...bundled(out), printNote: () => {} }, { ...steps(), run: async () => checks })).toBe(3);
  });

  it('a current path that judged nothing, beside a claim on the new path: the fold decides', async () => {
    const nothing: CurrentPathResult = { exitCode: 0, report: { verdict: 'pass', plans: [] } };
    for (const [words, exit] of [[['pass'], 0], [['fail'], 1], [['blocked'], 3]] as const) {
      const out = path.join(tmp, `out-${exit}`);
      expect(await runBundled(bundled(out, recording([...words])), { ...steps(), run: async () => nothing })).toBe(exit);
    }
  });
});

describe('run with --proof-bundle', () => {
  it('runs the same sequence, then judges, then prints the head; seals the fold of its verdicts; the bundle verifies', async () => {
    const out = path.join(tmp, 'out');
    // No claim on the new path, and the current path judged a plan: its code stands.
    expect(await runBundled(bundled(out), steps())).toBe(0);
    expect(events).toEqual(['open', 'run', 'print pass', 'close', 'judge', 'proof bundle head']);

    const seal = (await ledger(out)).at(-1);
    expect(seal.t).toBe('run.seal');
    // No claim ran: the fold of no verdict is not known, never a pass.
    expect(seal.body.result).toEqual({ verdict: 'not_known', verdicts: 0, exit: 2, currentPath: { verdict: 'pass', exitCode: 0, plans: [{ id: 'p', verdict: 'pass' }] } });
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
    // Check 13 is not_checked over a folder with no lockfile: nothing fails, something is not known, exit 3.
    expect(await runBundled(bundled(out, async (recorder) => [await runCheck13(recorder, { repoPath: tmp })]), steps())).toBe(3);
    const records = await ledger(out);
    expect(records.filter((r) => r.t === 'verdict').map((r) => r.body.verdict)).toEqual(['not_checked']);
    expect(records.at(-1).body.result).toMatchObject({ verdict: 'not_known', verdicts: 1, exit: 3, currentPath: { exitCode: 0 } });

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
