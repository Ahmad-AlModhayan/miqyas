# Miqyas: domain glossary

The words Miqyas's code, docs and agents use, one meaning each. Specs live in `docs/`; decisions that are hard to
reverse live in `docs/adr/`.

## The platform

**Verification platform**: the system any software passes through before anyone trusts it, across web, mobile,
desktop, server and industrial/factory surfaces. Miqyas is the platform, not an MCP server and not a standalone agent.

**Proof core**: the part of Miqyas that turns every check, from any source, into one recorded verdict with evidence and
coverage.

**Agent team**: the coordinated agents that understand the software, author plans, crawl states, run active checks
and inject faults on a surface, with every result recorded through the proof core. _Avoid_: AI tester, bot.

**Surface**: the kind of software environment Miqyas verifies: web, mobile, desktop, server, or industrial/factory
system.

**Target**: the running software, binary, site or repository under verification on a surface. _Avoid_: SUT.

**Entry point**: how Miqyas is invoked: one CLI command for a solo developer, a team CI gate before `ready`, an MCP
interface for a coding agent, or a self-hosted deployment where code and data never leave.

## Plans and verdicts

**Plan**: a file (authored by a person or by the agent team) that names a target, the steps or faults to run on its
surface, and the assertions to check. _Avoid_: test, script, scenario.

**Assertion**: one thing (written by a person or by the agent team) that must be true of the target. Miqyas judges it
into the ledger as pass or fail, with evidence. _Avoid_: check, expectation, test case.

**Ledger**: the record of one verdict with evidence per assertion. A plan passes only when every assertion in it has
a recorded pass. _Avoid_: results, report.

## Exploration, checks, and faults

**Finding**: a problem Miqyas found that no assertion asked about. It has a source, a severity and evidence. A
finding is never a pass or a fail and never enters the ledger as a verdict, though a readiness check can cite it as
evidence. _Avoid_: issue, bug, defect, alert.

**Source** (of a finding): where a finding came from: a code check, an adapter, the agent team, or a crawl.

**Unconfirmed**: a finding an agent proposed that no code check or second look has backed yet.
_Avoid_: suspected, possible.

**Crawl**: Miqyas visiting screens or states of the target on its own, beyond the steps a plan names.
_Avoid_: exploration, spider, discovery.

**Active check**: a security check that acts against the target (sends payloads, uses a second session) instead of only
watching it. Runs only when the person opts in, and only against a test host or an owned host.
_Avoid_: attack, scan, pentest.

**Fault injection**: a deliberate failure applied to a target or its environment (dropped connections, HTTP errors,
restarts, clock skew, or build mutations) to verify that assertions and invariants hold under failure.

**Test host**: a host whose name marks it as not production: localhost, `.localhost`, `.test`, or a label such as
staging, dev, test or qa.

## Readiness and coverage

**Readiness check**: an assertion Miqyas writes itself, as part of a profile, judged by code into the ledger like any
other assertion. The findings it turns up are its evidence. _Avoid_: scan, rule, audit.

**Coverage**: what a readiness check reached: screens, states, files, tables or endpoints, and requests.
_Avoid_: scope.

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

**Cassette**: the recorded model answers of one run, which a later run can replay without spending.
_Avoid_: recording, cache, fixture.

**Corpus**: the set of target systems with defects planted on purpose, used to score Miqyas offline.
_Avoid_: benchmark, test suite.

**Seed**: one defect planted on purpose in the corpus. _Avoid_: mutant (today's mutation presets), bug.

**Part** (of the corpus score): one of three groups of seeds, scored apart and never blended: asserted (a plan asserts
the defect), unasserted (no plan names it) and readiness (a readiness check must catch it). _Avoid_: half.

**Clean twin**: the same target with no seed, on which every check must stay quiet. _Avoid_: baseline, control.

**Owned host**: a host whose owner has proven, with a token Miqyas prints, that active checks may run on it.
_Avoid_: verified host, trusted host, allowed host.

**Adapter**: the part of Miqyas that runs an existing tool (a runner, driver or scanner) without rebuilding it and
reports what it covered.
_Avoid_: plugin, wrapper, integration.
