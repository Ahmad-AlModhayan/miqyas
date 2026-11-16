# Miqyas: the map

The whole system on one page: what the parts are, how one run flows through them, where each is specified, and what
makes the design strong. The [foundation](FOUNDATION.md) specifies the parts; [ALGORITHMS.md](ALGORITHMS.md) specifies
what each computes; the [ADRs](adr/) say why.

## 1. The system

```
                 ENTRY POINTS      CLI · CI gate · MCP · self-hosted            one control protocol
                                            │
 ┌─────────────────────────────────── RUN ENGINE ───────────────────────────────────┐
 │   resolve claims → match to collectors → fit to limits → collect → judge → seal   │
 └───────┬──────────────────────────────┬──────────────────────────────┬────────────┘
         │ what must be true            │ how to look                  │ what the result is worth
         ▼                              ▼                              ▼
     CLAIMS  (data)                  SEARCH                        ASSURANCE
     four shapes: set, pair,         an explorer for each space    per claim: coverage, confidence,
     trace, sample                   a defect hides in;            how it was seen to fail, kind of
     profiles; plans and             the target model;             evidence, how far it re-checks
     their bindings                  budget goes where
         │                           coverage grows
         │                              │
         │                       COLLECTORS    workers (web, api, engine, …) · adapters · readers · probes
         │                              │  every action
         │                              ▼
         │                          THE GATE ───────►  target · model · tool · network
         │                              │  facts and effect records
         ▼                              ▼
     THE JUDGE  ◄───────────  LEDGER + evidence  =  the PROOF BUNDLE  ───────►  verify · reports · gate · attest
     a pure function,                   │
     three values, one fold         DIAGNOSIS    the smallest failing case · the culprit change · the suspect code
```

Read it as three questions asked of a target, and one record that answers for all three:

- **What must be true?** Claims, as data. A plan's assertion, a readiness check, an invariant and an imported test are
  the same thing to the engine.
- **How do we look?** Collectors measure the target through the gate and record facts. Explorers decide where to look
  next. Nothing in this column says pass or fail.
- **What is the result worth?** For every verdict: what was covered, how sure, by what kind of evidence.
- **The record.** Everything Miqyas did and saw goes into one append-only ledger. The judge reads only that. Anyone
  can read it again.

## 2. The parts

| Part | What it does | Specified in | Functions |
|---|---|---|---|
| Kernel | holds the ledger, judges claims, folds verdicts, verifies bundles | FOUNDATION §4, §5 | ALGORITHMS A, K |
| Gate | classes every request at the wire and every origin, allows or refuses, records the decision | FOUNDATION §6 | B |
| Workers | hold a session on a surface, take actions, record facts | FOUNDATION §7 | F4 |
| Collectors | adapters around existing tools, readers of files, probes | FOUNDATION §3, §7 | |
| Engine | turns a request into a graph of collection, runs it, judges each claim when its facts are closed | FOUNDATION §10 | E |
| Plans and bindings | plain-language steps, bound once to locators and claims, replayed by code | FOUNDATION §8 | A3, A7 |
| Claims and profiles | what Miqyas ships to check, as files | FOUNDATION §9 | A1 to A4 |
| Target model | the states, transitions, routes and roles of a target, kept across runs | FOUNDATION §11 | C |
| Explorers | search each space a defect hides in, and know when to stop | FOUNDATION §11 | D |
| Oracles | decide something is wrong when nobody wrote an assertion | FOUNDATION §11 | F |
| Assurance | records what each verdict is worth; never one number | FOUNDATION §4, §11 | G |
| Diagnosis | shrinks a failure, finds the change that caused it, ranks suspect code | FOUNDATION §11 | H |
| Economy | reuses results, re-runs only what a change calls for | FOUNDATION §11 | I |
| Agents | propose bindings, plans, where to look; never a verdict | FOUNDATION §12 | D9 |
| Entry points | CLI, CI gate, MCP, self-hosted: clients of one protocol | FOUNDATION §13 | |

## 3. One run, end to end

1. A person asks: this target, these plans, this profile, these grants, this much time and money.
2. The engine gathers the claims and works out which facts each needs and which collectors can record them. Whatever
   can't be checked is settled now as `blocked`, with what to add. Nothing has touched the target yet.
3. Collectors run. Each action goes to the gate, which classes it from the request itself, checks the class of the
   origin it lands on, allows or refuses, and writes down the decision. What comes back is recorded as facts.
4. When every collector that could add to a claim's facts has closed, the judge runs once on that fixed set and
   records a verdict: pass, fail, or one of three kinds of "not known", with the facts it read.
5. The run is sealed. Its result is the fold of its verdicts, and the head of the ledger is printed.
6. Later, anyone runs `miqyas verify` on the bundle and gets the same verdicts, with no target, no model and no
   network.

## 4. What makes this the strongest design

A verifier is only as strong as its weakest of five abilities: what it can state, what it can reach, how well it
searches, whether its verdicts can be trusted, and whether its silence means anything. Tools usually excel at one. This
design is built so that none of the five is the weak one, and so that the claims below are enforced by code and not
by care.

**1. A pass is a computation anyone can repeat.**
Every verdict is a pure function of recorded facts. No clock, no model and no network take part in judging. The record
is append-only and hashed, and `verify` recomputes each verdict from it. Each verdict also says how far it can be
re-checked: from the facts alone, by re-running derivations, or only by measuring again. A tool that prints "passed"
asks to be believed; this one can be checked.

**2. It refuses to trust a check that has never failed.**
No claim contributes a pass until it has been seen to fail: on an example it ships with, or, for a binding, on the
very facts it was bound on, with its key text replaced. The usual practice is to find out afterwards, with mutation
testing, how many checks were hollow. Here a hollow check can't pass in the first place.

**3. Its silence is measured.**
"Nothing found" is never a pass by itself. An absence passes only when the claim's coverage rule holds, over a set
Miqyas enumerated itself, with the denominator stated. A crawl says why it stopped and how likely one more step was to
find something new. A statistical claim says how many samples stand behind it and at what confidence, and "too few
samples" is an answer.

**4. It can state what other tools can't.**
Four shapes of claim cover what a property can be about: a set of things, a relation between two runs or two users,
order and time within a session, and a rate with a confidence. "One account can't read another's records", "no error
appears before the page settles" and "99 in 100 answers arrive within a second, at 95% confidence" are each one line
of data, judged by the same engine, with the same three values.

**5. It looks in every space a defect hides in, and knows what it covered in each.**
States and sequences, inputs, combinations of settings, who is asking, the order of concurrent work, and what fails
underneath: each has its own explorer, its own measure with a denominator, and its own rule for stopping. The budget
goes to whichever explorer is still finding new ground. Every failure exploration finds is shrunk to its smallest
form and kept as a plan.

**6. A model can't make it pass.**
No model judges at run time. A model binds a plain-language step once to a rule; code tests that the rule is tied to
the words and can fail; a person reviews it as a diff; after that it replays with no model, the same every time, at no
cost. A page has no judge to talk to. Agents propose where to look and what to try, and are fed budget only when what
they propose adds coverage.

**7. It is safe to point at anything.**
One gate stands between Miqyas and the world. It classes each request from the request, not from what the caller says
it is, and each origin by what was established about it, not by what was claimed. The crawl can't change a target
even by accident, because a request that would is stopped at the wire. The strongest checks (faults, writes, mutation)
run in a sandbox Miqyas started, where nothing is at risk. And the bundle shows everything that was done to the
target, refused requests included.

**8. It uses the world's tools and is honest about what each proves.**
Scanners, test runners, model checkers and provers come in as collectors. Their output becomes facts; their word is
never taken for what they covered. Each verdict is labelled with the kind of evidence behind it: tested, checked to a
bound, or proved. There is no score that blends them.

**9. When something fails, it says what, since when, and where.**
A failure comes with the smallest input that still triggers it, the change that introduced it, a ranking of the code
to look at first, and a bundle that replays it. A failing claim is re-run to tell a broken thing from a flaky one, and
a pass on a retry never erases a failure.

**10. One engine, every surface.**
A surface is a vocabulary of facts. A browser, an API, a command-line program, a sync engine under fault injection and
a factory controller differ in what they record and what they can do; the claims, the judge, the gate, the record and
the assurance are the same.

**11. It holds itself to the same standard.**
The judge's guarantees are tested with generated inputs, and its own tests are mutation-tested. Every shipped check
must catch its planted defects and stay quiet on the clean twin, per release, and that run is itself a proof bundle.

In one sentence: **every pass Miqyas gives is a computation over recorded evidence that anyone can repeat, at a
coverage that was measured, by a check that was seen to fail, on any surface and with any tool.**

## 5. What the design doesn't claim

- That a collector recorded the target faithfully. A bundle proves the verdicts follow from the facts, not that the
  facts are the world. Planted defects and clean twins are the check on collectors.
- That passing means there is no defect. Sensitivity shows a check can fail; it isn't the share of real defects found.
- That estimates are measurements. The chance of finding a new state, and the bound on a failure rate, come with
  assumptions that are stated beside them.
- That it replaces a penetration test, an audit or a certification.
- That any of this is true before it is built and the numbers are published. This is a design.

## 6. Order of building

Each step needs the ones before it. Nothing here is a date.

1. **The kernel**: ledger, the judge for `set` claims, the fold, `verify`; one check end to end.
2. **The gate**: wire rules, origin classes, permits; every collector behind it.
3. **Two workers**: web and API, recording facts on the new contract.
4. **The thirteen checks as claims**, with `pair` claims for the ones about two users.
5. **Plans**: `trace` claims over windows, bindings, bound replay, then the binder.
6. **Reports** from the bundle; the old path deleted.
7. **The target model and the explorers**: states, saturation, inputs, combinations, the authorisation matrix.
8. **Assurance and diagnosis**: the record per claim, sandbox mutation, shrinking, bisecting, ranking.
9. **`sample` claims** and the statistics behind them.
10. **The engine worker**: histories, faults, checkers. Then desktop, mobile, command-line.
11. **Outward**: adapters for more tools, provers included; attestation and `gate`; workers in their own process; MCP.
