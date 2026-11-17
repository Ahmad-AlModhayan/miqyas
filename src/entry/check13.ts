// SPDX-License-Identifier: AGPL-3.0-only
// Check 13 on the new path (docs/FOUNDATION.md §15, step 1): the tracer through the foundation, behind --proof-bundle.
// The claim is the data file in src/claims, recorded verbatim. The tools are run here, by the adapter that already
// exists, because only src/entry may reach the old code; what they find is handed to the new collectors, which record
// it as facts. The kernel's judge then gives the verdict over those facts, and that is what goes in the verdict record.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type OsvExecOptions, findRepoLockfiles, runOsvScannerOffline } from '../adapters/osv.js';
import { type LockfilesFound, type OsvScan, recordLockfiles, recordOsvScan } from '../collectors/dependencies.js';
import type { RunRecorder } from '../engine/recorder.js';
import { loadClaim } from '../kernel/claim.js';
import { type Verdict, judgeSet } from '../kernel/judge.js';
import type { Json } from '../kernel/ledger.js';
import { nodeSha256 } from './fs-store.js';

/** The claim file, found from this module whether it runs from src/entry or from dist/entry. */
export const CHECK_13_CLAIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/claims/readiness-13-dependencies.json');

/** The subject the facts are about: the repository given with --repo. It is not named by digest yet. */
export const REPOSITORY_SUBJECT = 'repository';

export interface Check13Options {
  repoPath?: string;
  osv?: OsvExecOptions;
}

/** Records check 13's claim and facts through the recorder, judges it, records the verdict, and returns it. */
export async function runCheck13(recorder: RunRecorder, options: Check13Options): Promise<Verdict> {
  const bytes = new Uint8Array(await readFile(CHECK_13_CLAIM));
  const loaded = await loadClaim(bytes, nodeSha256);
  await recorder.record('claim', {
    claim: `${loaded.claim.id}@${loaded.claim.version}`,
    rule: loaded.rule,
    file: new TextDecoder().decode(bytes),
  });

  const repo = options.repoPath === undefined ? undefined : path.resolve(options.repoPath);
  let found: LockfilesFound;
  if (repo === undefined) found = { failed: 'no repository was given (--repo)' };
  else if (!(await stat(repo).catch(() => null))?.isDirectory()) found = { failed: 'the repository folder does not exist' };
  else found = { lockfiles: await findRepoLockfiles(repo) };
  const facts = await recordLockfiles(recorder, REPOSITORY_SUBJECT, found);

  const scan: OsvScan = repo === undefined || 'failed' in found ? { failed: 'there was no repository to scan' } : await runOsvScannerOffline(repo, options.osv);
  facts.push(...(await recordOsvScan(recorder, REPOSITORY_SUBJECT, scan)));

  const verdict = judgeSet(loaded, { subject: REPOSITORY_SUBJECT, facts });
  await recorder.record('verdict', verdict as unknown as Json); // plain data: the judge builds it from JSON values only
  return verdict;
}
