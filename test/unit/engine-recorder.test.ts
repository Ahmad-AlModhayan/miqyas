// SPDX-License-Identifier: AGPL-3.0-only
// The recorder enforces the fact kinds and closes collector runs (docs/FOUNDATION.md §3): a fact that fails its schema
// never reaches the ledger, no fact of a run is accepted after the run's `collection` fact, and a run that ends with a
// collector run still open has the engine close it as failed. Over a store in memory; the kernel is real.
import { describe, expect, it } from 'vitest';
import { FactRefused } from '../../src/engine/fact-check.js';
import { openRecorder } from '../../src/engine/recorder.js';
import { readLedger } from '../../src/kernel/ledger.js';
import { MemoryStore, sha256 } from '../kernel-helpers.js';

async function recorderOverMemory() {
  const store = new MemoryStore();
  const recorder = await openRecorder(store, sha256, { origin: 'test-run', open: { format: 1 }, now: () => new Date(Date.UTC(2026, 10, 18)) });
  const ledger = async () => (await readLedger(store)).records.map((r) => ({ seq: r.seq, t: r.t, body: r.body as Record<string, unknown> }));
  return { store, recorder, ledger };
}

const file = (path: string, by = 'lockfile-reader@1', run = 1) => ({ kind: 'repo.file', v: 1, by, run, subject: 'repository', body: { path, role: 'lockfile' } });
const closing = (by = 'lockfile-reader@1', run = 1, status = 'complete') => ({
  kind: 'collection',
  v: 1,
  by,
  run,
  subject: 'repository',
  body: { setOut: 'every supported lockfile in the repository', status, ...(status === 'complete' ? {} : { reason: 'stopped' }), counts: { lockfiles: 1 }, dropped: 0 },
});

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
    expect(closings).toEqual([
      {
        kind: 'collection',
        v: 1,
        by: 'lockfile-reader@1',
        run: 1,
        subject: 'repository',
        body: {
          setOut: 'not stated: the collector did not close its run',
          status: 'failed',
          reason: 'the run ended before the collector recorded its collection fact',
          counts: { facts: 2 },
          dropped: 0,
        },
      },
      {
        kind: 'collection',
        v: 1,
        by: 'other-reader@1',
        run: 3,
        subject: 'repository',
        body: {
          setOut: 'not stated: the collector did not close its run',
          status: 'failed',
          reason: 'the run ended before the collector recorded its collection fact',
          counts: { facts: 1 },
          dropped: 0,
        },
      },
    ]);
    expect(records[8]!.body).toMatchObject({ counts: { records: 9, byType: { fact: 7 } } });
  });

  it('takes a run back as it was when the ledger writer refuses a fact its schema accepted', async () => {
    const { recorder, ledger } = await recorderOverMemory();
    // The writer refuses what JSON would not carry back unchanged; the schema has no view on -0 or a missing value.
    const ghost = { ...file('a.lock', 'ghost-reader@1'), origin: undefined } as unknown as Parameters<typeof recorder.record>[1];
    await expect(recorder.record('fact', ghost)).rejects.toThrow(/undefined/);
    await recorder.record('fact', file('package-lock.json'));
    const minusZero = { ...closing(), body: { ...closing().body, dropped: -0 } };
    await expect(recorder.record('fact', minusZero)).rejects.toThrow(/-0/);
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
});
