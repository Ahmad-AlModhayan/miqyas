// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { treeRoot } from '../../src/kernel/tree.js';
import { sha256, utf8 } from '../kernel-helpers.js';

// The expected roots were computed once, outside this repository, by a short Python script using only hashlib:
// the Merkle tree hash of RFC 9162 section 2.1.1 (as in RFC 6962), written directly from the RFC, over the lines
// "line 0", "line 1", ... as UTF-8. None of this repository's code was used to compute them.
const EXPECTED: Record<number, string> = {
  0: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  1: '34f50f7d0310e8ba2ab2c1efe8d6bd680aeda70b67f6e3cf8fc7f29e4a161ad0',
  2: 'f28ea81d8c3f38b19c71068c76992a3fd14c3ec47f64d32bcf71865fa545977f',
  3: 'e8d3e3ae206483e0df450ff2112c9f0aa773aeb01c3ee6e28191fea4eb7b7402',
  7: '7771cee9fa6ff1524141b74c3be67456c5684b89b57b941cb616971640b4466f',
  8: '55a6611a239db316e56c95840eb08b421d0c9abc241ea02efe76d62c4f7f0012',
};

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const lines = (n: number): Uint8Array[] => Array.from({ length: n }, (_, i) => utf8(`line ${i}`));

describe('the tree over the ledger lines (RFC 9162)', () => {
  for (const n of [0, 1, 2, 3, 7, 8]) {
    it(`gives the independently computed root for ${n} records`, async () => {
      expect(hex(await treeRoot(lines(n), sha256))).toBe(EXPECTED[n]);
    });
  }

  it('gives a different root when one line changes', async () => {
    const changed = lines(7);
    changed[4] = utf8('line 4 edited');
    expect(hex(await treeRoot(changed, sha256))).not.toBe(EXPECTED[7]);
  });
});
