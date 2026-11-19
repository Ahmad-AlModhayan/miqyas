// SPDX-License-Identifier: Apache-2.0
// The fact kinds a worker, an adapter or a reader records (docs/FOUNDATION.md §3, "Kinds in the foundation"), as
// versioned JSON Schemas (draft 2020-12). They are data: whoever records or reads a fact can check it against them
// with the validator of their choice. A schema uses integers and strings and never a floating-point number. Each kind
// also says whether its content may ever go to a model, whether it records traffic (and so must carry its `cause`),
// which fields identify one item, and which blobs it holds.
//
// The kinds that derivations, extractors and the experiment engine record come with their own tickets. `finding` is
// here: derivations, adapters and agents all record it.

/** A JSON Schema, as plain data. */
export type JsonSchema = { readonly [keyword: string]: unknown };

/** A body schema: always an object, with the properties it may have. */
export type BodySchema = JsonSchema & { readonly type: 'object'; readonly properties: { readonly [field: string]: JsonSchema } };

/**
 * Whether a kind's content may ever go to a model: `never`, or `scrubbed` (only through the scrubber, as every model
 * call goes, ADR 0003). Repository content never does, nor does code a target serves.
 */
export type ModelPolicy = 'never' | 'scrubbed';

/** Who caused the traffic or the change a fact records (docs/FOUNDATION.md §3). */
const FACT_CAUSES = ['page', 'plan', 'probe', 'crawl'] as const;
export type FactCause = (typeof FACT_CAUSES)[number];

/** How a collector run ended (docs/FOUNDATION.md §3, "It closes"). */
const COLLECTION_STATUSES = ['complete', 'partial', 'failed'] as const;

/** How severe a finding is (docs/FOUNDATION.md §3), from least to most. */
export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
/** Whether a derivation, an experiment or a second look has backed a finding. */
export const FINDING_STATES = ['confirmed', 'unconfirmed'] as const;
/** Where a finding came from (CONTEXT.md, "Source"): `by` names which one. */
export const FINDING_SOURCES = ['derivation', 'adapter', 'agent'] as const;

export interface FactKind {
  kind: string;
  /** The version of this schema. A fact names it in `v`. */
  v: number;
  model: ModelPolicy;
  /** It records traffic or a change something caused: a fact of it must carry its `cause`. */
  traffic: boolean;
  /** The fields of the body that identify one item. */
  identity: readonly string[];
  /** The blobs a fact of this kind may name, and whether it must. A kind with none may name no blob. */
  blobs?: { readonly [name: string]: { required: boolean } };
  /** A fact of it rests on other facts: it must name at least one in `from`. */
  restsOn?: boolean;
  body: BodySchema;
}

// Building blocks. Every object is closed: a field a schema does not name is refused.
const str: JsonSchema = { type: 'string', minLength: 1 };
const text: JsonSchema = { type: 'string' };
const bool: JsonSchema = { type: 'boolean' };
/**
 * An integer from `minimum` to `maximum`, never beyond the integers a record can hold: the ledger refuses any other
 * number, and a fact is refused here first, naming its kind and the field.
 */
const int = (minimum = -Number.MAX_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER): JsonSchema => ({ type: 'integer', minimum, maximum });
const count = int(0);
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });
const list = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const oneOf = (...values: readonly string[]): JsonSchema => ({ type: 'string', enum: [...values] });

function object(required: { [field: string]: JsonSchema }, optional: { [field: string]: JsonSchema } = {}): BodySchema {
  return {
    type: 'object',
    properties: { ...required, ...optional },
    required: Object.keys(required),
    additionalProperties: false,
  };
}

/** A map of names to values of one schema. */
const objectOf = (values: JsonSchema): JsonSchema => ({ type: 'object', additionalProperties: values });

/**
 * A path as a record holds it: relative to the repository, with "/". Not absolute, no drive letter, no backslash, no
 * "." or ".." segment, no empty segment: so a fact never holds a path of the machine it ran on, nor one that leaves
 * the repository.
 */
const REPOSITORY_PATH: JsonSchema = {
  type: 'string',
  pattern: '^(?!\\.{1,2}(/|$))(?!.*/\\.{1,2}(/|$))(?![A-Za-z]:)[^/\\\\]+(/[^/\\\\]+)*$',
};

/** A SHA-256 digest as the blob store writes it. */
const SHA256_DIGEST: JsonSchema = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };

/** How a fact names a blob (docs/FOUNDATION.md §3). */
const BLOB_REF: JsonSchema = object({ digest: SHA256_DIGEST, size: count, mediaType: str });

const http = (): JsonSchema => int(100, 599);

/** A keyed digest (docs/ALGORITHMS.md L2): HMAC-SHA-256 under the run's key, which is thrown away at its end. */
const KEYED_DIGEST: JsonSchema = { type: 'string', pattern: '^hmac-sha256:[0-9a-f]{64}$' };

/**
 * Why a value was not kept (docs/FOUNDATION.md §3, "Safe to keep"): a row's contents, an id a test account owns, a
 * secret, or a request's or a response's body, which may hold any of them.
 */
export const WITHHELD_REASONS = ['row', 'owned-id', 'secret', 'body'] as const;
export type WithheldReason = (typeof WITHHELD_REASONS)[number];

/**
 * A value that must not be kept, as a fact holds it: why, its shape, its count and its keyed digest, so that two values
 * can be compared for equality without either being readable. A body of bytes also says its size.
 */
const withheldValue = (size: 'size' | 'no size'): JsonSchema =>
  object({ why: oneOf(...WITHHELD_REASONS), shape: str, count, digest: KEYED_DIGEST, ...(size === 'size' ? { size: count } : {}) });

/** A field of the body, as `withheld` names it: its path from the body, the names joined by ".". */
const BODY_FIELD: JsonSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*$' };

export const FACT_KINDS: readonly FactKind[] = [
  {
    kind: 'ui.snapshot',
    v: 1,
    model: 'scrubbed',
    traffic: false,
    identity: ['url'],
    blobs: { nodes: { required: true }, screenshot: { required: false } },
    body: object({
      url: str,
      title: text,
      lang: nullable(str),
      dir: nullable(oneOf('ltr', 'rtl', 'auto')),
      viewport: object({ width: count, height: count }),
      truncated: bool,
      settled: bool,
    }),
  },
  {
    kind: 'ui.event',
    v: 1,
    model: 'scrubbed',
    traffic: false,
    identity: ['type', 'message'],
    body: object({ type: oneOf('page-error', 'console-error', 'dialog'), message: text }, { url: str, dialog: oneOf('alert', 'confirm', 'prompt', 'beforeunload') }),
  },
  {
    kind: 'ui.control',
    v: 1,
    model: 'scrubbed',
    traffic: true,
    identity: ['label'],
    body: {
      ...object({ label: text, tried: bool }, { changed: object({ url: bool, nodes: count, requests: count }), reason: str }),
      // One that was tried says what changed; one that wasn't says why. Each condition asks for the field it reads, so
      // a body without it is refused for that field.
      allOf: [
        {
          if: { type: 'object', required: ['tried'], properties: { tried: { const: true } } },
          then: { type: 'object', required: ['changed'], properties: { reason: false } },
        },
        {
          if: { type: 'object', required: ['tried'], properties: { tried: { const: false } } },
          then: { type: 'object', required: ['reason'], properties: { changed: false } },
        },
      ],
    },
  },
  {
    kind: 'http.exchange',
    v: 1,
    model: 'scrubbed',
    traffic: true,
    identity: ['method', 'url'],
    body: object(
      {
        method: { type: 'string', pattern: '^[A-Z]+$' },
        url: str,
        route: nullable(str),
        status: nullable(http()),
        headers: objectOf(text),
        // As whom it was sent: nobody, or a named account with its role.
        as: nullable(object({ account: str, role: str })),
      },
      {
        // The bodies are not kept: each is withheld, and the fact names it in `withheld`.
        request: withheldValue('size'),
        response: withheldValue('size'),
      },
    ),
  },
  {
    kind: 'asset',
    v: 1,
    model: 'never',
    traffic: false,
    identity: ['from', 'name'],
    blobs: { content: { required: true } },
    body: object({ from: oneOf('served', 'storage'), name: str }),
  },
  {
    kind: 'code.coverage',
    v: 1,
    model: 'never',
    traffic: false,
    identity: ['session', 'script'],
    blobs: { ranges: { required: false } },
    body: object({ session: str, script: str, functions: count, functionsRun: count, blocks: count, blocksRun: count }),
  },
  {
    kind: 'a11y.violation',
    v: 1,
    model: 'scrubbed',
    traffic: false,
    identity: ['rule', 'node'],
    body: object({ rule: str, impact: nullable(oneOf('minor', 'moderate', 'serious', 'critical')), node: object({ target: list(str) }, { html: text }) }),
  },
  {
    kind: 'repo.tree',
    v: 1,
    model: 'never',
    traffic: false,
    identity: ['commit'],
    body: object({ commit: nullable({ type: 'string', pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$' }), dirty: bool, paths: list(REPOSITORY_PATH) }),
  },
  {
    kind: 'repo.file',
    v: 1,
    model: 'never',
    traffic: false,
    identity: ['path'],
    body: object({ path: REPOSITORY_PATH }, { role: str, digest: SHA256_DIGEST, size: count }),
  },
  {
    kind: 'secret.match',
    v: 1,
    model: 'never',
    traffic: false,
    identity: ['rule', 'path', 'line'],
    body: object({ rule: str, path: REPOSITORY_PATH, line: int(1), redacted: text }),
  },
  {
    kind: 'db.table',
    v: 1,
    model: 'never',
    traffic: false,
    identity: ['schema', 'name'],
    body: object({ schema: str, name: str, rls: bool }, { file: REPOSITORY_PATH }),
  },
  {
    kind: 'dep.package',
    v: 1,
    model: 'never',
    traffic: false,
    identity: ['ecosystem', 'name', 'version', 'lockfile'],
    body: object({ name: str, version: str, ecosystem: str, lockfile: REPOSITORY_PATH }),
  },
  {
    kind: 'dep.advisory',
    v: 1,
    model: 'never',
    traffic: false,
    identity: ['id', 'package', 'lockfile'],
    body: object({
      id: str,
      aliases: list(str),
      malicious: bool,
      severity: oneOf('critical', 'high', 'medium', 'low', 'info'),
      package: object({ name: str, version: str, ecosystem: str }),
      lockfile: REPOSITORY_PATH,
      fixed: list(str),
    }),
  },
  {
    kind: 'tool.run',
    v: 1,
    model: 'never',
    traffic: false,
    identity: ['tool'],
    body: object(
      { tool: str, version: nullable(str), finished: bool },
      { outcome: str, command: list(text), exitCode: nullable(int()), inputs: objectOf(SHA256_DIGEST) },
    ),
  },
  {
    kind: 'test.case',
    v: 1,
    model: 'never',
    traffic: false,
    identity: ['id'],
    body: {
      // One test as it ran, or the list of tests planned, recorded before the run.
      ...object({}, { id: str, status: oneOf('passed', 'failed', 'skipped', 'errored'), attempts: int(1), planned: list(str) }),
      if: { type: 'object', required: ['planned'] },
      then: { type: 'object', properties: { id: false, status: false, attempts: false } },
      else: { type: 'object', required: ['id', 'status', 'attempts'] },
    },
  },
  {
    kind: 'step.done',
    v: 1,
    model: 'scrubbed',
    traffic: true,
    identity: ['plan', 'step'],
    body: object({ plan: str, step: int(0), outcome: oneOf('done', 'failed', 'unknown') }, { reason: str }),
  },
  {
    kind: 'sample',
    v: 1,
    model: 'scrubbed',
    traffic: false,
    identity: ['name'],
    body: {
      ...object({ name: str, value: int(), unit: oneOf('ms', 'bytes', 'count', 'yes-no') }),
      // A yes or no is 1 or 0.
      if: { type: 'object', required: ['unit'], properties: { unit: { const: 'yes-no' } } },
      then: { type: 'object', properties: { value: { enum: [0, 1] } } },
    },
  },
  {
    kind: 'collection',
    v: 1,
    model: 'scrubbed',
    traffic: false,
    identity: ['setOut'],
    body: {
      // `listed` names what was counted, under the name of its count, each name once: a claim's coverage can then
      // compare what two collectors saw, and not only how many (two looks with one file swapped have equal counts).
      ...object(
        { setOut: str, status: oneOf(...COLLECTION_STATUSES), counts: objectOf(count), dropped: count },
        { reason: str, listed: objectOf({ ...list(str), uniqueItems: true }) },
      ),
      allOf: [
        // A run that didn't finish says why it stopped.
        {
          if: { type: 'object', required: ['status'], properties: { status: { enum: ['partial', 'failed'] } } },
          then: { type: 'object', required: ['reason'] },
        },
        // A run that dropped facts can't say it finished (ADR 0010).
        {
          if: { type: 'object', required: ['dropped'], properties: { dropped: int(1) } },
          then: { type: 'object', properties: { status: { enum: ['partial', 'failed'] } } },
        },
      ],
    },
  },
  {
    // A problem no claim asked about (docs/FOUNDATION.md §3). The facts it rests on are its `from`. It holds no
    // verdict: no field of it can say pass or fail.
    kind: 'finding',
    v: 1,
    model: 'scrubbed',
    traffic: false,
    identity: ['id'],
    restsOn: true,
    body: {
      ...object({ id: str, title: str, severity: oneOf(...FINDING_SEVERITIES), state: oneOf(...FINDING_STATES), source: oneOf(...FINDING_SOURCES) }),
      // A finding an agent proposed is unconfirmed: what backs it is a derivation's or an experiment's finding of its
      // own, which rests on it.
      if: { type: 'object', required: ['source'], properties: { source: { const: 'agent' } } },
      then: { type: 'object', properties: { state: { const: 'unconfirmed' } } },
    },
  },
];

/** The schema of `kind` at version `v`, or undefined when there is none. */
export function factKind(kind: string, v: number): FactKind | undefined {
  return FACT_KINDS.find((k) => k.kind === kind && k.v === v);
}

/** Whether any version of `kind` has a schema. */
export function isKnownKind(kind: string): boolean {
  return FACT_KINDS.some((k) => k.kind === kind);
}

/**
 * The schema of a whole fact of one kind (docs/FOUNDATION.md §3, `interface Fact`): the fields every fact has, the
 * kind's body, its blobs, and its `cause` when it records traffic.
 */
export function factSchema(k: FactKind): JsonSchema {
  const blobs = k.blobs;
  const required = ['kind', 'v', 'by', 'run', 'subject', 'body'];
  if (k.traffic) required.push('cause');
  if (k.restsOn) required.push('from');
  if (blobs && Object.values(blobs).some((b) => b.required)) required.push('blobs');
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://miqyas.kahflabs.com/schema/fact/${k.kind}/${k.v}.json`,
    title: `${k.kind}@${k.v}`,
    type: 'object',
    properties: {
      kind: { const: k.kind },
      v: { const: k.v },
      // The collector or derivation, as id@version.
      by: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*@[0-9][0-9A-Za-z.+-]*$' },
      // Which attempt of that collector.
      run: int(1),
      subject: str,
      origin: str,
      place: objectOf(str),
      effect: int(1),
      cause: oneOf(...FACT_CAUSES),
      from: k.restsOn ? { ...list(int(1)), minItems: 1 } : list(int(1)),
      body: k.body,
      blobs:
        blobs === undefined
          ? false
          : {
              type: 'object',
              properties: Object.fromEntries(Object.keys(blobs).map((name) => [name, BLOB_REF])),
              required: Object.entries(blobs)
                .filter(([, b]) => b.required)
                .map(([name]) => name),
              additionalProperties: false,
            },
      // The fields of the body that hold a value withheld, or rest on one the collector did not keep.
      withheld: { type: 'array', items: BODY_FIELD, uniqueItems: true },
    },
    required,
    additionalProperties: false,
  };
}
