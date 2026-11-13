// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// CLI exit codes that need no browser (SRS FR-C1): 2 for a plan or usage error, 3 for a missing model key.
// Codes 0, 1 and 3 for a blocked run are in test/e2e/runner.test.ts, with a scripted agent.

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordDailySpend } from '../../src/agents/spend.js';
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

  it('quote prints free offline likely/worst-case estimates, daily spend, and 90-day warning without network or key', async () => {
    const spendDir = path.join(tmp, 'spend-quote');
    await recordDailySpend({ spendDir, runId: 'prev', model: 'claude-haiku-5-5', usd: 2.5, now: new Date('2026-11-13T10:00:00Z') });
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    try {
      expect(
        await main(['quote', good, '--tier', 'medium'], { spendDir, now: () => new Date('2026-11-13T12:00:00Z') }),
      ).toBe(0);
      const outSameDay = chunks.join('');
      expect(outSameDay).toContain('claude-sonnet-5-5');
      expect(outSameDay).toContain('good');
      expect(outSameDay).toContain('$2.50 / $20.00 daily cap');

      chunks.length = 0;
      expect(
        await main(['quote', good, '--tier', 'medium'], { spendDir, now: () => new Date('2027-02-01T00:00:00Z') }),
      ).toBe(0);
      expect(chunks.join('')).toContain('WARNING:');

      chunks.length = 0;
      expect(await main(['quote', good, '--no-model', '--json'], { spendDir, now: () => new Date('2026-11-13T10:00:00Z') })).toBe(0);
      const parsed = JSON.parse(chunks.join(''));
      expect(parsed).toMatchObject({ noModel: true, likelyUsd: 0, worstCaseUsd: 0 });
    } finally {
      spy.mockRestore();
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    }
  });

  it('refuses billed cloud runs in non-TTY CI (exit 3) and rejects --live or invalid --tier (exit 2)', async () => {
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--live'])).toBe(2);
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--tier', 'mega'])).toBe(2);

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const spendDir = path.join(tmp, 'spend-nontty');
    const preset = path.join(tmp, 'preset2.json');
    await writeFile(preset, JSON.stringify({ name: 'p', mutations: [{ id: 'm1', title: 't', kind: 'css', css: 'h1{display:none}', plan: 'good', assertion: 'a1', probe: { measure: 'height', selector: 'h1' } }] }));
    try {
      expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--out', path.join(tmp, 'nontty-run')], { isTTY: false, spendDir })).toBe(3);
      expect(existsSync(path.join(tmp, 'nontty-run'))).toBe(false);
      expect(await main(['mutate', good, '--build', tmp, '--preset', preset, '--out', path.join(tmp, 'nontty-mut')], { isTTY: false, spendDir })).toBe(3);
      expect(existsSync(path.join(tmp, 'nontty-mut'))).toBe(false);
      // Unknown model pricing fails closed with exit 3 even when TTY is true
      expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--model', 'unknown-price-model', '--out', path.join(tmp, 'unk-model')], { isTTY: true, spendDir, promptCap: async () => '1' })).toBe(3);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('refuses interactive live start unless a valid numeric cap <= remaining daily cap is typed', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const spendDir = path.join(tmp, 'spend-prompt');
    await recordDailySpend({ spendDir, runId: 'prev', model: 'claude-haiku-5-5', usd: 15, now: new Date('2026-11-13T10:00:00Z') });
    const now = () => new Date('2026-11-13T12:00:00Z');
    try {
      for (const badAnswer of ['', 'yes', '0', '-2', '5.01']) {
        const errOut: string[] = [];
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
          errOut.push(String(c));
          return true;
        });
        try {
          const code = await main(
            ['run', good, '--url', 'http://127.0.0.1:9/', '--out', path.join(tmp, 'bad-cap')],
            { isTTY: true, spendDir, now, promptCap: async () => badAnswer },
          );
          expect(code).toBe(3);
          expect(errOut.join('')).toContain('Quote (claude-haiku-5-5)');
          expect(existsSync(path.join(tmp, 'bad-cap'))).toBe(false);
        } finally {
          spy.mockRestore();
          vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        }
      }
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
