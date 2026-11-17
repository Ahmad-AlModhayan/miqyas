# Miqyas: domain glossary

The words Miqyas's code, docs and agents use, one meaning each. Specs live in `docs/`; decisions that are hard to
reverse live in `docs/adr/`.

## The platform

**Verification platform**: the system any software passes through before anyone trusts it, across web, mobile,
desktop, server and industrial/factory surfaces. Miqyas is the platform, not an MCP server and not a standalone agent.

**Proof core**: the part of Miqyas that turns every check, from any source, into one recorded verdict with evidence and
coverage.

**Agent team**: the coordinated agents that propose: bindings, plans, what to crawl next, probes and faults to try on a
surface. A proposal is data that code checks, and it is never a verdict. _Avoid_: AI tester, bot.

**Surface**: the kind of software environment Miqyas verifies: web, mobile, desktop, server, or industrial/factory
system. Each is defined by the kinds of fact that can be recorded there and the actions that can be taken.

**Worker**: a collector that holds a live session on a surface, takes actions there and records facts. One surface
can have several: the server surface has an API worker and an engine worker. _Avoid_: driver, runner.

**Target**: the running software, binary, site or repository under verification on a surface. _Avoid_: SUT.

**Subject**: the exact thing a run verified, named by digest: a commit, a build directory, a binary. A URL is not a
subject. _Avoid_: artifact, build (alone).

**Entry point**: how Miqyas is invoked: one CLI command for a solo developer, a team CI gate before `ready`, an MCP
interface for a coding agent, or a self-hosted deployment where code and data never leave.

## Facts and proof

**Fact**: one typed measurement of a target, recorded with who measured it and what it is about. A fact never says pass
or fail. _Avoid_: observation (the old screenshot-and-tree bundle), data point, result.

**Collector**: anything that records facts by touching the world: a worker, an adapter, a reader of files, a probe. A
collector measures and never judges. _Avoid_: scanner (a tool an adapter runs).

**Adapter**: a collector that runs an outside tool (a scanner, a runner, a model checker or a prover) and records
what the tool was given and what it found. It adds facts and decides nothing.
_Avoid_: plugin, wrapper, integration.

**Substrate**: what Miqyas stands on to carry out what it decided: the browser and the library that drives it, the
database a target keeps its state in, the operating system, hash functions, a CEL library. It is borrowed, sits
behind one interface, and its version is recorded wherever it can change a verdict.
_Avoid_: dependency (wider: an outside tool is one too).

**Derivation**: a pure, versioned function that computes facts from facts, and can be re-run from a bundle to the same
result. _Avoid_: analysis, post-processing.

**Checker**: a derivation for a property no rule over items can express, such as a history being linearizable. Its
result is a fact in three values.

**Ledger**: the append-only record of one run: what Miqyas did, the facts it recorded, and one verdict per claim.
_Avoid_: results, report, log.

**Proof bundle**: the ledger of one run together with the evidence it points to, which anyone can re-check offline.
_Avoid_: report (a view of a bundle), artifact, archive.

**Seal**: the closing record of a run. A run with no seal did not finish and never passes.

**Head**: the size and root hash of a ledger at one moment. Publishing it somewhere its holder doesn't control fixes
what the bundle contained. _Avoid_: checksum, signature.

**Cassette**: the model answers recorded in one run's bundle, which a later run can replay without spending.
_Avoid_: recording, cache, fixture.

## Plans, claims and verdicts

**Plan**: a file (authored by a person or by the agent team) that names a target, the steps or faults to run on its
surface, and the assertions to check. _Avoid_: test, script.

**Scenario**: a run of an engine under test from a recorded random number: a schedule, a fault plan and the invariants
to check afterwards.

**Claim**: one thing that must be true of a target, written as data: what it covers, what must hold, and the coverage
it needs. It has one of four shapes: set, pair, trace or sample. _Avoid_: check (alone), expectation, test case.

**Assertion**: a plan step that says, in plain language, what must be true. It becomes a claim when it is bound.
_Avoid_: check, expectation, test case.

**Binding**: what a plain-language step was compiled to: the locators an action uses, or the claim an assertion means.
Made once with a model, reviewed by a person, replayed by code. _Avoid_: selector cache, compiled test.

**Anchored**: said of a binding whose claim holds the assertion's own quoted words, such that replacing them changes
the verdict.

**View**: the set of facts a claim is judged over, fixed and closed before the judge runs and recorded with the
verdict.

**Window**: the view of a plan's assertion: every snapshot from the end of the action before it until the page
settles or the step's time runs out.

**Witness**: the facts a pass rests on, which code can point to. A **counterexample** is the same for a fail.
_Avoid_: citation, proof (alone).

**Judge**: the code that turns one claim and its view into a verdict. A model is never the judge.

**Verdict**: what the judge recorded for one claim: `pass`, `fail`, or one of three kinds of not known. `blocked`
means the person must supply something; `not_checked` means Miqyas didn't establish it; `unverified` means it looked
like a pass on a basis not yet accepted. _Avoid_: result, status, outcome.

**Vacuous**: said of a claim over no items. It is `not_checked` unless the claim says an empty set is a pass and its
coverage rule shows the set really is empty.

**Fold**: the one function that turns a set of verdicts into a result: any fail gives fail, otherwise anything not
known gives not known, otherwise pass.

## Laws and experiments

**Law**: a relation that must hold between two runs of a target, or between two things the target states about
itself. A universal law is wrong to break whatever anyone intended, and ships with Miqyas; a local law is one a person
adopted for one project. _Avoid_: convention, pattern, heuristic, invariant (what a scenario checks).

**Experiment engine**: the part of Miqyas that runs experiments over a target's operations and reports which laws
were broken. The run engine is a different thing: it carries out one run.

**Operation**: one thing a target lets someone do: a route with a method, a control with its action.

**Experiment**: two runs from the same capsule that differ in exactly one thing, with checks in the same experiment
that the instrument worked. It records the runs and the checks and no result; whether the law held, was broken or
can't be told is the judge's answer on that record. _Avoid_: probe (a request), test.

**Axis**: the one thing in which the two runs of an experiment differ: who asks, through which door, how often, in
what order, under what failure, and the rest of the list in the engine's design.

**Reference run**: the run of an experiment that shows normal behaviour, against which the other is compared.
_Avoid_: control (a clean twin's word), baseline (the last build's behaviour).

**Matrix**: operations against axes. Each cell says whether the law held, was broken, wasn't tested or can't be told,
and the share of cells tested is the engine's coverage.

**Capsule**: a capture of what a sandboxed target holds, which can be restored or forked.
_Avoid_: snapshot (a `ui.snapshot` fact), checkpoint (of the ledger), backup.

**Recipe**: the description of one kind of stack: how to start it, which stores of state it keeps, and what a
capture does with each.

**Footprint**: what one action changed in a target's state: rows, requests, what the page shows, as far as the recipe
could see. _Avoid_: effect (what Miqyas does to a target), side effect.

**Entity**: one thing a target is made of: a route, a screen, a control, a field, a role, a table, a function.

**Property**: one observation about an entity: yes, no, or not known, with how it is known. It is protective (lacking
it is the risk), hazardous (having it is the risk) or descriptive. Not known is never read as no.

**Extractor**: a derivation that reads one kind of property from facts.

**Book**: the file in a project that keeps its accepted exceptions with their reasons, which build was last accepted,
and the local laws a person adopted.

**Adversary**: the part of Miqyas that plants seeds in the public corpus to measure the experiment engine. It uses no
customer's code.

## Exploration, checks, and faults

**Finding**: a problem Miqyas found that no claim asked about. It has a source, a severity and evidence. A finding is
never a pass or a fail and never carries a verdict, though a readiness check can rest on it. _Avoid_: issue, bug,
defect, alert.

**Source** (of a finding): where a finding came from: a derivation, an adapter, or the agent team.

**Unconfirmed**: a finding that no experiment, derivation or second look has backed yet.
_Avoid_: suspected, possible.

**Crawl**: Miqyas visiting screens or states of the target on its own, beyond the steps a plan names.
_Avoid_: exploration, spider, discovery.

**Explorer**: a part of Miqyas that searches one space a defect can hide in (states, inputs, combinations, who is
asking, interleavings, faults) and knows what it covered and when to stop. The crawl is the explorer of states.

**Target model**: what Miqyas knows about a target across runs: its states, the transitions between them, its routes
and who may call them. _Avoid_: site map, graph (alone).

**Oracle**: what decides that a recorded behaviour is wrong: a claim someone specified, a relation that must hold
between two runs, a thing that is wrong in any product, or a person or model looking.

**Effect**: one thing Miqyas does to a target or lets out of the machine. On a target it has a class: observe,
interact, probe, write or disrupt. _Avoid_: action (a plan step), operation.

**Gate**: the one place every effect passes, which allows or refuses it by its class and the class of the origin it
lands on, and records the decision. _Avoid_: policy check, guard, firewall.

**Permit**: what the gate hands a collector: one origin, up to one class of effect. _Avoid_: scope, capability, token.

**Active check**: a check that needs the probe effect or higher: it sends requests the interface wouldn't send.
Outside a sandbox it runs only when the person opts in, and only against a test host or an owned host.
_Avoid_: attack, scan, pentest.

**Fault injection**: a deliberate failure applied to a target or its environment (dropped connections, HTTP errors,
restarts, clock skew, or build mutations) to verify that assertions and invariants hold under failure. It is the
disrupt effect.

**Sandbox**: an origin served by a process Miqyas started itself for one run, which it can throw away. Every effect is
allowed there except what the never-do list forbids everywhere.
_Avoid_: test host (a host someone else runs), staging, mock.

**Test host**: a host whose name marks it as not production: localhost, `.localhost`, `.test`, or a label such as
staging, dev, test or qa. One on this machine is local; one known only by a label in a public name is named.

**Owned host**: a host named with `--allow-host` whose owner has proven, with a token Miqyas prints, that active
checks may run on it.
_Avoid_: verified host, trusted host, allowed host.

**Backend**: an origin the target's own pages call. It takes its consent from the origin that calls it.

## Readiness and coverage

**Readiness check**: a claim Miqyas ships as part of a profile, judged by code into the ledger like any other claim.
The findings it turns up are its evidence. _Avoid_: scan, rule, audit.

**Coverage**: what a claim's enumeration reached (screens, states, files, tables or endpoints, and requests), against
a stated denominator, and whether that met the claim's coverage rule. _Avoid_: scope.

**Profile**: a named, versioned set of readiness checks for one grade, which a person chooses to run.
_Avoid_: preset (a set of mutations), suite, scan.

**Grade**: the level of readiness a profile targets. Grade 1 is an indie or vibe-coded launch, Grade 2 a startup or
SaaS, Grade 3 an enterprise or regulated system. A person chooses the grade; Miqyas never awards one.
_Avoid_: level, score, tier (the model tier).

**Ready**: a profile's result when every readiness check in it has a recorded pass. Anything else is not ready.
_Avoid_: certified, compliant, secure.

**Pillar**: one of the eight areas readiness checks are grouped under in a report (code and logic, UI states and
flows, data and money, APIs and third parties, security and tenant isolation, performance and cost, operations, AI
and compliance). _Avoid_: category (a corpus seed's kind).

**Depth**: how far a verdict can be re-checked from its bundle: from the facts alone, by re-running derivations too,
or only by measuring again.

**Kind of assurance**: what sort of evidence stands behind a pass: tested (it held on what was run), bounded (a tool
checked every case up to a stated bound), or proved. _Avoid_: confidence (a number for a sample claim), score.

## Spending and proving

**Quote**: the free estimate Miqyas prints before any run that would call a model: the likely cost, the worst case,
and today's spend. _Avoid_: estimate, preview.

**Cap**: the dollar amount a person types after a quote; the run may not spend past it. The daily cap bounds what one
device spends in a day. _Avoid_: limit.

**Budget**: the time and the money a run may spend: its time limit and its cap.

**Tier**: how capable, and how costly, a model a run uses: low, medium or high. _Avoid_: level, grade.

**Corpus**: the set of target systems with defects planted on purpose, used to score Miqyas offline.
_Avoid_: benchmark, test suite.

**Seed**: one defect planted on purpose in the corpus. A number that fixes random choices is always written "random
seed". _Avoid_: mutant (today's mutation presets), bug.

**Part** (of the corpus score): one of three groups of seeds, scored apart and never blended: asserted (a plan asserts
the defect), unasserted (no plan names it) and readiness (a readiness check must catch it). _Avoid_: half.

**Clean twin**: the same target with no seed, on which every check must stay quiet. _Avoid_: baseline, control.

**Sensitivity**: evidence that a pass could have failed: the claim was re-judged on a broken copy of what it read, or
of the target, and failed. It is not a measure of how many real defects Miqyas finds, nor the share of seeds
the engine shows. _Avoid_: recall, strength.
