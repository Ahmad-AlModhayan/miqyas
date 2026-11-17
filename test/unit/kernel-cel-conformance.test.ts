// SPDX-License-Identifier: AGPL-3.0-only
// The CEL conformance suite, the part of it inside the subset Miqyas allows, run through the kernel's own interface
// against the chosen library. The data and where it comes from: test/conformance/cel/README.md.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type CelValue, CEL_LIBRARY, compile, evaluateValue } from '../../src/kernel/cel.js';

/** A value in the suite's JSON form (the protobuf JSON form of `cel.expr.Value`). */
interface SuiteValue {
  int64Value?: string;
  stringValue?: string;
  boolValue?: boolean;
  nullValue?: null;
  listValue?: { values?: SuiteValue[] };
  mapValue?: { entries?: Array<{ key: SuiteValue; value: SuiteValue }> };
}

interface SuiteTest {
  section: string;
  name: string;
  expr: string;
  bindings?: Record<string, SuiteValue>;
  value?: SuiteValue;
  error?: true;
}

const suite = JSON.parse(readFileSync(new URL('../conformance/cel/subset.json', import.meta.url), 'utf8')) as {
  tests: SuiteTest[];
};

/** A value the way a fact holds it: whole numbers are bigint, a map with text keys is a plain object. */
function asVariable(value: SuiteValue): unknown {
  if (value.int64Value !== undefined) return BigInt(value.int64Value);
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if ('nullValue' in value) return null;
  if (value.listValue !== undefined) return (value.listValue.values ?? []).map(asVariable);
  if (value.mapValue !== undefined) {
    return Object.fromEntries((value.mapValue.entries ?? []).map((entry) => [entry.key.stringValue, asVariable(entry.value)]));
  }
  throw new Error(`a value outside the subset: ${JSON.stringify(value)}`);
}

/** The value a result must be, in the form the kernel returns it: a map is a Map. */
function asResult(value: SuiteValue): CelValue {
  if (value.int64Value !== undefined) return BigInt(value.int64Value);
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if ('nullValue' in value) return null;
  if (value.listValue !== undefined) return (value.listValue.values ?? []).map(asResult);
  if (value.mapValue !== undefined) {
    return new Map(
      (value.mapValue.entries ?? []).map((entry) => [asResult(entry.key) as string | bigint | boolean, asResult(entry.value)]),
    );
  }
  throw new Error(`a value outside the subset: ${JSON.stringify(value)}`);
}

// The suite's tests of parsing deep and long expressions are about the library; the kernel's own limits have their
// own tests, so they are raised here (the cost bound too) to let those expressions through.
const RAISED_LIMITS = {
  maxLength: 100_000,
  maxDepth: 1_000,
  maxComprehensionDepth: 100,
  maxListLength: 100_000,
  maxStringLength: 100_000,
  maxInputSize: 1_000_000,
  maxCost: Number.MAX_SAFE_INTEGER,
};

describe('the CEL conformance suite, the subset Miqyas allows, against the chosen library', () => {
  it('records which library and version it ran against', () => {
    const lock = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(CEL_LIBRARY).toEqual({ name: '@bufbuild/cel', version: lock.dependencies['@bufbuild/cel'] });
  });

  it('holds the tests the data file says it holds', () => {
    expect(suite.tests.length).toBe(468);
    const readme = readFileSync(new URL('../conformance/cel/README.md', import.meta.url), 'utf8');
    expect(readme.replace(/\s+/g, ' ')).toContain(`The file holds ${suite.tests.length} cases`);
    const sections = new Set(suite.tests.map((test) => test.section.split('/')[0]));
    for (const section of ['basic', 'comparisons', 'integer_math', 'lists', 'logic', 'macros', 'string', 'fields']) {
      expect(sections.has(section), section).toBe(true);
    }
  });

  for (const test of suite.tests) {
    it(`${test.section}: ${test.name}`, () => {
      const variables = Object.fromEntries(Object.entries(test.bindings ?? {}).map(([name, value]) => [name, asVariable(value)]));
      const outcome = evaluateValue(compile(test.expr, RAISED_LIMITS), variables);
      if (test.error === true) {
        expect(outcome.ok).toBe(false);
      } else {
        expect(outcome).toEqual({ ok: true, value: asResult(test.value as SuiteValue) });
      }
    });
  }
});
