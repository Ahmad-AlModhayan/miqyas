// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { type Json, LedgerError, LedgerWriter, readLedger } from '../../src/kernel/ledger.js';
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

  it('refuses what JSON would drop or change without saying: minus zero, a symbol key, a hidden property', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    const hidden = Object.defineProperty({ shown: 1 }, 'kept', { value: 2, enumerable: false });

    await expect(writer.append('fact', { n: -0 }, AT)).rejects.toThrow(LedgerError);
    await expect(writer.append('fact', { [Symbol('s')]: 1, n: 1 } as never, AT)).rejects.toThrow(LedgerError);
    await expect(writer.append('fact', hidden as never, AT)).rejects.toThrow(LedgerError);

    expect(store.textOf('ledger.jsonl').split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(await writer.append('fact', { n: 0 }, AT)).toBe(1);
  });

  it('refuses a body that answers differently each time it is read, and writes nothing', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    let reads = 0;
    // A property read through a getter: a whole number the first time it is read, a fraction after that.
    const shifting = {
      get size() {
        reads += 1;
        return reads === 1 ? 1 : 1.5;
      },
    };

    await expect(writer.append('fact', shifting as never, AT)).rejects.toThrow(LedgerError);

    expect(store.textOf('ledger.jsonl').split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(await writer.append('fact', { size: 1 }, AT)).toBe(1);
  });

  it('checks the line it is about to write, so a body that changes between the check and the write is refused', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    // A proxy describes its property as the plain value 1, and answers 1.5 whenever the property is read.
    const twoFaced = new Proxy({ size: 1 }, { get: (target, key) => (key === 'size' ? 1.5 : Reflect.get(target, key)) });

    await expect(writer.append('fact', twoFaced, AT)).rejects.toThrow(/body\.size is 1\.5/);

    const read = await readLedger(store);
    expect(read.problems).toEqual([]);
    expect(read.records.map((r) => r.t)).toEqual(['run.open']);
  });

  it('refuses a record whose blobs are not exact {digest, size, mediaType} entries, and writes nothing', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    const digest = `sha256:${'0'.repeat(64)}`;
    const refused: [unknown, RegExp][] = [
      ['sha256:00', /names its blobs in a form that is not recognised/],
      [[{ digest, size: 1, mediaType: 'x' }], /names its blobs in a form that is not recognised/],
      [{ a: 'sha256:00' }, /the blob "a" is named in a form that is not recognised/],
      [{ a: { digest, size: 1 } }, /the blob "a" is named in a form/],
      [{ a: { digest, size: 1, mediaType: 'x', extra: 1 } }, /the blob "a" is named in a form/],
      [{ a: { digest, size: -1, mediaType: 'x' } }, /the blob "a" is named in a form/],
      [{ a: { digest: 'md5:00', size: 1, mediaType: 'x' } }, /the blob "a" has a digest that is not recognised: "md5:00"/],
      [{ a: { digest: digest.toUpperCase(), size: 1, mediaType: 'x' } }, /the blob "a" has a digest that is not recognised/],
    ];
    for (const [blobs, reason] of refused) {
      const append = writer.append('fact', { blobs } as never, AT);
      await expect(append).rejects.toBeInstanceOf(LedgerError);
      await expect(append).rejects.toThrow(reason);
    }
    expect((await readLedger(store)).records).toHaveLength(1);
    expect(await writer.append('fact', { blobs: { a: { digest, size: 1, mediaType: 'x' } } }, AT)).toBe(1);
  });

  it('refuses input nested too deeply as a rejected LedgerError, writes nothing, and stays open', async () => {
    const store = new MemoryStore();
    const writer = await open(store);
    let deep: Json = 0;
    for (let i = 0; i < 200_000; i++) deep = [deep];

    let append: Promise<number> | undefined;
    expect(() => {
      append = writer.append('fact', { deep }, AT);
    }).not.toThrow();
    await expect(append).rejects.toBeInstanceOf(LedgerError);
    let seal: Promise<number> | undefined;
    expect(() => {
      seal = writer.seal({ deep }, AT);
    }).not.toThrow();
    await expect(seal).rejects.toBeInstanceOf(LedgerError);

    expect((await readLedger(store)).records).toHaveLength(1);
    expect(await writer.append('fact', { n: 1 }, AT)).toBe(1);
  });

  it('names a line nested too deeply to read as a problem, and does not throw', async () => {
    const store = new MemoryStore();
    const deep = `${'['.repeat(200_000)}0${']'.repeat(200_000)}`;
    store.setText('ledger.jsonl', `{"seq":0,"t":"run.open","at":"x","body":{"deep":${deep}}}\n`);

    const read = await readLedger(store);
    expect(read.problems).toEqual([{ path: 'ledger.jsonl', record: 0, reason: 'the line is nested too deeply to read' }]);
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
