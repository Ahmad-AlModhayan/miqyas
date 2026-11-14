// SPDX-License-Identifier: Apache-2.0
// Scrubber: replaces configured terms (organisation, project and person names) in text sent to a model and in
// served bundles, then re-scans. Unicode-aware: patterns are matched as JavaScript strings over UTF-8-decoded text,
// so Arabic terms work (the perl scrub in the Wasl log missed «هاتف فلان» without -Mutf8).

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ScrubTerm {
  from: string;
  to: string;
  /** Match only where no letter, mark, digit or underscore touches it (used for short secret values). */
  whole?: boolean;
}

export interface ScrubRules {
  terms: ScrubTerm[];
  /** Match Latin terms regardless of case (default true). */
  ignoreCase?: boolean;
}

export const NO_SCRUB: ScrubRules = { terms: [] };

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest terms first, so "06-adhan-engine.md" is replaced before "adhan". */
function ordered(rules: ScrubRules): ScrubTerm[] {
  return [...rules.terms].sort((a, b) => b.from.length - a.from.length);
}

function source(t: ScrubTerm): string {
  const s = escape(t.from.normalize('NFC'));
  return t.whole ? `(?<![\\p{L}\\p{M}\\p{N}_])${s}(?![\\p{L}\\p{M}\\p{N}_])` : s;
}

function pattern(t: ScrubTerm, ignoreCase: boolean): RegExp {
  return new RegExp(source(t), ignoreCase ? 'giu' : 'gu');
}

export function scrubText(text: string, rules: ScrubRules): string {
  if (rules.terms.length === 0) return text;
  let out = text;
  for (const t of ordered(rules)) out = out.replace(pattern(t, rules.ignoreCase ?? true), () => t.to);
  return out;
}

/** Every remaining occurrence of a term (the re-scan; it must find nothing). */
export function findTerms(text: string, rules: ScrubRules): { term: string; count: number }[] {
  const hits: { term: string; count: number }[] = [];
  for (const t of rules.terms) {
    const n = text.match(pattern(t, rules.ignoreCase ?? true))?.length ?? 0;
    if (n > 0) hits.push({ term: t.from, count: n });
  }
  return hits;
}

/** The re-scan before text leaves the machine: each rule that still matches, named by number and replacement, never
 * by the matched text (a secret's rule is named by its placeholder). */
export function ruleHits(text: string, rules: ScrubRules): string[] {
  return rules.terms.flatMap((t, i) => (pattern(t, rules.ignoreCase ?? true).test(text) ? [`rule ${i + 1} (to "${t.to}")`] : []));
}

/** One pattern for every term, matched as `scrubText` matches them; used to find secret values on the page. */
export function anyTerm(rules: ScrubRules): RegExp | undefined {
  if (rules.terms.length === 0) return undefined;
  return new RegExp(rules.terms.map(source).join('|'), (rules.ignoreCase ?? true) ? 'iu' : 'u');
}

/** Page text as the model reads it: a JSON string, with every control and line separator escaped too, so a quote,
 * newline or U+2028 in the page can't end its field or its line in the snapshot. */
export function jsonQuote(s: string): string {
  return JSON.stringify(s).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A value as typed, as a URL carries it (percent-encoded, and form-encoded: a GET form, spaces as +), and as the
 * snapshot quotes it. */
function encodings(v: string): string[] {
  const uri = encodeURIComponent(v);
  const form = uri.replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');
  return [...new Set([v, uri, form, jsonQuote(v).slice(1, -1)])];
}

/** One plan's rules: the configured terms, plus each secret's value (also URL-encoded) scrubbed back to its
 * placeholder, whatever its length. A value shorter than 3 characters matches only as a whole value, so "ab" doesn't
 * eat into "about"; longer values match anywhere, so a secret run into other text still never reaches the model. */
export function withSecrets(rules: ScrubRules, names: string[], env: Record<string, string | undefined>): ScrubRules {
  const secrets = names.flatMap((name) => {
    const v = env[`MIQYAS_SECRET_${name}`] ?? '';
    const whole = v.length < 3;
    return v ? encodings(v).map((from): ScrubTerm => ({ from, to: `\${secret.${name}}`, ...(whole ? { whole } : {}) })) : [];
  });
  return { ...rules, terms: [...rules.terms, ...secrets] };
}

export function parseScrubRules(raw: unknown, where = 'scrub rules'): ScrubRules {
  const obj = raw as { terms?: unknown; ignoreCase?: unknown };
  if (typeof obj !== 'object' || obj === null || !Array.isArray(obj.terms)) throw new Error(`${where}: expected {"terms": [{"from", "to"}]}`);
  const terms = obj.terms.map((t, i) => {
    const term = t as { from?: unknown; to?: unknown };
    if (typeof term.from !== 'string' || !term.from || typeof term.to !== 'string')
      throw new Error(`${where}: terms[${i}] needs a non-empty "from" and a "to"`);
    return { from: term.from, to: term.to };
  });
  const rules: ScrubRules = { terms };
  if (typeof obj.ignoreCase === 'boolean') rules.ignoreCase = obj.ignoreCase;
  return rules;
}

export async function loadScrubRules(file: string): Promise<ScrubRules> {
  return parseScrubRules(JSON.parse(await readFile(file, 'utf8')), file);
}

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.htm', '.json', '.map', '.svg', '.txt', '.webmanifest']);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walk(p)));
    else if (TEXT_EXT.has(path.extname(d.name).toLowerCase())) out.push(p);
  }
  return out;
}

export interface ScrubDirResult {
  filesChanged: string[];
  replaced: number;
  /** Re-scan after scrubbing: must be empty. */
  remaining: { file: string; term: string; count: number }[];
}

/** Scrub every text file under `dir` in place, then re-scan. `dryRun` only scans. */
export async function scrubDir(dir: string, rules: ScrubRules, dryRun = false): Promise<ScrubDirResult> {
  const result: ScrubDirResult = { filesChanged: [], replaced: 0, remaining: [] };
  for (const file of await walk(dir)) {
    const before = await readFile(file, 'utf8');
    const hits = findTerms(before, rules);
    if (hits.length && !dryRun) {
      const after = scrubText(before, rules);
      await writeFile(file, after, 'utf8');
      result.filesChanged.push(file);
      result.replaced += hits.reduce((n, h) => n + h.count, 0);
    }
    const left = findTerms(dryRun ? before : await readFile(file, 'utf8'), rules);
    for (const h of left) result.remaining.push({ file, ...h });
  }
  return result;
}
