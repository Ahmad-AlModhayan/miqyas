# Standard formats at the edges

ADR 0005 put each existing tool behind an adapter written for it. That scales one tool at a time, and it left Miqyas's
own output in a format only Miqyas reads. Where a standard exists, Miqyas now speaks it at both edges. Coming in:
scanner results as SARIF 2.1.0 and test-runner results as JUnit XML, each normalised into facts, so one adapter serves
every tool that writes the format. Going out: a proof bundle exports as an in-toto Statement in a DSSE envelope, so the
supply-chain tools a team already runs can read it and gate a release on it.

No existing in-toto predicate carries a verdict with its coverage for each claim, so Miqyas defines its own predicate
type for the full result and emits a Simple Verification Result beside it, which policy engines already understand.
This is the destination for "ready": a statement about one exact build that someone else can check. Nothing public is
built on it at early access.

## Considered options

- Use an existing predicate only (Test Result, the SLSA verification summary): rejected. They carry a result and a list
  of names, with no coverage and no evidence, which is the gap Miqyas exists to close.
- Keep one adapter per tool: kept, but only for what a format can't say. A tool's report rarely says what it analysed
  or whether it finished, so a thin wrapper still records the command, the exit code, the tool's version and the digest
  of what it was given.
- Make JUnit XML or a newer test-report format the stored type: rejected. Formats drift and lose detail (retries,
  attachments); Miqyas stores its own fact and reads the formats.

## Consequences

- Coverage never comes from the file a tool wrote. Miqyas lists what should be analysed, hands it over, and compares
  (ADR 0006). For a test runner that means listing the tests before running them: a runner that crashed reports no
  failures.
- A subject must be immutable, so the statement names a build by digest and carries a deployed URL as a field
  (ADR 0007).
- The predicate type's address, once published, can't change. It is fixed when the export is built.
- Some scanners that write SARIF have licences that rule them out of a default install. Each is still checked before it
  is added (ADR 0005).
