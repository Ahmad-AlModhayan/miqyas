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
    dev(["<b>Developer / QA Engineer</b><br/><i>Person</i><br/>Runs plans, readiness checks,<br/>mutations &amp; offline verify"])
    ci("<b>CI / CD Pipeline</b><br/><i>[External System]</i><br/>Enforces readiness gate"):::ext

    miqyas("<b>Miqyas</b><br/><i>[Software System]</i><br/>Decoupled open-core verification platform<br/>Gated collection → pure judge → proof bundle")

    sut("<b>Target Under Test</b><br/><i>[External System]</i><br/>Web app, server, or build"):::ext
    scanners("<b>External Scanners</b><br/><i>[External Tools]</i><br/>gitleaks, osv-scanner, axe-core"):::ext
    llms("<b>LLM Providers (Optional)</b><br/><i>[External Systems]</i><br/>Scrubbed inputs only,<br/>never judge verdicts"):::ext

    dev -->|"run, lint, mutate, verify<br/>[CLI]"| miqyas
    ci -->|"Readiness gate<br/>[Exit Codes]"| miqyas
    miqyas -->|"Gated browser &amp; probes<br/>[Playwright / HTTP]"| sut
    miqyas -->|"Collects facts<br/>[Local Process]"| scanners
    miqyas -->|"Scrubbed exploration<br/>[HTTPS]"| llms

    classDef ext stroke-dasharray:5 5,stroke-width:1.5px;
```

### Containers & Open-Core Boundary (C4 Level 2)

```mermaid
flowchart TB
    dev(["<b>Developer / CI</b><br/><i>CLI Caller</i>"])

    subgraph miqyas_repo["Miqyas Repository"]
        direction TB
        subgraph cli_tier["Apache-2.0 CLI Entry (zero AGPL imports)"]
            cli("<b>Thin CLI</b><br/><i>[src/cli.ts]</i><br/>Spawns core across process boundary")
        end

        subgraph agpl_layer["AGPL-3.0-only Core Engine"]
            direction TB
            entry("<b>Entry &amp; Proof Orchestrator</b><br/><i>[src/entry/, proof-core/]</i><br/>Grade 1 checks, mutate, bench, reports")
            kernel("<b>Verification Kernel</b><br/><i>[src/kernel/]</i><br/>Ledger, blobs, CEL judge, verify")
            gate("<b>Request Gate &amp; Engine</b><br/><i>[src/gate/, engine/]</i><br/>Permits, recorder, derivations")
            adapters("<b>Adapters &amp; Agent Router</b><br/><i>[src/adapters/, agents/]</i><br/>Scanners &amp; scrubbed LLM caps")
        end

        store[("<b>Proof Bundle Store</b><br/><i>[.miqyas/runs/ — FS]</i><br/>Bundles, reports, payloads")]

        subgraph driver_tier["Apache-2.0 Drivers &amp; Scrubber"]
            direction LR
            surfaces("<b>Surface Drivers &amp; Protocol</b><br/><i>[src/surfaces/, protocol/]</i><br/>Playwright, axe-core, worker/1")
            scrubber("<b>Secret Scrubber</b><br/><i>[src/scrub/]</i><br/>Redacts builds, prompts, logs")
        end
    end

    sut("<b>Target Under Test</b><br/><i>[Web / Build]</i>"):::ext
    scanners("<b>External Scanners</b><br/><i>[gitleaks / osv]</i>"):::ext
    llms("<b>LLM Providers</b><br/><i>[Anthropic / OpenAI]</i>"):::ext

    dev -->|"CLI args"| cli
    cli -->|"Spawns process"| entry
    entry -->|"Judges &amp; verifies"| kernel
    entry -->|"Gated checks"| gate
    entry -->|"Scanners &amp; helpers"| adapters
    kernel -->|"Seals bundles"| store
    gate -->|"Permitted [stdio]"| surfaces
    gate -->|"Scrubs evidence"| scrubber
    adapters -->|"Scrubs prompts"| scrubber
    store ~~~ sut
    scrubber ~~~ scanners
    scrubber ~~~ llms
    surfaces -->|"Playwright / HTTP"| sut
    adapters -->|"Process"| scanners
    adapters -->|"Scrubbed [HTTPS]"| llms

    style miqyas_repo fill:none,stroke:#8b949e,stroke-width:1.5px,stroke-dasharray:5 3
    style cli_tier fill:none,stroke:#8b949e,stroke-width:1.5px,stroke-dasharray:4 2
    style agpl_layer fill:none,stroke:#8b949e,stroke-width:1.5px,stroke-dasharray:4 2
    style driver_tier fill:none,stroke:#8b949e,stroke-width:1.5px,stroke-dasharray:4 2
    classDef ext stroke-dasharray:5 5,stroke-width:1.5px;
```

### Runtime Flow: Gated Verification & Offline Proof Replay (UML Sequence)

```mermaid
sequenceDiagram
    autonumber
    participant CLI as Thin CLI (Apache)
    participant Core as Core & Gate (AGPL)
    participant Worker as Surface & Scrubber
    participant Kernel as Ledger & CEL Judge
    participant Bundle as Proof Bundle

    CLI->>Core: Spawn core entry (process boundary)
    Core->>Core: Resolve claims, facts & collectors

    loop For each action / probe
        Core->>Core: Gate checks wire & origin grants
        alt Denied by Gate
            Core->>Kernel: Record deny effect (target untouched)
        else Permitted
            Core->>Worker: Run action (miqyas-worker/1)
            Worker->>Worker: Scrub secrets from payloads
            Worker-->>Kernel: Append normalized facts & blobs
        end
    end

    Core->>Kernel: Pure CEL judge & verdict fold<br/>(no model, clock, or network)
    Kernel->>Bundle: Seal hash-chained ledger & reports
    Core-->>CLI: Exit code (0/1/2/3)

    CLI->>Kernel: miqyas verify (offline)
    Kernel->>Bundle: Read sealed ledger & blobs
    Kernel-->>CLI: Confirm identical verdicts
```

<details>
<summary>Level 3 — Component Diagram: Verification Kernel, Gate &amp; Proof Core</summary>

```mermaid
flowchart TB
    cli("<b>Thin CLI (src/cli.ts)</b><br/><i>[Apache-2.0]</i>"):::ext

    subgraph core_c["Miqyas Core Engine (AGPL-3.0-only)"]
        direction TB
        entry("<b>Core Entry &amp; Orchestrator</b><br/><i>[src/entry/*, proof-core/*]</i><br/>Grade 1 checks, plan runner, mutate, reports")
        judge("<b>CEL Judge &amp; Verifier</b><br/><i>[src/kernel/cel*, judge, fold]</i><br/>Pure 3-valued verdicts &amp; verify")
        ledger("<b>Ledger &amp; Blobs</b><br/><i>[src/kernel/ledger, blobs, tree]</i><br/>Append-only facts &amp; checkpoints")
        gate_eng("<b>Request Gate &amp; Recorder</b><br/><i>[src/gate/decide/*, engine/*]</i><br/>Wire/origin grants &amp; derivations")
    end

    store[("<b>Proof Bundle Store</b><br/><i>[.miqyas/runs/]</i>")]:::ext
    surf("<b>Web Surface &amp; Scrubber</b><br/><i>[Apache-2.0]</i>"):::ext
    adap("<b>Adapters &amp; Router</b><br/><i>[src/adapters, agents]</i>"):::ext

    cli -->|"Child Process"| entry
    entry -->|"Offline verify"| judge
    entry -->|"Routes actions"| gate_eng
    entry -->|"Scanner facts"| adap
    judge -->|"Reads fact sets"| ledger
    gate_eng -->|"Appends facts"| ledger
    ledger -->|"Seals bundles"| store
    entry -->|"Writes reports"| store
    gate_eng -->|"Actions &amp; scrub"| surf

    style core_c fill:none,stroke:#8b949e,stroke-width:1.5px,stroke-dasharray:5 3
    classDef ext stroke-dasharray:5 5,stroke-width:1.5px;
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
