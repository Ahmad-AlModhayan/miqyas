// SPDX-License-Identifier: AGPL-3.0-only
// Loading a claim file (docs/FOUNDATION.md §4, ADRs 0011, 0013 and 0014). A claim is data: JSON naming its view, its
// shape and its rules in CEL. Every rule is compiled under the CEL limits, so a rule over a limit or outside the
// subset is refused here; a key the loader does not know is refused, so a misspelt rule is never dropped; and every
// example the file carries is judged, so a file without an example that gives each of pass, fail and not_checked, or
// with an example that doesn't give what it says, is refused too. The `set` and `pair` shapes are judged so far,
// without `each`, and combinations of them with `all` and `any`; a claim that asks for more is refused, naming what it
// asked for.
import { CelRejection, type CompiledExpression, compile } from './cel.js';
import type { Fact, PlacedFact } from './fact.js';
import type { Json } from './ledger.js';
import {
  COMBINATIONS,
  type Claim,
  type Combination,
  EFFECT_CLASSES,
  type EffectClass,
  type LoadedClaim,
  type Needs,
  QUANTIFIERS,
  type Quantifier,
  type Selector,
  type SetClaim,
  UNMATCHED,
  type Unmatched,
  VERDICTS,
  type VerdictValue,
  judgeClaim,
} from './judge.js';
import { type Sha256, fromUtf8, isPlainObject, toHex } from './store.js';

/** Why a claim file was not loaded. */
export class ClaimRejection extends Error {}

const SET_KEYS = ['id', 'version', 'title', 'needs', 'view', 'shape', 'quantifier', 'from', 'where', 'usable', 'holds', 'count', 'covered', 'vacuous'];
const PAIR_KEYS = ['id', 'version', 'title', 'needs', 'view', 'shape', 'quantifier', 'left', 'right', 'on', 'usable', 'holds', 'unmatched', 'covered', 'vacuous'];
/** A combination states only how it joins its parts; each part states its own needs, view and rules. */
const COMBINED_KEYS = ['id', 'version', 'title', 'all', 'any'];
const SELECTOR_KEYS = ['from', 'where'];
/** Keys of the judge in full (docs/ALGORITHMS.md A1) that this judge does not judge yet. */
const NOT_YET = ['each'];
const VIEW_KEYS = ['kinds', 'by'];
const NEEDS_KEYS = ['inputs', 'effect', 'kinds'];
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
  const { examples: rawExamples, ...claimData } = data;
  const claim = readClaim(claimData);
  const examples = readExamples(rawExamples);
  for (const verdict of MUST_GIVE) {
    if (!examples.some((e) => e.expect === verdict)) {
      throw new ClaimRejection(`claim ${claim.id} has no example that gives ${verdict}, so it can't be seen to give it (ADR 0014)`);
    }
  }
  const failing = examples.find((e) => e.expect === 'fail') as Example;

  const loaded = compileClaim(claim, toHex(await sha256(bytes)), failing.name);
  // An example shows what the claim gives once it can be judged: the effect and the kinds it needs are supplied. The
  // inputs it needs are the example's own to give.
  const supplies = suppliesFor(claim);
  for (const example of examples) {
    const facts: PlacedFact[] = example.facts.map((fact, seq) => ({ seq, fact }));
    const got = judgeClaim(loaded, { subject: 'example', facts, inputs: example.inputs, supplies }).verdict;
    if (got !== example.expect) {
      throw new ClaimRejection(`claim ${claim.id}: example ${JSON.stringify(example.name)} gives ${got}, not ${example.expect}`);
    }
  }
  return loaded;
}

/** Each rule of a claim compiled, a combination's parts with them; a part carries its file's digest and failing example. */
function compileClaim(claim: Claim, digest: string, failedOn: string): LoadedClaim {
  const at = { rule: digest, failedOn };
  if ('combine' in claim) return { claim, ...at, parts: claim.parts.map((part) => compileClaim(part, digest, failedOn)) };
  const covered = rule('covered', claim.covered);
  const usable = claim.usable === undefined ? {} : { usable: rule('usable', claim.usable) };
  if (claim.shape === 'pair') {
    const side = (name: 'left' | 'right') => (claim[name].where === undefined ? {} : { where: rule(`${name}.where`, claim[name].where as string) });
    return {
      claim,
      ...at,
      compiled: { left: side('left'), right: side('right'), on: [rule('on[0]', claim.on[0]), rule('on[1]', claim.on[1])], ...usable, holds: rule('holds', claim.holds), covered },
    };
  }
  const where = claim.where === undefined ? {} : { where: rule('where', claim.where) };
  return {
    claim,
    ...at,
    compiled:
      claim.quantifier === 'count'
        ? { covered, ...where, ...usable, quantifier: 'count', count: rule('count', claim.count) }
        : { covered, ...where, ...usable, quantifier: claim.quantifier, holds: rule('holds', claim.holds) },
  };
}

/** What a claim's examples are judged with: the effect and the kinds it and every part of it need. */
function suppliesFor(claim: Claim): { kinds: string[]; effect?: EffectClass } {
  const needs: Needs[] = [];
  const walk = (c: Claim): void => {
    if ('combine' in c) c.parts.forEach(walk);
    else if (c.needs !== undefined) needs.push(c.needs);
  };
  walk(claim);
  const kinds = [...new Set(needs.flatMap((n) => n.kinds))];
  const effects = needs.flatMap((n) => (n.effect !== undefined ? [EFFECT_CLASSES.indexOf(n.effect)] : []));
  return { kinds, ...(effects.length > 0 ? { effect: EFFECT_CLASSES[Math.max(...effects)] as EffectClass } : {}) };
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

/** Reads a claim, or a part of a combination: a combination, a `set` claim or a `pair` claim. */
function readClaim(data: Record<string, unknown>, part?: string): Claim {
  const refuse = (why: string): never => {
    throw new ClaimRejection(`${part === undefined ? 'the claim file' : `part ${part}`} ${why}`);
  };
  const text = (key: string, from: Record<string, unknown> = data, name = key): string => {
    const value = from[key];
    if (typeof value !== 'string' || value === '') return refuse(`needs ${name} as text`);
    return value;
  };
  for (const key of NOT_YET) if (data[key] !== undefined) refuse(`has ${JSON.stringify(key)}: it is not judged yet`);
  const combined = COMBINATIONS.filter((how) => data[how] !== undefined);
  const keys = combined.length > 0 ? COMBINED_KEYS : data.shape === 'pair' ? PAIR_KEYS : SET_KEYS;
  const unknown = unknownKey(data, keys);
  if (unknown !== undefined) refuse(`has an unknown key ${JSON.stringify(unknown)}`);

  const id = text('id');
  const version = data.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) refuse('needs version as a whole number');
  const title = text('title');
  const head = { id, version: version as number, title };

  if (combined.length > 0) {
    if (combined.length > 1) refuse('has both all and any: a combination is one of them');
    const combine = combined[0] as Combination;
    const parts = data[combine];
    if (!Array.isArray(parts) || parts.length === 0) return refuse(`needs ${combine} as a list of claims: an empty list is refused`);
    return {
      ...head,
      combine,
      parts: parts.map((p, i) => {
        const name = `${combine}[${i}]${part === undefined ? '' : ` of ${part}`}`;
        if (!isPlainObject(p)) return refuse(`needs ${combine}[${i}] as a claim`);
        return readClaim(p, name);
      }),
    };
  }

  if (data.shape !== 'set' && data.shape !== 'pair') refuse(`has shape ${JSON.stringify(data.shape)}: only "set" and "pair" are judged so far`);
  const pair = data.shape === 'pair';
  const quantifiers: readonly Quantifier[] = pair ? QUANTIFIERS.filter((q) => q !== 'count') : QUANTIFIERS;
  const quantifier = data.quantifier as Quantifier;
  if (!quantifiers.includes(quantifier)) {
    refuse(`has quantifier ${JSON.stringify(quantifier)}: ${pair ? 'a pair claim' : 'it'} must be one of ${quantifiers.map((q) => JSON.stringify(q)).join(', ')}`);
  }
  // The rule the quantifier reads, and only that one: a rule the judge would not read is refused, never dropped.
  if (quantifier === 'count' && data.holds !== undefined) refuse('is a count claim and has holds: a count claim counts the items inside it');
  if (quantifier !== 'count' && data.count !== undefined) refuse('has count, which only a count claim reads');
  const optional = (key: 'where' | 'usable') => (data[key] === undefined ? {} : { [key]: text(key) });
  const view = data.view;
  if (!isPlainObject(view) || !isTextList(view.kinds) || (view.by !== undefined && !isTextList(view.by))) {
    return refuse('needs view.kinds, and view.by if given, as lists of text');
  }
  const unknownInView = unknownKey(view, VIEW_KEYS);
  if (unknownInView !== undefined) refuse(`has an unknown key ${JSON.stringify(`view.${unknownInView}`)}`);
  const viewData = view as { kinds: string[]; by?: string[] };
  const inView = (from: string) => {
    if (!viewData.kinds.includes(from)) refuse(`reads items of kind ${from}, which its view does not hold`);
    return from;
  };
  const vacuous = data.vacuous;
  if (vacuous !== undefined && vacuous !== 'pass' && vacuous !== 'not_checked') refuse('has vacuous other than pass or not_checked');
  if (vacuous !== undefined && quantifier !== 'every' && quantifier !== 'none') refuse('has vacuous, which only an every or none claim reads');
  const needs = data.needs === undefined ? undefined : readNeeds(data.needs, refuse);
  const common = {
    ...head,
    ...(needs !== undefined ? { needs } : {}),
    view: { kinds: [...viewData.kinds], ...(viewData.by ? { by: [...viewData.by] } : {}) },
  };
  const tail = { covered: text('covered'), ...(vacuous !== undefined ? { vacuous: vacuous as 'pass' | 'not_checked' } : {}) };

  if (pair) {
    const selector = (name: 'left' | 'right'): Selector => {
      const s = data[name];
      if (!isPlainObject(s)) return refuse(`needs ${name} as a selector: { "from": <kind>, "where": <rule> }`);
      const unknownInSide = unknownKey(s, SELECTOR_KEYS);
      if (unknownInSide !== undefined) refuse(`has an unknown key ${JSON.stringify(`${name}.${unknownInSide}`)}`);
      const from = inView(text('from', s, `${name}.from`));
      return { from, ...(s.where === undefined ? {} : { where: text('where', s, `${name}.where`) }) };
    };
    const left = selector('left');
    const right = selector('right');
    const on = data.on;
    if (!isTextList(on) || on.length !== 2) return refuse('needs on as two key expressions, one for each side');
    const unmatched = data.unmatched;
    if (unmatched !== undefined && !UNMATCHED.includes(unmatched as Unmatched)) {
      refuse(`needs unmatched as one of ${UNMATCHED.map((u) => JSON.stringify(u)).join(', ')}`);
    }
    return {
      ...common,
      shape: 'pair',
      quantifier: quantifier as Exclude<Quantifier, 'count'>,
      left,
      right,
      on: [on[0] as string, on[1] as string],
      ...optional('usable'),
      holds: text('holds'),
      ...(unmatched !== undefined ? { unmatched: unmatched as Unmatched } : {}),
      ...tail,
    };
  }
  return {
    ...common,
    shape: 'set',
    from: inView(text('from')),
    ...optional('where'),
    ...optional('usable'),
    ...(quantifier === 'count' ? { quantifier, count: text('count') } : { quantifier, holds: text('holds') }),
    ...tail,
  } as SetClaim;
}

function readNeeds(value: unknown, refuse: (why: string) => never): Needs {
  if (!isPlainObject(value)) return refuse('needs needs as an object');
  const unknown = unknownKey(value, NEEDS_KEYS);
  if (unknown !== undefined) refuse(`has an unknown key ${JSON.stringify(`needs.${unknown}`)}`);
  if (!isTextList(value.kinds)) refuse('needs needs.kinds as a list of text');
  if (value.inputs !== undefined && !isTextList(value.inputs)) refuse('needs needs.inputs as a list of text');
  if (value.effect !== undefined && !EFFECT_CLASSES.includes(value.effect as EffectClass)) {
    refuse(`needs needs.effect as one of ${EFFECT_CLASSES.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  return {
    ...(value.inputs !== undefined ? { inputs: [...(value.inputs as string[])] } : {}),
    ...(value.effect !== undefined ? { effect: value.effect as EffectClass } : {}),
    kinds: [...(value.kinds as string[])],
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
