// SPDX-License-Identifier: AGPL-3.0-only
// How a run writes its proof bundle (docs/FOUNDATION.md §5, §10). The run, and the collectors it starts, append
// records and store blobs through a RunRecorder and never touch the store or the ledger writer themselves. The
// recorder holds no input or output of its own: it is built over a kernel Store and Sha256 it is handed, and over a
// clock, because the kernel has none and a record's time comes from the caller. It is also where the rules every
// collector follows are enforced (docs/FOUNDATION.md §3): a fact must match the schema of its kind, and no fact of a
// collector run is accepted after that run's collection fact.
import { BlobStore } from '../kernel/blobs.js';
import { type Head, toBase64 } from '../kernel/checkpoint.js';
import { type Json, LedgerWriter, type RecordType } from '../kernel/ledger.js';
import type { Fact } from '../kernel/fact.js';
import type { Sha256, Store } from '../kernel/store.js';
import { assertFact } from './fact-check.js';

/** The record types a run appends as it goes: every type but the two that open and close the ledger. */
export type AppendableType = Exclude<RecordType, 'run.open' | 'run.seal'>;

/**
 * How a record names a blob it holds (docs/FOUNDATION.md §3): put it in the record's `blobs`, under any name. A type
 * and not an interface, so that it can go straight into a record's body.
 */
export type StoredBlob = { digest: string; size: number; mediaType: string };

/** What the run and its collectors are given. */
export interface RunRecorder {
  /**
   * Appends one record, timed by the recorder's clock, and resolves to its seq once the store holds it. A fact that
   * does not match the schema of its kind is refused with FactRefused, and one of a closed collector run is refused;
   * neither reaches the ledger.
   */
  record(t: AppendableType, body: Json): Promise<number>;
  /** Stores evidence too large for a record, once, under its SHA-256. A fact names it by the BlobRef this returns. */
  putBlob(bytes: Uint8Array, mediaType: string): Promise<StoredBlob>;
  /** A stored blob's bytes. Throws for one that is missing or whose bytes no longer match. */
  getBlob(digest: string): Promise<Uint8Array>;
  /** The size and root of the ledger as written so far. */
  head(): Promise<Head>;
}

/** What closes a run: the seal, written once, and the head that fixes the ledger. */
export interface SealedRun {
  seq: number;
  head: Head;
}

/** The recorder as its owner holds it. Only the owner can seal; the run is handed the RunRecorder alone. */
export interface OpenRunRecorder extends RunRecorder {
  /**
   * Closes as failed each collector run still open, then appends run.seal with `result` (what the run concluded) and
   * the counts, and returns the head to print.
   */
  seal(result: Json): Promise<SealedRun>;
}

export interface RecorderOptions {
  /** Names the run in the checkpoint. One line, no absolute path. */
  origin: string;
  /** The body of run.open. */
  open: Json;
  /** The time of each record. */
  now: () => Date;
  checkpointEvery?: number;
}

/** The version of the run.seal body this writes. */
export const SEAL_FORMAT = 1;

export async function openRecorder(store: Store, sha256: Sha256, options: RecorderOptions): Promise<OpenRunRecorder> {
  const at = () => options.now().toISOString();
  const writer = await LedgerWriter.open(store, sha256, {
    origin: options.origin,
    at: at(),
    body: options.open,
    ...(options.checkpointEvery !== undefined ? { checkpointEvery: options.checkpointEvery } : {}),
  });
  const blobs = new BlobStore(store, sha256);
  const counts = new Map<string, number>([['run.open', 1]]);
  const count = (t: string, by: number) => counts.set(t, (counts.get(t) ?? 0) + by);
  const runs = new CollectorRuns();

  const record = (t: AppendableType, body: Json): Promise<number> => {
    // Checked, counted and its run's state changed when asked, not when written: so a seal asked for right after
    // counts every record before it, and a fact asked for after its run's collection fact is refused even while that
    // fact is still being written. A refusal by the writer takes the count and the run's change back.
    let undo = () => {};
    try {
      if (t === 'fact') undo = runs.accept(body);
    } catch (error) {
      return Promise.reject(error);
    }
    count(t, 1);
    return writer.append(t, body, at()).catch((error: unknown) => {
      count(t, -1);
      undo();
      throw error;
    });
  };

  return {
    record,
    putBlob: async (bytes, mediaType) => ({ ...(await blobs.put(bytes, mediaType)) }),
    getBlob: (digest) => blobs.get(digest),
    head: () => writer.head(),
    async seal(result) {
      // A collector run still open is one whose collector died or forgot to close: the engine closes it as failed
      // (docs/FOUNDATION.md §3, "It closes"), so that every run in a sealed ledger ends with its collection fact.
      for (const open of runs.open()) await record('fact', engineClosing(open));
      const byType: { [type: string]: number } = {};
      const all = [...counts, ['run.seal', 1] as const].filter(([, n]) => n > 0);
      for (const [t, n] of all.sort(([a], [b]) => (a < b ? -1 : 1))) byType[t] = n;
      const records = all.reduce((sum, [, n]) => sum + n, 0);
      const seq = await writer.seal({ format: SEAL_FORMAT, counts: { records, byType }, result }, at());
      return { seq, head: await writer.head() };
    },
  };
}

/** A collector run the recorder has accepted facts from and that has not closed. */
interface OpenRun {
  by: string;
  run: number;
  /** The subject of its last fact. */
  subject: string;
  facts: number;
}

/**
 * The collector runs of one ledger (docs/FOUNDATION.md §3): a run is one attempt of one collector, named by `by` and
 * `run`, and is closed by its `collection` fact. Every fact is checked against its kind here, before it is accepted.
 */
class CollectorRuns {
  private readonly runs = new Map<string, OpenRun | 'closed'>();

  /** Accepts a fact or throws; returns how to take the acceptance back if the writer then refuses the record. */
  accept(body: Json): () => void {
    assertFact(body);
    const fact = body as unknown as Fact;
    const key = JSON.stringify([fact.by, fact.run]);
    const before = this.runs.get(key);
    if (before === 'closed') {
      throw new Error(`a fact of ${fact.by} run ${fact.run} came after that run's collection fact, and the run is closed`);
    }
    const facts = (before?.facts ?? 0) + 1;
    const after = fact.kind === 'collection' ? 'closed' : { by: fact.by, run: fact.run, subject: fact.subject, facts };
    this.runs.set(key, after);
    return () => {
      // Only while nothing of the same run was accepted since; otherwise that later state stands.
      if (this.runs.get(key) !== after) return;
      if (before === undefined) this.runs.delete(key);
      else this.runs.set(key, before);
    };
  }

  /** The runs still open, in the order they opened. */
  open(): OpenRun[] {
    return [...this.runs.values()].filter((r): r is OpenRun => r !== 'closed');
  }
}

/** The collection fact the engine writes for a collector run that ended without closing. */
function engineClosing(open: OpenRun): Json {
  const fact: Fact = {
    kind: 'collection',
    v: 1,
    by: open.by,
    run: open.run,
    subject: open.subject,
    body: {
      setOut: 'not stated: the collector did not close its run',
      status: 'failed',
      reason: 'the run ended before the collector recorded its collection fact',
      counts: { facts: open.facts },
      dropped: 0,
    },
  };
  return fact as unknown as Json;
}

/** How the head is printed when a run ends, so that it can be published where the bundle's holder doesn't control. */
export function formatHead(head: Head): string {
  return `${head.size} records, root ${toBase64(head.root)}`;
}
