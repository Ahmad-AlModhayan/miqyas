// SPDX-License-Identifier: AGPL-3.0-only
// The ledger of one run (docs/FOUNDATION.md §5, ADR 0007): ledger.jsonl, one JSON record per line, appended as the run
// goes by one writer and never rewritten. A record is {"seq": n, "t": type, "at": time, "body": {…}}, where seq is the
// record's position in the ledger, counted from 0, and so the index of its leaf in the tree. The line is
// JSON.stringify of that object, in that key order; the reader refuses a line with any other bytes.
import { type Head, formatCheckpoint } from './checkpoint.js';
import { readBlobRefs } from './blobs.js';
import { CHECKPOINT_PATH, LEDGER_PATH, type Sha256, type Store, equalBytes, fromUtf8, isPlainObject, utf8 } from './store.js';
import { leafHash, rootOfLeaves } from './tree.js';

const RECORD_TYPES = [
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
  /** The checkpoint is written at open, rewritten after every this many records, and after the seal. */
  checkpointEvery?: number;
}

const CHECKPOINT_EVERY = 256;

const NEWLINE = 0x0a;

/** Writes one run's ledger. Records go to the store one at a time, in the order they were appended. */
export class LedgerWriter {
  private next = 0;
  private sealed = false;
  private broken: unknown = undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly leaves: Uint8Array[] = [];

  private constructor(
    private readonly store: Store,
    private readonly sha256: Sha256,
    private readonly origin: string,
    private readonly checkpointEvery: number,
  ) {}

  /** Starts a ledger with its run.open record. Refuses a store that already holds a ledger. */
  static async open(store: Store, sha256: Sha256, options: OpenOptions): Promise<LedgerWriter> {
    if ((await store.read(LEDGER_PATH)) !== undefined) {
      throw new LedgerError(`${LEDGER_PATH} already exists: a ledger is written once, by one writer`);
    }
    if (options.origin === '' || /[\r\n]/.test(options.origin)) {
      throw new LedgerError('the origin must be one line that names the run');
    }
    const every = options.checkpointEvery ?? CHECKPOINT_EVERY;
    if (!Number.isSafeInteger(every) || every < 1) throw new LedgerError('checkpointEvery must be a whole number above 0');
    const writer = new LedgerWriter(store, sha256, options.origin, every);
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

  /** The size and root of the ledger as written so far: what is printed when a run ends. */
  async head(): Promise<Head> {
    await this.queue;
    return { size: this.leaves.length, root: await rootOfLeaves(this.leaves, this.sha256) };
  }

  /** Every refusal is a rejected LedgerError, and a refused record takes no seq and writes nothing. */
  private write(t: RecordType, body: Json, at: string): Promise<number> {
    let json: string;
    try {
      json = this.serialize(this.next, t, body, at);
    } catch (error) {
      if (error instanceof LedgerError) return Promise.reject(error);
      // A body nested deeper than the stack allows, for one: refused like any other, not thrown.
      return Promise.reject(new LedgerError(`the record could not be checked: ${String(error)}`));
    }
    if (t === 'run.seal') this.sealed = true;
    const seq = this.next++;
    const done = this.queue.then(async () => {
      if (this.broken !== undefined) throw new LedgerError('an earlier write failed; the ledger is closed');
      try {
        await this.store.append(LEDGER_PATH, utf8(`${json}\n`));
        this.leaves.push(await leafHash(utf8(json), this.sha256));
        // At open too, so a run killed before its first interval can still be checked up to here.
        const due = t === 'run.open' || t === 'run.seal' || this.leaves.length % this.checkpointEvery === 0;
        if (due) await this.checkpoint();
      } catch (error) {
        this.broken = error;
        throw error;
      }
      return seq;
    });
    this.queue = done.catch(() => undefined);
    return done;
  }

  /** The record's line without its newline. Throws LedgerError for a record the verifier would fail. */
  private serialize(seq: number, t: RecordType, body: Json, at: string): string {
    if (this.sealed) throw new LedgerError('the ledger is sealed: nothing may follow run.seal');
    if (this.broken !== undefined) throw new LedgerError('an earlier write failed; the ledger is closed');
    if (typeof at !== 'string') throw new LedgerError('the record time must be a string');
    checkBody(body);
    const json = JSON.stringify({ seq, t, at, body });
    // The line is made once, and what it holds is checked again as the reader will read it. A body that answers
    // differently each time it is read cannot pass the check as one thing and be written as another.
    checkBody((JSON.parse(json) as { body: unknown }).body);
    return json;
  }

  private async checkpoint(): Promise<void> {
    const root = await rootOfLeaves(this.leaves, this.sha256);
    await this.store.write(CHECKPOINT_PATH, utf8(formatCheckpoint({ origin: this.origin, size: this.leaves.length, root })));
  }
}

/**
 * The first place where a value isn't JSON that survives a round trip unchanged, and what is there ("body.size is
 * 1.5"), or undefined when there is none. Integers only, as facts hold no floating point.
 */
/** Throws LedgerError for a body the verifier would fail: one that isn't plain JSON, or whose blobs aren't references. */
function checkBody(body: unknown): void {
  const notAllowed = describeNonJson(body, 'body');
  if (notAllowed !== undefined) throw new LedgerError(`${notAllowed}: a record holds only JSON, with integers`);
  const badBlob = isPlainObject(body) && 'blobs' in body ? readBlobRefs(body.blobs).problems[0] : undefined;
  if (badBlob !== undefined) throw new LedgerError(`${badBlob}: each is {digest, size, mediaType}`);
}

function describeNonJson(value: unknown, where: string): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') {
    // JSON writes minus zero as 0, so it would not come back as it went in.
    return Number.isSafeInteger(value) && !Object.is(value, -0) ? undefined : `${where} is ${Object.is(value, -0) ? '-0' : value}`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const notAllowed = describeNonJson(value[i], `${where}[${i}]`);
      if (notAllowed !== undefined) return notAllowed;
    }
    return undefined;
  }
  if (isPlainObject(value)) {
    // JSON drops a symbol key and a property that isn't enumerable, and a getter may answer differently each time.
    if (Object.getOwnPropertySymbols(value).length > 0) return `${where} has a symbol key`;
    for (const key of Object.getOwnPropertyNames(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property === undefined || !property.enumerable || !('value' in property)) {
        return `${where}.${key} is not a plain property`;
      }
      const notAllowed = describeNonJson(property.value, `${where}.${key}`);
      if (notAllowed !== undefined) return notAllowed;
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
  if (read.lines.length === 0) {
    read.problems.push({
      path: LEDGER_PATH,
      record: 0,
      reason: 'the ledger holds no complete record: it does not start with run.open',
    });
  }

  read.lines.forEach((line, seq) => {
    let record: LedgerRecord | string;
    try {
      record = parseRecord(line, seq);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      record = 'the line is nested too deeply to read'; // what the writer refuses to write
    }
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
  if (!isPlainObject(value)) return 'the line is not a JSON object';
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'at,body,seq,t') return `the record has the fields ${keys || '(none)'}, not seq, t, at and body`;
  const record = value;
  if (record.seq !== seq) return `the record says seq ${JSON.stringify(record.seq)} on line ${seq}`;
  if (!RECORD_TYPES.includes(record.t as RecordType)) return `the record type ${JSON.stringify(record.t)} is not known`;
  if (typeof record.at !== 'string') return 'the record time is not a string';
  const notAllowed = describeNonJson(record.body, 'body');
  if (notAllowed !== undefined) return `${notAllowed}: a record holds only JSON, with integers`;
  // The line must be the bytes the writer writes for the record it parses to. That refuses a duplicate key, a
  // byte-order mark, a CR, spaces and escapes the writer doesn't use: anything two parsers could read differently.
  const { seq: s, t, at, body } = record;
  if (!equalBytes(utf8(JSON.stringify({ seq: s, t, at, body })), line)) {
    return 'the line is not the bytes the writer writes for its record, so two readers could read it apart';
  }
  return record as unknown as LedgerRecord;
}
