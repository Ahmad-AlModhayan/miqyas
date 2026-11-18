// SPDX-License-Identifier: AGPL-3.0-only
// The `run` command around the run itself (docs/FOUNDATION.md §5): open the driver, run, print the report, close the
// driver, in that order on both paths, so a close that throws still leaves the report printed. With --proof-bundle the
// same sequence runs inside the bundle, the claims on the new path are judged after it, and the head is printed last.
import type { RunRecorder } from '../engine/recorder.js';
import { type Verdict, sealResult } from '../kernel/judge.js';
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

/** What the current path gives, as much of it as the seal keeps beside the fold. */
export interface CurrentPathResult {
  exitCode: number;
  report: { verdict: string; plans: readonly { planId: string; verdict: string }[] };
}

export interface BundledRun {
  bundle: Omit<ProofBundleRun, 'print'>;
  /** Judges the claims on the new path, after the current path has run and printed; each verdict is already recorded. */
  judge: (recorder: RunRecorder) => Promise<Verdict[]>;
  /** Where the head goes, after everything else. */
  printHead: (line: string) => void;
}

/**
 * The run with --proof-bundle. The current path runs as it does without the flag; then the claims on the new path are
 * judged. The seal holds the fold of the verdict records, and beside it, apart, what the current path concluded. The
 * exit code is still the current path's.
 */
export async function runBundled<D extends { close(): Promise<void> }, R extends CurrentPathResult>(
  bundled: BundledRun,
  steps: RunSteps<D, R>,
): Promise<number> {
  const head: string[] = [];
  const exitCode = await runWithProofBundle({ ...bundled.bundle, print: (line) => head.push(line) }, async (recorder) => {
    const result = await runPrintClose(steps);
    const verdicts = await bundled.judge(recorder);
    const currentPath = {
      verdict: result.report.verdict,
      exitCode: result.exitCode,
      plans: result.report.plans.map((p) => ({ id: p.planId, verdict: p.verdict })),
    };
    return { result: result.exitCode, fold: { ...sealResult(verdicts.map((v) => v.verdict)), currentPath } };
  });
  for (const line of head) bundled.printHead(line);
  return exitCode;
}
