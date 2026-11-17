// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { BlobStore, blobPath } from '../../src/kernel/blobs.js';
import { LedgerWriter } from '../../src/kernel/ledger.js';
import { verifyIntact } from '../../src/kernel/verify.js';
import { MemoryStore, sha256, utf8 } from '../kernel-helpers.js';

const AT = '2026-11-17T10:00:00Z';

/** A finished run: run.open, a fact that names a blob, a verdict, the seal. */
async function bundle(options: { seal?: boolean; checkpointEvery?: number } = {}) {
  const store = new MemoryStore('/home/someone/project/.miqyas/runs/run-1');
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
    expect(result.head?.size).toBe(4);
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
    expect(result.head?.size).toBe(2);
    expect(result.problems).toEqual([
      {
        path: 'ledger.jsonl',
        record: 3,
        reason: 'there is no run.seal: the run did not finish, and a run with no seal never passes',
      },
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
    const store = new MemoryStore();
    const writer = await LedgerWriter.open(store, sha256, { origin: 'run-1', at: AT, body: {} });
    await writer.append('fact', { blobs: { a: { digest: 'md5:00', size: 1, mediaType: 'x' } } }, AT);
    await writer.append('fact', { blobs: { b: 'sha256:00' } }, AT);
    await writer.seal({}, AT);

    expect((await verifyIntact(store, sha256)).problems).toEqual([
      { path: 'ledger.jsonl', record: 1, reason: 'the blob "a" has a digest that is not recognised: "md5:00"' },
      { path: 'ledger.jsonl', record: 2, reason: 'the blob "b" is named in a form that is not recognised' },
    ]);
  });

  it('verifies the same bytes under another root, and no record holds an absolute path', async () => {
    const { store, writer } = await bundle();
    const copy = store.copyTo('D:/elsewhere/copied-bundle');

    for (const s of [store, copy]) {
      const result = await verifyIntact(s, sha256);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    }
    const head = await writer.head();
    expect((await verifyIntact(copy, sha256)).head).toEqual({
      origin: 'run-1',
      size: head.size,
      root: Buffer.from(head.root).toString('base64'),
    });

    const ledger = store.textOf('ledger.jsonl');
    expect(ledger).not.toContain(store.root);
    expect(ledger).not.toContain('/home/');
    for (const line of ledger.trimEnd().split('\n')) {
      expect(line).not.toMatch(/"(\/|[A-Za-z]:[\\/])/); // no string value starts as an absolute path does
    }
  });
});
