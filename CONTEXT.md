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

**Target**: the running software, binary, site or repository under verification on a surface. _Avoid_: SUT.

**Subject**: the exact thing a run verified, named by digest: a commit, a build directory, a binary, or the manifest of
what a URL served during the run. _Avoid_: artifact, build (alone).

**Entry point**: how Miqyas is invoked: one CLI command for a solo developer, a team CI gate before `ready`, an MCP
interface for a coding agent, or a self-hosted deployment where code and data never leave.

## Facts and proof

**Fact**: one typed measurement of a target, recorded with who measured it and what it is about. A fact never says pass
or fail. _Avoid_: observation (the old screenshot-and-tree bundle), data point, result.

**Collector**: anything that records facts: a surface worker, an adapter, a reader of files, a probe. A collector
measures and never judges. _Avoid_: checker, scanner (the tools an adapter runs).

**Adapter**: a collector that runs an existing tool (a runner, driver or scanner) without rebuilding it, and records
what the tool was given and what it found.
_Avoid_: plugin, wrapper, integration.

**Ledger**: the append-only record of one run: what Miqyas did, the facts it recorded, and one verdict per claim.
_Avoid_: results, report, log.

**Proof bundle**: the ledger of one run together with the evidence it points to, which anyone can re-check offline.
_Avoid_: report (a view of a bundle), artifact, archive.

**Seal**: the closing record of a run, after which the bundle's head is taken. A run with no seal did not finish and
never passes.

**Cassette**: the model answers recorded in one run's bundle, which a later run can replay without spending.
_Avoid_: recording, cache, fixture.

## Plans, claims and verdicts

**Plan**: a file (authored by a person or by the agent team) that names a target, the steps or faults to run on its
surface, and the assertions to check. _Avoid_: test, script, scenario.

**Claim**: one thing that must be true of a target, written as data: the items it covers, what must hold for each, and
the coverage it needs. Assertions and readiness checks are claims. _Avoid_: check (alone), expectation, test case.

**Assertion**: a claim written in a plan, by a person or by the agent team, in plain language. _Avoid_: check,
expectation, test case.

**Binding**: what a plain-language step was compiled to: the locators an action uses, or the claim an assertion means.
Made once with a model, reviewed by a person, replayed by code. _Avoid_: selector cache, compiled test.

**Witness**: the facts a pass rests on, which code can point to. _Avoid_: citation, proof (alone).

**Judge**: the code that turns one claim and the recorded facts into a verdict. A model is never the judge.

**Verdict**: what the judge recorded for one claim: `pass`, `fail`, or one of three kinds of not known. `blocked`
means the person must supply something; `not_checked` means Miqyas didn't establish it; `unverified` means it looked
like a pass on a basis not yet accepted. _Avoid_: result, status, outcome.

## Exploration, checks, and faults

**Finding**: a problem Miqyas found that no claim asked about. It has a source, a severity and evidence. A finding is
never a pass or a fail and never carries a verdict, though a readiness check can rest on it. _Avoid_: issue, bug,
defect, alert.

**Source** (of a finding): where a finding came from: a code check, an adapter, the agent team, or a crawl.

**Unconfirmed**: a finding an agent proposed that no code check or second look has backed yet.
_Avoid_: suspected, possible.

**Crawl**: Miqyas visiting screens or states of the target on its own, beyond the steps a plan names.
_Avoid_: exploration, spider, discovery.

**Effect**: one thing Miqyas does to a target or lets out of the machine. On a target it has a class: observe,
interact, probe, write or disrupt. _Avoid_: action (a plan step), operation.

**Gate**: the one place every effect passes, which allows or refuses it by its class and the target's environment, and
records the decision. _Avoid_: policy check, guard, firewall.

**Active check**: a check that needs the probe effect or higher: it sends requests the interface wouldn't send. Runs
only when the person opts in, and only against a sandbox, a test host or an owned host.
_Avoid_: attack, scan, pentest.

**Fault injection**: a deliberate failure applied to a target or its environment (dropped connections, HTTP errors,
restarts, clock skew, or build mutations) to verify that assertions and invariants hold under failure. It is the
disrupt effect.

**Sandbox**: a target Miqyas started itself for one run and can throw away. Every effect is allowed there.
_Avoid_: test host (a host someone else runs), staging, mock.

**Test host**: a host whose name marks it as not production: localhost, `.localhost`, `.test`, or a label such as
staging, dev, test or qa.

**Owned host**: a host whose owner has proven, with a token Miqyas prints, that active checks may run on it.
_Avoid_: verified host, trusted host, allowed host.

## Readiness and coverage

**Readiness check**: a claim Miqyas ships as part of a profile, judged by code into the ledger like any other claim.
The findings it turns up are its evidence. _Avoid_: scan, rule, audit.

**Coverage**: what a claim's enumeration reached (screens, states, files, tables or endpoints, and requests) and
whether that met the claim's coverage rule. _Avoid_: scope.

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

## Spending and proving

**Quote**: the free estimate Miqyas prints before any run that would call a model: the likely cost, the worst case,
and today's spend. _Avoid_: estimate, preview.

**Cap**: the dollar amount a person types after a quote; the run may not spend past it. The daily cap bounds what one
device spends in a day. _Avoid_: budget, limit.

**Tier**: how capable, and how costly, a model a run uses: low, medium or high. _Avoid_: level, grade.

**Corpus**: the set of target systems with defects planted on purpose, used to score Miqyas offline.
_Avoid_: benchmark, test suite.

**Seed**: one defect planted on purpose in the corpus. _Avoid_: mutant (today's mutation presets), bug.

**Part** (of the corpus score): one of three groups of seeds, scored apart and never blended: asserted (a plan asserts
the defect), unasserted (no plan names it) and readiness (a readiness check must catch it). _Avoid_: half.

**Clean twin**: the same target with no seed, on which every check must stay quiet. _Avoid_: baseline, control.

**Sensitivity**: evidence that a pass could have failed: the claim was re-evaluated on a broken copy of what it read,
or of the target, and failed. It is not a measure of how many real defects Miqyas finds. _Avoid_: recall, strength.
