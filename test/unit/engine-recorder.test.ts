// SPDX-License-Identifier: AGPL-3.0-only
// The recorder enforces the fact kinds and closes collector runs (docs/FOUNDATION.md §3): a fact that fails its schema
// never reaches the ledger, no fact of a run is accepted after the run's `collection` fact, and a run that ends with a
// collector run still open has the engine close it as failed. Over a store in memory; the kernel is real.
import { describe, expect, it } from 'vitest';
import { FactRefused } from '../../src/engine/fact-check.js';
import { openRecorder } from '../../src/engine/recorder.js';
import { readLedger } from '../../src/kernel/ledger.js';
import { MemoryStore, collectionFact, sha256 } from '../kernel-helpers.js';

async function recorderOverMemory() {
  const store = new MemoryStore();
  const recorder = await openRecorder(store, sha256, { origin: 'test-run', open: { format: 1 }, now: () => new Date(Date.UTC(2026, 10, 18)) });
  const ledger = async () => (await readLedger(store)).records.map((r) => ({ seq: r.seq, t: r.t, body: r.body as Record<string, unknown> }));
  return { store, recorder, ledger };
}

const file = (path: string, by = 'lockfile-reader@1', run = 1) => ({ kind: 'repo.file', v: 1, by, run, subject: 'repository', body: { path, role: 'lockfile' } });
const closing = (by = 'lockfile-reader@1', run = 1, status: 'complete' | 'failed' = 'complete') =>
  collectionFact({ by, run, subject: 'repository', setOut: 'every supported lockfile in the repository', counts: { lockfiles: 1 }, status });

describe('the recorder checks each fact against its kind', () => {
  it('refuses a fact that fails its schema, naming the kind and the field, and nothing of it reaches the ledger', async () => {
    const { store, recorder, ledger } = await recorderOverMemory();
    const bad = { ...file('package-lock.json'), body: { path: '/abs/package-lock.json', role: 'lockfile' } };
    const refusal = await recorder.record('fact', bad).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(FactRefused);
    expect(refusal).toMatchObject({ kind: 'repo.file', field: 'body.path' });
    expect((refusal as Error).message).toMatch(/"repo\.file".*body\.path/);
    expect(store.textOf('ledger.jsonl')).not.toContain('/abs/');
    // The refusal took no position: the next fact is the next record.
    expect(await recorder.record('fact', file('package-lock.json'))).toBe(1);
    expect((await ledger()).map((r) => r.t)).toEqual(['run.open', 'fact']);
  });

  it('refuses minus zero as a fact that fails its schema, naming the kind and the field, before the writer sees it', async () => {
    const { recorder, ledger } = await recorderOverMemory();
    const minusZero = { ...closing(), body: { ...closing().body, dropped: -0 } };
    const refusal = await recorder.record('fact', minusZero).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(FactRefused);
    expect(refusal).toMatchObject({ kind: 'collection', field: 'body.dropped' });
    expect((await ledger()).map((r) => r.t)).toEqual(['run.open']);
  });

  it('refuses a fact of a kind with no schema', async () => {
    const { recorder } = await recorderOverMemory();
    await expect(recorder.record('fact', { kind: 'page', v: 1, by: 'x@1', run: 1, subject: 's', body: {} })).rejects.toMatchObject({ kind: 'page', field: 'kind' });
  });

  it('counts no refused fact in the seal', async () => {
    const { recorder } = await recorderOverMemory();
    await recorder.record('fact', file('package-lock.json'));
    await recorder.record('fact', { ...file('x'), run: 1.5 }).catch(() => undefined);
    await recorder.record('fact', closing());
    const sealed = await recorder.seal(null);
    expect(sealed.head.size).toBe(4);
  });

  it('does not check records that are not facts', async () => {
    const { recorder } = await recorderOverMemory();
    expect(await recorder.record('verdict', { claim: 'c1@1', verdict: 'pass' })).toBe(1);
  });
});

describe('a collector run closes', () => {
  it('accepts no further fact of a run after its collection fact, not even a second collection', async () => {
    const { store, recorder, ledger } = await recorderOverMemory();
    await recorder.record('fact', file('package-lock.json'));
    await recorder.record('fact', closing());
    await expect(recorder.record('fact', file('yarn.lock'))).rejects.toThrow(/lockfile-reader@1.*run 1.*closed/);
    await expect(recorder.record('fact', closing('lockfile-reader@1', 1, 'failed'))).rejects.toThrow(/closed/);
    expect(store.textOf('ledger.jsonl')).not.toContain('yarn.lock');
    expect((await ledger()).map((r) => r.t)).toEqual(['run.open', 'fact', 'fact']);
  });

  it('refuses a late fact even when the collection fact has not been written yet', async () => {
    const { recorder } = await recorderOverMemory();
    const closed = recorder.record('fact', closing());
    await expect(recorder.record('fact', file('yarn.lock'))).rejects.toThrow(/closed/);
    expect(await closed).toBe(1);
  });

  it('keeps other runs open: another attempt of the same collector, and another collector', async () => {
    const { recorder, ledger } = await recorderOverMemory();
    await recorder.record('fact', closing());
    await recorder.record('fact', file('package-lock.json', 'lockfile-reader@1', 2));
    await recorder.record('fact', file('package-lock.json', 'repository-reader@1', 1));
    await recorder.record('fact', closing('lockfile-reader@1', 2));
    await recorder.record('fact', closing('repository-reader@1', 1));
    expect((await ledger()).filter((r) => r.t === 'fact')).toHaveLength(5);
  });

  it('a run whose collector never closed is closed by the engine as failed, before the seal', async () => {
    const { recorder, ledger } = await recorderOverMemory();
    await recorder.record('fact', file('package-lock.json'));
    await recorder.record('fact', file('yarn.lock'));
    await recorder.record('fact', file('a.lock', 'other-reader@1', 3));
    await recorder.record('fact', file('b.lock', 'closed-reader@1'));
    await recorder.record('fact', closing('closed-reader@1'));
    await recorder.seal({ verdict: 'pass' });
    const records = await ledger();
    expect(records.map((r) => r.t)).toEqual(['run.open', 'fact', 'fact', 'fact', 'fact', 'fact', 'fact', 'fact', 'run.seal']);
    const closings = records.slice(6, 8).map((r) => r.body);
    const byTheEngine = { subject: 'repository', setOut: 'not stated: the collector did not close its run', status: 'failed' as const };
    const reason = 'the run ended before the collector recorded its collection fact';
    expect(closings).toEqual([
      collectionFact({ ...byTheEngine, by: 'lockfile-reader@1', run: 1, reason, counts: { facts: 2 } }),
      collectionFact({ ...byTheEngine, by: 'other-reader@1', run: 3, reason, counts: { facts: 1 } }),
    ]);
    expect(records[8]!.body).toMatchObject({ counts: { records: 9, byType: { fact: 7 } } });
  });

  it('takes a run back as it was when the ledger writer refuses a fact its schema accepted', async () => {
    const { recorder, ledger } = await recorderOverMemory();
    // The writer refuses what JSON would not carry back unchanged; the schema has no view on a missing value.
    const ghost = { ...file('a.lock', 'ghost-reader@1'), origin: undefined } as unknown as Parameters<typeof recorder.record>[1];
    await expect(recorder.record('fact', ghost)).rejects.toThrow(/undefined/);
    await recorder.record('fact', file('package-lock.json'));
    const unsent = { ...closing(), origin: undefined } as unknown as Parameters<typeof recorder.record>[1];
    await expect(recorder.record('fact', unsent)).rejects.toThrow(/undefined/);
    // The collection fact was refused, so the run is still open: it takes another fact, and the engine closes it.
    await recorder.record('fact', file('yarn.lock'));
    await recorder.seal(null);
    const facts = (await ledger()).filter((r) => r.t === 'fact').map((r) => r.body);
    expect(facts.map((f) => [f.by, f.kind])).toEqual([
      ['lockfile-reader@1', 'repo.file'],
      ['lockfile-reader@1', 'repo.file'],
      ['lockfile-reader@1', 'collection'],
    ]);
    expect(facts[2]!.body).toMatchObject({ status: 'failed', counts: { facts: 2 } });
  });

  it('counts in the closing fact the engine writes only the facts of the run that are in the ledger', async () => {
    const { recorder, ledger } = await recorderOverMemory();
    // The writer refuses the first fact after the second fact of the same run was accepted.
    const ghost = recorder.record('fact', { ...file('a.lock'), origin: undefined } as unknown as Parameters<typeof recorder.record>[1]);
    const kept = recorder.record('fact', file('b.lock'));
    await expect(ghost).rejects.toThrow(/undefined/);
    expect(await kept).toBe(1);
    await recorder.seal(null);
    const facts = (await ledger()).filter((r) => r.t === 'fact').map((r) => r.body);
    expect(facts.map((f) => [f.by, f.kind])).toEqual([
      ['lockfile-reader@1', 'repo.file'],
      ['lockfile-reader@1', 'collection'],
    ]);
    expect(facts[1]!.body).toMatchObject({ status: 'failed', counts: { facts: 1 } });
  });

  it('refuses every fact once the seal has started, so that no run opens or grows while the engine closes the open ones', async () => {
    const { recorder, ledger } = await recorderOverMemory();
    await recorder.record('fact', file('package-lock.json', 'r@1'));
    const sealing = recorder.seal(null);
    const late = recorder.record('fact', file('yarn.lock', 'late@1'));
    const more = recorder.record('fact', file('pnpm-lock.yaml', 'r@1'));
    await expect(late).rejects.toThrow(/being sealed/);
    await expect(more).rejects.toThrow(/being sealed/);
    const sealed = await sealing;
    const records = await ledger();
    // The refused facts took no position.
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(sealed.seq).toBe(3);
    expect(records.map((r) => [r.t, r.body.by, r.body.kind])).toEqual([
      ['run.open', undefined, undefined],
      ['fact', 'r@1', 'repo.file'],
      ['fact', 'r@1', 'collection'],
      ['run.seal', undefined, undefined],
    ]);
    // Every run that has a fact in the sealed ledger has its collection fact.
    const facts = records.filter((r) => r.t === 'fact').map((r) => r.body);
    const runOf = (f: Record<string, unknown>) => JSON.stringify([f.by, f.run]);
    expect(new Set(facts.filter((f) => f.kind === 'collection').map(runOf))).toEqual(new Set(facts.map(runOf)));
    await expect(recorder.record('fact', file('after.lock', 'later@1'))).rejects.toThrow(/sealed/);
  });

  it('opens no run for a fact it refused', async () => {
    const { recorder, ledger } = await recorderOverMemory();
    await recorder.record('fact', { ...file('/abs'), by: 'refused-reader@1' }).catch(() => undefined);
    await recorder.seal(null);
    expect((await ledger()).map((r) => r.t)).toEqual(['run.open', 'run.seal']);
  });

  it('closes a run under the subject of its last fact in the ledger, not of one the writer refused', async () => {
    const { recorder, ledger } = await recorderOverMemory();
    await recorder.record('fact', file('package-lock.json'));
    const elsewhere = { ...file('a.lock'), subject: 'another-subject', origin: undefined } as unknown as Parameters<typeof recorder.record>[1];
    await expect(recorder.record('fact', elsewhere)).rejects.toThrow(/undefined/);
    await recorder.seal(null);
    const facts = (await ledger()).filter((r) => r.t === 'fact').map((r) => r.body);
    expect(facts.map((f) => f.subject)).toEqual(['repository', 'repository']);
  });
});

describe('the scrubber runs before every write', () => {
  const TERM = 'Fictional-Org-Zeta';
  const TOKEN = 'tok_FAKE0000demo';
  const rules = { terms: [{ from: TERM, to: 'ORG' }, { from: TOKEN, to: '${secret.TOKEN}' }] };
  const bytes = (s: string) => new TextEncoder().encode(s);

  async function scrubbingRecorder(open: Record<string, unknown> = { format: 1 }) {
    const store = new MemoryStore();
    const recorder = await openRecorder(store, sha256, { origin: 'test-run', open: open as never, now: () => new Date(Date.UTC(2026, 10, 18)), scrub: rules });
    return { store, recorder };
  }
  const everything = (store: MemoryStore) => [...store.files.values()].map((b) => new TextDecoder().decode(b)).join('\n');

  it('scrubs a fact before it is checked and written, in its values and its names', async () => {
    const { store, recorder } = await scrubbingRecorder();
    await recorder.record('fact', { ...file(`apps/${TERM.toLowerCase()}/package-lock.json`), place: { [TERM]: `by ${TERM}` } });
    const text = everything(store);
    expect(text).not.toMatch(new RegExp(TERM, 'i'));
    expect(text).toContain('apps/ORG/package-lock.json');
  });

  it('scrubs a URL in run.open, a token in a path segment and its percent-encoded form too', async () => {
    const { store, recorder } = await scrubbingRecorder({ format: 1, inputs: { url: `https://app.test/invite/${TOKEN}/accept`, other: `https://app.test/q/${encodeURIComponent(`${TOKEN} x`)}` } });
    await recorder.seal({ note: `seen at /invite/${TOKEN}` });
    const text = everything(store);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('https://app.test/invite/${secret.TOKEN}/accept');
  });

  it('scrubs a text blob before it is stored, and names it by the digest of what was stored', async () => {
    const { store, recorder } = await scrubbingRecorder();
    const ref = await recorder.putBlob(bytes(`{"owner":"${TERM}"}`), 'application/json');
    expect(new TextDecoder().decode(await recorder.getBlob(ref.digest))).toBe('{"owner":"ORG"}');
    expect(everything(store)).not.toContain(TERM);
  });

  it('refuses a binary blob that holds a term, which it cannot scrub without breaking it', async () => {
    const { store, recorder } = await scrubbingRecorder();
    await expect(recorder.putBlob(bytes(`\u0089PNG ${TOKEN}`), 'image/png')).rejects.toThrow(/scrub/);
    expect(everything(store)).not.toContain(TOKEN);
    await expect(recorder.putBlob(bytes('\u0089PNG clean'), 'image/png')).resolves.toMatchObject({ mediaType: 'image/png' });
  });

  it('scrubs records that are not facts too', async () => {
    const { store, recorder } = await scrubbingRecorder();
    await recorder.record('verdict', { claim: 'c1@1', note: TERM });
    expect(everything(store)).not.toContain(TERM);
  });
});

describe('scrubbing never breaks a fact or loses a value', () => {
  // Two made-up organisation names, both scrubbed to the same placeholder.
  const twoToOne = { terms: [{ from: 'acmezed', to: 'ORG' }, { from: 'betazed', to: 'ORG' }] };
  async function scrubbing(rules: { terms: { from: string; to: string }[] }) {
    const store = new MemoryStore();
    const recorder = await openRecorder(store, sha256, { origin: 'test-run', open: { format: 1 }, now: () => new Date(Date.UTC(2026, 10, 19)), scrub: rules });
    const ledger = async () => (await readLedger(store)).records.map((r) => r.body as Record<string, any>);
    return { store, recorder, ledger };
  }

  it('keeps two list entries apart when scrubbing makes them equal, the same way whatever their order', async () => {
    const { recorder, ledger } = await scrubbing(twoToOne);
    const listedAs = async (paths: string[], run: number) => {
      const fact = collectionFact({ by: 'lockfile-reader@1', run, subject: 'repository', setOut: 'the lockfiles', counts: { lockfiles: paths.length }, listed: { lockfiles: paths } });
      await recorder.record('fact', fact);
      return (await ledger()).at(-1)!.body.listed.lockfiles as string[];
    };
    const forward = await listedAs(['acmezed/package-lock.json', 'betazed/package-lock.json'], 1);
    expect(forward).toEqual(['ORG/package-lock.json', 'ORG/package-lock.json~2']);
    const backward = await listedAs(['betazed/package-lock.json', 'acmezed/package-lock.json'], 2);
    expect(new Set(backward)).toEqual(new Set(forward));
    expect(backward).toEqual(['ORG/package-lock.json~2', 'ORG/package-lock.json']);
  });

  it('keeps an entry that was a duplicate before scrubbing a duplicate after it', async () => {
    const { recorder, ledger } = await scrubbing(twoToOne);
    await recorder.record('fact', { kind: 'tool.run', v: 1, by: 't@1', run: 1, subject: 'repository', body: { tool: 'x', version: null, finished: true, command: ['acmezed', 'acmezed', 'betazed'] } });
    expect((await ledger()).at(-1)!.body.command).toEqual(['ORG', 'ORG', 'ORG~2']);
  });

  it('keeps two object keys apart when scrubbing makes them equal, losing no value', async () => {
    const { recorder, ledger } = await scrubbing(twoToOne);
    const counts = { acmezed: 1, betazed: 2 };
    await recorder.record('fact', collectionFact({ by: 'r@1', subject: 'repository', setOut: 'the lockfiles', counts }));
    expect((await ledger()).at(-1)!.body.counts).toEqual({ ORG: 1, 'ORG~2': 2 });
  });

  it('does not scrub a digest, even when a secret is found inside it', async () => {
    const store = new MemoryStore();
    const plain = await openRecorder(store, sha256, { origin: 'test-run', open: { format: 1 }, now: () => new Date(Date.UTC(2026, 10, 19)) });
    const ref = await plain.putBlob(new TextEncoder().encode('{"a":1}'), 'application/json');
    // A six-character hex secret that happens to sit inside the blob's digest.
    const secret = ref.digest.slice('sha256:'.length + 10, 'sha256:'.length + 16);
    const { recorder, ledger } = await scrubbing({ terms: [{ from: secret, to: '${secret.HEX}' }] });
    const asset = { kind: 'asset', v: 1, by: 'w@1', run: 1, subject: 'target', body: { from: 'served', name: 'a.json' }, blobs: { content: ref } };
    await recorder.record('fact', asset);
    const file = { kind: 'repo.file', v: 1, by: 'w@1', run: 1, subject: 'target', body: { path: 'a.json', digest: ref.digest } };
    await recorder.record('fact', file);
    const [, written, second] = await ledger();
    expect(written!.blobs.content.digest).toBe(ref.digest);
    expect(second!.body.digest).toBe(ref.digest);
  });

  it('does not scrub the fields that are structure: the kind and the collector', async () => {
    const { recorder, ledger } = await scrubbing({ terms: [{ from: 'lockfile', to: 'X' }] });
    await recorder.record('fact', { kind: 'repo.file', v: 1, by: 'lockfile-reader@1', run: 1, subject: 'repository', body: { path: 'a/lockfile.json', role: 'lockfile' } });
    const [, written] = await ledger();
    expect(written).toMatchObject({ kind: 'repo.file', by: 'lockfile-reader@1', body: { path: 'a/X.json', role: 'X' } });
  });
});
