// SPDX-License-Identifier: AGPL-3.0-only
// The fact kinds as schemas (docs/FOUNDATION.md §3, "Kinds in the foundation"): every kind a worker, an adapter or a
// reader records has a versioned schema in the protocol layer, and a fact is checked against it. The seam is the check
// itself: a fact in, ok or a refusal that names the kind and the field out.
import { describe, expect, it } from 'vitest';
import { checkFact } from '../../src/engine/fact-check.js';
import { FACT_KINDS, factKind, factSchema } from '../../src/protocol/facts.js';

const DIGEST = `sha256:${'ab'.repeat(32)}`;
const blob = (mediaType: string) => ({ digest: DIGEST, size: 12, mediaType });

/** One fact of each kind that its schema accepts, as a collector of that kind would record it. */
const VALID: Record<string, Record<string, unknown>> = {
  'ui.snapshot': {
    body: { url: 'https://app.test/', title: 'Home', lang: 'ar', dir: 'rtl', viewport: { width: 1280, height: 800 }, truncated: false, settled: true },
    blobs: { nodes: blob('application/json'), screenshot: blob('image/png') },
  },
  'ui.event': { body: { type: 'console-error', message: 'TypeError: x is undefined', url: 'https://app.test/' } },
  'ui.control': { cause: 'crawl', body: { label: 'Save', tried: true, changed: { url: false, nodes: 3, requests: 1 } } },
  'http.exchange': {
    cause: 'page',
    withheld: ['response'],
    origin: 'https://app.test',
    body: {
      method: 'GET',
      url: 'https://app.test/api/items/12',
      route: '/api/items/{id}',
      status: 200,
      headers: { 'content-type': 'application/json' },
      response: { why: 'body', shape: '{id:integer,name:string}', count: 2, size: 120, digest: `hmac-sha256:${'cd'.repeat(32)}` },
      as: { account: 'owner', role: 'admin' },
    },
  },
  asset: { body: { from: 'served', name: 'https://app.test/main.js' }, blobs: { content: blob('text/javascript') } },
  'code.coverage': { body: { session: 's1', script: 'https://app.test/main.js', functions: 10, functionsRun: 4, blocks: 40, blocksRun: 12 } },
  'a11y.violation': { body: { rule: 'color-contrast', impact: 'serious', node: { target: ['#save'] } } },
  'repo.tree': { body: { commit: 'a'.repeat(40), dirty: false, paths: ['package.json', 'src/index.ts'] } },
  'repo.file': { body: { path: 'package-lock.json', role: 'lockfile' } },
  'secret.match': { body: { rule: 'aws-access-key', path: 'src/config.ts', line: 12, redacted: 'AKIA****' } },
  'db.table': { body: { schema: 'public', name: 'invoices', rls: true, file: 'supabase/migrations/001.sql' } },
  'dep.package': { body: { name: 'left-pad', version: '1.3.0', ecosystem: 'npm', lockfile: 'package-lock.json' } },
  'dep.advisory': {
    withheld: ['severity'],
    body: {
      id: 'GHSA-crit-0001',
      aliases: [],
      malicious: false,
      severity: 'critical',
      package: { name: 'vuln-critical', version: '1.0.0', ecosystem: 'npm' },
      lockfile: 'package-lock.json',
      fixed: [],
    },
  },
  'tool.run': { body: { tool: 'osv-scanner', version: '2.7.0', finished: true, outcome: 'ok' } },
  'test.case': { body: { id: 'auth > signs in', status: 'passed', attempts: 1 } },
  'step.done': { cause: 'plan', body: { plan: 'checkout', step: 3, outcome: 'done' } },
  sample: { body: { name: 'first paint', value: 812, unit: 'ms' } },
  collection: { body: { setOut: 'every supported lockfile in the repository', status: 'complete', counts: { lockfiles: 1 }, dropped: 0 } },
  finding: {
    from: [4, 7],
    body: { id: 'source-map-served', title: 'The served bundle exposes its source map', severity: 'medium', state: 'confirmed', source: 'derivation' },
  },
};

/** The kinds of the §3 table that a worker, an adapter or a reader records, and `finding`. */
const COLLECTED = Object.keys(VALID);

/** The kinds of the §3 table that are not this ticket's: derivations, extractors, the experiment engine. */
const NOT_SCHEMED_HERE = ['model.state', 'model.edge', 'entity', 'property', 'capsule', 'fidelity', 'experiment', 'footprint'];

const fact = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, v: 1, by: 'test-collector@1', run: 1, subject: 'repository', ...VALID[kind], ...extra });

/** The fact of `kind` with its body changed by `change`. */
function withBody(kind: string, change: (body: Record<string, unknown>) => void) {
  const body = structuredClone(VALID[kind]!.body) as Record<string, unknown>;
  change(body);
  return fact(kind, { body });
}

function refusal(f: unknown) {
  const result = checkFact(f);
  if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(f)}`);
  return { kind: result.kind, field: result.field, message: result.message };
}

type Schema = { [keyword: string]: unknown };

/**
 * Every schema and subschema of the whole fact of every kind. Only where a keyword holds a schema: a property of the
 * body named `type` (as `ui.event` has) is a field, and the values of `const` and `enum` are data.
 */
function everySchema(): Schema[] {
  const found: Schema[] = [];
  const isSchema = (node: unknown): node is Schema => node !== null && typeof node === 'object' && !Array.isArray(node);
  const walk = (node: unknown): void => {
    if (!isSchema(node)) return;
    found.push(node);
    for (const keyword of ['properties', 'patternProperties', '$defs']) {
      Object.values((node[keyword] as Schema | undefined) ?? {}).forEach(walk);
    }
    for (const keyword of ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']) walk(node[keyword]);
    for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) ((node[keyword] as unknown[] | undefined) ?? []).forEach(walk);
  };
  FACT_KINDS.forEach((k) => walk(factSchema(k)));
  return found;
}

describe('the fact kinds of the foundation', () => {
  it('give each kind a worker, an adapter or a reader records a schema at version 1, and none of the rest', () => {
    expect(FACT_KINDS.map((k) => k.kind).sort()).toEqual([...COLLECTED].sort());
    for (const kind of COLLECTED) expect(factKind(kind, 1)?.v).toBe(1);
    for (const kind of NOT_SCHEMED_HERE) expect(factKind(kind, 1)).toBeUndefined();
    expect(factKind('repo.file', 2)).toBeUndefined();
  });

  it('use integers and strings, never a floating-point number, anywhere in a schema', () => {
    const types = everySchema().flatMap((s) => (s.type === undefined ? [] : [s.type].flat()));
    expect(types).toContain('integer');
    expect(types).not.toContain('number');
  });

  it('bound every integer within the integers a record can hold', () => {
    const integers = everySchema().filter((s) => [s.type].flat().includes('integer'));
    expect(integers.length).toBeGreaterThan(0);
    for (const s of integers) {
      expect(s.minimum, JSON.stringify(s)).toBeGreaterThanOrEqual(-Number.MAX_SAFE_INTEGER);
      expect(s.maximum, JSON.stringify(s)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }
  });

  it('declare for each kind whether its content may ever go to a model, and repository content never does', () => {
    for (const k of FACT_KINDS) expect(['never', 'scrubbed']).toContain(k.model);
    const repo = FACT_KINDS.filter((k) => k.kind.startsWith('repo.'));
    expect(repo.map((k) => k.kind).sort()).toEqual(['repo.file', 'repo.tree']);
    for (const k of repo) expect(k.model).toBe('never');
    // What else is read out of the repository, or is served code, is repository content too (ADR 0003).
    for (const kind of ['secret.match', 'db.table', 'dep.package', 'dep.advisory', 'test.case', 'asset', 'code.coverage']) {
      expect(factKind(kind, 1)?.model).toBe('never');
    }
  });

  it('name the fields that identify one item, each one a field of the body', () => {
    for (const k of FACT_KINDS) {
      expect(k.identity.length).toBeGreaterThan(0);
      for (const field of k.identity) expect(Object.keys(k.body.properties)).toContain(field);
    }
  });
});

describe('checking a fact against its schema', () => {
  it.each(COLLECTED)('accepts a %s fact as its collector records it', (kind) => {
    expect(checkFact(fact(kind))).toEqual({ ok: true });
  });

  it('refuses a fact of a kind with no schema, naming the kind and the field', () => {
    expect(refusal(fact('collection', { kind: 'page' }))).toMatchObject({ kind: 'page', field: 'kind' });
    expect(refusal(fact('collection', { kind: 'footprint' }))).toMatchObject({ kind: 'footprint', field: 'kind' });
  });

  it('refuses a version of a kind that has no schema', () => {
    expect(refusal(fact('repo.file', { v: 2 }))).toMatchObject({ kind: 'repo.file', field: 'v' });
  });

  it('refuses a field of the body of the wrong type, naming the kind and the full path of the field', () => {
    const r = refusal(withBody('dep.advisory', (b) => ((b.package as Record<string, unknown>).version = 1)));
    expect(r).toMatchObject({ kind: 'dep.advisory', field: 'body.package.version' });
    expect(r.message).toContain('dep.advisory');
    expect(r.message).toContain('body.package.version');
  });

  it('refuses a body that leaves out a field its kind requires, naming that field', () => {
    expect(refusal(withBody('repo.file', (b) => delete b.path))).toMatchObject({ kind: 'repo.file', field: 'body.path' });
    expect(refusal(withBody('tool.run', (b) => delete b.finished))).toMatchObject({ kind: 'tool.run', field: 'body.finished' });
  });

  it('refuses a field its kind does not have, in the body and in the fact around it', () => {
    expect(refusal(withBody('dep.advisory', (b) => (b.summary = 'Critical RCE')))).toMatchObject({ kind: 'dep.advisory', field: 'body.summary' });
    expect(refusal(withBody('dep.advisory', (b) => ((b.package as Record<string, unknown>).cvss = 9)))).toMatchObject({ field: 'body.package.cvss' });
    expect(refusal(fact('repo.file', { verdict: 'pass' }))).toMatchObject({ kind: 'repo.file', field: 'verdict' });
  });

  it('refuses a floating-point number wherever a schema asks for an integer, in the body and around it', () => {
    expect(refusal(withBody('sample', (b) => (b.value = 812.5)))).toMatchObject({ kind: 'sample', field: 'body.value' });
    expect(refusal(withBody('collection', (b) => (b.counts = { lockfiles: 1.5 })))).toMatchObject({ field: 'body.counts.lockfiles' });
    expect(refusal(fact('repo.file', { run: 1.5 }))).toMatchObject({ kind: 'repo.file', field: 'run' });
    expect(refusal(withBody('ui.snapshot', (b) => (b.viewport = { width: 1280.5, height: 800 })))).toMatchObject({ field: 'body.viewport.width' });
  });

  it('refuses an integer beyond the integers a record can hold, naming the kind and the field', () => {
    for (const big of [1e300, 2 ** 60, -(2 ** 60)]) {
      expect(refusal(withBody('sample', (b) => (b.value = big)))).toMatchObject({ kind: 'sample', field: 'body.value' });
      expect(refusal(withBody('tool.run', (b) => (b.exitCode = big)))).toMatchObject({ kind: 'tool.run', field: 'body.exitCode' });
      expect(refusal(fact('repo.file', { run: big }))).toMatchObject({ kind: 'repo.file', field: 'run' });
    }
    expect(refusal(withBody('collection', (b) => (b.counts = { lockfiles: 2 ** 60 })))).toMatchObject({ field: 'body.counts.lockfiles' });
    expect(refusal(fact('repo.file', { effect: 1e300 }))).toMatchObject({ field: 'effect' });
    for (const edge of [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
      expect(checkFact(withBody('sample', (b) => (b.value = edge)))).toEqual({ ok: true });
    }
  });

  it('refuses minus zero, which a record cannot hold, naming the kind and the field', () => {
    expect(refusal(withBody('collection', (b) => (b.dropped = -0)))).toMatchObject({ kind: 'collection', field: 'body.dropped' });
    expect(refusal(withBody('sample', (b) => (b.value = -0)))).toMatchObject({ kind: 'sample', field: 'body.value' });
    expect(refusal(withBody('collection', (b) => (b.counts = { 'apps/web': -0 })))).toMatchObject({ field: 'body.counts.apps/web' });
    const r = refusal(withBody('tool.run', (b) => (b.exitCode = -0)));
    expect(r).toMatchObject({ kind: 'tool.run', field: 'body.exitCode' });
    expect(r.message).toContain('tool.run');
  });

  it('refuses a fact without the fields every fact has', () => {
    for (const field of ['v', 'by', 'run', 'subject', 'body']) {
      const f: Record<string, unknown> = fact('repo.file');
      delete f[field];
      expect(refusal(f)).toMatchObject({ kind: 'repo.file', field });
    }
    expect(refusal(fact('repo.file', { by: 'lockfile-reader' }))).toMatchObject({ field: 'by' });
    expect(refusal(fact('repo.file', { run: 0 }))).toMatchObject({ field: 'run' });
    expect(refusal(fact('repo.file', { subject: '' }))).toMatchObject({ field: 'subject' });
  });

  it('refuses what is not a fact at all, and names what it can', () => {
    expect(refusal(null)).toMatchObject({ field: '' });
    expect(refusal('repo.file')).toMatchObject({ field: '' });
    expect(refusal([fact('repo.file')])).toMatchObject({ field: '' });
    expect(refusal({ ...fact('repo.file'), kind: 7 })).toMatchObject({ kind: '7', field: 'kind' });
  });

  it('refuses a repository path that is absolute or leaves the repository', () => {
    for (const bad of ['/etc/passwd', 'C:\\repo\\package-lock.json', 'c:/repo/yarn.lock', '../package-lock.json', 'a/../../b', 'apps\\web\\yarn.lock', '']) {
      expect(refusal(withBody('repo.file', (b) => (b.path = bad)))).toMatchObject({ kind: 'repo.file', field: 'body.path' });
    }
    expect(refusal(withBody('dep.advisory', (b) => (b.lockfile = '/package-lock.json')))).toMatchObject({ field: 'body.lockfile' });
    expect(checkFact(withBody('repo.file', (b) => (b.path = 'apps/web/..lock')))).toEqual({ ok: true });
  });

  it('holds a control that was tried to what changed, and one that was not to why', () => {
    expect(refusal(withBody('ui.control', (b) => delete b.changed))).toMatchObject({ kind: 'ui.control', field: 'body.changed' });
    expect(refusal(withBody('ui.control', (b) => (b.reason = 'hidden')))).toMatchObject({ kind: 'ui.control', field: 'body.reason' });
    expect(refusal(withBody('ui.control', (b) => (delete b.changed, Object.assign(b, { tried: false }))))).toMatchObject({ field: 'body.reason' });
    expect(refusal(withBody('ui.control', (b) => Object.assign(b, { tried: false, reason: 'hidden' })))).toMatchObject({ field: 'body.changed' });
    expect(checkFact(withBody('ui.control', (b) => (delete b.changed, Object.assign(b, { tried: false, reason: 'hidden' }))))).toEqual({ ok: true });
    expect(refusal(withBody('ui.control', (b) => delete b.tried))).toMatchObject({ field: 'body.tried' });
  });

  it('holds a test case to one test as it ran, or to the list planned before the run, and not both', () => {
    expect(checkFact(withBody('test.case', (b) => (delete b.id, delete b.status, delete b.attempts, (b.planned = ['a', 'b']))))).toEqual({ ok: true });
    expect(refusal(withBody('test.case', (b) => (b.planned = ['a'])))).toMatchObject({ kind: 'test.case', field: 'body.id' });
    expect(refusal(withBody('test.case', (b) => delete b.attempts))).toMatchObject({ field: 'body.attempts' });
    expect(refusal(withBody('test.case', (b) => (b.attempts = 0)))).toMatchObject({ field: 'body.attempts' });
  });

  it('holds a yes or no to 1 or 0', () => {
    expect(checkFact(withBody('sample', (b) => Object.assign(b, { unit: 'yes-no', value: 1 })))).toEqual({ ok: true });
    expect(refusal(withBody('sample', (b) => Object.assign(b, { unit: 'yes-no', value: 2 })))).toMatchObject({ kind: 'sample', field: 'body.value' });
    expect(checkFact(withBody('sample', (b) => Object.assign(b, { unit: 'count', value: 2 })))).toEqual({ ok: true });
  });

  it('refuses a severity the adapter does not give', () => {
    expect(refusal(withBody('dep.advisory', (b) => (b.severity = 'pass')))).toMatchObject({ kind: 'dep.advisory', field: 'body.severity' });
  });

  it('refuses a blob a kind does not hold, and a kind that must hold one without it', () => {
    expect(refusal(fact('repo.file', { blobs: { body: blob('text/plain') } }))).toMatchObject({ kind: 'repo.file', field: 'blobs' });
    expect(refusal(fact('ui.snapshot', { blobs: { screenshot: blob('image/png') } }))).toMatchObject({ field: 'blobs.nodes' });
    expect(refusal(fact('ui.snapshot', { blobs: { ...VALID['ui.snapshot']!.blobs as object, video: blob('video/webm') } }))).toMatchObject({ field: 'blobs.video' });
    expect(refusal(fact('asset', { blobs: { content: { ...blob('text/javascript'), digest: 'md5:00' } } }))).toMatchObject({ field: 'blobs.content.digest' });
  });
});

describe('the fields around the body', () => {
  it('a place is names to non-empty strings', () => {
    expect(checkFact(fact('repo.file', { place: { file: 'package-lock.json', step: '2' } }))).toEqual({ ok: true });
    expect(refusal(fact('repo.file', { place: { file: 3 } }))).toMatchObject({ kind: 'repo.file', field: 'place.file' });
    expect(refusal(fact('repo.file', { place: { screen: '' } }))).toMatchObject({ kind: 'repo.file', field: 'place.screen' });
  });

  it('an effect is the ledger position of a gate record, so a whole number from 1', () => {
    expect(checkFact(fact('http.exchange', { effect: 4 }))).toEqual({ ok: true });
    expect(refusal(fact('http.exchange', { effect: 0 }))).toMatchObject({ kind: 'http.exchange', field: 'effect' });
    expect(refusal(fact('http.exchange', { effect: '4' }))).toMatchObject({ kind: 'http.exchange', field: 'effect' });
  });

  it('from is a list of ledger positions, each a whole number from 1', () => {
    expect(checkFact(fact('sample', { from: [1, 5] }))).toEqual({ ok: true });
    expect(refusal(fact('sample', { from: [3, 0] }))).toMatchObject({ kind: 'sample', field: 'from.1' });
    expect(refusal(fact('sample', { from: 3 }))).toMatchObject({ kind: 'sample', field: 'from' });
  });
});

describe('a fact that records traffic', () => {
  const TRAFFIC = ['http.exchange', 'ui.control', 'step.done'];

  it('is declared so by its kind, and no other kind is', () => {
    expect(FACT_KINDS.filter((k) => k.traffic).map((k) => k.kind).sort()).toEqual([...TRAFFIC].sort());
  });

  it.each(TRAFFIC)('a %s fact without its cause is refused, naming the field', (kind) => {
    const f: Record<string, unknown> = fact(kind);
    delete f.cause;
    expect(refusal(f)).toMatchObject({ kind, field: 'cause' });
  });

  it('carries one of the four causes and nothing else', () => {
    for (const cause of ['page', 'plan', 'probe', 'crawl']) expect(checkFact(fact('http.exchange', { cause }))).toEqual({ ok: true });
    expect(refusal(fact('http.exchange', { cause: 'target' }))).toMatchObject({ kind: 'http.exchange', field: 'cause' });
  });

  it('a fact that records no traffic may still say what caused it', () => {
    expect(checkFact(fact('ui.event', { cause: 'page' }))).toEqual({ ok: true });
  });
});

describe('a collection fact', () => {
  it('says what it set out to cover, how it ended, its counts and what it dropped', () => {
    for (const field of ['setOut', 'status', 'counts', 'dropped']) {
      expect(refusal(withBody('collection', (b) => delete b[field]))).toMatchObject({ kind: 'collection', field: `body.${field}` });
    }
    expect(refusal(withBody('collection', (b) => (b.status = 'pass')))).toMatchObject({ field: 'body.status' });
    expect(refusal(withBody('collection', (b) => (b.dropped = -1)))).toMatchObject({ field: 'body.dropped' });
    expect(refusal(withBody('collection', (b) => (b.counts = { lockfiles: -1 })))).toMatchObject({ field: 'body.counts.lockfiles' });
    // A name with a "/" or a "~" in it is named as it is, not as the JSON pointer escapes it.
    expect(refusal(withBody('collection', (b) => (b.counts = { 'apps/web~1': -1 })))).toMatchObject({ field: 'body.counts.apps/web~1' });
    expect(refusal(withBody('collection', (b) => (b.setOut = '')))).toMatchObject({ field: 'body.setOut' });
  });

  it('says why it stopped when it did not finish', () => {
    for (const status of ['partial', 'failed']) {
      expect(refusal(withBody('collection', (b) => (b.status = status)))).toMatchObject({ kind: 'collection', field: 'body.reason' });
      expect(checkFact(withBody('collection', (b) => Object.assign(b, { status, reason: 'the budget ran out' })))).toEqual({ ok: true });
    }
  });

  it('cannot say it finished when it dropped facts', () => {
    expect(refusal(withBody('collection', (b) => (b.dropped = 2)))).toMatchObject({ kind: 'collection', field: 'body.status' });
    expect(checkFact(withBody('collection', (b) => Object.assign(b, { dropped: 2, status: 'partial', reason: 'shed under load' })))).toEqual({ ok: true });
  });

  it('may list what it counted, by name, each name once, so that a claim can compare two lists and not only two counts', () => {
    const listed = (value: unknown) => withBody('collection', (b) => (b.listed = value));
    expect(checkFact(listed({ lockfiles: ['apps/web/package-lock.json', 'package-lock.json'] }))).toEqual({ ok: true });
    expect(checkFact(listed({ lockfiles: [] }))).toEqual({ ok: true });
    expect(refusal(listed({ lockfiles: ['package-lock.json', 'package-lock.json'] }))).toMatchObject({ kind: 'collection', field: 'body.listed.lockfiles' });
    expect(refusal(listed({ lockfiles: 'package-lock.json' }))).toMatchObject({ kind: 'collection', field: 'body.listed.lockfiles' });
    for (const name of ['', 1, null]) {
      expect(refusal(listed({ lockfiles: [name] }))).toMatchObject({ kind: 'collection', field: expect.stringMatching(/^body\.listed\.lockfiles/) });
    }
  });
});

describe('a finding', () => {
  it('has a source, a severity, a state and the facts it rests on', () => {
    for (const field of ['id', 'title', 'severity', 'state', 'source']) {
      expect(refusal(withBody('finding', (b) => delete b[field]))).toMatchObject({ kind: 'finding', field: `body.${field}` });
    }
    const without: Record<string, unknown> = fact('finding');
    delete without.from;
    expect(refusal(without)).toMatchObject({ kind: 'finding', field: 'from' });
    expect(refusal(fact('finding', { from: [] }))).toMatchObject({ kind: 'finding', field: 'from' });
  });

  it('takes the severities and states agreed, and nothing else', () => {
    for (const severity of ['info', 'low', 'medium', 'high', 'critical']) {
      expect(checkFact(withBody('finding', (b) => (b.severity = severity)))).toEqual({ ok: true });
    }
    expect(refusal(withBody('finding', (b) => (b.severity = 'blocker')))).toMatchObject({ kind: 'finding', field: 'body.severity' });
    expect(checkFact(withBody('finding', (b) => (b.state = 'unconfirmed')))).toEqual({ ok: true });
    expect(refusal(withBody('finding', (b) => (b.state = 'suspected')))).toMatchObject({ field: 'body.state' });
    for (const source of ['derivation', 'adapter', 'agent']) {
      expect(checkFact(withBody('finding', (b) => Object.assign(b, { source, state: 'unconfirmed' })))).toEqual({ ok: true });
    }
    expect(refusal(withBody('finding', (b) => (b.source = 'model')))).toMatchObject({ field: 'body.source' });
  });

  it('is unconfirmed when a model proposed it: a derivation or an experiment backs it with a finding of its own', () => {
    expect(refusal(withBody('finding', (b) => Object.assign(b, { source: 'agent', state: 'confirmed' })))).toMatchObject({ kind: 'finding', field: 'body.state' });
  });

  it('never carries a verdict', () => {
    for (const field of ['verdict', 'pass', 'status']) {
      expect(refusal(withBody('finding', (b) => (b[field] = 'fail')))).toMatchObject({ kind: 'finding', field: `body.${field}` });
    }
    expect(refusal(fact('finding', { verdict: 'fail' }))).toMatchObject({ kind: 'finding', field: 'verdict' });
  });
});

describe('a value that must not be kept', () => {
  it('is held by an exchange as shape, count, size and a keyed digest, never a plain one', () => {
    const response = (change: Record<string, unknown>) =>
      withBody('http.exchange', (b) => Object.assign(b.response as Record<string, unknown>, change));
    expect(refusal(response({ digest: 'k1' }))).toMatchObject({ kind: 'http.exchange', field: 'body.response.digest' });
    expect(refusal(response({ digest: DIGEST }))).toMatchObject({ field: 'body.response.digest' });
    expect(refusal(response({ value: 'row 1' }))).toMatchObject({ field: 'body.response.value' });
    expect(refusal(response({ why: 'because' }))).toMatchObject({ field: 'body.response.why' });
    for (const field of ['why', 'shape', 'count', 'size', 'digest']) {
      expect(refusal(withBody('http.exchange', (b) => delete (b.response as Record<string, unknown>)[field]))).toMatchObject({ field: `body.response.${field}` });
    }
  });

  it('is refused unless withheld names its field, naming the kind and the field', () => {
    const { withheld: _named, ...unnamed } = fact('http.exchange') as Record<string, unknown>;
    expect(refusal(unnamed)).toMatchObject({ kind: 'http.exchange', field: 'body.response' });
    expect(refusal(unnamed).message).toMatch(/withheld/);
    expect(refusal(fact('http.exchange', { withheld: ['as.account'] }))).toMatchObject({ kind: 'http.exchange', field: 'body.response' });
    const both = withBody('http.exchange', (b) => (b.request = { ...(b.response as object) }));
    expect(refusal(both)).toMatchObject({ field: 'body.request' });
    expect(checkFact({ ...both, withheld: ['request', 'response'] })).toEqual({ ok: true });
  });

  it('is refused when withheld names a field the body does not hold', () => {
    expect(refusal(fact('http.exchange', { withheld: ['response', 'request'] }))).toMatchObject({ kind: 'http.exchange', field: 'withheld' });
    expect(refusal(fact('dep.advisory', { withheld: ['score'] }))).toMatchObject({ kind: 'dep.advisory', field: 'withheld' });
    // A field that rests on a value the collector did not keep holds a plain value: check 13's severity.
    expect(checkFact(fact('dep.advisory'))).toEqual({ ok: true });
  });

  it('is named in withheld by the path of its field in the body', () => {
    expect(checkFact(fact('http.exchange', { withheld: ['response'] }))).toEqual({ ok: true });
    expect(checkFact(fact('http.exchange', { withheld: ['response', 'as.account'] }))).toEqual({ ok: true });
    expect(refusal(fact('http.exchange', { withheld: ['the response'] }))).toMatchObject({ kind: 'http.exchange', field: 'withheld.0' });
    expect(refusal(fact('http.exchange', { withheld: ['response', 'response'] }))).toMatchObject({ field: 'withheld' });
  });
});

describe('a body only JSON can hold', () => {
  it('refuses fields that sit on a prototype and not on the object, naming the kind and the field', () => {
    const body = Object.create({ path: 'package-lock.json' }) as Record<string, unknown>;
    expect(refusal(fact('repo.file', { body }))).toMatchObject({ kind: 'repo.file', field: 'body' });
    const viewport = Object.create({ width: 1, height: 2 }) as Record<string, unknown>;
    expect(refusal(withBody('ui.snapshot', (b) => (b.viewport = viewport)))).toMatchObject({ kind: 'ui.snapshot', field: 'body.viewport' });
  });
});
