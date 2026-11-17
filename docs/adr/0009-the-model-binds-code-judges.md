# The model binds a step once; code judges every run

Until now a model judged each plain-language assertion on every run, and a pass with nothing to cite counted on the
model's word. That verdict cost money each time, could differ between two runs of the same build, couldn't gate CI
without spending, and was only as strong as the judge. The model no longer judges at run time. The first time a plan
runs, the model binds each step: an action to the locator it used, an assertion to a claim (a rule over what the surface
recorded) and the nodes that claim rests on. Code evaluates the claim. The bindings go into a file beside the plan,
written only by a command a person runs, where they are reviewed once like a lock file. Later runs replay them: the
same every time, free, and identical in CI.

- A binding counts at once only when code has shown three things on the facts it was bound on: the claim holds the
  assertion's own words (its quoted text or `cite` locator); replacing those words with random text makes it stop
  passing; and it didn't already hold before the action it follows. A binding that asserts an absence must also fail
  when the item that would break it is inserted. Any other binding gives `unverified` until a person accepts it.
- A binding that stops matching is never repaired during a run. The step fails, and re-binding is its own command,
  whose diff a person sees.
- An assertion that can't be written as a rule, because it needs eyes, can be marked one by one for a model's opinion.
  Such a pass keeps the old guard (a cited node that code matches), is counted apart, and is never part of a profile.
- With no terminal, only bound plans run, and nothing is bound.

This tightens ADRs 0001 and 0002: a pass on the model's word alone no longer counts unless the person marked that
assertion for it, and `--strict` goes away because it is the default.

## Considered options

- Keep the run-time judge and make `--strict` the default: rejected. It still pays and varies on every run, and a plan
  still can't gate CI.
- Have the model write test code, as test generators do: rejected. Model output would become code that Miqyas runs,
  which the threat model forbids, and a claim in a small rule language can be tested for its tie to the assertion and
  for whether it can fail, where code can't.
- Count any binding whose claim contains the assertion's quoted text: rejected. A claim can contain the text and
  ignore it. The text has to change the answer.
- Write bindings into the plan file: rejected. A plan is something a person writes, and Miqyas doesn't rewrite it; a
  run writes nothing outside its own folder (ADR 0003).
- Repair a broken binding during the run: rejected. A tool that heals a failing test while it runs can heal away the
  bug the test was there to catch.

## Consequences

- No judge reads the page at run time, so a page can't talk one into a pass. What is left is a page steering the
  binder toward a weak claim, which the three tests and the review exist to catch, and the assertions a person marked
  for a model, which keep the old guards.
- An assertion is judged over every snapshot from its action until the page settles, so a message that shows briefly
  is caught, and an absence only passes once the page has settled.
- A bound plan is the regression test. Exporting it to Playwright Test is a translation.
- A plan's first run needs a model and a review, and a changed interface needs a re-bind that someone looks at.
- The published model number changes from "how well the cheapest tier judges" to "how often it binds correctly the
  first time", measured on pages where the assertion is true and twins where it is false.
