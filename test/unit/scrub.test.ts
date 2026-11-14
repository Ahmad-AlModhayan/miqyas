// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { anyTerm, findTerms, jsonQuote, loadScrubRules, NO_SCRUB, parseScrubRules, ruleHits, scrubDir, scrubText, withSecrets } from '../../src/scrub/scrub.js';

const rules = await loadScrubRules(new URL('../../presets/wasl-scrub.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

describe('scrubber', () => {
  it('replaces the Wasl terms, longest first, including the Arabic name', () => {
    const before = 'KahfLabs: mizwala/docs, qasd/docs, 06-adhan-engine.md, adhan; device «هاتف فلان»; kahflabs.com';
    const after = scrubText(before, rules);
    expect(after).toBe('Example Org: project-a/docs, project-b/docs, engine-notes.md, engine; device «هاتفي»; Example Org.com');
    expect(findTerms(after, rules)).toEqual([]);
  });

  it('re-scan reports what is left', () => {
    expect(findTerms('qasd and QASD and هاتف فلان', rules)).toEqual([
      { term: 'qasd', count: 2 },
      { term: 'هاتف فلان', count: 1 },
    ]);
  });

  it('respects ignoreCase: false', () => {
    const r = parseScrubRules({ ignoreCase: false, terms: [{ from: 'Wasl', to: 'App' }] });
    expect(scrubText('Wasl wasl', r)).toBe('App wasl');
  });

  it('treats regex characters literally', () => {
    expect(scrubText('a.b axb', parseScrubRules({ terms: [{ from: 'a.b', to: 'X' }] }))).toBe('X axb');
  });

  it('scrubs a built app in place and re-scans to zero', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-scrub-'));
    try {
      await writeFile(path.join(dir, 'mock.js'), 'const d={name:"هاتف فلان",org:"KahfLabs"};', 'utf8');
      await writeFile(path.join(dir, 'font.woff2'), 'KahfLabs');
      const dry = await scrubDir(dir, rules, true);
      expect(dry.remaining.map((r) => r.term).sort()).toEqual(['KahfLabs', 'هاتف فلان'].sort());
      const r = await scrubDir(dir, rules);
      expect(r).toMatchObject({ replaced: 2, remaining: [] });
      expect(await readFile(path.join(dir, 'mock.js'), 'utf8')).toBe('const d={name:"هاتفي",org:"Example Org"};');
      expect(await readFile(path.join(dir, 'font.woff2'), 'utf8')).toBe('KahfLabs');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scrubs a secret back to its placeholder whatever its length; a short one only as a whole value', () => {
    const short = withSecrets(NO_SCRUB, ['PIN', 'PASS', 'HA'], { MIQYAS_SECRET_PIN: '7', MIQYAS_SECRET_PASS: 'ab', MIQYAS_SECRET_HA: 'أ' });
    expect(scrubText('PIN 7, step 17, about ab. AB', short)).toBe('PIN ${secret.PIN}, step 17, about ${secret.PASS}. ${secret.PASS}');
    expect(scrubText('/search?pin=7&q=ab', short)).toBe('/search?pin=${secret.PIN}&q=${secret.PASS}');
    expect(scrubText('سعيد أ', short)).toBe('سعيد ${secret.HA}');
    // The re-scan and the on-page mask match the same way: no false hit inside a longer word or number.
    expect(ruleHits('step 17, about سعيد', short)).toEqual([]);
    expect(anyTerm(short)!.test('step 17, about سعيد')).toBe(false);
    expect(anyTerm(short)!.test('code: 7')).toBe(true);
    // Longer values still match anywhere: a secret run into other text must not reach the model.
    expect(scrubText('xhunter2x', withSecrets(NO_SCRUB, ['P'], { MIQYAS_SECRET_P: 'hunter2' }))).toBe('x${secret.P}x');
    // A value with a quote or backslash, as the snapshot quotes it (a JSON string), still scrubs.
    const quoted = withSecrets(NO_SCRUB, ['Q'], { MIQYAS_SECRET_Q: 'pa"ss\\w0rd' });
    expect(scrubText(`c2e3 textbox "Password" [value=${jsonQuote('pa"ss\\w0rd')}]`, quoted)).toBe('c2e3 textbox "Password" [value="${secret.Q}"]');
    // A set but empty value has nothing to scrub.
    expect(withSecrets(NO_SCRUB, ['E'], { MIQYAS_SECRET_E: '' }).terms).toEqual([]);
  });

  it('rejects malformed rules', () => {
    expect(() => parseScrubRules({ terms: [{ from: '', to: 'x' }] })).toThrow();
    expect(() => parseScrubRules({})).toThrow();
  });
});
