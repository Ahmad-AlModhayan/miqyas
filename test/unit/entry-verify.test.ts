// SPDX-License-Identifier: AGPL-3.0-only
// `miqyas verify <bundle>` (docs/FOUNDATION.md §5, "Verifying"): needs no target, model or network, answers "Intact?",
// exits non-zero when the bundle is not intact and names the record or file, and prints the head when it is.
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/entry/cli.js';
import { verifyBundle } from '../../src/entry/verify.js';
import { runWithProofBundle } from '../../src/entry/proof-bundle.js';
import { collectionFact, independentCheckpoint } from '../kernel-helpers.js';

let tmp: string;
let dir: string;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 17, 10, 15, tick++));

/** A sealed bundle: run.open, a fact that names a blob, a verdict, the collection fact that closes the fact's run, run.seal. */
async function makeBundle(at: string): Promise<void> {
  tick = 0;
  await runWithProofBundle({ dir: at, runId: 'run-1', open: { format: 1 }, now: clock, print: () => undefined }, async (recorder) => {
    const blob = await recorder.putBlob(new TextEncoder().encode('<html>the page</html>'), 'text/html');
    const fact = { by: 'test-worker@1', run: 1, subject: 'target', v: 1 };
    await recorder.record('fact', { ...fact, kind: 'asset', body: { from: 'served', name: 'https://app.test/alpha' }, blobs: { content: blob } });
    await recorder.record('verdict', { claim: 'c1@1', verdict: 'pass' });
    await recorder.record('fact', collectionFact({ by: fact.by, run: fact.run, subject: fact.subject, setOut: 'the page', counts: { assets: 1 } }));
    return { result: 0, fold: { verdict: 'pass', verdicts: 1 } };
  });
}

const ledgerPath = () => path.join(dir, 'ledger.jsonl');
const readLines = async () => (await readFile(ledgerPath(), 'utf8')).split('\n').filter((l) => l !== '');
const writeLines = (lines: string[]) => writeFile(ledgerPath(), lines.join('\n') + '\n');
const blobFile = async () => {
  const sub = path.join(dir, 'blobs', 'sha256');
  const [two] = await readdir(sub);
  const [rest] = await readdir(path.join(sub, two!));
  return path.join(sub, two!, rest!);
};

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-verify-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmp, 'b-'));
  await rm(dir, { recursive: true });
  await makeBundle(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const text = (lines: string[]) => lines.join('\n');

describe('verify on an untouched bundle', () => {
  it('exits 0, says it is intact and prints the head', async () => {
    const r = await verifyBundle(dir);
    expect(r.exitCode).toBe(0);
    const [, size, root] = (await readFile(path.join(dir, 'checkpoint'), 'utf8')).split('\n') as [string, string, string];
    expect(text(r.lines)).toContain('1. Intact? yes');
    expect(text(r.lines)).toContain(`head: ${size} records, root ${root}`);
    expect(size).toBe('5');
  });

  it('says that the questions this version does not answer are not answered, so a pass is not read as more', async () => {
    const out = text((await verifyBundle(dir)).lines);
    expect(out).toContain('3. Do the verdicts follow? not checked yet');
    expect(out).toContain('4. Do the derived facts follow? not checked yet');
    expect(out).toMatch(/cannot show who made it|can't show who made it/);
  });

  it('answers that the result follows: the fold of the verdict records is what the seal says', async () => {
    const r = await verifyBundle(dir);
    expect(r.lines).toContain('2. Does the result follow? yes');
    expect(r.lines).toContain('   the seal (record 4) says pass over 1 verdict; the fold of the 1 verdict record gives pass');
  });

  it('still verifies when the folder is copied somewhere else', async () => {
    const copy = path.join(tmp, 'copied-elsewhere');
    await cp(dir, copy, { recursive: true });
    const r = await verifyBundle(copy);
    expect(r.exitCode).toBe(0);
    await rm(copy, { recursive: true, force: true });
  });
});

describe('verify on an intact bundle whose seal does not follow from its verdicts', () => {
  /** Written through the writer, so the bundle is intact and only the seal's result is wrong. */
  async function sealWith(at: string, verdicts: string[], fold: { verdict: string; verdicts: number }): Promise<void> {
    tick = 0;
    await runWithProofBundle({ dir: at, runId: 'run-2', open: { format: 1 }, now: clock, print: () => undefined }, async (recorder) => {
      for (const [i, verdict] of verdicts.entries()) await recorder.record('verdict', { claim: `c${i + 1}@1`, verdict });
      return { result: 0, fold };
    });
  }

  it('answers no, naming the seal and the verdict record that disagree, while it is still intact', async () => {
    const at = path.join(tmp, 'wrong-fold');
    await sealWith(at, ['pass', 'fail'], { verdict: 'pass', verdicts: 2 });
    const r = await verifyBundle(at);
    expect(r.exitCode).toBe(1);
    expect(r.lines).toContain('1. Intact? yes');
    expect(r.lines).toContain('2. Does the result follow? NO');
    expect(r.lines).toContain('   the seal (record 3) says pass over 2 verdicts; the fold of the 2 verdict records gives fail');
    expect(r.lines).toContain('   record 2: c2@1 fail');
    await rm(at, { recursive: true, force: true });
  });

  it('answers no when the seal counts verdicts the ledger does not hold', async () => {
    const at = path.join(tmp, 'wrong-count');
    await sealWith(at, ['pass'], { verdict: 'pass', verdicts: 2 });
    const r = await verifyBundle(at);
    expect(r.lines).toContain('1. Intact? yes');
    expect(r.lines).toContain('2. Does the result follow? NO');
    expect(r.lines).toContain('   the seal (record 2) says pass over 2 verdicts; the fold of the 1 verdict record gives pass');
    await rm(at, { recursive: true, force: true });
  });

  it('does not answer it for a bundle that is not intact, such as a run with no seal, which never passes', async () => {
    const lines = await readLines();
    await writeLines(lines.slice(0, -1));
    const r = await verifyBundle(dir);
    expect(r.exitCode).toBe(1);
    expect(r.lines).toContain('1. Intact? NO');
    expect(r.lines).toContain("2. Does the result follow? not answered: the bundle is not intact, so its records can't answer it");
    expect(text(r.lines)).not.toContain('the seal (record');
  });

  it('does not answer it over a ledger the first question rejected, even when the seal agrees with the edited records', async () => {
    const lines = await readLines();
    lines[1] = lines[1]!.replace('alpha', 'omega');
    await writeLines(lines);
    const r = await verifyBundle(dir);
    expect(r.exitCode).toBe(1);
    expect(r.lines).toContain('1. Intact? NO');
    expect(r.lines).toContain("2. Does the result follow? not answered: the bundle is not intact, so its records can't answer it");
    expect(r.lines).not.toContain('2. Does the result follow? yes');
  });
});

describe('verify on a bundle that was changed', () => {
  it('fails when a ledger line is edited and still parses: names the ledger and the range the head covers', async () => {
    const lines = await readLines();
    lines[1] = lines[1]!.replace('alpha', 'omega');
    await writeLines(lines);
    const r = await verifyBundle(dir);
    expect(r.exitCode).toBe(1);
    expect(text(r.lines)).toContain('1. Intact? NO');
    expect(text(r.lines)).toMatch(/ledger\.jsonl: records 0 to 4 do not match the checkpoint root/);
  });

  it('fails when a ledger line is edited into one that cannot be read: names the record', async () => {
    const lines = await readLines();
    lines[2] = lines[2]!.replace('"verdict"', '"verdit"');
    await writeLines(lines);
    const r = await verifyBundle(dir);
    expect(r.exitCode).toBe(1);
    expect(text(r.lines)).toMatch(/ledger\.jsonl \(record 2\): the record type "verdit" is not known/);
  });

  it('fails when a blob is changed: names the blob file and the record that names it', async () => {
    const file = await blobFile();
    await writeFile(file, '<html>another page</html>');
    const r = await verifyBundle(dir);
    expect(r.exitCode).toBe(1);
    const out = text(r.lines);
    expect(out).toContain(path.basename(file));
    expect(out).toMatch(/blobs\/sha256\/[0-9a-f]{2}\/[0-9a-f]{62} \(record 1\)/);
    expect(out).toMatch(/does not match its digest/);
  });

  it('fails when a blob is removed', async () => {
    await rm(await blobFile());
    const r = await verifyBundle(dir);
    expect(r.exitCode).toBe(1);
    expect(text(r.lines)).toMatch(/\(record 1\): the blob "content": there is no blob/);
  });

  it('fails when lines are removed from the end, even with a checkpoint that was never updated', async () => {
    const lines = await readLines();
    await writeLines(lines.slice(0, 2));
    const r = await verifyBundle(dir);
    expect(r.exitCode).toBe(1);
    const out = text(r.lines);
    expect(out).toMatch(/the checkpoint covers 5 records and the ledger holds 2: records 2 to 4 are missing/);
    expect(out).toMatch(/no run\.seal/);
  });

  it('fails when only the seal line is removed, and says there is no seal', async () => {
    const lines = await readLines();
    await writeLines(lines.slice(0, 4));
    const r = await verifyBundle(dir);
    expect(r.exitCode).toBe(1);
    expect(text(r.lines)).toMatch(/no run\.seal/);
  });

  it('fails when the seal is removed and the checkpoint is made to match, which is still no seal', async () => {
    const lines = await readLines();
    const kept = lines.slice(0, 4);
    await writeLines(kept);
    await writeFile(path.join(dir, 'checkpoint'), independentCheckpoint('run-1', kept.join('\n') + '\n'));
    const r = await verifyBundle(dir);
    expect(r.exitCode).toBe(1);
    expect(text(r.lines)).toMatch(/ledger\.jsonl \(record 4\): there is no run\.seal/);
  });

  it('fails when the checkpoint is gone', async () => {
    await rm(path.join(dir, 'checkpoint'));
    const r = await verifyBundle(dir);
    expect(r.exitCode).toBe(1);
    expect(text(r.lines)).toMatch(/checkpoint: there is no checkpoint/);
  });

  it('reports a torn last line as torn, and not as tampering', async () => {
    const lines = await readLines();
    await writeFile(ledgerPath(), lines.slice(0, 2).join('\n') + '\n' + lines[2]!.slice(0, 20));
    await writeFile(
      path.join(dir, 'checkpoint'),
      independentCheckpoint('run-1', lines.slice(0, 2).join('\n') + '\n'),
    );
    const r = await verifyBundle(dir);
    expect(r.exitCode).toBe(1);
    const out = text(r.lines);
    expect(out).toMatch(/torn: record 2 is cut off after 20 bytes/);
    expect(out).toMatch(/no run\.seal/);
    expect(out).not.toMatch(/do not match the checkpoint root/);
  });
});

describe('verify on something that is not a bundle', () => {
  it('exits 2 for a folder that is not there', async () => {
    const r = await verifyBundle(path.join(tmp, 'no-such-folder'));
    expect(r.exitCode).toBe(2);
    expect(text(r.lines)).toMatch(/is not a folder/);
  });

  it('exits 1 for a folder with no ledger in it', async () => {
    const empty = await mkdtemp(path.join(tmp, 'empty-'));
    const r = await verifyBundle(empty);
    expect(r.exitCode).toBe(1);
    expect(text(r.lines)).toMatch(/ledger\.jsonl: there is no ledger/);
  });
});

describe('miqyas verify, the command', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('prints the report and returns the exit code, with no target, model or network', async () => {
    expect(await main(['verify', dir])).toBe(0);
    expect(out.join('')).toContain('1. Intact? yes');
    await rm(await blobFile());
    out.length = 0;
    expect(await main(['verify', dir])).toBe(1);
    expect(out.join('')).toContain('1. Intact? NO');
  });

  it('exits 2 without a bundle, and with more than one', async () => {
    expect(await main(['verify'])).toBe(2);
    expect(await main(['verify', dir, dir])).toBe(2);
  });

  it('is refused for options that belong to a run', async () => {
    expect(await main(['verify', dir, '--url', 'http://127.0.0.1:9/'])).toBe(2);
  });
});

describe('--proof-bundle belongs to run only', () => {
  it('is refused on any other command', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['lint', '--proof-bundle'])).toBe(2);
    expect(await main(['verify', dir, '--proof-bundle'])).toBe(2);
    vi.restoreAllMocks();
  });
});
