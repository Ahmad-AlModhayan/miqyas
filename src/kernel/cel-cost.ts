// SPDX-License-Identifier: AGPL-3.0-only
// The bound on the work an expression can do, computed when it is loaded (docs/cel-subset.md, "The cost bound").
// It reads the parsed expression in the standard CEL syntax tree (cel.expr.Expr of cel-spec) and counts every walk:
// the comprehension macros, `in`, comparison, concatenation, `size`, the string functions, `matches`, `normalize`,
// `int` and `string`. There is no type checker, so a value read from the variables is taken at the largest the input
// limits allow. Pure functions of the tree and the limits: no clock and no Node API.

import type { CelLimits } from './cel-static.js';

/** How much longer `normalize()` can make a text: NFKD expands one code unit to at most 18, and it runs twice. */
export const NORMALIZE_GROWTH = 18 * 18;
/** The longest text `string()` makes from an integer: `-9223372036854775808`. */
const INT_TEXT = 20;
/**
 * The steps charged for each element `map` or `filter` adds to the list it builds. The library joins a new list to
 * the old one at every element and keeps every join alive until the list is dropped; that took about 40 times an
 * ordinary step when measured, so a rule cannot load with more than about a million of them.
 */
const APPEND = 40;

/** The parts of a cel.expr.Expr this pass reads. */
export interface SyntaxNode {
  readonly id: bigint;
  readonly exprKind:
    | { readonly case: 'constExpr'; readonly value: { readonly constantKind: { readonly case: string | undefined; readonly value?: unknown } } }
    | { readonly case: 'identExpr'; readonly value: { readonly name: string } }
    | { readonly case: 'selectExpr'; readonly value: { readonly operand?: SyntaxNode; readonly testOnly: boolean } }
    | { readonly case: 'callExpr'; readonly value: { readonly target?: SyntaxNode; readonly function: string; readonly args: readonly SyntaxNode[] } }
    | { readonly case: 'listExpr'; readonly value: { readonly elements: readonly SyntaxNode[] } }
    | { readonly case: 'structExpr'; readonly value: { readonly entries: ReadonlyArray<{ readonly keyKind: { readonly case: string | undefined; readonly value?: unknown }; readonly value?: SyntaxNode }> } }
    | {
        readonly case: 'comprehensionExpr';
        readonly value: {
          readonly iterVar: string;
          readonly iterRange?: SyntaxNode;
          readonly accuVar: string;
          readonly accuInit?: SyntaxNode;
          readonly loopCondition?: SyntaxNode;
          readonly loopStep?: SyntaxNode;
          readonly result?: SyntaxNode;
        };
      }
    | { readonly case: undefined; readonly value?: undefined };
}

export interface ParsedSyntax {
  readonly expr: SyntaxNode;
  readonly sourceInfo?: { readonly macroCalls: Readonly<Record<string, SyntaxNode>> };
}

/** The expression cannot be costed because it leaves the subset in a way only the tree shows. */
export class OutsideCostModel extends Error {}

/**
 * A bound that may grow with the size of a comprehension variable: `constant + Σ perVariable[v] · size(v)`. Summed over
 * the iterations of a comprehension, the sizes of its variable add up to at most the size of the list it walks.
 */
interface Linear {
  readonly constant: number;
  readonly perVariable: ReadonlyMap<number, number>;
}

const fixed = (constant: number): Linear => ({ constant, perVariable: new Map() });

function plus(...terms: Linear[]): Linear {
  const perVariable = new Map<number, number>();
  let constant = 0;
  for (const term of terms) {
    constant += term.constant;
    for (const [v, c] of term.perVariable) perVariable.set(v, (perVariable.get(v) ?? 0) + c);
  }
  return { constant, perVariable };
}

function times(term: Linear, factor: number): Linear {
  const perVariable = new Map<number, number>();
  for (const [v, c] of term.perVariable) perVariable.set(v, c * factor);
  return { constant: term.constant * factor, perVariable };
}

function larger(a: Linear, b: Linear): Linear {
  const perVariable = new Map(a.perVariable);
  for (const [v, c] of b.perVariable) perVariable.set(v, Math.max(perVariable.get(v) ?? 0, c));
  return { constant: Math.max(a.constant, b.constant), perVariable };
}

/**
 * Either bound is sound for the smaller of two. Take the one that is smaller when each comprehension variable has the
 * size of a typical element, since that is what a variable's size adds up to over the iterations.
 */
function smaller(a: Linear, b: Linear, typicalElement: number): Linear {
  const at = (t: Linear) => t.constant + [...t.perVariable.values()].reduce((sum, c) => sum + c * typicalElement, 0);
  return at(a) <= at(b) ? a : b;
}

/** The sum over every iteration of a comprehension of `term`, where variable `v` walks a list of `n` elements and size `range`. */
function overIterations(term: Linear, v: number, n: number, range: Linear): Linear {
  const rest = new Map(term.perVariable);
  const perElement = rest.get(v) ?? 0;
  rest.delete(v);
  return plus(times({ constant: term.constant, perVariable: rest }, n), times(range, perElement));
}

/** What is known of a subexpression: the work to evaluate it, and bounds on the value it gives. */
interface Estimate {
  readonly cost: Linear;
  /** The size of the value: 1 for each integer, boolean, null, list and map, and 1 plus its length for each text. */
  readonly size: Linear;
  /** The most elements in the value or any list or map inside it. */
  readonly items: number;
  /** The longest text in the value or inside it. */
  readonly chars: number;
  /** How many joins deep a list in the value may be: the library joins lists lazily, so reading one walks the joins. */
  readonly joins: number;
}

const scalar = (cost: Linear): Estimate => ({ cost, size: fixed(1), items: 0, chars: 0, joins: 0 });

/** Reading every element of a value, as equality and `in` may: its size, times the joins on the way to each part. */
const walk = (e: Estimate): Linear => times(e.size, Math.max(1, e.joins));

/**
 * The value may hold a list built by `map`, `filter` or `+`, at any depth: each element read from it walks its joins.
 * A list or map literal, a field, a choice and a comprehension variable carry the joins of what they hold.
 */
const built = (e: Estimate): boolean => e.joins > 1;

/** An upper bound on the program RE2 builds from a literal pattern: its length, times every counted repetition. */
function patternWork(pattern: string): number {
  let work = pattern.length + 1;
  for (const match of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
    const low = Number(match[1]);
    const high = match[2] === undefined || match[2] === '' ? low : Number(match[2]);
    work *= Math.max(low, high) + 1;
  }
  return work;
}

const COMPARISONS = new Set(['_==_', '_!=_', '_<_', '_<=_', '_>_', '_>=_']);
const CONSTANT_WORK = new Set(['_&&_', '_||_', '!_', '-_', '_-_', '_*_', '_/_', '_%_', '@not_strictly_false']);
const GROWING = new Set(['map', 'filter']);

/**
 * The most work an expression can do, in steps: each node of the tree is one step, and each walk adds the size it may
 * walk. Throws `OutsideCostModel` when the tree holds what the subset does not allow, such as a pattern that is not a
 * literal text.
 */
export function estimateCost(parsed: ParsedSyntax, limits: CelLimits): number {
  const macroCalls = parsed.sourceInfo?.macroCalls ?? {};
  const input: Estimate = {
    cost: fixed(1),
    size: fixed(limits.maxInputSize),
    items: limits.maxListLength,
    chars: limits.maxStringLength,
    joins: 1,
  };
  const typicalElement = limits.maxInputSize / Math.max(1, limits.maxListLength);
  let nextVariable = 0;

  const estimate = (node: SyntaxNode | undefined, scope: ReadonlyMap<string, Estimate>): Estimate => {
    if (node === undefined) throw new OutsideCostModel('an incomplete expression');
    const kind = node.exprKind;
    switch (kind.case) {
      case 'constExpr': {
        const constant = kind.value.constantKind;
        if (constant.case === 'stringValue') {
          const length = String(constant.value).length;
          return { cost: fixed(1), size: fixed(1 + length), items: 0, chars: length, joins: 0 };
        }
        return scalar(fixed(1));
      }
      case 'identExpr':
        return scope.get(kind.value.name) ?? input;
      case 'selectExpr': {
        const operand = estimate(kind.value.operand, scope);
        if (kind.value.testOnly) return scalar(plus(operand.cost, fixed(1)));
        return { ...operand, cost: plus(operand.cost, fixed(1)) };
      }
      case 'listExpr': {
        const elements = kind.value.elements.map((element) => estimate(element, scope));
        return {
          cost: plus(fixed(1 + elements.length), ...elements.map((e) => e.cost)),
          size: plus(fixed(1), ...elements.map((e) => e.size)),
          items: Math.max(elements.length, ...elements.map((e) => e.items)),
          chars: Math.max(0, ...elements.map((e) => e.chars)),
          joins: Math.max(1, ...elements.map((e) => e.joins)),
        };
      }
      case 'structExpr': {
        const parts: Estimate[] = [];
        for (const entry of kind.value.entries) {
          if (entry.keyKind.case !== 'mapKey') throw new OutsideCostModel('constructing a message');
          parts.push(estimate(entry.keyKind.value as SyntaxNode, scope), estimate(entry.value, scope));
        }
        // Building the map hashes each key, which reads it.
        return {
          cost: plus(fixed(1 + parts.length), ...parts.map((e) => e.cost), ...parts.map((e) => fixed(e.chars))),
          size: plus(fixed(1), ...parts.map((e) => e.size)),
          items: Math.max(parts.length / 2, ...parts.map((e) => e.items)),
          chars: Math.max(0, ...parts.map((e) => e.chars)),
          joins: Math.max(1, ...parts.map((e) => e.joins)),
        };
      }
      case 'comprehensionExpr':
        return comprehension(node, kind.value, scope);
      case 'callExpr':
        return call(kind.value, scope);
      default:
        throw new OutsideCostModel('an expression of an unknown kind');
    }
  };

  const comprehension = (
    node: SyntaxNode,
    parts: Extract<SyntaxNode['exprKind'], { case: 'comprehensionExpr' }>['value'],
    scope: ReadonlyMap<string, Estimate>,
  ): Estimate => {
    const macro = macroCalls[node.id.toString()];
    const name = macro?.exprKind.case === 'callExpr' ? macro.exprKind.value.function : '';
    const growing = GROWING.has(name);
    const range = estimate(parts.iterRange, scope);
    const n = range.items;
    const variable = nextVariable++;
    const inner = new Map(scope);
    inner.set(parts.iterVar, { cost: fixed(1), size: { constant: 0, perVariable: new Map([[variable, 1]]) }, items: range.items, chars: range.chars, joins: range.joins });
    // The accumulator of `map` and `filter` is the list being built; its growth is counted from each step below.
    inner.set(parts.accuVar, { cost: fixed(1), size: fixed(growing ? 0 : 1), items: 0, chars: 0, joins: 0 });
    const init = estimate(parts.accuInit, inner);
    const condition = estimate(parts.loopCondition, inner);
    const step = estimate(parts.loopStep, inner);
    const result = estimate(parts.result, inner);
    const perIteration = plus(fixed(growing ? 1 + APPEND : 1), condition.cost, step.cost);
    const cost = plus(
      fixed(1),
      range.cost,
      fixed(n * Math.max(1, range.joins)), // stepping through the list, and through its joins
      init.cost,
      overIterations(perIteration, variable, n, range.size),
      result.cost,
    );
    if (!growing) return scalar(cost);
    return {
      cost,
      size: plus(fixed(1), overIterations(step.size, variable, n, range.size)),
      items: Math.max(n, step.items),
      chars: step.chars,
      joins: Math.max(n + 1, step.joins),
    };
  };

  const call = (
    parts: Extract<SyntaxNode['exprKind'], { case: 'callExpr' }>['value'],
    scope: ReadonlyMap<string, Estimate>,
  ): Estimate => {
    const operands = [...(parts.target === undefined ? [] : [parts.target]), ...parts.args];
    const args = operands.map((operand) => estimate(operand, scope));
    const own = plus(fixed(1), ...args.map((a) => a.cost));
    const [a, b, c] = args as [Estimate, Estimate | undefined, Estimate | undefined];
    const fn = parts.function;
    // The length of a text is at most its longest text, and at most its size; the size adds up over a comprehension.
    const textLength = (e: Estimate): Linear => smaller(fixed(e.chars), e.size, typicalElement);
    if (CONSTANT_WORK.has(fn)) return scalar(own);
    if (COMPARISONS.has(fn) && b !== undefined) {
      // Equality reads element i of both sides. Two plain values stop at the shorter, so either walk bounds it; on a
      // built value each read walks its joins, so the cheaper side's walk does not cover the other: count both.
      const work = built(a) || built(b) ? plus(walk(a), walk(b)) : smaller(walk(a), walk(b), typicalElement);
      return scalar(plus(own, work));
    }
    switch (fn) {
      case '_?_:_':
        if (b === undefined || c === undefined) break;
        return { cost: own, size: larger(b.size, c.size), items: Math.max(b.items, c.items), chars: Math.max(b.chars, c.chars), joins: Math.max(b.joins, c.joins) };
      case '@in':
        if (b === undefined) break;
        // A list compares the value with each element; a map hashes it. Comparing a built value with an element reads
        // as many of its elements as the element has, each through its joins.
        return scalar(plus(own, walk(b), textLength(a), built(a) ? times(b.size, a.joins) : fixed(0)));
      case '_[_]':
        if (b === undefined) break;
        return { ...a, cost: plus(own, fixed(Math.max(1, a.joins)), textLength(b)) };
      case '_+_':
        if (b === undefined) break;
        return {
          cost: plus(own, textLength(a), textLength(b)),
          size: plus(a.size, b.size),
          items: a.items + b.items,
          chars: a.chars + b.chars,
          joins: Math.max(a.joins, b.joins) + 1,
        };
      case 'size':
      case 'int':
        return scalar(plus(own, textLength(a)));
      case 'string':
        return {
          cost: plus(own, textLength(a), fixed(INT_TEXT)),
          size: plus(fixed(1 + INT_TEXT), textLength(a)),
          items: 0,
          chars: Math.max(a.chars, INT_TEXT),
          joins: 0,
        };
      case 'contains':
      case 'startsWith':
      case 'endsWith':
        if (b === undefined) break;
        // A search may compare the pattern at every place in the text.
        return scalar(plus(own, smaller(times(plus(textLength(a), fixed(1)), b.chars + 1), times(plus(textLength(b), fixed(1)), a.chars + 1), typicalElement)));
      case 'matches': {
        const pattern = operands[1]?.exprKind;
        if (pattern?.case !== 'constExpr' || pattern.value.constantKind.case !== 'stringValue') {
          throw new OutsideCostModel('a pattern that is not a literal text');
        }
        return scalar(plus(own, times(plus(textLength(a), fixed(1)), patternWork(String(pattern.value.constantKind.value)))));
      }
      case 'normalize': {
        const grown = times(textLength(a), NORMALIZE_GROWTH);
        return {
          cost: plus(own, textLength(a), grown),
          size: plus(fixed(1), grown),
          items: 0,
          chars: a.chars * NORMALIZE_GROWTH,
          joins: 0,
        };
      }
      default:
        throw new OutsideCostModel(`the function ${fn}()`);
    }
    throw new OutsideCostModel(`${fn}() with ${args.length} arguments`);
  };

  return estimate(parsed.expr, new Map()).cost.constant;
}
