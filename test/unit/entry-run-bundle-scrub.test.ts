// SPDX-License-Identifier: AGPL-3.0-only
// A real `run --proof-bundle` scrubs its bundle (docs/FOUNDATION.md §3, "Safe to keep"): the terms of --scrub and every
// secret value the plans name are in no ledger line and no blob, as typed or as a URL carries them, and the bundle
// still verifies. Driven through `main`; only the browser is stood in for, so that no Chromium starts.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/surfaces/web/driver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openWebSurfaceDriver: async () => ({
    surface: 'web',
    version: 'stand-in-1',
    openSession: async () => {
      throw new Error('the stand-in browser opens no page');
    },
    close: async () => {},
  }),
}));

const { main } = await import('../../src/entry/cli.js');

/** A made-up organisation name, a space in it so that a URL carries it percent-encoded. */
const TERM = 'Quxvane Orchard';
const ENCODED = encodeURIComponent(TERM);
const SECRET = 'qv-made-up-secret-7731';

let tmp: string;
const saved = process.env.MIQYAS_SECRET_QVTOKEN;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-run-scrub-'));
  process.env.MIQYAS_SECRET_QVTOKEN = SECRET;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (errors.push(String(chunk)), true));
});
const errors: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.MIQYAS_SECRET_QVTOKEN;
  else process.env.MIQYAS_SECRET_QVTOKEN = saved;
  await rm(tmp, { recursive: true, force: true });
});

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

describe('run --proof-bundle --scrub', () => {
  it('writes no scrubbed term and no secret value into any file of the bundle, and the bundle verifies', async () => {
    const plan = path.join(tmp, 'plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        format: 'miqyas-plan',
        version: 1,
        id: 'qv',
        steps: [
          { id: 's1', type: 'action', text: `Open the ${TERM} page and type \${secret.QVTOKEN}` },
          { id: 'a1', type: 'assertion', text: "'Welcome'" },
        ],
      }),
    );
    const rules = path.join(tmp, 'made-up-scrub.json');
    await writeFile(rules, JSON.stringify({ terms: [{ from: TERM, to: 'ORG-A' }] }));
    // A repository whose one lockfile sits in a folder named for the term: check 13 lists it in its facts.
    const repo = path.join(tmp, 'repo');
    await mkdir(path.join(repo, TERM), { recursive: true });
    await writeFile(path.join(repo, TERM, 'package-lock.json'), JSON.stringify({ name: 'x', lockfileVersion: 3, packages: {} }));
    const out = path.join(tmp, 'run');

    const code = await main([
      'run',
      plan,
      '--profile',
      'grade-1',
      '--repo',
      repo,
      '--url',
      `http://127.0.0.1:9/${ENCODED}/${SECRET}/`,
      '--dry-run',
      '--scrub',
      rules,
      '--proof-bundle',
      '--out',
      out,
    ]);
    // A dry run whose page can't open ends with 3; the bundle is sealed all the same.
    expect(code, errors.join('')).toBe(3);
    expect(errors.join('')).not.toContain('Error:');

    // The bundle is the ledger, its checkpoints and its blobs: every file the store wrote.
    const bundle = (await filesUnder(out)).filter((f) => /^(ledger\.jsonl|checkpoint|blobs[\\/].*)$/.test(path.relative(out, f)));
    expect(bundle.map((f) => path.relative(out, f))).toContain('ledger.jsonl');
    for (const file of bundle) {
      const text = await readFile(file, 'utf8');
      expect(text.includes(TERM), `${path.relative(out, file)} holds the term`).toBe(false);
      expect(text.includes(ENCODED), `${path.relative(out, file)} holds the term percent-encoded`).toBe(false);
      expect(text.includes(SECRET), `${path.relative(out, file)} holds the secret value`).toBe(false);
    }
    // Check 13 ran, so its facts were scrubbed too, the lockfile's path among them.
    const ledger = await readFile(path.join(out, 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('ORG-A/package-lock.json');
    expect(ledger).toContain('${secret.QVTOKEN}');
    expect(await main(['verify', out]), errors.join('')).toBe(0);
  });
});
