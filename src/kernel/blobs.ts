// SPDX-License-Identifier: AGPL-3.0-only
// Evidence too large for a record, stored beside the ledger under its SHA-256 (docs/FOUNDATION.md §5):
// blobs/sha256/<first two hex digits>/<the other 62>. A digest is written "sha256:<64 lower-case hex digits>". The
// blob store hashes every blob it is handed and every blob it gives back; one whose bytes don't match is refused.
import { type Sha256, type Store, isPlainObject, toHex } from './store.js';

/** How a fact names a blob (docs/FOUNDATION.md §3). */
export interface BlobRef {
  digest: string;
  size: number;
  mediaType: string;
}

export class BlobError extends Error {}

const DIGEST = /^sha256:([0-9a-f]{64})$/;

/**
 * Reads how a record names its blobs: `blobs` is an object whose every entry is exactly a BlobRef with a sha256
 * digest. Gives the entries that are, and a reason for each that is not. The writer refuses a record with any reason;
 * the verifier reports each one.
 */
export function readBlobRefs(blobs: unknown): { refs: [name: string, ref: BlobRef][]; problems: string[] } {
  if (!isPlainObject(blobs)) return { refs: [], problems: ['the record names its blobs in a form that is not recognised'] };
  const refs: [string, BlobRef][] = [];
  const problems: string[] = [];
  for (const [name, ref] of Object.entries(blobs)) {
    if (
      !isPlainObject(ref) ||
      Object.keys(ref).sort().join(',') !== 'digest,mediaType,size' ||
      typeof ref.digest !== 'string' ||
      typeof ref.mediaType !== 'string' ||
      !Number.isSafeInteger(ref.size) ||
      (ref.size as number) < 0
    ) {
      problems.push(`the blob "${name}" is named in a form that is not recognised`);
    } else if (blobPath(ref.digest) === undefined) {
      problems.push(`the blob "${name}" has a digest that is not recognised: ${JSON.stringify(ref.digest)}`);
    } else {
      refs.push([name, { digest: ref.digest, size: ref.size as number, mediaType: ref.mediaType }]);
    }
  }
  return { refs, problems };
}

/** The blob's path in the bundle, or undefined for a digest that isn't one this store writes. */
export function blobPath(digest: string): string | undefined {
  const hex = DIGEST.exec(digest)?.[1];
  return hex === undefined ? undefined : `blobs/sha256/${hex.slice(0, 2)}/${hex.slice(2)}`;
}

export class BlobStore {
  constructor(
    private readonly store: Store,
    private readonly sha256: Sha256,
  ) {}

  /** Stores the bytes, once, and returns how a fact names them. */
  async put(bytes: Uint8Array, mediaType: string): Promise<BlobRef> {
    const digest = `sha256:${toHex(await this.sha256(bytes))}`;
    const path = blobPath(digest) as string;
    const existing = await this.store.read(path);
    if (existing === undefined) await this.store.write(path, bytes);
    else await this.check(digest, existing);
    return { digest, size: bytes.length, mediaType };
  }

  /** The blob's bytes. Throws for a digest it doesn't recognise, a missing blob, or bytes that don't match. */
  async get(digest: string): Promise<Uint8Array> {
    const path = blobPath(digest);
    if (path === undefined) throw new BlobError(`${JSON.stringify(digest)} is not a sha256 digest`);
    const bytes = await this.store.read(path);
    if (bytes === undefined) throw new BlobError(`there is no blob ${digest}`);
    await this.check(digest, bytes);
    return bytes;
  }

  private async check(digest: string, bytes: Uint8Array): Promise<void> {
    const actual = `sha256:${toHex(await this.sha256(bytes))}`;
    if (actual !== digest) throw new BlobError(`the blob ${digest} does not match its digest: its bytes hash to ${actual}`);
  }
}
