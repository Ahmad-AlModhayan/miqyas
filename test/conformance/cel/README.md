# CEL conformance subset

`subset.json` holds the part of the CEL conformance suite that falls inside the CEL subset Miqyas allows
([`docs/cel-subset.md`](../../../docs/cel-subset.md)). `test/unit/kernel-cel-conformance.test.ts` runs every case
through the kernel's own interface (`compile`, then `evaluateValue`) against the CEL library the kernel uses, so a
change of library or of version is checked against the same cases in CI.

## Source

- The suite: the `tests/simple/testdata` conformance tests of google/cel-spec, version 0.25.1.
- How it was obtained: the `@bufbuild/cel-spec` package, version 0.6.2, republishes that data as JavaScript. The cases
  were read from it and written out as JSON, with values in the suite's own JSON form (the protobuf JSON form of a
  CEL value, for example `{"int64Value": "3"}`).
- Licence: Apache-2.0, the licence of cel-spec. Its notice is in [`NOTICE.md`](../../../NOTICE.md).

The expressions, bindings and expected values are the suite's own and are not edited. The file holds 468 cases, in
the suite's order.

## How the subset was chosen

A case is kept when the whole expression is inside the allowed subset (types, operators, functions and macros named in
`docs/cel-subset.md`) and it can be run with plain JSON-shaped variables. The check for the first part is the same
`checkStatic` the kernel runs when it loads an expression; the second part is the list below.

A case is left out when it:

- uses a feature outside the subset: bytes, doubles, unsigned integers, timestamps and durations, protobuf messages,
  optional syntax (`.?`, `[?`), comments, `type()` and other functions that are not allowed;
- uses a backtick-quoted field name (the library does not parse them). A backtick inside a string literal is fine,
  and the `parse/string_literals` cases with one are kept: they show that the kernel's own tokenizer and the library
  read escapes and raw strings the same way;
- needs a type declaration, a container or a check-only run (the kernel has no type checker);
- binds a variable to a map whose keys are not text (a fact is JSON data, and JSON keys are text).

The cases that stay are the ones whose result the kernel relies on: integer arithmetic and overflow, comparisons,
logic with error absorption, lists, maps, strings, `matches`, and the macros.

## Updating it

Regenerate the file from the same package at a new version, and read the diff. A case that moves from passing to
failing is a decision about the library, not a reason to edit the file. The research note
[`docs/research/cel-library-2026-11.md`](../../../docs/research/cel-library-2026-11.md) records the numbers the
current pick was chosen on.
