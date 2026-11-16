# Collectors record facts; one engine judges

Until now each check gathered its own evidence and decided its own verdict in the same code. A pass could exist with no
stored evidence, coverage was a sentence, and the rule for "pass" lived in a dozen places. From here on the two jobs are
split. A collector (a surface worker, an adapter, a reader or a probe) only measures: it records typed facts and never
says pass or fail. A claim (a plan's assertion, a readiness check, an invariant, an imported test) is data: the items it
covers, what must hold for each, and the coverage it needs. One engine judges every claim from the recorded facts, in
three values: a counterexample fails a claim at any coverage, a pass needs the coverage met, and anything else is not a
pass. One fold turns verdicts into a result, and everything that can change the exit code is a claim.

We chose this because it is the only shape in which a verdict can be recomputed later from what was recorded (ADR 0007),
a new check is a definition and no longer a change to the engine, and a missing or failed measurement can't become a
pass by accident.

## Considered options

- Keep checks as code that returns a verdict, and add evidence fields: rejected. Each check would still have to remember
  to store its evidence and enforce its coverage. The first thirteen checks each declared a minimum coverage that no
  code read.
- Let adapters and workers report a verdict of their own, as `miqyas-worker/1` allowed: rejected, because the proof
  would then be only as good as each tool's word.

## Consequences

- Evidence is no longer assembled by hand. It is the set of facts the engine read to reach the verdict.
- Miqyas enumerates what a claim covers and never takes it from a tool's report. A scanner that prints "no issues"
  proves nothing about what it scanned; the files, screens or tables Miqyas handed it do.
- An empty set of items passes only when the claim's coverage rule says the enumeration was complete, and the report
  marks it as nothing to check.
- A check that needs an order or a history (linearizability, isolation anomalies) can't be written as a rule over single
  facts. A trusted, versioned checker runs over the recorded history and records its result as a fact, in three values
  like everything else.
- The five verdict words stay. `not_checked`, `blocked` and `unverified` are the three kinds of "not known", each with
  a typed reason.
