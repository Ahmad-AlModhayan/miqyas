// SPDX-License-Identifier: AGPL-3.0-only
// The checkpoint: the head of the ledger written beside it (docs/ALGORITHMS.md K3). Three lines: the origin naming
// the run, the number of records, and the root in base64, each ending in a newline. Signature lines are not written
// yet, and a checkpoint that has any, or anything else, is not one this reader recognises.

/** The size and root hash of a ledger at one moment. */
export interface Head {
  size: number;
  root: Uint8Array;
}

export interface Checkpoint extends Head {
  origin: string;
}

export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function formatCheckpoint({ origin, size, root }: Checkpoint): string {
  return `${origin}\n${size}\n${toBase64(root)}\n`;
}

const SIZE = /^(0|[1-9][0-9]{0,15})$/;
const ROOT = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes

/** Reads a checkpoint, or says why it can't. */
export function parseCheckpoint(text: string): Checkpoint | string {
  const lines = text.split('\n');
  if (lines.length !== 4 || lines[3] !== '') {
    return 'the checkpoint is not three lines (origin, size, root), and signatures are not recognised';
  }
  const [origin, size, root] = lines as [string, string, string];
  if (origin === '') return 'the checkpoint names no origin';
  if (!SIZE.test(size) || !Number.isSafeInteger(Number(size))) return `the checkpoint size ${JSON.stringify(size)} is not a count`;
  if (!ROOT.test(root)) return 'the checkpoint root is not a SHA-256 in base64';
  const bytes = Uint8Array.from(atob(root), (c) => c.charCodeAt(0));
  if (toBase64(bytes) !== root) return 'the checkpoint root is not a SHA-256 in base64';
  return { origin, size: Number(size), root: bytes };
}
