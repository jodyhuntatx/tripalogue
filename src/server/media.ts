/**
 * Media processing jobs (F-4): probe each original and make a thumbnail and a
 * proxy in object storage. Proxies keep a keyframe every second so seeking is
 * fast. Everything here is rebuildable from the original at any time.
 *
 * Jobs live in the database, so they survive restarts; a worker loop (inside
 * the web process by default, or a separate `tripalogue worker`) runs them.
 * Uses the ffmpeg and ffprobe command-line tools.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MediaItem } from '../core/index.js';
import type { BlobStore } from './blobstore.js';
import type { ServerConfig } from './config.js';
import type { Db } from './db.js';
import { SYSTEM_USER, type Projects } from './projects.js';

const run = promisify(execFile);
const MAX_ATTEMPTS = 3;

export interface ProbeResult {
  width?: number;
  height?: number;
  durationSec?: number;
  hasAudio?: boolean;
  createdAt?: string;
}

export async function probe(file: string, ffprobe = 'ffprobe'): Promise<ProbeResult> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { maxBuffer: 8 << 20 });
  const j = JSON.parse(stdout) as {
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string; side_data_list?: { rotation?: number }[]; tags?: { rotate?: string } }[];
    format?: { duration?: string; format_name?: string; tags?: { creation_time?: string } };
  };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  const rot = Math.abs(Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0)) % 180;
  const isStill = /image2|png_pipe|jpeg_pipe|webp_pipe|heif|tiff_pipe|bmp_pipe/.test(j.format?.format_name ?? '');
  const dur = Number(j.format?.duration ?? v?.duration);
  return {
    width: v ? (rot === 90 ? v.height : v.width) : undefined,
    height: v ? (rot === 90 ? v.width : v.height) : undefined,
    durationSec: !isStill && Number.isFinite(dur) ? Math.round(dur * 1000) / 1000 : undefined,
    hasAudio: !!a,
    createdAt: j.format?.tags?.creation_time,
  };
}

const fitScale = (max: number) => `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`;

export class Jobs {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly db: Db, private readonly cfg: ServerConfig, private readonly blobs: BlobStore, private readonly projects: Projects) {}

  enqueue(projectId: string, mediaId: string): void {
    const now = Date.now();
    this.db.run('INSERT INTO jobs (kind, project_id, media_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'process', projectId, mediaId, 'queued', now, now);
    this.kick();
  }

  /** Start polling for jobs. Jobs left "running" by a crash are re-queued. */
  start(intervalMs = 500): void {
    this.db.run("UPDATE jobs SET status = 'queued' WHERE status = 'running'");
    this.timer = setInterval(() => this.kick(), intervalMs);
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pending(projectId?: string): number {
    const q = "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')" + (projectId ? ' AND project_id = ?' : '');
    return Number(this.db.get<{ n: number }>(q, ...(projectId ? [projectId] : []))?.n ?? 0);
  }

  /** Resolves when no jobs are queued or running (tests and the import tool). */
  idle(): Promise<void> {
    if (!this.running && this.pending() === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
      if (this.pending() === 0) this.idleWaiters.splice(0).forEach((r) => r());
    });
  }

  private async drain(): Promise<void> {
    const concurrency = Math.max(1, Math.min(4, os.cpus().length - 1));
    const take = () => this.db.tx(() => {
      const j = this.db.get<{ id: number; project_id: string; media_id: string; attempts: number }>("SELECT id, project_id, media_id, attempts FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1");
      if (j) this.db.run("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?", Date.now(), j.id);
      return j;
    });
    const worker = async () => {
      for (let j = take(); j; j = take()) {
        try {
          await this.process(j.project_id, j.media_id);
          this.db.run("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?", Date.now(), j.id);
        } catch (e) {
          const msg = (e as Error).message.split('\n')[0].slice(0, 300);
          const final = j.attempts + 1 >= MAX_ATTEMPTS;
          this.db.run('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?', final ? 'failed' : 'queued', msg, Date.now(), j.id);
          if (final) this.markFailed(j.project_id, j.media_id, msg);
          this.cfg.log(`media job ${j.id} (${j.media_id}) ${final ? 'failed' : 'will retry'}: ${msg}`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  private markFailed(projectId: string, mediaId: string, error: string) {
    try {
      this.projects.serverChange(projectId, SYSTEM_USER, 'Media processing failed', (doc) => ({
        ...doc, media: doc.media.map((m) => (m.id === mediaId ? { ...m, status: 'failed' as const, error } : m)),
      }));
    } catch {
      /* project deleted */
    }
  }

  async process(projectId: string, mediaId: string): Promise<void> {
    const item = this.projects.load(projectId).doc.media.find((m) => m.id === mediaId);
    if (!item?.storageKey) throw new Error('media item has no stored original');
    const src = await this.blobs.localPath(item.storageKey);
    const pr = await probe(src, this.cfg.ffprobe);
    const assets: MediaItem['assets'] = {};
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-job-'));
    try {
      const ff = (args: string[]) => run(this.cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 8 << 20 });
      const base = `derived/${projectId}/${mediaId}`;
      if (item.kind === 'image' || item.kind === 'video') {
        const at = item.kind === 'video' ? ['-ss', String(Math.min(1, (pr.durationSec ?? 0) / 10))] : [];
        const thumb = path.join(tmp, 'thumb.jpg');
        await ff([...at, '-i', src, '-vf', fitScale(320), '-frames:v', '1', '-q:v', '4', thumb]);
        await this.blobs.putFile(`${base}/thumb.jpg`, thumb);
        assets.thumb = `${base}/thumb.jpg`;
      }
      if (item.kind === 'image') {
        const proxy = path.join(tmp, 'proxy.jpg');
        await ff(['-i', src, '-vf', fitScale(1920), '-frames:v', '1', '-q:v', '3', proxy]);
        await this.blobs.putFile(`${base}/proxy.jpg`, proxy);
        assets.proxy = `${base}/proxy.jpg`;
      } else if (item.kind === 'video') {
        const proxy = path.join(tmp, 'proxy.mp4');
        await ff([
          '-i', src, '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
          '-force_key_frames', 'expr:gte(t,n_forced*1)', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', proxy,
        ]);
        await this.blobs.putFile(`${base}/proxy.mp4`, proxy);
        assets.proxy = `${base}/proxy.mp4`;
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
    this.projects.serverChange(projectId, SYSTEM_USER, `Processed ${item.uri}`, (doc) => ({
      ...doc,
      media: doc.media.map((m) => (m.id !== mediaId ? m : {
        ...m,
        width: m.width ?? pr.width,
        height: m.height ?? pr.height,
        durationSec: m.durationSec ?? (m.kind !== 'image' ? pr.durationSec : undefined),
        capturedAt: m.capturedAt ?? pr.createdAt,
        timestampConfidence: m.timestampConfidence ?? (pr.createdAt ? 'high' : undefined),
        assets,
        status: 'ready' as const,
        error: undefined,
      })),
    }));
  }
}
