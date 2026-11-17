// SPDX-License-Identifier: AGPL-3.0-only
// The first question `miqyas verify` answers (docs/FOUNDATION.md §5, "Verifying"): is the bundle intact? Every line
// matches the tree the checkpoint fixes, every blob matches the digest a record names for it, and the run was sealed.
// It fails closed: whatever it can't read or doesn't recognise is a problem that names the file and the record. The
// one exception is a torn last line of an unsealed ledger, which is what a crash leaves; it is reported in `torn`.
import { BlobError, BlobStore, blobPath, readBlobRefs } from './blobs.js';
import { type Checkpoint, parseCheckpoint, toBase64 } from './checkpoint.js';
import { type LedgerRecord, type Problem, readLedger } from './ledger.js';
import { CHECKPOINT_PATH, LEDGER_PATH, type Sha256, type Store, equalBytes, fromUtf8, isPlainObject } from './store.js';
import { treeRoot } from './tree.js';

export interface Intact {
  /** Intact and sealed: no problem at all. */
  ok: boolean;
  sealed: boolean;
  /** How many complete lines the ledger holds. */
  records: number;
  /** The head the checkpoint gives, with the root in base64, or null when there is no checkpoint that can be read. */
  head: { origin: string; size: number; root: string } | null;
  torn: { record: number; bytes: number } | null;
  problems: Problem[];
}

export async function verifyIntact(store: Store, sha256: Sha256): Promise<Intact> {
  const ledger = await readLedger(store);
  const problems = [...ledger.problems];
  const n = ledger.lines.length;

  const checkpoint = await readCheckpoint(store, problems);
  if (checkpoint !== undefined) {
    if (checkpoint.size > n) {
      problems.push({
        path: LEDGER_PATH,
        record: n,
        reason: `the checkpoint covers ${checkpoint.size} records and the ledger holds ${n}: records ${n} to ${checkpoint.size - 1} are missing`,
      });
    } else if (!equalBytes(await treeRoot(ledger.lines.slice(0, checkpoint.size), sha256), checkpoint.root)) {
      problems.push({
        path: LEDGER_PATH,
        reason: `records 0 to ${checkpoint.size - 1} do not match the checkpoint root: a line was changed, added or removed`,
      });
    }
    if (ledger.sealed && checkpoint.size !== n) {
      problems.push({
        path: CHECKPOINT_PATH,
        reason: `the ledger is sealed at ${n} records and the checkpoint covers ${checkpoint.size}`,
      });
    }
  }

  if (!ledger.sealed) {
    problems.push({
      path: LEDGER_PATH,
      record: n,
      reason: 'there is no run.seal: the run did not finish, and a run with no seal never passes',
    });
  }

  const blobs = new BlobStore(store, sha256);
  for (const record of ledger.records) await checkBlobs(record, blobs, problems);

  return {
    ok: problems.length === 0,
    sealed: ledger.sealed,
    records: n,
    head:
      checkpoint === undefined
        ? null
        : { origin: checkpoint.origin, size: checkpoint.size, root: toBase64(checkpoint.root) },
    torn: ledger.torn,
    problems,
  };
}

async function readCheckpoint(store: Store, problems: Problem[]): Promise<Checkpoint | undefined> {
  const bytes = await store.read(CHECKPOINT_PATH);
  if (bytes === undefined) {
    problems.push({ path: CHECKPOINT_PATH, reason: 'there is no checkpoint, so no head fixes what the ledger held' });
    return undefined;
  }
  const text = fromUtf8(bytes);
  const checkpoint = text === undefined ? 'the checkpoint is not valid UTF-8' : parseCheckpoint(text);
  if (typeof checkpoint === 'string') {
    problems.push({ path: CHECKPOINT_PATH, reason: checkpoint });
    return undefined;
  }
  return checkpoint;
}

/** Each blob a record names must be in the bundle, with the bytes and size the record gives. */
async function checkBlobs(record: LedgerRecord, blobs: BlobStore, problems: Problem[]): Promise<void> {
  const body = record.body;
  if (!isPlainObject(body) || !('blobs' in body)) return;
  const addProblem = (path: string, reason: string) => problems.push({ path, record: record.seq, reason });
  const { refs, problems: unrecognised } = readBlobRefs(body.blobs);
  for (const reason of unrecognised) addProblem(LEDGER_PATH, reason);
  for (const [name, ref] of refs) {
    const path = blobPath(ref.digest) as string;
    try {
      const bytes = await blobs.get(ref.digest);
      if (bytes.length !== ref.size) {
        addProblem(path, `the blob "${name}" holds ${bytes.length} bytes and the record says ${ref.size}`);
      }
    } catch (error) {
      if (!(error instanceof BlobError)) throw error;
      addProblem(path, `the blob "${name}": ${error.message}`);
    }
  }
}
