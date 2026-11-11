// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// CLI exit codes that need no browser (SRS FR-C1): 2 for a plan or usage error, 3 for a missing model key.
// Codes 0, 1 and 3 for a blocked run are in test/e2e/runner.test.ts, with a scripted agent.

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';

let tmp: string;
let good: string;
let bad: string;
const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN };

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-cli-'));
  good = path.join(tmp, 'good.json');
  bad = path.join(tmp, 'bad.json');
  await writeFile(good, JSON.stringify({ format: 'miqyas-plan', version: 1, id: 'good', steps: [{ id: 's1', type: 'action', text: 'Open' }, { id: 'a1', type: 'assertion', text: "'Folder pairs'" }] }));
  await writeFile(bad, JSON.stringify({ format: 'miqyas-plan', version: 1, id: 'bad', steps: [{ id: 's1', type: 'nonsense', text: 'x' }] }));
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterAll(async () => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  await rm(tmp, { recursive: true, force: true });
});

describe('CLI exit codes', () => {
  it('2 for a usage error', async () => {
    expect(await main([])).toBe(2);
    expect(await main(['frobnicate'])).toBe(2);
    expect(await main(['run', good, '--no-such-flag'])).toBe(2);
    expect(await main(['run', good])).toBe(2);
    expect(await main(['run', good, '--url', 'not a url'])).toBe(2);
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--dry-run', '--concurrency', '0', '--out', path.join(tmp, 'c0')])).toBe(2);
  });

  it('2 for a plan error, before any page is opened', async () => {
    expect(await main(['run', bad, '--url', 'http://127.0.0.1:9/', '--out', path.join(tmp, 'bad')])).toBe(2);
    expect(await main(['run', path.join(tmp, 'missing.json'), '--url', 'http://127.0.0.1:9/', '--out', path.join(tmp, 'missing')])).toBe(2);
    expect(await main(['lint', bad])).toBe(2);
    expect(await main(['lint', good])).toBe(0);
  });

  it('3 when a live run has no model key', async () => {
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--out', path.join(tmp, 'nokey')])).toBe(3);
    // The key is checked before the run folder is made, so a failed start leaves nothing behind.
    expect(existsSync(path.join(tmp, 'nokey'))).toBe(false);
    const preset = path.join(tmp, 'preset.json');
    await writeFile(preset, JSON.stringify({ name: 'p', mutations: [{ id: 'm1', title: 't', kind: 'css', css: 'h1{display:none}', plan: 'good', assertion: 'a1' }] }));
    expect(await main(['mutate', good, '--build', tmp, '--preset', preset, '--out', path.join(tmp, 'nokey-mutate')])).toBe(3);
    expect(existsSync(path.join(tmp, 'nokey-mutate'))).toBe(false);
  });
});
