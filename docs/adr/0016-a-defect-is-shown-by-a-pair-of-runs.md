# A defect is shown by a pair of runs

Every verifier needs someone to say what correct is, and that is the part of verification that doesn't get done. Some
of it can't be avoided: behaviour that is wrong only because someone meant otherwise needs a written assertion. But
much of what matters is wrong whatever anyone intended, and each such case is a statement about two runs of the same
system: one account receiving what belongs to another, a server storing what its own form refuses to send, two
requests at once leaving a state neither order could, a failure leaving half a change. Miqyas's own oracles are these.
An experiment starts two runs from the same state that differ in exactly one thing (who asks, through which door, how
often, in what order, under what failure), and a law says how what they recorded must relate. A law is broken only
when the content shows it, with controls in the same experiment that the instrument worked.

We chose this as the core of what Miqyas finds by itself because it needs nothing written in advance, it can't be done
by any tool that looks at one run at a time, and a broken law comes with both runs recorded for anyone to re-check.

## Considered options

- Infer the target's rules from what most of its parts do, and report the parts that differ: tried, and rejected as a
  detector. On two real codebases none of the 70 exceptions read by hand was a defect: most were deliberate, the
  ranking did no better than chance, and a small application has too few peers for the counts to mean much. The
  published successes of this method are on very large codebases with the comparison chosen by hand. It is kept for
  two smaller jobs: a map of where each protection is missing, and the order in which to run experiments.
- Have a model read the code and say what looks wrong: rejected as the core. Nothing it says can be re-checked, and
  it differs from run to run. A model is used to propose paths to a state, never to decide.
- Decide by status code: rejected. Applications refuse with a 401, a 404, a redirect or a page that says so with a
  200, and answer a stranger with a 200 and nothing in it. Content decides.

## Consequences

- The application's own interface stands in for intent: what an identity can reach through its own pages is what the
  application says it may do. A product with no interface needs a declared schema or a role table instead.
- The laws are shipped claims with failing examples (ADR 0014). The ones in a profile gate a release; a broken law
  outside a profile is a finding.
- The report is a matrix of operations against axes, and coverage is cells tested over cells that apply. Some laws
  can only be shown to hold in a number of tries, and are reported as that.
- Most axes change state, so they run in a sandbox (ADR 0017). On a live host only what the gate allows is tested, and
  the rest is "can't tell".
- This is a design. One part was tried and failed; the rest is untested, and the engine page says so.
