// SPDX-License-Identifier: AGPL-3.0-only
// The one interface the rest of the kernel uses for CEL: compile an expression under static limits, then evaluate it
// against variables to true, false or error. docs/FOUNDATION.md §4, docs/adr/0011-claims-are-data-in-cel.md.
//
// This module imports nothing outside the kernel except the CEL library, and uses no API that exists only in Node.
// No clock takes part: the limits are on the text and on the work it may do, checked when the expression is loaded,
// and on the size of the variables it is given, so the same expression and the same variables always give the same
// answer, and the work is bounded (docs/cel-subset.md, "The cost bound").

import { CelScalar, celEnv, celFunc, celList, celMap, isCelError, isCelList, isCelMap, parse, plan } from '@bufbuild/cel';
import { OutsideCostModel, type ParsedSyntax, estimateCost } from './cel-cost.js';
import { type CelLimits, DEFAULT_LIMITS, type StaticRejection, checkStatic } from './cel-static.js';
import { normalize } from './normalize.js';

export { DEFAULT_LIMITS, type CelLimits };

/** The CEL library behind this interface. Recorded in every bundle; swapping it must not change what a rule gives. */
export const CEL_LIBRARY = Object.freeze({ name: '@bufbuild/cel', version: '0.6.2' });

/** What an expression evaluates to. Not a verdict: the judge makes a verdict for a claim from many of these. */
export type Truth = 'true' | 'false' | 'error';

/** Why an expression could not be loaded: over a named limit, not CEL, or CEL outside the allowed subset. */
export class CelRejection extends Error {
  readonly reason: StaticRejection['reason'];
  /** The name of the limit that was exceeded, when `reason` is `limit`. */
  readonly limit: keyof CelLimits | undefined;

  constructor(reason: StaticRejection['reason'], message: string, limit?: keyof CelLimits) {
    super(message);
    this.name = 'CelRejection';
    this.reason = reason;
    this.limit = limit;
  }
}

export interface CompiledExpression {
  readonly source: string;
  readonly limits: CelLimits;
}

type Program = (bindings: Record<string, unknown>) => unknown;

/** The planned program of each compiled expression, kept off its public shape. */
const programs = new WeakMap<CompiledExpression, Program>();

const env = celEnv({ funcs: [celFunc('normalize', [CelScalar.STRING], CelScalar.STRING, normalize)] });

/** The deepest a variable may nest. A guard on the stack, not a limit a claim sets. */
const MAX_VALUE_DEPTH = 64;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** A variable holds something a CEL value cannot be, or more than the input limits allow. */
class NotCelData extends Error {}

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
  let parsed: ReturnType<typeof parse>;
  let program: Program;
  try {
    parsed = parse(source);
    program = plan(env, parsed) as Program;
  } catch (error) {
    throw new CelRejection('syntax', error instanceof Error ? error.message : 'the expression could not be parsed');
  }
  let cost: number;
  try {
    cost = estimateCost(parsed as unknown as ParsedSyntax, limits);
  } catch (error) {
    if (error instanceof OutsideCostModel) {
      throw new CelRejection('subset', `${error.message} is outside the allowed CEL subset (see docs/cel-subset.md)`);
    }
    throw error;
  }
  if (cost > limits.maxCost) {
    throw new CelRejection(
      'limit',
      `the expression may take ${cost} steps over the largest variables the limits allow, over the limit maxCost of ${limits.maxCost}`,
      'maxCost',
    );
  }
  const compiled: CompiledExpression = Object.freeze({ source, limits });
  programs.set(compiled, program);
  return compiled;
}

/** How much of `maxInputSize` the variables have used so far. */
interface Budget {
  used: number;
}

function spend(budget: Budget, limits: CelLimits, amount: number): void {
  budget.used += amount;
  if (budget.used > limits.maxInputSize) throw new NotCelData('variables larger than maxInputSize');
}

function text(value: string, limits: CelLimits, budget: Budget): string {
  if (value.length > limits.maxStringLength) throw new NotCelData('a text over maxStringLength');
  spend(budget, limits, 1 + value.length);
  return value;
}

/**
 * JSON-shaped values become CEL values. Whole numbers are integers (CEL `int`, held as bigint); fact schemas have no
 * fractions (ADR 0011), so a fraction, NaN, infinity or an integer that a JSON number cannot hold exactly is refused
 * and never guessed at. A list or map longer than maxListLength, a text longer than maxStringLength, and variables
 * larger than maxInputSize together are refused: the cost bound counts on them. Lists and maps are wrapped as CEL
 * values once, here, so the library does not wrap a nested one again each time it is read.
 */
function toInput(value: unknown, limits: CelLimits, depth: number, budget: Budget): unknown {
  if (depth > MAX_VALUE_DEPTH) throw new NotCelData('nested too deep');
  switch (typeof value) {
    case 'string':
      return text(value, limits, budget);
    case 'boolean':
      spend(budget, limits, 1);
      return value;
    case 'number':
      if (!Number.isSafeInteger(value)) throw new NotCelData('a number that is not a whole number');
      spend(budget, limits, 1);
      return BigInt(value);
    case 'bigint':
      if (value < INT64_MIN || value > INT64_MAX) throw new NotCelData('an integer beyond 64 bits');
      spend(budget, limits, 1);
      return value;
    case 'object': {
      spend(budget, limits, 1);
      if (value === null) return null;
      if (Array.isArray(value)) {
        if (value.length > limits.maxListLength) throw new NotCelData('a list over maxListLength');
        return celList(value.map((inner) => toInput(inner, limits, depth + 1, budget)) as Parameters<typeof celList>[0]);
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new NotCelData('an object that is not plain data');
      const entries: Array<[string, unknown]> = [];
      for (const [key, inner] of Object.entries(value)) {
        if (entries.length >= limits.maxListLength) throw new NotCelData('a map over maxListLength');
        if (inner !== undefined) entries.push([text(key, limits, budget), toInput(inner, limits, depth + 1, budget)]);
      }
      return celMap(new Map(entries) as Parameters<typeof celMap>[0]);
    }
    default:
      throw new NotCelData(`a ${typeof value}`);
  }
}

/** What an expression can give: an integer, text, a boolean, null, a list, or a map. */
export type CelValue = null | boolean | bigint | string | CelValue[] | Map<string | bigint | boolean, CelValue>;

export type Outcome = { ok: true; value: CelValue } | { ok: false; reason: string };

/** A result the kernel does not accept: a fraction, an unsigned integer, bytes, a time, an object. */
const NOT_A_VALUE = 'the result is not an integer, text, a boolean, null, a list or a map';

function fromResult(result: unknown): CelValue {
  if (result === null || typeof result === 'boolean' || typeof result === 'bigint' || typeof result === 'string') return result;
  if (isCelList(result)) return Array.from(result, fromResult);
  if (isCelMap(result)) {
    const entries: Array<[string | bigint | boolean, CelValue]> = [];
    for (const [key, inner] of result.entries()) {
      if (typeof key === 'object') throw new NotCelData(NOT_A_VALUE);
      entries.push([key, fromResult(inner)]);
    }
    return new Map(entries);
  }
  throw new NotCelData(NOT_A_VALUE);
}

/**
 * Evaluate to the value itself, for a rule that gives an integer: a `sample` claim's `value` (docs/FOUNDATION.md §4).
 * The other rules, `count` among them, give a yes or no and go through `evaluate`. It is `ok: false` for anything that
 * goes wrong, with the reason; the reason is for people, and nothing is ever judged from it.
 */
export function evaluateValue(expression: CompiledExpression, variables: Record<string, unknown>): Outcome {
  const program = programs.get(expression);
  if (program === undefined) return { ok: false, reason: 'the expression was not loaded by compile' };
  try {
    const bindings: Record<string, unknown> = {};
    const budget: Budget = { used: 0 };
    for (const [name, value] of Object.entries(variables)) bindings[name] = toInput(value, expression.limits, 0, budget);
    const result = program(bindings);
    if (isCelError(result as never)) return { ok: false, reason: (result as Error).message };
    return { ok: true, value: fromResult(result) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'evaluation failed' };
  }
}

/**
 * Evaluate to `true`, `false` or `error`. Anything that goes wrong (a missing field, an operator applied to a type it
 * does not take, an overflow, a variable that is not CEL data or is over an input limit, an exception from the
 * library) is `error`; nothing but a result that is exactly the boolean `true` or `false` gives either of those.
 */
export function evaluate(expression: CompiledExpression, variables: Record<string, unknown>): Truth {
  const outcome = evaluateValue(expression, variables);
  if (!outcome.ok) return 'error';
  if (outcome.value === true) return 'true';
  if (outcome.value === false) return 'false';
  return 'error';
}
