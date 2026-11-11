// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Test helpers: a method block for reports built in tests, and the report schemas (schema/*.schema.json) in Ajv.

import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { environment, type Method } from '../src/core/report.js';

export function testMethod(scrub: Partial<Method['scrub']> = {}): Method {
  return {
    ...environment(null),
    model: null,
    settings: { concurrency: 1, viewport: { width: 1280, height: 800 }, timeouts: { planMs: 600_000, navigationMs: 30_000, actionMs: 5000 }, allowOtherOrigins: false, headed: false },
    preset: null,
    scrub: { file: null, sha256: null, terms: 0, ...scrub },
  };
}

const schema = (name: string) => JSON.parse(readFileSync(new URL(`../schema/${name}.schema.json`, import.meta.url), 'utf8'));
// Formats (date-time, uri) stay annotations: Ajv would need ajv-formats to check them.
const ajv = new Ajv2020({ allErrors: true, validateFormats: false }).addSchema(schema('report')).addSchema(schema('mutation-report'));

/** Schema errors for a report, as readable lines; empty when it validates. */
export function schemaErrors(kind: 'report' | 'mutation-report', report: unknown): string[] {
  const validate = ajv.getSchema(`https://miqyas.kahflabs.com/schema/${kind}.schema.json`)!;
  return validate(report) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}
