# Contributing to Miqyas

Thanks for helping. Miqyas is **open code**: the whole source is public under the
[PolyForm Shield License 1.0.0](LICENSE). You may read, run, change and share it, and send pull requests; you may not
use it to provide a product that competes with Miqyas. It is source-available, not open source by the OSI definition.
Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) first, and report security problems through
[SECURITY.md](SECURITY.md), not as public issues.

## Where to start

- The words the code and docs use are in [CONTEXT.md](CONTEXT.md); the contract is the [SRS](docs/SRS.md); the reasons
  behind hard-to-reverse choices are the [ADRs](docs/adr/).
- Open an issue before a large change, so we can agree on the shape first. Small fixes can go straight to a pull
  request.
- A bug fix starts with a test that goes red on the bug.

## Build and run the checks

Node 20 or newer, on macOS, Linux or Windows.

```sh
npm ci
npm run typecheck
npm test                 # unit tests, offline
npx playwright install chromium
npm run test:e2e         # Chromium against a local fixture, scripted agent, no network
```

Tests never call a model and never need a key.

## Contributor agreement

Every pull request needs the [contributor agreement](CLA.md) signed. CLA Assistant comments on your first pull
request; reply with the sentence it shows. **You keep your copyright.** The agreement licenses your work to Kahf Labs,
because Shield has no clause for incoming contributions and does not let anyone sublicense, so without it Kahf Labs
could not ship your change in a paid Miqyas or change the licence later. No pull request merges before it is signed.

## Pull requests

- One change per pull request, with a description of what and why. Link the issue it closes.
- Keep the checks above green and add a test for new behaviour.
- Do not commit keys, secrets, run output (`.miqyas/`) or anything from a real user's app.
- Dependencies: say the licence of anything you add. MIT, Apache-2.0, BSD and ISC are fine; MPL, LGPL, GPL and AGPL
  need a discussion first.
- The names Kahf, Wasl, Qasd and Miqyas and their logos are not licensed for use by forks ([TRADEMARKS.md](TRADEMARKS.md)).
