// SPDX-License-Identifier: AGPL-3.0-only
// The one interface the rest of the kernel uses for CEL: compile an expression under static limits, then evaluate it
// against variables to true, false or error. docs/FOUNDATION.md §4, docs/adr/0011-claims-are-data-in-cel.md.
//
// This module imports nothing outside the kernel except the CEL library, and uses no API that exists only in Node.
// No clock takes part: the limits are on the text, checked when the expression is loaded, and on the size of the
// lists it is given, so the same expression and the same variables always give the same answer.

import { CelScalar, celEnv, celFunc, isCelError, parse, plan } from '@bufbuild/cel';
import { type CelLimits, DEFAULT_LIMITS, checkStatic } from './cel-static.js';
import { normalize } from './normalize.js';

export { DEFAULT_LIMITS, type CelLimits };

export type Verdict = 'true' | 'false' | 'error';

/** Why an expression could not be loaded: over a named limit, not CEL, or CEL outside the allowed subset. */
export class CelRejection extends Error {
  readonly reason: 'limit' | 'syntax' | 'subset';
  /** The name of the limit that was exceeded, when `reason` is `limit`. */
  readonly limit: keyof CelLimits | undefined;

  constructor(reason: 'limit' | 'syntax' | 'subset', message: string, limit?: keyof CelLimits) {
    super(message);
    this.name = 'CelRejection';
    this.reason = reason;
    this.limit = limit;
  }
}

export interface CompiledExpression {
  readonly source: string;
  readonly limits: CelLimits;
  /** @internal */
  readonly run: (bindings: Record<string, unknown>) => unknown;
}

const env = celEnv({ funcs: [celFunc('normalize', [CelScalar.STRING], CelScalar.STRING, normalize)] });

/** The deepest a variable may nest. A guard on the stack, not a limit a claim sets. */
const MAX_VALUE_DEPTH = 64;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** A variable holds something a CEL value cannot be, or more than the limits allow. */
class Unreadable extends Error {}

function resolveLimits(given: Partial<CelLimits> | undefined): CelLimits {
  const limits = { ...DEFAULT_LIMITS, ...given };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`limit ${name} must be a whole number of 0 or more, not ${String(value)}`);
    }
  }
  return limits;
}

/** Load an expression. Throws `CelRejection` when it is over a limit, is not CEL, or is outside the allowed subset. */
export function compile(source: string, given?: Partial<CelLimits>): CompiledExpression {
  const limits = resolveLimits(given);
  const rejected = checkStatic(source, limits);
  if (rejected !== undefined) {
    throw new CelRejection(rejected.reason, rejected.message, rejected.reason === 'limit' ? rejected.limit : undefined);
  }
  try {
    const run = plan(env, parse(source)) as (bindings: Record<string, unknown>) => unknown;
    return { source, limits, run };
  } catch (error) {
    throw new CelRejection('syntax', error instanceof Error ? error.message : 'the expression could not be parsed');
  }
}

/**
 * JSON-shaped values become CEL values. Whole numbers are integers (CEL `int`, held as bigint); fact schemas have no
 * fractions (ADR 0011), so a fraction, NaN, infinity or an integer that a JSON number cannot hold exactly is refused
 * and never guessed at. A list or map longer than the limit is refused: it is the list the expression would walk.
 */
function toInput(value: unknown, limits: CelLimits, depth: number): unknown {
  if (depth > MAX_VALUE_DEPTH) throw new Unreadable('nested too deep');
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Unreadable('a number that is not a whole number');
      return BigInt(value);
    case 'bigint':
      if (value < INT64_MIN || value > INT64_MAX) throw new Unreadable('an integer beyond 64 bits');
      return value;
    case 'object': {
      if (value === null) return null;
      if (Array.isArray(value)) {
        if (value.length > limits.maxListLength) throw new Unreadable('a list over maxListLength');
        return value.map((inner) => toInput(inner, limits, depth + 1));
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Unreadable('an object that is not plain data');
      const entries: Array<[string, unknown]> = [];
      for (const [key, inner] of Object.entries(value)) {
        if (entries.length >= limits.maxListLength) throw new Unreadable('a map over maxListLength');
        if (inner !== undefined) entries.push([key, toInput(inner, limits, depth + 1)]);
      }
      return new Map(entries);
    }
    default:
      throw new Unreadable(`a ${typeof value}`);
  }
}

/**
 * Evaluate to `true`, `false` or `error`. Anything that goes wrong (a missing field, a type mismatch, an overflow, a
 * variable that is not CEL data, an exception from the library) is `error`; nothing but a result that is exactly the
 * boolean `true` or `false` gives either of those.
 */
export function evaluate(expression: CompiledExpression, variables: Record<string, unknown>): Verdict {
  try {
    const bindings: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(variables)) bindings[name] = toInput(value, expression.limits, 0);
    const result = expression.run(bindings);
    if (isCelError(result as never)) return 'error';
    if (result === true) return 'true';
    if (result === false) return 'false';
    return 'error';
  } catch {
    return 'error';
  }
}
