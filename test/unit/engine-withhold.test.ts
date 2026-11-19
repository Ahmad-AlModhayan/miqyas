// SPDX-License-Identifier: AGPL-3.0-only
// A value that must not be kept (docs/FOUNDATION.md §3, "Safe to keep"; docs/ALGORITHMS.md L2): it is recorded as its
// shape, its count and a keyed digest, HMAC-SHA-256 under a key made for the run and thrown away at its end. Equal
// values give equal digests within a run, and nothing of the value is in the run folder. The seams are withholding
// itself, and one run folder searched end to end, scrubber included.
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRecorder } from '../../src/engine/recorder.js';
import { withhold } from '../../src/engine/withhold.js';
import { runKey } from '../../src/entry/fs-store.js';
import { runWithProofBundle } from '../../src/entry/proof-bundle.js';
import { MemoryStore, collectionFact, sha256 } from '../kernel-helpers.js';

const KEY = new Uint8Array(32).fill(7);
const hmac = async (bytes: Uint8Array) => new Uint8Array(createHmac('sha256', KEY).update(bytes).digest());
const bytes = (s: string) => new TextEncoder().encode(s);

describe('withholding a value', () => {
  it('records its shape, its count and its keyed digest, and nothing of the value', async () => {
    const row = { name: 'Row Owner', id: 41, paid: true };
    const kept = await withhold(row, 'row', hmac);
    expect(kept).toEqual({ why: 'row', shape: '{id:integer,name:string,paid:boolean}', count: 3, digest: expect.stringMatching(/^hmac-sha256:[0-9a-f]{64}$/) });
    expect(JSON.stringify(kept)).not.toContain('Row Owner');
  });

  it('digests the value written the one way: its fields in name order', async () => {
    const digest = (await withhold({ b: 1, a: 'x' }, 'row', hmac)).digest;
    expect(digest).toBe(`hmac-sha256:${createHmac('sha256', KEY).update('{"a":"x","b":1}').digest('hex')}`);
    expect((await withhold({ a: 'x', b: 1 }, 'row', hmac)).digest).toBe(digest);
  });

  it('gives equal values equal digests within a run, and other values other digests', async () => {
    expect((await withhold('owned-id-17', 'owned-id', hmac)).digest).toBe((await withhold('owned-id-17', 'owned-id', hmac)).digest);
    expect((await withhold('owned-id-17', 'owned-id', hmac)).digest).not.toBe((await withhold('owned-id-18', 'owned-id', hmac)).digest);
  });

  it('gives the same value another digest in another run, whose key is another', async () => {
    const one = runKey();
    const two = runKey();
    expect((await withhold('same', 'secret', one.hmac)).digest).not.toBe((await withhold('same', 'secret', two.hmac)).digest);
    expect((await withhold('same', 'secret', one.hmac)).digest).toBe((await withhold('same', 'secret', one.hmac)).digest);
    one.discard();
    await expect(one.hmac(bytes('after'))).rejects.toThrow(/discarded/);
  });

  it('counts what a value holds: characters, items, fields; and names the shape of a list by its items', async () => {
    expect(await withhold('سلام', 'secret', hmac)).toMatchObject({ shape: 'string', count: 4 });
    expect(await withhold([1, 'a', 2], 'row', hmac)).toMatchObject({ shape: '[integer|string]', count: 3 });
    expect(await withhold([], 'row', hmac)).toMatchObject({ shape: '[]', count: 0 });
    expect(await withhold(null, 'row', hmac)).toMatchObject({ shape: 'null', count: 1 });
  });

  it('withholds a body by its bytes: JSON by the value it holds, other bytes as bytes, and says its size', async () => {
    const json = await withhold(bytes('{"b": [1, 2], "a": "x"}'), 'body', hmac);
    expect(json).toMatchObject({ shape: '{a:string,b:[integer]}', count: 2, size: 23 });
    expect(json.digest).toBe((await withhold({ a: 'x', b: [1, 2] }, 'body', hmac)).digest);
    expect(await withhold(bytes('not json'), 'body', hmac)).toMatchObject({ shape: 'bytes', count: 8, size: 8 });
  });

  it('is offered to collectors by the recorder, under the key it was handed, and refused without one', async () => {
    const withKey = await openRecorder(new MemoryStore(), sha256, { origin: 'r', open: {}, now: () => new Date(0), keyedHash: hmac });
    expect((await withKey.withhold('v', 'secret')).digest).toBe((await withhold('v', 'secret', hmac)).digest);
    const without = await openRecorder(new MemoryStore(), sha256, { origin: 'r', open: {}, now: () => new Date(0) });
    await expect(without.withhold('v', 'secret')).rejects.toThrow(/key/);
  });
});

describe('one run folder, searched end to end', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-withhold-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function everyFile(root: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const p = path.join(root, entry.name);
      if (entry.isDirectory()) out.push(...(await everyFile(p)));
      else out.push(p);
    }
    return out;
  }

  it('holds neither the seeded term nor the row-value sentinel, in any ledger line or blob', async () => {
    const TERM = 'Fictional-Org-Zeta';
    const SENTINEL = 'ROW-VALUE-SENTINEL-7f3a';
    const dir = path.join(tmp, '.miqyas', 'runs', 'r1');
    const scrub = { terms: [{ from: TERM, to: 'ORG' }] };
    const open = { format: 1, inputs: { url: `https://app.test/${TERM}/home` } };
    await runWithProofBundle({ dir, runId: 'r1', open, scrub, print: () => undefined }, async (recorder) => {
      const response = await recorder.withhold(bytes(JSON.stringify([{ owner: SENTINEL, org: TERM }])), 'body');
      await recorder.record('fact', {
        kind: 'http.exchange',
        v: 1,
        by: 'test-worker@1',
        run: 1,
        subject: 'target',
        cause: 'page',
        body: { method: 'GET', url: `https://app.test/${TERM}/rows`, route: null, status: 200, headers: { 'x-org': TERM }, as: null, response },
        withheld: ['response'],
      });
      const snapshot = await recorder.putBlob(bytes(`<p>${TERM}</p>`), 'text/html');
      await recorder.record('fact', { kind: 'asset', v: 1, by: 'test-worker@1', run: 1, subject: 'target', body: { from: 'served', name: 'page' }, blobs: { content: snapshot } });
      await recorder.record('fact', collectionFact({ by: 'test-worker@1', subject: 'target', setOut: `the pages of ${TERM}`, counts: { exchanges: 1 } }));
      return { result: undefined, fold: { note: TERM } };
    });
    const files = await everyFile(dir);
    expect(files.some((f) => f.endsWith('ledger.jsonl'))).toBe(true);
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toMatch(new RegExp(TERM, 'i'));
      expect(text, file).not.toContain(SENTINEL);
    }
  });
});
