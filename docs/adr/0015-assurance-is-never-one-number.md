# Assurance is recorded per claim and never blended into one number

A pass from a run of thirteen readiness checks, a pass from a property a model checker explored to a bound, and a pass
from a proof are different things, and so are a pass over fifty screens and a pass over two. Tools flatten all of this
into a score or a badge, and the score is what gets trusted. Miqyas records, for every verdict, what stands behind it,
and never combines the parts:

- its **coverage**: what was enumerated, by what, against which denominator, and whether the claim's coverage rule was
  met;
- its **kind of assurance**: `tested` (it held on the executions observed), `bounded` (a tool checked every case up
  to a stated bound), or `proved` (a tool proved it for every case);
- its **depth**: how far the verdict can be re-checked from the bundle (ADR 0007);
- for a statistical claim, its **confidence** and the number of samples;
- how it was **seen to fail** (ADR 0014).

A profile is ready when every claim in it passes. Beyond that one word, a report shows the record per claim, and there
is no score out of a hundred, no percentage of readiness and no grade Miqyas awards.

## Considered options

- A weighted score: rejected. Any weighting lets a strong result in one place hide a missing one in another, which is
  the failure Miqyas exists to prevent, and the weights would be ours, not the reader's.
- One coverage percentage: rejected. Coverage has a different denominator in each space (screens, routes, inputs,
  configurations, faults, code), and a percentage of one says nothing about another. Code coverage in particular is a
  weak predictor of what a suite catches.
- Treat every pass alike: rejected. It makes a tested claim look like a proved one.

## Consequences

- Evidence from tools that explore exhaustively or prove (model checkers, provers) enters through adapters like any
  other, and is the only source of `bounded` and `proved`.
- Estimates are labelled as estimates, with their assumptions: how likely one more step of a crawl is to find a new
  state, or the upper bound on a failure rate after a number of clean runs.
- A profile is also an assurance case in the usual sense: a claim at the top, the claims that support it, the evidence
  under each, and what was assumed. It can be exported as one.
