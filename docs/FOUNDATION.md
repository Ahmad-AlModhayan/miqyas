# Miqyas foundation

The architecture everything else in Miqyas is built on: the data model, how evidence becomes a verdict, the record a
run leaves, the one place every action passes, and the contracts for surfaces, plans, checks and agents.

| | |
|---|---|
| Status | Proposed, 2026-11-16. Becomes the contract when ADRs 0006 to 0019 merge. |
| Read with | [MAP.md](MAP.md): the whole system on one page and why it is built this way. [ENGINE.md](ENGINE.md): the experiment engine, which finds what nobody asked to be checked. [ALGORITHMS.md](ALGORITHMS.md): every function and formula named here, numbered. |
| Replaces | The Architecture section of the [charter](CHARTER.md), and §5.2 (worker protocol), §6 (data model) and §7 (architecture) of the [SRS](SRS.md). It changes three lines of the [threat model](threat-model.md), listed there. Where an older document disagrees with this page, this page wins. |
| Reasons | [ADRs 0006 to 0019](adr/). This page says what and how; each ADR says why, once. |
| Words | [CONTEXT.md](../CONTEXT.md). |

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

## 2. The rules

Ten rules hold everywhere. Each later section applies them, and each is something code enforces, not a convention.

1. **A verdict is a pure function of recorded facts.** Nothing that touches a target or a model produces a verdict.
2. **Collectors measure and never judge.**
3. **The set of facts a claim is judged over is fixed, closed and recorded** before the judge runs.
4. **An absence is never a pass without coverage.** A counterexample or a witness settles a claim; not finding one
   settles nothing until the enumeration was complete.
5. **A claim must have been seen to fail before it may pass.**
6. **Every effect passes the gate**, which decides at the wire, per request, and never takes a caller's word for what
   an action is.
7. **What a model produces is a proposal, and a proposal is data** that code evaluates and a person can review.
8. **The record is append-only and addressed by content**, so it can be re-checked offline.
9. **Every verdict says how far it can be re-checked**, and how strong the kind of evidence behind it is.
10. **Formats are the contract.** An implementation can be replaced; a bundle written today must verify in ten years.

The picture of how the parts fit is in [MAP.md](MAP.md).

## 3. Facts and collectors

A **fact** is one typed measurement. A **collector** is anything that records facts: a surface worker holding a live
session, an adapter running an outside tool, a reader parsing files, a probe sending requests. A collector never
writes a verdict, a severity decision or the word "pass" (ADR 0006).

```ts
interface Fact {
  kind: string;                    // "ui.snapshot", "http.exchange", "dep.advisory", ...
  v: number;                       // version of the kind's schema
  by: string;                      // collector or derivation, as id@version; the engine records what it started
  run: number;                     // which attempt of that collector, when it was retried
  subject: string;                 // which subject it is about
  origin?: string;                 // the origin it was observed at, for facts about network traffic
  place?: Record<string, string>;  // where it was measured: screen, route, file, table, session label, step
  effect?: number;                 // ledger position of the gate record that allowed the action behind it
  cause?: 'page' | 'plan' | 'probe' | 'crawl';   // who caused the traffic or change this fact records
  from?: number[];                 // for a derived fact: positions of the facts it was computed from
  body: Json;                      // small and schema-checked; integers and strings, no floating point
  blobs?: Record<string, { digest: string; size: number; mediaType: string }>;  // large payloads, by digest
  withheld?: string[];             // which fields were left out on purpose, and why
}
```

Three things record facts, in this order of trust:

- **Collectors** touch the world, through the gate. What they record can't be recomputed, only measured again.
- **Derivations** are pure, versioned functions from facts to facts: grouping requests into routes, attributing an
  error to a screen, pairing a request with its replay. They can be re-run from a bundle and must give the same facts.
  A derivation ships with examples of its own, like a claim does.
- **Checkers** are derivations for properties a rule over items can't express, such as an operation history being
  linearizable. A checker's result is a fact in three values, and "can't tell within the budget" is one of them.

Rules every collector follows:

- **Raw first.** A collector records what it measured, and leaves deciding to a derivation or a claim. Where a
  collector must decide something itself because the data can't be kept, the fact says so in `withheld`, and any
  verdict that reads that field is marked as resting on a measurement (§4, "How far a verdict can be re-checked").
- **Safe to keep.** The scrubber runs before a fact is recorded, not only before a model call. A value that must not
  be kept (a row's contents, an id a test account owns, a secret) is recorded as shape, count and a keyed digest, so
  that two values can still be compared for equality without either being readable.
  - *What is scrubbed.* Every record and every text blob, with the run's full rules: the `--scrub` terms, each secret
    value a plan names and the test accounts' credentials, each also as a URL carries it (percent-encoded as a
    component and as `encodeURI` writes it, form-encoded) and matched in text written decomposed (NFD). Content is
    scrubbed: every string value and object key. Structure is not: a fact's `kind`, `v`, `by`, `run`, `from`,
    `effect`, `cause`, `blobs` and `withheld`, and anywhere a string that is a whole `sha256:` or `hmac-sha256:`
    digest. Two strings of one list, or two keys of one object, that scrubbing makes equal are kept apart by `~2`,
    `~3`… in code-unit order of the originals, so no value is lost and a list stays a list of distinct names.
  - *A withheld value* is `{why, shape, count, digest}`, and a body of bytes adds `size`. `why` is `row`, `owned-id`,
    `secret` or `body`; `digest` is HMAC-SHA-256 under the run's key; `count` is the characters of a text, the items of
    a list, the fields of an object. The `shape` gives types only (an object as its fields' shapes in code-unit order),
    and keeps field names only when the collector says they are a schema's names, since a row keyed by its own values
    would otherwise put them in the ledger.
  - *`withheld`* lists body fields by dotted path (`response`, `as.account`; a list adds no name). A fact whose body
    holds a withheld value at a path it does not name is refused, and so is a path it names that the body does not
    hold. A named field may hold a plain value that rests on one not kept, as check 13's `severity` does.
- **Miqyas enumerates; a tool only judges items.** The list of files, screens, tables or tests a claim covers comes
  from Miqyas's own enumeration, recorded as facts, and never from a tool's report.
- **Its own traffic is marked.** Every exchange carries its `cause`. A 503 that Miqyas's own probing caused is not the
  target's page failing, and a claim about pages reads only what pages caused.
- **It closes.** Every collector run ends with a `collection` fact: what it set out to cover, whether it finished
  (`complete`, `partial`, `failed`), why it stopped, its counts, and how many facts it dropped. Where a claim must
  compare what two collectors saw, not only how many, it also lists what it counted by name (`listed`, each name
  once, in code-unit order), so that one file swapped for another between two looks is seen. The engine writes
  `failed` for a collector that died. After a run's `collection` fact, no further fact from that run is accepted.
  Limit today: check 13's claim reads both lockfile lists as kernel input, which is capped at 10,000 units (1 plus
  the length of each string), so a repository with more than about 170 lockfiles gives `not_checked` on this path.
- **Identity.** Each kind's schema names the fields that identify one item. Two collectors that record the same thing
  record two facts; a claim says which collector it reads (§4, "Views").
- **Model policy.** Each kind declares whether its content may ever go to a model. Repository content never does
  (ADR 0003).

A **finding** is a fact of kind `finding`: a problem no claim asked about, with a source (a derivation, an adapter or
an agent), a severity and the facts it rests on. Its body is `id`, `title`, `severity` (`info`, `low`, `medium`,
`high`, `critical`), `state` (`confirmed`, `unconfirmed`) and `source` (`derivation`, `adapter`, `agent`), and its
`from` is required, with at least one position. A model-proposed finding is `unconfirmed` until a derivation or an
experiment backs it; one whose source is `agent` can't be `confirmed`. Findings are recorded in the ledger and never
carry a verdict.

A derivation's examples each state the facts it gives, in order and without `by` and `run`; it is registered only
when it gives exactly those, so one that gives as many facts but the wrong ones is refused.

### Kinds in the foundation

| Kind | Recorded by | Holds |
|---|---|---|
| `ui.snapshot` | web worker; later mobile and desktop | URL, title, language, direction, viewport, whether it was truncated, whether the page had settled; the rendered nodes (role, name, state, text, box in whole pixels, whether rendered) as a JSON blob, and the screenshot as a blob |
| `ui.event` | web worker | a page error, a console error, a dialog |
| `ui.control` | crawl | one control tried: its label, what changed (URL, nodes, requests), or why it wasn't tried |
| `http.exchange` | web worker, API worker | method, URL and its route template (or null), status (or null), selected headers, the request and response bodies each as a withheld value (shape, count, size, keyed digest) and named in `withheld`, its cause, and as whom it was sent (nobody, or a named account with its role) |
| `asset` | web worker | one served file (bundle, source map) or storage entry, as a blob |
| `code.coverage` | web worker | which functions and blocks of the served scripts ran, per session |
| `a11y.violation` | axe adapter | rule, impact, the node |
| `repo.tree`, `repo.file` | repository reader | what was read: paths, the commit, whether the tree was dirty |
| `secret.match` | gitleaks adapter | rule, location, redacted |
| `db.table` | migrations reader | schema, name, whether row-level security is on |
| `dep.package`, `dep.advisory` | lockfile reader, osv adapter | a package and version; an advisory against it with its severity |
| `tool.run` | every adapter | the command, exit code, tool version, digests of what it was given, whether it finished |
| `test.case` | test-runner adapter | one test: id, status, attempts; plus the list of tests planned, recorded before the run |
| `step.done` | plan runner | one action step: carried out, failed, or outcome unknown |
| `sample` | any collector | one numeric measurement with its unit: a duration, a size, a yes or no |
| `model.state`, `model.edge` | derivations | the target model: a state and a transition between two states (ALGORITHMS C) |
| `entity`, `property` | extractors | one thing a target is made of, and one observation about it: yes, no or not known, with how it is known (ENGINE §8) |
| `capsule`, `fidelity` | the experiment engine | a capture of a sandbox: its manifest, the recipe that made it and what that recipe did with each store; whether a restore and a fork answered as the original did, and which reads moved (ALGORITHMS M1, M2) |
| `experiment` | the experiment engine | the runs of one experiment and the result of each of its checks. It holds no result of its own: the law's claim is judged over it (ALGORITHMS L1) |
| `footprint` | a derivation over two recorded listings of state | what one action changed, as far as the recipe could see: rows by table and column, requests sent, what the page shows (ALGORITHMS M4) |
| `collection` | every collector, or the engine | see above |
| `finding` | derivations, adapters, agents | see above |

Kinds reserved for later surfaces, so the contract isn't shaped only by a browser: `process.result` (a command-line
program), `history.op` and `fault` (an engine under test), `signal.sample` and `target.class` (a control system).

## 4. Claims, views and the judge

A **claim** is one thing that must be true. A plan's assertion, a readiness check, an invariant and an imported test
are all claims, and one judge handles all of them. A claim is data (ADRs 0006, 0011 and 0013).

### Views

A claim is judged over a **view**: the facts it may read. The view is fixed before the judge runs, and it is
recorded in the verdict, so that re-judging reads exactly the same facts.

```ts
interface View {
  subject: string;                 // one subject; a run on several subjects folds each apart
  kinds: string[];
  by?: string[];                   // which collectors; required when more than one can record a kind
  session?: string;                // one session label, or a pair of labels for a pair claim
  cause?: string[];                // 'page', 'plan', 'probe', 'crawl'
  window?: { after: number; upto: number };   // ledger positions, for a plan step
}
```

A view is **closed** when every collector run that can add to it has recorded its `collection` fact. The judge runs
once, when the view closes, and never earlier. A fact can't arrive late, because a closed collector run accepts
nothing more.

### Four shapes

Every claim has one of four shapes (ADR 0013). All four give the same three values.

| Shape | Judged over | Says | Used for |
|---|---|---|---|
| `set` | items | every, some or none of them hold a rule; or their count does | most readiness checks; state assertions |
| `pair` | pairs of items joined on a key | every, some or none of the pairs hold a rule | one user reading another's data; old against new; a mock against the real thing; a layout before and after a flip |
| `trace` | the events of one session, in order | something never happens, always holds, or follows something else within a bound | plan assertions over a step; "after X, Y within 2 s"; no error at any point |
| `sample` | numeric measurements | a proportion or a quantile meets a bound at a stated confidence | latency, stability, the pass rate of a feature that isn't deterministic |

```ts
interface Claim {
  id: string; version: number; title: string;
  needs?: { inputs?: string[]; effect?: EffectClass; kinds: string[] };
  view: Partial<View>;             // the engine fills in the subject and, for a plan step, the window
  vacuous?: 'pass' | 'not_checked';   // what an empty domain means; default 'not_checked'
  uses?: string[];                 // derivations this claim relies on, pinned as id@version
  usable?: string;                 // `set` and `pair` claims: CEL over one item or pair; unless true, it isn't used

  all?: Claim[]; any?: Claim[];    // a combination; an empty list is rejected

  shape?: 'set' | 'pair' | 'trace' | 'sample';
  // set
  quantifier?: 'every' | 'some' | 'none' | 'count';
  from?: string; each?: string;    // the kind of fact, and optionally a list inside each fact to take items from
  where?: string; holds?: string; count?: string;   // CEL over `item`; `count` is CEL over `n`
  // pair
  left?: Selector; right?: Selector; on?: [string, string];   // key expressions for each side
  unmatched?: 'uncovered' | 'fail' | 'ignore';                // a left item with no partner; default 'uncovered'
  // trace
  pattern?: 'absence' | 'universality' | 'existence' | 'precedence' | 'response';
  during?: 'globally' | 'before' | 'after' | 'between';       // which stretch of the session the pattern covers
  p?: string; s?: string; q?: string; r?: string;             // CEL over one `event`
  within?: { ms?: number; steps?: number };
  // sample
  value?: string; success?: string;                           // CEL giving an integer, or a yes or no
  bound?: { proportionAtLeast?: string } | { quantile: string; atMost: number };   // decimals as strings
  confidence?: string;                                        // "0.95" by default
  samples?: number;                                           // how many to take, fixed before the run

  covered: string;                 // CEL over `ctx`: when the enumeration counts as complete
}
```

Expressions are CEL from a documented subset. Their cost is bounded when a claim is loaded, from the size of the
expression, how deeply it nests, and the largest list it may walk; no clock takes part in judging, so the same facts
always give the same verdict. An expression sees one item, one pair or one event; the engine does all quantifying.
Items come from the facts in the view, or, with `each`, from a list inside each fact, which may be a JSON blob such as
a snapshot's nodes. In a `count` rule, `n` is the number of items inside the claim. `ctx` is defined, not ad hoc: it
holds the `collection` facts of the collectors in the view keyed by collector, the run's inputs by name (the run date,
which accounts were given), and the keyed digests of secrets a claim may compare against. Text is compared through
`normalize()`, a documented extension that folds case, Unicode forms, Arabic diacritics and letter variants, and
spacing, implemented identically wherever claims are evaluated.

### The judge

For a `set` claim the judge sorts every candidate item into one of four groups: it **holds**, it **fails**, it is
**outside** the claim (`where` is false), or it is **uncertain** (`where` or `holds` gave an error, or the claim's
`usable` rule isn't true of it). Then:

| Quantifier | `fail` when | `pass` when | otherwise `not_checked` |
|---|---|---|---|
| `every` | some item fails | no item fails or is uncertain, and covered | an item is uncertain, or coverage is not met |
| `some` | no item holds or is uncertain, and covered | some item holds | no item holds and an item is uncertain, or coverage is not met |
| `none` | some item holds | no item holds or is uncertain, and covered | an item is uncertain, or coverage is not met |
| `count` | covered, and the count rule is false for every count the uncertain items allow | covered, and it is true for every such count | the uncertain items could change the answer, or coverage is not met |

Reading the table: a counterexample settles an `every` or a `none` claim at any coverage, and a witness settles a
`some` claim at any coverage. Not finding one settles nothing until `covered` is true. An error is never read as true
or false, in `where` as much as in `holds`, and an error in `covered` means not covered.

A `set` or `pair` claim over measurements can say when one is **usable**. A replay as a second account shows nothing
if that account's session had expired, so the claim names the checks that must have passed: the owner's own request
returned the data, and the second account could make a request it is allowed. An item that isn't usable is
uncertain. It can make neither a pass nor a fail.

When no item is inside the claim, an `every` or `none` claim is **vacuous**. A vacuous claim is `not_checked`, with
the reason "nothing to check", unless the claim says `vacuous: 'pass'`, which a claim may say only when its coverage
rule establishes that the set really is empty. A `where` that selected nothing is reported either way, because a typo
in a rule otherwise passes forever.

A `pair` claim uses the same table over pairs. A left item with no partner makes the coverage not met, unless the claim
says it is a failure or can be ignored. A `trace` claim and a `sample` claim have tables of their own, in ALGORITHMS
A3 and A4; each has a `fail`, a `pass` and a "can't tell yet".

A combination uses the same three values: `all` fails if any part fails and passes only if every part passes; `any`
is the mirror.

"Not known" keeps its three words, split by who has to act next:

| Verdict | Meaning | Typical reasons |
|---|---|---|
| `blocked` | the person must supply something | an input, a secret, a flag, a tool that isn't installed, a step that was never bound |
| `not_checked` | Miqyas didn't establish it | coverage short, a collector failed, dropped for time or money, an expression errored, a measurement couldn't be used, nothing to check, too few samples |
| `unverified` | it looked like a pass, on a basis not yet accepted | a binding nobody reviewed that code couldn't show to be tied to the assertion and able to fail |

Each carries a typed reason and, where it applies, what to add. That list is computed from the claim's unmet `needs`;
nobody writes it by hand per check.

### Seen to fail

No claim contributes a pass until it has been seen to fail (rule 5, ADR 0014). How that is shown depends on where the
claim came from:

- **A shipped claim** carries examples in its file: facts that must give `pass`, facts that must give `fail`, facts
  that must give "not known". A claim file with no failing example isn't loaded.
- **A binding** is tested on the facts it was bound on, before it is used (§8): its anchored text is replaced by
  random text and it must stop passing; it must not have held already before the action it follows; and a binding
  that asserts an absence comes with an item that would break it, which is inserted and must break it.
- **A claim a person writes by hand** is held to the same tests by `miqyas lint`.

A claim that can't be shown to fail gives `unverified`, with that as its reason. These tests run on recorded facts, so
they cost nothing and anyone can repeat them from the bundle.

### How far a verdict can be re-checked

Every verdict records its **depth** (rule 9), computed from where the facts it read came from:

| Depth | Meaning |
|---|---|
| `facts` | the verdict follows from recorded raw facts and the claim alone |
| `derived` | it also needs derivations, whose inputs are all in the bundle, so they can be re-run |
| `measured` | it rests on a field a collector computed from data that wasn't kept; it can only be measured again |

It also records its **kind of assurance** (ADR 0015): `tested` (the claim held on the executions that were observed),
`bounded` (a tool checked every case up to a stated bound), or `proved` (a tool proved it for every case). Miqyas's
own collectors give `tested`; the other two come from adapters around model checkers and provers. A report never
blends the kinds or the depths into one number.

### Evidence

The evidence of a verdict is its read set: the view, the items sorted into their four groups, the witnesses or
counterexamples among them, and the coverage rule with the values it saw. The engine records it; no check assembles it.

```ts
interface Verdict {
  claim: string;                 // id@version
  rule: string;                  // SHA-256 of the claim file's bytes; the file is recorded once, verbatim
  view: View;                    // exactly what was in view
  verdict: 'pass' | 'fail' | 'not_checked' | 'blocked' | 'unverified';
  reason?: string; add?: string[];
  items: { held: number; failed: number; outside: number; uncertain: number };
  read: number[];                // ledger positions of the facts read
  shown: number[];               // counterexamples for a fail, witnesses for a pass
  coverage: { rule: string; met: boolean; saw: Json };
  vacuous?: boolean;
  depth: 'facts' | 'derived' | 'measured';
  assurance: 'tested' | 'bounded' | 'proved';
  basis: 'rule' | 'opinion';     // "opinion" only for an assertion marked for a model (§8)
  failed_on?: string;            // which failing example or counterfactual showed the claim can fail
  binding?: { by: string; accepted: boolean; anchored: boolean };
  stats?: { n: number; k: number; confidence: string };   // for a sample claim
}
```

### The fold

One function turns verdicts into a result: any `fail` gives fail; otherwise anything not known gives not known;
otherwise pass; and an empty set never passes. Everything that can change the exit code is a claim:

- A plan carries one implicit claim, "every action step was carried out", over its `step.done` facts, beside its
  assertions. A plan with no assertion is still an error when it is linted.
- `--fail-on high` adds the claim "no confirmed finding at or above high".
- A crawl that stopped early is coverage not met in the claims that needed it, not a special case in the report.

A profile is ready when the fold of its claims passes. A pass with basis `opinion` counts in the plan whose author
marked that assertion for a model, is counted apart in every report, and is never part of a profile. Exit codes follow
the three values: 0 every claim passes, 1 some claim fails, 3 nothing fails but something is not known or the run
couldn't finish, 2 a usage or plan error, which includes a run with no claim at all. This changes one thing from the
first version, where a verdict that was not known exited 1: "found something wrong" and "couldn't establish it" are
now told apart, and both still stop a gate.

## 5. The ledger and the proof bundle

A run writes a **proof bundle** as it goes (ADR 0007):

```
.miqyas/runs/<run id>/
  ledger.jsonl          append-only; one JSON record per line, written once, by one writer
  blobs/sha256/ab/cd…   evidence too large for a record, named by its SHA-256
  checkpoint            tree size and root hash; rewritten at intervals and after the seal
  retired.json          which blobs retention removed, and when; absent until it removes one
  report.md  report.json  report.html      views, regenerable from the ledger
```

Each line is `{"seq": n, "t": type, "at": time, "body": {…}}`. The record types:

| Type | Body |
|---|---|
| `run.open` | format version; engine, collector, derivation and CEL library versions, and the versions of the other substrate that can change what is recorded (the browser, its driver, the SQL parser); the subjects with their digests; the inputs given; the grants; the class of each origin; the budgets; the quote and the cap |
| `claim` | one claim file, verbatim, recorded once and referred to by the SHA-256 of its bytes |
| `effect` | one decision of the gate: the request, who asked, the class the gate gave it, the rule, allowed or refused |
| `fact` | one fact (§3) |
| `proposal` | something a model produced: a binding, a crawl choice, a draft finding |
| `model.call` | the model asked, the scrubbed request as a blob (the payload log of ADR 0003), the answer, tokens and cost |
| `verdict` | one verdict (§4) |
| `run.seal` | the fold's result per subject, plan and profile, and the counts |

- **The tree.** The leaves of a Merkle tree (RFC 9162) are the lines as stored: `SHA-256(0x00 ‖ line)`. Nothing is
  re-serialised to be hashed. Blobs are bound to the tree through the digests in the facts that name them, and the
  engine re-hashes every blob a worker hands it.
- **Checkpoints.** The `checkpoint` is rewritten every few hundred records and after the seal, so a run that crashed
  can still be checked up to its last checkpoint.
- **A torn last line.** A final line with no newline is what a crash leaves. A reader drops it and says so; it is not
  tampering.
- **Retention.** Removing old evidence is recorded in `retired.json`. A verdict whose evidence was retired is reported
  as "evidence retired", distinct from "evidence changed".
- **Subjects.** A subject is the exact thing verified, by digest: a commit, a build directory, a binary. A deployed
  URL is not a subject, because it can change during a run and its pages differ on every load. A run against a URL
  records what was served as facts and, when the person also gives the build, a fact saying whether the URL was
  serving that build. A run on a URL alone has no subject and says so. The strongest statement about a build comes
  from a sandbox run on that build.

### Verifying

`miqyas verify <bundle>` needs no target, model or network. It answers four questions and reports each apart:

1. **Intact?** Every line matches the tree, every blob matches the digest a fact names for it, and the checkpoint
   matches the tree.
2. **Does the result follow?** The fold of the recorded verdicts equals the seal.
3. **Do the verdicts follow?** Each claim, re-judged over its recorded view, gives the recorded verdict and read set,
   and its failing example still fails.
4. **Do the derived facts follow?** With `--rederive`: derivations re-run to the same facts. A tool is re-run only
   when its inputs are in the bundle and it is installed; otherwise the answer is "not re-derived".

What a bundle can't show is stated in every report. It can't show that a collector recorded the target faithfully. It
can't show who made it or that nothing was left off the end, unless its head was published somewhere its holder
doesn't control; the head is printed when a run ends for that purpose. And a verdict of depth `measured` can't be re-
judged past the measurement. A run with no seal didn't finish and never passes.

A bundle can hold pages as real users see them. It stays on the machine that made it; sharing one means choosing what
to disclose, and the tree lets a verdict and its evidence be handed over with proof that they belong to the run,
without the rest.

Replay needs no separate file: `--replay <bundle>` answers model calls from the `model.call` records of an earlier run,
keyed as today, and fails closed on a miss.

## 6. The gate

Everything Miqyas does to a target and everything that leaves the machine is an **effect**, and every effect passes
one gate (ADR 0008).

### Classes

| Effect | Meaning |
|---|---|
| observe | load and read what a client is served, and move through the interface without changing anything |
| interact | use the product through its own interface the way a person's plan says, submissions included |
| probe | send a request the interface didn't send, that only reads |
| write | send a request that changes stored state or spends the target's money |
| disrupt | break or degrade the target on purpose: faults, restarts, clock skew, a mutated build, load; capturing, restoring and forking a sandbox's state |
| execute | run the target's own code on this machine: its tests, its command-line program |

An **environment class belongs to an origin**, not to a run. Every origin a run touches is classed by itself:

| Class | How it is established |
|---|---|
| sandbox | the engine started the process serving it in this run, and that process can reach the network only through the gate; an origin that is both a sandbox and a test host by name is a sandbox |
| test host | by its name, as the threat model defines it. One on this machine (loopback, `.localhost`, `.test`) is **local**; one recognised only by a label in a public name (`staging.`, `dev.`) is **named** |
| owned host | named with `--allow-host`, and its owner has placed the token, as the threat model defines it |
| backend | the target's own pages were observed calling it; it takes its consent from the origin whose pages called it, and is never a sandbox unless the engine started it too |
| other | everything else |

| | sandbox | local test host | named test host | owned host | backend | other |
|---|---|---|---|---|---|---|
| observe | yes | yes | yes | yes | yes | yes |
| interact, from a person's plan | yes | yes | yes | yes | through the page | yes |
| probe | yes | `--active` | `--active` | `--active` | as the origin that calls it | never |
| write | yes | `--active` | `--active --allow-writes` and the token | `--active --allow-writes` | as the origin that calls it, and `--allow-writes` | never |
| disrupt | yes | `--allow-disrupt` | `--allow-disrupt` and the token | `--allow-disrupt` | never | never |

`execute` runs only inside a container the engine started with no network and a read-only copy of the repository, or
with the person's `--allow-exec`. A person's plan is a plan a person wrote or reviewed; one an agent drafted is a
proposal until then.

The table is a ceiling, and it tightens one thing: a host that is a test host only by a label in its name now needs
the ownership token before Miqyas writes to it or disrupts it, because a name proves nothing about who owns it. What
Miqyas's own probes do stays as the threat model says, now as deny rules with a test each: inert markers only, the
second account only reads, only ids the test accounts own with no enumeration, and anything a target stores is tagged
with the run id and listed for clean-up. These rules bind on every origin that isn't a sandbox. In a sandbox the
engine started, an experiment may write as any identity it made and send what an interface forbids (ENGINE §3).

### How the gate decides

- **At the wire, per request.** The gate classes each request itself and never takes a caller's word. A request with
  a method that isn't safe is at least a write, unless it matches a read pattern the gate knows (a GraphQL query, a
  named read endpoint). A request to a route recorded as spending money is a write. A request whose method, route and
  parameters the page never sent is at least a probe. A caller can declare a higher class than the gate found, never
  a lower one (ALGORITHMS B1).
- **The crawl is read-only at the wire.** While the permit is observe, a request the page tries to send that would be
  a write is refused before it leaves, and the control that caused it is recorded as "would write, not tried". The
  crawl no longer relies on a button's label to know what it does.
- **Permits.** A collector asks for a permit: this origin, up to this class. The only way to act is through a client
  the gate made for that permit. A lint rule keeps `fetch`, sockets, child processes, browser drivers and model SDKs
  out of every other module.
- **Every decision is a record**, allowed or refused, with the rule that decided.
- **A class is established, never claimed.** A plan file, a page, a model or a caller without a person can't raise a
  class or add a grant.
- **The never-do list stays in the threat model**, and each line becomes a deny rule that no grant overrides, with an
  id and a test. This design rewords two lines and adds one, and the threat model lists them: "leave the origin"
  becomes "leave the set of origins the run is about"; "run an active check on a host that isn't a test host or an
  owned host" becomes "probe, write to or disrupt an origin that isn't a sandbox, a test host, an owned host or the
  backend of one"; and "write to or disrupt a live physical process" is new.
- **What was seen to change counts.** A route whose footprint in a sandbox wasn't empty is classed as a write from
  then on, whatever its method. A footprint can raise a class and never lower one (ALGORITHMS B1, M4).
- **Capsules are sandbox-only.** Capturing, restoring and forking are `disrupt` effects, and a deny rule refuses them
  on any origin that isn't a sandbox, whatever was granted.
- **Seeds go only into the corpus.** Planting a defect to measure the experiment engine is refused on any subject
  that isn't a copy of an application from the public corpus (ADR 0018).
- **Isolation for every session.** The in-process proxy that keeps a browser session to its origins (requests,
  WebSockets, workers and frames included, with no direct WebRTC) is a gate rule for every web session, not only for
  workers in their own process.
- **Rates and stops.** The gate owns each origin's request rate (2 a second by default) and the stop rule: the first
  429 or 503 ends everything code chose to send to that origin, where before it ended only the crawl. The stop is
  recorded, exchanges after it are marked as following it, and the claims that needed more get coverage not met.
- **The limits that exist stand**, as gate rules: the daily cap per device; failing closed on an unknown price or
  missing usage; the crawl's defaults of 50 screens and depth 3, changed only by a flag the report shows; and the
  crawl's refusal of controls named as destructive in English and Arabic and of forms that post, which now sits in
  front of the wire rule as a second guard.
- **What leaves the machine.** A model call passes the same gate: scrub, re-scan, a pessimistic cost estimate against
  the cap, then a `model.call` record. A network fetch is allowed only to a named command such as `update-db`. A tool
  runs with fixed arguments on paths Miqyas chose. A run writes nothing outside its run folder and, for a sandbox, the
  capsule store beside it.
- **Consent is a typed question only a person can answer** (§13).
- **A worker in its own process** sends its traffic through a proxy the engine runs. One that can't be proxied gets
  nothing above observe.

What the gate can't know is stated: a `GET` that changes state on a badly built target looks like a read. That is why
anything above observe needs consent, and why the strongest checks run in a sandbox.

## 7. Surfaces and the worker protocol

A **surface** is the set of fact kinds a worker can record and the action kinds it can take (ADR 0010). The engine
knows nothing else about it.

`miqyas-worker/2` is JSON-RPC 2.0 as newline-delimited JSON over standard input and output; logs go to standard error.
Every request carries the protocol version and a deadline.

| Method | Purpose |
|---|---|
| `discover` | versions spoken, the surface's name, each action kind with its parameter schema, each fact kind with its version, how the worker is held to the gate, its limits |
| `open` | start a session on a subject as a named identity; the engine passes the folder for blobs and the proxy to use |
| `act` | take one action in a session; the request names the gate record that allowed it |
| `observe` | record the named kinds now |
| `cancel` | stop a request that is still running |
| `close` | end the session |
| `fact` (notification, worker to engine) | something that happened by itself: a console error, a request the page made, an operation finishing |

The semantics that keep verdicts sound:

- **An action has three outcomes**: carried out, failed, or unknown. A worker that timed out or crashed mid-action
  reports unknown, and the engine never reads unknown as either of the others.
- **Order.** Before a worker answers `act`, it sends every fact that action caused. A fact that arrives by itself
  names the last action before it. A console error is therefore always attributed to the step that caused it.
- **Nothing is dropped silently.** A worker that sheds facts under load says how many, per kind, and its `collection`
  fact then can't be `complete`.
- **Asynchronous work.** `act` may answer "started" with an id, and the completion arrives as a fact. This is how an
  engine under test, where calls overlap, fits the same contract.
- **Identity.** The engine records the version and digest of every worker it starts. A worker's own claim about what
  it is isn't used.
- **A dead worker** is a failed collection written by the engine, and never a pass.

A worker writes large payloads into the blob folder and returns digests. There is no message that carries a verdict.
The same contract is used in process, as plain calls, for the workers that ship with Miqyas.

**Two workers ship with the foundation**, one for the web surface and one for the server surface, so the contract is
shaped by more than one:

- **web**: Playwright Chromium. Actions: navigate, click, fill, select, press, scroll, wait. Facts: `ui.snapshot`,
  `ui.event`, `ui.control`, `http.exchange`, `asset`, `code.coverage`, `a11y.violation`. The crawl is a collector
  built on it.
- **api**: an HTTP client with named identities (nobody, and each account the run was given, with its role). One
  action, `request`. Facts: `http.exchange`. The backend, access and parameter probes behind checks 8 to 12 become
  collectors on it.

Next comes the **engine** worker, also for the server surface: a schedule fixed by a recorded random number, a fault
plan, a recorded history of operations (invoked, ok, failed, and unknown for a call that timed out), and checkers
over that history. It is the worker least like a browser, and it is where `disrupt` is first used; an engine under
test runs in a sandbox. A worker for a control system must record a `target.class` fact (simulator, twin, live) before
anything else, and anything that isn't a simulator the engine started is treated as live.

**Adapters** run outside tools as ADR 0005 describes, and become collectors: each records a `tool.run` fact and the
tool's results as facts. Two shared readers serve many adapters (ADR 0012): one for SARIF 2.1.0, into `finding` and
`tool.run`, and one for JUnit XML, into `test.case`. Model checkers and provers come in as adapters too, and are what
give a verdict the assurance `bounded` or `proved`.

**What is Miqyas's own, and what is borrowed** (ADR 0019). Judging and finding by experiment are Miqyas's own code:
the kernel, the gate, the run engine, the experiment engine, capsules, explorers, oracles and diagnosis, with the
workers, proxies and probes that carry them out. What is borrowed is one of two things. **Substrate** carries out or
reads what Miqyas decided; it is kept behind one interface, and its version is recorded in the bundle wherever it can
change what is recorded or a verdict. A sandboxed stack's database is pinned by its recipe, which the capsule's
manifest names as id@version (ALGORITHMS M1). An **outside tool** runs behind an adapter on what Miqyas handed it,
and adds facts.

| Borrowed | As | Why |
|---|---|---|
| Chromium, driven through Playwright | substrate | a web target runs in a real browser; a lint keeps the driver inside the surface code |
| Node.js, the operating system and a container runtime | substrate | Miqyas and a sandboxed target run on them; a recipe starts containers (ENGINE §6) |
| the database of a sandboxed target | substrate | a target keeps its state in a real database |
| `libpg-query`, to read SQL | substrate | it is built from PostgreSQL's own parser, so SQL is read as the database reads it |
| SHA-256, and HMAC-SHA-256 for keyed digests, from the platform | substrate | published standards, which a second verifier already has |
| a CEL library | substrate | the language is specified apart from any implementation (ADR 0011) |
| Ajv, to check JSON Schema | substrate | it checks each fact against the schema of its kind when the fact is recorded; the schemas are data of Miqyas's own, and Ajv is used in the engine, never in the kernel |
| SARIF 2.1.0, JUnit XML, in-toto and DSSE, RFC 9162 | substrate (formats) | published formats; Miqyas reads and writes them with code of its own, so the borrowed part is the specification (ADRs 0007 and 0012) |
| a PNG decoder, and a model provider's client library | substrate | one decodes an image and the other carries a request; code decides what is sent and what an answer means |
| axe-core | outside tool | a catalogue of accessibility rules (check 4); bundled, and injected into the page by the web worker |
| gitleaks | outside tool | a catalogue of key formats (checks 5 and 6); the web worker also carries a short list of patterns derived from it |
| osv-scanner | outside tool | a catalogue of advisories (check 13) |
| a project's own test runner, model checkers, provers | outside tools | their results are the project's or the tool's own, and say what kind of evidence they give (ADR 0015) |

A language model is neither: it proposes, and code tests what it proposed (ADR 0009). Miqyas's own code takes the
place of something borrowed only when a measurement named beforehand shows it does better (ADR 0019).

## 8. Plans and bindings

A plan keeps its two step types and its stable ids, and stays a file a person writes. What the steps were bound to
lives beside it, in a file a machine writes (ADR 0009):

```
plans/wasl-03-add-pair-validation.json            what a person wrote: the steps, in plain language
plans/wasl-03-add-pair-validation.bindings.json   what they were bound to; written only by `miqyas bind`
```

```json
{ "format": "miqyas-bindings", "version": 1, "plan": "wasl-03-add-pair-validation",
  "steps": {
    "s1": { "for": "Click 'Add folder pair'", "by": "model", "accepted": true,
            "do": [ { "tool": "click", "locator": { "role": "button", "name": "Add folder pair" } } ] },
    "a1": { "for": "An error list says 'required'", "by": "model", "accepted": false, "anchored": true,
            "claim": { "shape": "trace", "pattern": "existence", "during": "globally",
                       "p": "event.nodes.exists(n, n.role == 'alert' && n.rendered && normalize(n.text).contains('required'))" },
            "failed_on": "anchor replaced" } } }
```

- The **plan** is the intent, and never changes when the product's interface does. A version 1 plan loads as it is:
  its `check` becomes an accepted binding and its `cite` constrains the binder.
- The **bindings file** records, per step, the text it was made for (a binding made for different text is stale),
  who made it, whether a person accepted it, and how it was shown able to fail. It is meant to be committed and
  reviewed like a lock file. Whoever can change it can accept a binding; that is the same trust as reviewing code.
- **A run never writes either file.** A run with a person present records the bindings it proposes in its bundle.
  `miqyas bind` writes the bindings file, from a bundle or by running, and shows the diff. `miqyas accept` marks
  entries accepted.

### What an assertion is judged on

An assertion is a `trace` claim over its **window**: every snapshot from the end of the action before it until the
page has settled, or the step's time limit. The worker records a snapshot when the page settles and at short
intervals while it is still changing.

- An assertion that something **is there** passes on any snapshot in the window, so a message that shows for two
  seconds is caught.
- An assertion that something **isn't there** must hold on every snapshot in the window, and passes only if the
  window ended settled. An error that appears 400 ms after the action fails it.
- A snapshot that was truncated can't support an absence.

### Binding

Binding happens once, with a model. The binder sees the step and the current snapshot and answers in a narrow schema:
for an action, a choice among the controls code listed; for an assertion, a claim and the nodes it rests on. Code then
does all of this before the binding counts:

1. Evaluate the claim on the assertion's window.
2. Check the witnesses are among the items the claim selected.
3. **Anchor** it: every quoted string in the assertion appears as a literal in the claim, and a `cite` locator is
   implied by it.
4. **Replace the anchor**: put random text in place of each anchored literal and judge again. It must stop passing.
   A claim that passes whatever the text says wasn't tied to the assertion.
5. **Look before the action**: judge the claim on the snapshot from before the action this assertion follows. If it
   already held, the assertion isn't testing the action.
6. For an absence: insert the breaking item the binder supplied, and it must fail.

A binding that passes all of these counts at once. One that doesn't gives `unverified` where it would have passed,
with the reason, until a person accepts it. A fail counts either way: it costs a look, not trust.

### Running

A run replays bindings. An action's locator is resolved against the snapshot's nodes, to a handle taken when the
snapshot was, and the action is done on that handle, so the page can't swap the node in between. A locator names a
role and a name, and may be narrowed by `within` another locator, by `nth`, or by a claim ("the row whose text
contains…"). If it resolves to nothing, or to more than one element, the step failed. Nothing is repaired during a
run. A value that changes between runs (today's date, an account's name) is referred to through `ctx`, never written
into a binding.

| Situation | What a run does |
|---|---|
| every step bound | runs with no model, at no cost, the same every time; this is the only mode with no terminal |
| some step unbound, a person present and a cap typed | binds it, records the proposal in the bundle, applies the rules above |
| some step unbound, or its binding stale, and no person | that step and what follows it are `blocked` |
| an action binding nobody accepted | it is used: an action that was bound wrongly can't pass anything, it can only lead the assertions after it to fail |
| an assertion binding nobody accepted | it counts if it passed every test above, and is `unverified` otherwise |
| an assertion marked `"judge": "model"` | a model judges it each run; a pass needs a cited node that code matches to the assertion's quoted text or `cite`, as before, and has basis `opinion`; text on the page that addresses the judge makes it `unverified`; with no model it is `blocked` |

Every model call, the binder's included, still passes page text as fenced data and never as instructions.

## 9. Readiness: profiles and checks as claims

A **readiness check** is a claim Miqyas ships (ADR 0004 stands). A **profile** is a versioned file naming claims, each
with a pillar and a priority, and pinning the collectors and derivations they use. Adding a check or a profile adds
files; it doesn't change the engine. A company's own profile is the same kind of file.

The thirteen Grade 1 checks, restated. The shape says how each is judged; the depth says how far its verdict can be
re-checked from a bundle. Intended differences from today's verdicts are listed in the port of each check before it
starts, and decided there.

| # | Collectors and derivations | Shape and claim | Covered when | Depth |
|---|---|---|---|---|
| 1 | crawl; errors attributed to screens | set: every screen has no page error, uncaught console error or same-origin 5xx that a page caused | at least one screen, and the crawl wasn't stopped early | derived |
| 2 | crawl | set: every control tried changed something, by a recorded measure | at least one control tried; those not tried are listed | facts |
| 3 | plan runner; API worker | pair: after the log-in steps, a request returns what it didn't return with no session; after sign-up, the new account can log in | both flows ran to the end | facts |
| 4 | crawl, axe adapter | set: no violation is critical or serious | axe finished on every screen reached | facts |
| 5 | crawl, gitleaks adapter | set: no match is a known key format | every asset recorded was handed over, and the tool finished | derived |
| 6 | repository reader, gitleaks adapter | set: no match is a known key format | working tree and history both scanned | measured |
| 7 | migrations reader | set: every public table has row-level security on | every migration file parsed, and at least one table found | derived |
| 8 | backend detection, API probe | set: no table read with the public key returns rows | every backend detected was probed | facts |
| 9 | API probe as the second account | pair: no record the first account read is readable by the second | every record chosen was replayed | derived |
| 10 | API probe with no session | pair: no route seen behind log-in gives a request with no session what it gave the session | every such route replayed | derived |
| 11 | API parameter probe | set: no parameter reflects the marker unescaped or redirects to it | at least one parameter probed | derived |
| 12 | API probe with no session | pair: no route recorded as spending money gives a request with no session what it gave the session | every such route replayed | derived |
| 13 | lockfile reader, osv adapter | set: no advisory is critical, high or malicious | every lockfile found was scanned against a present database | derived |

Four things in this table are deliberate changes. Check 3 stops being a model's judgement: "log-in works" is what the
server does with the session afterwards, and only finding the form fields needs binding, once per app, kept in the
project's bindings and not in a file Miqyas ships. Until that binding exists the check is `blocked`, saying to bind
once; twelve of the thirteen checks still need no model at all. Checks 9 to 12
keep enough of each exchange (status, shape, keyed digests, the text around Miqyas's own marker) for a derivation to
reach the same answer again. Check 6 is `measured` because a repository's history isn't copied into a bundle.

Checks 9, 10 and 12 are the `who` axis of the experiment engine, run on a host that can't be restored, and they are
decided as that law is (ALGORITHMS L3): on what each response carries, never on its status. Each names what makes a
replay usable: the session's own request returned the data, and the other identity is live. On such a host a response
is all there is to read, so check 12 shows that nothing came back to a request with no session, not that nothing was
spent. The law for writes, judged on the state and on what is read back, runs in a sandbox (MAP §6, step 6).

The drop order under a time limit is no longer a list in code: each claim has a priority, and §10 uses it.

## 10. The run engine

A run goes through six stages. The first three touch nothing and make up `--dry-run` and the quote. Each stage is a
function in ALGORITHMS E.

1. **Resolve.** Collect every claim: the plans' assertions through their bindings, the profiles' claims, the claims
   flags add. Reject a claim with no failing example.
2. **Match.** For each claim, find the kinds its view needs and the collectors that record them, following what those
   collectors consume in turn. The result is a graph over kinds, fixed before anything runs: the crawl feeds the
   derivations that feed the probes. Where two collectors record one kind, the claim's view names which. A claim
   whose needs can't be met (an input, a grant, a tool) is settled now as `blocked`, with what to add.
3. **Fit.** Estimate time and money against the time limit and the cap. If the time limit can't hold everything, drop
   the collectors that serve only the lowest-priority claims, ties broken by claim id; those claims become
   `not_checked`, dropped for time.
4. **Collect.** Run collectors in the order the graph gives, independent ones in parallel, each origin's rate held by
   the gate, a deadline on each. A collector that is retried starts a new run of itself, and a view reads its last
   one. A collector that fails leaves a failed `collection`, and by rule 4 a missing fact can't make a pass.
5. **Judge.** Judge each claim once, when its view closes. A plan's assertion closes with its window.
6. **Seal.** Fold per subject, write the seal and the checkpoint, print the head, render the reports.

The ledger is also the event stream: a client that follows a run reads the records as they are appended.

Given a request, the recorded facts and the recorded model answers, the verdicts are fixed. The order of records in
the ledger can differ between two runs when collectors run in parallel; no verdict depends on it, because `set` and
`pair` claims are judged over sets and a `trace` claim reads one session, whose order is its own.

## 11. Finding what is wrong, and saying how sure

The foundation above makes a verdict trustworthy. What makes Miqyas find more, and say how much its silence means, is
built on it. The centre of that is the **experiment engine**, specified in [ENGINE.md](ENGINE.md): it runs pairs of
runs from the same restored state that differ in one thing, and reports where a law that holds whatever anyone
intended is broken. Around it, specified in [ALGORITHMS.md](ALGORITHMS.md):

- **The target model** (C): the states, transitions, routes and roles of a target, derived from facts and kept across
  runs. It steers exploration, shows what changed between two releases, and is the denominator for coverage.
- **Search** (D): the explorers that look for counterexamples in each space a defect can hide in: states and
  sequences, inputs, configurations, who is asking, timing and interleaving, faults. Each has a coverage measure with
  a stated denominator and a rule for when to stop.
- **Oracles** (F): what decides that something is wrong when nobody wrote an assertion: relations between runs,
  agreement between two versions or two implementations, conformance to a contract, invariants over a history.
- **Assurance** (G): for every claim, what was covered, with what confidence, how sensitive the check was shown to be,
  and what kind of evidence stands behind it. Never one blended number.
- **Diagnosis** (H): the smallest input that still fails, which change introduced it, which code is suspect.
- **Economy** (I): doing only the work a change calls for, and spending a budget where it buys the most coverage.

## 12. The agent team

Agents propose; code disposes. An agent is a role with a narrow answer schema, no permit, and a share of the cap.
Its answer is a `proposal` record, checked by code before anything comes of it, and it is never a verdict.

| Role | Proposes | What code does with it |
|---|---|---|
| Binder | a binding for a step | §8. The only role the foundation builds. |
| Cartographer | which control or route to try next, from a list code built; a name for a state | carries it out through the gate; the target model grows from the facts |
| Author | a plan or a claim, from the model and a description a person supplies | lints it, tests that it can fail; a person reviews it |
| Prober | a hypothesis ("this route may leak that") | maps it onto a probe template code already has; in a sandbox, may be a request of its own |
| Fault planner | a schedule of faults for a scenario | stores it as data and runs it from a seed, in a sandbox |
| Triager | a draft finding or a cause to look at | records it as `unconfirmed`, labelled as a model's judgement |
| Adversary | a seed to plant in an application of the public corpus, to measure the experiment engine | admits it only with a test, written apart from the engine, that shows it (ENGINE §11) |

To the engine an agent is one more explorer: it is given budget when what it proposes adds coverage, by the same
measure as every other explorer (ALGORITHMS D9). Agents don't talk to each other; they read the same facts.

## 13. Entry points

There is one engine and one **control protocol** to it, in the same JSON-RPC shape as the worker protocol: start a
run, follow its records, answer a consent question, fetch the result. Every entry point is a client.

| Entry point | What it is |
|---|---|
| CLI | a thin client that starts the engine as a child process; the only client that can answer a consent question |
| CI gate | the CLI with no terminal: bound plans and replays only; nothing is bound without a person, and an unbilled local model serves only assertions marked for a model; or `miqyas gate` on a bundle made earlier |
| MCP | a client that exposes runs and results as tools; it returns results, never instructions, and can't widen a run |
| Self-hosted | the same engine kept running behind the same protocol, with a queue and a store of bundles; later |

## 14. Layout

```
src/kernel/      ledger, blobs, checkpoint, claim schema, the judge for all four shapes, fold, verify
src/protocol/    worker protocol, control protocol, fact kind schemas
src/scrub/       the scrubber
src/surfaces/    web and api workers
src/gate/        the gate: classes, wire rules, scopes, spend, consent
src/engine/      resolve, match, budget, collect, replay; derivations and checkers
src/model/       the target model and its diff
src/experiment/  the experiment engine: the laws, the matrix, controls, footprints, the book
src/capsule/     capture, restore and fork of a sandbox; one recipe per kind of stack
src/measure/     real-defect sets, seeds, and the scores of the experiment engine
src/explore/     the explorers and the budget allocator
src/assure/      coverage measures, sensitivity, the assurance record
src/diagnose/    minimising, bisecting, clustering, localising
src/collectors/  adapters, readers and probes
src/claims/      shipped claims and profiles, as data
src/agents/      model providers and roles
src/bench/       corpus, score, mutation
src/entry/       the engine process and the control protocol server
src/cli.ts       the thin client
```

The kernel has no dependency but the CEL library, and reaches storage and hashing only through interfaces it is
handed, so it can run outside Node and be ported. Imports go one way: `protocol` and `scrub` import nothing else here;
`surfaces` imports only those two; `kernel` imports only `protocol`; everything else may import those four and what is
listed above it; `cli.ts` imports only `protocol`. The lint that checks this also keeps I/O libraries inside `gate/`
and `surfaces/`. Licences are unchanged by this design: each new folder takes the licence of the layer it grows out
of, as [OPEN_MODEL.md](OPEN_MODEL.md) sets them.

## 15. Migration

The new foundation is built beside the old code and takes over one piece at a time. The bundle format is version 0,
and may change, until the gate and both workers write to it; it becomes version 1 at the first release. The order of
building is [MAP §6](MAP.md), which places the experiment engine's steps among these. This section says only what the
old code hands over.

1. **Kernel first**, with one check end to end through the new path behind a flag: facts, a claim with its failing
   example, a view, the judge, the ledger, `verify`.
2. **The gate**, then every collector moved behind it.
3. **Web and API workers** on the new contract, recording facts.
4. **The thirteen checks ported one by one.** Before each port, the differences intended from today's verdict are
   written down (what an empty domain gives, what `--strict` used to change, check 3). While both exist, old and new
   are compared on the fixtures and the corpus; any other difference is a defect in one of them.
5. **Plans**: the bindings file, bound replay over windows, then the binder.
6. **Reports** rendered from the bundle.
7. **Delete** the old orchestrator, `readiness.ts`, `miqyas-worker/1`, and `report.json` as the source of truth.

In MAP §6 these are steps 1 to 4, 7 and 10; a capsule and the `who` axis come between the checks and the plans.
Everything else is placed there too: the other axes, the target model and the explorers, the assurance record,
sandbox mutation, diagnosis, the SARIF, JUnit and prover adapters, attestation and `gate`, the engine-scenario
surface, workers in their own process, MCP, the wider agent team.

## 16. Tests

- **The seam stays the CLI run on fixtures**, with scanner shims on the path, scripted and replay agents, no network.
- **The kernel is tested as pure functions**: claims and facts in, verdicts out, for every row of every judge table.
  Its properties are tested with generated inputs (ALGORITHMS A6): adding facts never turns a fail of an `every`
  claim or a pass of a `some` claim into anything else; no absence passes uncovered; the order of facts never matters.
- **The kernel's own tests are mutation-tested.** A change to the judge that no test notices is a missing test.
- **Each claim and each derivation ships its own examples** for pass, fail and not known.
- **The gate has one test per never-do rule**, one per cell of the effect table, and one per wire rule.
- **A worker conformance suite** runs any worker through the protocol and checks the facts against their schemas.
- **The CEL conformance suite** runs in CI against the library in use, and `normalize()` against shared vectors.
- **Bindings have a labelled corpus**: pages where an assertion is true and twins where it is false. A binding made on
  the true page must fail on the twin.
- **The injection seeds keep their bar**: on pages written to address the binder or the judge, zero passes rest on
  what the page said.
- **Old against new**, until the old is deleted.

## 17. Not in this document

Each of these gets its own spec on this foundation: the engine-scenario surface; Tauri, Android and command-line
surfaces; the MCP entry point; the self-hosted service; the agent roles other than the binder; Grades 2 and 3; exports
to Playwright Test; signing a bundle and the attestation built on it.

## 18. Open

- **The CEL library.** Chosen by a short trial that runs the conformance suite on the candidates.
- **What a shared bundle discloses.** The tree allows handing over one verdict with its evidence; which evidence may
  leave by default is decided with the export.
- **What a caller without a person may ask for.** An MCP client can't add a grant; whether a file a person wrote can
  grant one in advance is decided in the MCP spec.
