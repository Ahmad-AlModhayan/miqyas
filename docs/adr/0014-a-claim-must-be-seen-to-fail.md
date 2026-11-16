# A claim must be seen to fail before it may pass

A check that can't fail proves nothing, and nothing in a passing report distinguishes it from one that can. The usual
answer is to measure this afterwards, with mutation testing, and report a score. Miqyas makes it a condition instead:
no claim contributes a pass until it has been seen to fail.

- A claim Miqyas ships carries, in its own file, facts that must give a pass, facts that must give a fail and facts
  that must give "not known". A claim file with no failing example isn't loaded.
- A binding is tested on the facts it was bound on before it counts (ADR 0009): with its anchored text replaced, it
  must stop passing; it must not have held before the action it follows; an absence must fail when the item that
  would break it is inserted.
- A claim a person writes by hand is held to the same tests when it is linted.

A claim that can't be shown to fail gives `unverified`. Because the judge is a pure function of recorded facts (ADR
0006), these tests run on the record: they cost nothing, and anyone can repeat them from a bundle.

## Considered options

- Report it as a flag beside the verdict: rejected. A flag that doesn't change the result is read by nobody, and a
  claim that passes whatever the page says would count toward ready.
- Rely on mutation of the target alone: rejected as the only guard. It needs a build Miqyas can serve and break, it
  can't perturb what an absence rests on, and it runs after the pass was already given. It stays, as the stronger
  second layer.

## Consequences

- This shows that a claim is sensitive to what it reads. It doesn't show that Miqyas finds every real defect, and no
  document calls it recall.
- The failing example proves the rule can fail, not that the collector sees the world as it is. That is what planted
  defects with clean twins are for, per release.
- The examples can share their author's blind spot. The corpus is written apart from the claims for that reason.
