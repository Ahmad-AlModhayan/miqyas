// SPDX-License-Identifier: AGPL-3.0-only
// What the tests hand the kernel: SHA-256 from node:crypto, and a store that keeps files in memory under a root.
import { createHash } from 'node:crypto';
import type { Sha256, Store } from '../src/kernel/store.js';

export const sha256: Sha256 = async (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

/** A store held in memory. Every path is kept under `root`, as a folder on disk would keep it. */
export class MemoryStore implements Store {
  readonly files = new Map<string, Uint8Array>();
  constructor(readonly root = '/runs/a') {}

  private key(path: string): string {
    return `${this.root}/${path}`;
  }
  async read(path: string): Promise<Uint8Array | undefined> {
    const bytes = this.files.get(this.key(path));
    return bytes && new Uint8Array(bytes);
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(this.key(path), new Uint8Array(bytes));
  }
  async append(path: string, bytes: Uint8Array): Promise<void> {
    const before = this.files.get(this.key(path)) ?? new Uint8Array();
    const after = new Uint8Array(before.length + bytes.length);
    after.set(before);
    after.set(bytes, before.length);
    this.files.set(this.key(path), after);
  }

  /** The same bytes under another root, as a bundle copied to another folder. */
  copyTo(root: string): MemoryStore {
    const copy = new MemoryStore(root);
    for (const [key, bytes] of this.files) copy.files.set(root + key.slice(this.root.length), new Uint8Array(bytes));
    return copy;
  }

  /** Test-only access to a file's text, for tampering. */
  textOf(path: string): string {
    return text(this.files.get(this.key(path)));
  }
  setText(path: string, value: string): void {
    this.files.set(this.key(path), utf8(value));
  }
}
