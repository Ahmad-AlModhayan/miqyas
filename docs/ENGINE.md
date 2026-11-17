# The experiment engine: how Miqyas finds what nobody asked it to check

The [foundation](FOUNDATION.md) makes a verdict trustworthy. This page is about where verdicts come from when nobody
wrote a test: the engine that finds defects in a running system by controlled experiments, with laws that hold
whatever the developer intended.

| | |
|---|---|
| Status | Proposed, 2026-11-16. A design: one part of it was tried and failed (§12), the rest is untested. |
| Read with | [MAP.md](MAP.md) for where the engine sits; [ALGORITHMS.md](ALGORITHMS.md) parts L, M and N for the functions, numbered. |
| Reasons | ADRs 0016 to 0018. |
| Evidence | [research/engine-2026-11.md](research/engine-2026-11.md): the published work, two trials on real code, and what is still unproven. |

## 1. The problem

Every testing tool needs someone to say what "correct" is. A test runner needs tests, a scanner needs rules, and an
agent that drives a browser needs a plan or guesses. Saying what software should do is the expensive part of
verification and the part that doesn't get done, and it gets worse as code gets cheaper to produce.

Deciding what is correct without being told is called the oracle problem. The engine answers one part of it: the
defects that can be shown without knowing what anyone intended.

## 2. Two kinds of wrong

Some behaviour is wrong only because someone meant otherwise: the discount should have been 10%. No tool can find
that without being told, and Miqyas doesn't pretend to; that is what a plan's assertions are for.

Other behaviour is wrong **whatever anyone intended**:

- one account receives another account's private records;
- the server stores what the application's own form refuses to send;
- asking twice does what asking once should have done, twice;
- two requests at the same moment leave a state that neither order of them could have produced;
- a failure halfway leaves half of a change behind;
- what was written is not what is read back;
- a session keeps working after log-out;
- two views of the same data disagree.

None of these needs a specification. Each is a statement about **two runs of the same system**: what one run shows
must stand in a fixed relation to what the other shows. A single run can't reveal any of them, which is why tools
that look at one run at a time, however cleverly, don't find them. The engine is built to make pairs of runs cheap,
controlled and exhaustive.

## 3. A defect is a pair of runs

An **experiment** starts two runs from the same state. They differ in exactly one thing, the **axis**. A **law** says
how what they recorded must relate. If it doesn't, the law is **broken**, and both runs are in the ledger for anyone
to re-check.

| Axis: what differs | The two runs | Law | Finds |
|---|---|---|---|
| **who** | the same request as the account that owns the data, and as another account, a lower role, or nobody | the lesser identity receives nothing of the owner's that its own interface doesn't offer it, and changes nothing of the owner's | broken access control, leaks between tenants |
| **door** | an action through the interface, and the same request sent straight to the server carrying what the interface forbids or never sends | the server enforces what the interface and the schema declare | validation that exists only in the client; fields a client must not set |
| **again** | a request once, and twice | repeating a request that is declared safe or repeatable changes nothing more in what the application then shows | unsafe reads, duplicated effects |
| **together** | one request then another; the other order; both at once | the result of both at once is the result of one of the two orders | races: spending twice, passing a limit, duplicate accounts |
| **failure** | undisturbed, and with one fault at one point | all of the change or none of it, and an error reported | partial writes, swallowed errors |
| **round trip** | a value written, and then read | what comes back is what went in | truncation, damaged text, silent conversion |
| **after** | before and after log-out, deletion or revocation | what was ended is refused from then on | sessions that survive, deleted data still served |
| **view** | two views of the same data in the same state | they agree: a count and its list, a total and its lines, the page and the API | stale and inconsistent data |
| **presentation** | a page, and the same page in another direction, language, viewport or theme | the same content and controls, placed as the change implies | right-to-left, responsive and translation defects |
| **build** | the previous build, and this one | nothing differs that the change didn't touch | regressions |

Four things make these laws usable without knowing intent.

- **The application's own interface is its statement of intent.** What an identity can reach through its own
  interface is what the application says that identity may do. The `who` law doesn't ask whether a record should be
  private; it asks whether one identity can obtain by a direct request what the application never offers it. For a
  product with no interface, a declared schema or a role table a person supplies takes its place.
- **Standards say the rest.** That a read changes nothing and that some methods can be repeated safely is what the
  protocol defines. That a transaction is all or nothing is what the word means.
- **Content decides, never a status code.** An application can refuse with a 401, a 404 that hides the record, a
  redirect, or a page that says "please log in" with a 200, and can answer a stranger with a 200 and an empty list.
  A law is broken only when the content shows it: the lesser identity's response carries items whose keyed digests
  match the owner's; the stored row holds the value that was forbidden.
- **State is judged as the application shows it.** The answer to a write doesn't say whether the write happened, so a
  law about state is judged on what each identity can then read back through the application, with the footprint as
  the supporting record. What a server keeps for itself (a log line, a revision, a counter) may differ between two
  runs without any law being broken; the protocol says as much.

Each law is a claim Miqyas ships, judged by the one judge like any other, with examples that must fail (FOUNDATION
§4). Most are `pair` claims: items from the reference run on one side, items from the test run on the other, joined
on a key. What a rule can't state on two items (a footprint, the states two orders can reach) a derivation computes
first from the recorded runs, and the claim reads that. A broken law is a `fail` wherever it is judged. It counts
toward "ready" only when the profile names it.

## 4. The matrix

An **operation** is one thing a target lets someone do: a route with a method, a control with its action. Operations
and axes form a matrix, and each cell has a state: doesn't apply, not tested, held, broken, or can't tell, with
why.

```
                who   door   again   together   failure   round trip   after   view
 GET  /invoices/:id    held  n/a    held    n/a        n/a       n/a          held    held
 POST /invoices        held  BROKEN held    held (40)  can't     held         n/a     held
 PUT  /invoices/:id    BROKEN held  held    BROKEN     held      held         n/a     held
 DELETE /invoices/:id  held  n/a    held    n/a        held      n/a          held    n/a
```

The matrix is the report. It is also the coverage: cells tested over cells that apply, per axis, with every "can't
tell" explained. "Nothing found" means a row of `held`, which is a different thing from a row nobody tested.

Some laws can be shown broken and never shown to hold for certain. Two requests at once either collide in a given try
or don't, so `together` is recorded as "held in 40 tries", and reads as that.

## 5. Running an experiment so that it means something

An experiment is only as good as its controls. A response that looks like a refusal may be a missing record, an
expired session or a rate limit. So every experiment carries its own checks, in the same fork:

- **The reference run works.** The owner's identical request succeeds and returns the data. That shows the record
  exists and the instrument works.
- **The other identity is live.** A request it is allowed to make succeeds. That shows a refusal isn't an expired
  session.
- **What varies by itself is known.** The same request, and the same sequence of reads, is run twice from the same
  state first; whatever differs between two identical runs (ids, times, tokens) is left out of every comparison.
- **It is repeated.** A law is recorded as held only after two runs that agree. One odd run decides nothing.
- **Nothing is overwritten.** What an experiment shows is recorded beside what the code says and what a page did. When
  they disagree, the disagreement is reported.

An experiment records its runs and the result of each check, and nothing more. It is a collector's work, and
collectors don't judge (FOUNDATION rule 2). The law's claim is judged over that record, and what the judge says about
one operation is that operation's cell:

| Cell | In the judge (FOUNDATION §4) |
|---|---|
| doesn't apply | the operation is outside the law: the claim's `where` is false |
| held | the item holds |
| broken | the item fails: the content shows it, and every check passed |
| can't tell | the item is uncertain, by the claim's `usable` rule: a check failed, the state didn't come back the same, two test runs disagreed, or the gate refused a run |
| not tested | no experiment was recorded for an operation the law applies to; it counts against coverage |

The law's verdict for an axis follows from its cells as any verdict follows from its items: `fail` when a cell is
broken; `pass` when every cell that applies held and coverage is met; `not_checked` otherwise. Before anything runs,
a law that needs something a person must add (a sandbox, a recipe, a grant) is `blocked`. "Can't tell" is never read
as held.

## 6. The same state: capsules

Two runs can only be compared if they started from the same state, and an experiment must not spoil the state for the
next. That takes a **capsule**: a capture of what a sandboxed target holds, which can be restored or forked.

A capsule is only as complete as its **recipe**, the description of one kind of stack: how to start it, what state it
keeps and where, how to capture and restore each part. What a simple capture misses is known, and each item breaks
experiments in its own way:

| State | If it isn't captured |
|---|---|
| sessions and secrets made at start-up | every request after a restore is refused, and access defects look like refusals |
| caches, counters, rate limits | one run changes what the next one sees |
| queues and background jobs | work from one fork runs against another; state changes between the two runs |
| files and object stores | uploads and exports differ between forks |
| other services | the gate blocks them, and the application takes its error path |
| time | tokens and windows expire between capture and restore |

So a recipe **declares what it does with each store of state**: captured, reset to a fixed start, or outside its
reach. The engine doesn't take its word. Before any experiment it runs a **fidelity check**: capture, restore, replay
a recorded sequence of reads, compare what comes back; then the same on a fork. If the restored or forked target
doesn't answer as the original did, every experiment on it is "can't tell", and the report says which reads moved.
Forks run side by side only where the recipe gives each fork its own copy of every store; otherwise one at a time.

Other services are replaced by recordings of their answers where the target allows it. Where it doesn't, the cells
that depend on them are "can't tell".

Capsules hold sandbox data only, never a copy of a production database. They live in a store beside the run, are
named in the ledger by the digest of their manifest (ALGORITHMS M1), and are deleted when the run ends unless a
person keeps them. Capturing, restoring and forking are `disrupt` effects, and a deny rule of the gate confines them
to a sandbox whatever was granted.

Recipes come in levels behind one interface (`capture`, `restore`, `fork`). The first captures a database, the
browser's storage and what the recipe lists besides, on any machine with containers. Later levels capture a process
tree, then a whole virtual machine, and need Linux. A target whose backend is a hosted service is run against that
service's local stack, where one exists; where none does, only the cells the gate allows on a live host can be tested
(§10). Two hosted backends were checked, and each publishes a local stack with sign-in, storage and its
access rules. An application that isn't pointed at its local stack would reach the hosted one, so a sandbox's only
way out is the gate.

**What an action did.** With the state before and after in hand, the difference is the action's **footprint**: rows
added, changed and removed, by table and column, aligned by their natural keys and with generated values (ids, times)
left out; requests sent; what the page shows. `door`, `together` and `failure` are judged on footprints; for
`again` a footprint is the supporting record (§3).
A footprint records what the recipe could see, and says so: a write to a queue or to another service is outside it.
For that reason a footprint may raise the class the gate gives a request and never lower it, and "no change observed"
is never evidence that a request is a read.

## 7. Getting to a state worth testing

To test whether one account can read another's invoice, the other must have an invoice. The engine has to bring a
target to states where the laws have something to bite on, which is a search problem of its own:

- **What makes what.** From recorded traffic, the engine works out which operations produce what others consume: the
  id a create returns is the id a read needs.
- **Goals in terms of state.** "Every account owns at least one of each kind of thing" is checked by footprints, not
  assumed from a 200.
- **An archive of states.** Each state reached is kept with its capsule, keyed by what the page shows and what the
  database holds, and returned to in one step, where replaying the path would cost its length. Experiments fork from
  the archive.
- **Agents propose paths**; code checks that the state was reached. This is the binder's job (FOUNDATION §8) applied
  to setting up, and it is the place a model helps most.

## 8. Where to look first

A matrix has more cells than a budget, so the order matters. Nothing in this section decides what is wrong. It
decides only what is tested first.

- **What changed.** The operations a change touches, found from the files each one was read from.
- **What the operation does.** Writes before reads; money, access and deletion first.
- **What its footprint touches.** Two writes are worth running together when their footprints overlap.
- **What its peers do.** An operation that lacks a protection most of its peers have goes to the front.

That last signal is the one this design first tried to use as a detector, and it failed (§12). What it is good for is
narrower:

- **A map for a reviewer.** For each protective property, the entities that have it and the ones that don't: every
  route that answers without a session, every table with no policy. Each exception is explained once, by a person,
  with a reason, and recorded. On a small target that list is short, and it is the list a security review starts by
  writing by hand.
- **An order of testing.** The entity that differs from its peers is tested first. If the experiment shows a law
  broken, that law fails; if not, nothing is reported.

Its limits are stated with it: it needs a protective direction (lacking a guard matters; having a comment doesn't);
near-copies count once; with no prior knowledge it takes about thirty clean peers before "they all do this" means
much, which a small application doesn't have; and it can't see a protection that is missing everywhere.

## 9. What is kept between runs

A project keeps a **book**, written by a command a person runs and reviewed like any other change:

- **Exceptions**, each with what it is, why, and who said so: "`/health` answers without a session: readiness probe".
- **The last accepted build**, for the `build` axis: the commit to compare this one against. Both builds are run in
  the same run, because digests made in different runs can't be compared (ALGORITHMS L2).
- **Local laws a person chose to adopt**: "every route under `/invoices` requires the tenant filter". From then on it
  is an ordinary claim.

A change is checked by testing the cells of the operations it touches, in a sandbox. Where a property can't be read
or an operation can't be reached, the cell is "can't tell", said out loud, never silence. A change to shared
configuration, such as a guard applied by path, touches every operation it covers. When a law is shown broken, the
report gives both runs and the first point where they part, and says that the difference may be deliberate and that a
person decides.

## 10. On a live host

Experiments need a sandbox for anything that changes state. On a live host the gate (FOUNDATION §6) allows less, and
the engine does less:

| Where | What runs |
|---|---|
| a sandbox | every axis |
| a test host, or an owned host, with `--active` | `who` for reads, `view`, `presentation`, `build`: requests that only read |
| the same, with `--allow-writes` and what the gate requires | `door`, `again` and `round trip`, with the inert values of ALGORITHMS D4, tagged for clean-up; `after` for a test account's own log-out |
| any other host | `presentation` and what a visitor sees |

`together`, `failure`, `who` for writes, and `after` for a deletion or a revocation are sandbox-only. Elsewhere their
cells read "can't tell: needs a sandbox", and a law that can't run at all is `blocked`.

## 11. Measuring the engine

- **Real defects first.** The main measure is defects that really happened: published advisories for missing
  authorisation, wrong ownership checks and races in open-source applications, each with the commit that fixed it. The
  engine is run on the commit before the fix; either it shows the defect or it doesn't.
- **Seeds second.** Defects planted on purpose (the **adversary**) fill in where history is thin. A seed counts only
  if whoever planted it also wrote the test that shows it, independent of the engine, so that the corpus isn't limited
  to what the engine already sees. Seeds the engine has no experiment for are counted, not discarded.
- **Held-out applications.** Anything fitted is fitted on some applications and reported on others.
- **Quiet where it should be.** On applications judged clean, what the engine reports is read by a person and
  labelled, and the labelling rules are published.
- **Nothing from customers.** Everything used is public or written for the purpose.

Numbers are given per axis and per kind of defect, never blended (ADR 0015).

## 12. What is known so far

This is a design, and this is the evidence for and against it as of the date above.

**Published work.** Each axis has evidence of its own, from separate tools, one axis at a time.

| Axis | What has been shown | Where the false alarms came from |
|---|---|---|
| who | A black-box tester that replays requests as another account, and reads the effect back from another page, found 89 vulnerabilities in 20 applications, 54 of them new. On changes to another user's data it raised no false alarm in 53 findings, where a widely used replay tool managed 62% precision. On reads, which it compares by similarity, 8 of its 44 reports were false alarms. An older study worked out what each role can reach and tried the rest by direct request, which is the "interface as intent" idea used here. | data meant to be public; pages with nothing sensitive; a fixed similarity threshold on pages that vary; an expired session |
| together | Reading the database traces of 12 shop applications turned up 22 exploitable races in 11 of them (stock, vouchers, carts). A person had to name each invariant and trigger each race by hand, about two hours apiece. A newer technique releases requests within a millisecond of each other. | races that a lock or a re-check prevents; timing |
| door | Limits a form enforces and the server doesn't were found in every one of six applications by one tool, and 47 across nine applications by its predecessor. | a refusal page that resembles success; limits the product doesn't really need |
| failure | In large data stores, 92% of catastrophic failures came from mishandling errors the software itself had signalled, and simple tests of the error paths would have caught 58%. Nothing comparable was found for web applications. | faults at points that can't fail; effects that rightly stay, such as a sent email |
| after | Rules of this kind on a stateful API tester (use after deletion; another user's namespace) found defects in production cloud services. | cached reads |
| again, round trip, view | No measured study was found. | what a server keeps for itself; deliberate normalisation; caches |

Three things follow. No published system or product was found that runs several axes together, from restored state,
with relations judged by content; the whole is unproven as well as new. The best-measured work says the two things
this design depends on: decide by content read back, never by the answer to the request, and reach the right state
first. And every source that needed the state to be the same got it by controlling or replacing what lies outside
the application, not by restoring it, which makes capsules the part of this design most likely to disappoint.

**First trial: peers as a detector. Failed.** Rules of the form "entities of a class share a property" were inferred
from two real codebases (a web API with 26 routes and 32 tables; a tool with 239 exported functions), and the 70
highest-ranked and randomly sampled exceptions were read by hand. None was a defect. Most were deliberate, a few were
misreadings, and the ranking did no better than chance. The method had no sense of direction, its score called weak
majorities rules, and both codebases already enforced their conventions with tests. The published successes of this
method are on very large codebases, with the things compared chosen by hand. It did produce, unprompted, the
list of every route that answers without a session. §8 is what was kept of it.

**Second trial: one forgotten protection, planted.** The method was given a direction (only "most have the
protection, this one lacks it" counts) and a sounder score, then frozen. A protection was removed from one place at a
time, 261 times, in the same two codebases, and each time the method was asked whether it noticed.

| Where | Planted omissions reported |
|---|---|
| a session required on an API route | 18 of 19 |
| queries scoped to the caller | 12 of 16 |
| the owner column on a table | 30 of 30 |
| the other protections on tables | 85 of 87 |
| input schema, rate limit, response model, commit | 0 of 14 |
| every guard in the tool's own source (7 kinds) | 0 of 95 |
| all | 145 of 261 (56%) |

Where a protection was already the norm in some class, a single omission was caught, and with the existing exceptions
listed it was the only thing reported. Where the protection was the minority, which was 11 of the 17 properties,
nothing was ever reported, however many were missing. No class with an exception reached a 0.9 lower bound on its
compliance: on codebases of this size the counts support "unusual" and never "wrong". The list of exceptions also
shifted when the accepted ones were taken out of the counts. Of fourteen real edits to source, the extractor saw
twelve; the two it missed were protections stated in two places.

So peers give a tripwire for one narrow kind of regression, where a protection is already the norm, and a law a
person declares once ("every route requires a session unless listed") does the same job with no statistics. That is
why §8 uses peers for a map and an order of testing and for nothing else.

**Not yet tested by anyone here:** the experiment engine as a whole; how complete a capsule can be made for a common
stack and how long a restore takes; how many cells a budget covers; how often a broken law turns out to be
deliberate.

**The cheapest next tests**, in order:

1. `who`, by hand-written script, on open-source applications at the commits before published access-control fixes:
   is the fixed route shown, and what else is?
2. A capsule for one stack, with the fidelity check: what moves?
3. `together` on the same applications: races found per hundred pairs tried.

## 13. Where it stands on the foundation

- A law is a shipped claim with failing examples (rule 5). Its runs are recorded before it is judged, and the judge
  reads only them and what derivations compute from them (rules 1 and 3). An experiment records no result of its own.
- An experiment is a collector's work: it passes the gate, request by request, and can never do on a live host what
  the table of effects forbids.
- Deriving footprints, digests and the order of testing is done by derivations, in integers, so that it gives the
  same result when re-run from a bundle.
- A broken law is a `fail` in the run that judged it, and counts toward "ready" only when the profile names it. The
  fold doesn't change.
- Entities and properties read from a repository are never sent to a model (ADR 0003). An agent proposing a path
  sees what a page shows, not the code.
- The adversary plants seeds only in copies of the public corpus, by a deny rule of the gate (FOUNDATION §6).

## 14. What it doesn't do

- It doesn't know intent, and doesn't find what is wrong only by intent.
- It doesn't prove a law holds. A cell that held was tested and wasn't broken, on the states reached.
- It can't test what it can't reach or restore, and says which cells those are.
- Comparing by content has false alarms of its own: data that is meant to be shared, and pages that vary by
  themselves. The checks in §5 reduce them and don't remove them.
- It needs a sandbox for most axes, and a recipe for the stack.
- It hasn't been built. Nothing on this page is a measured property of a product.
