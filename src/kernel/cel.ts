// SPDX-License-Identifier: AGPL-3.0-only
// The one interface the rest of the kernel uses for CEL: compile an expression, evaluate it to true, false or error.
// docs/FOUNDATION.md §4, docs/adr/0011-claims-are-data-in-cel.md.
//
// This module imports nothing outside the kernel except the CEL library, and uses no API that exists only in Node.

import { celEnv, isCelError, parse, plan } from '@bufbuild/cel';

export type Verdict = 'true' | 'false' | 'error';

export interface CompiledExpression {
  readonly source: string;
  /** @internal */
  readonly run: (bindings: Record<string, unknown>) => unknown;
}

const env = celEnv();

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** A variable holds something a CEL value cannot be. */
class Unreadable extends Error {}

export function compile(source: string): CompiledExpression {
  const run = plan(env, parse(source)) as (bindings: Record<string, unknown>) => unknown;
  return { source, run };
}

/**
 * JSON-shaped values become CEL values. Whole numbers are integers (CEL `int`, held as bigint); fact schemas have no
 * fractions (ADR 0011), so a fraction, NaN, infinity or an integer outside what both 64-bit and a JSON number can
 * hold exactly is refused and never guessed at.
 */
function toInput(value: unknown): unknown {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Unreadable('number');
      return BigInt(value);
    case 'bigint':
      if (value < INT64_MIN || value > INT64_MAX) throw new Unreadable('bigint');
      return value;
    case 'object': {
      if (value === null) return null;
      if (Array.isArray(value)) return value.map(toInput);
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Unreadable('object');
      const entries: Array<[string, unknown]> = [];
      for (const [key, inner] of Object.entries(value)) {
        if (inner !== undefined) entries.push([key, toInput(inner)]);
      }
      return new Map(entries);
    }
    default:
      throw new Unreadable(typeof value);
  }
}

export function evaluate(expression: CompiledExpression, variables: Record<string, unknown>): Verdict {
  try {
    const bindings: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(variables)) bindings[name] = toInput(value);
    const result = expression.run(bindings);
    if (isCelError(result as never)) return 'error';
    if (result === true) return 'true';
    if (result === false) return 'false';
    return 'error';
  } catch {
    return 'error';
  }
}
