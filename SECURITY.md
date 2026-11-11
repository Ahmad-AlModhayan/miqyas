# Security policy

## Reporting a vulnerability

Please report security problems **privately**. Do not open a public issue or pull request.

Use GitHub private vulnerability reporting: go to the repository's **Security** tab and choose
**Report a vulnerability** (https://github.com/Ahmad-AlModhayan/miqyas/security/advisories/new).

Include what you found, the version or commit, and steps to reproduce. These matter most:

- a **scrubber miss**: personal data, a secret or a configured term that reaches a model call or `payloads.jsonl`
  unmasked (see [ADR 0003](docs/adr/0003-what-leaves-the-machine.md)). We treat it as a security report;
- a page that forges a pass, or makes Miqyas act outside the hosts you allowed (ADR 0002, the threat model);
- a way around the spend cap or the write guard.

## What to expect

Reports are answered within a cycle. We confirm the problem, tell you when a fix is planned, fix it before anything is
said in public, and credit you in the advisory if you want that.

## Supported versions

| Version | Supported |
|---|---|
| Latest release | yes |
| Earlier releases | no |
| `main` | fixes land here first |
