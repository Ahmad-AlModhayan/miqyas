# Miqyas (مقياس)

Miqyas is a **verification platform**: the place any software passes through before anyone trusts it — web, mobile,
desktop, servers, and industrial or factory systems. It is not an MCP server and not a standalone agent.

Miqyas brings three parts together so every check leaves proof:

- **Proof core**: every check, from any source, ends in one verdict in the ledger with evidence and coverage.
- **Agent team**: agents that understand the software, author plans, explore states, run active checks, and inject
  faults on any surface.
- **Outside tools as adapters**: the runners and scanners you already trust (axe-core, gitleaks, osv-scanner, and
  more) plug in behind adapters and add facts. Judging is Miqyas's own code, and so, by design, is finding a defect
  by experiment ([docs/MAP.md](docs/MAP.md)).

Four ways in: one CLI command for a solo developer, a CI gate blocking release before `ready`, an MCP interface for a
coding agent to verify what it built, and self-hosted runs where source code and data never leave your network.

**What works today (Phase 1, web):** CLI, Playwright runner, assertion ledger, reports, mutate mode, and scrubber. The
Grade 1 web readiness profile (13 checks, 12 of them with no model call) is being built first to prove the proof core
and adapter layer end to end. Only the model calls you configure leave your machine, each one scrubbed and logged, and
source code never reaches a model. Expect rough edges and changing interfaces.

## Install and build

Node 20 or newer, and Playwright's Chromium.

```bash
npm ci && npm run build
npx playwright install chromium
node dist/cli.js doctor        # Node, browser, whether a model key is set
```

## Use

```bash
node dist/cli.js lint plans/wasl                          # offline plan check
node dist/cli.js run plans/wasl --url http://localhost:4173/ --scrub wasl-scrub
node dist/cli.js mutate plans/wasl --build <dist-mock> --preset wasl-tray --scrub wasl-scrub
node dist/cli.js import testsprite <testsprite/plans> --out plans/wasl
node dist/cli.js scrub <dist-mock> --rules wasl-scrub     # then re-scans; exit 1 if anything is left
```

`plans/wasl` and the `wasl-*` presets are the example plans and scrub rules from dogfooding Miqyas on the Wasl tray
window. Write your own plans in the same JSON format ([charter](docs/CHARTER.md), plan format).

Live runs read `ANTHROPIC_API_KEY` from your environment or from a git-ignored `.env` in the folder you run from (see
`.env.example`; set it yourself, Miqyas never asks for it, and a variable set in the shell wins). Without it,
`--dry-run`, `lint`, `mutate --dry-run` and the tests still work. Exit codes: 0 pass, 1 fail, 2 plan or usage error,
3 blocked or environment.

Runs go to `.miqyas/runs/<id>/`: `report.json`, `report.md`, evidence crops and screenshots, and `payloads.jsonl`
(every model call, scrubbed). Each report has a method block (versions, OS, model and run settings, preset, the scrub
rules file with its SHA-256 and term count, never the terms). `schema/report.schema.json` and
`schema/mutation-report.schema.json` describe the reports.

`bench wasl-tray [--repo <wasl clone>] [--commit <ref>] [--dry-run]` reruns the Wasl dogfood end to end: it exports
the app at a pinned commit with `git archive` (never writing inside your clone), builds the dev mock, scrubs the
build, runs the plans and the mutations, and writes `bench/<date>-<commit>/summary.md` and `summary.json`.

Tests: `npm test` (unit, offline) and `npm run test:e2e` (Chromium against a local fixture, scripted agent, no
network).

## Architecture (C4 + UML)

### System Context (C4 Level 1)

```mermaid
flowchart TB
    dev(["Developer / QA Engineer<br/>[Person]<br/>Runs plans, readiness checks,<br/>mutations, and offline verification"])
    ci["CI / CD Pipeline<br/>[External System]<br/>Enforces readiness gate via exit codes"]:::ext

    miqyas["Miqyas<br/>[Software System]<br/>Decoupled open-core verification platform<br/>Gated collection -> deterministic judge -> proof bundle"]

    sut["Target Software Under Test<br/>[External System]<br/>Web app, local dev server, or source build"]:::ext
    scanners["External Scanners<br/>[External Tools]<br/>gitleaks, osv-scanner, axe-core behind adapters"]:::ext
    llms["LLM Providers (Optional)<br/>[External Systems]<br/>Anthropic / OpenAI; scrubbed inputs only,<br/>never judge verdicts"]:::ext

    dev -->|"run, lint, mutate, scrub, bench, verify [CLI]"| miqyas
    ci -->|"Readiness gate [CLI / Exit Codes]"| miqyas
    miqyas -->|"Drives sessions & probes through Gate [Playwright / HTTP]"| sut
    miqyas -->|"Collects structured facts [Local Process]"| scanners
    miqyas -->|"Scrubbed exploration / bindings [HTTPS]"| llms

    classDef ext stroke-dasharray: 5 5,stroke-width:1.5px;
```

### Containers & Open-Core Boundary (C4 Level 2)

```mermaid
flowchart TB
    dev(["Developer / CI<br/>[CLI Caller]"])

    subgraph miqyas_repo["Miqyas Repository"]
        subgraph apache_layer["Apache-2.0 Interface Layer (zero AGPL imports)"]
            cli["Thin CLI — src/cli.ts<br/>[Node.js, TypeScript]<br/>Spawns core entry across strict process boundary"]
            surfaces["Surface Drivers & Protocol — src/surfaces/, src/protocol/<br/>[TypeScript, Playwright, axe-core]<br/>Web crawler, proxy, detectors, miqyas-worker/1 stdio"]
            scrubber["Secret Scrubber — src/scrub/<br/>[TypeScript]<br/>Rule-based redactor for builds, prompts, logs"]
        end

        subgraph agpl_layer["AGPL-3.0-only Core Engine"]
            entry["Entry & Proof Orchestrator — src/entry/, src/proof-core/<br/>[Node.js, TypeScript]<br/>Grade 1 13-check readiness, mutate self-check, bench, reports"]
            kernel["Verification Kernel — src/kernel/<br/>[TypeScript]<br/>Hash-chained ledger, blobs, CEL judge, fold, offline verify"]
            gate["Request Gate & Engine — src/gate/, src/engine/<br/>[TypeScript]<br/>Wire/origin classifier, grants, recorder, derivations"]
            adapters["Adapters, Collectors & Agent Router<br/>[src/adapters/, src/collectors/, src/agents/]<br/>Scanner adapters + scrubbed LLM router & spend caps"]
        end

        store[("Run & Proof Bundle Store — .miqyas/runs/<br/>[Local Filesystem]<br/>Sealed bundles, report.json/md, crops, scrubbed payloads.jsonl")]
    end

    sut["Target Under Test"]:::ext
    scanners["External Scanners"]:::ext
    llms["LLM Providers"]:::ext

    dev --> cli
    cli -->|"Spawns child process"| entry
    entry --> gate
    entry --> kernel
    entry --> adapters
    gate -->|"miqyas-worker/1"| surfaces
    gate --> scrubber
    surfaces -->|"Playwright / HTTP"| sut
    adapters -->|"Local Process"| scanners
    adapters --> scrubber
    adapters -->|"HTTPS"| llms
    kernel --> store

    classDef ext stroke-dasharray: 5 5,stroke-width:1.5px;
```

### Runtime Flow: Gated Verification & Offline Proof Replay (UML Sequence)

```mermaid
sequenceDiagram
    actor Caller as Developer / CI
    participant CLI as Thin CLI (Apache-2.0)
    participant Core as Entry & Orchestrator (AGPL-3.0)
    participant Gate as Request Gate (src/gate)
    participant Worker as Web Surface & Scrubber (Apache-2.0)
    participant Kernel as Ledger & CEL Judge (src/kernel)
    participant Bundle as Proof Bundle (.miqyas/runs/)

    Caller->>CLI: miqyas run / check13 / mutate
    CLI->>Core: Spawn core entry (process boundary, zero AGPL import)
    Core->>Core: Resolve claims, required facts, and collectors

    loop For each permitted action / probe
        Core->>Gate: Request action against target
        Gate->>Gate: Classify wire method & origin against grants
        alt Denied by Gate
            Gate->>Kernel: Record deny effect fact (target untouched)
        else Permitted
            Gate->>Worker: Execute action (miqyas-worker/1)
            Worker->>Worker: Scrub secrets from observations & payloads
            Worker-->>Kernel: Append normalized facts & evidence blobs
        end
    end

    Note over Kernel,Bundle: Deterministic judging — no model, clock, or network
    Core->>Kernel: Judge closed fact sets via pure CEL rules & fold verdicts
    Kernel->>Bundle: Seal hash-chained ledger, blobs, report.json & report.md
    Core-->>Caller: Exit code (0 pass / 1 fail / 2 usage / 3 blocked)

    Note over Caller,Bundle: Offline verification anytime later
    Caller->>Kernel: miqyas verify .miqyas/runs/run-id
    Kernel->>Bundle: Read sealed ledger & blobs only
    Kernel-->>Caller: Recompute & confirm identical verdicts offline
```

<details>
<summary>Level 3 — Component Diagram: Verification Kernel, Gate &amp; Proof Core</summary>

```mermaid
flowchart TB
    cli["Thin CLI (src/cli.ts)<br/>[Apache-2.0]"]:::ext
    surf["Web Surface & Scrubber<br/>[Apache-2.0]"]:::ext
    adap["Adapters & Agent Router<br/>[src/adapters, src/agents]"]:::ext

    subgraph core_c["Miqyas Core Engine (AGPL-3.0-only)"]
        entry["Core Entry & Readiness Runner<br/>[src/entry/cli.ts, run-command.ts, check13.ts, verify.ts]<br/>Command dispatch, Grade 1 checks, bundle & fail-on"]
        orch["Plan Orchestrator & Mutator<br/>[src/proof-core/orchestrator.ts, plan.ts, mutate.ts, report.ts]<br/>Plan runs, mutation self-check, bench, reports"]
        gate_c["Request Gate<br/>[src/gate/decide/*]<br/>Wire & origin classifier, grants, allow/deny effects"]
        eng_c["Derivation & Recording Engine<br/>[src/engine/*]<br/>Fact recorder, derivations, scrubbing & withhold rules"]
        ledger["Ledger, Blobs & Merkle Tree<br/>[src/kernel/ledger, blobs, tree, checkpoint, store]<br/>Append-only canonical facts & content-addressed blobs"]
        judge["CEL Judge & Verdict Folder<br/>[src/kernel/claim, cel, cel-cost, judge, fold, verify]<br/>Pure 3-valued verdicts (held/broken/unknown) & offline verify"]
    end

    store[("Proof Bundle Store<br/>[.miqyas/runs/]")]:::ext

    cli -->|"Child Process"| entry
    entry --> orch
    entry -->|"Offline verify"| judge
    orch --> gate_c
    orch --> eng_c
    orch --> adap
    gate_c --> surf
    eng_c --> surf
    eng_c --> ledger
    gate_c --> ledger
    judge --> ledger
    ledger --> store
    orch --> store

    classDef ext stroke-dasharray: 5 5,stroke-width:1.5px;
```

</details>

## Documents

- [Product requirements (PRD)](docs/PRD.md) and [software requirements (SRS)](docs/SRS.md)
- [Charter](docs/CHARTER.md): goal, readiness grades and profiles, the seven principles, plan format, roadmap
- The design being built next, not yet what the code does: the [map](docs/MAP.md) (the whole system on one page and
  what makes it strong), the [foundation](docs/FOUNDATION.md) (what makes a verdict trustworthy), the
  [experiment engine](docs/ENGINE.md) (how defects are found with nothing written in advance) and the
  [algorithms](docs/ALGORITHMS.md) (every function and formula).
- [Threat model](docs/threat-model.md): what Miqyas defends, what it may do to a target, what it never does
- [Decisions (ADRs)](docs/adr/) and the [glossary](CONTEXT.md)
- Numbers like "ticket 28" in the docs refer to Kahf's internal tracker.
- [Dogfood note](docs/dogfood/2026-10-29-wasl.md) and [research notes](docs/research/)

## Licence

Miqyas is open source under a **decoupled open-core** model (see [`docs/OPEN_MODEL.md`](docs/OPEN_MODEL.md)):

| Path | Licence |
|---|---|
| `src/proof-core/`, `src/adapters/`, `src/agents/`, `src/entry/`, `test/` | `AGPL-3.0-only` ([`LICENSE`](LICENSE)) — commercial dual-licences available from Kahf Labs |
| `src/protocol/`, `src/scrub/`, `src/surfaces/`, `src/cli.ts`, `scripts/`, `presets/`, `schema/` | `Apache-2.0` ([`LICENSE-APACHE`](LICENSE-APACHE)) |

No `Apache-2.0` module may import any `AGPL-3.0-only` module (`npm run lint` enforces both layer boundaries and per-file SPDX headers in CI).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md). Every pull request needs the
[contributor agreement](CLA.md); you keep your copyright. The names Kahf, Wasl, Qasd and Miqyas are not licensed for forks ([TRADEMARKS.md](TRADEMARKS.md)).

## Security

Report vulnerabilities, including any scrubber miss, privately: see [SECURITY.md](SECURITY.md). Do not open a public
issue.
