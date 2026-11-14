// SPDX-License-Identifier: Apache-2.0
// Verifies per-file SPDX-License-Identifier headers match the decoupled open-core boundary.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const APACHE_PREFIXES = ['src/protocol/', 'src/scrub/', 'src/surfaces/', 'scripts/'];
const AGPL_PREFIXES = ['src/adapters/', 'src/agents/', 'src/proof-core/', 'src/entry/', 'test/'];

export function expectedSpdxForFile(filePath) {
  const norm = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (norm === 'src/cli.ts' || APACHE_PREFIXES.some((p) => norm.startsWith(p))) {
    return 'Apache-2.0';
  }
  if (norm === 'vitest.config.ts' || AGPL_PREFIXES.some((p) => norm.startsWith(p))) {
    return 'AGPL-3.0-only';
  }
  return null;
}

export function extractSpdxHeader(source) {
  const head = source.split(/\r?\n/, 5);
  for (const line of head) {
    const match = line.match(/SPDX-License-Identifier:\s*([A-Za-z0-9.\-+]+)/);
    if (match) return match[1];
  }
  return null;
}

async function collectCodeFiles(dir, relBase, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collectCodeFiles(abs, rel, out);
    } else if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(rel);
    }
  }
}

export async function checkSpdxHeaders(
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
) {
  const files = ['vitest.config.ts'];
  await collectCodeFiles(path.join(rootDir, 'src'), 'src', files);
  await collectCodeFiles(path.join(rootDir, 'scripts'), 'scripts', files);
  await collectCodeFiles(path.join(rootDir, 'test'), 'test', files);

  const violations = [];
  for (const rel of files.sort()) {
    const expected = expectedSpdxForFile(rel);
    if (!expected) {
      violations.push({ file: rel, reason: 'File is not mapped to an Apache-2.0 or AGPL-3.0-only layer.' });
      continue;
    }
    const content = await readFile(path.join(rootDir, rel), 'utf8');
    const actual = extractSpdxHeader(content);
    if (actual !== expected) {
      violations.push({
        file: rel,
        reason: `Expected "SPDX-License-Identifier: ${expected}", found "${actual ?? 'none'}".`,
      });
    }
  }
  return violations;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const violations = await checkSpdxHeaders();
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(`${v.file}: ${v.reason}\n`);
    }
    process.exit(1);
  }
  process.stdout.write('ok: all source, script, and test SPDX headers match the open-core boundary.\n');
}
