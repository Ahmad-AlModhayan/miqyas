# Readiness checks are assertions in the ledger

A readiness check is an assertion Miqyas writes itself, judged by code into the ledger with one verdict and its
evidence, not a finding outside it. So "Grade 1: ready" carries the same proof as a plan: every check in the
profile has a recorded pass. A check passes only when it met its declared minimum coverage and found nothing; a check
that couldn't run, or fell short of its coverage, is `not_checked`, and the profile is not ready. The findings a check
turns up are its evidence and keep their source and severity; findings that belong to no check stay outside the
ledger, as before.

## Considered options

- Readiness as a list of findings, the way scanners report: rejected, because "nothing found" would then prove
  nothing, which is exactly the incumbent's gap.
