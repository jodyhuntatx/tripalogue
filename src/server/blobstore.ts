/**
 * Object storage. Originals are written once and never altered; derived files
 * (thumbnails, proxies) can always be rebuilt from them.
 *
 * The interface is shaped like an object store (put, stat, ranged read,
 * delete) so an S3-compatible driver can replace the file-system driver
 * without touching the services. localPath() exists for media tools such as
 * ffmpeg; a remote driver would download to a temp file there.
 */
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

export interface BlobStat {
  size: number;
}

export interface BlobStore {
  /** Move (or copy) a finished local file into the store under key. */
  putFile(key: string, file: string): Promise<void>;
  stat(key: string): Promise<BlobStat | null>;
  read(key: string, range?: { start: number; end: number }): Readable;
  /** A local file path holding the blob's bytes, for tools that need one. */
  localPath(key: string): Promise<string>;
  delete(key: string): Promise<void>;
  /** Delete every blob whose key starts with this folder prefix ("derived/p1/m1/"). */
  deletePrefix(prefix: string): Promise<void>;
}

const KEY = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;

export function assertKey(key: string): void {
  if (!KEY.test(key) || key.length > 512 || key.split('/').some((s) => s === '.' || s === '..')) throw new Error(`Invalid blob key "${key}"`);
}

export class FsBlobStore implements BlobStore {
  constructor(readonly root: string) {}

  private file(key: string): string {
    assertKey(key);
    const f = path.resolve(this.root, key);
    if (!f.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Blob key escapes the store');
    return f;
  }

  async putFile(key: string, src: string): Promise<void> {
    const dest = this.file(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.rename(src, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      const tmp = `${dest}.${process.pid}.tmp`;
      await fs.copyFile(src, tmp);
      await fs.rename(tmp, dest);
      await fs.rm(src, { force: true });
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    try {
      const st = await fs.stat(this.file(key));
      return st.isFile() ? { size: st.size } : null;
    } catch {
      return null;
    }
  }

  read(key: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.file(key), range);
  }

  async localPath(key: string): Promise<string> {
    const f = this.file(key);
    await fs.access(f);
    return f;
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    if (!/^[a-z]+\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?\/$/.test(prefix)) throw new Error(`refusing to delete prefix "${prefix}"`);
    await fs.rm(this.file(prefix.slice(0, -1)), { recursive: true, force: true });
  }
}
