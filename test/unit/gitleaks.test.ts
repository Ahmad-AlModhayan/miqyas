// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyGitleaksRule,
  decodeJwtRole,
  detectKnownSecretFormats,
  probeGitleaksVersion,
  runGitleaksDir,
  runGitleaksGit,
} from '../../src/adapters/gitleaks.js';

const temps: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'miqyas-gitleaks-unit-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function makeJwt(payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.sigpart1234567890`;
}

describe('gitleaks adapter helpers', () => {
  it('decodes JWT role claims safely without throwing on malformed tokens', () => {
    const srvJwt = makeJwt({ role: 'service_role', iss: 'supabase' });
    const anonJwt = makeJwt({ role: 'anon', iss: 'supabase' });
    expect(decodeJwtRole(srvJwt)).toBe('service_role');
    expect(decodeJwtRole(anonJwt)).toBe('anon');
    expect(decodeJwtRole('eyJnot-a-valid-token')).toBeNull();
  });

  it('detects curated known key formats while sparing anon JWTs and public Firebase client keys', () => {
    const sbSecret = ['sb', 'secret', 'dummy0123456789abcdef'].join('_');
    const stripeLive = ['sk', 'live', '51H1234567890abcdefghijklmnop'].join('_');
    const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE2'].join('');
    const srvJwt = makeJwt({ role: 'service_role', ref: 'demo' });
    const anonJwt = makeJwt({ role: 'anon', ref: 'demo' });
    const firebaseKey = ['AIza', 'SyDummyClientConfigKey1234567890123456'].join('');

    const text = [
      `const a = "${sbSecret}";`,
      `const b = "${stripeLive}";`,
      `const c = "${awsKey}";`,
      `const d = "${srvJwt}";`,
      `const okAnon = "${anonJwt}";`,
      `const okFirebase = "${firebaseKey}";`,
    ].join('\n');

    const hits = detectKnownSecretFormats(text, 'bundle/app.js');
    const rules = hits.map((h) => h.ruleId);
    expect(rules).toContain('supabase-secret-key');
    expect(rules).toContain('stripe-live-key');
    expect(rules).toContain('aws-access-key');
    expect(rules).toContain('supabase-service-role-jwt');
    expect(hits).toHaveLength(4);
    for (const h of hits) {
      expect(h.knownFormat).toBe(true);
      expect(h.evidence).not.toContain(sbSecret);
      expect(h.evidence).not.toContain(stripeLive);
      expect(h.evidence).not.toContain(awsKey);
      expect(h.evidence).not.toContain(srvJwt);
    }
  });

  it('classifies known secret gitleaks rules apart from generic matches', () => {
    expect(classifyGitleaksRule('aws-access-token')).toBe('known');
    expect(classifyGitleaksRule('stripe-access-token')).toBe('known');
    expect(classifyGitleaksRule('private-key')).toBe('known');
    expect(classifyGitleaksRule('github-pat')).toBe('known');
    expect(classifyGitleaksRule('generic-api-key')).toBe('generic');
    expect(classifyGitleaksRule('jwt')).toBe('generic');
  });

  it('probes version and reports missing gitleaks binaries cleanly', async () => {
    const dir = makeTmpDir();
    const missingEnv = { ...process.env, PATH: dir };
    expect(await probeGitleaksVersion({ env: missingEnv })).toBeNull();
    const missingScan = await runGitleaksDir(dir, { env: missingEnv });
    expect(missingScan.status).toBe('missing');
    expect(missingScan.version).toBeNull();
  });

  it('masks raw secret tokens before applying substring scrub rules', () => {
    const raw = ['sb', 'secret', 'subtoken0123456789'].join('_');
    const partialHide = (t: string) => t.replace(/subtoken/g, '[redacted]');
    const hits = detectKnownSecretFormats(`const k = "${raw}";`, 'app.js', partialHide);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.evidence).not.toContain('0123456789');
    expect(hits[0]?.evidence).not.toContain('subtoken');
  });

  it('executes gitleaks dir & git with --redact, handles exit code 1 findings, and preserves generic vs known split', async () => {
    const dir = makeTmpDir();
    const binDir = path.join(dir, 'bin');
    const argsLog = path.join(dir, 'argv.log');
    const targetDir = path.join(dir, 'target');
    const fs = await import('node:fs');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    const shimPath = path.join(binDir, 'gitleaks');
    const shimScript = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'version') {
  process.stdout.write('8.30.1-shim\\n');
  process.exit(0);
}
const rpIdx = args.indexOf('--report-path');
const rp = rpIdx >= 0 ? args[rpIdx + 1] : null;
const mode = args[0];
if (rp) {
  const payload = mode === 'dir'
    ? [{ RuleID: 'generic-api-key', Description: 'Generic API Key', File: 'app.js', StartLine: 12, Match: 'key = "REDACTED"', Secret: 'REDACTED' }]
    : [{ RuleID: 'stripe-access-token', Description: 'Stripe Access Key', File: 'config.ts', StartLine: 4, Commit: 'abc123def', Match: 'REDACTED', Secret: 'REDACTED' }];
  fs.writeFileSync(rp, JSON.stringify(payload));
}
process.exit(1);
`;
    writeFileSync(shimPath, shimScript, 'utf8');
    chmodSync(shimPath, 0o755);

    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
    expect(await probeGitleaksVersion({ env })).toBe('8.30.1-shim');

    const dirRes = await runGitleaksDir(targetDir, { env });
    expect(dirRes.status).toBe('ok');
    expect(dirRes.version).toBe('8.30.1-shim');
    expect(dirRes.knownHits).toHaveLength(0);
    expect(dirRes.genericHits).toHaveLength(1);
    expect(dirRes.genericHits[0]?.ruleId).toBe('generic-api-key');

    const gitRes = await runGitleaksGit(targetDir, { env });
    expect(gitRes.status).toBe('ok');
    expect(gitRes.knownHits).toHaveLength(1);
    expect(gitRes.knownHits[0]?.commit).toBe('abc123def');
    expect(gitRes.genericHits).toHaveLength(0);

    const logged = fs.readFileSync(argsLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    const dirArgs = logged.find((a) => a[0] === 'dir')!;
    const gitArgs = logged.find((a) => a[0] === 'git')!;
    expect(dirArgs).toContain('--redact');
    expect(gitArgs).toContain('--redact');
  });
});
