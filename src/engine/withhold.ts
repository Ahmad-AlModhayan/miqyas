// SPDX-License-Identifier: AGPL-3.0-only
// Withholding a value that must not be kept (docs/FOUNDATION.md §3, "Safe to keep"; docs/ALGORITHMS.md L2): a row's
// contents, an id a test account owns, a secret, a body. It is recorded as its shape, its count and a keyed digest,
// HMAC-SHA-256 under the key of this run, so that two values can be compared for equality, within the run and when
// re-judging its bundle, and neither can be read. The keyed hash is handed in, with its key inside it: the key is made
// for the run by the entry point and thrown away at its end, and nothing here holds a key, a clock or randomness.
import type { Json } from '../kernel/ledger.js';
import type { WithheldReason } from '../protocol/facts.js';

/** HMAC-SHA-256 of some bytes under the run's key. */
export type KeyedHash = (bytes: Uint8Array) => Promise<Uint8Array>;

/** A value withheld, as a fact's body holds it in place of the value. A body of bytes also says its size. */
export type WithheldValue = {
  why: WithheldReason;
  shape: string;
  count: number;
  digest: string;
  size?: number;
};

/** The value written the one way (docs/ALGORITHMS.md L2, `normalise`): JSON, the fields of each object in name order. */
export function normalise(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(normalise).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${normalise((value as { [k: string]: Json })[k] as Json)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * How a caller withholds a value. `fieldNames: 'schema'` says the names of its objects' fields are a schema's names,
 * fixed by the code that reads them, and not values: only then does the shape keep them.
 */
export interface WithholdOptions {
  fieldNames?: 'schema';
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The shape of a value: its type; for a list the shapes of its items, each once; for an object the shape of each field.
 * No value is kept, and no field name unless the caller says the names are a schema's: a row keyed by its own values
 * would put them in the shape. Without the names an object's shape is its fields' shapes in code-unit order, one per
 * field; with them, each field as name:shape in name order (a row is its columns in name order, ALGORITHMS L2).
 */
export function shapeOf(value: Json, options: WithholdOptions = {}): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${[...new Set(value.map((v) => shapeOf(v, options)))].sort(byCodeUnit).join('|')}]`;
  if (typeof value === 'object') {
    const fields = Object.entries(value).map(([k, v]) => [k, shapeOf(v as Json, options)] as const);
    if (options.fieldNames !== 'schema') return `{${fields.map(([, s]) => s).sort(byCodeUnit).join(',')}}`;
    return `{${fields
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([k, s]) => `${k}:${s}`)
      .join(',')}}`;
  }
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** How much a value holds: the characters of a text, the items of a list, the fields of an object; 1 for the rest. */
function countOf(value: Json): number {
  if (typeof value === 'string') return [...value].length;
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === 'object') return Object.keys(value).length;
  return 1;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const utf8 = (text: string) => new TextEncoder().encode(text);

/** The value a body of bytes holds, when it is JSON in UTF-8. */
function jsonIn(bytes: Uint8Array): { value: Json } | undefined {
  try {
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Json };
  } catch {
    return undefined;
  }
}

/**
 * Withholds a value: a JSON value, or a body of bytes. A body that is JSON is withheld as the value it holds, so that
 * two bodies that differ only in spacing or field order compare equal; other bytes as bytes, counted in bytes.
 */
export async function withhold(value: Json | Uint8Array, why: WithheldReason, hmac: KeyedHash, options: WithholdOptions = {}): Promise<WithheldValue> {
  const digest = async (bytes: Uint8Array) => `hmac-sha256:${hex(await hmac(bytes))}`;
  if (!(value instanceof Uint8Array)) return { why, shape: shapeOf(value, options), count: countOf(value), digest: await digest(utf8(normalise(value))) };
  const json = jsonIn(value);
  if (json === undefined) return { why, shape: 'bytes', count: value.length, size: value.length, digest: await digest(value) };
  return { why, shape: shapeOf(json.value, options), count: countOf(json.value), size: value.length, digest: await digest(utf8(normalise(json.value))) };
}
