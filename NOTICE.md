# Notice

Miqyas (مقياس) uses a decoupled open-core licensing split: the core verification engine (`src/proof-core/`, `src/adapters/`, `src/agents/`, `src/entry/`) is licensed under GNU AGPL v3.0 (`AGPL-3.0-only`, [`LICENSE`](LICENSE)); the worker protocol, scrubber, surface drivers, thin CLI launcher, presets, and schemas (`src/protocol/`, `src/scrub/`, `src/surfaces/`, `src/cli.ts`, `presets/`, `schema/`) are licensed under Apache-2.0 ([`LICENSE-APACHE`](LICENSE-APACHE)). Commercial dual-licences are available from Kahf Labs.

Required Notice: Copyright Ahmad AlModhayan, trading as Kahf Labs (https://kahflabs.com)

Dependencies keep their own licences (see `package-lock.json`). The names Kahf, Wasl, Qasd and Miqyas are covered by [TRADEMARKS.md](TRADEMARKS.md), not by the licence.

## Third-Party Notices

- **axe-core** (`axe-core`, version 4.14.0): Copyright Deque Systems, Inc. Licensed under the Mozilla Public License 2.0 (MPL-2.0), bundled and used unmodified. Source code: <https://github.com/dequelabs/axe-core>.
- **libpg-query** (`libpg-query`, version 18.2.4): MIT License; wraps `libpg_query` (Copyright pganalyze, BSD-3-Clause License). Source code: <https://github.com/launchql/libpg-query-node>.
- Curated secret-detection regex patterns in `src/surfaces/web/detectors.ts` are derived from **gitleaks** (<https://github.com/gitleaks/gitleaks>), MIT License.
