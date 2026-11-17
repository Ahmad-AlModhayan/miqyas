// SPDX-License-Identifier: AGPL-3.0-only
// The ledger of one run (docs/FOUNDATION.md §5, ADR 0007): ledger.jsonl, one JSON record per line, appended as the run
// goes by one writer and never rewritten. A record is {"seq": n, "t": type, "at": time, "body": {…}}, where seq is the
// record's position in the ledger, counted from 0, and so the index of its leaf in the tree.
import { LEDGER_PATH, type Sha256, type Store, fromUtf8, utf8 } from './store.js';

export const RECORD_TYPES = [
  'run.open',
  'claim',
  'effect',
  'fact',
  'proposal',
  'model.call',
  'verdict',
  'run.seal',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface LedgerRecord {
  seq: number;
  t: RecordType;
  at: string;
  body: Json;
}

/** Something a reader or a verifier found wrong, naming the file and, where there is one, the record. */
export interface Problem {
  path: string;
  record?: number;
  reason: string;
}

export class LedgerError extends Error {}

export interface OpenOptions {
  /** Names the run in the checkpoint. One line, no absolute path. */
  origin: string;
  /** The time of the run.open record, from the caller: the kernel has no clock. */
  at: string;
  /** The run.open record's body. */
  body: Json;
}

const NEWLINE = 0x0a;

/** Writes one run's ledger. Records go to the store one at a time, in the order they were appended. */
export class LedgerWriter {
  private next = 0;
  private sealed = false;
  private broken: unknown = undefined;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly store: Store,
    private readonly sha256: Sha256,
    private readonly origin: string,
  ) {}

  /** Starts a ledger with its run.open record. Refuses a store that already holds a ledger. */
  static async open(store: Store, sha256: Sha256, options: OpenOptions): Promise<LedgerWriter> {
    if ((await store.read(LEDGER_PATH)) !== undefined) {
      throw new LedgerError(`${LEDGER_PATH} already exists: a ledger is written once, by one writer`);
    }
    const writer = new LedgerWriter(store, sha256, options.origin);
    await writer.write('run.open', options.body, options.at);
    return writer;
  }

  /** Appends one record and resolves to its seq once the store holds it. */
  append(t: Exclude<RecordType, 'run.open' | 'run.seal'>, body: Json, at: string): Promise<number> {
    if (t === ('run.open' as RecordType) || t === ('run.seal' as RecordType) || !RECORD_TYPES.includes(t)) {
      return Promise.reject(new LedgerError(`append can't write a ${String(t)} record`));
    }
    return this.write(t, body, at);
  }

  /** Appends run.seal, the last record. Nothing may be appended after it. */
  async seal(body: Json, at: string): Promise<number> {
    const seq = await this.write('run.seal', body, at);
    return seq;
  }

  private write(t: RecordType, body: Json, at: string): Promise<number> {
    if (this.sealed) return Promise.reject(new LedgerError('the ledger is sealed: nothing may follow run.seal'));
    if (this.broken !== undefined) return Promise.reject(new LedgerError('an earlier write failed; the ledger is closed'));
    const wrong = notJson(body, 'body');
    if (wrong !== undefined) return Promise.reject(new LedgerError(`${wrong}: a record holds only JSON, with integers`));
    if (t === 'run.seal') this.sealed = true;
    const seq = this.next++;
    const line = utf8(`${JSON.stringify({ seq, t, at, body })}\n`);
    const done = this.queue.then(async () => {
      if (this.broken !== undefined) throw new LedgerError('an earlier write failed; the ledger is closed');
      try {
        await this.store.append(LEDGER_PATH, line);
      } catch (error) {
        this.broken = error;
        throw error;
      }
      return seq;
    });
    this.queue = done.catch(() => undefined);
    return done;
  }
}

/** Where a value isn't JSON that survives a round trip unchanged; integers only, as facts hold no floating point. */
function notJson(value: unknown, where: string): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? undefined : `${where} is ${value}`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const wrong = notJson(value[i], `${where}[${i}]`);
      if (wrong !== undefined) return wrong;
    }
    return undefined;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      const wrong = notJson(item, `${where}.${key}`);
      if (wrong !== undefined) return wrong;
    }
    return undefined;
  }
  return `${where} is ${typeof value}`;
}

export interface LedgerRead {
  /** Every complete line as stored, without its newline: the leaves of the tree. */
  lines: Uint8Array[];
  /** The records of the lines that could be read, in order. A line that couldn't is a problem, not a record. */
  records: LedgerRecord[];
  sealed: boolean;
  /** A last line with no newline: what a crash leaves. It is dropped and reported here. */
  torn: { record: number; bytes: number } | null;
  problems: Problem[];
}

/** Reads a ledger. Anything it can't read or doesn't recognise is a problem naming the record. */
export async function readLedger(store: Store): Promise<LedgerRead> {
  const bytes = await store.read(LEDGER_PATH);
  const read: LedgerRead = { lines: [], records: [], sealed: false, torn: null, problems: [] };
  if (bytes === undefined) {
    read.problems.push({ path: LEDGER_PATH, reason: 'there is no ledger' });
    return read;
  }
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === NEWLINE) {
      read.lines.push(bytes.slice(start, i));
      start = i + 1;
    }
  }
  if (start < bytes.length) read.torn = { record: read.lines.length, bytes: bytes.length - start };

  read.lines.forEach((line, seq) => {
    const record = parseRecord(line, seq);
    if (typeof record === 'string') read.problems.push({ path: LEDGER_PATH, record: seq, reason: record });
    else read.records.push(record);
  });
  const last = read.lines.length - 1;
  for (const { seq, t } of read.records) {
    if (seq === 0 && t !== 'run.open') {
      read.problems.push({ path: LEDGER_PATH, record: seq, reason: `the first record is ${t}, not run.open` });
    }
    if (seq !== 0 && t === 'run.open') {
      read.problems.push({ path: LEDGER_PATH, record: seq, reason: 'run.open is not the first record' });
    }
    if (seq !== last && t === 'run.seal') {
      read.problems.push({ path: LEDGER_PATH, record: seq, reason: 'run.seal is not the last record' });
    }
  }
  read.sealed = read.records.at(-1)?.t === 'run.seal' && read.records.at(-1)?.seq === last;
  if (read.sealed && read.torn) {
    // The writer appends nothing after the seal, so this is not what a crash leaves.
    read.problems.push({
      path: LEDGER_PATH,
      record: read.torn.record,
      reason: 'there are bytes after run.seal, which a crash cannot leave',
    });
    read.torn = null;
  }
  read.problems.sort((a, b) => (a.record ?? -1) - (b.record ?? -1));
  return read;
}

function parseRecord(line: Uint8Array, seq: number): LedgerRecord | string {
  const text = fromUtf8(line);
  if (text === undefined) return 'the line is not valid UTF-8';
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'the line is not JSON';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'the line is not a JSON object';
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'at,body,seq,t') return `the record has the fields ${keys || '(none)'}, not seq, t, at and body`;
  const record = value as Record<string, unknown>;
  if (record.seq !== seq) return `the record says seq ${JSON.stringify(record.seq)} on line ${seq}`;
  if (!RECORD_TYPES.includes(record.t as RecordType)) return `the record type ${JSON.stringify(record.t)} is not known`;
  if (typeof record.at !== 'string') return 'the record time is not a string';
  return record as unknown as LedgerRecord;
}
