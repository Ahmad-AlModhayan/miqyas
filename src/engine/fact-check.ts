// SPDX-License-Identifier: AGPL-3.0-only
// Checking a fact against the schema of its kind (docs/FOUNDATION.md §3), before it is recorded. The schemas are data
// in the protocol layer; this compiles each one once, with Ajv, and answers ok or a refusal that names the kind and
// the field. Ajv stays here and out of the kernel, which takes no library but the CEL one (docs/FOUNDATION.md §14).
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { FACT_KINDS, factKind, factSchema, isKnownKind } from '../protocol/facts.js';

export type FactCheck = { ok: true } | { ok: false; kind: string; field: string; message: string };

/** A fact that does not match the schema of its kind: it names the kind and the field. */
export class FactRefused extends Error {
  constructor(
    readonly kind: string,
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'FactRefused';
  }
}

// strict: a schema with a keyword Ajv doesn't know, or one that can't apply, fails to compile instead of being
// ignored. The conditions of a kind (if, then) name required fields their parent schema defines, so strictRequired,
// which would ask each to define them again, is off. Formats stay annotations, as they are for the report schemas.
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: false, validateFormats: false });
const compiled = new Map<string, ValidateFunction>(FACT_KINDS.map((k) => [`${k.kind}@${k.v}`, ajv.compile(factSchema(k))]));

/** The field an error is about, as a dotted path from the fact: "body.package.version", "cause", "blobs.nodes". */
function fieldOf(error: ErrorObject): string {
  const parts = error.instancePath
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  const params = error.params as { missingProperty?: string; additionalProperty?: string };
  if (error.keyword === 'required' && params.missingProperty !== undefined) parts.push(params.missingProperty);
  if (error.keyword === 'additionalProperties' && params.additionalProperty !== undefined) parts.push(params.additionalProperty);
  return parts.join('.');
}

function refused(kind: string, field: string, why: string): FactCheck {
  const where = field === '' ? '' : ` at ${field}`;
  return { ok: false, kind, field, message: `a fact of kind ${JSON.stringify(kind)} does not match its schema${where}: ${why}` };
}

/** Checks a fact, envelope and body, against the schema of its kind and version. */
export function checkFact(fact: unknown): FactCheck {
  if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) return refused('', '', 'it is not an object');
  const { kind, v } = fact as { kind?: unknown; v?: unknown };
  if (typeof kind !== 'string' || !isKnownKind(kind)) return refused(String(kind), 'kind', 'no schema is known for this kind');
  const k = typeof v === 'number' ? factKind(kind, v) : undefined;
  if (k === undefined) return refused(kind, 'v', `no schema is known for version ${JSON.stringify(v)} of this kind`);
  // A schema reads a field through the prototype, and a record writes only the object's own fields: an object that is
  // not a plain one is refused here, so that the refusal names the kind and the field and not the ledger writer.
  const notPlain = notPlainAt(fact, []);
  if (notPlain !== undefined) return refused(kind, notPlain, 'must be a plain object or array, as JSON holds it');
  const validate = compiled.get(`${k.kind}@${k.v}`) as ValidateFunction;
  if (!validate(fact)) {
    const error = (validate.errors ?? [])[0];
    if (error === undefined) return refused(kind, '', 'it does not validate');
    return refused(kind, fieldOf(error), error.message ?? error.keyword);
  }
  const minusZero = minusZeroAt(fact, []);
  if (minusZero !== undefined) return refused(kind, minusZero, 'must not be minus zero, which a record cannot hold');
  const unsaid = withheldProblem(fact as { body: unknown; withheld?: readonly string[] });
  if (unsaid !== undefined) return refused(kind, unsaid.field, unsaid.why);
  return { ok: true };
}

/** A value a fact holds in place of one that must not be kept (docs/FOUNDATION.md §3): it says why, and its digest is keyed. */
function isWithheldValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { why, digest } = value as { why?: unknown; digest?: unknown };
  return typeof why === 'string' && typeof digest === 'string' && digest.startsWith('hmac-sha256:');
}

/** The dotted path from the body of each withheld value it holds. A list adds no name: its items share its path. */
function withheldValuesAt(value: unknown, path: readonly string[], out: string[]): string[] {
  if (isWithheldValue(value)) out.push(path.join('.'));
  else if (Array.isArray(value)) for (const item of value) withheldValuesAt(item, path, out);
  else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) withheldValuesAt(item, [...path, key], out);
  return out;
}

/** Whether the body holds a field at a dotted path, reading through lists. */
function holdsField(body: unknown, path: string): boolean {
  let here: unknown[] = [body];
  for (const name of path.split('.')) {
    here = here
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object' && Object.hasOwn(v, name))
      .map((v) => v[name]);
    if (here.length === 0) return false;
  }
  return true;
}

/**
 * What `withheld` fails to say: a withheld value at a path it does not name, or a path it names that the body does not
 * hold. A path it names may hold a plain value, which rests on one the collector did not keep (check 13's severity).
 */
function withheldProblem(fact: { body: unknown; withheld?: readonly string[] }): { field: string; why: string } | undefined {
  const named = fact.withheld ?? [];
  for (const at of withheldValuesAt(fact.body, [], [])) {
    if (!named.includes(at)) return { field: `body.${at}`, why: `holds a withheld value, and withheld does not name ${JSON.stringify(at)}` };
  }
  for (const at of named) {
    if (!holdsField(fact.body, at)) return { field: 'withheld', why: `names ${JSON.stringify(at)}, a field the body does not hold` };
  }
  return undefined;
}

/**
 * The first field that holds minus zero, as a dotted path, or undefined. A schema can't tell it from 0, and JSON writes
 * it as 0, so the ledger refuses it; it is refused here first, so that the refusal names the kind and the field.
 */
function minusZeroAt(value: unknown, path: string[]): string | undefined {
  if (Object.is(value, -0)) return path.join('.');
  if (value === null || typeof value !== 'object') return undefined;
  for (const [key, item] of Object.entries(value)) {
    const found = minusZeroAt(item, [...path, key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The first object that is neither a plain object nor an array, as a dotted path, or undefined. */
function notPlainAt(value: unknown, path: string[]): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const proto = Object.getPrototypeOf(value) as unknown;
  if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return path.join('.');
  for (const [key, item] of Object.entries(value)) {
    const found = notPlainAt(item, [...path, key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Throws FactRefused unless the fact matches its schema. */
export function assertFact(fact: unknown): void {
  const result = checkFact(fact);
  if (!result.ok) throw new FactRefused(result.kind, result.field, result.message);
}
