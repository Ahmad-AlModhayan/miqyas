// SPDX-License-Identifier: AGPL-3.0-only
// What the recorder writes once the scrubber has run (docs/FOUNDATION.md §3, "Safe to keep"). A record is content
// and structure. Content is what a target or a repository holds, or what a run was told: every string value and every
// object key, and it is scrubbed. Structure is what Miqyas itself names, and it is never scrubbed, because changing it
// would break the record: a fact's kind, version, collector (`by`), attempt (`run`), positions (`from`, `effect`), cause,
// blobs and the fields it names in `withheld`; and anywhere, a string that is a whole digest (sha256: or hmac-sha256:
// and 64 hex digits), which a short secret can match by chance. Scrubbing never makes two different values one: two
// strings of one list, or two keys of one object, that scrubbing makes equal are kept apart by "~2", "~3"... in the
// code-unit order of what they were, so the same values give the same text whatever order they come in.
import type { Json } from '../kernel/ledger.js';
import { type ScrubRules, findTerms, isTextMediaType, ruleHits, scrubText } from '../scrub/scrub.js';

/** What a record or a blob still held of a scrub rule once it was scrubbed: never the text, only the rule. */
export class ScrubRefused extends Error {
  constructor(what: string, hits: readonly string[]) {
    super(`${what} still holds what the scrub rules remove (${hits.join(', ')}), and is not written`);
    this.name = 'ScrubRefused';
  }
}

/** A digest the run computed: structure, whatever it happens to contain. */
const DIGEST = /^(sha256|hmac-sha256):[0-9a-f]{64}$/;

/** The fields of a fact that are structure. Its subject, origin, place and body are content. */
const FACT_STRUCTURE = new Set(['kind', 'v', 'by', 'run', 'from', 'effect', 'cause', 'blobs', 'withheld']);

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * How each of some distinct strings is written once scrubbed: as scrubbed, unless another of them scrubs to the same
 * text, in which case the second and later in code-unit order of the originals get "~2", "~3"..., never a text another
 * one already has.
 */
function apart(originals: readonly string[], rules: ScrubRules): Map<string, string> {
  const distinct = [...new Set(originals)].sort(byCodeUnit);
  const natural = new Map(distinct.map((s) => [s, scrubText(s, rules)]));
  const taken = new Set(natural.values());
  const claimed = new Set<string>();
  const out = new Map<string, string>();
  for (const s of distinct) {
    const scrubbed = natural.get(s) as string;
    let written = scrubbed;
    for (let n = 2; claimed.has(written); n++) {
      written = `${scrubbed}~${n}`;
      if (taken.has(written)) written = scrubbed;
    }
    claimed.add(written);
    out.set(s, written);
  }
  return out;
}

/** Scrubs a value's content, keeping its structure, and gathers the content as written for the re-scan. */
function scrubValue(value: Json, rules: ScrubRules, content: string[]): Json {
  if (typeof value === 'string') {
    if (DIGEST.test(value)) return value;
    const out = scrubText(value, rules);
    content.push(out);
    return out;
  }
  if (Array.isArray(value)) {
    const strings = value.filter((v): v is string => typeof v === 'string' && !DIGEST.test(v));
    const written = apart(strings, rules);
    return value.map((item) => {
      if (typeof item !== 'string' || DIGEST.test(item)) return scrubValue(item, rules, content);
      const out = written.get(item) as string;
      content.push(out);
      return out;
    });
  }
  if (value !== null && typeof value === 'object') {
    const keys = apart(Object.keys(value), rules);
    const out: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value)) {
      const name = keys.get(key) as string;
      content.push(name);
      out[name] = scrubValue(item as Json, rules, content);
    }
    return out;
  }
  return value;
}

/** Scrubs a record's body, then re-scans its content as it will be written. */
export function scrubbed(body: Json, rules: ScrubRules, what: string, isFact = false): Json {
  if (rules.terms.length === 0) return body;
  const content: string[] = [];
  let out: Json;
  if (isFact && body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const fact: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(body)) fact[key] = FACT_STRUCTURE.has(key) ? (item as Json) : scrubValue(item as Json, rules, content);
    out = fact;
  } else {
    out = scrubValue(body, rules, content);
  }
  const left = ruleHits(content.join('\n'), rules);
  if (left.length > 0) throw new ScrubRefused(what, left);
  return out;
}

/**
 * A blob's bytes as they may be stored. Text is scrubbed as UTF-8 and stored unchanged when nothing matched; bytes that
 * are not text can't be scrubbed without breaking them, so one that holds a term is refused.
 */
export function scrubbedBlob(bytes: Uint8Array, mediaType: string, rules: ScrubRules): Uint8Array {
  if (rules.terms.length === 0) return bytes;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (findTerms(text, rules).length === 0) return bytes;
  if (!isTextMediaType(mediaType)) throw new ScrubRefused(`a blob of type ${mediaType}`, ruleHits(text, rules));
  const out = scrubText(text, rules);
  const left = ruleHits(out, rules);
  if (left.length > 0) throw new ScrubRefused(`a blob of type ${mediaType}`, left);
  return new TextEncoder().encode(out);
}
