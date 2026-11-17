// SPDX-License-Identifier: AGPL-3.0-only
// A run with --proof-bundle (docs/FOUNDATION.md §5): the folder it writes, what its first and last records hold, and
// the head it prints. Real temporary folders; the kernel is not mocked.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsStore, nodeSha256 } from '../../src/entry/fs-store.js';
import { buildRunOpen, runWithProofBundle } from '../../src/entry/proof-bundle.js';
import { verifyIntact } from '../../src/kernel/verify.js';
import { independentCheckpoint, utf8 } from '../kernel-helpers.js';

let tmp: string;
let dir: string;
const RUN = '20261117-101500-ab12';
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-bundle-'));
  dir = path.join(tmp, '.miqyas', 'runs', RUN);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 17, 10, 15, tick++));
const lines = (ledger: string) => ledger.split('\n').filter((l) => l !== '');
const OPEN = { format: 1, note: 'what the run knew' };

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(root, rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe('a run with a proof bundle', () => {
  it('writes the layout of §5, opens with run.open, ends with run.seal, and prints the head the checkpoint holds', async () => {
    tick = 0;
    const printed: string[] = [];
    const code = await runWithProofBundle(
      { dir, runId: RUN, open: OPEN, now: clock, print: (line) => printed.push(line) },
      async (recorder) => {
        const blob = await recorder.putBlob(utf8('<html>evidence</html>'), 'text/html');
        await recorder.record('fact', { kind: 'page', blobs: { body: blob } });
        await recorder.record('verdict', { claim: 'c1', result: 'pass' });
        return { result: 7, fold: { verdict: 'pass' } };
      },
    );
    expect(code).toBe(7);

    const files = await listFiles(dir);
    expect(files).toHaveLength(3);
    expect(files[0]).toMatch(/^blobs\/sha256\/[0-9a-f]{2}\/[0-9a-f]{62}$/);
    expect(files.slice(1)).toEqual(['checkpoint', 'ledger.jsonl']);

    const ledger = await readFile(path.join(dir, 'ledger.jsonl'), 'utf8');
    const records = lines(ledger).map((l) => JSON.parse(l) as { seq: number; t: string; at: string; body: Record<string, unknown> });
    expect(records.map((r) => [r.seq, r.t])).toEqual([
      [0, 'run.open'],
      [1, 'fact'],
      [2, 'verdict'],
      [3, 'run.seal'],
    ]);
    expect(records[0]!.body).toEqual(OPEN);
    expect(records[0]!.at).toBe('2026-11-17T10:15:00.000Z');
    expect(records[3]!.body).toEqual({
      format: 1,
      counts: { records: 4, byType: { fact: 1, 'run.open': 1, 'run.seal': 1, verdict: 1 } },
      result: { verdict: 'pass' },
    });

    // The checkpoint is the one an independent computation gives, named for the run, and what was printed is its head.
    const checkpoint = await readFile(path.join(dir, 'checkpoint'), 'utf8');
    expect(checkpoint).toBe(independentCheckpoint(RUN, ledger));
    const [origin, size, root] = checkpoint.split('\n') as [string, string, string];
    expect(origin).toBe(RUN);
    expect(printed).toEqual([`proof bundle head: ${size} records, root ${root}`]);
    expect(size).toBe('4');

    expect((await verifyIntact(new FsStore(dir), nodeSha256)).ok).toBe(true);
  });

  it('writes records as the run goes, not at the end', async () => {
    tick = 0;
    let seenMidRun = '';
    await runWithProofBundle({ dir, runId: RUN, open: OPEN, now: clock, print: () => undefined }, async (recorder) => {
      await recorder.record('fact', { kind: 'page' });
      seenMidRun = await readFile(path.join(dir, 'ledger.jsonl'), 'utf8');
      return { result: 0, fold: null };
    });
    expect(lines(seenMidRun).map((l) => JSON.parse(l).t)).toEqual(['run.open', 'fact']);
  });

  it('holds no absolute path and not the folder the run was made in, so a copy elsewhere still verifies', async () => {
    tick = 0;
    await runWithProofBundle({ dir, runId: RUN, open: OPEN, now: clock, print: () => undefined }, async (recorder) => {
      await recorder.record('fact', { kind: 'page' });
      return { result: 0, fold: null };
    });
    const text = (await readFile(path.join(dir, 'ledger.jsonl'), 'utf8')) + (await readFile(path.join(dir, 'checkpoint'), 'utf8'));
    expect(text).not.toContain(tmp);
    expect(text).not.toContain(path.basename(tmp));
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(text).not.toMatch(/\\\\/);
  });

  it('leaves a ledger with no seal when the run throws, and prints no head', async () => {
    tick = 0;
    const printed: string[] = [];
    await expect(
      runWithProofBundle({ dir, runId: RUN, open: OPEN, now: clock, print: (l) => printed.push(l) }, async (recorder) => {
        await recorder.record('fact', { kind: 'page' });
        throw new Error('the run broke');
      }),
    ).rejects.toThrow('the run broke');
    const types = lines(await readFile(path.join(dir, 'ledger.jsonl'), 'utf8')).map((l) => JSON.parse(l).t);
    expect(types).toEqual(['run.open', 'fact']);
    expect(printed).toEqual([]);
  });

  it('refuses a folder that already holds a ledger', async () => {
    tick = 0;
    const run = () =>
      runWithProofBundle({ dir, runId: RUN, open: OPEN, now: clock, print: () => undefined }, async () => ({ result: 0, fold: null }));
    await run();
    await expect(run()).rejects.toThrow(/already exists/);
  });

  it('the recorder the run is handed can append, store and read a blob, and cannot seal', async () => {
    tick = 0;
    await runWithProofBundle({ dir, runId: RUN, open: OPEN, now: clock, print: () => undefined }, async (recorder) => {
      expect(Object.keys(recorder).sort()).toEqual(['getBlob', 'head', 'putBlob', 'record']);
      const ref = await recorder.putBlob(utf8('abc'), 'text/plain');
      expect(ref).toEqual({
        digest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        size: 3,
        mediaType: 'text/plain',
      });
      expect(new TextDecoder().decode(await recorder.getBlob(ref.digest))).toBe('abc');
      await expect(recorder.record('run.seal' as 'fact', {})).rejects.toThrow();
      expect((await recorder.head()).size).toBe(1);
      return { result: 0, fold: null };
    });
  });
});

describe('a run that is cut short', () => {
  it('has no seal: verify says so, and a half-written last line is torn, not tampering', async () => {
    tick = 0;
    await expect(
      runWithProofBundle({ dir, runId: RUN, open: OPEN, now: clock, print: () => undefined }, async (recorder) => {
        await recorder.record('fact', { kind: 'page' });
        throw new Error('the process died');
      }),
    ).rejects.toThrow();
    const store = new FsStore(dir);

    const cut = await verifyIntact(store, nodeSha256);
    expect(cut.ok).toBe(false);
    expect(cut.sealed).toBe(false);
    expect(cut.torn).toBeNull();
    expect(cut.problems.map((p) => p.reason)).toEqual([expect.stringMatching(/no run\.seal/)]);

    // Now the process died in the middle of writing the next line.
    const ledger = await readFile(path.join(dir, 'ledger.jsonl'), 'utf8');
    await writeFile(path.join(dir, 'ledger.jsonl'), ledger + '{"seq":2,"t":"fa');
    const torn = await verifyIntact(store, nodeSha256);
    expect(torn.ok).toBe(false);
    expect(torn.torn).toEqual({ record: 2, bytes: 16 });
    expect(torn.records).toBe(2);
    expect(torn.problems.map((p) => p.reason)).toEqual([expect.stringMatching(/no run\.seal/)]);
    expect(torn.problems.some((p) => /match the checkpoint|changed/.test(p.reason))).toBe(false);
  });
});

describe('buildRunOpen: what run.open carries as far as the run knows it', () => {
  const input = {
    url: 'https://user:pw@shop.example.test:8443/app/?token=abc#top',
    plans: [{ id: 'checkout' }, { id: 'login' }],
    settings: {
      concurrency: 3,
      allowOtherOrigins: false,
      headed: false,
      crawl: true,
      maxScreens: 50,
      maxDepth: 3,
      maxRps: 2,
      maxTimeMs: 600000,
      active: true,
      allowWrites: false,
      allowHost: 'shop.example.test',
      hostToken: 'secret-token-value',
    },
    quote: {
      model: 'a-model',
      noModel: false,
      dailyCapUsd: 20,
      likelyUsd: 0.0123,
      worstCaseUsd: 0.5,
    },
  };

  it('names the format, the versions, no subject, the inputs, the grants, the origins, the budgets and the quote', async () => {
    const body = (await buildRunOpen(input)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['budgets', 'format', 'grants', 'inputs', 'origins', 'quote', 'subjects', 'versions']);
    expect(body.format).toBe(1);
    expect(body.subjects).toEqual([]);
    expect(body.origins).toEqual({});
    const versions = body.versions as Record<string, unknown>;
    expect(versions.engine).toBe('0.1.0');
    expect(versions.node).toBe(process.version);
    expect(versions.cel).toEqual({ name: '@bufbuild/cel', version: '0.6.2' });
    expect(body.inputs).toEqual({
      url: 'https://shop.example.test:8443/app/',
      plans: ['checkout', 'login'],
      crawl: true,
    });
    expect(body.grants).toEqual({ active: true, allowWrites: false, allowHost: 'shop.example.test', allowOtherOrigins: false });
    expect(body.budgets).toEqual({ concurrency: 3, maxScreens: 50, maxDepth: 3, maxRpsMilli: 2000, maxTimeMs: 600000 });
    expect(body.quote).toEqual({
      model: 'a-model',
      noModel: false,
      dailyCapMicroUsd: 20_000_000,
      likelyMicroUsd: 12300,
      worstCaseMicroUsd: 500000,
    });
  });

  it('keeps the host token, the query and the credentials out, and is a record the ledger accepts', async () => {
    const body = await buildRunOpen(input);
    const json = JSON.stringify(body);
    expect(json).not.toContain('secret-token-value');
    expect(json).not.toContain('token=abc');
    expect(json).not.toContain('user:pw');
    const dir2 = path.join(tmp, 'b');
    tick = 0;
    await runWithProofBundle({ dir: dir2, runId: RUN, open: body, now: clock, print: () => undefined }, async () => ({
      result: 0,
      fold: null,
    }));
    expect((await verifyIntact(new FsStore(dir2), nodeSha256)).ok).toBe(true);
  });

  it('says there is no quote for a run that has none', async () => {
    const body = (await buildRunOpen({ ...input, quote: undefined })) as Record<string, unknown>;
    expect(body.quote).toBeNull();
  });
});
