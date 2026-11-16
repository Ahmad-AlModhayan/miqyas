# Four shapes of claim

A rule over single items can say that every table has row-level security on. It can't say that one user must not read
what another reads, that an error never appears between a click and the page settling, or that ninety-five in a
hundred requests answer within a second. Those are different kinds of statement, and a verifier that can only make the
first kind either pushes the rest into code nobody can re-check or doesn't make them at all. Miqyas's claims have four
shapes, and every shape gives the same three values:

- **set**: every, some or none of a set of items hold a rule, or their count does.
- **pair**: every, some or none of the pairs of items joined on a key hold a rule. This is the shape of a statement
  about two runs or two users, which no statement about one run can express.
- **trace**: over the events of one session in order, something never happens, always holds, exists, comes before
  something else, or follows it within a bound.
- **sample**: a proportion or a quantile of numeric measurements meets a bound at a stated confidence.

We chose these four because each is the smallest form of a well-understood class of property (state predicates,
relations between executions, bounded temporal patterns, statistical bounds), each has a natural "can't tell yet", and
together they cover what readiness checks, plan assertions, invariants and imported tests need without a general
programming language.

## Considered options

- One shape, with derivations doing the pairing, ordering and counting: rejected. The decisive logic would move out of
  the claim, where it is data anyone can read, into code, and the claim would become a formality over a field named
  `ok`.
- A full temporal logic for traces: rejected for a fixed list of patterns with bounds. The patterns cover what is
  asked in practice, a bound makes each one decidable on a finite recording, and a person can read them.
- Treat statistical statements as set claims over an average: rejected. An average hides the tail, and a bound with no
  confidence says nothing about how many samples stand behind it.

## Consequences

- A trace claim on a recording that ended early is "can't tell", never a pass: whether an obligation left open at the
  end counts as broken depends on whether the session finished or was cut off.
- A sample claim has three outcomes by construction: the bound is met with confidence, missed with confidence, or
  there aren't enough samples yet. The number of samples is fixed before the run, so looking early can't bias it.
- A plan's assertion is a trace claim over the snapshots between its action and the page settling.
- Properties these shapes can't express (linearizability, isolation anomalies) stay with checkers (ADR 0006).
