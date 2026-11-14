# How Miqyas is licensed and offered

Miqyas uses a **decoupled open-core** model that separates the verifiable core engine (`AGPL-3.0-only`) from its open integration surfaces and protocols (`Apache-2.0`) and from separate commercial hosted/UI offerings (outside this repository).

## Code licences in this repository

| Layer | Paths | Licence | Why |
|---|---|---|---|
| Core verification engine (`miqyas-core`) | `src/proof-core/`, `src/adapters/`, `src/agents/`, `src/entry/`, `test/` | GNU Affero General Public License v3.0 ([`AGPL-3.0-only`](../LICENSE)) | Strong copyleft keeps the audit trail, assertion ledger, readiness checks, and mutation self-check auditable while preventing competitors from wrapping `miqyas-core` into a closed SaaS without contributing changes back under AGPL-3.0-only §13 or obtaining a commercial licence. |
| Worker protocol, scrubber, surface drivers, thin CLI, presets, schemas | `src/protocol/`, `src/scrub/`, `src/surfaces/`, `src/cli.ts`, `scripts/`, `presets/`, `schema/` | Apache License 2.0 ([`LICENSE-APACHE`](../LICENSE-APACHE)) | Permissive licence allows teams, CI runners, and custom surface workers (`miqyas-worker/1`) to implement drivers, embed plan schemas, redact secrets, and invoke the CLI without AGPL obligations. |
| Hosted runner & proprietary UI clients (separate commercial products) | Outside this repository | Proprietary (commercial terms from Kahf Labs) | Managed execution convenience, dashboards, and visual workflows monetize hosted infrastructure and UX without gating local CLI/CI transparency. |

## Strict architecture & SPDX boundaries

Four rules keep the `Apache-2.0` interface layer free of `AGPL-3.0-only` obligations:

1. **Process boundary for workers and CLI.** Third-party or proprietary surface workers speak `miqyas-worker/1` JSON lines over stdio (`src/protocol/worker.ts`). `src/cli.ts` (`Apache-2.0`) launches the core entry process (`src/entry/cli.ts`, `AGPL-3.0-only`) as a child process with no JS/TS module import across the boundary.
2. **One-way static import check + SPDX verification.** `npm run lint` (`scripts/check-boundaries.mjs`) enforces both import direction (`Apache-2.0` layers may never import `AGPL-3.0-only` layers) and per-file `SPDX-License-Identifier` headers across `src/`, `scripts/`, and `test/`.
3. **Same repository, separate licence files.** Root [`LICENSE`](../LICENSE) carries GNU AGPL v3.0 (`AGPL-3.0-only`) and [`LICENSE-APACHE`](../LICENSE-APACHE) carries Apache License 2.0 (`Apache-2.0`). Third-party notices live in [`NOTICE.md`](../NOTICE.md).
4. **No third-party dependency leakage into `Apache-2.0` interfaces.** Shared protocol, scrubber, and CLI modules restrict dependencies to permissive Node built-ins or permissive packages; `src/surfaces/web/` bundles unmodified `MPL-2.0` `axe-core` for in-page checks with attribution in [`NOTICE.md`](../NOTICE.md).

## Contributor agreement & commercial dual-licensing

Every external pull request requires signing [`CLA.md`](../CLA.md). Contributors keep copyright to their work and grant Kahf Labs a licence to distribute it under `AGPL-3.0-only`, `Apache-2.0` (in permissive layers), and **commercial dual-licences** for B2B customers who want to embed `miqyas-core` inside proprietary products or hosted platforms without `AGPL-3.0-only` obligations.

For commercial dual-licensing inquiries, contact Kahf Labs.
