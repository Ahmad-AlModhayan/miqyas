// SPDX-License-Identifier: AGPL-3.0-only
// The CEL module of the kernel imports nothing outside the kernel except the CEL library, and uses no API that
// exists only in Node, so it can run in a browser, a worker or another runtime (docs/FOUNDATION.md §14).
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const KERNEL = new URL('../../src/kernel/', import.meta.url);
const CEL_FILES = ['cel.ts', 'cel-static.ts', 'normalize.ts'];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function importsOf(source: string): string[] {
  const found = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] as string);
  return found;
}

const NODE_ONLY = [
  /\bprocess\b/,
  /\bBuffer\b/,
  /\brequire\s*\(/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\bsetImmediate\b/,
  /\bqueueMicrotask\b/,
  /\bperformance\b/,
  /\bDate\b/,
  /\bMath\.random\b/,
  /\bAbortSignal\b/,
];

function violations(source: string): string[] {
  const code = stripComments(source);
  const bad: string[] = [];
  for (const spec of importsOf(code)) {
    const own = spec.startsWith('./') && !spec.startsWith('./../');
    if (!own && spec !== '@bufbuild/cel') bad.push(`imports ${spec}`);
    if (spec.startsWith('node:')) bad.push(`imports ${spec}`);
  }
  for (const pattern of NODE_ONLY) if (pattern.test(code)) bad.push(`uses ${pattern.source}`);
  return bad;
}

describe('the CEL module is portable', () => {
  it('notices what it is looking for', () => {
    const sample = "import fs from 'node:fs';\nimport x from '../protocol/worker.js';\nsetTimeout(() => process.exit(), 1);\nBuffer.from('a');\nconst now = new Date();";
    expect(violations(sample)).toEqual(
      expect.arrayContaining([
        'imports node:fs',
        'imports ../protocol/worker.js',
        'uses \\bprocess\\b',
        'uses \\bsetTimeout\\b',
        'uses \\bBuffer\\b',
        'uses \\bDate\\b',
      ]),
    );
    expect(violations("// uses process and Date\nimport { a } from './own.js';\nexport const b = a;")).toEqual([]);
  });

  it('knows every file of the module', () => {
    const present = readdirSync(KERNEL).filter((name) => name.endsWith('.ts'));
    for (const file of CEL_FILES) expect(present).toContain(file);
  });

  for (const file of CEL_FILES) {
    it(`${file} imports only the kernel and the CEL library, and uses no Node-only API or clock`, () => {
      expect(violations(readFileSync(new URL(file, KERNEL), 'utf8'))).toEqual([]);
    });
  }

  it('is as deterministic as its inputs: the same expression and variables give the same answer every time', async () => {
    const { compile, evaluate } = await import('../../src/kernel/cel.js');
    const rule = compile('item.rows.all(r, r.size() > 0) && normalize(item.name) == "a"');
    const variables = { item: { rows: ['x', 'y'], name: ' A ' } };
    const answers = new Set(Array.from({ length: 50 }, () => evaluate(rule, variables)));
    expect([...answers]).toEqual(['true']);
  });
});
