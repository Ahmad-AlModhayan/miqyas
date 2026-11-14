# Miqyas (مقياس) · Software Requirements Specification

| | |
|---|---|
| Version | 0.4 (2026-11-13): align platform scope (proof core, agent team, adapters; entry points and future surfaces) with PRD 0.4 |
| Status | Building. M1 hardening from 2026-11-09; Grade 1 early access next. |
| PRD | `docs/PRD.md` |

## 1. Introduction

### 1.1 Purpose
Specifies Miqyas's proof core (plan format, assertion ledger, mutate mode, readiness checks, exporter, harness contract
checks), surface workers, adapters, Arabic and RTL checks, model router and scrubber, CLI, CI gate hooks, MCP server
and reports, along with the P1 and P2 features that follow v1.0.

### 1.2 Scope
Miqyas is a verification platform built around a proof core, an agent team, and existing tools plugged in as adapters
(PRD Vision). Within that platform:

- **In scope for early access (M1–M2):** web targets in Chromium, the hardening of §3.11 and the Grade 1 readiness
  profile of §3.12, judged by code, with existing tools behind adapters (ADR 0005).
- **In scope for v1.0:** web apps in Chromium, Android apps on an emulator or device, Tauri desktop apps on Windows,
  Linux and macOS, command-line programs, and engine scenarios for Wasl's `wasld`, across CLI, CI gate, MCP and
  self-hosted runs.
- **Beyond v1.0 (P1, P2 and platform horizon):** recorder, persona runs, fix loop, PDF reports, GitHub check (P1); iOS
  and the Python judge on `kahf-agent-harness` (P2); broader server and industrial/factory surface workers and full
  autonomous agent-team workflows (understanding software, drafting plans, exploring, running active checks and fault
  injection across surfaces).
- **Out of scope for the open-source CLI:** load testing, full penetration testing, and hosted cloud runs (optional proprietary Kahf-hosted runners and UI clients live outside the open-source CLI repository). The security checks once planned for P1 (FR-S1–S4) come earlier, in §3.11 and §3.12.

### 1.3 Definitions
| Term | Meaning |
|---|---|
| Plan | A JSON file of steps or faults for one flow on one surface, authored by a person or drafted by the agent team |
| Step | An `action` or an `assertion`, each with a stable `id` |
| Ledger | Every assertion in a run with exactly one verdict and its evidence |
| Verdict | `pass`, `fail`, `blocked` (a needed input is missing) or `not_checked` |
| Evidence | Screenshot crop, the DOM, accessibility or UI-hierarchy node read, observation, check method |
| Worker | A process that drives one surface over the worker protocol (§5.2) |
| Adapter | The module that runs an existing tool and reports its version and coverage |
| Detection rate | Mutations whose targeted assertion failed, divided by mutations applied |
| Contract check | Calling a mock with every command the target can send; silence fails |
| Scenario | A seeded engine or server test: devices, steps, injected faults, invariants |
| False failure | A failed run not traced to a product, harness or plan defect |

## 2. Overall description

### 2.1 Product perspective
```
 plans/*.json | TestSprite plans | recorder (P1) | persona batches (P1)
                         v
 [CLI]  [MCP server] --> [Core, TypeScript, Node 20+]
                          lint, contract check, scheduler, model router
                          (Claude | vLLM | Ollama), scrubber (regex)
                               | JSON-over-stdio, miqyas-worker/1
   +-----------+-----------+-----------+----------+-------------------+-----------------+
   v           v           v           v          v                   v
  web         android     tauri       cli        engine (Rust, ph.2)  judge (Python, P2)
  Playwright, WebdriverIO WebdriverIO pseudo-    wasld x2, fake Drive kahf-agent-harness
  Midscene.js + Appium    Tauri svc   terminal   fault injection      Pydantic Evals
                         v evidence and verdicts
 [Assertion ledger] --> report.md | report.json | exports | PDF (P1) | GitHub check (P1)
 [Mutate mode] breaks a served copy and scores the detection rate
```

### 2.2 User classes
Solo developers (CLI), release teams (CI gate blocking before `ready`), coding agents (over MCP), plan authors
(developers, QA), report readers (no install), self-hosting admins (companies and factories), Kahf maintainers.

### 2.3 Operating environment
macOS, Linux or Windows with Node 20+; Playwright's Chromium; Android platform tools with an emulator or device; for macOS Tauri runs, an app build with `tauri-plugin-wdio-webdriver`; a Rust toolchain for the engine worker. Models through the Anthropic API (`ANTHROPIC_API_KEY` from the environment) or an OpenAI-compatible endpoint such as vLLM or Ollama.

### 2.4 Constraints
- Only model calls leave the machine during a run (ADR 0003); a named command (`miqyas update-db`) fetches the OSV database and logs what it sends. Source code is read only by code, never sent to a model, and never written. A call carries the step text and the scrubbed screenshot and DOM or accessibility excerpt of the current step; never source files or an architecture summary.
- Keys come from the environment; Miqyas never writes, prints or asks for them.
- Drivers are used, never rebuilt: Playwright, Playwright MCP, Midscene.js, Stagehand, WebdriverIO.
- Runs never touch a user's real app or data (a developer's installed apps and data are never read or written). Mutations apply to a copy of a served build, never to the repository.
- Lean builds; verification runs locally.

## 3. Functional requirements

Priority: **M** must (v1.0), **S** should, **C** could.

### 3.1 Plans
| ID | Requirement | Pri | Acceptance |
|---|---|---|---|
| FR-P1 | Plan format (§5.1): `action` and `assertion` steps whose `id` never changes when other steps are edited | M | Schema tests; inserting a step keeps existing ids |
| FR-P2 | Import TestSprite plans: steps map one to one, `projectId` dropped, ids assigned once and written back | M | Wasl's 11 plans import with 32 assertions |
| FR-P3 | `miqyas lint` offline: schema, duplicate ids, locators; a plan with no assertion is an error | M | Runs with no network |
| FR-P4 | `miqyas plan draft` from a spec file, locally; every drafted case is written, no priority cap | M | 50 drafted cases give 50 plans |
| FR-P5 | Secrets as variables (`${secret.vault_pass}`) from the environment or a local file, never sent to a model; a missing value gives `blocked`, never a guess | M | Sentinel absent from payload log; missing value blocks |

### 3.2 Ledger and runs
| ID | Requirement | Pri | Acceptance |
|---|---|---|---|
| FR-L1 | Every assertion gets exactly one verdict with evidence | M | Wasl run: 32 entries for 32 assertions |
| FR-L2 | A run passes only if every assertion has a recorded `pass`; `not_checked` fails the run | M | Unit tests on synthetic ledgers |
| FR-L3 | Deterministic check first (visible, text, value, URL, count, position by code); the model judges only the rest; each verdict records its method | M | Method on every entry |
| FR-L4 | A mid-flow assertion is checked at its position, before the next action | M | Hidden-error mutation on Wasl plan 03 fails there |
| FR-L5 | Visible means rendered: computed style, non-zero box, not clipped; text only in markup is not visible | M | CSS-hidden error on plan 06 fails; a 1×1 px live-region copy is not a duplicate |
| FR-L6 | Retries are recorded beside the first attempt and never replace a failure; flaky assertions flagged | M | Report shows both attempts |
| FR-L7 | Failure bundle: observation, crop, node, console and network excerpt, suspected class (product, harness, environment, plan) labelled AI judgement | M | Bundle schema test |

### 3.3 Mutate mode
| ID | Requirement | Pri | Acceptance |
|---|---|---|---|
| FR-M1 | `miqyas mutate` applies CSS hide, string swap, RTL flip and mock silence to a copy of the served build | M | Repository and clean build hashes unchanged |
| FR-M2 | Preset `wasl-tray` with TestSprite evaluation's mutations: "The recycle bin is empty" → "Nothing to show here"; `.field-error{display:none}`; `.kf-field-error .kf-field-help{display:none}`; `html[dir=rtl] body{direction:ltr}` | M | Each confirmed effective (text changed, element 0 px high, sidebar at x=0) before the run |
| FR-M3 | Report the detection rate and which assertion caught each mutation; catches by an unrelated assertion counted apart | M | Unit test on mixed outcomes |
| FR-M4 | Propose one mutation per assertion | S | Proposals for Wasl's 32 assertions |

### 3.4 Exports
| ID | Requirement | Pri | Acceptance |
|---|---|---|---|
| FR-X1 | Export passing runs as Playwright Test (web) or WebdriverIO specs (Tauri, Android), assertions at their step positions | M | Exported Wasl suite passes clean and fails each mutation |
| FR-X2 | Locators by role and accessible name, label, text or test id; no positional XPath or `nth-child`; no stable locator means no export, element named | M | Lint finds no `/html/`, `xpath=` or `nth-child` |
| FR-X3 | Replay every exported assertion against the run's final state first; one that can't be evaluated blocks the export | M | Zero "not verified" assertions |
| FR-X4 | Refuse a test with no assertion; no fixed sleeps | M | Lint finds no `waitForTimeout` or `sleep(` |

### 3.5 Harness contract checks
| ID | Requirement | Pri | Acceptance |
|---|---|---|---|
| FR-H1 | Read the commands an app can send (for Wasl, every `invoke('…')` in `api.ts`), call the mock with each; no answer, `null` or `undefined` fails | M | Wasl's pre-fix mock: the evaluation's nine silent commands reported |
| FR-H2 | Targets marked `mock: true` run the contract check before any plan; failure stops the run as a harness error | M | No plan runs on the pre-fix mock |
| FR-H3 | A success message with no state change is classed as a likely harness gap | S | Wasl plan 04 on the pre-fix mock |

### 3.6 Surfaces
| ID | Requirement | Pri | Acceptance |
|---|---|---|---|
| FR-W1 | Workers speak `miqyas-worker/1`; a worker crash or timeout ends the run as an error, never a pass | M | Killed-worker test |
| FR-W2 | Web: Playwright Chromium, accessibility snapshot and screenshot per step; Midscene.js locates by vision when no accessible node fits, and the verdict says so; origin allowlist | M | Wasl tray suite; off-allowlist navigation blocked |
| FR-W3 | Tauri: WebdriverIO Tauri service on Windows, Linux and macOS, real shell, temporary data folder | M | Wasl smoke plan on macOS and Windows or Linux; real data unchanged |
| FR-W4 | Android: Appium (UiAutomator2) through WebdriverIO's Appium service; locators from resource id, content description, text; hierarchy as evidence | M | Wasl Android smoke plan on an emulator |
| FR-W5 | CLI programs in a pseudo-terminal: exit code, stdout and stderr (text, regex, JSON path), files written (exists, hash, content), interactive prompts | M | Fixture program with a yes/no prompt |
| FR-W6 | Engine worker (Rust): two or more engine instances with separate data folders, a local fake Drive, faults (dropped connection, HTTP 429/500/503, slow replies, crash and restart, clock skew), seeded and replayable | M | Same seed, same event log |
| FR-W7 | Invariants after each scenario: no data loss (every version written is in the final state, a conflict copy or the recycle bin), convergence, no silent overwrite | M | Planted bug that drops conflict copies is caught |
| FR-W8 | Model-proposed scenarios stored as data and run deterministically | S | Proposals validate and replay |

### 3.7 Arabic and RTL checks
| ID | Requirement | Pri | Acceptance |
|---|---|---|---|
| FR-A1 | `dir` and `lang` set, and the mirrored layout confirmed by measured position as well | M | RTL-flip mutation fails |
| FR-A2 | Mixed Arabic, Latin and digits (paths, names, numbers) keep logical order; user content isolated (`<bdi>`, `dir=auto`, Unicode isolates) | M | Unisolated «المستندات/تقارير/2026» fixture fails |
| FR-A3 | Arabic plurals follow CLDR categories (zero, one, two, few, many, other) | M | «2 ملفات» in place of «ملفان» fails |
| FR-A4 | One digit style (Western or Arabic-Indic) per screen, as configured | M | Mixed-digit fixture fails |
| FR-A5 | Arabic rendered in the expected font, joined, no missing glyphs (for Wasl, Readex Pro) | S | Missing-font fixture flagged |
| FR-A6 | One plan runs in Arabic and English through a string table | S | Wasl plan 07 in both |

### 3.8 Models, scrubber and data
| ID | Requirement | Pri | Acceptance |
|---|---|---|---|
| FR-D1 | Model router: Claude by default; OpenAI-compatible endpoints (vLLM, Ollama); without a key, live runs stop with a message while lint, dry run, mutation and unit tests still work | M | Tests with two providers and with no key |
| FR-D2 | Scrubber before every model call and on served bundles: configured terms (organisation, project and person names, emails, keys), Unicode-aware, then a re-scan that must find zero | M | `KahfLabs`, `mizwala`, `qasd`, `adhan`, «هاتف فلان» absent from payloads |
| FR-D3 | The scrubber's regex set is documented | S | Seeded identifiers for every documented pattern absent from payloads |
| FR-D4 | Payload log of every model call (provider, model, size, scrubbed content), kept locally | M | One entry per call |
| FR-D5 | No telemetry; artifacts under `.miqyas/` with retention per project; videos off by default | M | Network capture shows only the model endpoint and the app |

### 3.9 CLI, MCP and reports
| ID | Requirement | Pri | Acceptance |
|---|---|---|---|
| FR-C1 | CLI (§5.3), human and `--json` output; exit codes 0 pass, 1 fail, 2 plan or usage error, 3 blocked or environment | M | Test per code |
| FR-C2 | `--dry-run` resolves plans, targets and workers with no network or model call | M | Runs offline |
| FR-C3 | MCP server over stdio (§5.4); tools return results, never instructions for the calling agent, and never open windows unasked | M | MCP client runs a Wasl plan end to end |
| FR-C4 | Markdown and JSON reports: summary, ledger with evidence, detection rate when mutated, method (models, settings, versions, scrub rules file with its SHA-256 and term count, never the terms) | M | Report schema test |
| FR-C5 | Local HTML report viewer in Arabic and English on `@kahf/design` | S | axe-core clean in both |

### 3.10 After v1.0
FR-S1–S4 below are superseded by FR-B9 and FR-K1–K13, which bring them into early access.

| ID | Requirement | Pri | Acceptance |
|---|---|---|---|
| FR-R1 | Recorder (from Dalil): record a flow once in the browser or on Android (UI hierarchy per step), save a plan with role and name locators; click an element to add an assertion | S | Recorded Qasd and Wasl flows replay |
| FR-R2 | Password and one-time-code fields never read (`type=password`, `autocomplete` codes, Android `password` nodes); values become secret variables | S | Sentinel absent from disk and logs |
| FR-R3 | Recorder screenshots redacted by the scrubber before saving; until the scrubber covers images, they're marked unscanned and kept local | S | Seeded identifiers blurred |
| FR-U1 | Persona runs (from Tajriba): goal, tech skill, Arabic or English, device, accessibility (tree only, 200% zoom, keyboard only); 5 repeats by default | S | 8 built-in personas |
| FR-U2 | Success, extra steps against the shortest known path, backtracks; axe-core per new screen; rates with n and a 95% Wilson interval | S | Fixture with a known path |
| FR-U3 | Findings labelled automated check, measured behaviour or AI judgement; personas shown as simulated; no satisfaction scores | S | Report schema |
| FR-S1 | Supabase tables in exposed schemas with row level security off (read-only database connection the user gives) or readable with the public key | S | Fixture with one open table |
| FR-S2 | IDOR (insecure direct object reference): user B requests user A's resources by the ids seen in A's run, with two test users the user provides; read requests only unless opted in | S | Fixture API with one IDOR |
| FR-S3 | Secret keys in served JavaScript and source maps (Supabase secret and `service_role` keys, payment and cloud keys, private keys) | S | Planted keys found |
| FR-S4 | Each security finding says it is not a penetration test; checks run only on allowlisted origins | S | Text in both languages |
| FR-G1 | Fix loop: failures to the coding agent over MCP with evidence; re-run only failed assertions | S | Loop test keeps both runs |
| FR-G2 | PDF report through a PDF library chosen at build time (Typst preferred) | S | Arabic pages pass Miqyas's own Arabic and RTL checks |
| FR-G3 | GitHub check run per commit, failed assertions as annotations | S | Check on a test repository |
| FR-G4 | iOS worker | C | P2 |
| FR-G5 | Python judge on `kahf-agent-harness`; agent-output evaluations (Pydantic Evals) for Raqeeb, and the later Diwan edition of its engine, in the same ledger | C | P2 |
| FR-G6 | Results on Entire trails through an Entire CLI plugin | C | P2 |

### 3.11 Hardening (M1)
| ID | Requirement | Pri | Acceptance |
|---|---|---|---|
| FR-B1 | Every run that would call a model first prints a free quote: the likely cost, the worst case (every turn limit, `max_tokens`), per plan and in total, today's spend against the daily cap, and the price table's date (a warning past 90 days). `miqyas quote <plans>` prints it and stops. `--live` is gone, and `--dry-run` skips the quote. | M | Quote test with no network; reports record the quote beside the actual cost |
| FR-B2 | A person at a terminal types a dollar amount, which becomes the run's hard cap. Anything else rejects the run. With no TTY, a live run is refused, and no flag overrides that. One run may approve at most what is left of today's cap. | M | Non-TTY refusal test; typed-amount test |
| FR-B3 | Before each call, a pessimistic estimate is made; a call that would pass the cap is refused, and the plan ends as `error: budget cap`. Fails closed on an unknown price or missing usage. Daily cap $20 per device in `~/.miqyas/`; the crawl and model-proposed findings share at most 25% of the cap; when that share runs out, findings work stops and assertions carry on. | M | Cap tests at `gateCall` |
| FR-B4 | `--tier` (low, medium or high) maps to the newest Haiku, Sonnet and Opus through one table; `--model` pins an id; default low; one tier both acts and judges; server-side fallback off; `doctor` and the method block show the endpoint, and a custom endpoint's host. | M | Tier table test |
| FR-B5 | Replay: a replay agent at the agent seam answers from `cassette.jsonl`, keyed by a hash of the scrubbed request with refs and ids renumbered; a miss fails closed; cassettes are recorded at the tier of the run they replay; only live or near-hit-free replays give a publishable score. | M | Replay round-trip test; miss fails closed |
| FR-B6 | A model-judged pass needs a cited node that code matches to the quoted text or `cite` locator, or it is `unverified`; uncitable passes are `model-only` (counted, `--strict` makes them `unverified`); injection-shaped text is a high-severity finding that makes that screen's model-only passes `unverified`. Refs resolve to handles at snapshot time. | M | Injection fixture: zero forged passes |
| FR-B7 | Findings: always-on code detectors on every screen (console and page errors, 4xx/5xx, secrets, clipping, axe-core, focus traps, open redirects on seen params), with source, severity and evidence; outside the ledger; a run fails on findings only at or above `--fail-on` (default `none`). | M | Detector tests on fixtures |
| FR-B8 | Crawl, opt-in: code-chosen, same origin, never submits forms, skips destructive controls (English and Arabic names, POST/PUT/DELETE forms); 50 screens, depth 3, 2 req/s, stop on the first 429 or 503. | M | Crawl test on a multi-screen fixture; destructive control untouched |
| FR-B9 | Active checks, opt-in: inert probes only, the second account only reads, stored probes tagged `miqyas-probe-<run id>`; need `--active`, and run only on a test host, or on a host named with `--allow-host` that is also an owned host (threat model); `--allow-writes` for writes off a test host; the never-do list (threat model) holds whatever the flags. | M | Off-host refusal test; never-do tests |
| FR-B10 | Model-proposed findings: at most one proposal call per screen, citing nodes and a screenshot or dropped, `unconfirmed` until a code check or second look backs them. | S | Proposal schema test |
| FR-B11 | Corpus: `corpus/<target>/seeds.json` and `corpus/fixtures/<app>/`; 10 categories with at least 10 valid seeds each, plus the readiness part; every seed has a code probe proving it effective; unasserted seeds are placed blind and linted against plans; a reviewed `known-findings.json` per clean build; the 2 Wasl stand-in mutants are rewritten or dropped; Qasd and Mizwala join after ticket 6. | M | Lint test; probe tests |
| FR-B12 | Score: per category and per part (asserted, unasserted, readiness), never blended; asserted = Stryker killed ÷ valid (`detected_elsewhere` counts as killed), shown beside caught by the targeted assertion and caught by code against caught by the judge; unasserted = recall; readiness = per check, seeds caught of seeds placed, and quiet on the clean twin; false positives on each clean twin; shown at ≥10 valid per category and ≥50 per part; scored baselines run 3 times (killed = 2 of 3), development runs once, on one Chromium desktop viewport; the baseline summary and proposed thresholds come as a `bench/` PR merged only with Kahf Labs' yes; `bench/history.jsonl` names each regression. | M | Score tests on synthetic results |

### 3.12 Readiness profiles (M2)
| ID | Requirement | Pri | Acceptance |
|---|---|---|---|
| FR-Q1 | `miqyas run --profile grade-1 --url <url> [--repo <path>]`: runs the profile's readiness checks as assertions Miqyas writes, judged by code into the ledger with evidence and coverage (ADR 0004). | M | e2e on fixture apps |
| FR-Q2 | A check passes only at its declared minimum coverage with nothing found; below it, or with an input missing, it is `not_checked` with the reason and what to add. "Ready" means every check has a recorded pass. | M | Unit tests on synthetic ledgers |
| FR-Q3 | Report: the readiness summary first ("Grade 1: not ready (10 of 13 pass, 2 fail, 1 not checked)"), then per pillar each check with its verdict, coverage and evidence, "not a penetration test" on each security check, then what to add, then the ledger and the findings; `report.json` gains a `readiness` block in its schema. No score out of 100. | M | Report schema test |
| FR-Q4 | Adapters (ADR 0005): each tool reports its version and coverage in the method block; gitleaks (run with `--redact`) and osv-scanner are user-installed binaries that `doctor` lists; migrations are parsed with libpg-query (MIT); a missing binary makes its checks `not_checked`. | M | Shim-on-path e2e; missing-binary test |
| FR-Q5 | `--no-model` runs every check that needs no model (12 of 13) at $0, and the quote says so. | M | Network capture: no model endpoint |
| FR-Q6 | `miqyas update-db` fetches the OSV database, prints what it sends and logs it; nothing but model calls leaves the machine during a run (ADR 0003). | M | Network capture during a run |
| FR-Q7 | Row values a probe reaches are never written to disk or sent to a model; evidence is the status code, table and column names, and "at least one row returned". | M | Sentinel row value absent from the run folder and payloads |
| FR-Q8 | Each Grade 1 check has at least 3 readiness seeds and a clean twin in the corpus, and catches all of them before public copy calls it proven. | M | Readiness part of the score |
| FR-K1–K13 | The 13 Grade 1 checks of PRD §6, with the fail rules stated there; `--profile grade-1` turns the crawl on, and active checks need `--active`. | M | Each check's seeds and clean twin (FR-Q8), e2e |

## 4. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-1 | Correctness | PASS always equals the conjunction of recorded verdicts |
| NFR-2 | Privacy | Only model calls leave the machine; payload log; no telemetry |
| NFR-3 | Security | Keys from the environment only; page content passed to models as data; actions on allowlisted origins |
| NFR-4 | Performance | Core overhead under 1 s per step, model time excluded; 5 plans in parallel by default |
| NFR-5 | Reliability | A worker failure is an error, never a pass; runs resume from the ledger after a crash |
| NFR-6 | Footprint | One shared browser install; retention enforced at the start of each run |
| NFR-7 | Language | Reports and viewer in Arabic (RTL) and English; Thmanyah for Arabic, IBM Plex Sans and Mono |
| NFR-8 | Maintainability | TypeScript strict; offline unit tests for plan parsing, ledger rules, reports, mutation application |
| NFR-9 | Licensing | Decoupled open-core notices in [`LICENSE`](../LICENSE) (`AGPL-3.0-only`), [`LICENSE-APACHE`](../LICENSE-APACHE) (`Apache-2.0`), and [`NOTICE.md`](../NOTICE.md); import and SPDX boundaries checked on CI; dependency licences checked (Playwright Apache-2.0, Midscene.js MIT, axe-core MPL-2.0 unmodified) |

## 5. External interfaces

### 5.1 Plan format
```json
{ "format": "miqyas-plan", "version": 1, "id": "wasl-03-add-pair-validation", "surface": "web",
  "steps": [
    { "id": "s1", "type": "action", "text": "Click Add folder pair, then Create and preview" },
    { "id": "a1", "type": "assertion", "text": "An alert lists the three missing items",
      "check": { "locator": { "role": "alert" }, "expect": "visible" } },
    { "id": "s2", "type": "action", "text": "Click Back" },
    { "id": "a2", "type": "assertion", "text": "Folder pairs is shown again" } ] }
```
Without `check`, the model judges the assertion and the verdict says so.

### 5.2 Worker protocol `miqyas-worker/1`
JSON lines over stdio. Core to worker: `hello`, `open {target}`, `act {step_id, text, locator?, input?}`, `observe`, `check {assertion_id, check?}`, `close`. Worker to core: `ready {surface, capabilities}`, `observation {screenshot, tree}`, `verdict {assertion_id, verdict, evidence}`, `error {code, message}`. Binaries are files in the run folder; messages carry paths.

### 5.3 CLI
`miqyas run <plans> --url | --app | --apk | --bin`, `lint`, `import testsprite <dir>`, `plan draft <spec>`, `contract`, `mutate --preset <name>`, `export <run>`, `report <run>`, `doctor`.

### 5.4 MCP tools
`miqyas_run_plan`, `miqyas_get_ledger`, `miqyas_get_failure`, `miqyas_mutate`, `miqyas_export`, `miqyas_lint`.

### 5.5 Other
Anthropic Messages API; OpenAI-compatible chat with images; Playwright, WebdriverIO, Midscene.js; a PDF library (Typst preferred) and GitHub check runs (P1).

## 6. Data model

`Project(id, allowlist[], model, retention_days, scrub_terms[])` 1:n `Target(id, surface, location, mock)`; `Plan(id, surface, source{authored,testsprite,drafted,recorded})` 1:n `Step(id, position, type, text, check)`; `Run(id, plan_id, target_id, model_id, settings, verdict, exit_code)` 1:n `LedgerEntry(assertion_id, verdict, method{code,ai}, attempt, evidence_id)`; `Evidence(id, crop, node, console, network)`; `MutationRun(id, mutations[], detected[], rate)`; `Export(id, run_id, framework, replay_passed)`; `ModelCall(id, run_id, provider, model, bytes, payload)`; `Scenario(id, seed, devices, faults)` 1:n `InvariantResult(invariant, verdict, evidence_id)`.

## 7. Architecture and stack

TypeScript on Node 20+ for the core, CLI, MCP server (MCP TypeScript SDK), plan schema (JSON Schema), ledger and reports; Vitest for offline tests; a SQLite index over run folders. Workers: Playwright and Midscene.js, WebdriverIO with its Tauri and Appium services, a pseudo-terminal runner. Phase 2: Rust engine worker (tokio, serde) with a fake Drive as a local HTTP server. Later: Python judge on `kahf-agent-harness` (PydanticAI). Layout: `src/{proof-core,adapters,agents,entry}` (`AGPL-3.0-only`), `src/{protocol,scrub,surfaces}`, `src/cli.ts`, `presets/`, `schema/` (`Apache-2.0`), `site/` (miqyas.kahflabs.com, `@kahf/design`). Public repository `miqyas` (decoupled open-core: `AGPL-3.0-only` + `Apache-2.0`).

## 8. Verification

| Area | Method |
|---|---|
| Tool logic | Offline unit tests (plan parsing, ledger, reports, mutation application) |
| Self-check | Wasl preset each release; detection rate in release notes |
| Dogfood | Wasl's 11 plans against ground truth walked by hand (the evaluation) |
| Exports | Export lint; suite passes clean, fails each mutation |
| Harness | Pre-fix Wasl mock fixture: nine silent commands |
| Privacy | Sentinel keys and secrets; scrub-term scan of payloads; network capture |
| Arabic | Fixtures for direction, bidi, plurals, digits, fonts |
| Surfaces | Smoke plans on the Wasl window, Tauri shell, Android app and CLI; engine scenarios with planted bugs |
| Quality | False failures per 100 runs on Kahf apps |

## 9. Traceability

| PRD goal | Requirements |
|---|---|
| G1 Assertion ledger | FR-L1–L7, NFR-1 |
| G2 Mutation self-check | FR-M1–M4 |
| G3 Real regression tests | FR-X1–X4 |
| G4 One CLI and MCP across surfaces | FR-W1–W8, FR-C1–C4 |
| G5 Harness contract checks | FR-H1–H3 |
| G6 Local-first | FR-D1–D5, FR-P5, NFR-2, NFR-3 |
| G7 Arabic and RTL | FR-A1–A6, NFR-7 |
| G8 TestSprite-compatible plans | FR-P1–P4 |
| Early access: hardening | FR-B1–B12 |
| Early access: Grade 1 readiness | FR-Q1–Q8, FR-K1–K13 |
