// SPDX-License-Identifier: AGPL-3.0-only
// The `run` command around the run itself (docs/FOUNDATION.md §5): open the driver, run, print the report, close the
// driver, in that order on both paths, so a close that throws still leaves the report printed. With --proof-bundle the
// same sequence runs inside the bundle, the claims on the new path are judged after it, and the head is printed last.
import type { RunRecorder } from '../engine/recorder.js';
import { type SealResult, type Verdict, sealResult } from '../kernel/judge.js';
import { runCheck13 } from './check13.js';
import { type Severity, TARGET_SUBJECT, runFailOn } from './fail-on.js';
import { type ProofBundleRun, runWithProofBundle } from './proof-bundle.js';

/** The parts of a run, as arguments: how to open the driver, how to run with it, how to print what the run gave. */
export interface RunSteps<D extends { close(): Promise<void> }, R> {
  openDriver: () => Promise<D>;
  run: (driver: D) => Promise<R>;
  print: (result: R) => void;
}

/** Opens the driver, runs, prints, then closes the driver, even when the run or the print throws. */
export async function runPrintClose<D extends { close(): Promise<void> }, R>(steps: RunSteps<D, R>): Promise<R> {
  const driver = await steps.openDriver();
  try {
    const result = await steps.run(driver);
    steps.print(result);
    return result;
  } finally {
    await driver.close();
  }
}

/** What the current path gives, as much of it as the seal keeps beside the fold and the exit rule reads. */
export interface CurrentPathResult {
  exitCode: number;
  report: { verdict: string; plans: readonly { planId: string; verdict: string }[]; readiness?: unknown };
}

export interface BundledRun {
  bundle: Omit<ProofBundleRun, 'print'>;
  /** Judges the claims on the new path, after the current path has run and printed; each verdict is already recorded. */
  judge: (recorder: RunRecorder) => Promise<Verdict[]>;
  /** Where the head goes, after everything else. */
  printHead: (line: string) => void;
  /** Where a note about the exit goes; standard error when not given. */
  printNote?: (line: string) => void;
}

/** What the run exits with on the new path, and the note to print with it, if any. */
export interface BundledExit {
  exit: number;
  note?: string;
}

/**
 * The exit of a run with --proof-bundle, until plans and the other checks are judged on the new path: it is never
 * greener than the current path. 1 if the current path gave 1 or the fold fails; otherwise 3 if the fold is not known;
 * otherwise the current path's code, which is never turned into 0; and 2 only when neither path judged anything. The
 * seal's own exit stays the fold of the bundle's verdicts, which verify recomputes.
 */
export function bundledExit(current: CurrentPathResult, sealed: SealResult): BundledExit {
  if (current.exitCode === 1 || sealed.verdict === 'fail') return { exit: 1 };
  if (sealed.verdicts > 0 && sealed.verdict === 'not_known') return { exit: 3 };
  const currentJudged = current.report.plans.length > 0 || current.report.readiness !== undefined;
  if (sealed.verdicts === 0 && !currentJudged) {
    return { exit: 2, note: 'miqyas: nothing was judged: no plan or check on the current path, and no claim on the new path' };
  }
  return { exit: current.exitCode };
}

/** What decides which claims the run judges on the new path. */
export interface NewPathSettings {
  profile?: string;
  repoPath?: string;
  failOn?: Severity | 'none';
}

/**
 * The claims on the new path, each recorded with its verdict: check 13 under profile grade-1, and the --fail-on claim.
 * Nothing on the new path records findings yet, so the --fail-on claim reads no fact.
 */
export async function judgeNewPath(recorder: RunRecorder, settings: NewPathSettings): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  if (settings.profile === 'grade-1') verdicts.push(await runCheck13(recorder, settings.repoPath !== undefined ? { repoPath: settings.repoPath } : {}));
  if (settings.failOn !== undefined && settings.failOn !== 'none') {
    verdicts.push(await runFailOn(recorder, { severity: settings.failOn, subject: TARGET_SUBJECT, facts: [] }));
  }
  return verdicts;
}

/**
 * The run with --proof-bundle. The current path runs as it does without the flag; then the claims on the new path are
 * judged. The seal holds the fold of the verdict records with its exit code, and beside it, apart, what the current
 * path concluded. The run exits by `bundledExit`, which takes both into account.
 */
export async function runBundled<D extends { close(): Promise<void> }, R extends CurrentPathResult>(
  bundled: BundledRun,
  steps: RunSteps<D, R>,
): Promise<number> {
  const head: string[] = [];
  let note: string | undefined;
  const exitCode = await runWithProofBundle({ ...bundled.bundle, print: (line) => head.push(line) }, async (recorder) => {
    const result = await runPrintClose(steps);
    const verdicts = await bundled.judge(recorder);
    const currentPath = {
      verdict: result.report.verdict,
      exitCode: result.exitCode,
      plans: result.report.plans.map((p) => ({ id: p.planId, verdict: p.verdict })),
    };
    const sealed = sealResult(verdicts.map((v) => v.verdict));
    const exit = bundledExit(result, sealed);
    note = exit.note;
    return { result: exit.exit, fold: { ...sealed, currentPath } };
  });
  for (const line of head) bundled.printHead(line);
  if (note !== undefined) (bundled.printNote ?? ((line: string) => process.stderr.write(line + '\n')))(note);
  return exitCode;
}
