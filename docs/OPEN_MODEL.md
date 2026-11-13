# Miqyas's open model

## 1. Why

Miqyas is built by one person and wants people to help build it: checks, surfaces, fixes, translations and docs. So
Miqyas is **open code**: its whole source is public under the [PolyForm Shield License 1.0.0](../LICENSE). Anyone may
read, run, change and share it and send pull requests; nobody may use it to provide a product that competes with
Miqyas, free or paid. Developers can also check exactly what is scrubbed before anything leaves their machine
([ADR 0003](adr/0003-what-leaves-the-machine.md)).

It is source-available, not open source by the OSI definition, and it never converts to an open-source licence.

The parts that reach into an app are plumbing over tools people already trust (Playwright, WebdriverIO, Appium;
[ADR 0005](adr/0005-miqyas-orchestrates-existing-runners.md)), useful in other people's test tools too. They are
planned as an Apache-2.0 package, `miqyas-drivers`.

## 2. Money and code

| Part | Money | Code | Licence |
|---|---|---|---|
| Miqyas: proof core (ledger, verdict judging, readiness profiles including the 13 Grade 1 checks, mutation self-check, reports), agent team, CLI, CI gate, MCP server | Free during early access, paid later, for developers | Open code | PolyForm Shield 1.0.0 |
| `miqyas-drivers` (planned): the `miqyas-worker/1` protocol, surface drivers, RTL checks, scrubbers, fault presets | Free | Open | Apache-2.0 |

## 3. Plans for the package

1. **One package** holding the `miqyas-worker/1` protocol (SRS §5.2), the web worker now and the Tauri, Android, CLI
   and engine workers as they land, the RTL checks, the scrubbers (`src/core/scrub.ts`) and the fault presets
   (`presets/`). Their tests move with them.
2. **One-way dependency.** Miqyas imports the package; the package never imports the rest of Miqyas. A CI
   import-boundary check fails on any such import, so the package can't pick up Shield-licensed code. A licence
   allow-list covers third-party dependencies.
3. **Same repository.** The package sits in this repository as a folder with its own `LICENSE` (standard Apache-2.0
   text); Miqyas uses it by path (an npm workspace). A registry publish comes only when others want to install it alone.

## 4. Contributions

Every pull request needs the contributor agreement ([CLA.md](../CLA.md), checked by CLA Assistant on people, not
paths). PolyForm Shield has no clause for incoming contributions and forbids sublicensing, so without it Kahf Labs
couldn't sell a contribution in the paid Miqyas or change the licence later. You keep your copyright; neither the
agreement nor Shield transfers it. Code in `miqyas-drivers`, once it exists, also arrives under Apache-2.0 §5.

## 5. Protections

The source is public under PolyForm Shield 1.0.0: nobody may provide a competing product from it, free or paid. A
trademark policy ([TRADEMARKS.md](../TRADEMARKS.md)) keeps forks from using the Kahf, Wasl, Qasd and Miqyas names and
logos. No name is registered yet, so the policy rests on unregistered use. Secrets and signing keys never enter the
repository. Security reports come in privately ([SECURITY.md](../SECURITY.md)) and are fixed before anything is said in
public; a scrubber miss is treated as a security report.
