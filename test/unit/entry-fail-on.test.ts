// SPDX-License-Identifier: AGPL-3.0-only
// --fail-on <severity> on the new path (docs/FOUNDATION.md §4, "The fold"): a claim over `finding` facts, judged by the
// real judge and folded by the one fold, at the judge and fold seams with findings built here, and through the run
// with --proof-bundle into a real bundle that verifies.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TARGET_SUBJECT, failOnClaimPath, runFailOn } from '../../src/entry/fail-on.js';
import type { RunRecorder } from '../../src/engine/recorder.js';
import { type CurrentPathResult, type NewPathCollector, judgeNewPath, runBundled } from '../../src/entry/run-command.js';
import { verifyBundle } from '../../src/entry/verify.js';
import type { PlacedFact } from '../../src/kernel/fact.js';
import { sealResult } from '../../src/kernel/fold.js';
import type { Json } from '../../src/kernel/ledger.js';
import { type FindingSeverity, SEVERITY_RANK } from '../../src/proof-core/findings.js';
import { type Given, advisoryFact, collectionFact, done, finding, judge, loadFile, place } from '../kernel-helpers.js';

/** The `collection` fact of the collector that records the findings. */
const closed = (status = 'complete'): Given => done(status, 'f@1');
/** What the run hands the claim when `f@1` is the one collector declared as recording findings. */
const supplied = { supplies: { kinds: ['finding'] }, inputs: { finders: ['f@1'] } };

/** The severities, least first, from the one list the findings keep. */
const SEVERITIES = (Object.keys(SEVERITY_RANK) as FindingSeverity[]).sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b]);
/** A shipped claim file, as data. */
const claimFile = async (severity: FindingSeverity) => JSON.parse(await readFile(failOnClaimPath(severity), 'utf8'));

describe('the --fail-on claim at the judge: no confirmed finding at or above the severity', () => {
  it('is data in src/claims, one file per severity, each naming exactly the severities at or above it', async () => {
    for (const severity of SEVERITIES) {
      expect(path.relative(path.resolve('src', 'claims'), failOnClaimPath(severity))).toBe(`fail-on-${severity}.json`);
      const file = await claimFile(severity);
      expect(file.id).toBe(`fail-on.${severity}`);
      const atOrAbove = SEVERITIES.filter((s) => SEVERITY_RANK[s] >= SEVERITY_RANK[severity]);
      expect(file.where).toBe(`item.severity in [${atOrAbove.map((s) => JSON.stringify(s)).join(', ')}]`);
    }
  });

  it('loads for every severity, with its examples, and says what it means', async () => {
    for (const severity of SEVERITIES) {
      const loaded = await loadFile(await claimFile(severity));
      expect(loaded.claim.title).toBe(`no confirmed finding at or above ${severity}`);
      expect(loaded.failedOn).toBe(`a confirmed ${severity} finding`);
    }
  });

  it('shows in every file that a declared finder which never closed leaves the claim not known', async () => {
    for (const severity of SEVERITIES) {
      const file = await claimFile(severity);
      const two = file.examples.find((e: { inputs?: { finders?: string[] } }) => (e.inputs?.finders ?? []).length === 2);
      expect(two).toMatchObject({ expect: 'not_checked', facts: [{ kind: 'collection', by: 'example', body: { status: 'complete' } }] });
    }
  });

  it('fails on a confirmed finding at or above the severity, and shows it', async () => {
    const loaded = await loadFile(await claimFile('high'));
    for (const severity of ['high', 'critical']) {
      const v = judge(loaded, place([finding('low', 'confirmed'), finding(severity, 'confirmed'), closed()]), supplied);
      expect(v.verdict).toBe('fail');
      expect(v.shown).toEqual([2]);
    }
  });

  it('passes when every finding at or above it is unconfirmed or there is none, once every collector closed complete', async () => {
    const loaded = await loadFile(await claimFile('high'));
    const v = judge(loaded, place([finding('critical', 'unconfirmed'), finding('medium', 'confirmed'), closed()]), supplied);
    expect(v.verdict).toBe('pass');
    expect(v.items).toEqual({ held: 0, failed: 1, outside: 1, uncertain: 0 });
    const none = judge(loaded, place([closed()]), supplied);
    expect(none.verdict).toBe('pass');
    expect(none.vacuous).toBe(true);
  });

  it('is not known while a collector has not closed complete, or a finding has no severity it knows', async () => {
    const loaded = await loadFile(await claimFile('high'));
    expect(judge(loaded, place([closed('failed')]), supplied)).toMatchObject({ verdict: 'not_checked', reason: 'coverage not met' });
    expect(judge(loaded, place([]), supplied)).toMatchObject({ verdict: 'not_checked', reason: 'coverage not met' });
    // Told of a second declared finder that never closed, or not told which finders were declared: not covered.
    const two = { ...supplied, inputs: { finders: ['f@1', 'f2@1'] } };
    expect(judge(loaded, place([closed()]), two)).toMatchObject({ verdict: 'not_checked', reason: 'coverage not met' });
    expect(judge(loaded, place([closed()]), { supplies: supplied.supplies })).toMatchObject({ verdict: 'not_checked', reason: 'coverage not met' });
    expect(judge(loaded, place([{ kind: 'finding', by: 'f@1', body: { state: 'confirmed' } }, closed()]), supplied)).toMatchObject({
      verdict: 'not_checked',
      reason: 'uncertain items: an expression gave an error',
    });
  });

  it('is blocked while no collector records findings, saying to add one; a confirmed finding still fails', async () => {
    const loaded = await loadFile(await claimFile('high'));
    expect(judge(loaded, place([closed()]))).toMatchObject({ verdict: 'blocked', reason: 'no collector records a kind it needs', add: ['kind:finding'] });
    expect(judge(loaded, place([finding('critical', 'confirmed'), closed()])).verdict).toBe('fail');
  });

  it('reads through from: a finding derived from facts it was given is derived', async () => {
    const loaded = await loadFile(await claimFile('high'));
    const facts = place([{ kind: 'dep.advisory', by: 'f@1', body: {} }, finding('high', 'confirmed', [1]), closed()]);
    expect(judge(loaded, facts, supplied).depth).toBe('derived');
  });

  it('folds like any claim: no special case', async () => {
    const loaded = await loadFile(await claimFile('medium'));
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
  it('adds the claim; on a clean run as the CLI starts it no collector on the new path looks for findings, so it is blocked and the run exits 3', async () => {
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

  const withFindings = (severity: FindingSeverity, facts: PlacedFact[]) => (recorder: Parameters<typeof runFailOn>[0]) =>
    runFailOn(recorder, { severity, subject: TARGET_SUBJECT, facts, finders: ['f@1'], supplies: { kinds: ['finding'] } });
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

  it('misses no confirmed finding at or above the severity, whichever subject it is on: one verdict per subject, all folded', async () => {
    const out = path.join(tmp, 'another-subject');
    // The run's own subject closed complete with no finding; a confirmed critical finding on another subject.
    const facts = [...about([closed()]), ...place([{ ...finding('critical', 'confirmed'), subject: 'api' }, { ...closed(), subject: 'api' }], 2)];
    expect(await runBundled(bundled(out, withFindings('high', facts)), steps)).toBe(1);
    const ledger = await records(out);
    expect(ledger.filter((r) => r.t === 'claim')).toHaveLength(1);
    expect(ledger.filter((r) => r.t === 'verdict').map((r) => [r.body.view.subject, r.body.verdict])).toEqual([
      [TARGET_SUBJECT, 'pass'],
      ['api', 'fail'],
    ]);
    expect(ledger.at(-1).body.result).toMatchObject({ verdict: 'fail', verdicts: 2, exit: 1 });
    expect((await verifyBundle(out)).exitCode).toBe(0);
  });

  it('a finding on another subject that settles nothing there still counts: an unconfirmed one with no closed collector is not known', async () => {
    const out = path.join(tmp, 'another-unclosed');
    const facts = [...about([closed()]), ...place([{ ...finding('high', 'unconfirmed'), subject: 'api' }], 2)];
    expect(await runBundled(bundled(out, withFindings('high', facts)), steps)).toBe(3);
    const ledger = await records(out);
    expect(ledger.filter((r) => r.t === 'verdict').map((r) => [r.body.view.subject, r.body.verdict])).toEqual([
      [TARGET_SUBJECT, 'pass'],
      ['api', 'not_checked'],
    ]);
  });

});

describe('--fail-on end to end: findings recorded through the recorder, the claim judged over what the bundle holds', () => {
  const FINDER = 'finder@1';
  type Found = { severity: FindingSeverity; state: 'confirmed' | 'unconfirmed' };
  /** How a collector looks at one subject: in a run of its own, the findings it records, then how it closes (null: it doesn't). */
  type Look = { subject: string; found?: Found[]; status?: 'complete' | 'partial' | 'failed' | null };
  const fact = (recorder: RunRecorder, body: unknown) => recorder.record('fact', body as Json);

  /** A collector that looks for findings: each one rests on the advisory it read, as the `finding` kind requires. */
  const finder = (looks: Look[], by = FINDER): NewPathCollector => ({
    by,
    records: ['dep.advisory', 'finding'],
    collect: async (recorder) => {
      for (const [i, look] of looks.entries()) {
        const envelope = { v: 1, by, run: i + 1, subject: look.subject };
        for (const [j, f] of (look.found ?? []).entries()) {
          const read = await fact(recorder, { ...advisoryFact(`GHSA-${i}-${j}`, f.severity), ...envelope });
          await fact(recorder, { ...finding(f.severity, f.state, [read]), ...envelope });
        }
        if (look.status === null) continue;
        const counts = { findings: look.found?.length ?? 0 };
        await fact(recorder, collectionFact({ ...envelope, setOut: 'findings about the subject', counts, status: look.status ?? 'complete' }));
      }
    },
  });
  /** A collector that records no finding, and closes complete about the run's subject. */
  const other: NewPathCollector = {
    by: 'other@1',
    records: ['repo.tree'],
    collect: async (recorder) => {
      await fact(recorder, collectionFact({ by: 'other@1', subject: TARGET_SUBJECT, setOut: 'the tree', counts: { files: 0 } }));
    },
  };

  const runWith = async (name: string, collectors: NewPathCollector[]) => {
    const out = path.join(tmp, name);
    const exit = await runBundled(bundled(out, (recorder) => judgeNewPath(recorder, { failOn: 'high', collectors })), steps);
    const ledger = await records(out);
    expect((await verifyBundle(out)).exitCode).toBe(0);
    const verdicts = ledger.filter((r) => r.t === 'verdict').map((r) => r.body);
    return { exit, ledger, verdicts, bySubject: verdicts.map((v) => [v.view.subject, v.verdict]) };
  };
  const seqsOf = (ledger: { seq: number; t: string; body: { kind?: string } }[], kind: string) =>
    ledger.filter((r) => r.t === 'fact' && r.body.kind === kind).map((r) => r.seq);

  it('fails on a confirmed finding at the threshold, and shows the finding as the bundle holds it: exit 1', async () => {
    const { exit, ledger, verdicts } = await runWith('at', [finder([{ subject: TARGET_SUBJECT, found: [{ severity: 'high', state: 'confirmed' }] }])]);
    expect(exit).toBe(1);
    expect(verdicts.map((v) => v.verdict)).toEqual(['fail']);
    expect(verdicts[0].shown).toEqual(seqsOf(ledger, 'finding'));
    expect(verdicts[0].depth).toBe('derived');
    expect(ledger.at(-1).body.result).toMatchObject({ verdict: 'fail', verdicts: 1, exit: 1 });
  });

  it.each([
    ['a confirmed finding below the threshold', { severity: 'medium', state: 'confirmed' }],
    ['an unconfirmed critical finding', { severity: 'critical', state: 'unconfirmed' }],
  ] as const)('passes on %s once the collector closed complete: exit 0', async (_name, found) => {
    const { exit, verdicts } = await runWith(`below-${found.severity}`, [finder([{ subject: TARGET_SUBJECT, found: [found] }])]);
    expect(exit).toBe(0);
    expect(verdicts.map((v) => [v.verdict, v.coverage.met])).toEqual([['pass', true]]);
  });

  it('passes with no finding at all when the collector that looks for findings closed complete: exit 0', async () => {
    const { exit, verdicts } = await runWith('none', [finder([{ subject: TARGET_SUBJECT }])]);
    expect(exit).toBe(0);
    expect(verdicts.map((v) => [v.verdict, v.vacuous])).toEqual([['pass', true]]);
  });

  it('fails on a confirmed finding at the threshold on a second subject: one verdict per subject, exit 1', async () => {
    const looks = [{ subject: TARGET_SUBJECT }, { subject: 'api', found: [{ severity: 'high', state: 'confirmed' } as const] }];
    const { exit, bySubject } = await runWith('second', [finder(looks)]);
    expect(exit).toBe(1);
    expect(bySubject).toEqual([
      [TARGET_SUBJECT, 'pass'],
      ['api', 'fail'],
    ]);
  });

  it('never passes because nothing looked for findings: with only another collector, closed complete, it is blocked, exit 3', async () => {
    const { exit, verdicts } = await runWith('nobody', [other]);
    expect(exit).toBe(3);
    expect(verdicts.map((v) => [v.verdict, v.add])).toEqual([['blocked', ['kind:finding']]]);
  });

  it("is not known while the collector that looks for findings hasn't closed, though another closed complete: exit 3", async () => {
    const unclosed = finder([{ subject: TARGET_SUBJECT, found: [{ severity: 'high', state: 'unconfirmed' }], status: null }]);
    const { exit, verdicts } = await runWith('unclosed', [unclosed, other]);
    expect(exit).toBe(3);
    expect(verdicts.map((v) => [v.verdict, v.reason])).toEqual([['not_checked', 'coverage not met']]);
  });

  describe('two collectors declared as recording findings: covered only once every one closed complete', () => {
    const SECOND = 'finder2@1';
    const clean = finder([{ subject: TARGET_SUBJECT }]);

    it('is not known while the second has not closed, though the first closed complete with no finding: exit 3', async () => {
      const { exit, verdicts } = await runWith('two-unclosed', [clean, finder([{ subject: TARGET_SUBJECT, status: null }], SECOND)]);
      expect(exit).toBe(3);
      expect(verdicts.map((v) => [v.verdict, v.reason, v.coverage.met])).toEqual([['not_checked', 'coverage not met', false]]);
    });

    it.each(['failed', 'partial'] as const)('is not known while the second closed %s: exit 3', async (status) => {
      const { exit, verdicts } = await runWith(`two-${status}`, [clean, finder([{ subject: TARGET_SUBJECT, status }], SECOND)]);
      expect(exit).toBe(3);
      expect(verdicts.map((v) => [v.verdict, v.reason, v.coverage.met])).toEqual([['not_checked', 'coverage not met', false]]);
    });

    it('passes once both closed complete with no finding: exit 0', async () => {
      const { exit, verdicts } = await runWith('two-complete', [clean, finder([{ subject: TARGET_SUBJECT }], SECOND)]);
      expect(exit).toBe(0);
      expect(verdicts.map((v) => [v.verdict, v.coverage.met])).toEqual([['pass', true]]);
    });

    describe('two collectors under the same name are refused: a fact\'s `by` cannot tell them apart', () => {
      /** A recorder that counts what is written to it: a refused list must write nothing. */
      const counting = () => {
        const calls: string[] = [];
        const recorder = { record: async (t: string) => (calls.push(t), 1) } as unknown as Parameters<typeof judgeNewPath>[0];
        return { calls, recorder };
      };
      const refuses = async (collectors: NewPathCollector[]) => {
        const { calls, recorder } = counting();
        await expect(judgeNewPath(recorder, { failOn: 'high', collectors })).rejects.toThrow(/duplicate.*finder@1/i);
        expect(calls).toEqual([]);
      };

      it('refuses two collectors that both record findings, naming the name', async () => {
        await refuses([clean, finder([{ subject: TARGET_SUBJECT, status: null }])]);
      });

      it('refuses the same name on a finder and on a collector that records another kind', async () => {
        await refuses([clean, { ...other, by: FINDER }]);
        await refuses([{ ...other, by: FINDER }, clean]);
      });

      it('refuses the run when the first closes complete with no finding and the second never closes, and gives no verdict', async () => {
        const out = path.join(tmp, 'same-name');
        const sameName = [clean, finder([{ subject: TARGET_SUBJECT, status: null }])];
        const run = runBundled(bundled(out, (recorder) => judgeNewPath(recorder, { failOn: 'high', collectors: sameName })), steps);
        await expect(run).rejects.toThrow(/duplicate.*finder@1/i);
        const ledger = await records(out).catch(() => []);
        expect(ledger.filter((r) => r.t === 'verdict')).toEqual([]);
        expect(ledger.some((r) => r.t === 'fact')).toBe(false);
      });

      it('accepts names that differ only by version, since a fact\'s `by` is the exact text: exit 0', async () => {
        const { exit, verdicts } = await runWith('two-versions', [clean, finder([{ subject: TARGET_SUBJECT }], 'finder@2')]);
        expect(exit).toBe(0);
        expect(verdicts.map((v) => [v.verdict, v.coverage.met])).toEqual([['pass', true]]);
      });

      it('accepts two collectors with different names, as before: exit 0', async () => {
        const { exit, verdicts } = await runWith('two-distinct', [clean, other]);
        expect(exit).toBe(0);
        expect(verdicts.map((v) => v.verdict)).toEqual(['pass']);
      });
    });

    it('still fails on a confirmed finding at the threshold while the second has not closed: exit 1', async () => {
      const found = finder([{ subject: TARGET_SUBJECT, found: [{ severity: 'high', state: 'confirmed' }] }]);
      const { exit, verdicts } = await runWith('two-found', [found, finder([{ subject: TARGET_SUBJECT, status: null }], SECOND)]);
      expect(exit).toBe(1);
      expect(verdicts.map((v) => [v.verdict, v.coverage.met])).toEqual([['fail', false]]);
    });
  });
});
