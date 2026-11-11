/**
 * Resumable uploads of originals (F-7).
 *
 * 1. POST   /api/projects/:id/uploads   {fileName, size, mediaId?}  → {uploadId, offset, chunkBytes}
 * 2. PUT    /api/uploads/:uploadId?offset=N   (raw bytes)          → {offset}
 * 3. GET    /api/uploads/:uploadId                                 → {offset, size}  (to resume)
 *
 * A chunk must start exactly at the current offset, so a retried or
 * duplicated chunk can never corrupt the file. When the last byte arrives the
 * file is hashed, moved into object storage unaltered, and queued for
 * processing. Uploading into an existing pending item (import) or creating a
 * new item are both supported.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MediaItem } from '../core/index.js';
import type { User } from './auth.js';
import type { BlobStore } from './blobstore.js';
import type { ServerConfig } from './config.js';
import type { Db } from './db.js';
import { HttpError, type Req } from './http.js';
import type { Jobs } from './media.js';
import type { Projects } from './projects.js';

const KIND_BY_EXT: Record<string, MediaItem['kind']> = {
  jpg: 'image', jpeg: 'image', png: 'image', heic: 'image', heif: 'image', webp: 'image', gif: 'image',
  mp4: 'video', mov: 'video', m4v: 'video', webm: 'video',
  mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio',
};

export function kindForFile(name: string): MediaItem['kind'] | undefined {
  return KIND_BY_EXT[path.extname(name).slice(1).toLowerCase()];
}

interface UploadRow {
  id: string;
  project_id: string;
  media_id: string;
  user_id: string;
  file_name: string;
  size: number;
  received: number;
  completed_at: number | null;
}

export class Uploads {
  private readonly tmpDir: string;
  private readonly busy = new Set<string>();

  constructor(private readonly db: Db, private readonly cfg: ServerConfig, private readonly blobs: BlobStore, private readonly projects: Projects, private readonly jobs: Jobs) {
    this.tmpDir = path.join(cfg.dataDir, 'uploads');
  }

  private part(id: string) {
    return path.join(this.tmpDir, `${id}.part`);
  }

  async create(projectId: string, user: User, body: Record<string, unknown>): Promise<{ uploadId: string; mediaId: string; offset: number; chunkBytes: number }> {
    const fileName = typeof body.fileName === 'string' ? path.basename(body.fileName).slice(0, 255) : '';
    const size = Number(body.size);
    if (!fileName) throw new HttpError(400, 'fileName is required', 'invalid');
    if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'size must be a positive whole number of bytes', 'invalid');
    if (size > this.cfg.maxUploadBytes) throw new HttpError(413, `Files may be up to ${Math.round(this.cfg.maxUploadBytes / 1024 ** 3)} GB`, 'too_large');
    const kind = kindForFile(fileName);
    if (!kind) throw new HttpError(415, `${fileName}: unsupported file type`, 'unsupported');

    let mediaId: string;
    if (typeof body.mediaId === 'string') {
      mediaId = body.mediaId;
      const item = this.projects.load(projectId).doc.media.find((m) => m.id === mediaId);
      if (!item) throw new HttpError(404, 'No such media item', 'not_found');
      if (item.status === 'ready' || item.status === 'processing') throw new HttpError(409, `${item.uri} is already uploaded`, 'already_uploaded');
      // Resume an unfinished upload for the same item and size instead of starting over.
      const prior = this.db.get<UploadRow>('SELECT * FROM uploads WHERE project_id = ? AND media_id = ? AND completed_at IS NULL AND size = ? ORDER BY created_at DESC', projectId, mediaId, size);
      if (prior) return { uploadId: prior.id, mediaId, offset: prior.received, chunkBytes: this.cfg.chunkBytes };
      this.projects.serverChange(projectId, user.id, `Uploading ${item.uri}`, (doc) => ({
        ...doc, media: doc.media.map((m) => (m.id === mediaId ? { ...m, status: 'uploading' as const, uploadedBy: user.id, error: undefined } : m)),
      }));
    } else {
      mediaId = this.projects.addUploadedItem(projectId, user, fileName, kind);
    }
    const uploadId = `up_${randomBytes(12).toString('base64url')}`;
    await fs.mkdir(this.tmpDir, { recursive: true });
    await fs.writeFile(this.part(uploadId), '');
    this.db.run('INSERT INTO uploads (id, project_id, media_id, user_id, file_name, size, received, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      uploadId, projectId, mediaId, user.id, fileName, size, Date.now());
    return { uploadId, mediaId, offset: 0, chunkBytes: this.cfg.chunkBytes };
  }

  status(uploadId: string, user: User): { offset: number; size: number; complete: boolean; mediaId: string } {
    const u = this.get(uploadId, user);
    return { offset: u.received, size: u.size, complete: u.completed_at !== null, mediaId: u.media_id };
  }

  private get(uploadId: string, user: User): UploadRow {
    const u = this.db.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', uploadId);
    if (!u || u.user_id !== user.id) throw new HttpError(404, 'Upload not found', 'not_found');
    return u;
  }

  async putChunk(uploadId: string, user: User, offset: number, req: Req): Promise<{ offset: number; complete: boolean }> {
    const u = this.get(uploadId, user);
    if (u.completed_at !== null) return { offset: u.size, complete: true };
    if (this.busy.has(uploadId)) throw new HttpError(409, 'Another chunk for this upload is in progress', 'busy');
    if (offset !== u.received) throw new HttpError(409, `Expected offset ${u.received}`, 'offset_mismatch');
    this.busy.add(uploadId);
    try {
      const fh = await fs.open(this.part(uploadId), 'r+');
      let written = 0;
      try {
        for await (const chunk of req) {
          const buf = chunk as Buffer;
          if (written + buf.length > this.cfg.chunkBytes * 2 || u.received + written + buf.length > u.size) {
            throw new HttpError(413, 'Chunk is larger than allowed or past the end of the file', 'too_large');
          }
          await fh.write(buf, 0, buf.length, u.received + written);
          written += buf.length;
        }
      } finally {
        await fh.close();
      }
      const received = u.received + written;
      this.db.run('UPDATE uploads SET received = ? WHERE id = ?', received, uploadId);
      if (received === u.size) {
        await this.finish(u);
        return { offset: received, complete: true };
      }
      return { offset: received, complete: false };
    } finally {
      this.busy.delete(uploadId);
    }
  }

  private async finish(u: UploadRow): Promise<void> {
    const file = this.part(u.id);
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    const contentHash = hash.digest('hex');
    const ext = path.extname(u.file_name).toLowerCase().replace(/[^.a-z0-9]/g, '');
    const key = `originals/${u.project_id}/${u.media_id}${ext}`;
    await this.blobs.putFile(key, file);
    this.db.run('UPDATE uploads SET completed_at = ? WHERE id = ?', Date.now(), u.id);
    this.projects.serverChange(u.project_id, u.user_id, `Uploaded ${u.file_name}`, (doc) => ({
      ...doc,
      media: doc.media.map((m) => (m.id === u.media_id ? { ...m, storageKey: key, contentHash, sizeBytes: u.size, uploadedBy: u.user_id, status: 'processing' as const } : m)),
    }));
    this.jobs.enqueue(u.project_id, u.media_id);
  }
}
