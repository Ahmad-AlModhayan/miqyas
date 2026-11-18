// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { BlobStore, blobPath } from '../../src/kernel/blobs.js';
import { formatCheckpoint, parseCheckpoint } from '../../src/kernel/checkpoint.js';
import { LedgerWriter } from '../../src/kernel/ledger.js';
import { verifyIntact, verifyResult } from '../../src/kernel/verify.js';
import { MemoryStore, independentCheckpoint, sha256, utf8 } from '../kernel-helpers.js';

const AT = '2026-11-17T10:00:00Z';

/** A finished run: run.open, a fact that names a blob, a verdict, the seal. */
async function bundle(options: { seal?: boolean; checkpointEvery?: number } = {}) {
  const store = new MemoryStore('runs/a');
  const writer = await LedgerWriter.open(store, sha256, {
    origin: 'run-1',
    at: AT,
    body: { format: 1 },
    checkpointEvery: options.checkpointEvery,
  });
  const ref = await new BlobStore(store, sha256).put(utf8('{"packages":[]}'), 'application/json');
  await writer.append('fact', { kind: 'dep.package', body: { name: 'left-pad' }, blobs: { lockfile: { ...ref } } }, AT);
  await writer.append('verdict', { claim: 'deps@1', verdict: 'pass' }, AT);
  if (options.seal !== false) await writer.seal({ result: 'pass' }, AT);
  return { store, writer, ref };
}

describe('verifying a proof bundle is intact', () => {
  it('passes an untouched bundle', async () => {
    const { store } = await bundle();
    const result = await verifyIntact(store, sha256);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.sealed).toBe(true);
    expect(result.checkpoint?.size).toBe(4);
    expect(store.textOf('checkpoint')).toBe(independentCheckpoint('run-1', store.textOf('ledger.jsonl')));
  });

  it('fails when a ledger line is edited, naming the records the checkpoint covers', async () => {
    const { store } = await bundle();
    store.setText('ledger.jsonl', store.textOf('ledger.jsonl').replace('"verdict":"pass"', '"verdict":"fail"'));

    const result = await verifyIntact(store, sha256);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      {
        path: 'ledger.jsonl',
        reason: 'records 0 to 3 do not match the checkpoint root: a line was changed, added or removed',
      },
    ]);
  });

  it('fails when a blob is changed, naming the record that names it', async () => {
    const { store, ref } = await bundle();
    const path = blobPath(ref.digest) as string;
    store.setText(path, '{"packages":["x"]}');

    const result = await verifyIntact(store, sha256);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      { path, record: 1, reason: expect.stringMatching(/^the blob "lockfile": .*does not match its digest/) },
    ]);
  });

  it('fails when a blob is missing, or its size is not the one recorded', async () => {
    const missing = await bundle();
    missing.store.files.delete(`${missing.store.root}/${blobPath(missing.ref.digest)}`);
    expect((await verifyIntact(missing.store, sha256)).problems).toEqual([
      { path: blobPath(missing.ref.digest), record: 1, reason: expect.stringMatching(/there is no blob/) },
    ]);

    const store = new MemoryStore();
    const writer = await LedgerWriter.open(store, sha256, { origin: 'run-1', at: AT, body: {} });
    const ref = await new BlobStore(store, sha256).put(utf8('hello'), 'text/plain');
    await writer.append('fact', { blobs: { greeting: { ...ref, size: 6 } } }, AT);
    await writer.seal({}, AT);
    expect((await verifyIntact(store, sha256)).problems).toEqual([
      { path: blobPath(ref.digest), record: 1, reason: 'the blob "greeting" holds 5 bytes and the record says 6' },
    ]);
  });

  it('fails when lines are removed from the end, naming the missing records and the missing seal', async () => {
    const { store } = await bundle();
    const lines = store.textOf('ledger.jsonl').split('\n');
    store.setText('ledger.jsonl', `${lines.slice(0, 2).join('\n')}\n`);

    const result = await verifyIntact(store, sha256);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      {
        path: 'ledger.jsonl',
        record: 2,
        reason: 'the checkpoint covers 4 records and the ledger holds 2: records 2 to 3 are missing',
      },
      {
        path: 'ledger.jsonl',
        record: 2,
        reason: 'there is no run.seal: the run did not finish, and a run with no seal never passes',
      },
    ]);
  });

  it('fails a run that was killed before its seal, and reports a torn last line without calling it tampering', async () => {
    const { store } = await bundle({ seal: false, checkpointEvery: 2 });
    await store.append('ledger.jsonl', utf8('{"seq":3,"t":"fa'));

    const result = await verifyIntact(store, sha256);
    expect(result.ok).toBe(false);
    expect(result.sealed).toBe(false);
    expect(result.torn).toEqual({ record: 3, bytes: 16 });
    expect(result.checkpoint?.size).toBe(2);
    expect(result.problems).toEqual([
      {
        path: 'ledger.jsonl',
        record: 3,
        reason: 'there is no run.seal: the run did not finish, and a run with no seal never passes',
      },
    ]);
  });

  it('never passes a bundle with no seal, whatever its length, and says what is missing', async () => {
    // SHA-256 of nothing, the root of the empty tree (RFC 9162 section 2.1.1).
    const EMPTY_CHECKPOINT = 'run-1\n0\n47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=\n';
    const noSeal = (record: number) => ({
      path: 'ledger.jsonl',
      record,
      reason: 'there is no run.seal: the run did not finish, and a run with no seal never passes',
    });
    const noOpen = {
      path: 'ledger.jsonl',
      record: 0,
      reason: 'the ledger holds no complete record: it does not start with run.open',
    };

    const empty = new MemoryStore();
    empty.setText('ledger.jsonl', '');
    empty.setText('checkpoint', EMPTY_CHECKPOINT);
    const emptyResult = await verifyIntact(empty, sha256);
    expect(emptyResult.ok).toBe(false);
    expect(emptyResult.problems).toEqual([noOpen, noSeal(0)]);

    const torn = new MemoryStore();
    torn.setText('ledger.jsonl', '{"seq":0,"t":"run.op');
    torn.setText('checkpoint', EMPTY_CHECKPOINT);
    const tornResult = await verifyIntact(torn, sha256);
    expect(tornResult.ok).toBe(false);
    expect(tornResult.torn).toEqual({ record: 0, bytes: 20 });
    expect(tornResult.problems).toEqual([noOpen, noSeal(0)]);

    const missing = new MemoryStore();
    missing.setText('checkpoint', EMPTY_CHECKPOINT);
    const missingResult = await verifyIntact(missing, sha256);
    expect(missingResult.ok).toBe(false);
    expect(missingResult.problems).toEqual([{ path: 'ledger.jsonl', reason: 'there is no ledger' }, noSeal(0)]);
  });

  it('checks a run killed right after run.open against the checkpoint written at open, and fails it', async () => {
    const store = new MemoryStore();
    await LedgerWriter.open(store, sha256, { origin: 'run-1', at: AT, body: { format: 1 } });
    // The run is killed here, before its first interval.

    const result = await verifyIntact(store, sha256);
    expect(result.ok).toBe(false);
    expect(result.sealed).toBe(false);
    expect(result.checkpoint?.size).toBe(1);
    expect(result.problems).toEqual([
      {
        path: 'ledger.jsonl',
        record: 1,
        reason: 'there is no run.seal: the run did not finish, and a run with no seal never passes',
      },
    ]);
  });

  it('refuses a line whose bytes are not the ones the writer writes for its record, naming the record', async () => {
    const NOT_WRITTEN = 'the line is not the bytes the writer writes for its record, so two readers could read it apart';
    const cases: [string, number, (line: string) => string, string][] = [
      ['a duplicate seq key', 1, (l) => l.replace('{"seq":1,', '{"seq":1,"seq":1,'), NOT_WRITTEN],
      ['a byte-order mark', 0, (l) => `﻿${l}`, NOT_WRITTEN],
      ['a CRLF ending', 1, (l) => `${l}\r`, NOT_WRITTEN],
      ['a trailing space', 1, (l) => `${l} `, NOT_WRITTEN],
      ['a \\u0041 escape for A', 1, (l) => l.replace('"A"', '"\\u0041"'), NOT_WRITTEN],
      ['a number the writer refuses', 1, (l) => l.replace('"n":1', '"n":1.5'), 'body.n is 1.5: a record holds only JSON, with integers'],
    ];
    for (const [name, record, edit, reason] of cases) {
      const store = new MemoryStore();
      const writer = await LedgerWriter.open(store, sha256, { origin: 'run-1', at: AT, body: { format: 1 } });
      await writer.append('fact', { name: 'A', n: 1 }, AT);
      await writer.seal({}, AT);
      const lines = store.textOf('ledger.jsonl').split('\n');
      const before = lines[record];
      lines[record] = edit(lines[record] as string);
      expect(lines[record], name).not.toBe(before);
      const ledger = lines.join('\n');
      store.setText('ledger.jsonl', ledger);
      store.setText('checkpoint', independentCheckpoint('run-1', ledger));

      expect((await verifyIntact(store, sha256)).problems, name).toEqual([{ path: 'ledger.jsonl', record, reason }]);
    }
  });

  it('fails a sealed ledger whose checkpoint covers fewer records than it holds', async () => {
    const store = new MemoryStore();
    const writer = await LedgerWriter.open(store, sha256, { origin: 'run-1', at: AT, body: {}, checkpointEvery: 2 });
    await writer.append('fact', { n: 1 }, AT);
    const atTwo = store.textOf('checkpoint'); // written after the second record, and true of the first two lines
    await writer.append('fact', { n: 2 }, AT);
    await writer.seal({}, AT);
    store.setText('checkpoint', atTwo);

    const result = await verifyIntact(store, sha256);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      { path: 'checkpoint', reason: 'the ledger is sealed at 4 records and the checkpoint covers 2' },
    ]);
  });

  it('fails when the checkpoint is missing or is not one it recognises', async () => {
    const missing = await bundle();
    missing.store.files.delete(`${missing.store.root}/checkpoint`);
    expect((await verifyIntact(missing.store, sha256)).problems).toEqual([
      { path: 'checkpoint', reason: 'there is no checkpoint, so no head fixes what the ledger held' },
    ]);

    const signed = await bundle();
    signed.store.setText('checkpoint', `${signed.store.textOf('checkpoint')}\n— someone abc=\n`);
    expect((await verifyIntact(signed.store, sha256)).problems).toEqual([
      {
        path: 'checkpoint',
        reason: 'the checkpoint is not three lines (origin, size, root), and signatures are not recognised',
      },
    ]);
  });

  it('fails when a record names a blob in a form it does not recognise', async () => {
    // The writer refuses these, so the lines are written by hand, with a checkpoint that matches them.
    const store = new MemoryStore();
    const ledger = [
      `{"seq":0,"t":"run.open","at":"${AT}","body":{}}`,
      `{"seq":1,"t":"fact","at":"${AT}","body":{"blobs":{"a":{"digest":"md5:00","size":1,"mediaType":"x"}}}}`,
      `{"seq":2,"t":"fact","at":"${AT}","body":{"blobs":{"b":"sha256:00"}}}`,
      `{"seq":3,"t":"run.seal","at":"${AT}","body":{}}`,
      '',
    ].join('\n');
    store.setText('ledger.jsonl', ledger);
    store.setText('checkpoint', independentCheckpoint('run-1', ledger));

    expect((await verifyIntact(store, sha256)).problems).toEqual([
      { path: 'ledger.jsonl', record: 1, reason: 'the blob "a" has a digest that is not recognised: "md5:00"' },
      { path: 'ledger.jsonl', record: 2, reason: 'the blob "b" is named in a form that is not recognised' },
    ]);
  });

  it('verifies the same bytes under another root, and no record holds an absolute path', async () => {
    const { store } = await bundle();
    const copy = store.copyTo('elsewhere/b');

    for (const s of [store, copy]) {
      const result = await verifyIntact(s, sha256);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    }
    const ledger = store.textOf('ledger.jsonl');
    expect(ledger).toBe(
      [
        '{"seq":0,"t":"run.open","at":"2026-11-17T10:00:00Z","body":{"format":1}}',
        '{"seq":1,"t":"fact","at":"2026-11-17T10:00:00Z","body":{"kind":"dep.package","body":{"name":"left-pad"},"blobs":{"lockfile":{"digest":"sha256:454eea274ef715bed0aef364fec823e04318850d28eb04f1c16a03a5127c071c","size":15,"mediaType":"application/json"}}}}',
        '{"seq":2,"t":"verdict","at":"2026-11-17T10:00:00Z","body":{"claim":"deps@1","verdict":"pass"}}',
        '{"seq":3,"t":"run.seal","at":"2026-11-17T10:00:00Z","body":{"result":"pass"}}',
        '',
      ].join('\n'),
    );
    // The root was computed once, outside this repository, by a short Python script using only hashlib and written
    // straight from RFC 9162 section 2.1.1: a leaf is SHA-256(0x00 ‖ line) over each line above without its newline,
    // a node is SHA-256(0x01 ‖ left ‖ right), split at the largest power of two below the count. The blob digest is
    // SHA-256 of the 15 bytes {"packages":[]}, from the same script. None of this repository's code was used.
    expect((await verifyIntact(copy, sha256)).checkpoint).toEqual({
      origin: 'run-1',
      size: 4,
      root: '9YJF2iDT+xLSooiKK4rzb6bUGqdqHBvRllpNfmgBkAA=',
    });

    expect(ledger).not.toContain(store.root);
    for (const line of ledger.trimEnd().split('\n')) {
      expect(line).not.toMatch(/"(\/|[A-Za-z]:[\\/])/); // no string value starts as an absolute path does
    }
  });
});

describe('the checkpoint text (ALGORITHMS K3)', () => {
  // Three lines: the origin, the number of lines, the root in base64. The root here is SHA-256 of nothing, the root
  // of the empty tree, whose value is published widely; its 32 bytes are written out below.
  const TEXT = 'run-1\n0\n47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=\n';
  const ROOT = Uint8Array.from(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'.match(/../g) as string[],
    (h) => Number.parseInt(h, 16),
  );

  it('is written as three lines', () => {
    expect(formatCheckpoint({ origin: 'run-1', size: 0, root: ROOT })).toBe(TEXT);
  });

  it('is read from those three lines', () => {
    expect(parseCheckpoint(TEXT)).toEqual({ origin: 'run-1', size: 0, root: ROOT });
  });
});

describe('does the result follow? (verifyResult)', () => {
  /** A run of the given verdicts, sealed with the given result, or not sealed. */
  async function run(verdicts: (string | null)[], result?: unknown) {
    const store = new MemoryStore('runs/b');
    const writer = await LedgerWriter.open(store, sha256, { origin: 'run-2', at: AT, body: { format: 1 } });
    for (const [i, verdict] of verdicts.entries()) {
      await writer.append('verdict', verdict === null ? { claim: `c${i + 1}@1` } : { claim: `c${i + 1}@1`, verdict }, AT);
    }
    if (result !== undefined) await writer.seal({ result } as never, AT);
    return store;
  }

  it('gives what it recomputed, what the seal holds, and that they agree', async () => {
    const store = await run(['pass', 'pass'], { verdict: 'pass', verdicts: 2 });
    expect(await verifyResult(store)).toEqual({
      seal: { seq: 3, verdict: 'pass', verdicts: 2 },
      recomputed: { verdict: 'pass', verdicts: 2 },
      records: [
        { seq: 1, claim: 'c1@1', verdict: 'pass' },
        { seq: 2, claim: 'c2@1', verdict: 'pass' },
      ],
      agree: true,
    });
  });

  it('does not agree when the seal says another conclusion, or another count', async () => {
    expect(await verifyResult(await run(['pass', 'fail'], { verdict: 'pass', verdicts: 2 }))).toMatchObject({
      recomputed: { verdict: 'fail', verdicts: 2 },
      agree: false,
    });
    expect(await verifyResult(await run(['pass'], { verdict: 'pass', verdicts: 2 }))).toMatchObject({
      seal: { seq: 2, verdict: 'pass', verdicts: 2 },
      recomputed: { verdict: 'pass', verdicts: 1 },
      agree: false,
    });
  });

  it('gives null for what the seal or a verdict record does not state, which never agrees', async () => {
    expect(await verifyResult(await run([null], {}))).toEqual({
      seal: { seq: 2, verdict: null, verdicts: null },
      recomputed: { verdict: 'not_known', verdicts: 1 },
      records: [{ seq: 1, claim: 'c1@1', verdict: null }],
      agree: false,
    });
  });

  it('gives no seal for a run that was not sealed', async () => {
    expect(await verifyResult(await run(['pass']))).toEqual({ seal: null });
  });
});
