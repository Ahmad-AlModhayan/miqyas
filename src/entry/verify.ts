// SPDX-License-Identifier: AGPL-3.0-only
// `miqyas verify <bundle>` (docs/FOUNDATION.md §5, "Verifying"). It needs no target, model or network: it reads the
// folder it is given and answers the questions of §5 one by one, each apart. This version answers the first, "Intact?",
// with the kernel's verifyIntact. The others are listed as not checked yet, so that a pass is never read as more than
// it is, and each takes its place in QUESTIONS when it is built.
import { stat } from 'node:fs/promises';
import type { Problem } from '../kernel/ledger.js';
import type { Sha256, Store } from '../kernel/store.js';
import { verifyIntact } from '../kernel/verify.js';
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
}

const QUESTIONS: Question[] = [
  { title: 'Intact?', answer: intact },
  { title: 'Does the result follow?' },
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
  for (const [i, question] of QUESTIONS.entries()) {
    if (question.answer === undefined) {
      lines.push(`${i + 1}. ${question.title} not checked yet`);
      continue;
    }
    const answer = await question.answer(store, nodeSha256);
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
