# Standard formats at the edges

ADR 0005 put each existing tool behind an adapter written for it. That scales one tool at a time, and it left Miqyas's
own output in a format only Miqyas reads. Where a common format exists, Miqyas now speaks it at both edges. Coming in:
scanner results as SARIF 2.1.0 and test-runner results as JUnit XML, the de facto format, each normalised into facts by
one shared reader. Going out: a proof bundle exports as an in-toto Statement in a DSSE envelope, so the supply-chain
tools a team already runs can read it and gate a release on it.

No existing in-toto predicate carries a verdict with its coverage for each claim, so Miqyas defines its own predicate
type for the full result and emits a Simple Verification Result beside it, which is designed to be read by policy
engines. This is the destination for "ready": a statement about one exact build that someone else can check. Nothing
public is built on it yet.

## Considered options

- Use an existing predicate only: rejected. Test Result carries a result and lists of names, and the SLSA
  verification summary carries levels shaped for SLSA. Neither holds coverage per claim, which is the gap Miqyas
  exists to close.
- Keep only one adapter per tool: rejected for the reading, kept for the running. A shared reader serves every tool
  that writes the format, but a tool's file rarely says what was analysed or whether the tool finished, so a thin
  adapter per tool still records the command, the exit code, the tool's version and the digest of what it was given.
- Make JUnit XML or a newer test-report format the stored type: rejected. The formats drift between tools and lose
  detail (retries, attachments); Miqyas stores its own fact and reads the formats.

## Consequences

- Coverage never comes from the file a tool wrote. Miqyas lists what should be analysed, hands it over, and compares
  (ADR 0006). This supersedes the line of ADR 0005 that had an adapter report what it covered. For a test runner it
  means listing the tests before running them: a runner that crashed reports no failures.
- A statement's subject must be immutable, so it names a build by digest, and a deployed URL is carried as a field of
  the predicate (ADR 0007).
- The predicate type's address, once published, can't change. It is fixed when the export is built.
- Some scanners that write SARIF have licences that rule them out of a default install. Each is still checked before
  it is added (ADR 0005).
