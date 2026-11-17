// SPDX-License-Identifier: AGPL-3.0-only
// The file-system store behind a proof bundle (docs/FOUNDATION.md §5, §14): the kernel's Store over one folder, and
// SHA-256 from node:crypto. Real temporary folders, no mocks of the kernel.
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsStore, StorePathError, nodeSha256 } from '../../src/entry/fs-store.js';
import { toHex } from '../../src/kernel/store.js';
import { text, utf8 } from '../kernel-helpers.js';

let tmp: string;
let root: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-fsstore-'));
  root = path.join(tmp, 'bundle');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('FsStore: read, write and append', () => {
  it('reads back what was written, creating the folders on the way', async () => {
    const store = new FsStore(root);
    await store.write('blobs/sha256/ab/cdef', utf8('hello'));
    expect(text(await store.read('blobs/sha256/ab/cdef'))).toBe('hello');
    expect(await readFile(path.join(root, 'blobs', 'sha256', 'ab', 'cdef'), 'utf8')).toBe('hello');
  });

  it('answers undefined for a file that is not there, and for a folder in its place', async () => {
    const store = new FsStore(root);
    expect(await store.read('ledger.jsonl')).toBeUndefined();
    await store.write('blobs/x', utf8('1'));
    expect(await store.read('blobs')).toBeUndefined();
    expect(await store.read('blobs/x/y')).toBeUndefined();
  });

  it('append creates the file and then adds to its end', async () => {
    const store = new FsStore(root);
    await store.append('ledger.jsonl', utf8('one\n'));
    await store.append('ledger.jsonl', utf8('two\n'));
    expect(text(await store.read('ledger.jsonl'))).toBe('one\ntwo\n');
  });

  it('write replaces the file whole', async () => {
    const store = new FsStore(root);
    await store.write('checkpoint', utf8('a long first content\n'));
    await store.write('checkpoint', utf8('short\n'));
    expect(text(await store.read('checkpoint'))).toBe('short\n');
  });

  it('keeps bytes that are not text exactly', async () => {
    const store = new FsStore(root);
    const bytes = Uint8Array.from([0, 255, 10, 13, 128, 0]);
    await store.write('blobs/bin', bytes);
    expect(Array.from((await store.read('blobs/bin')) as Uint8Array)).toEqual(Array.from(bytes));
  });
});

describe('FsStore: paths that would leave the folder', () => {
  const refused = [
    '../outside',
    'a/../../outside',
    'a/..',
    '..',
    '/etc/passwd',
    'C:/Windows/x',
    'c:x',
    'a\\b',
    '\\\\server\\share\\x',
    'a//b',
    'a/./b',
    './a',
    '',
    'a/',
    'blobs/x:stream',
    'a\u0000b',
  ];
  for (const bad of refused) {
    it(`refuses ${JSON.stringify(bad)} for read, write and append, and writes nothing`, async () => {
      const store = new FsStore(root);
      await expect(store.read(bad)).rejects.toBeInstanceOf(StorePathError);
      await expect(store.write(bad, utf8('x'))).rejects.toBeInstanceOf(StorePathError);
      await expect(store.append(bad, utf8('x'))).rejects.toBeInstanceOf(StorePathError);
      expect(await readdir(tmp)).toEqual([]);
    });
  }

  it('refuses a folder inside the bundle that is a link to somewhere outside it', async () => {
    const outside = path.join(tmp, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret'), 'secret');
    await mkdir(root);
    await symlink(outside, path.join(root, 'blobs'), 'junction');
    const store = new FsStore(root);
    await expect(store.read('blobs/secret')).rejects.toBeInstanceOf(StorePathError);
    await expect(store.write('blobs/new', utf8('x'))).rejects.toBeInstanceOf(StorePathError);
    expect(await readdir(outside)).toEqual(['secret']);
  });
});

describe('FsStore: the rewrite of a file is never half done', () => {
  it('leaves no temporary file beside it after a write', async () => {
    const store = new FsStore(root);
    await store.write('checkpoint', utf8('first\n'));
    await store.write('checkpoint', utf8('second\n'));
    expect(await readdir(root)).toEqual(['checkpoint']);
  });

  it('a crash after the new bytes are beside the file and before the rename leaves the old content', async () => {
    const crash = new Error('the process died');
    const store = new FsStore(root, {
      rename: async () => {
        throw crash;
      },
    });
    await new FsStore(root).write('checkpoint', utf8('old\n'));
    await expect(store.write('checkpoint', utf8('new\n'))).rejects.toBe(crash);
    expect(await readFile(path.join(root, 'checkpoint'), 'utf8')).toBe('old\n');
  });

  it('a crash before the first rename leaves no checkpoint rather than half of one', async () => {
    const store = new FsStore(root, {
      rename: async () => {
        throw new Error('the process died');
      },
    });
    await expect(store.write('checkpoint', utf8('new\n'))).rejects.toThrow('the process died');
    expect(await new FsStore(root).read('checkpoint')).toBeUndefined();
  });
});

describe('nodeSha256', () => {
  it('is SHA-256: 32 bytes, matching the published digests of "" and "abc"', async () => {
    expect(toHex(await nodeSha256(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    const abc = await nodeSha256(utf8('abc'));
    expect(abc).toBeInstanceOf(Uint8Array);
    expect(toHex(abc)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
