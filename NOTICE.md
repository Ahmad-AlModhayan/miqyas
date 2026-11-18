# Notice

Miqyas (مقياس) uses a decoupled open-core licensing split: the core verification engine (`src/proof-core/`, `src/adapters/`, `src/agents/`, `src/entry/`) is licensed under GNU AGPL v3.0 (`AGPL-3.0-only`, [`LICENSE`](LICENSE)); the worker protocol, scrubber, surface drivers, thin CLI launcher, presets, and schemas (`src/protocol/`, `src/scrub/`, `src/surfaces/`, `src/cli.ts`, `presets/`, `schema/`) are licensed under Apache-2.0 ([`LICENSE-APACHE`](LICENSE-APACHE)). Commercial dual-licences are available from Kahf Labs.

Required Notice: Copyright Ahmad AlModhayan, trading as Kahf Labs (https://kahflabs.com)

Dependencies keep their own licences (see `package-lock.json`). The names Kahf, Wasl, Qasd and Miqyas are covered by [TRADEMARKS.md](TRADEMARKS.md), not by the licence.

## Third-Party Notices

- **axe-core** (`axe-core`, version 4.14.0): Copyright Deque Systems, Inc. Licensed under the Mozilla Public License 2.0 (MPL-2.0), bundled and used unmodified. Source code: <https://github.com/dequelabs/axe-core>.
- **libpg-query** (`libpg-query`, version 18.2.4): MIT License; wraps `libpg_query` (Copyright pganalyze, BSD-3-Clause License). Source code: <https://github.com/launchql/libpg-query-node>.
- **@bufbuild/cel** (`@bufbuild/cel`, version 0.6.2): Copyright Buf Technologies, Inc. Apache License 2.0, used unmodified as the CEL engine of the kernel. Source code: <https://github.com/bufbuild/cel-es>.
- **@bufbuild/cel-spec** (`@bufbuild/cel-spec`, version 0.6.2): Apache License 2.0; republishes the conformance tests of google/cel-spec (Copyright Google LLC, Apache License 2.0). Pulled in by `@bufbuild/cel`; its data is also copied, as a subset, to `test/conformance/cel/subset.json`. Source code: <https://github.com/bufbuild/cel-es>.
- **@bufbuild/re2** (`@bufbuild/re2`, version 0.6.2): MIT License; a JavaScript port of RE2 (Copyright The Go Authors, BSD-3-Clause License), used by `@bufbuild/cel` for `matches`. Source code: <https://github.com/bufbuild/cel-es>.
- **@bufbuild/protobuf** (`@bufbuild/protobuf`, version 2.17.0): Apache License 2.0 AND BSD-3-Clause License (the SPDX expression in its package metadata), used by `@bufbuild/cel`. Source code: <https://github.com/bufbuild/protobuf-es>.
- **Ajv** (`ajv`, version 8.20.0): Copyright Evgeny Poberezkin. MIT License, used unmodified to check each fact against the schema of its kind when it is recorded. Source code: <https://github.com/ajv-validator/ajv>.
- **fast-deep-equal** (`fast-deep-equal`, version 3.1.3): Copyright Evgeny Poberezkin. MIT License, used by `ajv`. Source code: <https://github.com/epoberezkin/fast-deep-equal>.
- **fast-uri** (`fast-uri`, version 3.1.9): Copyright Gary Court and The Fastify team. BSD-3-Clause License, used by `ajv`. Source code: <https://github.com/fastify/fast-uri>.
- **json-schema-traverse** (`json-schema-traverse`, version 1.0.0): Copyright Evgeny Poberezkin. MIT License, used by `ajv`. Source code: <https://github.com/epoberezkin/json-schema-traverse>.
- **require-from-string** (`require-from-string`, version 2.0.2): Copyright Vsevolod Strukchinsky. MIT License, used by `ajv`. Source code: <https://github.com/floatdrop/require-from-string>.
- Curated secret-detection regex patterns in `src/surfaces/web/detectors.ts` are derived from **gitleaks** (<https://github.com/gitleaks/gitleaks>), MIT License.
