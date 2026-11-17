// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BlobStore } from '../../src/kernel/blobs.js';
import { MemoryStore, sha256, text, utf8 } from '../kernel-helpers.js';

const HELLO_HEX = createHash('sha256').update('hello').digest('hex');

describe('the blob store', () => {
  it('stores a blob under its SHA-256 and gives it back by digest', async () => {
    const store = new MemoryStore();
    const blobs = new BlobStore(store, sha256);

    const ref = await blobs.put(utf8('hello'), 'text/plain');
    expect(ref).toEqual({ digest: `sha256:${HELLO_HEX}`, size: 5, mediaType: 'text/plain' });
    expect(await store.read(`blobs/sha256/${HELLO_HEX.slice(0, 2)}/${HELLO_HEX.slice(2)}`)).toBeDefined();
    expect(text(await blobs.get(ref.digest))).toBe('hello');
  });

  it('refuses a blob whose bytes do not match its name', async () => {
    const store = new MemoryStore();
    const blobs = new BlobStore(store, sha256);
    const ref = await blobs.put(utf8('hello'), 'text/plain');
    store.setText(`blobs/sha256/${HELLO_HEX.slice(0, 2)}/${HELLO_HEX.slice(2)}`, 'hullo');

    await expect(blobs.get(ref.digest)).rejects.toThrow(/does not match its digest/);
  });

  it('refuses a missing blob and a digest it does not recognise', async () => {
    const blobs = new BlobStore(new MemoryStore(), sha256);
    await expect(blobs.get(`sha256:${HELLO_HEX}`)).rejects.toThrow(/no blob/);
    await expect(blobs.get('md5:abc')).rejects.toThrow(/not a sha256 digest/);
    await expect(blobs.get(`sha256:${HELLO_HEX.toUpperCase()}`)).rejects.toThrow(/not a sha256 digest/);
  });

  it('keeps one copy when the same bytes are put twice, and refuses to overwrite a changed one', async () => {
    const store = new MemoryStore();
    const blobs = new BlobStore(store, sha256);
    await blobs.put(utf8('hello'), 'text/plain');
    expect((await blobs.put(utf8('hello'), 'text/plain')).digest).toBe(`sha256:${HELLO_HEX}`);

    store.setText(`blobs/sha256/${HELLO_HEX.slice(0, 2)}/${HELLO_HEX.slice(2)}`, 'hullo');
    await expect(blobs.put(utf8('hello'), 'text/plain')).rejects.toThrow(/does not match its digest/);
  });
});
