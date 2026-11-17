#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Static one-way layer boundary checker for Miqyas source modules.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The folders of docs/FOUNDATION.md §14, in the order it lists them.
const FOUNDATION_FOLDERS = [
  'kernel',
  'protocol',
  'scrub',
  'surfaces',
  'gate',
  'engine',
  'model',
  'experiment',
  'capsule',
  'measure',
  'explore',
  'assure',
  'diagnose',
  'collectors',
  'claims',
  'agents',
  'bench',
  'entry',
];

// The rules §14 states one by one: what each of these may import besides itself. `cli` is `src/cli.ts`.
const STATED_RULES = {
  protocol: [],
  scrub: [],
  surfaces: ['protocol', 'scrub'],
  kernel: ['protocol'],
  cli: ['protocol'],
};

// "Those four" of §14: what every folder without a stated rule may import, wherever it is in the order.
const IMPORTABLE_BY_THE_REST = ['protocol', 'scrub', 'surfaces', 'kernel'];

// The folders of the layout before the foundation, with the rules they had. These hold until the code in
// them moves (FOUNDATION §15). `agents` and `entry` are in both layouts and take both sets of rules.
const EARLIER_RULES = {
  adapters: ['protocol', 'scrub', 'surfaces'],
  agents: ['protocol', 'scrub', 'surfaces'],
  'proof-core': ['protocol', 'scrub', 'surfaces', 'adapters', 'agents'],
  entry: ['protocol', 'scrub', 'surfaces', 'adapters', 'agents', 'proof-core'],
};

function buildAllowedLayers() {
  const imports = { ...STATED_RULES };
  FOUNDATION_FOLDERS.forEach((folder, i) => {
    if (Object.hasOwn(STATED_RULES, folder)) return;
    // No stated rule: the folder may import those four and every folder §14 lists above it.
    imports[folder] = [...IMPORTABLE_BY_THE_REST, ...FOUNDATION_FOLDERS.slice(0, i)];
  });
  for (const [folder, earlier] of Object.entries(EARLIER_RULES)) {
    imports[folder] = [...(imports[folder] ?? []), ...earlier];
  }
  return Object.fromEntries(Object.entries(imports).map(([layer, list]) => [layer, new Set([layer, ...list])]));
}

/** Layer name to the set of layers it may import, itself included. */
const ALLOWED_LAYERS = buildAllowedLayers();

/** Every folder under `src/` that the check knows, for its messages. */
const DECLARED_FOLDERS = Object.keys(ALLOWED_LAYERS).filter((layer) => layer !== 'cli');

const VENDOR_LAYER_ONLY = {
  playwright: 'surfaces',
  'axe-core': 'surfaces',
  '@anthropic-ai/sdk': 'agents',
  'libpg-query': 'adapters',
};

// Paths whose files may import only other files by a relative path: no npm package and no built-in, `node:`
// or not. The deciding half of the gate (FOUNDATION §6) is data and pure functions, and this is how the lint
// shows it. Imports of a relative path still follow the layer rules above.
const NO_BARE_IMPORTS_UNDER = ['src/gate/decide/'];

function normalizePosix(p) {
  return p.split(path.sep).join('/');
}

/** Map a `src/...` path to its architectural layer name, or null if outside known layers. */
export function layerOf(filePath) {
  const norm = normalizePosix(filePath);
  const idx = norm.lastIndexOf('src/');
  const rel = idx >= 0 ? norm.slice(idx + 4) : norm;
  if (rel === 'cli.ts') return 'cli';
  const [top] = rel.split('/');
  if (top && Object.hasOwn(ALLOWED_LAYERS, top)) return top;
  return null;
}

/**
 * Strip comments and literal contents except string tokens that sit in import/export/require positions.
 * Simpler and exact: tokenize JS/TS cleanly into non-comment/non-string code + string tokens, then scan
 * code+string patterns for `import ... from 'x'`, `import 'x'`, `export ... from 'x'`, `import('x')`, `require('x')`.
 */
export function extractImports(source) {
  const tokens = [];

  const tokenize = (chunk) => {
    let i = 0;
    const n = chunk.length;
    let codeBuf = '';

    const flushCode = () => {
      if (codeBuf) {
        tokens.push({ kind: 'code', value: codeBuf });
        codeBuf = '';
      }
    };

    while (i < n) {
      const ch = chunk[i];
      const next = chunk[i + 1];

      // Line comment
      if (ch === '/' && next === '/') {
        flushCode();
        i += 2;
        while (i < n && chunk[i] !== '\n') i++;
        continue;
      }
      // Block comment
      if (ch === '/' && next === '*') {
        flushCode();
        i += 2;
        while (i < n && !(chunk[i] === '*' && chunk[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      // Single/double string literal
      if (ch === "'" || ch === '"') {
        flushCode();
        const quote = ch;
        i++;
        let val = '';
        while (i < n && chunk[i] !== quote) {
          if (chunk[i] === '\\' && i + 1 < n) {
            val += chunk[i + 1];
            i += 2;
            continue;
          }
          val += chunk[i];
          i++;
        }
        i++;
        tokens.push({ kind: 'str', value: val });
        continue;
      }
      // Template literal: ignore literal text while tokenizing embedded `${...}` expressions recursively.
      if (ch === '`') {
        flushCode();
        i++;
        while (i < n && chunk[i] !== '`') {
          if (chunk[i] === '\\' && i + 1 < n) {
            i += 2;
            continue;
          }
          if (chunk[i] === '$' && chunk[i + 1] === '{') {
            i += 2;
            let depth = 1;
            const start = i;
            while (i < n && depth > 0) {
              if (chunk[i] === '{') depth++;
              else if (chunk[i] === '}') depth--;
              i++;
            }
            tokens.push({ kind: 'code', value: ' ' });
            tokenize(chunk.slice(start, i - 1));
            tokens.push({ kind: 'code', value: ' ' });
            continue;
          }
          i++;
        }
        i++;
        tokens.push({ kind: 'code', value: ' ' });
        continue;
      }

      codeBuf += ch;
      i++;
    }
    flushCode();
  };

  tokenize(source);

  // Build normalized stream replacing string literals with placeholder markers pointing to their values.
  const strings = [];
  let normalized = '';
  for (const t of tokens) {
    if (t.kind === 'str') {
      const idx = strings.push(t.value) - 1;
      normalized += `\u0000${idx}\u0000`;
    } else {
      normalized += t.value;
    }
  }

  const found = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s*\u0000(\d+)\u0000/g,
    /(?:^|[;\n}])\s*import\s*\u0000(\d+)\u0000/g,
    /\b(?:import|require)\s*\(\s*\u0000(\d+)\u0000\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of normalized.matchAll(re)) {
      const idx = Number(m[1]);
      if (strings[idx] !== undefined) found.push(strings[idx]);
    }
  }
  return [...new Set(found)];
}

/** Check a single source file's imports against the one-way architecture rules. */
export function checkSourceImports(filePath, source) {
  const norm = normalizePosix(filePath);
  const srcIdx = norm.lastIndexOf('src/');
  const rel = srcIdx >= 0 ? norm.slice(srcIdx) : norm;
  const fromLayer = layerOf(rel);
  const violations = [];

  if (!fromLayer) {
    violations.push({
      file: rel,
      specifier: '',
      reason: `file is outside the declared layers (${DECLARED_FOLDERS.join(', ')}, or src/cli.ts)`,
    });
    return violations;
  }

  const fileDir = path.posix.dirname(rel);
  const allowed = ALLOWED_LAYERS[fromLayer];

  const bareImportsRefused = NO_BARE_IMPORTS_UNDER.some((prefix) => rel.startsWith(prefix));

  for (const spec of extractImports(source)) {
    if (bareImportsRefused && !spec.startsWith('.')) {
      violations.push({
        file: rel,
        specifier: spec,
        reason: `files under ${NO_BARE_IMPORTS_UNDER.find((p) => rel.startsWith(p))} may import no package and no built-in, only relative paths`,
      });
    }

    // Check vendor isolation rules
    for (const [pkg, requiredLayer] of Object.entries(VENDOR_LAYER_ONLY)) {
      if ((spec === pkg || spec.startsWith(`${pkg}/`)) && fromLayer !== requiredLayer) {
        violations.push({
          file: rel,
          specifier: spec,
          reason: `vendor package "${pkg}" may only be imported by layer "${requiredLayer}", not "${fromLayer}"`,
        });
      }
    }

    // Check internal relative imports inside src/
    if (spec.startsWith('.')) {
      const resolved = path.posix.normalize(path.posix.join(fileDir, spec)).replace(/\.(mjs|js|ts|mts|cts)$/, '.ts');
      if (resolved.startsWith('src/')) {
        const targetLayer = layerOf(resolved);
        if (!targetLayer) {
          violations.push({
            file: rel,
            specifier: spec,
            reason: `imports "${resolved}" which is outside declared layers`,
          });
        } else if (!allowed.has(targetLayer)) {
          violations.push({
            file: rel,
            specifier: spec,
            reason: `layer "${fromLayer}" cannot import layer "${targetLayer}" (${resolved})`,
          });
        }
      } else {
        violations.push({
          file: rel,
          specifier: spec,
          reason: `source module cannot reach outside src/ (${resolved})`,
        });
      }
    }
  }

  return violations;
}

async function listTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await listTsFiles(full)));
    else if (e.isFile() && /\.(ts|mts|cts)$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(full);
  }
  return files.sort();
}

export async function checkProjectBoundaries(rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const srcDir = path.join(rootDir, 'src');
  const files = await listTsFiles(srcDir);
  const all = [];
  for (const file of files) {
    const rel = normalizePosix(path.relative(rootDir, file));
    const text = await readFile(file, 'utf8');
    all.push(...checkSourceImports(rel, text));
  }
  return all;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const violations = await checkProjectBoundaries();
  if (violations.length) {
    for (const v of violations) {
      process.stderr.write(`boundary error: ${v.file}${v.specifier ? ` (${v.specifier})` : ''}: ${v.reason}\n`);
    }
    process.stderr.write(`\nFound ${violations.length} layer boundary violation(s).\n`);
    process.exit(1);
  }
  process.stdout.write('ok: all source imports respect one-way layer boundaries.\n');
}
