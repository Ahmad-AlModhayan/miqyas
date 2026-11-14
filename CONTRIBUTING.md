# Contributing to Miqyas

Thanks for helping. Miqyas follows a **decoupled open-core** model:
the core verification platform (`src/proof-core/`, `src/adapters/`, `src/agents/`, `src/entry/`) is open source under the
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`), while the worker protocol, scrubber, surface drivers,
thin CLI launcher, presets, and schemas (`src/protocol/`, `src/scrub/`, `src/surfaces/`, `src/cli.ts`, `presets/`, `schema/`)
are permissively licensed under the [Apache License 2.0](LICENSE-APACHE) (`Apache-2.0`).
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
request; reply with the sentence it shows. **You keep your copyright.** The agreement grants Kahf Labs the right to
dual-license the core commercially and to ship contributions across our open-core and hosted products. No pull request merges before it is signed.

## Pull requests

- One change per pull request, with a description of what and why. Link the issue it closes.
- Keep `npm run typecheck`, `npm run lint` (which enforces both layer import boundaries and per-layer `SPDX-License-Identifier` headers), `npm run build`, and tests green, and add a test for new behaviour.
- Do not add AGPL-licensed imports into Apache-2.0 layers (`src/protocol/`, `src/scrub/`, `src/surfaces/`, `src/cli.ts`); `npm run lint` checks this automatically.
- Do not commit keys, secrets, run output (`.miqyas/`) or anything from a real user's app.
- Dependencies: say the licence of anything you add. Permissive licences (`Apache-2.0`, `MIT`, `BSD`, `ISC`) fit both layers; adding any `MPL-2.0` or `AGPL-3.0-only` dependency needs a discussion first and may never enter the `Apache-2.0` protocol or CLI layers.
- The names Kahf, Wasl, Qasd and Miqyas and their logos are not licensed for use by forks ([TRADEMARKS.md](TRADEMARKS.md)).
