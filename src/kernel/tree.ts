// SPDX-License-Identifier: AGPL-3.0-only
// The Merkle tree over a ledger's lines, as RFC 9162 section 2.1.1 defines it (docs/ALGORITHMS.md K1). A leaf is
// SHA-256(0x00 ‖ line) over the line as stored, without its newline; an inner node is SHA-256(0x01 ‖ left ‖ right),
// split at the largest power of two below the count; the empty tree's root is SHA-256 of nothing.
import { type Sha256, concat } from './store.js';

const LEAF = new Uint8Array([0x00]);
const NODE = new Uint8Array([0x01]);

export function leafHash(line: Uint8Array, sha256: Sha256): Promise<Uint8Array> {
  return sha256(concat(LEAF, line));
}

/** The root over leaf hashes already taken, so a writer can keep the leaves and not the lines. */
export async function rootOfLeaves(leaves: readonly Uint8Array[], sha256: Sha256): Promise<Uint8Array> {
  if (leaves.length === 0) return sha256(new Uint8Array());
  if (leaves.length === 1) return leaves[0] as Uint8Array;
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  const left = await rootOfLeaves(leaves.slice(0, k), sha256);
  const right = await rootOfLeaves(leaves.slice(k), sha256);
  return sha256(concat(NODE, left, right));
}

export async function treeRoot(lines: readonly Uint8Array[], sha256: Sha256): Promise<Uint8Array> {
  const leaves = await Promise.all(lines.map((line) => leafHash(line, sha256)));
  return rootOfLeaves(leaves, sha256);
}
