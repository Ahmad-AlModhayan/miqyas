// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { LedgerWriter, readLedger } from '../../src/kernel/ledger.js';
import { MemoryStore, sha256, utf8 } from '../kernel-helpers.js';

const AT = '2026-11-17T10:00:00Z';
const open = (store: MemoryStore) =>
  LedgerWriter.open(store, sha256, { origin: 'run-1', at: AT, body: { format: 1 } });

describe('the ledger writer and reader', () => {
  it('reads back the records in the order they were appended', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    await writer.append('fact', { kind: 'dep.package', n: 1 }, AT);
    await writer.append('verdict', { claim: 'deps@1' }, AT);

    const read = await readLedger(store);
    expect(read.problems).toEqual([]);
    expect(read.records.map((r) => [r.seq, r.t])).toEqual([
      [0, 'run.open'],
      [1, 'fact'],
      [2, 'verdict'],
    ]);
    expect(read.records[1]?.body).toEqual({ kind: 'dep.package', n: 1 });
  });

  it('holds each record in the store as soon as its append resolves', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    await writer.append('fact', { n: 1 }, AT);
    expect((await readLedger(store)).records).toHaveLength(2);
    await writer.append('fact', { n: 2 }, AT);
    expect((await readLedger(store)).records).toHaveLength(3);
  });

  it('keeps the order of appends made without waiting, and refuses a second writer', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    const seqs = await Promise.all([1, 2, 3].map((n) => writer.append('fact', { n }, AT)));
    expect(seqs).toEqual([1, 2, 3]);
    expect((await readLedger(store)).records.map((r) => r.body)).toEqual([{ format: 1 }, { n: 1 }, { n: 2 }, { n: 3 }]);
    await expect(open(store)).rejects.toThrow(/already exists/);
  });

  it('closes the ledger when the store fails a write', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    const append = store.append.bind(store);
    store.append = async () => {
      throw new Error('disk full');
    };
    await expect(writer.append('fact', { n: 1 }, AT)).rejects.toThrow(/disk full/);
    store.append = append;
    await expect(writer.append('fact', { n: 2 }, AT)).rejects.toThrow(/earlier write failed/);
    expect((await readLedger(store)).records).toHaveLength(1);
  });

  it('ends with the seal, and refuses any record after it', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    await writer.append('verdict', { claim: 'deps@1' }, AT);
    expect(await writer.seal({ result: 'pass' }, AT)).toBe(2);

    const read = await readLedger(store);
    expect(read.sealed).toBe(true);
    expect(read.records.at(-1)?.t).toBe('run.seal');
    await expect(writer.append('fact', {}, AT)).rejects.toThrow(/sealed/);
  });

  it('leaves a ledger with no seal when the run stops before sealing', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    await writer.append('fact', { n: 1 }, AT);
    // The run is killed here: the writer is dropped without a seal.

    const read = await readLedger(store);
    expect(read.sealed).toBe(false);
    expect(read.records).toHaveLength(2);
    expect(read.problems).toEqual([]);
  });

  it('drops a torn last line and reports it, without calling it tampering', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    await writer.append('fact', { n: 1 }, AT);
    // A crash in the middle of writing the next line leaves it with no newline.
    await store.append('ledger.jsonl', utf8('{"seq":2,"t":"fact","at":"2026-11-'));

    const read = await readLedger(store);
    expect(read.records.map((r) => r.seq)).toEqual([0, 1]);
    expect(read.lines).toHaveLength(2);
    expect(read.torn).toEqual({ record: 2, bytes: 34 });
    expect(read.problems).toEqual([]);
    expect(read.sealed).toBe(false);
  });

  it('calls bytes after the seal a problem, not a torn line', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    await writer.seal({ result: 'pass' }, AT);
    await store.append('ledger.jsonl', utf8('{"seq":2'));

    const read = await readLedger(store);
    expect(read.problems).toEqual([
      { path: 'ledger.jsonl', record: 2, reason: 'there are bytes after run.seal, which a crash cannot leave' },
    ]);
  });

  it('refuses a body that JSON would change: floating point, undefined, NaN', async () => {
    const writer = await open(new MemoryStore());
    await expect(writer.append('fact', { size: 1.5 }, AT)).rejects.toThrow(/body\.size/);
    await expect(writer.append('fact', { list: [1, Number.NaN] }, AT)).rejects.toThrow(/body\.list\[1\]/);
    await expect(writer.append('fact', { gone: undefined } as never, AT)).rejects.toThrow(/body\.gone/);
    expect(await writer.append('fact', { size: 2, ok: true, none: null, name: 'x' }, AT)).toBe(1);
  });

  it('names the record when a line cannot be read', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    await writer.append('fact', { n: 1 }, AT);
    await writer.append('fact', { n: 2 }, AT);
    const lines = store.textOf('ledger.jsonl').split('\n');
    lines[1] = '{"seq":1,"t":"fact","at":"x","body":';
    lines[2] = lines[2]!.replace('"fact"', '"rumour"');
    store.setText('ledger.jsonl', lines.join('\n'));

    expect((await readLedger(store)).problems).toEqual([
      { path: 'ledger.jsonl', record: 1, reason: 'the line is not JSON' },
      { path: 'ledger.jsonl', record: 2, reason: 'the record type "rumour" is not known' },
    ]);
  });

  it('names a ledger whose first record is not run.open, or whose run.seal is not last', async () => {
    const store = new MemoryStore();
    store.setText(
      'ledger.jsonl',
      [
        '{"seq":0,"t":"fact","at":"x","body":{}}',
        '{"seq":1,"t":"run.seal","at":"x","body":{}}',
        '{"seq":2,"t":"run.open","at":"x","body":{}}',
        '',
      ].join('\n'),
    );

    expect((await readLedger(store)).problems).toEqual([
      { path: 'ledger.jsonl', record: 0, reason: 'the first record is fact, not run.open' },
      { path: 'ledger.jsonl', record: 1, reason: 'run.seal is not the last record' },
      { path: 'ledger.jsonl', record: 2, reason: 'run.open is not the first record' },
    ]);
  });
});
