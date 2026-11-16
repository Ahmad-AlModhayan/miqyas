# Miqyas: the map

The whole system on one page: what the parts are, how one run flows through them, where each is specified, and what
makes the design strong. The [foundation](FOUNDATION.md) specifies the parts that make a verdict trustworthy; the
[experiment engine](ENGINE.md) specifies how defects are found with nothing written in advance;
[ALGORITHMS.md](ALGORITHMS.md) specifies what each part computes; the [ADRs](adr/) say why.

This is a design. Section 5 says what it doesn't claim, and what has already been tried and dropped.

## 1. The system

```
                 ENTRY POINTS      CLI · CI gate · MCP · self-hosted            one control protocol
                                            │
 ┌─────────────────────────────────── RUN ENGINE ───────────────────────────────────┐
 │   resolve claims → match to collectors → fit to limits → collect → judge → seal   │
 └───────┬──────────────────────────────┬──────────────────────────────┬────────────┘
         │ what must be true            │ how to find out              │ what the result is worth
         ▼                              ▼                              ▼
     CLAIMS  (data)               EXPERIMENT ENGINE                ASSURANCE
     laws that hold whatever      two runs from one restored       the matrix of operations
     anyone intended;             state that differ in one         against axes; per claim:
     a project's own laws;        thing: who, door, again,         coverage, how it was seen
     plans and their              together, failure, …             to fail, kind of evidence,
     bindings; profiles           CAPSULES: restorable state       how far it re-checks
         │                        EXPLORERS: reaching states
         │                              │
         │                       COLLECTORS    workers (web, api, engine, …) · adapters · readers · probes
         │                              │  every action
         │                              ▼
         │                          THE GATE ───────►  target · model · tool · network
         │                              │  facts and effect records
         ▼                              ▼
     THE JUDGE  ◄───────────  LEDGER + evidence  =  the PROOF BUNDLE  ───────►  verify · reports · gate · attest
     a pure function,                   │
     three values, one fold         DIAGNOSIS    where two runs part · the smallest failing case · the culprit change
```

Read it as three questions asked of a target, and one record that answers for all three:

- **What must be true?** Claims, as data. Some are written by a person. The ones that matter most here are laws
  nobody has to write, because breaking them is wrong whatever anyone intended.
- **How do we find out?** By experiment: two runs from the same state that differ in one thing. Collectors carry the
  runs out through the gate and record facts. Nothing in this column says pass or fail.
- **What is the result worth?** For every operation and every axis: tested or not, held or broken, and why not when it
  can't be told.
- **The record.** Everything Miqyas did and saw goes into one append-only ledger. The judge reads only that. Anyone
  can read it again.

## 2. The parts

| Part | What it does | Specified in | Functions |
|---|---|---|---|
| Kernel | holds the ledger, judges claims, folds verdicts, verifies bundles | FOUNDATION §4, §5 | ALGORITHMS A, K |
| Gate | classes every request at the wire and every origin, allows or refuses, records the decision | FOUNDATION §6 | B |
| Workers | hold a session on a surface, take actions, record facts | FOUNDATION §7 | F4 |
| Collectors | adapters around existing tools, readers of files, probes | FOUNDATION §3, §7 | |
| Run engine | turns a request into a graph of collection, runs it, judges each claim when its facts are closed | FOUNDATION §10 | E |
| Experiment engine | runs pairs of runs over a target's operations and reports which laws were broken | ENGINE | L |
| Capsules | capture, restore and fork a sandboxed target's state, and check that it came back the same | ENGINE §6 | M |
| Plans and bindings | plain-language steps, bound once to locators and claims, replayed by code | FOUNDATION §8 | A3, A7 |
| Claims and profiles | what Miqyas ships to check, as files | FOUNDATION §9 | A1 to A4 |
| Target model | the states, transitions, routes and roles of a target, kept across runs | FOUNDATION §11 | C |
| Explorers | reach the states and inputs worth testing, and know when to stop | FOUNDATION §11, ENGINE §7 | D, M5 |
| Oracles | decide something is wrong when nobody wrote an assertion | ENGINE §2, §3 | F, L |
| Assurance | records what each verdict is worth; never one number | FOUNDATION §4 | G, L9 |
| Diagnosis | shows where two runs part, shrinks a failure, finds the change that caused it | FOUNDATION §11 | H, M6 |
| Measuring | scores the experiment engine on real defects and on seeds | ENGINE §11 | N |
| Agents | propose bindings, plans, paths to a state; never a verdict | FOUNDATION §12 | |
| Entry points | CLI, CI gate, MCP, self-hosted: clients of one protocol | FOUNDATION §13 | |

## 3. One run, end to end

1. A person asks: this target, these plans, this profile, these grants, this much time and money.
2. The run engine gathers the claims and works out which facts each needs and which collectors can record them.
   Whatever can't be checked is settled now as `blocked`, with what to add. Nothing has touched the target yet.
3. In a sandbox, the experiment engine brings the target to a state worth testing, captures it, and checks that a
   restore gives the same state back.
4. For each operation and each axis, it forks that state twice: once for the reference run, once changed in one
   thing. Every request goes to the gate, which classes it from the request itself, allows or refuses, and writes
   down the decision. What comes back is recorded as facts.
5. When the runs for a claim have closed, the judge runs once on that fixed set and records a verdict: the law held,
   was broken, or can't be told, with the facts it read.
6. The run is sealed. Its result is the fold of its verdicts, the report is the matrix, and the head of the ledger is
   printed.
7. Later, anyone runs `miqyas verify` on the bundle and gets the same verdicts, with no target, no model and no
   network.

## 4. What makes this the strongest design

A verifier is only as strong as the weakest of five abilities: what it can state, what it can reach, how well it
searches, whether its verdicts can be trusted, and whether its silence means anything. This design is built so that
none of the five is the weak one, and so that what follows is enforced by code and not by care.

**1. It finds what is wrong with nothing written in advance.**
One account receiving another's records, a server storing what its own form forbids, two requests at once leaving a
state neither order could, a failure leaving half a change: each is wrong whatever the developer intended, so no
specification is needed to call it. Each is also a fact about two runs, which no tool that looks at one run at a time
can see. The engine makes pairs of runs its unit of work.

**2. Every finding is an experiment, not an opinion.**
Two runs from the same restored state, differing in one thing, with checks in the same experiment that the record
exists and the other identity is live. Content decides, never a status code: a law is broken only when the other
account's response carries the owner's data, or the stored row holds the forbidden value. Both runs are in the ledger.

**3. Its silence is measured.**
The report is a matrix of operations against axes. Each cell is held, broken, not tested or can't tell, with why. A
row of `held` and a row nobody tested are different things and look different. Where a law can only be shown to hold
in a number of tries, the number is printed.

**4. It tests from state it can put back.**
A capsule captures what a sandboxed target holds. Before any experiment the engine restores it and checks the target
answers as it did; if it doesn't, the experiments are "can't tell", not guesses. What an action changed is measured
as the difference between two states, not inferred from a response.

**5. A pass is a computation anyone can repeat.**
Every verdict is a pure function of recorded facts. No clock, no model and no network take part in judging, and
`verify` recomputes each verdict offline. Each verdict says how far it can be re-checked.

**6. It refuses to trust a check that has never failed.**
No claim contributes a pass until it has been seen to fail, on an example it ships with or on the very facts it was
bound on. A hollow check can't pass in the first place.

**7. It can state what other tools can't.**
Four shapes of claim: about a set of things, about a relation between two runs or two users, about order and time
within a session, and about a rate with a confidence. All four are data, judged by one engine in the same three
values.

**8. A model can't make it pass.**
No model judges at run time. A model binds a plain-language step once, or proposes a path to a state; code tests what
it proposed. A page has no judge to talk to.

**9. It is safe to point at anything.**
One gate classes each request from the request and each origin by what was established about it. The crawl can't
change a target even by accident. Experiments that change state run only in a sandbox Miqyas started. The bundle
shows everything that was done, refused requests included.

**10. It uses the world's tools and is honest about what each proves.**
Scanners, runners, model checkers and provers come in as collectors. Their word is never taken for what they covered,
and each verdict is labelled tested, checked to a bound, or proved. There is no blended score.

**11. One engine, every surface.**
A surface is a vocabulary of facts. A browser, an API, a command-line program, a sync engine under faults and a
factory controller differ in what they record; the claims, the judge, the gate and the record are the same.

**12. It is measured on real defects, and says what failed.**
The engine is scored on defects that really happened, at the commit before each fix, then on seeds; per axis, never
blended; with "no experiment exists for this" as its own count. The first idea for this core was put to that kind of
test before it was written into the design, and was dropped when it failed (§5).

In one sentence: **Miqyas shows a defect as two recorded runs that differ in one thing and break a law nobody had to
write, and every pass it gives is a computation over recorded evidence that anyone can repeat.**

## 5. What the design doesn't claim

- **That it has been built.** Nothing here is a measured property of a product. The published evidence for each axis
  comes from separate tools, one axis at a time; running them together from restored state is new and unproven.
- **That inference from peers finds defects.** It was tried: rules of the form "things of this kind share this
  property" were inferred from two real codebases, and none of 70 exceptions read by hand was a defect. A second
  trial planted 261 omissions: the method noticed 56%, all of them where the protection was already the norm, and
  none where it was the minority. It is kept as a map of where a protection is missing and as an order of testing
  (ENGINE §8, §12).
- **That a collector recorded the target faithfully.** A bundle proves the verdicts follow from the facts, not that
  the facts are the world.
- **That a cell which held proves a law.** It was tested on the states reached and wasn't broken.
- **That it knows intent.** What is wrong only because someone meant otherwise needs a written assertion.
- **That it replaces a penetration test, an audit or a certification.**

## 6. Order of building

Each step needs the ones before it. Nothing here is a date.

1. **The kernel**: ledger, the judge for `set` and `pair` claims, the fold, `verify`; one check end to end.
2. **The gate**: wire rules, origin classes, permits; every collector behind it.
3. **Two workers**: web and API, recording facts on the new contract.
4. **The thirteen checks as claims.** Checks 9 and 10 are the `who` axis already, by hand.
5. **A capsule for one stack**, with the fidelity check. The first measurement: what moves on a restore.
6. **The `who` axis in full**, judged by content, and measured on real access-control defects at the commits before
   their fixes. This is the first test of the engine's premise, and comes before the other axes are built.
7. **Plans**: `trace` claims over windows, bindings, bound replay, the binder; reaching states.
8. **`door`, `again`, `round trip`, `after`, `view`**: the axes that need one identity and a footprint.
9. **`together` and `failure`**: the axes that need control of timing and of faults.
10. **Reports as the matrix**; the old path deleted; the book.
11. **`sample` claims**, the target model, diagnosis.
12. **More surfaces**: the engine worker, then desktop, mobile, command-line.
13. **Outward**: adapters for more tools, provers included; attestation and `gate`; workers in their own process; MCP.
