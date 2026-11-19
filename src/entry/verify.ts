// SPDX-License-Identifier: AGPL-3.0-only
// `miqyas verify <bundle>` (docs/FOUNDATION.md §5, "Verifying"). It needs no target, model or network: it reads the
// folder it is given and answers the questions of §5 one by one, each apart. This version answers the first two,
// "Intact?" and "Does the result follow?", with the kernel's verifyIntact and verifyResult. The others are listed as
// not checked yet, so that a pass is never read as more than it is, and each takes its place in QUESTIONS when built.
import { stat } from 'node:fs/promises';
import type { Problem } from '../kernel/ledger.js';
import type { Sha256, Store } from '../kernel/store.js';
import { type Follows, verifyIntact, verifyResult } from '../kernel/verify.js';
import { FsStore, nodeSha256 } from './fs-store.js';

export interface VerifyReport {
  /** 0 when every question this version answers is answered yes; 1 when one is answered no; 2 when there is no folder to read. */
  exitCode: number;
  lines: string[];
}

interface Answer {
  ok: boolean;
  lines: string[];
}

interface Question {
  title: string;
  /** Missing for a question this version does not answer yet. */
  answer?: (store: Store, sha256: Sha256) => Promise<Answer>;
  /** Answered only over a bundle the first question found intact: a ledger it rejected can't answer anything. */
  needsIntact?: boolean;
}

const QUESTIONS: Question[] = [
  { title: 'Intact?', answer: intact },
  { title: 'Does the result follow?', answer: async (store) => follows(await verifyResult(store)), needsIntact: true },
  { title: 'Do the verdicts follow?' },
  { title: 'Do the derived facts follow?' },
];

/** What a bundle can't show, stated in every report (docs/FOUNDATION.md §5). */
const LIMITS = [
  "A bundle can't show that a collector recorded the target faithfully.",
  "It can't show who made it, or that nothing was left off the end, unless its head was published somewhere its holder doesn't control.",
];

export async function verifyBundle(bundle: string): Promise<VerifyReport> {
  let isFolder = false;
  try {
    isFolder = (await stat(bundle)).isDirectory();
  } catch {
    // Falls through to the message below.
  }
  if (!isFolder) return { exitCode: 2, lines: [`miqyas: ${bundle} is not a folder, so there is no bundle to verify`] };

  const store = new FsStore(bundle);
  const lines = [`miqyas verify ${bundle}`];
  let failed = false;
  let bundleIntact = true;
  for (const [i, question] of QUESTIONS.entries()) {
    if (question.answer === undefined) {
      lines.push(`${i + 1}. ${question.title} not checked yet`);
      continue;
    }
    if (question.needsIntact && !bundleIntact) {
      lines.push(`${i + 1}. ${question.title} not answered: the bundle is not intact, so its records can't answer it`);
      continue;
    }
    const answer = await question.answer(store, nodeSha256);
    if (i === 0) bundleIntact = answer.ok;
    failed ||= !answer.ok;
    lines.push(`${i + 1}. ${question.title} ${answer.ok ? 'yes' : 'NO'}`, ...answer.lines.map((l) => `   ${l}`));
  }
  lines.push(...LIMITS);
  return { exitCode: failed ? 1 : 0, lines };
}

async function intact(store: Store, sha256: Sha256): Promise<Answer> {
  const result = await verifyIntact(store, sha256);
  const lines: string[] = [];
  if (result.checkpoint !== null) {
    lines.push(`head: ${result.checkpoint.size} records, root ${result.checkpoint.root}`);
  }
  lines.push(`ledger: ${result.records} records${result.sealed ? ', sealed' : ', not sealed'}`);
  if (result.torn !== null) {
    lines.push(
      `torn: record ${result.torn.record} is cut off after ${result.torn.bytes} bytes. A crash leaves that; it is not tampering.`,
    );
  }
  for (const problem of result.problems) lines.push(`problem: ${describe(problem)}`);
  return { ok: result.ok, lines };
}

function describe({ path, record, reason }: Problem): string {
  return `${path}${record === undefined ? '' : ` (record ${record})`}: ${reason}`;
}

/** Words what verifyResult found: the seal against the fold, then, when they disagree, each verdict record. */
function follows(found: Follows): Answer {
  if (found.seal === null) return { ok: false, lines: ["there is no seal: the run didn't finish, so no result follows"] };
  const { seal, recomputed, records, agree } = found;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const lines = [
    `the seal (record ${seal.seq}) says ${seal.verdict ?? '(nothing)'} over ${seal.verdicts === null ? 'an unstated number of verdicts' : plural(seal.verdicts, 'verdict')}, ` +
      `${seal.exit === null ? 'with no exit code' : `exit ${seal.exit}`}; ` +
      `the fold of the ${plural(recomputed.verdicts, 'verdict record')} gives ${recomputed.verdict}, exit ${recomputed.exit}`,
  ];
  if (!agree) for (const r of records) lines.push(`record ${r.seq}: ${r.claim ?? '(no claim named)'} ${r.verdict ?? '(no verdict)'}`);
  return { ok: agree, lines };
}
