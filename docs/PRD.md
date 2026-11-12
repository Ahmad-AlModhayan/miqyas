# Miqyas (مقياس) · Product Requirements

| | |
|---|---|
| Product | Miqyas checks whether your web app is ready to launch, and proves every check it made, from your own machine. An AI tester that proves what it checked, for web first, then desktop, Android and command-line apps. |
| Owner | Kahf Labs |
| Status | Building. Milestone 1 (hardening, then the live Wasl run) is under way; Grade 1 public early access follows. |
| Version | 0.3 (2026-11-03) |
| Changes | 0.3: the readiness hub. Grade 1 readiness for indie and vibe-coded launches comes first, on the web. The incumbent is Lovable's built-in Security checks. Miqyas orchestrates existing runners instead of rebuilding them (ADR 0005). The hardening decisions of map ticket 26 are folded in. 0.2: Miqyas becomes Kahf's testing platform, built on an evaluation of TestSprite on 2026-10-28. |
| License | Open code: PolyForm Shield 1.0.0 (`LICENSE`, `NOTICE.md`). Source-available, not open source by the OSI definition. |
| Related | SRS `docs/SRS.md`, charter `docs/CHARTER.md`, threat model `docs/threat-model.md`, ADRs `docs/adr/`, glossary `CONTEXT.md`.  |

## 1. Summary

Miqyas answers three questions about an app, and keeps evidence for every answer:
- **Verification**: did we build it right?
- **Validation**: did we build the right thing?
- **Readiness**: can it survive the real world?

It is the orchestration and proof layer over the tools developers already trust (Playwright, axe-core, gitleaks,
osv-scanner, later the app's own test runner, Stryker, ZAP and others). Miqyas runs them and turns their output into
code-judged verdicts with evidence and coverage, in one ledger and one report. An AI agent fills only the gaps code
can't: driving a flow and judging what code can't see.

The first product is the **Grade 1 profile**, for indie and vibe-coded launches. Its goal: don't get hacked, don't lose
data, don't run up a $10k bill, and make sure every button works. One command runs 13 readiness checks against the
running app, its served bundle and, if given, its repository. The report says "Grade 1: ready" only when every check
has a recorded pass, and each check shows what it covered. Twelve of the thirteen checks run without any model call,
for $0.

Under it sits the plan-driven tester from 0.2. A plan's actions are carried out on the real app, each written
assertion gets its own verdict with evidence, and a mutation self-check measures whether the tests would catch a break.

Everything runs on the person's machine. Only the model calls they configure leave it, scrubbed and logged. Source
code never reaches a model.

## 2. Problem

**Vibe-coded apps ship with holes nobody checked.** Research for ticket 52 (`docs/research/vibe-failures-2026-11.md`)
ranks what actually hurt these apps in 2025–2026:
1. Supabase tables readable with the public key (CVE-2025-48757: 170 of 1,645 Lovable apps).
2. Firebase and storage left open.
3. Secret keys shipped in the client bundle (400+ found in 5,600 apps).
4. Auth and admin routes with no auth.
5. One user reading another's records.
6. LLM and SMS routes with no limit, which run up bills.

Most of these can be seen from outside the app. The tools a vibe-coder already has list what they found; none shows
what it checked and found clean (`docs/research/grade1-incumbents-2026-11.md`). "No issues found" proves nothing.

**AI testers don't prove what they checked.** Kahf Labs ran TestSprite on Wasl's tray window on 2026-10-28: 53 runs
(53 runs, 11 plans). Its observations were accurate in every run, a run cost about
$0.02, and a 50-case plan took 23 s. It fell short where a tester must be strict:
- **A PASS did not prove the plan was checked.** 17 of 34 written assertions left a trace in the run record, and a
  mutation test caught 3 of 4 breaks: a hidden error list passed.
- **Exports were not regression tests.** 44 of 46 assertions were marked "not verified", 16 used positional XPath,
  and two passing tests had no assertion.
- **Web UI only**, while Wasl's risk sits in the Rust engine, the Tauri shell and Android.
- **It couldn't tell a mock from a backend.** All 8 failures came from the dev mock.
- **Data handling was opaque.** The built app was served to their cloud, with retention undocumented.

## 3. Why build it, and why it holds up

- **Incumbent**: Lovable's built-in Security checks, a free static scan on every publish that lists only what it found.
- **Leap**: Lovable's scanner lists what it found; Miqyas proves what it checked: every Grade 1 check gets one verdict
  with the requests and responses behind it, run from your machine against your app, and a self-check shows each check
  would have caught the bug.
- **Benchmark** (2026-11-04): Miqyas against Lovable's Security checks and the OWASP ZAP baseline
  on the same seeded fixtures and a pinned OWASP Juice Shop, counting seeds caught, false positives on the clean twin,
  and checks that show their coverage, published with the method and versions.
- **Build or reuse**: builds on Playwright, axe-core, gitleaks and osv-scanner behind adapters (ADR 0005); Miqyas's own
  code is the proof layer plus the few checks no licensed tool does within ADR 0002.
- **Money and code**: Free during early access, paid later; open code under PolyForm Shield 1.0.0 (`NOTICE.md`).

**(a) Why a better model or a vendor update does not replace it**
- The gap is accounting, not intelligence. The ledger, coverage, the corpus score and the mutation self-check are
  code that checks the tools and the model.
- Miqyas orchestrates; it doesn't compete with the runners. A better scanner becomes a better adapter.
- Reach is per-app integration: a backend's REST surface, two test accounts, a repository's history, a WebDriver
  plugin in a Tauri shell, a fake Drive beside a real sync engine. No model release ships these.
- A cloud tester's business is running your app in its cloud. Self-hosted runs with any model cut against it.
- Arabic and RTL checks are rules (mirrored layout, bidi isolation, plurals, digits) that Kahf's own apps need in every release.

**(b) Existing alternatives**

| Alternative | What it does well | Gap |
|---|---|---|
| Lovable Security checks (incumbent) | Free scan on every publish; Deep scan of the code; built into the builder | Static; lists findings, not what passed; nothing for runaway spend or dead buttons |
| Supabase Security Advisor | Free lints for RLS and exposed functions on a live project | Supabase only; needs the dashboard; no app-level checks |
| Aikido | Free developer tier; SAST, SCA, secrets; runs Lovable's paid pentest | Cloud; the pentest is credit-priced and takes hours; findings only |
| OWASP ZAP baseline, Nuclei, vibeward | Free and open (Apache-2.0, MIT); passive and template scans | Findings only; active scans send fuzzing volume; no proof of coverage |
| TestSprite | Plain-language plans in a cloud browser; accurate, cheap, fast | §2's figures; web only; runs in its cloud; no security |
| Playwright test generator, Playwright MCP, Midscene.js, Stagehand | Drivers and recorders | No plan format, verdict accounting or readiness; Miqyas builds on them |
| QA Wolf, Momentic | Agent-written tests | Hosted; no self-hosting mentioned; no readiness checks |

## 4. Users and jobs

| User | Job to be done |
|---|---|
| Indie developer or vibe-coder (early access) | "I built it with Lovable. Before launch, tell me whether anyone can read my users' data or run up my bill, and show me what you checked." |
| Developer building with AI agents | "The agent says sign-up works. Show me which checks ran, and hand the failures back to it with proof." |
| Company with a confidential app | «نبي نختبر النظام الداخلي بدون ما يطلع منه شي برا الشركة» |
| QA or engineering lead | "Show me each assertion behind a PASS, and give me tests I can keep in CI." |
| Kahf Labs | "Gate every Wasl release, then Qasd and Mizwala, and produce the numbers behind every comparison table." |

## 5. Goals and non-goals

**Goals for early access (Grade 1, web)**
1. **A Grade 1 profile of 13 code-judged readiness checks** (§6). "Ready" means every check has a recorded pass at its declared coverage.
2. **A free run**: `--no-model` runs 12 of the 13 checks with no model call.
3. **Hardening first**: the crawl, the findings, the verdict's resistance to the page, the quote and the hard cap,
   replay, and the seeded corpus with its score. The live Wasl run clears ticket 33's bar.
4. **Every check proven on the corpus**: at least 3 seeds and a clean twin per check.

**Goals for v1.0**: the seven principles of the charter: the assertion ledger; the mutation self-check;
exported tests that are real regression tests; one CLI and MCP across web, Android, Tauri desktop, command-line programs
and engine scenarios; harness contract checks; local-first with pluggable models; Arabic and RTL built in. Plans stay a
superset of TestSprite's steps.

**Non-goals**
- Not a penetration test, a security audit or a certification. Every security check says so.
- No load, spike or stress testing. Small fixed probes stay within the limits of ADR 0002.
- No cloud where customers' apps run.
- Never uses or reads real users' accounts. On a live host, only test accounts the person makes.
- No rebuilding of runners, drivers or scanners (ADR 0005).
- iOS later (P2). Replacing usability tests with people.

## 6. Scope

**Grade 1 at early access**: every check is judged by code. P is passive, A is active (ADR 0002).

| # | Pillar | Check | Run by | Needs | P/A |
|---|---|---|---|---|---|
| 1 | UI states and flows | Every screen the crawl reaches loads with no page error, uncaught console error or same-origin 5xx | Playwright + crawl | URL | P |
| 2 | UI states and flows | Every control the crawl clicks does something; destructive ones listed as not clicked | Playwright + crawl | URL | P |
| 3 | UI states and flows | Sign-up and log-in work (built-in plan templates) | agent + code | two test accounts | P |
| 4 | UI states and flows | No critical or serious violation on any screen reached | axe-core | URL | P |
| 5 | Security and tenant isolation | No secret key in the served bundle, source maps, URLs, DOM or storage | gitleaks + known formats | URL | P |
| 6 | Security and tenant isolation | No secret key in repo files or git history | gitleaks | `--repo` | P |
| 7 | Data and money | Every public table in the migrations has RLS on | own rule | `--repo` | P |
| 8 | Security and tenant isolation | The public key can't read the backend's tables (Supabase, Firebase) | own probe | `--active`; an owned host off test hosts | A |
| 9 | Security and tenant isolation | One test account can't read the other's records | own probe | `--active`, two test accounts | A |
| 10 | Security and tenant isolation | Routes seen behind log-in refuse a request with no session | own probe | `--active`, one test account | A |
| 11 | Security and tenant isolation | No reflected XSS or open redirect on the params seen | own probe | `--active` | A |
| 12 | Performance and cost | Routes that spend money (LLM, SMS, email) refuse a request with no session | own probe | `--active`; off test hosts, `--allow-writes` and an owned host | A |
| 13 | Code and logic | No critical, high or malicious dependency in the lockfile | osv-scanner | `--repo`, `update-db` | P |

What fails a check:
- axe-core: critical and serious violations.
- osv-scanner: critical and high vulnerabilities, and any `MAL-` entry.
- Errors: uncaught exceptions and same-origin 5xx. A 4xx is a finding.
- Secrets: known key formats only (`sb_secret_`, `service_role` JWTs, `sk_live_`, `AKIA…`, private keys). Generic hits
  are findings.

`--profile grade-1` turns the crawl on. Active checks (8–12) also need `--active`. A missing input or flag makes its
checks `not_checked`, and the report names what to add. If time runs short, checks are
dropped in this order: 12, 11, 3. A dropped check ships as `not_checked`, never as a pass.

**Hardening, before early access**:
- the code-driven crawl
- always-on code detectors
- model-proposed findings, which stay `unconfirmed` until backed
- active checks, with opt-in, test or owned hosts, and inert probes
- cite-matched passes, with `model-only` passes counted apart and `--strict`
- the quote and hard cap, the daily cap, and tiers
- replay from cassettes
- the seeded corpus (10 categories plus the readiness part) and its score

**Readiness roadmap** (no tickets yet):

| | Grade 1: indie or vibe-coded launch | Grade 2: startup or SaaS | Grade 3: enterprise or regulated |
|---|---|---|---|
| Goal | Don't get hacked, lose data or run up a $10k bill; every button works | Zero regressions, fast APIs, tenant isolation | Provable security and audit compliance |
| UI states and flows | Crawl, every control, sign-up and log-in, axe basics (early access); the 5 UI states, viewports, RTL and dark mode, checkout (after) | State-machine graph, flags, roles, visual regression | Cross-browser, WCAG and i18n matrices |
| Security and tenant isolation | Secrets, open tables, IDOR, missing auth, XSS and redirect (early access); headers, SSRF, webhooks, client-set state (after) | OWASP Top 10 DAST, SAST, CVE blocking | Continuous pentest, signed SBOMs, tamper-evident logs |
| Data and money | RLS in migrations, dependencies (early access); float money, constraints, package existence (after) | Races, idempotency, migration rollback, N+1 | Chaos tests, failover, backup restore |
| Performance and cost | Spending routes need a session (early access); rate-limit probe (after) | Spend caps and quotas | Budget alerts and audit |

Pillars 7 (operations) and 8 (AI and compliance) start at Grade 2.

**v1.0 and after** (unchanged from 0.2, re-ordered in §9):
- **P0, v1.0:**
  - plan format, TestSprite import, lint and drafting
  - ledger and failure bundle
  - mutate mode
  - exports with replay
  - harness contract check
  - surfaces: Tauri, Android and CLI programs
  - the Rust engine scenario runner
  - Arabic and RTL checks
  - model router and scrubber
  - CLI, MCP and reports
- **P1:** recorder, persona runs, fix loop over MCP, PDF reports, GitHub check.
- **P2:** iOS; the Python judge on `kahf-agent-harness`.

## 7. Key flows

1. **A vibe-coder before launch.** Sara built a notes app with Lovable on Supabase and synced it to GitHub. She runs
   `miqyas run --profile grade-1 --url https://notes-sara.lovable.app --allow-host notes-sara.lovable.app --active
   --repo ./notes --no-model`, with two test accounts as secrets and the ownership token placed at
   `/.well-known/miqyas.txt`. The result:
   - **Overall:** "Grade 1: not ready (9 of 13 pass, 2 fail, 2 not checked)".
   - **Check 3 is `not_checked`:** sign-up and log-in need a model, and she ran `--no-model`.
   - **Check 8 fails:** the `profiles` table answers the public key with rows. The evidence is the request, the
     status, the column names and "at least one row returned", with no values.
   - **Check 6 fails:** a `service_role` key sits in a commit from August.
   - **Check 12 is `not_checked`:** `/api/chat` spends money, and she didn't pass `--allow-writes`.

   She fixes the policy and rotates the key. Her next run drops `--no-model` and adds `--allow-writes`, so checks 3 and
   12 run too. Once all 13 pass, the report reads "Grade 1: ready".
2. **Wasl, milestone 1.** Wasl's 11 TestSprite plans run on the fixed build with a full ledger of 34 verdicts, and
   `miqyas mutate --preset wasl-tray` catches the four seeded mutations. The live run goes behind a quote, after
   ticket 33's bar.
3. **Vibecoder loop over MCP** (v1.0): Claude Code runs a plan, a success toast appears with no account behind it,
   and the agent gets the crop, the node and the network call, then fixes the handler.
4. **Engine scenario** (M4): two `wasld` instances, a fake Drive that answers HTTP 503, and invariants: no version lost,
   convergence, a conflict copy.
5. **Self-hosted company**: an HR system tested on the company's server with a local model. The payload log shows every
   call stayed local.

## 8. Success metrics (targets for the first 6 months after launch)

| Metric | Target |
|---|---|
| Grade 1 checks that catch every one of their seeds and stay quiet on the clean twin | reported per check; public copy calls only these proven |
| Forged passes on injection seeds; never-do violations | 0; 0 |
| Wasl's four mutations detected on Haiku (TestSprite: 3 of 4) | 4 of 4 |
| Written assertions with a recorded verdict (TestSprite: 17 of 34) | 100% |
| Per-category and per-part corpus scores, false positives, and the Haiku–Opus gap | thresholds set from the first scored baseline |
| Bytes sent anywhere but the model endpoint during a run (network capture) | 0 |
| Cost of a `--no-model` Grade 1 run | $0 |
| Outside teams using it on their own apps | 5 |

These are targets, not results.

## 9. Release plan

| Milestone | Content | When |
|---|---|---|
| M1 Hardening | Spend guard and quote, replay, verdict resistance, detectors and findings, crawl, active checks, corpus and score, scored baseline, live Wasl run | |
| M2 Grade 1 early access | The 13 checks, the profile and readiness report, `--no-model`, the corpus readiness part, distribution, licence | |
| M3 Exports and MCP | Exporter with replay, contract check, MCP server, plan drafting, Arabic and RTL checks | after early access |
| M4 Engine scenarios | Rust worker: two devices, fake Drive, faults, invariants on `wasld` | |
| M5 Desktop and CLI | Tauri on Windows, Linux and macOS (agent-desktop alongside, ticket 48); command-line surface | |
| M6 Android and v1.0 | Android worker, retention | |

## 10. Business model

- Early access is free. Miqyas is paid later, for developers.
- Distribution: a bundled npm tarball on the GitHub Releases of this repository, installed with `npm i -g <url>`.
- No telemetry. Feedback comes by email reply and a form on the site.
- No training on customer data.

## 11. Risks

| Risk | Mitigation |
|---|---|
| "Ready" read as "secure" | Not a penetration test on every security check; coverage line on every check; no public badge in early access |
| Miqyas used against someone else's app | Active checks only on test or owned hosts (token); passive checks see only what a browser loads (ADR 0002) |
| A page forges a pass | Cite-matched passes, injection findings, code-judged readiness, injection seeds with a zero bar |
| Scanner noise (gitleaks precision 46%) | Fail only on known key formats; the rest are findings |
| A runaway bill | Quote, typed cap, daily cap, fail closed; no live run without a person at a terminal |
| One engineer, a 5-week window | Hardening first; cut line with drop order 12, 11, 3; two work groups at most |
| Driver and tool churn | Adapters with pinned versions in the method block (ADR 0005) |

## 12. Open questions

1. The Android driver: Appium through WebdriverIO, or Maestro (M6).
2. Default artifact retention (14 days proposed, ticket 14) and video policy.
3. GitHub checks: a GitHub App, or a token with Checks permission.
4. Thmanyah's licence for commercial use and embedding.
5. Which local vision model is good enough; zero-retention terms with the model provider.
6. axe-core is MPL-2.0: ship it with its notice and a source link. a legal check comes before the first release.
8. OWASP Juice Shop's licence before it's fetched for the corpus.

## 13. Sources

- Research for map ticket 26: `docs/research/replay-2026-11.md`, `detectors-2026-11.md`
- Research for map ticket 50: `docs/research/grade1-incumbents-2026-11.md`, `vibe-failures-2026-11.md`,
  `blackbox-backend-2026-11.md`, `repo-checks-2026-11.md`
- [Lovable security](https://docs.lovable.dev/features/security), [Supabase row level security](https://supabase.com/docs/guides/database/postgres/row-level-security), [Supabase API keys](https://supabase.com/docs/guides/api/api-keys)
- [OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/), [OWASP LLM10:2025 Unbounded Consumption](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/)
- [gitleaks](https://github.com/gitleaks/gitleaks), [osv-scanner](https://github.com/google/osv-scanner), [axe-core](https://github.com/dequelabs/axe-core), [OWASP ZAP](https://www.zaproxy.org/), [Nuclei](https://github.com/projectdiscovery/nuclei)
- [TestSprite pricing](https://www.testsprite.com/pricing), [Playwright](https://playwright.dev/), [Midscene.js](https://midscenejs.com/), [WebdriverIO Tauri service](https://webdriver.io/docs/desktop-testing/tauri/)
