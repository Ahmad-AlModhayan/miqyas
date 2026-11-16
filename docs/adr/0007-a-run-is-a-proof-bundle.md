# A run is a proof bundle that anyone can re-check offline

A run used to end in `report.json`, written once when everything had finished. A crash lost the run, nothing could be
recomputed, and an edited report looked like any other. A run now writes a proof bundle as it goes: an append-only
ledger of records (what Miqyas did, the facts it recorded, the verdicts, the seal), with large evidence stored beside it
under its SHA-256. The records are the leaves of a Merkle tree (RFC 9162) over their bytes as stored, and the tree's
head is written at intervals and after the seal. `miqyas verify` re-checks a bundle with no target, no model and no
network: the bytes are intact, the result follows from the verdicts, and each verdict follows from the recorded facts.
Reports are views of the bundle and can be regenerated from it.

We chose a record that can be re-checked over a richer report because "proves what it checked" has to hold for someone
who wasn't there when the run happened.

## Considered options

- A hash chain, each record carrying the hash of the one before: rejected for the Merkle tree. The tree is about a
  hundred lines more to write, and it can later prove that one verdict and its evidence belong to a run without
  handing over the whole bundle.
- Canonical JSON (RFC 8785) before hashing: rejected. Nothing here needs a value re-serialised to be hashed: a record
  is hashed as the bytes on disk, and a claim is identified by the bytes of its file. Canonical forms are where two
  implementations are known to drift, on numbers above all.
- BLAKE3: rejected for SHA-256, which Node has built in and which the attestation and transparency-log formats use for
  their digests.
- A database as the record: rejected. Files are portable and still readable in ten years; an index over them is a cache.

## Consequences

- A bundle proves that its verdicts follow from its facts and that nothing in it changed after the head was taken. It
  can't prove that a collector recorded the target faithfully. Unsigned, it can't prove who made it or that nothing was
  left off the end; the head is printed when a run ends so that it can be published somewhere the bundle's holder
  doesn't control. Every report says so.
- Each verdict records how far it can be re-checked: from the facts alone, by re-running derivations too, or only by
  measuring again, when it rests on something a collector computed from data that wasn't kept.
- A bundle names the exact thing verified by digest: a commit, a build directory, a binary. A deployed URL isn't a
  subject, because it changes under a run and its pages differ on every load. What it served is recorded as facts, and
  a run on a URL alone says it has no subject.
- Facts must be safe to keep. The scrubber runs before anything is recorded, and a value a probe must not keep is
  recorded as shape, count and a keyed digest.
- A run without a seal did not finish and is never a pass. It can still be checked up to its last written head, and a
  half-written last line is read as the crash it is.
- The model answers recorded in a bundle are its cassette, and the scrubbed requests are its payload log (ADR 0003).
- Every format carries a version from its first release, and a verifier keeps every version it has shipped.
