// SPDX-License-Identifier: AGPL-3.0-only
// Loading a claim file (docs/FOUNDATION.md §4, ADRs 0011, 0013 and 0014). A claim is data: JSON naming its view, its
// shape and its rules in CEL. Every rule is compiled under the CEL limits, so a rule over a limit or outside the
// subset is refused here; and every example the file carries is judged, so a file with no failing example, or with an
// example that doesn't give what it says, is refused too. Only the `set` shape is judged so far.
import { CelRejection, type CompiledExpression, compile } from './cel.js';
import type { Json } from './ledger.js';
import { type Fact, type LoadedClaim, type PlacedFact, type Quantifier, type SetClaim, judgeSet } from './judge.js';
import { type Sha256, fromUtf8, isPlainObject, toHex } from './store.js';

/** Why a claim file was not loaded. */
export class ClaimRejection extends Error {}

const QUANTIFIERS: readonly Quantifier[] = ['every', 'some', 'none', 'count'];
const EXPECTED = ['pass', 'fail', 'not_checked', 'blocked', 'unverified'] as const;

/** One example in a claim file: facts, in ledger order, and the verdict they must give. */
interface Example {
  name: string;
  facts: Fact[];
  inputs: { [name: string]: Json };
  expect: (typeof EXPECTED)[number];
}

export async function loadClaim(bytes: Uint8Array, sha256: Sha256): Promise<LoadedClaim> {
  const text = fromUtf8(bytes);
  if (text === undefined) throw new ClaimRejection('the claim file is not UTF-8');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ClaimRejection('the claim file is not JSON');
  }
  if (!isPlainObject(data)) throw new ClaimRejection('the claim file is not a JSON object');
  const claim = readClaim(data);
  const compiled = {
    ...(claim.where !== undefined ? { where: rule('where', claim.where) } : {}),
    ...(claim.usable !== undefined ? { usable: rule('usable', claim.usable) } : {}),
    ...(claim.holds !== undefined ? { holds: rule('holds', claim.holds) } : {}),
    ...(claim.count !== undefined ? { count: rule('count', claim.count) } : {}),
    covered: rule('covered', claim.covered),
  };
  const examples = readExamples(data.examples);
  const failing = examples.find((e) => e.expect === 'fail');
  if (failing === undefined) throw new ClaimRejection(`claim ${claim.id} has no failing example, so it can't be seen to fail`);

  const loaded: LoadedClaim = { claim, rule: toHex(await sha256(bytes)), compiled, failedOn: failing.name };
  for (const example of examples) {
    const facts: PlacedFact[] = example.facts.map((fact, seq) => ({ seq, fact }));
    const got = judgeSet(loaded, { subject: 'example', facts, inputs: example.inputs }).verdict;
    if (got !== example.expect) {
      throw new ClaimRejection(`claim ${claim.id}: example ${JSON.stringify(example.name)} gives ${got}, not ${example.expect}`);
    }
  }
  return loaded;
}

function rule(place: string, source: string): CompiledExpression {
  try {
    return compile(source);
  } catch (error) {
    if (error instanceof CelRejection) throw new ClaimRejection(`${place}: ${error.reason}: ${error.message}`);
    throw error;
  }
}

function readClaim(data: Record<string, unknown>): SetClaim {
  const refuse = (why: string): never => {
    throw new ClaimRejection(`the claim file ${why}`);
  };
  const text = (key: string, required: boolean): string | undefined => {
    const value = data[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || value === '') return refuse(`needs ${key} as text`);
    return value;
  };
  const id = text('id', true) as string;
  const version = data.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) refuse('needs version as a whole number');
  const title = text('title', true) as string;
  if (data.shape !== 'set') refuse(`has shape ${JSON.stringify(data.shape)}: only "set" is judged so far`);
  const quantifier = data.quantifier;
  if (!QUANTIFIERS.includes(quantifier as Quantifier)) refuse('needs quantifier every, some, none or count');
  if (data.each !== undefined) refuse('has "each": items from a list inside a fact are not judged yet');
  const view = data.view;
  if (!isPlainObject(view) || !isTextList(view.kinds) || (view.by !== undefined && !isTextList(view.by))) {
    refuse('needs view.kinds, and view.by if given, as lists of text');
  }
  const viewData = view as { kinds: string[]; by?: string[] };
  const from = text('from', true) as string;
  if (!viewData.kinds.includes(from)) refuse(`reads items of kind ${from}, which its view does not hold`);
  const holds = text('holds', quantifier !== 'count');
  const count = text('count', quantifier === 'count');
  const vacuous = data.vacuous;
  if (vacuous !== undefined && vacuous !== 'pass' && vacuous !== 'not_checked') refuse('has vacuous other than pass or not_checked');
  const where = text('where', false);
  const usable = text('usable', false);
  return {
    id,
    version: version as number,
    title,
    view: { kinds: [...viewData.kinds], ...(viewData.by ? { by: [...viewData.by] } : {}) },
    shape: 'set',
    quantifier: quantifier as Quantifier,
    from,
    ...(where !== undefined ? { where } : {}),
    ...(usable !== undefined ? { usable } : {}),
    ...(holds !== undefined ? { holds } : {}),
    ...(count !== undefined ? { count } : {}),
    covered: text('covered', true) as string,
    ...(vacuous !== undefined ? { vacuous: vacuous as 'pass' | 'not_checked' } : {}),
  };
}

function readExamples(value: unknown): Example[] {
  if (!Array.isArray(value)) throw new ClaimRejection('the claim file needs examples as a list');
  return value.map((example, i) => {
    const refuse = (why: string): never => {
      throw new ClaimRejection(`example ${i} ${why}`);
    };
    if (!isPlainObject(example)) return refuse('is not an object');
    const { name, facts, inputs, expect } = example;
    if (typeof name !== 'string' || name === '') refuse('needs a name');
    if (!EXPECTED.includes(expect as Example['expect'])) refuse('needs expect: pass, fail, not_checked, blocked or unverified');
    if (!Array.isArray(facts)) refuse('needs facts as a list');
    if (inputs !== undefined && !isPlainObject(inputs)) refuse('has inputs that are not an object');
    return {
      name: name as string,
      expect: expect as Example['expect'],
      inputs: (inputs ?? {}) as { [name: string]: Json },
      facts: (facts as unknown[]).map((fact, j) => {
        if (!isPlainObject(fact) || typeof fact.kind !== 'string' || typeof fact.by !== 'string' || !('body' in fact)) {
          return refuse(`fact ${j} needs kind, by and body`);
        }
        // An example states only what its rules read; the rest of a fact takes the plainest value.
        return { v: 1, run: 1, subject: 'example', ...fact } as Fact;
      }),
    };
  });
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '');
}
