// SPDX-License-Identifier: AGPL-3.0-only
// A run with --proof-bundle (docs/FOUNDATION.md §5, ADR 0007): the run opens a bundle in its run folder, appends
// records as it goes, and ends by sealing the ledger and printing its head. Hands the kernel a file-system store and
// node:crypto, and the run a RunRecorder, so that nothing else in the run touches either (docs/FOUNDATION.md §14).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RunRecorder, formatHead, openRecorder } from '../engine/recorder.js';
import type { Json } from '../kernel/ledger.js';
import type { ScrubRules } from '../scrub/scrub.js';
import { FsStore, nodeSha256 } from './fs-store.js';

/** The version of the run.open body this writes. */
export const OPEN_FORMAT = 1;

export interface ProofBundleRun {
  /** The bundle's folder: the run folder, `.miqyas/runs/<run id>`. */
  dir: string;
  /** Names the run in the checkpoint. */
  runId: string;
  /** The body of run.open, from buildRunOpen. */
  open: Json;
  now?: () => Date;
  /** The run's scrub rules: every record and blob of the bundle is scrubbed with them before it is written. */
  scrub?: ScrubRules;
  /** Where the head goes when the run ends. */
  print: (line: string) => void;
}

/** What a run that wrote a bundle gives back: its result for the caller, and the conclusion that goes in the seal. */
export interface RunOutcome<T> {
  result: T;
  fold: Json;
}

/**
 * Opens the bundle, runs `run` with the recorder, then seals and prints the head. A run that throws is not sealed: its
 * ledger stays as the crash left it, with no seal, and verify says so.
 */
export async function runWithProofBundle<T>(options: ProofBundleRun, run: (recorder: RunRecorder) => Promise<RunOutcome<T>>): Promise<T> {
  const recorder = await openRecorder(new FsStore(options.dir), nodeSha256, {
    origin: options.runId,
    open: options.open,
    now: options.now ?? (() => new Date()),
    ...(options.scrub !== undefined ? { scrub: options.scrub } : {}),
  });
  const { result, fold } = await run({
    record: (t, body) => recorder.record(t, body),
    putBlob: (bytes, mediaType) => recorder.putBlob(bytes, mediaType),
    getBlob: (digest) => recorder.getBlob(digest),
    head: () => recorder.head(),
  });
  const sealed = await recorder.seal(fold);
  options.print(`proof bundle head: ${formatHead(sealed.head)}`);
  return result;
}

/** What the run knows when it starts, as the CLI holds it. Anything else the CLI holds, such as a token, stays out. */
export interface RunOpenInput {
  url: string;
  plans: readonly { id: string }[];
  settings: {
    concurrency: number;
    allowOtherOrigins: boolean;
    crawl?: boolean;
    maxScreens?: number;
    maxDepth?: number;
    maxRps?: number;
    maxTimeMs?: number;
    active?: boolean;
    allowWrites?: boolean;
    allowHost?: string;
    profile?: string;
    repoProvided?: boolean;
    strict?: boolean;
    failOn?: string;
  };
  quote?: {
    model: string | null;
    noModel: boolean;
    dailyCapUsd: number;
    likelyUsd: number | null;
    worstCaseUsd: number | null;
  };
}

const PACKAGE_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');

/**
 * The body of run.open, as far as the run knows today. A record holds integers only, so money is in millionths of a
 * dollar and a rate in thousandths of a request a second. No subject yet: a run on a URL alone has none, and says so
 * by an empty list. The gate does not classify origins yet, so there are none to list.
 */
export async function buildRunOpen({ url, plans, settings: s, quote }: RunOpenInput): Promise<Json> {
  const { CEL_LIBRARY } = await import('../kernel/cel.js');
  const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf8')) as { version: string };
  const target = new URL(url);
  target.username = '';
  target.password = '';
  target.search = '';
  target.hash = '';
  const micro = (usd: number | null) => (usd === null ? null : Math.round(usd * 1_000_000));
  return {
    format: OPEN_FORMAT,
    versions: {
      engine: pkg.version,
      node: process.version,
      cel: { name: CEL_LIBRARY.name, version: CEL_LIBRARY.version },
      collectors: {},
      derivations: {},
    },
    subjects: [],
    inputs: {
      url: target.href,
      plans: plans.map((p) => p.id),
      crawl: s.crawl ?? false,
      ...(s.profile !== undefined ? { profile: s.profile } : {}),
      ...(s.repoProvided ? { repoProvided: true } : {}),
      ...(s.strict ? { strict: true } : {}),
      ...(s.failOn !== undefined ? { failOn: s.failOn } : {}),
    },
    grants: {
      active: s.active ?? false,
      allowWrites: s.allowWrites ?? false,
      allowOtherOrigins: s.allowOtherOrigins,
      ...(s.allowHost !== undefined ? { allowHost: s.allowHost } : {}),
    },
    origins: {},
    budgets: {
      concurrency: s.concurrency,
      ...(s.maxScreens !== undefined ? { maxScreens: s.maxScreens } : {}),
      ...(s.maxDepth !== undefined ? { maxDepth: s.maxDepth } : {}),
      ...(s.maxRps !== undefined ? { maxRpsMilli: Math.round(s.maxRps * 1000) } : {}),
      ...(s.maxTimeMs !== undefined ? { maxTimeMs: s.maxTimeMs } : {}),
    },
    quote:
      quote === undefined
        ? null
        : {
            model: quote.model,
            noModel: quote.noModel,
            dailyCapMicroUsd: micro(quote.dailyCapUsd),
            likelyMicroUsd: micro(quote.likelyUsd),
            worstCaseMicroUsd: micro(quote.worstCaseUsd),
          },
  };
}
