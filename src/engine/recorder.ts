// SPDX-License-Identifier: AGPL-3.0-only
// How a run writes its proof bundle (docs/FOUNDATION.md §5, §10). The run, and the collectors it starts, append
// records and store blobs through a RunRecorder and never touch the store or the ledger writer themselves. The
// recorder holds no input or output of its own: it is built over a kernel Store and Sha256 it is handed, and over a
// clock, because the kernel has none and a record's time comes from the caller. It is also where the rules every
// collector follows are enforced (docs/FOUNDATION.md §3): the scrubber runs before every record and every blob is
// written, a fact must match the schema of its kind, and no fact of a collector run is accepted after that run's
// collection fact.
import { type BlobRef, BlobStore } from '../kernel/blobs.js';
import { type Head, toBase64 } from '../kernel/checkpoint.js';
import { type Json, LedgerWriter, type RecordType } from '../kernel/ledger.js';
import type { Fact } from '../kernel/fact.js';
import type { Sha256, Store } from '../kernel/store.js';
import { NO_SCRUB, type ScrubRules, findTerms, isTextMediaType, ruleHits, scrubJson, scrubText, withEncodedTerms } from '../scrub/scrub.js';
import { assertFact } from './fact-check.js';

/** The record types a run appends as it goes: every type but the two that open and close the ledger. */
export type AppendableType = Exclude<RecordType, 'run.open' | 'run.seal'>;

/** How a record names a blob it holds (docs/FOUNDATION.md §3): put it in the record's `blobs`, under any name. */
export type StoredBlob = BlobRef;

/** What the run and its collectors are given. */
export interface RunRecorder {
  /**
   * Appends one record, timed by the recorder's clock, and resolves to its seq once the store holds it. A fact that
   * does not match the schema of its kind is refused with FactRefused; one of a closed collector run, and any fact
   * once the seal has started, is refused too. None of them reaches the ledger.
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
   * Refuses every fact from here on, closes as failed each collector run still open, then appends run.seal with `result` (what the run concluded) and
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
  /**
   * The scrub rules: every record, run.open and the seal among them, and every blob, is scrubbed with them before it
   * is written, each term also as a URL carries it. None by default.
   */
  scrub?: ScrubRules;
}

/** What a record or a blob still held of a scrub rule once it was scrubbed: never the text, only the rule. */
export class ScrubRefused extends Error {
  constructor(what: string, hits: readonly string[]) {
    super(`${what} still holds what the scrub rules remove (${hits.join(', ')}), and is not written`);
    this.name = 'ScrubRefused';
  }
}

/** Scrubs a record's body, then re-scans it as it will be written. */
function scrubbed(body: Json, rules: ScrubRules, what: string): Json {
  if (rules.terms.length === 0) return body;
  const out = scrubJson(body, rules);
  const left = ruleHits(JSON.stringify(out), rules);
  if (left.length > 0) throw new ScrubRefused(what, left);
  return out;
}

/**
 * A blob's bytes as they may be stored. Text is scrubbed as UTF-8 and stored unchanged when nothing matched; bytes that
 * are not text can't be scrubbed without breaking them, so one that holds a term is refused.
 */
function scrubbedBlob(bytes: Uint8Array, mediaType: string, rules: ScrubRules): Uint8Array {
  if (rules.terms.length === 0) return bytes;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (findTerms(text, rules).length === 0) return bytes;
  if (!isTextMediaType(mediaType)) throw new ScrubRefused(`a blob of type ${mediaType}`, ruleHits(text, rules));
  const out = scrubText(text, rules);
  const left = ruleHits(out, rules);
  if (left.length > 0) throw new ScrubRefused(`a blob of type ${mediaType}`, left);
  return new TextEncoder().encode(out);
}

/** The version of the run.seal body this writes. */
export const SEAL_FORMAT = 1;

export async function openRecorder(store: Store, sha256: Sha256, options: RecorderOptions): Promise<OpenRunRecorder> {
  const at = () => options.now().toISOString();
  const rules = withEncodedTerms(options.scrub ?? NO_SCRUB);
  const writer = await LedgerWriter.open(store, sha256, {
    origin: scrubText(options.origin, rules),
    at: at(),
    body: scrubbed(options.open, rules, 'run.open'),
    ...(options.checkpointEvery !== undefined ? { checkpointEvery: options.checkpointEvery } : {}),
  });
  const blobs = new BlobStore(store, sha256);
  const counts = new Map<string, number>([['run.open', 1]]);
  const count = (t: string, by: number) => counts.set(t, (counts.get(t) ?? 0) + by);
  const collectorRuns = new CollectorRuns();
  // Set when the seal starts. From then on no fact is accepted, so no collector run can open or grow while the engine
  // closes the ones still open, and every run in the sealed ledger ends with its collection fact.
  let sealing = false;

  const append = (t: AppendableType, given: Json): Promise<number> => {
    // Scrubbed first, so that the schema checks what will be written. Checked, counted and its run's state changed
    // when asked, not when written: so a seal asked for right after counts every record before it, and a fact asked
    // for after its run's collection fact is refused even while that fact is still being written. A refusal by the
    // writer takes the count and the run's change back.
    let undo = () => {};
    let body: Json;
    try {
      body = scrubbed(given, rules, `a ${t} record`);
      if (t === 'fact') undo = collectorRuns.accept(body);
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

  const record = (t: AppendableType, body: Json): Promise<number> => {
    if (t === 'fact' && sealing) {
      return Promise.reject(new Error('the run is being sealed, or is sealed: no fact is accepted once the seal has started'));
    }
    return append(t, body);
  };

  return {
    record,
    putBlob: async (bytes, mediaType) => ({ ...(await blobs.put(scrubbedBlob(bytes, mediaType, rules), mediaType)) }),
    getBlob: (digest) => blobs.get(digest),
    head: () => writer.head(),
    async seal(result) {
      sealing = true;
      // Every record asked for before the seal settles first, so a fact the writer refused is out of its run's count.
      await writer.head();
      // A collector run still open is one whose collector died or forgot to close: the engine closes it as failed
      // (docs/FOUNDATION.md §3, "It closes"), so that every run in a sealed ledger ends with its collection fact.
      for (const open of collectorRuns.open()) await append('fact', engineClosing(open));
      const byType: { [type: string]: number } = {};
      const all = [...counts, ['run.seal', 1] as const].filter(([, n]) => n > 0);
      for (const [t, n] of all.sort(([a], [b]) => (a < b ? -1 : 1))) byType[t] = n;
      const records = all.reduce((sum, [, n]) => sum + n, 0);
      const seq = await writer.seal({ format: SEAL_FORMAT, counts: { records, byType }, result: scrubbed(result, rules, 'run.seal') }, at());
      return { seq, head: await writer.head() };
    },
  };
}

/**
 * One collector run (docs/FOUNDATION.md §3): one attempt of one collector, named by `by` and `run`, as the recorder
 * has accepted its facts. Not the run of the whole ledger, which run.open and run.seal bound.
 */
interface CollectorRun {
  by: string;
  run: number;
  /** The subject of its first fact, for a run all of whose facts the writer then refused. */
  firstSubject: string;
  /** Its facts accepted and not refused by the writer since, the collection fact aside, in the order accepted. */
  accepted: { subject: string }[];
  /** Its collection fact has been accepted. */
  closed: boolean;
}

/** A collector run whose collection fact has not been accepted. */
type OpenCollectorRun = CollectorRun & { closed: false };

/**
 * The collector runs of one ledger. A collector run is closed by its `collection` fact. Every fact is checked against
 * its kind here, before it is accepted.
 */
class CollectorRuns {
  private readonly runs = new Map<string, CollectorRun>();

  /** Accepts a fact or throws; returns how to take the acceptance back if the writer then refuses the record. */
  accept(body: Json): () => void {
    assertFact(body);
    const fact = body as unknown as Fact;
    const key = JSON.stringify([fact.by, fact.run]);
    const run = this.runs.get(key) ?? { by: fact.by, run: fact.run, firstSubject: fact.subject, accepted: [], closed: false };
    if (run.closed) {
      throw new Error(`a fact of ${fact.by} run ${fact.run} came after that run's collection fact, and the run is closed`);
    }
    this.runs.set(key, run);
    const mine = { subject: fact.subject };
    if (fact.kind === 'collection') run.closed = true;
    else run.accepted.push(mine);
    // Takes back only what this fact changed, whatever was accepted since: the run's facts stay those in the ledger,
    // its subject that of the last of them, and a run left with no fact and no closing is forgotten.
    return () => {
      if (fact.kind === 'collection') run.closed = false;
      else run.accepted.splice(run.accepted.indexOf(mine), 1);
      if (run.accepted.length === 0 && !run.closed && this.runs.get(key) === run) this.runs.delete(key);
    };
  }

  /** The collector runs still open, in the order they opened. */
  open(): OpenCollectorRun[] {
    return [...this.runs.values()].filter((r): r is OpenCollectorRun => !r.closed);
  }
}

/** The collection fact the engine writes for a collector run that ended without closing. */
function engineClosing(open: OpenCollectorRun): Json {
  const fact: Fact = {
    kind: 'collection',
    v: 1,
    by: open.by,
    run: open.run,
    subject: open.accepted.at(-1)?.subject ?? open.firstSubject,
    body: {
      setOut: 'not stated: the collector did not close its run',
      status: 'failed',
      reason: 'the run ended before the collector recorded its collection fact',
      counts: { facts: open.accepted.length },
      dropped: 0,
    },
  };
  return fact as unknown as Json;
}

/** How the head is printed when a run ends, so that it can be published where the bundle's holder doesn't control. */
export function formatHead(head: Head): string {
  return `${head.size} records, root ${toBase64(head.root)}`;
}
