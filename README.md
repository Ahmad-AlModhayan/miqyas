# Miqyas (مقياس)

Miqyas checks whether your web app is ready to launch, and proves every check it made, from your own machine.

It runs the tools you already trust (Playwright, axe-core, gitleaks, osv-scanner), judges what they found by code, and
puts every check in one ledger with its evidence and coverage. The Grade 1 profile, for indie and vibe-coded launches,
runs 13 readiness checks (open tables, leaked keys, one user reading another's data, routes that spend money with no
session, dead buttons and more), 12 of them with no model call. On top, an AI agent carries out written plans on the
real app, every assertion gets its own verdict, and a mutation self-check tests the tests. Only the model calls you
configure leave your machine, each one scrubbed and logged, and your source code never reaches a model.

**Status:** phase 1 (web) works: CLI, Playwright runner, assertion ledger, reports, mutate mode and scrubber. The
Grade 1 readiness profile is being built. Expect rough edges and changing interfaces.

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

## Documents

- [Product requirements (PRD)](docs/PRD.md) and [software requirements (SRS)](docs/SRS.md)
- [Charter](docs/CHARTER.md): goal, readiness grades and profiles, the seven principles, plan format, roadmap
- [Threat model](docs/threat-model.md): what Miqyas defends, what it may do to a target, what it never does
- [Decisions (ADRs)](docs/adr/) and the [glossary](CONTEXT.md)
- Numbers like "ticket 28" in the docs refer to Kahf's internal tracker.
- [Dogfood note](docs/dogfood/2026-10-29-wasl.md) and [research notes](docs/research/)

## Licence

Miqyas is **open code**: the source is public under the [PolyForm Shield License 1.0.0](LICENSE). It is
source-available, not open source by the OSI definition. You may read, run, change and share it, and send pull
requests. You may not use it to provide a product that competes with Miqyas or with a Kahf product built on it, free
or paid. Notices: [NOTICE](NOTICE.md); the reasoning: [open model](docs/OPEN_MODEL.md).

| Path | Licence |
|---|---|
| everything in this repository | PolyForm Shield 1.0.0 (`LICENSE`) |

A planned Apache-2.0 package, `miqyas-drivers` (worker protocol, surface drivers, RTL checks, scrubbers, fault
presets), will live in its own folder with its own `LICENSE`; this table gains a row when it lands.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md). Every pull request needs the
[contributor agreement](CLA.md); you keep your copyright. The names and logos Kahf, Wasl, Qasd and Miqyas are not
licensed for forks ([TRADEMARKS.md](TRADEMARKS.md)).

## Security

Report vulnerabilities, including any scrubber miss, privately: see [SECURITY.md](SECURITY.md). Do not open a public
issue.
