# The model binds a step once; code judges every run

Until now a model judged each plain-language assertion on every run, and a pass with nothing to cite counted on the
model's word. That verdict cost money each time, could differ between two runs of the same build, couldn't gate CI
without spending, and was only as strong as the judge. The model no longer judges at run time. The first time a plan
runs, the model binds each step: an action to the locator it used, an assertion to a claim (a rule over what the surface
observed) and the nodes that claim rests on. Code evaluates the claim, and the binding is written into the plan, where a
person reviews it once like any other diff. Later runs replay the bindings: the same every time, free, and identical in
CI.

- A binding counts at once when code can tie it to the assertion's own words: the quoted text or the `cite` locator
  appears in the claim. A binding with nothing to tie it to gives `unverified` until a person accepts it.
- A binding that stops matching is never repaired during a run. The step fails, and re-binding is its own command,
  whose diff a person sees.
- An assertion that can't be written as a rule, because it needs eyes, can be marked one by one for a model's opinion.
  Those passes are counted apart and never count toward ready.
- With no terminal, only bound plans run.

This tightens ADRs 0001 and 0002: a pass on the model's word alone no longer counts by default, and `--strict` goes
away because it is the default.

## Considered options

- Keep the run-time judge and make `--strict` the default: rejected. It still pays and varies on every run, and a plan
  still can't gate CI.
- Have the model write test code, as test generators do: rejected. Model output would become code that Miqyas runs,
  which the threat model forbids, and a claim in a small rule language can be checked for its tie to the assertion and
  for whether it can fail, where code can't.
- Repair a broken binding during the run: rejected. A tool that heals a failing test while it runs can heal away the
  bug the test was there to catch.

## Consequences

- A page can no longer forge a pass, because nothing the model says is a verdict. The worst a page can do is suggest a
  weak rule, which the tie to the assertion's words, the review and the sensitivity check exist to catch.
- Every pass records whether its claim was shown able to fail: it must not pass on an empty observation, and an
  assertion that already held before the action it follows is flagged.
- A bound plan is the regression test. Exporting it to Playwright Test is a translation.
- A plan's first run needs a model and a review, and a changed interface needs a re-bind that someone looks at.
- The published model number changes from "how well the cheapest tier judges" to "how often it binds correctly the
  first time".
