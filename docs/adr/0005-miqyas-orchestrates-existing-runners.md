# Miqyas orchestrates existing runners; it doesn't rebuild them

Miqyas is the orchestration and proof layer over existing open-source runners and scanners, not a new one (ticket 60). It runs them, turns their output into code-judged verdicts with evidence and coverage, and puts everything in
one ledger and one report. Today that's Playwright, axe-core, gitleaks and osv-scanner. Later it adds the app's own
test runner (Vitest, Jest, pytest), Stryker, ZAP, Nuclei, WebdriverIO and Appium. Each tool sits behind an adapter
that reports what it covered and its version, and the method block prints both. Miqyas writes its own check only when
no tool with a fitting licence does the job within the limits of ADR 0002, and that check's doc says why.

## Considered options

- Write every check in-house for one consistent engine: rejected. It spends the one engineer's time on solved
  problems and loses the trust that established tools carry.
- Wrap ZAP or Nuclei active scans for the Grade 1 security checks: rejected for early access. Their fuzzing volume
  breaks ADR 0002's inert-probe rule, so checks 8–12 are Miqyas's own small probes. ZAP's passive baseline comes in
  after early access.

## Consequences

- Scanners are binaries the person installs (ADR 0003); a missing one makes its checks `not_checked`.
- Tests put recorded-output shims on the tool path, so the CLI seam stays the one place behaviour is tested.
- Licences are checked per tool before it's added (see `CONTRIBUTING.md`). The ticket that adds a
  bundled tool also adds it to a third-party section in `NOTICE.md`.
