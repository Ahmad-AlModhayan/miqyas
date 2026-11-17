# Miqyas builds what finds and what judges; it borrows only what carries out or looks up

ADR 0005 made Miqyas a layer over existing runners and scanners, with a check of its own only where no tool fitted.
The design since then (ADRs 0006 to 0018) rests on parts no outside tool hands over: restoring a target's state,
running pairs of runs that differ in one thing, comparing them by content, judging with a pure function, and keeping
a record anyone can re-check. A result other tools can't give has to come from work other tools don't do. So the
default is turned around, and sorted by the kind of work:

- **Judging is Miqyas's own**: the judge, the fold, the record and the gate. No outside tool's "pass" is a verdict.
- **Finding by experiment is Miqyas's own**: reaching a state, capturing and restoring it, choosing what to send,
  ordering and failing what is sent, comparing what came back, shrinking a failure. These are capsules, explorers,
  the experiment engine, the oracles and diagnosis, with the workers, proxies and probes that carry them out.
- **Carrying out is borrowed, as substrate**: the browser and the library that drives it, the database a target
  keeps its state in, the operating system, hash functions, a CEL library. A target runs on the real ones, and a
  published standard is easier for anyone else to check than something of Miqyas's own.
- **Looking up is borrowed, behind adapters**: whether a string is a known key format, a version is in an advisory
  or a node breaks an accessibility rule is a question for a catalogue many people keep. A project's own tests,
  model checkers and provers come in the same way. ADR 0005 still describes how.

A run with no outside tool installed still produces the matrix (ENGINE §4).

## Considered options

- Keep ADR 0005's default: rejected. It was right for checks that look something up, and it stays for them. As the
  rule for the whole product it leaves Miqyas only as strong as the tools it runs: it can find what they find, state
  the coverage they report, and fix none of their misses. ADR 0012 had already stopped taking a tool's word for what
  it covered.
- Build everything, the substrate included: rejected. A browser or a database of Miqyas's own would test a target on
  something it doesn't run on. A hash function or a rule language of its own would make a bundle harder for a second
  verifier to check (ADRs 0007 and 0011).
- Rewrite the catalogues now: rejected. A list of advisories, key formats or accessibility rules is worth what its
  upkeep is worth, and many people keep these. Code of Miqyas's own that reads the same list can take an adapter's
  place under the rule below.
- Decide tool by tool, with no rule: rejected. Every new need would reopen the question. Sorting by the kind of work
  answers it once.

## Consequences

- When a new need appears, the first question is which kind of work it is. Finding and judging are built; nothing is
  wrapped to do them.
- FOUNDATION §7 lists everything borrowed, as substrate or as an outside tool, with the reason.
- Substrate sits behind one interface, and its version is recorded in the bundle wherever it can change a verdict,
  as ADR 0011 already requires of the CEL library. Swapping it must not change a verdict.
- An outside tool adds facts and decides nothing. Its coverage is taken from what Miqyas handed it (ADR 0012), a
  missing tool makes its checks `blocked` (ADR 0006), and a verdict that rests on one says what kind of evidence the
  tool gives (ADR 0015). No law of the experiment engine rests on an outside tool's facts.
- Miqyas's own code takes the place of something borrowed only by measurement, and the change that proposes it names
  the measurement first. For a tool that finds things, that is the corpus and the real defects of ADR 0018, per axis.
  For substrate, it is the worker conformance suite and old against new on the fixtures. If Miqyas's own does at
  least as well, it takes the place; if not, it is dropped.
- This is more to build than ADR 0005 allowed for, and that cost is accepted. The order of building (MAP §6) bounds
  it: a part is built when a step needs it.
- ADR 0005's consequences for adapters stand: tools the person installs, recorded-output shims in tests, and a
  licence check and a notice for each tool.
