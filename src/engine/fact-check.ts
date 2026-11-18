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
  const validate = compiled.get(`${k.kind}@${k.v}`) as ValidateFunction;
  if (!validate(fact)) {
    const error = (validate.errors ?? [])[0];
    if (error === undefined) return refused(kind, '', 'it does not validate');
    return refused(kind, fieldOf(error), error.message ?? error.keyword);
  }
  const minusZero = minusZeroAt(fact, []);
  if (minusZero !== undefined) return refused(kind, minusZero, 'must not be minus zero, which a record cannot hold');
  return { ok: true };
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

/** Throws FactRefused unless the fact matches its schema. */
export function assertFact(fact: unknown): void {
  const result = checkFact(fact);
  if (!result.ok) throw new FactRefused(result.kind, result.field, result.message);
}
