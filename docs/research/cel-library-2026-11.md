# Choosing a CEL library for the kernel (2026-11-17)

Research for [`docs/cel-subset.md`](../cel-subset.md) and ticket 43 (part of spec 41). The question: which TypeScript
CEL library does the kernel use, and does it hold up against the CEL conformance suite? Sources are the packages as
published, run here, and the upstream licence files. No expression in this note comes from a claim or a customer.

Tags: [V] verified by running the package here, or read from its published files or registry metadata, in 2026-11.
[M] recalled or reported by an earlier trial, not re-checked. A claim with no tag is the note's own reasoning.

## What the kernel needs

- The same answer everywhere claims are evaluated: Node, a browser, a worker. No Node-only API.
- Correct on the parts of CEL the kernel allows ([`docs/cel-subset.md`](../cel-subset.md)): 64-bit integers that
  overflow to an error, error absorption in `&&` and `||`, comparisons, lists, maps, strings, `matches`, and the macros.
  A wrong `true` or `false` is worse than a missing feature, because an error is read as uncertain and a wrong answer
  is not.
- A regular-expression engine that cannot be made to run for a long time by a pattern in a claim.
- A permissive licence (MIT, Apache-2.0, BSD or ISC) for the library and everything it pulls in.

## Candidates

The three TypeScript or JavaScript CEL libraries on npm that parse and evaluate the language itself (not a wrapper
around a service):

| Library | Version | Licence |
|---|---|---|
| `@bufbuild/cel` | 0.6.2 (0.x, marked beta) | Apache-2.0 |
| `@marcbachmann/cel-js` | 8.0.0 | MIT |
| `cel-js` (by ChromeGG) | 0.8.2 | MIT |

## Method

The conformance suite of google/cel-spec, version 0.25.1, in the form `@bufbuild/cel-spec` 0.6.2 republishes it. Each
case has an expression, optional variable bindings, and either an expected value or an expected error. Two runs per
library, each case evaluated with the library's own API and the result compared with the expected value in the suite's
own terms (an integer is a bigint, an error means an error):

1. The **JSON-expressible universe**: every case whose bindings and result can be written as JSON values (1533 cases).
   It includes features Miqyas does not allow, so it is a measure of the library's completeness, not of fitness.
2. The **subset**: the cases inside the allowed subset (468 cases in the trial run). This is the number that matters.

The trial scripts are not in the repository (see "Re-running the trial" below). The subset, vendored, is in
[`test/conformance/cel/`](../../test/conformance/cel/README.md) and runs in CI against the chosen library. The
vendored file was chosen by the rule in its README, not by the trial's script. It also holds 468 cases, all of which
pass with `@bufbuild/cel` [V], but it is a different set: the trial's 468 include the four backtick field-name cases
the library fails, and the file leaves those out.

## Results

| Library | Universe (1533) | Subset (468) |
|---|---|---|
| `@bufbuild/cel` | 1275 (83%) | 464 (99%) |
| `@marcbachmann/cel-js` | 1037 (68%) | 451 (96%) |
| `cel-js` (ChromeGG) | 447 (29%) | 263 (56%) |

**`@bufbuild/cel`.** The four subset failures are the four tests that use backtick-quoted field names, which the
subset does not allow. Everything else in the subset passes. Of the 258 failures in the larger universe, 251 are
cases of the extension libraries (math, bindings, blocks, encoders and the second macro suite) and 7 are field tests
that need protobuf messages; all of them are outside the subset.

**`@marcbachmann/cel-js`.** Seventeen subset failures; the four backtick ones plus these thirteen, which are not about
features Miqyas leaves out:

- `[].all(e, e > 0)` gives an error where CEL gives `true` (vacuity of an empty list), and `exists_one` over a map with
  integer keys gives an error where CEL gives `true`.
- `false && 32` and `true || 32` give an error where CEL gives `false` and `true`; so do the two forms with a text
  operand on the other side. Error absorption in `&&` and `||` is what lets a rule with a broken half still decide.
- `-(-9223372036854775808)` and `(-9223372036854775808)/-1` return 9223372036854775808, a value outside 64 bits,
  where CEL gives an overflow error.
- `has()` on a map literal gives an error; `['one'] == [2, 3]` gives an error where CEL gives `false`; and
  `true ? 'cows' : 17` gives an error where CEL gives `'cows'`.

**`cel-js` (ChromeGG).** Fails the basic literal tests, the string functions (`startsWith`, `endsWith`, `contains`,
`matches` all fail every case), and most macros. It is not a candidate.

The numbers in this section are from the trial run [M].

## Behaviour that the suite does not measure

Run on the same machine, each case once [M]:

| Probe | `@bufbuild/cel` | `@marcbachmann/cel-js` |
|---|---|---|
| `'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!'.matches('^(a+)+$')` | `false` in 5 ms | `false` after 7.6 s |
| `9223372036854775807 + 1` | an error value | throws |
| `1 + 1.0` | an error value | throws |
| `'ab'.matches('a(?=b)')` (lookahead, not in RE2) | an error value | `true` |
| `'é'.matches('\\p{L}')` | `true` | `false` |
| 20000 nested parentheses | an error value (stack depth) | throws (its own depth limit) |

`@bufbuild/cel` evaluates `matches` with `@bufbuild/re2`, a JavaScript port of RE2, which runs in linear time, accepts
the RE2 syntax CEL specifies and rejects what it does not. `@marcbachmann/cel-js` hands the pattern to the JavaScript
`RegExp`, which backtracks: a pattern in a claim can hold the process for seconds, and it accepts syntax CEL says is an
error. The kernel also refuses deep nesting itself before any library sees the text (`maxDepth`), so the last row
does not depend on either.

Both libraries evaluate integers as exact 64-bit values (`bigint`) and neither has a clock the kernel can reach. A
browser bundle of `@bufbuild/cel` (esbuild, minified, for the browser platform, with the string extension) builds
without any Node module and is 284 KB; of `@marcbachmann/cel-js`, 82 KB [M]. `cel-js` (ChromeGG) was not
measured for bundle size or for Node-only APIs: it was ruled out on correctness first.

**A missing field.** How each library treats `item.missing` when `item` has no such field:

- `@bufbuild/cel`: an error value, "field not found: missing" [V] (`test/unit/kernel-cel.test.ts`, "a missing field"), so the
  kernel's `evaluate` gives `error`. `has(item.missing)` is `false`.
- `@marcbachmann/cel-js` and `cel-js` (ChromeGG): not measured. Neither is installed in the repository, and the trial
  did not record it.

## The pick: `@bufbuild/cel` 0.6.2

- It passes every case in the subset and fails only the backtick names, which are outside the subset.
- It is the only one of the three that gets error absorption, empty-list vacuity and integer overflow right. Those are
  the cases where a wrong answer would turn an uncertain claim into a pass or a fail.
- Its regular-expression engine is linear time and follows the RE2 syntax the spec names.
- It runs in a browser and a worker without a Node module.
- Its licences are permissive (below).

Costs, and what the kernel does about each:

- It is 0.x and marked beta, so a release may change behaviour. The dependency is pinned to the exact version, the
  library and version are exported as `CEL_LIBRARY` so a proof bundle can record them, and the conformance subset runs
  in CI so a change shows up as a failing case.
- It has no type checker. A rule that orders text against an integer (`'a' < 1`) is an evaluation error, which the
  kernel reads as `error`, not a load-time rejection; `==` and `!=` across types give `false` and `true`, as CEL
  defines. The kernel's own static checks cover the limits, the subset and the cost bound, and the cost bound takes a
  value read from a variable at the largest the input limits allow, since its type is not known.
- It installs `@bufbuild/cel-spec` (about 6 MB, the conformance data) as a runtime dependency. The kernel does not
  import it at run time; the subset file in the repository is a copy of part of its data.
- It rejects a `//` comment that has no newline after it, and has no backtick-quoted names. The subset excludes both.

The kernel's interface (`compile`, `evaluate`, `evaluateValue` in `src/kernel/cel.ts`) is the only place the library
is imported, so a later swap changes one file, and the conformance subset says whether the swap is safe.

## Licence evidence

Checked on the packages as installed (the `license` field of each `package.json`) and, for the three whose tarballs
carry no licence file, against the upstream repository's `LICENSE` file.

| Package | Version | Licence | Added to the lockfile for |
|---|---|---|---|
| `@bufbuild/cel` | 0.6.2 | Apache-2.0 | the library |
| `@bufbuild/cel-spec` | 0.6.2 | Apache-2.0 | a dependency of `@bufbuild/cel` |
| `@bufbuild/re2` | 0.6.2 | MIT | a dependency of `@bufbuild/cel` |
| `@bufbuild/protobuf` | 2.17.0 | Apache-2.0 AND BSD-3-Clause | a peer dependency of `@bufbuild/cel` |

All are permissive. `@bufbuild/cel`, `@bufbuild/cel-spec` and `@bufbuild/protobuf` publish no `LICENSE` file inside
their npm tarballs (`@bufbuild/re2` does); the licence is in the `package.json` of each and in the `LICENSE` file of the
upstream repositories (`bufbuild/cel-es`, `bufbuild/protobuf-es`). The notices are in [`NOTICE.md`](../../NOTICE.md).
The conformance data in `@bufbuild/cel-spec` is from google/cel-spec, also Apache-2.0.

## Re-running the trial

The data is google/cel-spec v0.25.1 as republished by `@bufbuild/cel-spec` 0.6.2 (`dist/esm/testdata/conformance.js`,
which exports `tests`, a tree of suites whose leaves hold each case as `original`).

1. In a scratch directory outside the repository: `npm init -y`, then
   `npm install @bufbuild/cel@0.6.2 @bufbuild/cel-spec@0.6.2 @marcbachmann/cel-js@8.0.0 cel-js@0.8.2`.
2. Walk the `tests` tree, and for each case evaluate `expr` with each library's own parse-and-evaluate call, binding
   the case's `bindings` converted from the suite's JSON form (an `int64Value` is a `bigint`, a `mapValue` a map).
3. Compare with `value` (equal in the suite's terms) or `evalError` (any error). Count the universe as the cases whose
   bindings and value are all JSON-expressible, and the subset as those the kernel's `checkStatic` accepts.

The vendored subset re-runs with `npx vitest run test/unit/kernel-cel-conformance.test.ts`.

## Open points

- A later version of `@bufbuild/cel` may add a type checker or backtick names; either would let the subset grow. That is
  a change to the subset document and the subset file, not to this pick.
- The suite's tests of the extension libraries (math, strings, encoders) were run but are not part of the subset;
  `normalize()` is the only extension Miqyas defines, and it has its own shared vectors
  (`test/vectors/normalize.json`).
