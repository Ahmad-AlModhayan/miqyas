// SPDX-License-Identifier: AGPL-3.0-only
// The two collectors check 13 reads (docs/FOUNDATION.md §3 and §9): the lockfile reader, which records the lockfiles
// Miqyas found in the repository, and the osv adapter, which records the advisories osv-scanner reported against
// their packages. They only measure: neither decides what fails, and each run closes with its `collection` fact.
// They are handed what the tools found as plain data and never run a tool or read a file themselves; the entry point
// does that with the adapter that already exists (docs/FOUNDATION.md §15) and hands the result over.
import type { RunRecorder } from '../engine/recorder.js';
import type { Fact, PlacedFact } from '../kernel/judge.js';
import type { Json } from '../kernel/ledger.js';

export const LOCKFILE_READER = 'lockfile-reader@1';
export const OSV_ADAPTER = 'osv-adapter@1';

/** What the lockfile reader was handed: the lockfiles found, relative to the repository, or why none could be looked for. */
export type LockfilesFound = { lockfiles: readonly string[] } | { failed: string };

/** One advisory as the osv adapter reports it. Only these fields are recorded. */
export interface OsvAdvisory {
  id: string;
  aliases: readonly string[];
  isMalicious: boolean;
  severity: string;
  packageName: string;
  packageVersion: string;
  ecosystem: string;
  sourcePath: string;
  fixedVersions: readonly string[];
}

/** What an osv-scanner run gave, as the adapter reports it, or why it was not run. */
export type OsvScan =
  | {
      status: 'ok' | 'missing' | 'no_lockfiles' | 'db_missing' | 'error';
      version: string | null;
      lockfiles: readonly string[];
      packageCount: number;
      hits: readonly OsvAdvisory[];
    }
  | { failed: string };

const OSV_REASONS = {
  ok: undefined,
  no_lockfiles: 'no lockfile to scan',
  missing: 'osv-scanner is not installed',
  db_missing: 'the offline vulnerability database is not present',
  error: 'osv-scanner did not finish',
} as const;

async function recordFact(recorder: RunRecorder, fact: Fact): Promise<PlacedFact> {
  const seq = await recorder.record('fact', fact as unknown as Json);
  return { seq, fact };
}

const factOf = (kind: string, by: string, subject: string, body: Json): Fact => ({ kind, v: 1, by, run: 1, subject, body });

/** A path as a record may hold it: relative, with "/". An absolute one is cut to its last part. */
function relativePath(p: string): string {
  const parts = p.split(/[\\/]+/).filter((part) => part !== '');
  const absolute = /^([A-Za-z]:|[\\/])/.test(p) || parts.includes('..');
  return absolute ? (parts.at(-1) ?? 'lockfile') : parts.join('/');
}

/** Records one `repo.file` fact per lockfile found, then the reader's `collection` fact. */
export async function recordLockfiles(recorder: RunRecorder, subject: string, found: LockfilesFound): Promise<PlacedFact[]> {
  const out: PlacedFact[] = [];
  const lockfiles = 'failed' in found ? [] : found.lockfiles.map(relativePath);
  for (const file of lockfiles) {
    out.push(await recordFact(recorder, factOf('repo.file', LOCKFILE_READER, subject, { path: file, role: 'lockfile' })));
  }
  out.push(
    await recordFact(
      recorder,
      factOf('collection', LOCKFILE_READER, subject, {
        setOut: 'every supported lockfile in the repository',
        status: 'failed' in found ? 'failed' : 'complete',
        ...('failed' in found ? { reason: found.failed } : {}),
        counts: { lockfiles: lockfiles.length },
        dropped: 0,
      }),
    ),
  );
  return out;
}

/** Records the tool's run, one `dep.advisory` fact per advisory, then the adapter's `collection` fact. */
export async function recordOsvScan(recorder: RunRecorder, subject: string, scan: OsvScan): Promise<PlacedFact[]> {
  const out: PlacedFact[] = [];
  const add = async (kind: string, body: Json) => out.push(await recordFact(recorder, factOf(kind, OSV_ADAPTER, subject, body)));
  if ('failed' in scan) {
    await add('collection', {
      setOut: 'every lockfile found, against the offline vulnerability database',
      status: 'failed',
      reason: scan.failed,
      counts: { lockfiles: 0, scanned: 0, packages: 0, advisories: 0 },
      dropped: 0,
    });
    return out;
  }
  if (scan.status !== 'no_lockfiles') {
    await add('tool.run', { tool: 'osv-scanner', version: scan.version, finished: scan.status === 'ok', outcome: scan.status });
  }
  const hits = scan.status === 'ok' ? scan.hits : [];
  for (const hit of hits) {
    await add('dep.advisory', {
      id: hit.id,
      aliases: [...hit.aliases],
      malicious: hit.isMalicious,
      severity: hit.severity,
      package: { name: hit.packageName, version: hit.packageVersion, ecosystem: hit.ecosystem },
      lockfile: relativePath(hit.sourcePath),
      fixed: [...hit.fixedVersions],
    });
  }
  const reason = OSV_REASONS[scan.status];
  await add('collection', {
    setOut: 'every lockfile found, against the offline vulnerability database',
    status: scan.status === 'ok' || scan.status === 'no_lockfiles' ? 'complete' : 'failed',
    ...(reason !== undefined ? { reason } : {}),
    counts: {
      lockfiles: scan.lockfiles.length,
      scanned: scan.status === 'ok' ? scan.lockfiles.length : 0,
      packages: scan.packageCount,
      advisories: hits.length,
    },
    dropped: 0,
  });
  return out;
}
