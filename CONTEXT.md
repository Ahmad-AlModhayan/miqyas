# Miqyas: domain glossary

The words Miqyas's code, docs and agents use, one meaning each. Specs live in `docs/`; decisions that are hard to
reverse live in `docs/adr/`.

## What a person asks for

**Plan**: a file a person writes that names an app, the steps to take in it, and the assertions to check.
_Avoid_: test, script, scenario.

**Assertion**: one thing a person wrote down that must be true of the app. Miqyas judges it into the ledger as pass
or fail, with evidence. _Avoid_: check, expectation, test case.

**Ledger**: the record of one verdict with evidence per assertion. A plan passes only when every assertion in it has
a recorded pass. _Avoid_: results, report.

## What Miqyas finds on its own

**Finding**: a problem Miqyas found that no assertion asked about. It has a source, a severity and evidence. A
finding is never a pass or a fail and never enters the ledger as a verdict, though a readiness check can cite it as
evidence. _Avoid_: issue, bug, defect, alert.

**Source** (of a finding): where a finding came from: a code check that runs on every screen, the model, or the
crawl.

**Unconfirmed**: a finding the model proposed that no code check or second look has backed yet.
_Avoid_: suspected, possible.

**Crawl**: Miqyas visiting screens of the app on its own, beyond the steps a plan names.
_Avoid_: exploration, spider, discovery.

**Active check**: a security check that acts against the app (sends payloads, uses a second session) instead of only
watching it. Runs only when the person opts in, and only against a test host or a host the person clearly allows.
_Avoid_: attack, scan, pentest.

**Test host**: a host whose name marks it as not production: localhost, `.localhost`, `.test`, or a label such as
staging, dev, test or qa.

## Whether an app is ready

**Readiness check**: an assertion Miqyas writes itself, as part of a profile, judged by code into the ledger like any
other assertion. The findings it turns up are its evidence. _Avoid_: scan, rule, audit.

**Coverage**: what a readiness check reached: screens, files, tables or endpoints, and requests.
_Avoid_: scope.

**Profile**: a named, versioned set of readiness checks for one grade, which a person chooses to run.
_Avoid_: preset (a set of mutations), suite, scan.

**Grade**: the level of readiness a profile targets. Grade 1 is an indie or vibe-coded launch, Grade 2 a startup or
SaaS, Grade 3 an enterprise or regulated app. A person chooses the grade; Miqyas never awards one.
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

**Corpus**: the set of target apps with defects planted on purpose, used to score Miqyas offline.
_Avoid_: benchmark, test suite.

**Seed**: one defect planted on purpose in the corpus. _Avoid_: mutant (today's mutation presets), bug.

**Part** (of the corpus score): one of three groups of seeds, scored apart and never blended: asserted (a plan asserts
the defect), unasserted (no plan names it) and readiness (a readiness check must catch it). _Avoid_: half.

**Clean twin**: the same target with no seed, on which every check must stay quiet. _Avoid_: baseline, control.

**Owned host**: a host whose owner has proven, with a token Miqyas prints, that active checks may run on it.
_Avoid_: verified host, trusted host, allowed host.

**Adapter**: the part of Miqyas that runs one existing tool (a runner or scanner) and reports what it covered.
_Avoid_: plugin, wrapper, integration.
