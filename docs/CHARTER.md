# Miqyas charter

## Vision

Miqyas is a **verification platform**: the place any software passes through before anyone trusts it — across web,
mobile, desktop, servers and industrial or factory systems. It is not an MCP server and not a standalone agent.

Today there is no single, strong, trustworthy, integrated system for proving any software is sound; existing tools each
check one angle and leave teams without unified proof. Miqyas solves that in three parts:

- **Proof core**: every check, from any source, ends in one recorded verdict with evidence and coverage.
- **Agent team**: agents that understand the target software, author plans, crawl states, run active checks, and inject
  faults on any surface.
- **Existing tools as adapters**: the world's runners, drivers and scanners plugged in behind adapters, never rebuilt
  (ADR 0005).

Teams reach it through four entry points: one CLI command for a solo developer, a CI gate that blocks release before
`ready`, an MCP interface for coding agents after building, and self-hosted deployment so a company's or factory's
code and data never leave.

## Goal

Built on that vision, Miqyas answers three questions about a target with evidence:
- **Verification**: did we build it right?
- **Validation**: did we build the right thing?
- **Readiness**: can it survive the real world?

Miqyas doesn't replace your test runners. Its proof core runs them, judges what they found, and proves what they
checked (ADR 0005). The verdict is computed, not assumed: every assertion — whether authored by a person, drafted by
the agent team, or defined by a readiness check — gets exactly one recorded verdict with evidence. A run passes only
when all assertions pass, and a profile is `ready` only when every check in it has a recorded pass. Miqyas measures
itself by breaking targets on purpose, and sends nothing off the machine except the model calls the person configures.

Phase 1 proves the proof core and adapter model first on Grade 1 web launch readiness, with Wasl as the first target
proven end to end. Details: [PRD](PRD.md), [SRS](SRS.md), [threat model](threat-model.md), [ADRs](adr/).

## What to beat

For Grade 1 readiness, the incumbent is Lovable's built-in Security checks: free and static, and they list findings only
(PRD §3, `docs/research/grade1-incumbents-2026-11.md`). For the plan-driven tester, it's TestSprite on Wasl (2026-10-28):

| Finding | Number | Miqyas answer |
|---|---|---|
| Assertions with a trace in the run record | 17 of 34 (the evaluation prints 32, but its per-plan column and the 11 plan files both give 34) | Ledger: 34 of 34, each with a verdict and evidence, or the run fails |
| Mutations detected | 3 of 4 (a CSS-hidden error list passed) | Mutate mode, target 4 of 4; detection rate reported every release |
| Exported assertions "not verified" | 44 of 46; 16 positional XPath; 2 tests with no assertion | Role/name locators only, replay before export, refuse assertion-less tests |
| Surfaces | web UI only | One CLI and MCP across web, Tauri, Android, CLI programs and engine scenarios |
| False failures on Wasl | 8 of 8 caused by the dev mock | Harness contract check before any run on a mock |
| Data handling | code summaries and the built app go to their cloud; retention undocumented | Local runs; scrubber and payload log before every model call |

What TestSprite did well and we must keep: accurate observations (53 of 53 runs), judging rendered pixels rather than
markup, refusing to guess secrets, about $0.02 and 70 to 136 s per run.

## Readiness: pillars, grades, profiles

A **profile** is a set of readiness checks for one **grade**, which the person chooses (`--profile grade-1`). A
readiness check is an assertion Miqyas writes, judged by code into the ledger (ADR 0004). It passes only when it met
its declared coverage and found nothing. Checks are grouped under eight **pillars** in reports:
1. code and logic
2. UI states and flows
3. data and money
4. APIs and third parties
5. security and tenant isolation
6. performance and cost
7. operations
8. AI and compliance

| Grade | For | Profile |
|---|---|---|
| 1 | Indie or vibe-coded launch | `grade-1`, 13 checks at early access |
| 2 | Startup or SaaS | roadmap |
| 3 | Enterprise or regulated | roadmap |

Each grade's goal and its checks per pillar are in PRD §6, which owns them.

What Miqyas may do to a target, and what it never does, is in the [threat model](threat-model.md) and ADR 0002.
Spend is guarded by a free quote and a typed hard cap (ADR 0001). Only model calls leave the machine (ADR 0003).

## Seven principles

These were first called the "seven pillars"; they're renamed so that "pillar" keeps one meaning.

1. **Assertion ledger.** One verdict per assertion (`pass`, `fail`, `not_checked`, `blocked`, `unverified`), with a
   screenshot crop and the accessibility nodes read. PASS = the conjunction of recorded passes. A judge's "pass"
   without a cited node is `unverified`, which fails the run. Each assertion is judged at its position in the plan,
   before the next action (the TestSprite miss was a mid-flow assertion followed by navigation).
2. **Mutation self-check.** Break a copy of the served build on purpose (string swap, CSS hide, RTL flip; mock silence
   next), confirm each mutation is effective with a code probe, run the plans, report the detection rate and which
   assertion caught each one.
3. **Exports that are real regression tests.** Role/name locators recorded for every action from day one; export
   replays each assertion against the final state and refuses tests without assertions (phase 1b).
4. **One proof core, four entry points, many surfaces.** CLI, CI gate, MCP and self-hosted runs over one ledger;
   web first, then Tauri desktop (macOS through `tauri-plugin-wdio-webdriver`), Android via Appium, CLI programs,
   server/engine scenarios with fault injection, and later industrial/factory systems.
5. **Harness contract checks.** For a mocked target, check that the mock answers every command the app can send
   before running a plan.
6. **Local-first.** Pluggable model providers, Anthropic Claude by default with the key from the environment only; a
   Unicode-aware scrubber on snapshots and served bundles; a local payload log of every model call.
7. **Arabic and RTL built in.** Visible means rendered; direction checked by measured position, not only `dir`;
   bidi isolation, plurals, digits and fonts next.

## Architecture

Phase 1 implements the proof core, the first surface worker (web), and the first adapters behind a clean boundary so
additional surfaces, fault-injection workers, and coordinated agent-team roles plug into the same ledger:

```
plans (miqyas-plan/1) + profiles (grade-1) ──> core (TypeScript, Node 20+)
        plan parser + lint, ledger + readiness, reports, quote + cap, mutate, scrubber, payload log, corpus score
        │ agent interface (act / judge)   │ surface interface         │ adapters (ADR 0005)
        ▼                                 ▼                           ▼
  model provider (Anthropic default;  web: Playwright Chromium,  axe-core (in page), gitleaks,
  scripted and replay agents)         crawl + detectors + probes osv-scanner (user-installed)
                                      later workers over miqyas-worker/1: Tauri, Android, CLI, engine/server, industrial
```

- **Adapters**: each existing tool runs behind an adapter that reports what it covered and its version; Miqyas writes
  its own check only when no tool with a fitting licence fits ADR 0002, and says why (ADR 0005).
- **Core**: TypeScript, strict, on Node 20+ so it can use Playwright, WebdriverIO and Midscene directly.
- **Observation**: per step, a full-page screenshot plus a snapshot of rendered nodes only (computed style, non-zero
  box, not clipped), each with role, accessible name, state and box, and a ref the model cites.
- **Agent**: `act` drives a step with tools (click, fill, select, press, scroll, wait, navigate within the origin);
  `judge` may only look (and look again after a wait) and must call `record_verdict` citing node refs. Page text is
  data to the model, never instructions.
- **Verdict**: deterministic `check` first when the plan gives one, the model otherwise; the entry records the method.
- **Other surfaces** plug in as worker processes speaking JSON lines over stdio (`hello`, `open`, `act`, `observe`,
  `check`, `close`); binaries go to the run folder, messages carry paths. A worker crash is an error, never a pass.
- **Artifacts** stay under `.miqyas/` (git-ignored): ledger, reports, crops, payload log.

## Plan format

A superset of TestSprite's action/assertion steps; TestSprite plans import one to one (`projectId` dropped, ids
assigned once and written back).

```json
{ "format": "miqyas-plan", "version": 1, "id": "wasl-03-add-pair-validation", "surface": "web",
  "name": "Adding a folder pair with nothing filled in lists what is missing",
  "steps": [
    { "id": "s1", "type": "action", "text": "Click 'Add folder pair'" },
    { "id": "a1", "type": "assertion", "text": "An error list says what is missing",
      "check": { "locator": { "role": "alert" }, "expect": "visible" } },
    { "id": "s2", "type": "action", "text": "Click the back button" },
    { "id": "a2", "type": "assertion", "text": "The 'Folder pairs' screen is shown again" } ] }
```

Every step has a stable `id` that never changes when other steps are edited. Secrets are written `${secret.NAME}`,
read from `MIQYAS_SECRET_NAME` at the moment of typing and never shown to the model; a missing secret blocks the step.

## Roadmap

Phase 1 (web: CLI, Playwright runner, ledger, reports, mutate, Wasl preset) is built.

| Milestone | Scope | Exit |
|---|---|---|
| M1 Hardening (11-09 → 11-22) | Quote and hard cap, replay, cite-matched passes, detectors and findings, crawl, active checks, corpus and score | ticket 33's bar met on a scored baseline; live Wasl run |
| M2 Grade 1 early access | The 13 Grade 1 checks, readiness report, `--no-model`, readiness seeds, distribution | Every check catches its seeds and stays quiet on its clean twin |
| M3 Exports and MCP | Playwright Test export with replay, harness contract check, MCP server, Arabic and RTL checks | Exported Wasl suite passes clean and fails each mutation |
| M4 Wasl engine | Rust scenario worker: two `wasld` instances, local fake Drive, fault injection, invariants | Planted conflict-copy bug caught; same seed, same event log |
| M5 Desktop | Tauri worker (WebdriverIO) on the real shell; agent-desktop alongside | Wasl smoke plans on the real shell |
| M6 Android and v1.0 | Appium worker | Wasl smoke plans on an emulator |

## How quality is measured

- **Mutation detection rate**: mutations detected by the assertion they target, over mutations confirmed effective,
  on the Wasl preset every release (target 4 of 4; TestSprite 3 of 4). Catches by an unrelated assertion are counted
  apart.
- **False failures per 100 runs**: failures on a known-good build whose cause is the tester (wrong observation,
  wrong judgement, flake), measured by rerunning the clean Wasl suite; target under 2.
- **Ledger completeness**: assertions with a recorded verdict over assertions written; must be 100 %.
- **Corpus score**: per category and per part (asserted, unasserted, readiness), never blended, with false
  positives on each clean twin. A scored baseline runs 3 times, and the thresholds are set from the first one.
- Also tracked: cost and wall time per plan, model calls per step, and the Haiku–Opus gap on the corpus.
