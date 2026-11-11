# What leaves the machine

During a run, only model calls leave the machine, and each one is scrubbed and written to `payloads.jsonl`.
Source code never reaches a model, not even for model-proposed findings, and Miqyas never writes in the repository
it reads. Anything else that needs the network, today only the OSV vulnerability database, is fetched by its own named
command (`miqyas update-db`), which prints and logs what it sends. Third-party scanners (gitleaks, osv-scanner) are
binaries the person installs, and Miqyas neither downloads nor bundles them.

## Considered options

- Package-registry lookups during a run, to catch hallucinated packages by age: deferred, since they send every
  package name; the offline malicious-package entries in OSV cover early access.
- Sending code to the model for code-level findings: rejected. It breaks the promise that confidential apps stay
  in-house (PRD §4), which is part of the leap.
