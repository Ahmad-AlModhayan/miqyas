// SPDX-License-Identifier: AGPL-3.0-only
// Three-valued combining and the fold (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A5): the verdict words, `all` and
// `any` over them, the one fold that serves a plan's claims, a profile's and the run's, and the exit codes it gives.
// Pure functions of their arguments; the judge uses `combine` for a combination claim, and verify recomputes the seal
// with `sealResult`.

export const VERDICTS = ['pass', 'fail', 'not_checked', 'blocked', 'unverified'] as const;
export type VerdictValue = (typeof VERDICTS)[number];

/** How a combination joins its parts (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A5). */
export const COMBINATIONS = ['all', 'any'] as const;
export type Combination = (typeof COMBINATIONS)[number];

/** The not-known words in the order a combination reports them: the person's step first, then Miqyas's, then a review. */
export const NOT_KNOWN_ORDER: readonly VerdictValue[] = ['blocked', 'not_checked', 'unverified'];

/**
 * Three-valued combining (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A5): with `fail < not known < pass`, `all` is the
 * least of its parts and `any` the greatest. When that is not known, the word is the first of `blocked`,
 * `not_checked`, `unverified` among the parts. An empty list has no answer and is refused.
 */
export function combine(how: Combination, values: readonly VerdictValue[]): VerdictValue {
  if (values.length === 0) throw new RangeError(`${how} of no parts: an empty list is refused`);
  const settles: VerdictValue = how === 'all' ? 'fail' : 'pass';
  const other: VerdictValue = how === 'all' ? 'pass' : 'fail';
  if (values.includes(settles)) return settles;
  if (values.every((v) => v === other)) return other;
  return NOT_KNOWN_ORDER.find((word) => values.includes(word)) as VerdictValue;
}

/** What a run concluded: fail if any verdict fails, otherwise not known if any is not a pass, otherwise pass. */
export type Conclusion = 'pass' | 'fail' | 'not_known';

/**
 * The fold (docs/FOUNDATION.md §4, docs/ALGORITHMS.md A5): `all` over the verdicts, the one function that serves a
 * plan's claims, a profile's and the run's. An empty set never passes, and a word that is not a verdict is not a pass.
 */
export function fold(verdicts: readonly string[]): Conclusion {
  if (verdicts.length === 0) return 'not_known';
  const words = verdicts.map((v): VerdictValue => (VERDICTS.includes(v as VerdictValue) ? (v as VerdictValue) : 'not_checked'));
  const all = combine('all', words);
  return all === 'pass' || all === 'fail' ? all : 'not_known';
}

/**
 * The exit code of a run on the new path (docs/FOUNDATION.md §4, "The fold"): 0 every claim passes, 1 some claim
 * fails, 3 nothing fails but something is not known, 2 a usage error, which a run with no claim at all is.
 */
export type ExitCode = 0 | 1 | 2 | 3;

/** The part of the seal's result that verify recomputes from the verdict records: the conclusion, over how many, the exit code. */
export type SealResult = { verdict: Conclusion; verdicts: number; exit: ExitCode };

export function sealResult(verdicts: readonly string[]): SealResult {
  const verdict = fold(verdicts);
  const exit: ExitCode = verdicts.length === 0 ? 2 : verdict === 'pass' ? 0 : verdict === 'fail' ? 1 : 3;
  return { verdict, verdicts: verdicts.length, exit };
}
