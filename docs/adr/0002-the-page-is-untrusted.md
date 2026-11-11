# The page is untrusted; what Miqyas may do to a target

Every page Miqyas reads is untrusted, Kahf's own apps included, because a page can address the agent or the judge
. So a model-judged pass counts only with a cited node that code matches to the assertion's quoted text or
`cite` locator. What Miqyas does to a target is fixed in code and never chosen by the model:
- the crawl never submits a form or presses a destructive control;
- active checks send inert probes only;
- the second account only reads.

Active checks run only on a test host, or on a host named with `--allow-host` whose owner has placed the token
Miqyas prints. Passive checks see only what a browser loads. `docs/threat-model.md` owns the limits, the
never-do list and the evidence rules.

## Considered options

- Trust Kahf's own apps: rejected, since the corpus has to prove the boundary holds against hostile pages.
- `--allow-host` alone as consent on a live host: rejected for active checks, because it would let Miqyas probe apps
  the person doesn't own.
