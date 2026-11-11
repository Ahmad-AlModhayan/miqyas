# Grade 1 incumbents: who checks vibe-coded apps before launch (2026-11)

For: issue ticket 51 (map ticket 50, blocks ticket 56). Question: who already gives indie and vibe-coded apps (Lovable, Bolt, v0,
Replit; Supabase or Firebase backed) a pre-launch check, what they check, what they cost, and how they show what they
checked. Read 2026-11-03 from vendor docs, pricing pages and GitHub (licences read through the GitHub API). Prices
change often; re-check before quoting them publicly.

Grade 1 goal, for reference: don't get hacked, lose data or run up a $10k bill; every button works.

## Bottom line

- **Incumbent to name in the PRD: Lovable's built-in Security checks** (Quick scan at publish, on-demand Deep scan,
  optional Aikido pentest). It is where a vibe-coded launch actually gets checked today, it's free to run, and it already
  bundles the Supabase-style RLS lints and a dependency audit.
- **Runner-up: Aikido.** A broad free-tier platform (SAST, SCA, secrets, DAST, cloud) and the engine behind Lovable's
  dynamic pentest. It is the "real security tool" an indie graduates to.
- **Leap sentence:** *Lovable's scanner lists what it found; Miqyas proves what it checked: every Grade 1 assertion
  (the anon key can't read another user's rows, no secret ships in the bundle, every button does something) gets one
  verdict with the captured request and response, run from your machine against your live app, plus a mutation
  self-check that shows the check would have caught the bug.*
- **Gap nobody fills:** no candidate combines black-box proof (actually trying the anon key, actually clicking every
  button) with an accounting of what was *not* checked. Every tool reports findings; none reports a per-check
  verdict ledger with evidence for the passes. Nobody checks the "$10k bill" risk (unbounded paid API calls, missing
  rate limits on AI or email endpoints) except as a side effect of a general pentest.

## Comparison

| Tool | What it checks | Black-box or repo | Local or cloud | Price | Licence | How it shows what it checked |
|---|---|---|---|---|---|---|
| **Lovable Security** ([docs][lov]) | Quick scan: RLS and access rules, leaked-password protection off, npm advisories, MCP servers with no auth. Deep scan: access control, unauthenticated endpoints, injection, leaked secrets, payments, auth, exposed personal data. Optional Wiz (SCA, SAST) and Aikido (pentest). | Mostly repo and config (static). Aikido add-on is dynamic. | Cloud (inside Lovable) | Scans free; fixes beyond 10 a day cost credits; Security center needs Business or Enterprise; scheduled scans Enterprise only | Proprietary | Findings grouped by area as Critical, Warning, Info; one-line result in the publish dialog; JSON export of dependencies. Only critical dependency issues become findings. No list of passed checks. States it "cannot guarantee complete security". |
| **Lovable + Aikido pentest** ([docs][lovaik]) | AI agents send real payloads, test authn and authz, privilege escalation, API probing | Both: black-box plus white-box (Lovable sends the repo to Aikido) | Cloud; "runs for several hours" | Billed by Aikido: 100 Aikido credits per pentest (until end of June 2026) | Proprietary | Findings with attack analysis, reproduction steps, fix guidance; "only exploitable vulnerabilities"; shareable report and certificate. No raw request and response evidence documented. |
| **Supabase Security Advisor** ([docs][sbadv], [splinter][spl]) | ~19 SQL lints: RLS disabled in public, RLS on with no policy, always-true policies, `auth.users` exposed, security-definer views and functions callable by anon, user-metadata in policies, listable public buckets, GraphQL exposure, sensitive-looking columns | Database schema (white-box, reads the catalog) | Cloud dashboard, plus `supabase db advisors` CLI, MCP `get_advisors`, Management API; lints are plain SQL you can run from `psql` | Free with Supabase | splinter repo has no LICENSE file (GitHub reports none, checked 2026-11-03) | ERROR, WARN, INFO per finding, with ramification and SQL fix; notes "some findings may be intentional". Never tries the anon key against real data. |
| **Aikido** ([pricing][aik]) | SCA, SAST and AI SAST, secrets, IaC, cloud posture, containers, licence risk, DAST; Pro adds attack-surface monitoring, malware; AI pentest on credits | Repo, cloud and URL | Cloud (on-prem scanning on Pro) | Developer $0 (2 users, 10 repos, 1 domain); Basic $300/mo; Pro $600/mo (100 credits); pentest typical $4,000 per app, "no High or Critical = don't pay"; attack suite quote only | Proprietary | Deduplicated findings dashboard, AutoFix PRs, compliance reports |
| **Snyk** ([plans][snyk]) | Open Source (SCA), Code (SAST), IaC, Container; API and Web (DAST) only on Enterprise credits | Repo | Cloud, with CLI and IDE | Free: 200 OSS, 100 Code, 300 IaC, 100 Container tests a month; Team from $25/mo; DAST 3 credits per target per day (Enterprise) | Proprietary (CLI open source) | Findings per project with severity, fix advice. Doesn't touch the running app at Free or Team. |
| **Escape** ([pricing][esc]) | AI pentesting, business-logic DAST, GraphQL and API testing, attack surface, external network | Black-box | Cloud | No public price ("talk to our team") | Proprietary (GraphQL Armor is open source) | Enterprise dashboard. Escape published "The State of Security of Vibe Coded Apps" (~2,000 high-impact issues), so it knows the segment, but sells to security teams. |
| **OWASP ZAP baseline** ([docs][zap]) | Spider for 1 minute, then passive rules only: headers, cookies, info leaks. No attacks. | Black-box | Local (Docker) | Free | Apache-2.0 | Best accounting of the lot: every rule printed as PASS, WARN or FAIL with counts; exit codes 0/1/2/3; HTML, JSON, Markdown, XML reports; rule config file. But it says nothing about RLS, secrets in bundles or IDOR. |
| **Nuclei** ([docs][nuc]) | 6,500+ community YAML templates: known CVEs, misconfigurations, exposures | Black-box | Local CLI (ProjectDiscovery cloud for reporting) | Free; cloud priced separately | MIT (engine and templates) | Matches only; JSON output. Doesn't report which templates ran and passed. |
| **TestSprite** ([pricing][ts]) | AI browser and API tests of features; no security testing listed | Black-box UI plus code map | Cloud (tunnel) | Free 150 credits; $19, $39, $69/mo; Enterprise from $199 | CLI Apache-2.0, MCP BUSL-1.1 | Pass or fail per test; our evaluation found only 17 of 32 assertions in the run record. Covers "every button works" but not "don't get hacked". |
| **vibeward** ([repo][vw]) (2026 newcomer) | 25 rules: secrets in JS bundles, Supabase RLS, Firebase rules, source maps, headers, Next.js, Prisma issues; prompt-time guardrails; probes Supabase tables with the public key (asks first) | Both: URL (`--passive` option) and repo or ZIP | Local (`npx`, Claude Code hook, GitHub Action), no LLM calls | Free | MIT | Markdown, JSON, SARIF; exit code 2 on critical. Says a clean report means only the listed checks passed; excludes IDOR behind login, rate limits, business logic. New and unvetted. |
| **Vibe App Scanner** ([pricing][vas]) (2026 newcomer) | Live-app suite (security, SEO, performance, accessibility, email) plus separate repo scan | Both, kept separate | Cloud | Free preview; Go $29/mo; Pro $49/mo | Proprietary | Findings with copy-paste fixes for your AI tool; weekly monitoring on Pro |

Other free vibe-coding scanners turned up in search (VibeSafely, Vibesecur, Argus at $49/mo for monitoring), all
marketing pages with unverified claims; not evaluated.

## What this means for Miqyas

1. **Free is the price floor.** Lovable's scan, Supabase Advisor, ZAP, Nuclei and vibeward cost nothing. Grade 1 can't
   charge for "we found RLS off"; the value has to be the proof and the coverage of what nothing else checks.
2. **Static is the norm, black-box proof is rare and expensive.** Lovable's own scans, Supabase Advisor and Snyk read
   code or schema. Trying the anon key against real rows or clicking every button costs hours and $100 or more per run
   (Aikido) or a sales call (Escape). vibeward is the only free tool that probes Supabase with the public key.
3. **Nobody shows the passes with evidence.** ZAP comes closest (a PASS, WARN or FAIL line per rule), but its rules are
   passive header checks. Lovable shows findings only; Aikido shows exploitable findings only. Miqyas's ledger (one
   verdict plus evidence per assertion) and mutation self-check have no counterpart.
4. **Reuse, don't rebuild.** ZAP baseline (Apache-2.0), Nuclei (MIT) and vibeward (MIT) are licence-compatible inputs
   Miqyas could run and fold into its ledger. splinter's missing licence needs checking with Kahf Labs before any reuse
   (the lints can be re-derived from the public docs instead).
5. **The "$10k bill" and "every button works" halves are open.** Only TestSprite covers buttons; none checks for
   unmetered paid endpoints (AI, email, SMS) or missing rate limits as a named check.

## Sources

[lov]: https://docs.lovable.dev/features/security
[lovaik]: https://docs.lovable.dev/integrations/aikido
[sbadv]: https://supabase.com/docs/guides/database/database-advisors
[spl]: https://github.com/supabase/splinter
[aik]: https://www.aikido.dev/pricing
[snyk]: https://snyk.io/plans/
[esc]: https://escape.tech/pricing
[zap]: https://www.zaproxy.org/docs/docker/baseline-scan/
[nuc]: https://docs.projectdiscovery.io/opensource/nuclei/overview
[ts]: https://www.testsprite.com/pricing
[vw]: https://github.com/JSiapoDEV/vibeward
[vas]: https://vibeappscanner.com/pricing

- Lovable Security: https://docs.lovable.dev/features/security
- Lovable and Aikido pentest: https://docs.lovable.dev/integrations/aikido
- Supabase Security Advisor: https://supabase.com/docs/guides/database/database-advisors
- splinter (Supabase lints): https://github.com/supabase/splinter
- Aikido pricing: https://www.aikido.dev/pricing
- Snyk plans: https://snyk.io/plans/
- Escape pricing: https://escape.tech/pricing
- ZAP baseline scan: https://www.zaproxy.org/docs/docker/baseline-scan/
- Nuclei overview: https://docs.projectdiscovery.io/opensource/nuclei/overview
- TestSprite pricing: https://www.testsprite.com/pricing
- vibeward: https://github.com/JSiapoDEV/vibeward
- Vibe App Scanner pricing: https://vibeappscanner.com/pricing
- Licences: GitHub API `repos/<owner>/<repo>` for zaproxy/zaproxy (Apache-2.0), projectdiscovery/nuclei (MIT),
  projectdiscovery/nuclei-templates (MIT); supabase/splinter returns no licence.

Not found on primary sources: Lovable plan prices (pricing page rendered no figures), Escape prices, ProjectDiscovery
cloud prices.
