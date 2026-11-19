// SPDX-License-Identifier: AGPL-3.0-only
// --fail-on <severity> on the new path (docs/FOUNDATION.md §4, "The fold"): a claim over `finding` facts, judged by the
// real judge and folded by the one fold, at the judge and fold seams with findings built here, and through the run
// with --proof-bundle into a real bundle that verifies.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEVERITIES, type Severity, TARGET_SUBJECT, failOnClaimFile, runFailOn } from '../../src/entry/fail-on.js';
import { type CurrentPathResult, judgeNewPath, runBundled } from '../../src/entry/run-command.js';
import { verifyBundle } from '../../src/entry/verify.js';
import type { PlacedFact } from '../../src/kernel/fact.js';
import { sealResult } from '../../src/kernel/judge.js';
import { type Given, judge, loadFile, place } from '../kernel-helpers.js';

/** A finding as the agreed shape has it: its severity and state in the body, the facts it rests on in `from`. */
const finding = (severity: string, state: string, from?: number[]): Given => ({ kind: 'finding', by: 'f@1', body: { severity, state }, ...(from ? { from } : {}) });
const closed = (status = 'complete'): Given => ({ kind: 'collection', by: 'f@1', body: { status } });
const supplied = { supplies: { kinds: ['finding'] } };

describe('the --fail-on claim at the judge: no confirmed finding at or above the severity', () => {
  it('loads for every severity, with its examples, and says what it means', async () => {
    for (const severity of SEVERITIES) {
      const loaded = await loadFile(failOnClaimFile(severity));
      expect(loaded.claim.title).toBe(`no confirmed finding at or above ${severity}`);
      expect(loaded.failedOn).toBe(`a confirmed ${severity} finding`);
    }
  });

  it('fails on a confirmed finding at or above the severity, and shows it', async () => {
    const loaded = await loadFile(failOnClaimFile('high'));
    for (const severity of ['high', 'critical']) {
      const v = judge(loaded, place([finding('low', 'confirmed'), finding(severity, 'confirmed'), closed()]), supplied);
      expect(v.verdict).toBe('fail');
      expect(v.shown).toEqual([2]);
    }
  });

  it('passes when every finding at or above it is unconfirmed or there is none, once every collector closed complete', async () => {
    const loaded = await loadFile(failOnClaimFile('high'));
    const v = judge(loaded, place([finding('critical', 'unconfirmed'), finding('medium', 'confirmed'), closed()]), supplied);
    expect(v.verdict).toBe('pass');
    expect(v.items).toEqual({ held: 0, failed: 1, outside: 1, uncertain: 0 });
    const none = judge(loaded, place([closed()]), supplied);
    expect(none.verdict).toBe('pass');
    expect(none.vacuous).toBe(true);
  });

  it('is not known while a collector has not closed complete, or a finding has no severity it knows', async () => {
    const loaded = await loadFile(failOnClaimFile('high'));
    expect(judge(loaded, place([closed('failed')]), supplied)).toMatchObject({ verdict: 'not_checked', reason: 'coverage not met' });
    expect(judge(loaded, place([]), supplied)).toMatchObject({ verdict: 'not_checked', reason: 'coverage not met' });
    expect(judge(loaded, place([{ kind: 'finding', by: 'f@1', body: { state: 'confirmed' } }, closed()]), supplied)).toMatchObject({
      verdict: 'not_checked',
      reason: 'uncertain items: an expression gave an error',
    });
  });

  it('is blocked while no collector records findings, saying to add one; a confirmed finding still fails', async () => {
    const loaded = await loadFile(failOnClaimFile('high'));
    expect(judge(loaded, place([closed()]))).toMatchObject({ verdict: 'blocked', reason: 'no collector records a kind it needs', add: ['kind:finding'] });
    expect(judge(loaded, place([finding('critical', 'confirmed'), closed()])).verdict).toBe('fail');
  });

  it('reads through from: a finding derived from facts it was given is derived', async () => {
    const loaded = await loadFile(failOnClaimFile('high'));
    const facts = place([{ kind: 'dep.advisory', by: 'f@1', body: {} }, finding('high', 'confirmed', [1]), closed()]);
    expect(judge(loaded, facts, supplied).depth).toBe('derived');
  });

  it('folds like any claim: no special case', async () => {
    const loaded = await loadFile(failOnClaimFile('medium'));
    const failing = judge(loaded, place([finding('medium', 'confirmed'), closed()]), supplied);
    const passing = judge(loaded, place([closed()]), supplied);
    expect(sealResult([failing.verdict, 'pass'])).toMatchObject({ verdict: 'fail', exit: 1 });
    expect(sealResult([passing.verdict, 'pass'])).toMatchObject({ verdict: 'pass', exit: 0 });
    expect(sealResult([judge(loaded, place([closed()])).verdict, 'pass'])).toMatchObject({ verdict: 'not_known', exit: 3 });
  });
});

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-failon-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const current: CurrentPathResult = { exitCode: 0, report: { verdict: 'pass', plans: [] } };
const steps = { openDriver: async () => ({ close: async () => undefined }), run: async () => current, print: () => undefined };
const bundled = (dir: string, judgeWith: Parameters<typeof runBundled>[0]['judge']) => ({
  bundle: { dir, runId: 'run-1', open: { url: 'http://127.0.0.1:9/' }, now: () => new Date('2026-11-19T00:00:00Z') },
  judge: judgeWith,
  printHead: () => undefined,
});
const records = async (dir: string) => (await readFile(path.join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

describe('--fail-on through the run with --proof-bundle', () => {
  it('adds the claim; today nothing on the new path records findings, so it is blocked and the run exits 3', async () => {
    const out = path.join(tmp, 'today');
    expect(await runBundled(bundled(out, (recorder) => judgeNewPath(recorder, { failOn: 'high' })), steps)).toBe(3);
    const ledger = await records(out);
    expect(ledger.filter((r) => r.t === 'claim').map((r) => r.body.claim)).toEqual(['fail-on.high@1']);
    expect(ledger.filter((r) => r.t === 'verdict').map((r) => [r.body.verdict, r.body.add, r.body.view.subject])).toEqual([['blocked', ['kind:finding'], TARGET_SUBJECT]]);
    expect(ledger.at(-1).body.result).toMatchObject({ verdict: 'not_known', verdicts: 1, exit: 3, currentPath: { exitCode: 0 } });
    expect((await verifyBundle(out)).exitCode).toBe(0);
  });

  it('adds no claim without the flag: with no other claim the run is a usage error, exit 2', async () => {
    for (const failOn of [undefined, 'none'] as const) {
      const out = path.join(tmp, `none-${failOn}`);
      expect(await runBundled(bundled(out, (recorder) => judgeNewPath(recorder, failOn === undefined ? {} : { failOn })), steps)).toBe(2);
      expect((await records(out)).some((r) => r.t === 'claim')).toBe(false);
    }
  });

  const withFindings = (severity: Severity, facts: PlacedFact[]) => (recorder: Parameters<typeof runFailOn>[0]) =>
    runFailOn(recorder, { severity, subject: TARGET_SUBJECT, facts, supplies: { kinds: ['finding'] } }).then((v) => [v]);
  const about = (given: Given[]) => place(given).map((p) => ({ ...p, fact: { ...p.fact, subject: TARGET_SUBJECT } }));

  it.each([
    ['a confirmed critical finding', [finding('critical', 'confirmed'), closed()], 'fail', 1],
    ['only an unconfirmed high finding and a confirmed low one', [finding('high', 'unconfirmed'), finding('low', 'confirmed'), closed()], 'pass', 0],
    ['a collector that did not finish', [finding('low', 'confirmed'), closed('failed')], 'not_checked', 3],
  ] as const)('the result and the exit code follow from the fold: %s', async (_name, given, verdict, exit) => {
    const out = path.join(tmp, `case-${exit}`);
    expect(await runBundled(bundled(out, withFindings('high', about([...given]))), steps)).toBe(exit);
    const ledger = await records(out);
    expect(ledger.filter((r) => r.t === 'verdict').map((r) => r.body.verdict)).toEqual([verdict]);
    expect((await verifyBundle(out)).exitCode).toBe(0);
  });

  it.todo('end to end: a finding recorded through the recorder fails `run --proof-bundle --fail-on high` (once the finding kind has its schema)');
});
