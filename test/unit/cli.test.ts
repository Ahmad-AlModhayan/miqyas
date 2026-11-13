// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// CLI exit codes that need no browser (SRS FR-C1): 2 for a plan or usage error, 3 for a missing model key.
// Codes 0, 1 and 3 for a blocked run are in test/e2e/runner.test.ts, with a scripted agent.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordDailySpend } from '../../src/agents/spend.js';
import { main, loadCliEnv } from '../../src/cli.js';

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

  it('rejects invalid provider / missing OpenAI model (exit 2) and blocks missing OpenAI endpoint or public OpenAI credentials (exit 3)', async () => {
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--provider', 'bedrock'])).toBe(2);
    expect(
      await main(['run', good, '--url', 'http://127.0.0.1:9/', '--provider', 'openai', '--endpoint', 'http://127.0.0.1:11434/v1']),
    ).toBe(2);
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--provider', 'openai', '--model', 'qwen2.5-vl'])).toBe(3);
    expect(
      await main([
        'run',
        good,
        '--url',
        'http://127.0.0.1:9/',
        '--provider',
        'openai',
        '--endpoint',
        'https://llm.example.com/v1',
        '--model',
        'Qwen2.5-VL',
        '--out',
        path.join(tmp, 'pub-openai-nokey'),
      ]),
    ).toBe(3);
    expect(existsSync(path.join(tmp, 'pub-openai-nokey'))).toBe(false);

    // Public OpenAI-compatible endpoint even with key still refuses non-TTY CI runs.
    process.env.OPENAI_API_KEY = 'sk-public';
    try {
      expect(
        await main(
          [
            'run',
            good,
            '--url',
            'http://127.0.0.1:9/',
            '--provider',
            'openai',
            '--endpoint',
            'https://llm.example.com/v1',
            '--model',
            'Qwen2.5-VL',
            '--out',
            path.join(tmp, 'pub-openai-nontty'),
          ],
          { isTTY: false, spendDir: tmp },
        ),
      ).toBe(3);
      expect(existsSync(path.join(tmp, 'pub-openai-nontty'))).toBe(false);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('loadCliEnv imports only provider keys and MIQYAS_SECRET_* from .env without overriding shell or loading endpoint URLs', async () => {
    const envDir = path.join(tmp, 'env-wd');
    const prevCwd = process.cwd();
    const savedKeys = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      MIQYAS_PROVIDER: process.env.MIQYAS_PROVIDER,
      MIQYAS_SECRET_TOKEN: process.env.MIQYAS_SECRET_TOKEN,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.MIQYAS_PROVIDER;
    delete process.env.MIQYAS_SECRET_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'shell-wins';

    try {
      const { mkdir: mk } = await import('node:fs/promises');
      await mk(envDir, { recursive: true });
      await writeFile(
        path.join(envDir, '.env'),
        [
          'OPENAI_API_KEY=sk-from-dotenv',
          'ANTHROPIC_API_KEY=should-not-override',
          'MIQYAS_SECRET_TOKEN=tok-123',
          'OPENAI_BASE_URL=https://evil.example.com/v1',
          'ANTHROPIC_BASE_URL=https://evil.example.com',
          'MIQYAS_PROVIDER=openai',
        ].join('\n'),
      );
      process.chdir(envDir);
      loadCliEnv();
      expect(process.env.OPENAI_API_KEY).toBe('sk-from-dotenv');
      expect(process.env.ANTHROPIC_API_KEY).toBe('shell-wins');
      expect(process.env.MIQYAS_SECRET_TOKEN).toBe('tok-123');
      expect(process.env.OPENAI_BASE_URL).toBeUndefined();
      expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(process.env.MIQYAS_PROVIDER).toBeUndefined();
    } finally {
      process.chdir(prevCwd);
      for (const [k, v] of Object.entries(savedKeys)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('rejects conflicting --record/--replay flags (exit 2) and fails closed on missing or corrupt --replay cassette (exit 3)', async () => {
    const cas = path.join(tmp, 'missing-cas.jsonl');
    const badCas = path.join(tmp, 'corrupt-cas.jsonl');
    await writeFile(badCas, '{not json\n');

    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--record', cas, '--replay', cas])).toBe(2);
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--replay', cas, '--endpoint', 'http://127.0.0.1:8000/v1'])).toBe(2);
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--replay', cas, '--no-model'])).toBe(2);
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--replay', cas, '--dry-run'])).toBe(2);
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--record', cas, '--no-model'])).toBe(2);
    expect(await main(['bench', 'book', '--record', cas])).toBe(2);
    expect(await main(['bench', 'book', '--replay', cas])).toBe(2);

    const outMissing = path.join(tmp, 'out-missing-cas');
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--replay', cas, '--out', outMissing], { isTTY: false })).toBe(3);
    expect(existsSync(outMissing)).toBe(false);

    const mismatchCas = path.join(tmp, 'mismatch-cas.jsonl');
    await writeFile(
      mismatchCas,
      JSON.stringify({
        type: 'header',
        cassetteSchema: 1,
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        tier: 'low',
        effort: 'medium',
        createdAt: new Date().toISOString(),
      }) + '\n',
    );
    const outMismatch = path.join(tmp, 'out-mismatch-cas');
    expect(
      await main(['run', good, '--url', 'http://127.0.0.1:9/', '--replay', mismatchCas, '--provider', 'openai', '--out', outMismatch], {
        isTTY: false,
      }),
    ).toBe(3);
    expect(existsSync(outMismatch)).toBe(false);
    expect(
      await main(['run', good, '--url', 'http://127.0.0.1:9/', '--replay', mismatchCas, '--effort', 'max', '--out', outMismatch], {
        isTTY: false,
      }),
    ).toBe(3);
    expect(existsSync(outMismatch)).toBe(false);

    const outBad = path.join(tmp, 'out-bad-cas');
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--replay', badCas, '--out', outBad], { isTTY: false })).toBe(3);
    expect(existsSync(outBad)).toBe(false);
  });

  it('prints help text documenting --strict and --fail-on modes and returns 0', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    try {
      expect(await main(['run', '--help'])).toBe(0);
      expect(chunks.join('')).toContain('--strict');
      expect(chunks.join('')).toContain('--fail-on');
    } finally {
      spy.mockRestore();
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    }
  });

  it('rejects invalid --fail-on severities with exit code 2 before creating an output directory', async () => {
    const badFailOnOut = path.join(tmp, 'out-bad-failon');
    expect(
      await main(['run', good, '--url', 'http://127.0.0.1:9/', '--dry-run', '--fail-on', 'severe', '--out', badFailOnOut]),
    ).toBe(2);
    expect(existsSync(badFailOnOut)).toBe(false);
  });

  it('documents --crawl, --active, --allow-host, and --allow-writes in help text', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    try {
      expect(await main(['run', '--help'])).toBe(0);
      const help = chunks.join('');
      expect(help).toContain('--crawl');
      expect(help).toContain('--active');
      expect(help).toContain('--allow-host');
      expect(help).toContain('--allow-writes');
    } finally {
      spy.mockRestore();
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    }
  });

  it('refuses --active on unverified non-test hosts and invalid crawl/write flag combinations with exit code 2 before creating --out', async () => {
    const outPublic = path.join(tmp, 'out-public-active');
    expect(await main(['run', good, '--url', 'https://victim.example/', '--active', '--no-model', '--out', outPublic])).toBe(2);
    expect(existsSync(outPublic)).toBe(false);

    const outBadToken = path.join(tmp, 'out-bad-token');
    expect(
      await main(
        ['run', good, '--url', 'https://victim.example/', '--active', '--allow-host', 'victim.example', '--no-model', '--out', outBadToken],
        {
          hostPolicyDeps: {
            spendDir: path.join(tmp, 'host-tokens-dir'),
            fetchImpl: async () => new Response('not found', { status: 404 }),
            resolveTxtImpl: async () => [],
          },
        },
      ),
    ).toBe(2);
    expect(existsSync(outBadToken)).toBe(false);

    const outWriteNoActive = path.join(tmp, 'out-write-no-active');
    expect(await main(['run', good, '--url', 'http://127.0.0.1:9/', '--allow-writes', '--no-model', '--out', outWriteNoActive])).toBe(2);
    expect(existsSync(outWriteNoActive)).toBe(false);

    const outCrawlOtherOrigin = path.join(tmp, 'out-crawl-other-origin');
    expect(
      await main(['run', '--crawl', '--url', 'http://127.0.0.1:9/', '--allow-other-origins', '--no-model', '--out', outCrawlOtherOrigin]),
    ).toBe(2);
    expect(existsSync(outCrawlOtherOrigin)).toBe(false);

    const outBadMaxScreens = path.join(tmp, 'out-bad-max-screens');
    expect(
      await main(['run', '--crawl', '--max-screens', '0', '--url', 'http://127.0.0.1:9/', '--no-model', '--out', outBadMaxScreens]),
    ).toBe(2);
    expect(existsSync(outBadMaxScreens)).toBe(false);
  });

  it('validates corpus manifests with miqyas lint --corpus and rejects leaked unasserted seeds with exit code 2', async () => {
    expect(await main(['lint', '--corpus', 'corpus/mini-shop'])).toBe(0);

    const badCorpusDir = path.join(tmp, 'bad-corpus');
    const badPlansDir = path.join(badCorpusDir, 'plans');
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(badPlansDir, { recursive: true });
      await fs.mkdir(path.join(badCorpusDir, 'clean'), { recursive: true });
      await fs.writeFile(
        path.join(badCorpusDir, 'known.json'),
        JSON.stringify({ version: 1, target: 'bad', buildId: 'b1', reviewedAt: '2026-11-13T00:00:00Z', reviewer: 'Kahf Labs', entries: [] }),
      );
      await fs.writeFile(
        path.join(badPlansDir, 'p1.json'),
        JSON.stringify({
          format: 'miqyas-plan',
          version: 1,
          id: 'p1',
          steps: [{ id: 'a1', type: 'assertion', text: 'Check SECRET_LEAK_TOKEN_99 is absent' }],
        }),
      );
      await fs.writeFile(
        path.join(badCorpusDir, 'seeds.json'),
        JSON.stringify({
          version: 1,
          target: 'bad',
          cleanTwin: { buildDir: path.join(badCorpusDir, 'clean'), knownFindings: path.join(badCorpusDir, 'known.json') },
          seeds: [
            {
              id: 'u1',
              title: 'Secret leak',
              part: 'unasserted',
              category: 'secret-leak',
              blindTokens: ['SECRET_LEAK_TOKEN_99'],
              mutation: { kind: 'string-swap', from: 'ok', to: 'SECRET_LEAK_TOKEN_99' },
              probe: { measure: 'text', expectClean: 'ok', expectSeed: 'SECRET_LEAK_TOKEN_99' },
            },
          ],
        }),
      );
    });

    expect(await main(['lint', '--corpus', badCorpusDir])).toBe(2);
    expect(await main(['lint', '--corpus', path.join(tmp, 'nonexistent-corpus')])).toBe(2);
    expect(await main(['run', good, '--corpus', 'corpus/mini-shop', '--url', 'http://127.0.0.1:9/', '--dry-run'])).toBe(2);
  });

  it('rejects unknown --profile, invalid --repo, and --profile grade-1 + --allow-other-origins with exit code 2 before creating --out', async () => {
    const outBadProfile = path.join(tmp, 'out-bad-profile');
    expect(
      await main(['run', '--profile', 'grade-9', '--url', 'http://127.0.0.1:9/', '--no-model', '--out', outBadProfile]),
    ).toBe(2);
    expect(existsSync(outBadProfile)).toBe(false);

    const outBadRepo = path.join(tmp, 'out-bad-repo');
    expect(
      await main([
        'run',
        '--profile',
        'grade-1',
        '--url',
        'http://127.0.0.1:9/',
        '--repo',
        path.join(tmp, 'does-not-exist'),
        '--no-model',
        '--out',
        outBadRepo,
      ]),
    ).toBe(2);
    expect(existsSync(outBadRepo)).toBe(false);

    const outOtherOrigins = path.join(tmp, 'out-grade1-other-origins');
    expect(
      await main([
        'run',
        '--profile',
        'grade-1',
        '--url',
        'http://127.0.0.1:9/',
        '--allow-other-origins',
        '--no-model',
        '--out',
        outOtherOrigins,
      ]),
    ).toBe(2);
    expect(existsSync(outOtherOrigins)).toBe(false);
  });

  it('doctor lists gitleaks and osv-scanner status on stdout', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    try {
      const code = await main(['doctor']);
      expect([0, 3]).toContain(code);
      const out = chunks.join('');
      expect(out).toContain('gitleaks');
      expect(out).toContain('osv-scanner');
      expect(out).toContain('offline DB');
      expect(out).toContain('update-db');
    } finally {
      spy.mockRestore();
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    }
  });

  it('update-db downloads OSV zips from fixture server, logs contacted URLs, and exits 3 on server failure', async () => {
    let status = 200;
    const requested: string[] = [];
    const server = http.createServer((req, res) => {
      requested.push(req.url ?? '');
      if (status !== 200) {
        res.statusCode = status;
        res.end('fail');
        return;
      }
      res.statusCode = 200;
      res.end(Buffer.from('PK\x03\x04dummy-osv-zip'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const dbDir = path.join(tmp, 'osv-cache');
    mkdirSync(dbDir, { recursive: true });
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });

    try {
      const codeOk = await main(
        ['update-db', '--ecosystems', 'npm', '--db-dir', dbDir, '--json'],
        { osvBaseUrl: baseUrl },
      );
      expect(codeOk).toBe(0);
      expect(requested).toEqual(['/npm/all.zip']);
      const parsed = JSON.parse(chunks.join('')) as {
        logFile: string;
        entries: Array<{ ecosystem: string; url: string; destination: string; status: string }>;
      };
      expect(parsed.entries.map((e) => e.url)).toEqual([`${baseUrl}/npm/all.zip`]);
      expect(parsed.entries[0]?.status).toBe('ok');
      expect(existsSync(parsed.entries[0]!.destination)).toBe(true);
      expect(readFileSync(parsed.logFile, 'utf8')).toContain(`${baseUrl}/npm/all.zip`);

      expect(await main(['update-db', '--ecosystems', '..', '--db-dir', dbDir], { osvBaseUrl: baseUrl })).toBe(2);
      expect(await main(['update-db', '--db-dir', '   '], { osvBaseUrl: baseUrl })).toBe(2);

      status = 500;
      const codeFail = await main(
        ['update-db', '--ecosystems', 'npm', '--db-dir', dbDir],
        { osvBaseUrl: baseUrl },
      );
      expect(codeFail).toBe(3);
    } finally {
      spy.mockRestore();
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
