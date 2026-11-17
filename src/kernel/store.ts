// SPDX-License-Identifier: AGPL-3.0-only
// What the kernel is handed to reach storage and hashing (docs/FOUNDATION.md §14). The kernel does no input or output
// of its own: every byte of a proof bundle is read and written through a Store, and every hash is taken with the
// Sha256 it is given. Paths are relative to the bundle's folder and use "/", so a bundle reads the same wherever it is.

/** The files of one proof bundle. */
export interface Store {
  /** The file's bytes, or undefined when there is no such file. */
  read(path: string): Promise<Uint8Array | undefined>;
  /** Creates the file or replaces it whole. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Adds bytes to the end of the file, creating it when it isn't there. */
  append(path: string, bytes: Uint8Array): Promise<void>;
}

/** SHA-256 of the bytes: 32 bytes. */
export type Sha256 = (bytes: Uint8Array) => Promise<Uint8Array>;

export const LEDGER_PATH = 'ledger.jsonl';
export const CHECKPOINT_PATH = 'checkpoint';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decodes UTF-8, or returns undefined for bytes that aren't valid UTF-8. */
export function fromUtf8(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
