# Collectors record facts; one engine judges

Until now each readiness check gathered its own evidence and decided its own verdict in the same code. A pass could
exist with no stored evidence, coverage was a sentence, and the rule for "pass" lived in a dozen places. From here on
the two jobs are split. A collector (a surface worker, an adapter, a reader or a probe) only measures: it records typed
facts and never says pass or fail. A claim (a plan's assertion, a readiness check, an invariant, an imported test) is
data: the items it covers, what must hold for each, and the coverage it needs. One engine judges every claim, over a
set of facts that is fixed, closed and recorded before the judge runs, and in three values. A counterexample fails an
`every` or `none` claim at any coverage, a witness passes a `some` claim at any coverage, and every other pass needs
the coverage met. One fold turns verdicts into a result, and everything that can change the exit code is a claim.

We chose this because it is the only shape in which a verdict can be recomputed later from what was recorded (ADR 0007),
a new readiness check is a definition and no longer a change to the engine, and a missing or failed measurement can't
become a pass by accident.

## Considered options

- Keep checks as code that returns a verdict, and add evidence fields: rejected. Each one would still have to remember
  to store its evidence and enforce its coverage. The first thirteen each declared a minimum coverage that no code
  read.
- Let adapters and workers report a verdict of their own, as `miqyas-worker/1` allowed: rejected, because the proof
  would then be only as good as each tool's word.
- Judge a claim as soon as its facts arrive: rejected. A fact that arrives later, such as an error the page logs a
  moment after an action, would change the answer, and re-judging the finished record would then disagree with the
  run. A claim is judged once, when every collector that can add to its facts has closed.

## Consequences

- Evidence is no longer assembled by hand. It is the set of facts the judge read to reach the verdict.
- Miqyas enumerates what a claim covers and never takes it from a tool's report. A scanner that prints "no issues"
  proves nothing about what it scanned; the files, screens or tables Miqyas handed it do.
- A claim over no items is `not_checked`, with the reason "nothing to check", unless it says an empty set is a pass
  and its coverage rule establishes that the set really is empty.
- Logic too rich for a rule over items (attributing an error to a screen, checking that a history is linearizable)
  lives in derivations and checkers: pure, versioned code whose output is recorded as facts, in three values like
  everything else.
- The five verdict words stay, and the three kinds of "not known" are now split by who must act next. That moves one
  case: a tool that isn't installed, which ADR 0005 made `not_checked`, is `blocked`, because the person has to
  install it.
- Findings are recorded in the ledger, as facts. They still never carry a verdict, which is what ADR 0004 meant by
  keeping them outside it.
