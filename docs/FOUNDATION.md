# Miqyas foundation

The design everything else in Miqyas is built on: the data model, the algorithm that turns evidence into a verdict, the
record a run leaves, the one place every action passes, and the contracts for surfaces, plans, checks and agents.

| | |
|---|---|
| Status | Proposed, 2026-11-16. Becomes the contract when ADRs 0006 to 0012 merge. |
| Replaces | The Architecture section of the [charter](CHARTER.md), and §5.2 (worker protocol), §6 (data model) and §7 (architecture) of the [SRS](SRS.md). Where they disagree with this page, this page wins. |
| Reasons | [ADRs 0006 to 0012](adr/). This page says what and how; each ADR says why, once. |
| Words | [CONTEXT.md](../CONTEXT.md). |
| Research | [foundation-2026-11.md](research/foundation-2026-11.md): standards, libraries and prior art, with what was and wasn't verified. |

## 1. Why a new foundation

Miqyas promises proof of what it checked. The first version was built as a test runner that writes a report, and the
promise doesn't hold on that shape:

- A readiness pass kept no evidence. It was a sentence in `report.json`; the requests and responses behind it were gone.
- Nothing could be re-checked. No record was hashed or append-only, and the report was written once at the end, so a
  crash lost the run.
- Coverage was free text. Every check declared a minimum coverage, and no code read it.
- Readiness was one procedure of 2,400 lines. A new check meant editing it in six places.
- The surface contract was a browser: a screenshot and an accessibility tree. The worker protocol had no code using it.
- What Miqyas may do to a target was enforced by convention, at about six call sites.

Worth keeping, and kept: the rule that a model's pass counts only when code can check it, the single gate before every
model call, stable step ids, replay of recorded model answers, the host-ownership rules, the corpus and its score.

## 2. The model on one page

```
 run request: subjects, inputs, plans, profiles, grants, budgets
        │
        ▼
 ┌─ run engine ───────────────────────────────────────────────────────────────┐
 │  claims ──► what facts are needed ──► which collectors can record them      │
 │                                                                            │
 │  collectors ──(every action)──► GATE ──► target, model, tool, network      │
 │      │ facts                     │ effect records                          │
 │      ▼                           ▼                                         │
 │  LEDGER (append-only) + blobs by digest                                    │
 │      │                                                                     │
 │      ▼                                                                     │
 │  JUDGE: claim × facts → verdict        FOLD: verdicts → result             │
 └──────────────────────────────────────────────────────────────────────────┬─┘
                                                                            ▼
                    proof bundle ──► miqyas verify ──► reports, CI gate, attestation
```

Eight rules hold everywhere. Each later section applies them.

1. **A verdict is a pure function of recorded facts.** Nothing that touches a target or a model produces a verdict.
2. **Collectors measure and never judge.**
3. **Not known is not a pass.** A pass needs positive evidence at the coverage the claim declares.
4. **Every effect passes the gate.** No code holds a browser, a socket or a model client of its own.
5. **What a model produces is a proposal, and a proposal is data** that code evaluates and a person can review.
6. **A pass must be able to fail**, and Miqyas shows that it could.
7. **The record is append-only and addressed by content**, so it can be re-checked offline.
8. **Formats are the contract.** An implementation can be replaced; a bundle written today must verify in ten years.

## 3. Facts and collectors

A **fact** is one typed measurement. A **collector** is anything that records facts: a surface worker holding a live
session, an adapter running an existing tool, a reader parsing files, a probe sending requests. A collector never
writes a verdict, a severity decision or the word "pass" (ADR 0006).

```ts
interface Fact {
  kind: string;                    // "ui.snapshot", "http.exchange", "dep.advisory", ...
  v: number;                       // version of the kind's schema
  by: string;                      // collector or derivation, as id@version
  subject: string;                 // which subject it is about
  scope?: Record<string, string>;  // where: screen, route, file, table, session label
  effect?: number;                 // ledger position of the gate record that allowed the action behind it
  from?: number[];                 // for a derived fact: positions of the facts it was computed from
  body: Json;                      // small and schema-checked; integers and strings, no floating point
  blobs?: Record<string, { digest: string; size: number; mediaType: string }>;  // large payloads, by digest
  withheld?: string[];             // what was left out on purpose, and why
}
```

Three things record facts, in this order of trust:

- **Collectors** touch the world, through the gate. What they record can't be recomputed, only measured again.
- **Derivations** are pure, versioned functions from facts to facts: grouping requests into routes, matching known key
  formats, turning a console error into a finding. They can be re-run from a bundle and must give the same facts.
- **Checkers** are derivations for properties a rule over single facts can't express, such as an operation history
  being linearizable. A checker's result is a fact with three values, and "can't tell within the budget" is one of them.

A **finding** is a fact of kind `finding`: a problem no claim asked about, with a source (code, tool, model), a severity
and the facts it rests on. A model-proposed finding is `unconfirmed` until a derivation backs it. Findings never carry
a verdict.

Every collector ends by recording a `collection` fact: what it set out to cover, whether it finished (`complete`,
`partial`, `failed`), why it stopped, and its counts. Coverage rules read these.

**Miqyas enumerates; a tool only judges items.** The list of files, screens, tables or tests a claim covers comes from
Miqyas's own enumeration, recorded as facts, and never from a tool's report. A scanner's empty result means something
only next to the list of what it was handed and a record that it finished.

**Facts must be safe to keep.** The scrubber runs before a fact is recorded, not only before a model call. A value a
probe must not keep (a row's contents, a secret) is recorded as shape and count: the status, the column names, "at least
one row". The fact says what it withheld. Each kind declares whether its content may ever go to a model; repository
content never does (ADR 0003).

### Kinds in the foundation

| Kind | Recorded by | Holds |
|---|---|---|
| `ui.snapshot` | web worker; later mobile and desktop | URL, title, language, direction, viewport, whether it was truncated; the rendered nodes (role, name, state, text, box, whether rendered) and the screenshot as blobs |
| `ui.event` | web worker | a page error, a console error, a dialog |
| `ui.control` | crawl | one control tried: its label and whether anything changed, or that it was skipped as destructive |
| `http.exchange` | web worker, API worker | method, URL, status, selected headers, body digest or shape, who sent it (the page or a probe) and as whom (anonymous, account A, account B) |
| `asset` | web worker | one served artifact (bundle, source map, storage entry) as a blob |
| `a11y.violation` | axe adapter | rule, impact, the node |
| `repo.tree`, `repo.file` | repository reader | what was read: paths, the commit, whether the tree was dirty |
| `secret.match` | gitleaks adapter | rule, location, redacted |
| `db.table` | migrations reader | schema, name, whether row-level security is on |
| `dep.package`, `dep.advisory` | lockfile reader, osv adapter | a package and version; an advisory against it with its severity |
| `tool.run` | every adapter | the command, exit code, tool version, digests of what it was given, whether it finished |
| `test.case` | test-runner adapter | one test: id, status, attempts; plus the list of tests planned, recorded before the run |
| `collection` | every collector | see above |
| `finding` | derivations, adapters, agents | see above |

Kinds reserved for later surfaces, so the contract isn't shaped only by a browser: `process.result` (a command-line
program), `history.op` and `fault` (an engine under test), `signal.sample` (a control system).

## 4. Claims, the judge and the fold

A **claim** is one thing that must be true. A plan's assertion, a readiness check, an invariant and an imported test
are all claims, and one judge handles all of them. A claim is data (ADRs 0006 and 0011):

```ts
interface Claim {
  id: string; version: number; title: string;
  needs?: { inputs?: string[]; effect?: EffectClass; kinds: string[] };

  // either a combination of other claims ...
  all?: Claim[]; any?: Claim[];

  // ... or a rule over items
  quantifier?: 'every' | 'some' | 'none' | 'count';
  from?: string;      // the kind of fact the items come from
  each?: string;      // a list inside each fact to take items from (the nodes of a snapshot)
  where?: string;     // CEL over `item`: which items the claim is about
  holds?: string;     // CEL over `item`: what must be true of one
  count?: string;     // CEL over `n`, for quantifier "count"
  covered?: string;   // CEL over `ctx` and `n`: when the enumeration counts as complete
}
```

`where`, `holds`, `count` and `covered` are CEL expressions from a documented subset, evaluated with limits the engine
enforces (size, nesting, number of items, time). The engine does the quantifying; an expression sees one item.

### The judge

For each claim the judge selects the items, evaluates `holds` on each (true, false or error), evaluates `covered`, and
applies one table:

| Quantifier | `pass` when | `fail` when |
|---|---|---|
| `every` | no item fails or errors, and covered | some item fails |
| `some` | some item holds | no item holds or errors, and covered |
| `none` | no item holds or errors, and covered | some item holds |
| `count` | covered, and the count rule holds | covered, and it doesn't |

Anything else is not known. The asymmetry is deliberate: one counterexample settles an `every` claim at any coverage,
and one witness settles a `some` claim, but the absence of one means nothing until the enumeration was complete. A
combination uses the same three values: `all` fails if any part fails and passes only if every part passes; `any` is
the mirror.

An `every` claim over no items passes only when `covered` says the enumeration was complete, and the verdict is marked
`vacuous` so a report can say "nothing to check" in place of "checked and clean". A rule claim with no `covered`
expression is rejected when it is loaded.

"Not known" keeps its three words, split by who has to act next:

| Verdict | Meaning | Typical reasons |
|---|---|---|
| `blocked` | the person must supply something | an input, a secret, a flag, a tool that isn't installed |
| `not_checked` | Miqyas didn't establish it | coverage short, a collector failed, dropped for time or money, an expression errored |
| `unverified` | it looked like a pass, on a basis not yet accepted | a binding nobody reviewed and code couldn't tie to the assertion |

Each carries a typed reason and, where it applies, what to add. That list is computed from the claim's unmet `needs`;
nobody writes it by hand per check.

### Evidence

The evidence of a verdict is its read set: the facts the judge selected, the witnesses or counterexamples among them,
and the coverage rule with the values it saw. The engine records it; no check assembles it.

```ts
interface Verdict {
  claim: string;                 // id@version
  rule: string;                  // digest of the claim as evaluated; the claim itself is recorded once
  verdict: 'pass' | 'fail' | 'not_checked' | 'blocked' | 'unverified';
  reason?: string; add?: string[];
  items: { total: number; held: number; failed: number; errored: number };
  read: number[];                // ledger positions of the facts read
  shown: number[];               // counterexamples for a fail, witnesses for a pass
  coverage: { rule: string; met: boolean; saw: Json };
  vacuous?: boolean;
  basis: 'rule' | 'opinion';     // "opinion" only for an assertion marked for a model (§8)
  binding?: { by: string; status: 'accepted' | 'proposed'; anchored: boolean };
  sensitivity?: { shown: boolean; tried: string[] };   // §12
}
```

### The fold

One function turns verdicts into a result: any `fail` gives fail; otherwise anything not known gives not known;
otherwise pass; and an empty set never passes. A plan passes when the fold of its assertions passes and every action
was carried out. A profile is ready when the fold of its claims passes.

Everything that can change the exit code is a claim. `--fail-on high` adds the claim "no confirmed finding at or above
high". A crawl that stopped early isn't a special case in the report: it is coverage not met in the claims that needed
it. Exit codes follow the three values: 0 every claim passes, 1 some claim fails, 3 nothing fails but something is not
known or the run couldn't finish, 2 a usage or plan error.

## 5. The ledger and the proof bundle

A run writes a **proof bundle** as it goes (ADR 0007):

```
.miqyas/runs/<run id>/
  ledger.jsonl          append-only; one JSON record per line, written once
  blobs/sha256/ab/cd…   evidence too large for a record, named by its SHA-256
  checkpoint            written last: tree size and root hash; signature lines when signed
  report.md  report.json  report.html      views, regenerable from the ledger
```

Each line is `{"seq": n, "t": type, "at": time, "body": {…}}`. The record types:

| Type | Body |
|---|---|
| `run.open` | format and engine versions, the subjects with their digests, the inputs given, the grants, the environment class of each target, the budgets, the quote and the cap |
| `claim` | one claim definition as it will be evaluated, recorded once and referred to by digest |
| `effect` | one decision of the gate: what was asked, by which collector, allowed or refused, under which rule |
| `fact` | one fact (§3) |
| `proposal` | something a model produced: a binding, a crawl choice, a draft finding |
| `model.call` | the model asked, the digest of the scrubbed request, the answer, tokens and cost |
| `verdict` | one verdict (§4) |
| `run.seal` | the fold's result per plan and profile, and the counts |

Records refer to each other by position (`seq`). The leaves of a Merkle tree (RFC 9162) are the lines as stored:
`SHA-256(0x00 ‖ line)`. The `checkpoint` holds the tree size and root after the seal. Nothing is re-serialised to be
hashed, so no canonical form is involved.

A **subject** is the exact thing verified, by digest: a git commit, a build directory, a binary. A deployed URL can
change during a run, so its subject is the manifest of what was served (each same-origin asset's path and SHA-256), and
the bundle says that this is what it is. The strongest statement about a build comes from a sandbox run on that build.

### Verifying

`miqyas verify <bundle>` needs no target, model or network. It answers four questions and reports each apart:

1. **Intact?** Every line and blob matches the tree; the checkpoint matches; a signature, if present, is valid.
2. **Does the result follow?** The fold of the recorded verdicts equals the seal.
3. **Do the verdicts follow?** Each claim, re-judged from the recorded facts, gives the recorded verdict and read set.
4. **Do the derived facts follow?** With `--rederive`: derivations re-run to the same facts, and, where the tool is
   installed, a tool re-run on the stored inputs gives the same results.

What a bundle can't show is stated in every report: that a collector recorded the target faithfully, and, unsigned, who
made the bundle. The head is printed when a run ends so that it can be anchored outside the bundle's holder's control.

A run with no seal didn't finish. Its verdicts stand as recorded, its result is "couldn't finish", and it never passes.

Replay needs no separate file: `--replay <bundle>` answers model calls from the `model.call` records of an earlier run,
keyed as today, and fails closed on a miss.

### Exporting

`miqyas attest <bundle>` writes an in-toto Statement in a DSSE envelope (ADR 0012): the subjects by digest; a Miqyas
predicate with the verifier, the profile and its digest, each claim's verdict and coverage, and the ledger head; and
beside it a Simple Verification Result that existing policy engines read. `miqyas gate` checks such a statement against
what a release requires (this subject, this profile, ready, no older than a set age) without running anything again.

## 6. The gate

Everything Miqyas does to a target and everything that leaves the machine is an **effect**, and every effect passes
one gate (ADR 0008). The classes of effect, the classes of environment and the table that joins them are in the ADR.
This section is how it is built.

- **Capabilities.** A collector asks the gate for a scope: this target, up to this class. The gate answers with a
  scope or a refusal. The only way to act is through a client the gate made for that scope: an HTTP client, a browser
  session, a tool runner, a model client. A lint rule keeps `fetch`, sockets, child processes, browser drivers and
  model SDKs out of every other module.
- **Every decision is a record.** An `effect` record says what was asked, who asked, the rule that decided, and
  whether it was allowed. A bundle therefore shows all Miqyas did to a target, including what it refused to do.
- **Environment classes are established, not claimed.** A sandbox is one the engine started in this run. A test host
  is recognised by name. An owned host has passed the token check. A plan file, a page, a model or a caller without a
  person can never raise a class or add a grant.
- **The never-do list is deny rules** that no grant overrides, each with an id and a test: leave the origin; act above
  observe on a host that is neither sandbox, test nor owned; brute-force a login; get past a CAPTCHA or a firewall;
  upload a file no plan names; run page or model output as code; send page data anywhere but a scrubbed model call;
  type a secret the step doesn't name; write to or disrupt a live physical process.
- **Rates and stops.** The gate owns each target's request rate (2 a second by default) and the stop rule: the first
  429 or 503 ends everything code chose to send to that target, and the affected claims get coverage not met.
- **What leaves the machine.** A model call passes the same gate: scrub, re-scan, a pessimistic cost estimate against
  the cap, then a `model.call` record. A network fetch is allowed only to a named command such as `update-db`. A tool
  runs with fixed arguments on paths Miqyas chose. Nothing is written outside the run folder.
- **Consent is a typed question only a person can answer.** The spend cap is asked through the control protocol (§13),
  and only an interactive client can answer. With no person there is no billed model call, as before (ADR 0001).
- **A worker in its own process** is held to the gate by a proxy that the engine runs and the worker must use. A worker
  that can't be proxied gets nothing above observe.

## 7. Surfaces and the worker protocol

A **surface** is the set of fact kinds a worker can record and the action kinds it can take (ADR 0010). The engine
knows nothing else about it.

`miqyas-worker/2` is JSON-RPC 2.0 as newline-delimited JSON over standard input and output; logs go to standard error.
Every request carries the protocol version in `_meta`.

| Method | Purpose |
|---|---|
| `discover` | versions spoken, the surface's name, each action kind with its parameter schema and effect class, each fact kind with its version, how the worker is held to the gate, its limits |
| `open` | start a session on a subject; the engine passes the folder for blobs and, if needed, the proxy to use |
| `act` | take one action in a session; the request names the gate record that allowed it; the answer is the facts that resulted |
| `observe` | record the named kinds now |
| `close` | end the session |
| `fact` (notification, worker to engine) | something that happened by itself: a console error, a request the page made |

A worker writes large payloads into the blob folder and returns digests. There is no message that carries a verdict.
The same contract is used in process, as plain calls, for the workers that ship with Miqyas.

**Two surfaces ship with the foundation**, so the contract is shaped by more than one:

- **web**: Playwright Chromium. Actions: navigate, click, fill, select, press, scroll, wait. Facts: `ui.snapshot`,
  `ui.event`, `ui.control`, `http.exchange`, `asset`, `a11y.violation`. The crawl is a collector built on it.
- **api**: an HTTP client with named sessions (anonymous, account A, account B). One action, `request`, whose effect
  class the probe declares and the gate checks. Facts: `http.exchange`. The backend, access and parameter probes
  behind checks 8 to 12 become collectors on it.

Next comes the **engine-scenario** surface: a seeded schedule, a fault plan, a recorded history of operations (invoked,
ok, failed, and "don't know" for a call that timed out), and checkers over that history. It is the surface least like
a browser, and it is where `disrupt` is first used, always in a sandbox.

**Adapters** stay as ADR 0005 defines them, and become collectors: each records a `tool.run` fact (command, exit code,
version, digests of what it was given, whether it finished) and the tool's results as facts. Two general adapters read
standard formats (ADR 0012): SARIF 2.1.0 into `finding` and `tool.run`, and JUnit XML into `test.case`. A thin adapter
per tool remains for what a format can't say.

## 8. Plans and bindings

A plan keeps its two step types and its stable ids. `miqyas-plan/2` separates what a person wrote from what it was
bound to (ADR 0009):

```json
{ "format": "miqyas-plan", "version": 2, "id": "wasl-03-add-pair-validation", "surface": "web",
  "name": "Adding a folder pair with nothing filled in lists what is missing",
  "steps": [
    { "id": "s1", "type": "action", "text": "Click 'Add folder pair'",
      "binding": { "by": "model", "status": "accepted",
                   "do": [ { "tool": "click", "locator": { "role": "button", "name": "Add folder pair" } } ] } },
    { "id": "a1", "type": "assertion", "text": "An error list says what is missing",
      "binding": { "by": "person", "status": "accepted",
                   "claim": { "quantifier": "some", "from": "ui.snapshot", "each": "nodes",
                              "where": "item.role == 'alert' && item.rendered",
                              "holds": "item.text.contains('required')", "covered": "!ctx.truncated" } } },
    { "id": "a2", "type": "assertion", "text": "The chart looks right", "judge": "model" } ] }
```

- The **text** is the intent, and never changes when the product's interface does.
- The **binding** is what the text compiled to: for an action, the concrete steps with role-and-name locators; for an
  assertion, a claim. It records who made it, whether a person accepted it, and the text it was made for; a binding
  made for different text is stale.
- A version 1 plan loads as it is: its `check` becomes an accepted binding and its `cite` constrains the binder.

**Binding** happens once, with a model. The binder sees the step and the current snapshot and answers in a narrow
schema: for an action, a choice among the controls code listed; for an assertion, a claim and the nodes it rests on.
Code then does all of this before the binding is used:

1. Evaluate the claim on the snapshot taken at the assertion's position, before the next action.
2. Check the witnesses are among the items the claim selected.
3. **Anchor** it: every quoted string in the assertion appears as a literal in the claim, and a `cite` locator is
   implied by `where`. An assertion with neither quoted text nor `cite` can't be anchored.
4. Run the sensitivity tests of §12 and record the result.

An anchored binding counts at once. An unanchored one gives `unverified` where it would have passed, until a person
accepts it (`miqyas accept`, or by editing the plan). A fail counts either way: it costs a look, not trust.

**Running** replays bindings. A locator must resolve to exactly one rendered element; if it doesn't, the action failed
and the plan fails. Nothing is repaired during a run. `miqyas bind` re-binds with a model and shows the diff.

| Situation | What a run does |
|---|---|
| every step bound | runs with no model, at no cost, the same every time; this is the only mode with no terminal |
| some step unbound, a person present and a cap typed | binds it, records the proposal, applies the rules above |
| some step unbound, no person | that step and what follows it are `blocked` |
| an assertion marked `"judge": "model"` | a model judges it each run, citing nodes; a pass has basis `opinion`, is counted apart and never counts toward ready; with no model it is `blocked` |

## 9. Readiness: profiles and checks as claims

A **readiness check** is a claim Miqyas ships (ADR 0004 stands). A **profile** is a versioned file naming claims, each
with a pillar and a priority. Adding a check or a profile adds files; it doesn't change the engine. A company's own
profile is the same kind of file.

The thirteen Grade 1 checks, restated as collectors, facts and a claim. Their pass and fail rules don't change; where
porting exposes a difference from today's verdict, the port lists it and it is decided there.

| # | Collectors | Items | Claim | Covered when |
|---|---|---|---|---|
| 1 | crawl | screens | every screen has no page error, uncaught console error or same-origin 5xx | at least one screen, and the crawl wasn't stopped early |
| 2 | crawl | controls tried | every control changed something; destructive ones are listed as skipped | at least one control tried |
| 3 | plan runner on the built-in templates | the templates' assertions | all pass | both templates ran to the end |
| 4 | crawl, axe adapter | violations | none is critical or serious | axe finished on every screen reached |
| 5 | crawl, gitleaks adapter | matches in served assets, URLs, DOM, storage | none is a known key format | every asset recorded was handed over, and the tool finished |
| 6 | repository reader, gitleaks adapter | matches in files and history | none is a known key format | working tree and history both scanned |
| 7 | migrations reader | public tables | every one has row-level security on | every migration file parsed |
| 8 | backend detection, API probe | tables read with the public key | none returns rows | every backend detected was probed |
| 9 | API probe as the second account | records the first account owns | none is readable | at least one record replayed |
| 10 | API probe with no session | routes seen behind log-in | every one refuses | at least one route replayed |
| 11 | API parameter probe | parameters seen | none reflects the marker unescaped or redirects to it | at least one parameter probed |
| 12 | API probe with no session | routes that spend money | every one refuses | every such route replayed |
| 13 | lockfile reader, osv adapter | advisories | none is critical, high or malicious | every lockfile found was scanned against a present database |

The drop order under a time limit is no longer a list in code: each claim has a priority, and §10 uses it.

## 10. The run engine

A run goes through six stages. The first three touch nothing and make up `--dry-run` and the quote.

1. **Resolve.** Collect every claim: the plans' assertions, the profiles' claims, and the claims flags add.
2. **Match.** For each claim, find the facts it needs and the collectors that can record them, following what those
   collectors need in turn. A claim whose needs can't be met (an input, a grant, a tool) is settled now as `blocked`,
   with what to add.
3. **Budget.** Estimate time and money. If the time limit can't hold everything, drop the collectors that serve only
   the lowest-priority claims; those claims become `not_checked`, dropped for time.
4. **Collect.** Run collectors as a graph: independent ones in parallel, each target's rate held by the gate, a
   timeout on each. A collector that fails leaves facts missing, and by rule 3 a missing fact can't make a pass.
5. **Judge.** Judge each claim as soon as its facts are in. A plan's assertion is judged at its position, on the
   snapshot taken before the next action.
6. **Seal.** Fold, write the seal and the checkpoint, print the head, render the reports.

The ledger is also the event stream: a client that follows a run reads the records as they are appended.

The engine is deterministic given a request and the facts. What varies lives in two places, both recorded: the target,
in facts, and the model, in `model.call` records.

## 11. The agent team

Agents propose; code disposes. An agent is a role with a narrow answer schema, no capability, and a share of the cap.
Its answer is a `proposal` record, checked by code before anything comes of it, and it is never a verdict.

| Role | Proposes | What code does with it |
|---|---|---|
| Binder | a binding for a step | §8. This is the only role the foundation builds. |
| Cartographer | which control or route to try next, from a list code built | carries it out through the gate; the map of the target grows from the facts |
| Author | a plan, from the map and a description a person supplies | lints it; a person reviews it; it is bound like any plan |
| Prober | a hypothesis ("this route may leak that") | maps it onto a probe template code already has; in a sandbox, may be a request of its own |
| Fault planner | a schedule of faults for a scenario | stores it as data and runs it deterministically, in a sandbox |
| Triager | a draft finding or a suspected cause | records it as `unconfirmed`, labelled as a model's judgement |

The engine chooses when to ask which role, by what would add the most coverage for the money. Agents don't talk to
each other; they read the same facts.

## 12. How Miqyas measures itself

Three layers, from cheapest to strongest. None is called recall: each is evidence that a check can fail.

1. **Sensitivity, on every pass, offline.** The judge re-evaluates a passing claim on edited copies of the facts it
   read and records what happened:
   - an `every` claim must not pass on no items unless its coverage rule allows that;
   - a `some` claim is flagged when its rule matches most of what was observed, because it then says little;
   - an assertion that already held before the action it follows is flagged, because it isn't testing the action;
   - each shipped claim carries examples that must give pass, fail and not known, run by `miqyas selftest`.
2. **Mutation in a sandbox.** For each bound assertion Miqyas breaks the thing its witness rests on in a served copy
   (hides it, changes its text, removes it), confirms with a code probe that the break took effect, and re-evaluates
   the bound claim, which must now fail. Bound plans need no model, so this costs nothing to repeat. Presets of
   hand-picked mutations remain for breaks that no witness points at.
3. **Planted defects, per release.** Every shipped claim has at least three seeds it must catch and a clean twin it
   must stay quiet on, scored per part and never blended. A release's corpus run is itself a proof bundle.

## 13. Entry points

There is one engine and one **control protocol** to it, in the same JSON-RPC shape as the worker protocol: start a
run, follow its records, answer a consent question, fetch the result. Every entry point is a client.

| Entry point | What it is |
|---|---|
| CLI | a thin client that starts the engine as a child process; the only client that can answer a consent question |
| CI gate | the CLI with no terminal: bound plans, replays, unbilled local models; or `miqyas gate` on a bundle made earlier |
| MCP | a client that exposes runs and results as tools; it returns results, never instructions, and can't widen a run |
| Self-hosted | the same engine kept running behind the same protocol, with a queue and a store of bundles; later |

## 14. Layout and licences

```
src/kernel/      ledger, blobs, checkpoint, claim schema, judge, fold, sensitivity, verify, statement builder
src/protocol/    worker protocol, control protocol, fact kind schemas
src/scrub/       the scrubber
src/surfaces/    web and api workers
src/gate/        the gate: classes, rules, scopes, spend, consent
src/engine/      resolve, match, budget, collect, replay; derivations and checkers
src/collectors/  adapters, readers and probes
src/claims/      shipped claims and profiles, as data
src/agents/      model providers and roles
src/bench/       corpus, score, mutation
src/entry/       the engine process and the control protocol server
src/cli.ts       the thin client
```

The kernel has no dependency but the CEL library and does no input or output except through a store it is handed, so
it also runs in a browser and can be ported. Imports go one way, top of this list to bottom never upward, and the lint
that checks it also keeps I/O libraries inside `gate/` and `surfaces/`.

Licences follow [OPEN_MODEL.md](OPEN_MODEL.md). Which licence the kernel carries is open (§18).

## 15. Migration

The new foundation is built beside the old code and takes over one piece at a time.

1. **Kernel first**, with one check end to end through the new path behind a flag: facts, a claim, the judge, the
   ledger, `verify`.
2. **The gate**, then every collector moved behind it.
3. **Web and API workers** on the new contract, recording facts.
4. **The thirteen checks ported one by one.** While both exist, the old implementation is the oracle: old and new
   verdicts on the fixtures and the corpus must agree, or the difference is written down and decided.
5. **Plans**: version 2, the binder, replay.
6. **Reports** rendered from the bundle.
7. **Delete** the old orchestrator, `readiness.ts`, `miqyas-worker/1`, and `report.json` as the source of truth.

Before early access: steps 1 to 4, 6, and plan version 2 with bound replay. After it: sandbox mutation, attestation and
`gate`, the SARIF and JUnit adapters, the engine-scenario surface, workers in their own process, MCP, the wider agent
team.

## 16. Tests

- **The seam stays the CLI run on fixtures**, with scanner shims on the path, scripted and replay agents, no network.
- **The kernel is tested as pure functions**: claims and facts in, verdicts out, for every row of the judge's table and
  every kind of "not known"; a tampered bundle must fail each of `verify`'s questions.
- **Each claim ships its own examples** for pass, fail and not known.
- **The gate has one test per never-do rule** and one per cell of the effect table.
- **A worker conformance suite** runs any worker through the protocol and checks the facts against their schemas.
- **The CEL conformance suite** runs in CI against the library in use.
- **Old against new**, until the old is deleted.

## 17. Out of scope here

Each of these gets its own spec on this foundation: the engine-scenario surface; Tauri, Android and command-line
surfaces; the MCP entry point; the self-hosted service; the agent roles other than the binder; Grades 2 and 3; exports
to Playwright Test; signing beyond what §18 settles.

## 18. Open

- **The kernel's licence.** A bundle that anyone can check argues for the kernel, the formats and `verify` under
  Apache-2.0, with the engine, claims, collectors, agents and corpus staying AGPL-3.0-only.
- **Who signs a bundle.** The proposal: Miqyas never creates or stores a key. It signs with an Ed25519 key the person
  points it to through the environment, or writes the statement for an outside signer.
- **The CEL library.** Chosen by a spike that runs the conformance suite on the candidates.
- **The predicate type's address.** Fixed when the export is built, because it can't change afterwards.
- **What a caller without a person may ask for.** An MCP client can't add a grant; whether a file a person wrote can
  grant one in advance is decided in the MCP spec.
