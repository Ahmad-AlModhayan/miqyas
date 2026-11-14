// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PlanLedger, type PlanResult } from '../../src/proof-core/ledger.js';
import { errorExit } from '../../src/entry/cli.js';
import { applyMutation, BuildChangedError, classify, cssMarker, hashDir, judgeProbe, keepUnchanged, MutationError, parsePreset, renderMutationMarkdown, summarize, type Mutation } from '../../src/proof-core/mutate.js';
import { parsePlan } from '../../src/proof-core/plan.js';

let tmp: string;
let build: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-mutate-'));
  build = path.join(tmp, 'build');
  await mkdir(path.join(build, 'assets'), { recursive: true });
  await writeFile(path.join(build, 'index.html'), '<html><head><title>x</title></head><body></body></html>');
  await writeFile(path.join(build, 'assets', 'index-abc.js'), 'const t={bin:"The recycle bin is empty."};const u="The recycle bin is empty.";');
  await writeFile(path.join(build, 'assets', 'mock-def.js'), 'export const x=1;');
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

const preset = parsePreset(JSON.parse(await readFile(new URL('../../presets/wasl-tray.json', import.meta.url), 'utf8')));
const byId = (id: string) => preset.mutations.find((m) => m.id === id)!;

describe('the wasl-tray preset', () => {
  it('has the four mutations of the TestSprite evaluation, each aimed at an assertion', () => {
    expect(preset.mutations.map((m) => [m.id, m.kind, m.plan, m.assertion])).toEqual([
      ['bin-text', 'string-swap', '01-navigation', 'a7'],
      ['field-error-hidden', 'css', '03-add-pair-validation', 'a2'],
      ['passphrase-error-hidden', 'css', '06-vault-unlock', 'a2'],
      ['rtl-flip', 'css', '07-language-arabic', 'a1'],
    ]);
    expect(preset.mutations.filter((m) => m.kind === 'css').map((m) => (m.kind === 'css' ? m.css : ''))).toEqual([
      '.field-error{display:none}',
      '.kf-field-error .kf-field-help{display:none}',
      'html[dir=rtl] body{direction:ltr}',
    ]);
  });

  it('rejects malformed presets', () => {
    expect(() => parsePreset({ name: 'x', mutations: [{ id: 'a', title: 't', plan: 'p', kind: 'css', css: 'x' }] })).toThrow(/probe/);
    expect(() => parsePreset({ name: 'x', mutations: [{ id: 'a', title: 't', plan: 'p', kind: 'zap' }] })).toThrow(/kind/);
    const css = { id: 'a', title: 't', plan: 'p', kind: 'css', css: 'x' };
    expect(() => parsePreset({ name: 'x', mutations: [{ ...css, probe: { measure: 'display' } }] })).toThrow(/"height" or "left"/);
    expect(() => parsePreset({ name: 'x', mutations: [{ ...css, probe: { measure: 'height' } }] })).toThrow(/selector/);
    expect(() => parsePreset({ name: 'x', mutations: [{ ...css, probe: { measure: 'left', selector: 'nav', steps: [3] } }] })).toThrow(/steps/);
    const swap = { id: 'a', title: 't', plan: 'p', kind: 'string-swap', from: 'a', to: 'b' };
    expect(() => parsePreset({ name: 'x', mutations: [swap] })).toThrow(/probe/);
    expect(() => parsePreset({ name: 'x', mutations: [{ ...swap, probe: { measure: 'height', selector: 'p' } }] })).toThrow(/"text"/);
  });

  it('measures what FR-M2 names: rendered text, a 0 px high element, the sidebar at x=0', () => {
    expect(byId('bin-text').probe).toMatchObject({ measure: 'text', steps: ['nav.side >> text=Recycle bin'] });
    expect(byId('field-error-hidden').probe).toMatchObject({ measure: 'height', selector: '#miqyas-probe' });
    expect(byId('passphrase-error-hidden').probe).toMatchObject({ measure: 'height', selector: '#miqyas-probe' });
    expect(byId('rtl-flip').probe).toEqual({ measure: 'left', selector: 'nav.side', rootAttrs: { dir: 'rtl' } });
  });
});

describe('judging probe readings', () => {
  it('CSS hide: effective only when the element is 0 px high or absent on the mutant and has height on the clean build', () => {
    const m = byId('field-error-hidden');
    expect(judgeProbe(m, 38, 0)).toEqual({ effective: true, detail: 'probe height of #miqyas-probe: clean 38 px, mutated 0 px' });
    expect(judgeProbe(m, 38, null).effective).toBe(true);
    expect(judgeProbe(m, 38, 38).effective).toBe(false);
    expect(judgeProbe(m, 0, 0).effective).toBe(false);
    expect(judgeProbe(m, null, null).effective).toBe(false);
  });
  it('RTL flip: effective only when the sidebar sits at x=0 on the mutant and not on the clean build', () => {
    const m = byId('rtl-flip');
    expect(judgeProbe(m, 1100, 0).effective).toBe(true);
    expect(judgeProbe(m, 0, 0).effective).toBe(false);
    expect(judgeProbe(m, 1100, 1100).effective).toBe(false);
    expect(judgeProbe(m, 1100, null).effective).toBe(false);
  });
  it('string swap: effective only when the new text renders, the old does not, and the clean build shows the old', () => {
    const m = byId('bin-text');
    expect(judgeProbe(m, 'Recycle bin\nThe recycle bin is empty', 'Recycle bin\nNothing to show here').effective).toBe(true);
    // Gone from the bundle is not enough: the screen must show it.
    expect(judgeProbe(m, 'Recycle bin\nThe recycle bin is empty', 'Recycle bin').effective).toBe(false);
    expect(judgeProbe(m, 'Folder pairs', 'Nothing to show here').effective).toBe(false);
    expect(judgeProbe(m, 'The recycle bin is empty', 'The recycle bin is empty. Nothing to show here').effective).toBe(false);
    // The old text inside the new one doesn't count as the old text still showing.
    const nested = { ...m, from: 'empty', to: 'not empty' } as Mutation;
    expect(judgeProbe(nested, 'Bin is empty', 'Bin is not empty').effective).toBe(true);
    expect(judgeProbe(nested, 'Bin is empty', 'Bin is not empty; trash is empty').effective).toBe(false);
  });
});

describe('the clean build stays unchanged (FR-M1)', () => {
  it('hashes paths and bytes, so any edit, addition or rename changes the hash', async () => {
    const dir = path.join(tmp, 'h');
    await mkdir(dir);
    await writeFile(path.join(dir, 'a.js'), 'x');
    const h = await hashDir(dir);
    expect(await hashDir(dir)).toBe(h);
    await writeFile(path.join(dir, 'a.js'), 'y');
    expect(await hashDir(dir)).not.toBe(h);
    await writeFile(path.join(dir, 'a.js'), 'x');
    expect(await hashDir(dir)).toBe(h);
    await writeFile(path.join(dir, 'b.js'), '');
    expect(await hashDir(dir)).not.toBe(h);
  });

  it('frames entries so contents cannot pose as other files, and sees empty folders and links', async () => {
    const one = path.join(tmp, 'h1');
    const two = path.join(tmp, 'h2');
    await mkdir(one);
    await mkdir(two);
    await writeFile(path.join(one, 'a'), 'X');
    await writeFile(path.join(one, 'b'), 'Y');
    await writeFile(path.join(two, 'a'), 'X\0b\0Y');
    expect(await hashDir(one)).not.toBe(await hashDir(two));
    const h = await hashDir(one);
    await mkdir(path.join(one, 'empty'));
    expect(await hashDir(one)).not.toBe(h);
    const withDir = await hashDir(one);
    await symlink(path.join(one, 'empty'), path.join(one, 'link'));
    expect(await hashDir(one)).not.toBe(withDir);
  });

  it('a change to the clean build during the run is an error with exit 3', async () => {
    expect(await keepUnchanged(build, async () => 'ok')).toBe('ok');
    const err = await keepUnchanged(build, () => writeFile(path.join(build, 'assets', 'mock-def.js'), 'export const x=2;')).catch((e: unknown) => e);
    await writeFile(path.join(build, 'assets', 'mock-def.js'), 'export const x=1;');
    expect(err).toBeInstanceOf(BuildChangedError);
    expect((err as Error).message).toMatch(/changed during the run/);
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => (written.push(String(c)), true));
    try {
      expect(errorExit(err)).toBe(3);
    } finally {
      spy.mockRestore();
    }
    // Mapped as an environment error: one line, no stack trace.
    expect(written.join('')).toMatch(/^miqyas: the clean build .* changed during the run .*\n$/);
  });

  it('reports the change even when the run also failed', async () => {
    const err = await keepUnchanged(build, async () => {
      await writeFile(path.join(build, 'assets', 'mock-def.js'), 'export const x=3;');
      throw new Error('browser crashed');
    }).catch((e: unknown) => e);
    await writeFile(path.join(build, 'assets', 'mock-def.js'), 'export const x=1;');
    expect(err).toBeInstanceOf(BuildChangedError);
    await expect(keepUnchanged(build, async () => Promise.reject(new Error('browser crashed')))).rejects.toThrow('browser crashed');
  });
});

describe('applying mutations to a copy of the build', () => {
  it('swaps every occurrence of a string and leaves the clean build untouched', async () => {
    const out = path.join(tmp, 'm1');
    const a = await applyMutation(byId('bin-text'), build, out);
    expect(a.detail).toContain('2 occurrence(s)');
    expect(a.files).toEqual([path.join('assets', 'index-abc.js')]);
    const mutated = await readFile(path.join(out, 'assets', 'index-abc.js'), 'utf8');
    expect(mutated).not.toContain('The recycle bin is empty');
    expect(mutated).toContain('Nothing to show here.');
    expect(await readFile(path.join(build, 'assets', 'index-abc.js'), 'utf8')).toContain('The recycle bin is empty');
  });

  it('injects CSS into index.html with a marker', async () => {
    const out = path.join(tmp, 'm2');
    await applyMutation(byId('rtl-flip'), build, out);
    const html = await readFile(path.join(out, 'index.html'), 'utf8');
    expect(html).toContain(`<style ${cssMarker('rtl-flip')}>html[dir=rtl] body{direction:ltr}</style></head>`);
    expect(await readFile(path.join(build, 'index.html'), 'utf8')).not.toContain('miqyas');
  });

  it('refuses a string swap whose text is not in the build', async () => {
    const m: Mutation = { id: 'x', title: 'x', plan: 'p', kind: 'string-swap', from: 'Not in there', to: 'y', probe: { measure: 'text' } };
    await expect(applyMutation(m, build, path.join(tmp, 'm3'))).rejects.toThrow(MutationError);
  });
});

function planResult(verdicts: Record<string, 'pass' | 'fail'>, error?: string): PlanResult {
  const ids = Object.keys(verdicts);
  const plan = parsePlan({ format: 'miqyas-plan', version: 1, id: '03', steps: ids.map((id) => ({ id, type: 'assertion', text: id })) }, '03');
  const l = new PlanLedger(plan);
  for (const id of ids) l.recordAssertion({ stepId: id, verdict: verdicts[id]!, method: 'ai', observation: `${id} ${verdicts[id]}` });
  if (error) l.fail(error);
  return l.close(1);
}

describe('classifying outcomes', () => {
  const m = { ...byId('field-error-hidden'), plan: '03' } as Mutation;
  const clean = planResult({ a1: 'pass', a2: 'pass', a3: 'pass' });

  it('detected: the targeted assertion failed', () => {
    const r = classify(m, true, clean, planResult({ a1: 'pass', a2: 'fail', a3: 'pass' }), 'd');
    expect(r).toMatchObject({ outcome: 'detected', caughtBy: ['a2'], observation: 'a2 fail' });
  });
  it('detected elsewhere: another assertion failed, counted apart', () => {
    expect(classify(m, true, clean, planResult({ a1: 'fail', a2: 'pass', a3: 'pass' }), 'd').outcome).toBe('detected_elsewhere');
  });
  it('missed: the plan passed on a broken build (TestSprite on plan 03)', () => {
    expect(classify(m, true, clean, clean, 'd').outcome).toBe('missed');
  });
  it('inconclusive when the plan fails on the clean build; ineffective when the probe shows no change', () => {
    expect(classify(m, true, planResult({ a1: 'fail', a2: 'pass', a3: 'pass' }), clean, 'd').outcome).toBe('inconclusive');
    expect(classify(m, false, clean, clean, 'd').outcome).toBe('ineffective');
  });
  it('error when the mutated run errored before the target failed', () => {
    expect(classify(m, true, clean, planResult({ a1: 'pass', a2: 'pass', a3: 'pass' }, 'model error'), 'd').outcome).toBe('error');
  });

  it('computes the rate over effective, conclusive mutations only', () => {
    const s = summarize('wasl-tray', [
      classify(m, true, clean, planResult({ a1: 'pass', a2: 'fail', a3: 'pass' }), ''),
      classify(m, true, clean, planResult({ a1: 'pass', a2: 'fail', a3: 'pass' }), ''),
      classify(m, true, clean, planResult({ a1: 'fail', a2: 'pass', a3: 'pass' }), ''),
      classify(m, true, clean, clean, ''),
      classify(m, false, clean, clean, ''),
    ]);
    expect(s).toMatchObject({ valid: 4, detected: 2, detectedElsewhere: 1, rate: 0.5 });
  });

  it('scores like Stryker: a run error and an inconclusive mutant are excluded, and the report says how many', () => {
    const results = [
      classify(m, true, clean, planResult({ a1: 'pass', a2: 'fail', a3: 'pass' }), ''),
      classify(m, true, clean, planResult({ a1: 'pass', a2: 'pass', a3: 'pass' }, 'model error'), ''),
      classify(m, true, planResult({ a1: 'fail', a2: 'pass', a3: 'pass' }), clean, ''),
    ];
    const s = summarize('wasl-tray', results);
    expect(s).toMatchObject({ valid: 1, detected: 1, rate: 1, excluded: { error: 1, inconclusive: 1 } });
    expect(renderMutationMarkdown(s, { runId: 'r', dryRun: false })).toContain('**Detection rate: 1 of 1 valid (100 %)** by the targeted assertion; excluded: 1 error, 1 inconclusive.');
  });

  it('prints the baseline line only when the preset has one', () => {
    expect(preset.baseline).toEqual({ tool: 'TestSprite', detected: 3, of: 4, source: 'the TestSprite evaluation on Wasl, 2026-10-28' });
    const results = [classify(m, true, clean, planResult({ a1: 'pass', a2: 'fail', a3: 'pass' }), '')];
    const withBaseline = summarize('wasl-tray', results, preset.baseline);
    expect(withBaseline.baseline).toEqual(preset.baseline);
    expect(renderMutationMarkdown(withBaseline, { runId: 'r', dryRun: false })).toContain('**Detection rate: 1 of 1 valid (100 %)** by the targeted assertion. TestSprite on the same mutations: 3 of 4 (the TestSprite evaluation on Wasl, 2026-10-28).');
    const none = renderMutationMarkdown(summarize('other', results), { runId: 'r', dryRun: false });
    expect(none).toContain('by the targeted assertion.\n');
    expect(none).not.toContain('TestSprite');
    expect(() => parsePreset({ name: 'x', baseline: { tool: 'T', detected: 5, of: 4, source: 's' }, mutations: [] })).toThrow(/baseline/);
    expect(() => parsePreset({ name: 'x', baseline: { tool: 'T', detected: 1, of: 4 }, mutations: [] })).toThrow(/baseline/);
  });

  it('reports a mutation whose probe failed as not effective, outside the rate', () => {
    const s = summarize('wasl-tray', [classify(m, true, clean, planResult({ a1: 'pass', a2: 'fail', a3: 'pass' }), ''), classify(m, false, clean, undefined, 'probe saw no change')]);
    expect(s).toMatchObject({ valid: 1, detected: 1, rate: 1 });
    const md = renderMutationMarkdown(s, { runId: 'r', dryRun: false });
    expect(md).toContain('Detection rate: 1 of 1 valid (100 %)** by the targeted assertion; excluded: 1 not effective.');
    expect(md).toContain('1 mutation(s) not effective');
    expect(md).toMatch(/\| not effective \|/);
  });
});
