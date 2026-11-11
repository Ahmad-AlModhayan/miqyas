# Black-box backend checks for Grade 1

Research for ticket 53, 2026-11. Blocks ticket 58, ticket 59.

## Question

From outside and safely, how can Miqyas check that (a) a Supabase or Firebase backend refuses
the reads and writes it should refuse when called with the **public key from the bundle**, (b) one
test account can't read another's records (IDOR / BOLA), and (c) an endpoint that **spends money**
(LLM, SMS, email) has a rate limit or spend cap? For each: the exact requests, the minimum number,
what is read or written, how to stay read-only, how to recognise the backend and endpoint from the
bundle and traffic, and whether it fits the ticket 28 limits — flagging every check that can't, with the
smallest limit change that would make it fit.

## Limits this must fit (from ticket 27 and ticket 28, as confirmed)

- Active checks need the `--active` opt-in; **inert probes only** — unique markers, XSS reflection
  checks, read-only SQL probes. No fuzzing volume. (ticket 27 Q5a, ticket 28 Q5a)
- The **second account only reads**. (ticket 27 Q5, ticket 28 Q5a)
- **Stored probes** (anything the target persists) run only with `--allow-writes`, are tagged
  `miqyas-probe-<run id>`, and are listed in the report for clean-up. (ticket 28 Q16)
- **Test hosts only** (localhost, `.localhost`, `.test`, staging/dev/test/qa label), or a host whose
  exact name is given on the command line with `--allow-host`. A plan file never allows a host. (ticket 27 Q5, ticket 28 Q6a)
- Load default: 50 screens, depth 3, **2 req/s**, **stop on the first 429 or 503**; changing any needs a
  flag shown in the report. (ticket 28 Q7)
- Never, whatever the flags: leave the origin; active checks off a test/`--allow-host` host;
  brute-force logins; bypass CAPTCHA/WAF; upload files no plan names; run page/model code in Node;
  send page data anywhere but the scrubbed model call; type a secret the step doesn't name. (ticket 28 Q8)
- Findings never fail a run by default (`--fail-on none`); a model-proposed finding stays
  `unconfirmed` until a code check backs it. (ticket 27 Q3, ticket 27 Q6)

SRS scope: FR-S1 (Supabase RLS off / readable with the public key), FR-S2 (IDOR, two test users,
read-only unless opted in), FR-S3 (secret keys in served JS — separate, passive), FR-S4 (every
finding says it is not a pen-test; checks only on allowlisted origins). `docs/SRS.md:160-163`.

## Key fact that frames all of (a): the public key is meant to be public

Both vendors state the client key is safe to ship and is **not** a secret. So a GET made with it is
exactly the request the app itself already makes — no more intrusive than loading the app.

- Supabase: the publishable/`anon` key's "privileges are rated low … safe to ship in browsers and
  apps"; because anyone can read it, it "only reaches what Row Level Security allows". It warns the
  key is **not** meant to protect against reverse engineering or network inspection — i.e. reading it
  from the bundle is expected. The `service_role`/secret key "bypasses every Row Level Security
  policy" and must never ship — that is the FR-S3 passive check, not this one.
  [Supabase, API keys](https://supabase.com/docs/guides/api/api-keys)
- Firebase: the `firebaseConfig.apiKey` (`AIza…`) is an app identifier, not a secret; security is
  enforced server-side by Security Rules, not by hiding the key.
  [Firebase, Security Rules](https://firebase.google.com/docs/rules)

Consequence: **read** checks with the public key are inert and read-only by construction and fit the
limits cleanly. Only **write-refusal** checks (which must attempt a write) need `--allow-writes`.

---

## (a) BaaS rules checked with the public key from the bundle

### Recognising the backend from the bundle and traffic

- **Supabase**: bundle holds a URL like `https://<ref>.supabase.co` and an `anon` key — either a JWT
  whose payload has `"role":"anon"` / `"iss":"supabase"`, or the new `sb_publishable_…` form. Live
  traffic goes to `<ref>.supabase.co/rest/v1/…` (PostgREST), `/auth/v1/…`, `/storage/v1/…`, with an
  `apikey:` header and `Authorization: Bearer <key>`. [API keys](https://supabase.com/docs/guides/api/api-keys)
- **Firebase**: bundle holds a `firebaseConfig` object — `apiKey` (`AIza…`), `authDomain`
  (`<pid>.firebaseapp.com`), `projectId`, and for Realtime Database `databaseURL`
  (`https://<pid>.firebaseio.com` or `…-default-rtdb.<region>.firebasedatabase.app`). Live traffic
  goes to `firestore.googleapis.com`, the `firebaseio`/`firebasedatabase.app` host, and
  `identitytoolkit.googleapis.com` (Auth). [RTDB REST](https://firebase.google.com/docs/database/rest/start)

### What "refuses what it should refuse" means per vendor

- **Supabase/PostgREST**: PostgREST exposes every table/view the active role can reach as a one-level
  route, `people` → `/rest/v1/people`, supporting GET/POST/PATCH/DELETE per the role's grants; rows
  are filtered with `?col=op.value` (e.g. `?id=eq.1`). [PostgREST, Tables and Views](https://docs.postgrest.org/en/v12/references/api/tables_views.html)
  RLS decides which rows the `anon`/`authenticated` role may touch. "A table in an exposed schema
  without RLS is readable and writable by any role with a grant on it." With RLS on and no policy,
  "no data is accessible through the API when using a publishable key, until you create policies."
  [Supabase, RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
  So a 200 with rows from the `anon` key = RLS off or a permissive policy = finding (matches FR-S1
  and Security Advisor lints below).
- **Firebase RTDB**: any DB URL is a REST endpoint; "append `.json` to the end of the URL and send a
  request from your favorite HTTPS client." Test mode "allows anyone to read and overwrite your
  data"; locked mode "Denies all reads and writes from mobile and web clients."
  [RTDB REST](https://firebase.google.com/docs/database/rest/start)
  The open rule `".read": true` / `".write": true` (Firestore `allow read, write: if true`) is the
  one Firebase says to **NEVER** use: "it allows anyone to overwrite your entire database … anyone
  who guesses your project ID can steal, modify, or delete the data."
  [Firebase, insecure rules](https://firebase.google.com/docs/rules/insecure-rules)
  So an unauthenticated 200-with-data = open read rule = finding.

### The requests, and the minimum number

**Supabase read-refusal (inert, read-only — fits):**
1. `GET /rest/v1/` with the `apikey`/Bearer headers → PostgREST returns an OpenAPI doc listing every
   exposed table. **1 request** enumerates the surface without guessing names.
2. For each candidate table, `GET /rest/v1/<table>?select=*&limit=1`. **1 request per table.** A 200
   with a row = readable by `anon` (RLS off/permissive). 401/`permission denied` or an empty array
   with RLS-on-no-policy = refused as intended. Reads at most one row; a plain GET; same origin.
   Minimum useful run: `1 + N_tables`, and N can be capped (e.g. first 20 tables) under the 50-screen
   / 2-req/s budget.

**Firebase read-refusal (inert, read-only — fits):**
- RTDB: `GET https://<pid>.firebaseio.com/.json?shallow=true` → **1 request**; `shallow=true` returns
  only top-level keys (no row contents), the least-intrusive confirmation that reads are open. Follow
  with one shallow GET per interesting key if needed.
- Firestore: `GET https://firestore.googleapis.com/v1/projects/<pid>/databases/(default)/documents/<collection>?pageSize=1&key=<apiKey>`.
  **1 request per collection.** A 200 with documents while unauthenticated = open read rule.
- Reads only; no write; same project origin.

**Write-refusal (needs `--allow-writes` — see flag W1):** the only black-box way to show writes are
refused is to attempt one. Send a single inert, tagged row:
- Supabase: `POST /rest/v1/<table>` body `{"<col>":"miqyas-probe-<run id>"}`. 201 = writable by
  `anon` (finding); 401/403 = refused.
- Firebase RTDB: `PUT https://<pid>.firebaseio.com/miqyas-probe-<run id>.json` body
  `"<run id>"`. 200 = writable (finding); 401 = refused.
This **persists data** → a stored probe: `--allow-writes`, `miqyas-probe-<run id>` tag, listed for
clean-up (ticket 28 Q16). Never issue DELETE/PATCH to "clean up" automatically — DELETE is destructive and
on the never-do list; clean-up is reported, not performed. One POST/PUT per table is enough.

### Connection-based variant (FR-S1 first clause) — not black-box, for completeness

FR-S1 also allows "a read-only database connection the user gives". With that, Miqyas can run
Supabase's own linter, **splinter** (`splinter.sql`, Postgres 15+), whose SECURITY lints are the
authoritative list of what to flag: `0013_rls_disabled_in_public` (ERROR), `0008_rls_enabled_no_policy`,
`0007_policy_exists_rls_disabled`, `0024_permissive_rls_policy` (`USING (true)`),
`0023_sensitive_columns_exposed`, `0010_security_definer_view`, `0002_auth_users_exposed`,
`0016_materialized_view_in_api`, `0025_public_bucket_allows_listing`, and the GraphQL exposure lints.
[Supabase, database linter](https://supabase.com/docs/guides/database/database-linter)
These run against the DB, not the public API, so they sit outside the black-box path and the ticket 28
limits (no HTTP to the target). **Licence caveat:** `supabase/splinter` currently exposes no LICENSE
file and the GitHub API reports no licence; reusing its SQL would need Kahf Labs' yes per the
open-source rule. Simpler: treat the lint list as a *reference* for what the public-key probes look
for, and don't vendor the SQL.

### Fit for (a)

- Read-refusal (Supabase + Firebase): **fits** — GET only, 1 + N requests, one row or shallow keys,
  same origin, 2 req/s, stop on 429/503. The public key is meant to be public, so this is no more
  intrusive than the app's own load.
- Write-refusal: **fits only with `--allow-writes`** (stored probe), which already exists (ticket 28 Q16).
  No new limit needed; see flag W1 for the one tightening worth adding.

---

## (b) IDOR / BOLA with two test accounts

### The vulnerability and the standard method

OWASP API1:2023 (Broken Object Level Authorization) is the API top risk: the server trusts a
client-supplied object id and doesn't check the caller may act on that object. Ids "can be sequential
integers, UUIDs, or generic strings" and appear "in the path, query string, headers, or payload";
"The server response is usually enough to understand whether the request was successful."
[OWASP API1:2023 BOLA](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/)
Scenario #1 there is the canonical test shape: learn an object id belonging to someone else, replace
it in the request, and see if the data comes back. OWASP's prevention advice is to "write tests to
evaluate the … authorization mechanism". The matching WSTG control is Authorization Testing
WSTG-ATHZ-04 (Testing for IDOR): log in as one user, note the object references in that user's
requests, then as a second user replay those references and check whether the other user's resource
is returned. [OWASP WSTG](https://owasp.org/www-project-web-security-testing-guide/)

### The requests, and the minimum number

1. During A's **normal authenticated run** (a plan Miqyas already runs), passively record the object
   references A legitimately uses — ids in paths (`/orders/42`), query (`?id=eq.42`,
   `?user_id=eq.<A>`), or body — from traffic Miqyas already captures for the failure bundle
   (`Evidence(network)`, `docs/SRS.md:213`). **0 extra requests.**
2. Sign in as the second test account **B** (both accounts are plan secrets, ticket 27 Q5 / ticket 28 Q5a).
3. For each recorded reference, re-issue A's **GET** as B with A's id substituted. **1 request per
   id.** If B receives A's object (200 with A's content) → BOLA finding, `unconfirmed` until a code
   check backs it (a code check can compare B's response body against the content A saw). If
   403/404/empty → authorization holds.
   - Supabase example: as B, `GET /rest/v1/orders?id=eq.<A's id>&select=*`; a non-empty result that
     is A's row is the finding (RLS not scoped to the owner).
   - Generic REST example: as B, `GET /api/orders/<A's id>`.

Minimum: with K distinct references observed in A's run, **K GETs as B** (K is typically single
digits), plus the A baseline that costs nothing extra.

### How to stay read-only and inside the limits

- **GET only** as B; the second account never writes (ticket 28 Q5a). Reversed direction (A reading B) is
  symmetric and still read-only.
- **Only replay ids Miqyas already observed** in A's own traffic. Do **not** enumerate or increment
  ids to discover others' objects — that is fuzzing volume and is excluded (ticket 28 Q5a). This keeps the
  probe inert and bounded.
- Same origin, 2 req/s, stop on first 429/503.

### Fit for (b)

**Fits** as scoped above: GET-only, second account reads only, no enumeration, references limited to
those seen in A's run, same origin, bounded volume. No limit change needed. (If a future variant
wanted id *enumeration* — e.g. sequential-id ranges — that would break the no-fuzzing-volume rule and
must stay out of scope; flagged here so it isn't added silently.)

---

## (c) Rate limit / spend cap on an endpoint that spends money

### The risk and what a check must show

OWASP API4:2023 (Unrestricted Resource Consumption): some APIs "call paid third-party services for
each request, such as SMS, email, or biometric checks", and repeating them "can run up large
charges" — the SMS scenario triggers "tens of thousands of paid messages in minutes". The expected
mitigations are rate limiting ("Implement a limit on how often a client can interact with the API
within a defined timeframe") and spend caps ("Configure spending limits for all service
providers/API integrations"; when impossible, billing alerts). Testing "needs only simple API
requests, often sent concurrently", watching "response status, time, and length".
[OWASP API4:2023](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/)

To *prove a limiter exists* you must send enough requests to trip it and observe a 429 (or a
`RateLimit`/`Retry-After` header). That is the tension with ticket 28.

### Recognising a money-spending endpoint from the bundle and traffic

- Bundle/route names and handlers: `/send-sms`, `/otp`, `/verify`, `/email`, `/invite`, `/chat`,
  `/complete`, `/generate`, calls to Twilio/SendGrid/Resend/OpenAI/Anthropic SDKs, or a Supabase Edge
  Function / Firebase Callable under those names.
- Traffic: a POST that, in response, causes an out-of-band side effect (an SMS/email arrives) or
  returns LLM tokens; latency and cost scale with the request.
- Response headers worth reading **passively**: `RateLimit-Limit`, `RateLimit-Remaining`,
  `Retry-After`, `X-RateLimit-*`. Their presence is evidence of a limiter with **0 extra requests**.

### Two cases

1. **Rate-limit existence on a non-spending endpoint** (e.g. a read or a login that does not call a
   paid provider): send a **bounded burst** and stop at the first 429/503. Because ticket 28 already says
   "stop on the first 429 or 503", a burst that stops there *confirms* the limiter without exceeding
   it. This **fits** today, provided the endpoint neither spends money nor writes.
2. **The money-spending endpoint itself** (the thing FR-S asks about): every request may **succeed
   and spend** (a real SMS/email/LLM call) *before* any limit trips. That is a side-effecting write
   with a real cost — it is neither inert nor read-only. A single call already violates "inert probes
   only" and spends money.

### Fit for (c)

- Passive header check: **fits** (0 requests beyond the normal run; read-only).
- Rate-limit burst on a **non-spending** endpoint: **fits** as a bounded burst that stops on the
  first 429/503, under `--active` on a test/`--allow-host` host.
- Rate-limit / spend-cap probe on a **money-spending** endpoint: **does NOT fit** the current limits
  (inert-only, read-only, no spend). **Flagged** — see flag C1.

---

## Flags: checks that can't fit, and the smallest change that would

**W1 — Supabase/Firebase write-refusal probe.** Fits via the existing `--allow-writes` + stored-probe
tag, so no *new* limit is needed; the one tightening worth writing down: the report must list the
probe row and Miqyas must **never auto-delete it** (DELETE is on the never-do list). Clean-up is a
reported action for the operator, not an automated one.

**C1 — Rate-limit / spend-cap probe on a money-spending endpoint.** This is the only check that
genuinely can't fit. Smallest change that would make it fit, mirroring ticket 28's own structure:

- Add an opt-in `--rate-limit-probe=<N>` (default **off**), only effective on a host named with
  `--allow-host` **and** `--allow-writes` (because each call spends/side-effects), with **N small and
  hard-capped** (e.g. N ≤ 5, never more than a short burst), still stopping on the first 429/503, and
  the N value printed in the report.
- Require the endpoint to be in the provider's **test/sandbox mode** (e.g. Twilio/SendGrid/Stripe
  test keys) so the N calls spend nothing real; if no sandbox is available, the probe stays off and
  Miqyas reports only the passive header finding.
- Count the N calls against the ticket 29 spend guard (which already must bound crawl + model-proposed
  checks).
- Keep it off the never-do list's intent: no concurrency beyond 2 req/s, no retry past the first
  429/503, and it can only ever run on an explicitly allowed test host.

Net: (a)-read and (b) fit as-is; (a)-write fits via existing `--allow-writes` (W1); (c) fits only for
the passive header check and for bursts against non-spending endpoints — the money-endpoint probe
needs the bounded, sandbox-only, write-opted burst in C1, which is the smallest addition consistent
with ticket 27/#28.

## Prior art and licences

| Tool | What it does | Licence | Usable? |
|---|---|---|---|
| [axe-core](https://github.com/dequelabs/axe-core) | a11y code checks (already chosen ticket 27 Q7) | **MPL-2.0** (gh API) | yes, with notice + source link (per ticket 27) |
| [supabase/splinter](https://github.com/supabase/splinter) | the Supabase Security Advisor SQL lints (reference list above) | **no LICENSE file / none reported by gh API** | reference only; vendoring the SQL needs Kahf Labs' yes |
| [microsoft/restler-fuzzer](https://github.com/microsoft/restler-fuzzer) | spec-driven stateful REST sequencing | **MIT** (gh API) | its *design* (drive requests from an OpenAPI/PostgREST spec) is instructive; its fuzzing *volume* is out of scope under ticket 28 |
| [0xbigshaq/firepwn-tool](https://github.com/0xbigshaq/firepwn-tool) | drives the real Firebase client SDK to test rules | **GPL-3.0** (gh API) | do **not** vendor (GPL → Kahf Labs); confirms the method (public config + client SDK calls) |
| Burp Autorize | replays a request as a second session to detect broken authz (the (b) pattern) | unclear / not stated upstream | method reference only; not vendored |

Method sources are primary: OWASP API1:2023, API4:2023, WSTG; Supabase RLS / API-keys / PostgREST /
linter docs; Firebase Security Rules / insecure-rules / RTDB REST docs. Licences read from the GitHub
API on 2026-11-03.

## Open items handed on

- ticket 58, ticket 59 are blocked by this; they implement the probes and wiring.
- C1's `--rate-limit-probe` and its spend accounting intersect ticket 29 (spend guard) — raise there.
- ticket 32 should seed the corpus fixtures these probes need: an RLS-off Supabase table, an open Firebase
  rule, a two-account IDOR API, and a money-spending endpoint with and without a limiter.
