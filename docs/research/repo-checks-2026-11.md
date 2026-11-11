# Repo-side checks for a Grade 1 run

For: ticket 54 (map ticket 50, blocks ticket 57). Question: if a Grade 1 run may read the app's repository (code only, never sent to a
model), which checks pay off most for vibe-coded apps (JS/TS, Next.js or Vite, Supabase or Firebase), and with which
tools? Researched 2026-11-03 from primary sources (official repos, docs, papers); links inline. Nothing was installed
or run: **run times below are not measured** and need a spike before any number goes into the SRS.

Constraint that shapes everything: SRS §2.4 says "Only model calls leave the machine". Any check that queries a
registry or osv.dev breaks that rule unless the SRS gains an explicit, opt-in exception. The recommendation keeps the
default run fully offline.

## Bottom line

| Check | Recommended tool | Licence | Default network | Opt-in network |
|---|---|---|---|---|
| Known vulnerable and known malicious deps | `osv-scanner --offline` | Apache-2.0 (data: mostly CC-BY 4.0) | none | DB download from Google's bucket; sends no project data |
| Secrets in files and git history | `gitleaks git` / `gitleaks dir` with `--redact` | MIT | none documented (verify) | none needed |
| Service/secret keys reachable from client code | own check (TS, ~200 lines) + gitleaks over the built bundle | ours | none | none |
| Hallucinated / slopsquatted packages | own check: lockfile integrity offline; registry lookup opt-in | ours | none | package **names** (public scope only) to registry.npmjs.org / pypi.org |
| Money as floats | own check on SQL AST (`libpg-query`, MIT; wraps libpg_query, BSD-3) + TS AST | ours | none | none |
| Missing DB constraints in Supabase migrations | own rules on the same SQL AST | ours | none | none |

Not recommended: TruffleHog (AGPL-3.0, verifies secrets by sending them to provider APIs by default), `npm audit`
(network-only, npm lockfile only, redundant with OSV), Squawk for this purpose (lints lock safety, not data
modelling), Supabase splinter (no licence file, needs a live database).

What leaves the machine in the recommended set: **nothing during a run**. Two optional, separately-invoked actions
fetch public data: the OSV database download (request reveals the IP and which ecosystems, e.g. `npm/all.zip`), and
the registry existence check (reveals each public package name and the IP). Both need a §2.4 amendment and
Kahf Labs' yes before they ship.

## 1. Known vulnerable dependencies (OSV)

**osv-scanner** ([repo](https://github.com/google/osv-scanner), Apache-2.0, latest v2.7.0, 2026-10-12).

- Lockfiles ([list](https://google.github.io/osv-scanner/supported-languages-and-lockfiles/)): `package-lock.json`,
  `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`; `requirements.txt`, `poetry.lock`, `Pipfile.lock`, `pdm.lock`,
  `uv.lock`, `pylock.toml`. Covers every Grade 1 stack; `npm audit` covers only npm's own lockfile.
- Online mode sends **package names, versions, ecosystems and file hashes** to osv.dev, and names/versions/ecosystems
  to deps.dev for resolution, licences and deprecation; "no source code is transmitted" (README).
- Offline ([docs](https://google.github.io/osv-scanner/usage/offline-mode/)): `--offline` "sends no project or
  dependency information", errors if no local DB. `--offline-vulnerabilities` is weaker (other features may still call
  out); use `--offline`. DB per ecosystem at
  `https://osv-vulnerabilities.storage.googleapis.com/<ECOSYSTEM>/all.zip`, cached under
  `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY`. `--download-offline-databases` refreshes it. Commit-level scanning and
  transitive resolution (Maven only) are off in offline mode; irrelevant for JS/Python lockfiles, which pin the full tree.
- Bonus for slopsquatting: OSV ingests the **OpenSSF Malicious Packages** feed (Apache-2.0, per
  [OSV data sources](https://google.github.io/osv.dev/data/)), so a lockfile entry already reported as malware shows
  up as a `MAL-` finding offline.
- Data licences ([OSV data](https://google.github.io/osv.dev/data/)): GitHub Advisory DB and PyPI Advisory DB are
  CC-BY 4.0; download only the `npm` and `PyPI` zips (Chainguard/Wolfi is CC-BY-NC-ND 4.0 and not needed). If Miqyas
  downloads the zip at the user's request it redistributes nothing; if it ever bundles the DB, CC-BY attribution goes in
  the third-party notices.
- False positives: unreachable vulnerable code is the main noise source; osv-scanner offers call analysis to cut it
  (Go/Rust mainly, per README). No published FP rate found. Present findings with severity and "fixed in" version, not
  as hard fails for dev-only deps.

**npm audit** ([docs](https://docs.npmjs.com/cli/v10/commands/npm-audit)): POSTs every package name and its versions
to `/-/npm/v1/security/advisories/bulk`; the Quick Audit fallback also sends `npm_version`, `node_version`, `platform`,
`arch`, `node_env`. No offline mode; needs `package-lock.json`. Skip.

## 2. Secrets in files and git history

**gitleaks** ([repo](https://github.com/gitleaks/gitleaks), MIT, latest v8.30.1, 2026-03-21).

- Modes: `git` (walks `git log -p`, narrow with `--log-opts`), `dir` (files), `stdin`.
- `--redact` (0-100, default 100 when given) keeps secrets out of the report; Miqyas must always pass it, since the
  report lands in the run folder.
- Suppression the user can own: `.gitleaks.toml` allowlists, `.gitleaksignore` fingerprints, inline
  `gitleaks:allow`, and `--baseline-path` to report only new findings.
- Network: the README documents no network feature. Not verified; the spike should run it with networking blocked.
- Accuracy: Basak et al., ESEM 2023 ([arXiv:2307.00714](https://arxiv.org/abs/2307.00714)), 9 tools on a benchmark:
  gitleaks had the **highest recall (88%)** but **46% precision**, i.e. about one in two findings is noise. GitHub's
  scanner had the best precision (75%); TruffleHog recall 52%. So gitleaks findings should go out as "review" items
  with file, commit and rule, not as verdicts.

Alternatives:
- **secretlint** ([repo](https://github.com/secretlint/secretlint), MIT, Node). An npm library, so it embeds cleanly
  in a TS tool; scans files only, not history. Good fallback if shipping a Go binary is unwelcome.
- **detect-secrets** (Yelp, Apache-2.0, Python, last push 2026-04). Baseline-oriented, needs a Python runtime. No.
- **TruffleHog** ([repo](https://github.com/trufflesecurity/trufflehog), **AGPL-3.0** for v3; contributions need a CLA).
  Verification is on by default: a found secret is sent to the provider's API (e.g. AWS `GetCallerIdentity`) unless
  `--no-verification`. That breaks §2.4 and sends the user's secret to a third party. AGPL also goes to Kahf Labs under the
  Kahf rule. Not recommended.

## 3. Service and secret keys reachable from client code

No off-the-shelf tool knows the framework boundary; this is a Miqyas-specific check and the one most likely to find a
real, high-impact bug in a vibe-coded Supabase app.

Facts it rests on:
- Supabase ([API keys](https://supabase.com/docs/guides/api/api-keys)): `sb_publishable_...` and legacy `anon` keys are
  client-safe; `sb_secret_...` and legacy `service_role` keys bypass RLS and must never be "in a browser, a shipped
  application, or source control". Legacy keys are JWTs starting `eyJ`; telling anon from service_role means decoding
  the payload's `role` claim (standard JWT format; the docs page doesn't spell this out). Secret keys get a 401 from a
  browser User-Agent, which Supabase says is no substitute for keeping them secret.
- Next.js ([env docs](https://nextjs.org/docs/app/guides/environment-variables)): `NEXT_PUBLIC_*` values are inlined at
  build time "into any JavaScript sent to the browser".
- Vite ([env docs](https://vite.dev/guide/env-and-mode)): `VITE_*` are "exposed in client-side source code" and
  "should not contain sensitive information such as API keys".
- Firebase ([API keys](https://firebase.google.com/docs/projects/api-keys)): Firebase API keys are not secrets and are
  fine in code; a Gemini Developer API key must never be. Do not flag `apiKey` in a Firebase config (a known false
  positive for generic scanners).

Method (all local):
1. Env names: flag `NEXT_PUBLIC_` / `VITE_` / `EXPO_PUBLIC_` variables whose name contains `SERVICE_ROLE`, `SECRET`,
   `PRIVATE`, `ADMIN` in `.env*` files and in code.
2. Values: in any client-reachable file (Vite `src/`, Next files with `"use client"` and their imports), flag
   `sb_secret_` literals and JWTs whose `role` is `service_role`; flag imports of `firebase-admin` or service-account
   JSON (`"type": "service_account"`, `private_key`).
3. Strongest signal: if a built bundle exists (`.next/static`, `dist/`), run `gitleaks dir --redact` on it plus the
   same `sb_secret_` / service_role JWT test. A hit in the bundle is proof, not a heuristic.

Expected FP rate: low for steps 2 and 3 (exact prefixes and JWT claims), moderate for step 1 (name matching). Not
measured.

## 4. Hallucinated and slopsquatted packages

Evidence: Spracklen et al., "We Have a Package for You!", USENIX Security 2025
([arXiv:2406.10279](https://arxiv.org/abs/2406.10279)). 576,000 samples from 16 models, Python and JavaScript:
- at least **5.2%** of suggested packages hallucinated for commercial models, **21.7%** for open-source models;
  205,474 unique hallucinated names.
- Re-prompting 10 times: **43%** of hallucinated names came back in all 10 runs, 58% more than once. Repeatable names are
  what makes squatting them worthwhile.
- Only **13.4%** were within Levenshtein distance 1-2 of a real package; 48.6% were distance 6 or more. So a
  typo-distance check alone misses most hallucinations. 8.7% of hallucinated Python names were real npm packages
  (cross-ecosystem confusion).

Implication: the useful question is not "does this look like a typo of `react`" but "does this name exist, and has it
existed long enough to be trusted". A package already in a lockfile with `resolved` and `integrity` did exist at install
time; the risk is that the attacker registered it first.

Method:
- Offline, always: (a) every dependency in `package.json` / `requirements.txt` must appear in the lockfile with a
  `resolved` URL on the expected registry and an `integrity` hash; missing or foreign-registry entries are findings.
  (b) osv-scanner `MAL-` hits (section 1). (c) Edit distance 1-2 against a bundled top-N popular list as a weak,
  low-severity hint.
- Opt-in, network: for each **public** name (skip scoped packages from private registries and anything whose
  `resolved` is not registry.npmjs.org / pypi.org), `GET https://registry.npmjs.org/<name>`
  ([registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)) and read `time.created`; PyPI's
  JSON API for Python. Flag: not found, created within the last N days, or created after the lockfile entry was
  written. Sends: one package name per request, plus IP and User-Agent. The name list reveals the stack, not code.
- Commercial services (Socket and others) do this better with behaviour analysis, but send the manifest to a third
  party. Out of scope for a closed, local-first tool.

FP rate: unknown; "young package" flags legitimate new releases, so report as review items.

## 5. Money stored as floats

Postgres docs ([numeric types](https://www.postgresql.org/docs/current/datatype-numeric.html)): floating-point types
are "inexact" and values are "stored as approximations"; "If you require exact storage and calculations (such as for
monetary amounts), use the `numeric` type instead."

No existing linter covers this (Squawk's 79 rules have none on float or money; see section 6). Method:
- SQL: parse `supabase/migrations/*.sql` with **libpg-query** ([node](https://github.com/launchql/libpg-query-node),
  MIT; wraps pganalyze's [libpg_query](https://github.com/pganalyze/libpg_query), BSD-3, which is the real Postgres
  parser). Flag columns of type `real`, `float4`, `float8`, `double precision`, `float` whose names match
  `price|amount|total|cost|balance|fee|subtotal|tax|discount|salary|payment|refund` (`_cents` suffixed integers pass).
- Code: Prisma `Float` and Drizzle `real()` / `doublePrecision()` on the same names; `parseFloat` / `Number()` on
  money-named fields is too noisy for Grade 1, leave it out.
- FP rate: low on type, moderate on naming (e.g. `rating_total`). Severity: warning.

## 6. Missing DB constraints in Supabase migrations

Candidate tools checked:
- **Squawk** ([repo](https://github.com/sbdchd/squawk), Apache-2.0 / MIT, v2.71.0): its rules
  ([list](https://squawkhq.com/docs/rules)) "focus on ensuring safe migrations and warn about statements that could
  block reads / writes". Useful for production migrations, wrong question for Grade 1.
- **Supabase splinter** ([repo](https://github.com/supabase/splinter)): the official Supabase lints (RLS, exposed auth
  users, etc.), but they are SQL views run against a **live database**, and the repo has **no LICENSE file**, so there
  is no grant to copy them. Could be run against a user's local `supabase start` stack only if the user runs it; not as
  embedded code. Ask Kahf Labs before relying on it.
- **PGlite** ([repo](https://github.com/electric-sql/pglite), Apache-2.0) could apply the migrations in-process and let
  Miqyas query the catalog, but Supabase migrations reference `auth`, `storage` and Supabase roles, which would need
  stubs. A later option, not Grade 1.

Recommended: own rules on the libpg-query AST, a short list with a clear payoff:
1. A `create table` in `public` with no matching `alter table ... enable row level security` in any migration
   (Supabase exposes `public` through the API; without RLS the publishable key reads it). Highest value.
2. RLS enabled but no `create policy` for the table (locked out, or the app uses the service key to get around it,
   which links back to section 3).
3. A `*_id` column with no `references` constraint.
4. Money columns (section 5) with no `check (... >= 0)`; `email`-like columns with no `unique`.
5. Columns that look required (`user_id`, `created_at`, money) without `not null`.

FP rate: rule 1 is precise; rules 3-5 are naming heuristics, report as review items. Not measured.

## Embedding vs calling as an external binary

- **MIT (gitleaks, secretlint, libpg-query) and Apache-2.0 (osv-scanner, PGlite)**: duties attach to distribution, not
  to use. Calling a binary the user installed: no duty. Shipping or auto-downloading the binary with Miqyas: include
  the licence text (and Apache's NOTICE file if the project has one) in the third-party notices. Embedding as an npm
  library (secretlint, libpg-query): same notice duty. No source-disclosure duty either way.
- **BSD-3 (libpg_query)**: notice plus no endorsement; ships inside libpg-query's npm package, so one more notice line.
- **AGPL-3.0 (TruffleHog)**: calling an unmodified binary as a separate program is generally treated as aggregation,
  but bundling it means shipping its licence and offering its source; modifying it and offering it over a network
  triggers source disclosure. Under the Kahf rule this goes to Kahf Labs; the network behaviour already rules it out.
- **No licence (splinter)**: all rights reserved by default; do not copy the SQL.
- **OSV data**: CC-BY 4.0 attribution only if Miqyas redistributes the DB.
- Go binaries (gitleaks, osv-scanner) do not embed in a Node process anyway; the practical choice is "user installs"
  vs "Miqyas downloads a pinned, checksummed release on first use". The second is a download from GitHub at setup, so it
  also needs to fit §2.4 (it sends nothing about the project).

## Recommended minimal set for Grade 1

1. **Client-reachable secret keys** (own check, plus gitleaks over the built bundle). Highest payoff for
   Supabase/Firebase apps.
2. **RLS missing on `public` tables** (own rule on the migrations AST).
3. **Secrets in files and history**: `gitleaks git --redact` and `gitleaks dir --redact`, report-only.
4. **Known vulnerable and malicious deps**: `osv-scanner --offline` against a user-refreshed `npm` / `PyPI` DB.
5. **Lockfile integrity and a weak typo hint** offline; the registry age check stays opt-in.
6. **Money as floats** and the other constraint rules as warnings.

Leaves the machine during a run: nothing. Leaves it only on explicit opt-in commands: OSV zip download (IP, ecosystem
names), tool binary download (IP), registry lookups (public package names, IP). Source files never leave, and none of
these checks involves a model, so §2.4's model rule is untouched; the "only model calls" wording needs an exception
for the opt-in downloads.

## Open items for the spike (ticket 57 or its tickets)

- Measure wall time of gitleaks (`git` mode) and osv-scanner (`--offline`) on two small vibe-coded repos; confirm
  gitleaks makes no network calls with networking blocked.
- Decide install model for Go binaries (user-installed vs pinned download) and record it.
- Owner: §2.4 exception wording for the opt-in downloads; whether the registry age check ships at all.
- Owner: splinter has no licence; ask Supabase or skip.
