// SPDX-License-Identifier: AGPL-3.0-only
// The two collectors check 13 reads (docs/FOUNDATION.md §3 and §9): the lockfile reader, which records the lockfiles
// Miqyas found in the repository, and the osv adapter, which records the advisories osv-scanner reported against
// their packages. They only measure: neither decides what fails, and each run closes with its `collection` fact.
// They are handed what the tools found as plain data and never run a tool or read a file themselves; the entry point
// does that with the adapter that already exists (docs/FOUNDATION.md §15) and hands the result over.
import type { RunRecorder } from '../engine/recorder.js';
import type { Fact, PlacedFact } from '../kernel/fact.js';
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
  const seq = await recorder.record('fact', fact);
  return { seq, fact };
}

const factOf = (kind: string, by: string, subject: string, body: Json, withheld?: string[]): Fact => ({
  kind,
  v: 1,
  by,
  run: 1,
  subject,
  body,
  ...(withheld ? { withheld } : {}),
});

/**
 * A path as a record holds it: relative to the repository, with "/", as the adapter gives it. One that is absolute or
 * leaves the repository is refused, so a record never holds a path of the machine it ran on, nor a cut one.
 */
function repositoryPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
  if (/^([A-Za-z]:|[\\/])/.test(p) || parts.includes('..') || parts.length === 0) {
    throw new Error(`${JSON.stringify(p)} is not a path relative to the repository`);
  }
  return parts.join('/');
}

/** Records one `repo.file` fact per lockfile found, then the reader's `collection` fact. */
export async function recordLockfiles(recorder: RunRecorder, subject: string, found: LockfilesFound): Promise<PlacedFact[]> {
  const out: PlacedFact[] = [];
  const lockfiles = 'failed' in found ? [] : found.lockfiles.map(repositoryPath);
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
  const add = async (kind: string, body: Json, withheld?: string[]) =>
    out.push(await recordFact(recorder, factOf(kind, OSV_ADAPTER, subject, body, withheld)));
  if ('failed' in scan) {
    await add('collection', {
      setOut: 'every lockfile found, against the offline vulnerability database',
      status: 'failed',
      reason: scan.failed,
      counts: { lockfiles: 0, packages: 0, advisories: 0 },
      dropped: 0,
    });
    return out;
  }
  const hits = scan.status === 'ok' ? scan.hits : [];
  const lockfiles = hits.map((hit) => repositoryPath(hit.sourcePath)); // refused before anything of the scan is recorded
  if (scan.status !== 'no_lockfiles') {
    await add('tool.run', { tool: 'osv-scanner', version: scan.version, finished: scan.status === 'ok', outcome: scan.status });
  }
  for (const [i, hit] of hits.entries()) {
    const advisory = {
      id: hit.id,
      aliases: [...hit.aliases],
      malicious: hit.isMalicious,
      severity: hit.severity,
      package: { name: hit.packageName, version: hit.packageVersion, ecosystem: hit.ecosystem },
      lockfile: lockfiles[i] as string,
      fixed: [...hit.fixedVersions],
    };
    // The severity is the adapter's classification, and the score it came from is not kept (docs/FOUNDATION.md §3).
    await add('dep.advisory', advisory, ['severity']);
  }
  const reason = OSV_REASONS[scan.status];
  await add('collection', {
    setOut: 'every lockfile found, against the offline vulnerability database',
    status: scan.status === 'ok' || scan.status === 'no_lockfiles' ? 'complete' : 'failed',
    ...(reason !== undefined ? { reason } : {}),
    counts: {
      lockfiles: scan.lockfiles.length,
      packages: scan.packageCount,
      advisories: hits.length,
    },
    dropped: 0,
  });
  return out;
}
