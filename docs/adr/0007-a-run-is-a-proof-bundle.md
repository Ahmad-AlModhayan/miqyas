# A run is a proof bundle that anyone can re-check offline

A run used to end in `report.json`, written once when everything had finished. A crash lost the run, nothing could be
recomputed, and an edited report looked like any other. A run now writes a proof bundle as it goes: an append-only
ledger of records (what Miqyas did, the facts it recorded, the verdicts, the seal), with large evidence stored beside it
under its SHA-256. The records are the leaves of a Merkle tree (RFC 9162) over their bytes as stored, and the run ends
by writing the tree's head. `miqyas verify` re-checks a bundle with no target, no model and no network: the bytes are
intact, the result follows from the verdicts, and each verdict follows from the recorded facts. Reports are views of the
bundle and can be regenerated from it.

We chose a record that can be re-checked over a richer report because "proves what it checked" has to hold for someone
who wasn't there when the run happened.

## Considered options

- A hash chain, each record carrying the hash of the one before: rejected for the Merkle tree. It costs about the same
  to write, and it can later prove that one verdict and its evidence belong to a run without handing over the whole
  bundle.
- Canonical JSON (RFC 8785) before hashing: rejected. Hashing the stored bytes keeps canonicalisation off the
  verification path, which is where two implementations most often disagree.
- BLAKE3: rejected for SHA-256, which Node has built in and which the attestation and transparency-log formats already
  use.
- A database as the record: rejected. Files are portable and still readable in ten years; an index over them is a cache.

## Consequences

- A bundle proves that its verdicts follow from its facts and that nothing changed after the head was taken. It can't
  prove that a collector recorded the target faithfully, and unsigned it can't prove who made it. Every report says so.
- The head is printed at the end of a run, so it can be anchored somewhere the bundle's holder doesn't control: a CI
  log, a pull request, a signature.
- A bundle names the exact thing verified by digest: a commit, a build directory, a binary. For a deployed URL, which
  can change under a run, it is the manifest of what was served during the run, and the bundle says that this is what
  it is.
- Facts must be safe to keep. The scrubber runs before anything is recorded, and values a probe must not keep (row
  values, secrets) are recorded as shape and count only. Such a verdict re-checks to the measurement and no further.
- A run without a seal did not finish and is never a pass.
- The model answers recorded in a bundle are its cassette: a replay reads them from there.
- Every format carries a version from its first release.
