// SPDX-License-Identifier: AGPL-3.0-only
// Loading a claim file (docs/FOUNDATION.md §4, ADRs 0011, 0013 and 0014). A claim is data: JSON naming its view, its
// shape and its rules in CEL. Every rule is compiled under the CEL limits, so a rule over a limit or outside the
// subset is refused here; a key the loader does not know is refused, so a misspelt rule is never dropped; and every
// example the file carries is judged, so a file without an example that gives each of pass, fail and not_checked, or
// with an example that doesn't give what it says, is refused too. Only the `set` shape with the `none` quantifier is
// judged so far, and a claim that asks for more is refused, naming what it asked for.
import { CelRejection, type CompiledExpression, compile } from './cel.js';
import type { Fact, PlacedFact } from './fact.js';
import type { Json } from './ledger.js';
import { type LoadedClaim, QUANTIFIERS, type Quantifier, type SetClaim, VERDICTS, type VerdictValue, judgeSet } from './judge.js';
import { type Sha256, fromUtf8, isPlainObject, toHex } from './store.js';

/** Why a claim file was not loaded. */
export class ClaimRejection extends Error {}

const CLAIM_KEYS = ['id', 'version', 'title', 'view', 'shape', 'quantifier', 'from', 'holds', 'covered', 'vacuous', 'examples'];
/** Keys of the judge in full (docs/ALGORITHMS.md A1) that this judge does not judge yet. */
const NOT_YET = ['where', 'usable', 'count', 'each'];
const VIEW_KEYS = ['kinds', 'by'];
const EXAMPLE_KEYS = ['name', 'expect', 'facts', 'inputs'];
/** ADR 0014: a shipped claim carries facts that must give a pass, a fail and "not known". */
const MUST_GIVE: readonly VerdictValue[] = ['fail', 'pass', 'not_checked'];

/** One example in a claim file: facts, in ledger order, and the verdict they must give. */
interface Example {
  name: string;
  facts: Fact[];
  inputs: { [name: string]: Json };
  expect: VerdictValue;
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
  const compiled = { holds: rule('holds', claim.holds), covered: rule('covered', claim.covered) };
  const examples = readExamples(data.examples);
  for (const verdict of MUST_GIVE) {
    if (!examples.some((e) => e.expect === verdict)) {
      throw new ClaimRejection(`claim ${claim.id} has no example that gives ${verdict}, so it can't be seen to give it (ADR 0014)`);
    }
  }
  const failing = examples.find((e) => e.expect === 'fail') as Example;

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

function unknownKey(object: Record<string, unknown>, known: readonly string[]): string | undefined {
  return Object.keys(object).find((key) => !known.includes(key));
}

function readClaim(data: Record<string, unknown>): SetClaim {
  const refuse = (why: string): never => {
    throw new ClaimRejection(`the claim file ${why}`);
  };
  const text = (key: string): string => {
    const value = data[key];
    if (typeof value !== 'string' || value === '') return refuse(`needs ${key} as text`);
    return value;
  };
  for (const key of NOT_YET) if (data[key] !== undefined) refuse(`has ${JSON.stringify(key)}: it is not judged yet`);
  const unknown = unknownKey(data, CLAIM_KEYS);
  if (unknown !== undefined) refuse(`has an unknown key ${JSON.stringify(unknown)}`);

  const id = text('id');
  const version = data.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) refuse('needs version as a whole number');
  const title = text('title');
  if (data.shape !== 'set') refuse(`has shape ${JSON.stringify(data.shape)}: only "set" is judged so far`);
  if (!QUANTIFIERS.includes(data.quantifier as Quantifier)) {
    refuse(`has quantifier ${JSON.stringify(data.quantifier)}: only ${QUANTIFIERS.map((q) => JSON.stringify(q)).join(', ')} is judged so far`);
  }
  const view = data.view;
  if (!isPlainObject(view) || !isTextList(view.kinds) || (view.by !== undefined && !isTextList(view.by))) {
    return refuse('needs view.kinds, and view.by if given, as lists of text');
  }
  const unknownInView = unknownKey(view, VIEW_KEYS);
  if (unknownInView !== undefined) refuse(`has an unknown key ${JSON.stringify(`view.${unknownInView}`)}`);
  const viewData = view as { kinds: string[]; by?: string[] };
  const from = text('from');
  if (!viewData.kinds.includes(from)) refuse(`reads items of kind ${from}, which its view does not hold`);
  const vacuous = data.vacuous;
  if (vacuous !== undefined && vacuous !== 'pass' && vacuous !== 'not_checked') refuse('has vacuous other than pass or not_checked');
  return {
    id,
    version: version as number,
    title,
    view: { kinds: [...viewData.kinds], ...(viewData.by ? { by: [...viewData.by] } : {}) },
    shape: 'set',
    quantifier: data.quantifier as Quantifier,
    from,
    holds: text('holds'),
    covered: text('covered'),
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
    const unknown = unknownKey(example, EXAMPLE_KEYS);
    if (unknown !== undefined) refuse(`has an unknown key ${JSON.stringify(unknown)}`);
    const { name, facts, inputs, expect } = example;
    if (typeof name !== 'string' || name === '') refuse('needs a name');
    if (!VERDICTS.includes(expect as VerdictValue)) refuse(`needs expect: ${VERDICTS.join(', ')}`);
    if (!Array.isArray(facts)) refuse('needs facts as a list');
    if (inputs !== undefined && !isPlainObject(inputs)) refuse('has inputs that are not an object');
    return {
      name: name as string,
      expect: expect as VerdictValue,
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
