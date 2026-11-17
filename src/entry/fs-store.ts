// SPDX-License-Identifier: AGPL-3.0-only
// The file-system side of a proof bundle (docs/FOUNDATION.md §5, §14): the kernel's Store over one folder, and SHA-256
// from node:crypto. The kernel does no input or output of its own; this is what it is handed. A path is relative,
// uses "/", and stays inside the folder: the store refuses anything else before it touches the disk.
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sha256, Store } from '../kernel/store.js';

export const nodeSha256: Sha256 = async (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());

/** A path that is not one this store will touch: it is absolute, or has a drive, a backslash, a "..", or an empty part. */
export class StorePathError extends Error {}

export interface FsStoreOptions {
  /** Moves the file written beside the target onto it. Tests replace it to stand in for a crash. */
  rename?: (from: string, to: string) => Promise<void>;
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export class FsStore implements Store {
  private readonly root: string;
  private readonly rename: (from: string, to: string) => Promise<void>;

  constructor(root: string, options: FsStoreOptions = {}) {
    this.root = path.resolve(root);
    this.rename = options.rename ?? renameWithRetry;
  }

  async read(relative: string): Promise<Uint8Array | undefined> {
    const file = await this.resolve(relative);
    try {
      return new Uint8Array(await readFile(file));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
      throw error;
    }
  }

  /** Replaces the file whole: the bytes are written beside it and then renamed over it, so a crash leaves the old or the new. */
  async write(relative: string, bytes: Uint8Array): Promise<void> {
    const file = await this.resolve(relative, true);
    const beside = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(beside, bytes);
      await this.rename(beside, file);
    } catch (error) {
      await rm(beside, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async append(relative: string, bytes: Uint8Array): Promise<void> {
    await appendFile(await this.resolve(relative, true), bytes);
  }

  /** The path on disk for a bundle path, after refusing any that leaves the folder; makes the folders above it when asked. */
  private async resolve(relative: string, makeFolders = false): Promise<string> {
    checkRelative(relative);
    const file = path.join(this.root, ...relative.split('/'));
    if (makeFolders) await mkdir(path.dirname(file), { recursive: true });
    await this.checkLinks(path.dirname(file));
    return file;
  }

  /** The folder the file is in must really be inside the bundle: a link in the bundle can lead out of it. */
  private async checkLinks(folder: string): Promise<void> {
    let real: string;
    try {
      real = await realpath(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const base = await realpath(this.root).catch(() => this.root);
    if (real !== base && !real.startsWith(base + path.sep)) {
      throw new StorePathError(`${JSON.stringify(folder)} leads outside the bundle folder`);
    }
  }
}

function checkRelative(relative: string): void {
  const refuse = (why: string): never => {
    throw new StorePathError(`${JSON.stringify(relative)} is not a path inside a bundle: ${why}`);
  };
  if (typeof relative !== 'string' || relative === '') return refuse('it is empty');
  if (relative.includes('\u0000')) return refuse('it has a NUL');
  if (relative.includes('\\')) return refuse('it has a backslash');
  if (relative.startsWith('/')) return refuse('it is absolute');
  if (relative.includes(':')) return refuse('it has a drive or a stream name');
  for (const part of relative.split('/')) {
    if (part === '' || part === '.' || part === '..') return refuse('it has an empty part, "." or ".."');
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  // Windows refuses a rename over a file another process has open for an instant; trying again is enough.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 5 || !RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
