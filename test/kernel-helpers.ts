// SPDX-License-Identifier: AGPL-3.0-only
// What the tests hand the kernel: SHA-256 from node:crypto, a store that keeps files in memory under a root, and the
// small claims and facts the judge's tests share.
import { createHash } from 'node:crypto';
import { loadClaim } from '../src/kernel/claim.js';
import type { Fact, PlacedFact } from '../src/kernel/fact.js';
import { type JudgeInput, type LoadedClaim, type Quantifier, type Verdict, judgeClaim } from '../src/kernel/judge.js';
import type { Json } from '../src/kernel/ledger.js';
import type { Sha256, Store } from '../src/kernel/store.js';

export const sha256: Sha256 = async (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

/** A fact as a test gives it: what a rule reads, the rest taking the plainest value when it is placed. */
export type Given = { kind: string; by: string; body: Json; from?: number[]; withheld?: string[]; subject?: string; run?: number };

/** An item inside a test claim: `w` is what `where` reads, `u` what `usable` reads, `v` what `holds` reads. */
export const item = (v: Json, more: { [k: string]: Json } = {}): Given => ({ kind: 't.item', by: 'c@1', body: { v, w: true, u: 1, ...more } });
/** The `collection` fact of collector `c@1`, which a test claim's `covered` reads. */
export const done = (status = 'complete'): Given => ({ kind: 'collection', by: 'c@1', body: { status } });

/** Places facts at ledger positions `start`, `start + 1` and so on, about the subject `s`. */
export const place = (given: readonly Given[], start = 1): PlacedFact[] =>
  given.map((g, i) => ({ seq: start + i, fact: { v: 1, run: 1, subject: 's', ...g } as Fact }));

/**
 * A `set` claim file over `t.item` items, its `holds` being `item.v > 5` and its `count` `n >= 2`, carrying the three
 * examples every claim file must (ADR 0014): `fail` and `pass` beside a complete collection, and a failed collection.
 * An example gives the inputs its claim needs, as a run would. `extra` adds or replaces keys.
 */
export function setClaimFile(quantifier: Quantifier, examples: { fail: Given[]; pass: Given[] }, extra: Record<string, unknown> = {}) {
  const needed = ((extra.needs as { inputs?: string[] } | undefined)?.inputs ?? []).map((name) => [name, 'given']);
  const inputs = needed.length > 0 ? { inputs: Object.fromEntries(needed) } : {};
  return {
    id: `test.${quantifier}`,
    version: 1,
    title: `a ${quantifier} claim`,
    view: { kinds: ['t.item', 'collection'] },
    shape: 'set',
    quantifier,
    from: 't.item',
    ...(quantifier === 'count' ? { count: 'n >= 2' } : { holds: 'item.v > 5' }),
    covered: 'ctx.collections["c@1"].status == "complete"',
    examples: [
      { name: 'fails', expect: 'fail', facts: [...examples.fail, done()], ...inputs },
      { name: 'passes', expect: 'pass', facts: [...examples.pass, done()], ...inputs },
      { name: 'not collected', expect: 'not_checked', facts: [done('failed')], ...inputs },
    ],
    ...extra,
  };
}

/** An item on one side of a test pair claim: `k` is what the key reads, `v` what `holds` reads, `w` and `u` as above. */
export const side = (kind: 't.left' | 't.right', k: Json, v: Json, more: { [k: string]: Json } = {}): Given => ({
  kind,
  by: 'c@1',
  body: { k, v, w: true, u: 1, ...more },
});
export const leftItem = (k: Json, v: Json, more?: { [k: string]: Json }) => side('t.left', k, v, more);
export const rightItem = (k: Json, v: Json, more?: { [k: string]: Json }) => side('t.right', k, v, more);

/**
 * A `pair` claim file joining `t.left` and `t.right` items on `k`, its `holds` being `left.v == right.v`, with the three
 * examples every claim file must carry. `extra` adds or replaces keys.
 */
export function pairClaimFile(quantifier: Exclude<Quantifier, 'count'>, examples: { fail: Given[]; pass: Given[] }, extra: Record<string, unknown> = {}) {
  return {
    id: `test.pair.${quantifier}`,
    version: 1,
    title: `a ${quantifier} pair claim`,
    view: { kinds: ['t.left', 't.right', 'collection'] },
    shape: 'pair',
    quantifier,
    left: { from: 't.left' },
    right: { from: 't.right' },
    on: ['item.k', 'item.k'],
    holds: 'left.v == right.v',
    covered: 'ctx.collections["c@1"].status == "complete"',
    examples: [
      { name: 'fails', expect: 'fail', facts: [...examples.fail, done()] },
      { name: 'passes', expect: 'pass', facts: [...examples.pass, done()] },
      { name: 'not collected', expect: 'not_checked', facts: [done('failed')] },
    ],
    ...extra,
  };
}

export const loadFile = (file: unknown): Promise<LoadedClaim> => loadClaim(utf8(JSON.stringify(file)), sha256);

/** Judges a loaded claim over placed facts about the subject `s`. */
export const judge = (loaded: LoadedClaim, facts: PlacedFact[], more: Partial<JudgeInput> = {}): Verdict =>
  judgeClaim(loaded, { subject: 's', facts, ...more });

/**
 * The checkpoint text over a ledger's complete lines, computed here and not with the kernel: RFC 9162 section 2.1.1
 * written directly (a leaf is SHA-256(0x00 ‖ line), a node SHA-256(0x01 ‖ left ‖ right), split at the largest power
 * of two below the count, the empty tree SHA-256 of nothing). Tests use it to make a tampered ledger's checkpoint
 * match, so that only the check under test can catch the tampering.
 */
export function independentCheckpoint(origin: string, ledger: string): string {
  const bytes = Buffer.from(ledger, 'utf8');
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      lines.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  const hash = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
  const root = (leaves: Buffer[]): Buffer => {
    if (leaves.length === 0) return hash();
    if (leaves.length === 1) return hash(Buffer.from([0x00]), leaves[0] as Buffer);
    let k = 1;
    while (k * 2 < leaves.length) k *= 2;
    return hash(Buffer.from([0x01]), root(leaves.slice(0, k)), root(leaves.slice(k)));
  };
  return `${origin}\n${lines.length}\n${root(lines).toString('base64')}\n`;
}

/**
 * The `collection` fact that closes a collector run (docs/FOUNDATION.md §3), as a test writes it: complete with
 * nothing dropped unless it says otherwise, and with a reason whenever it is not complete.
 */
export function collectionFact(close: {
  by: string;
  run?: number;
  subject: string;
  setOut: string;
  counts: { [name: string]: number };
  status?: 'complete' | 'partial' | 'failed';
  reason?: string;
  dropped?: number;
}): { kind: string; v: number; by: string; run: number; subject: string; body: { [field: string]: string | number | { [name: string]: number } } } {
  const { by, run = 1, subject, setOut, counts, status = 'complete', dropped = 0 } = close;
  const reason = close.reason ?? (status === 'complete' ? undefined : 'stopped');
  return { kind: 'collection', v: 1, by, run, subject, body: { setOut, status, ...(reason === undefined ? {} : { reason }), counts, dropped } };
}

/** A store held in memory. Every path is kept under `root`, as a folder on disk would keep it. */
export class MemoryStore implements Store {
  readonly files = new Map<string, Uint8Array>();
  constructor(readonly root = 'runs/a') {}

  private key(path: string): string {
    return `${this.root}/${path}`;
  }
  async read(path: string): Promise<Uint8Array | undefined> {
    const bytes = this.files.get(this.key(path));
    return bytes && new Uint8Array(bytes);
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(this.key(path), new Uint8Array(bytes));
  }
  async append(path: string, bytes: Uint8Array): Promise<void> {
    const before = this.files.get(this.key(path)) ?? new Uint8Array();
    const after = new Uint8Array(before.length + bytes.length);
    after.set(before);
    after.set(bytes, before.length);
    this.files.set(this.key(path), after);
  }

  /** The same bytes under another root, as a bundle copied to another folder. */
  copyTo(root: string): MemoryStore {
    const copy = new MemoryStore(root);
    for (const [key, bytes] of this.files) copy.files.set(root + key.slice(this.root.length), new Uint8Array(bytes));
    return copy;
  }

  /** Test-only access to a file's text, for tampering. */
  textOf(path: string): string {
    return text(this.files.get(this.key(path)));
  }
  setText(path: string, value: string): void {
    this.files.set(this.key(path), utf8(value));
  }
}
