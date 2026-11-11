/**
 * Thumbnail and proxy cache (F-4).
 *
 * Lives outside the project file, in a per-user cache folder, and is always
 * safe to delete: every entry can be rebuilt from the original media. Entries
 * are keyed by the original's absolute path, size and modified time, so an
 * edited or replaced original gets a fresh entry automatically.
 *
 * Uses the ffmpeg and ffprobe command-line tools (a system dependency).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MediaItem, Travelogue } from '../core/schema.js';
import { resolveMediaPath, writeAtomic } from './storage.js';

const run = promisify(execFile);
export const CACHE_FORMAT = 1;

export interface CacheOptions {
  root?: string;
  thumbSize?: number;
  proxyImageSize?: number;
  proxyVideoHeight?: number;
  concurrency?: number;
  ffmpeg?: string;
  ffprobe?: string;
  log?: (msg: string) => void;
}

export interface ProbeResult {
  width?: number;
  height?: number;
  durationSec?: number;
  hasAudio?: boolean;
}

export interface CacheEntry {
  itemId: string;
  /** Paths relative to the cache root. */
  thumb?: string;
  proxy?: string;
  probe?: ProbeResult;
  error?: string;
}

export interface CacheManifest {
  format: number;
  projectId: string;
  builtAt: string;
  entries: Record<string, CacheEntry>;
}

export function defaultCacheRoot(): string {
  if (process.env.TRIPALOGUE_CACHE) return path.resolve(process.env.TRIPALOGUE_CACHE);
  const base = process.env.XDG_CACHE_HOME
    ?? (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches')
      : process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'))
        : path.join(os.homedir(), '.cache'));
  return path.join(base, 'tripalogue');
}

export const manifestPath = (root: string, projectId: string) => path.join(root, 'projects', `${projectId}.json`);

export async function readManifest(root: string, projectId: string): Promise<CacheManifest | undefined> {
  try {
    const m = JSON.parse(await fs.readFile(manifestPath(root, projectId), 'utf8')) as CacheManifest;
    return m.format === CACHE_FORMAT ? m : undefined;
  } catch {
    return undefined;
  }
}

export async function probe(file: string, ffprobe = 'ffprobe'): Promise<ProbeResult> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { maxBuffer: 8 << 20 });
  const j = JSON.parse(stdout) as {
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string; side_data_list?: { rotation?: number }[]; tags?: { rotate?: string } }[];
    format?: { duration?: string; format_name?: string };
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
  };
}

async function keyFor(file: string, variant: string): Promise<string> {
  const st = await fs.stat(file);
  return createHash('sha1').update(`${CACHE_FORMAT}|${path.resolve(file)}|${st.size}|${st.mtimeMs}|${variant}`).digest('hex');
}

async function exists(f: string): Promise<boolean> {
  try {
    await fs.access(f);
    return true;
  } catch {
    return false;
  }
}

/** Run ffmpeg into a temp file, then rename, so an interrupted build never leaves a broken entry. */
async function ffmpegTo(out: string, args: string[], ffmpeg: string): Promise<void> {
  await fs.mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp${path.extname(out)}`;
  try {
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, tmp], { maxBuffer: 8 << 20 });
    await fs.rename(tmp, out);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

const fitScale = (max: number) => `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`;

export async function buildItem(file: string, item: MediaItem, o: Required<Omit<CacheOptions, 'log'>>): Promise<CacheEntry> {
  const entry: CacheEntry = { itemId: item.id };
  const rel = (abs: string) => path.relative(o.root, abs).split(path.sep).join('/');
  const slot = (key: string, ext: string) => path.join(o.root, 'entries', key.slice(0, 2), `${key}${ext}`);
  try {
    entry.probe = await probe(file, o.ffprobe);
    if (item.kind === 'image') {
      const thumb = slot(await keyFor(file, `thumb${o.thumbSize}`), '.jpg');
      if (!(await exists(thumb))) await ffmpegTo(thumb, ['-i', file, '-vf', fitScale(o.thumbSize), '-frames:v', '1', '-q:v', '4'], o.ffmpeg);
      const proxy = slot(await keyFor(file, `proxy${o.proxyImageSize}`), '.jpg');
      if (!(await exists(proxy))) await ffmpegTo(proxy, ['-i', file, '-vf', fitScale(o.proxyImageSize), '-frames:v', '1', '-q:v', '3'], o.ffmpeg);
      entry.thumb = rel(thumb);
      entry.proxy = rel(proxy);
    } else if (item.kind === 'video') {
      const at = Math.min(1, (entry.probe.durationSec ?? 0) / 10);
      const thumb = slot(await keyFor(file, `thumb${o.thumbSize}`), '.jpg');
      if (!(await exists(thumb))) await ffmpegTo(thumb, ['-ss', String(at), '-i', file, '-vf', fitScale(o.thumbSize), '-frames:v', '1', '-q:v', '4'], o.ffmpeg);
      // A keyframe every second keeps seeks (scrubbing, trimmed in-points) fast.
      const proxy = slot(await keyFor(file, `proxy${o.proxyVideoHeight}-kf1`), '.mp4');
      if (!(await exists(proxy))) {
        await ffmpegTo(proxy, [
          '-i', file, '-vf', `scale=-2:'min(${o.proxyVideoHeight},ih)'`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*1)',
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
        ], o.ffmpeg);
      }
      entry.thumb = rel(thumb);
      entry.proxy = rel(proxy);
    }
    // Audio items: probe only in Phase 0; waveform thumbnails arrive with MM-15.
  } catch (e) {
    entry.error = (e as Error).message.split('\n')[0].slice(0, 300);
  }
  return entry;
}

export class CacheLocationError extends Error {}

/**
 * The cache must be safe to delete, so it may never sit inside the project's
 * folder or a media source folder (or contain them): clearing it would then
 * delete the user's work or originals. Symlinks are resolved first.
 */
export async function assertCacheOutsideProject(root: string, projectFile: string, p: Travelogue): Promise<void> {
  const real = async (f: string) => {
    let cur = path.resolve(f);
    const rest: string[] = [];
    for (;;) {
      try {
        return path.join(await fs.realpath(cur), ...rest.reverse());
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return path.resolve(f);
        rest.push(path.basename(cur));
        cur = parent;
      }
    }
  };
  const within = (a: string, b: string) => a === b || a.startsWith(b + path.sep);
  const cache = await real(root);
  const guarded = [path.dirname(projectFile), ...p.sources.filter((s) => s.type === 'localFolder').map((s) => resolveMediaPath(projectFile, s.rootPath, '.'))];
  for (const g of guarded) {
    const dir = await real(g);
    if (within(cache, dir) || within(dir, cache)) {
      throw new CacheLocationError(`Cache folder ${root} overlaps ${g}; choose a cache folder outside the project and its media folders.`);
    }
  }
}

/** Build (or refresh) cache entries for every media item and write the project's manifest. */
export async function buildCache(projectFile: string, p: Travelogue, opts: CacheOptions = {}): Promise<{ root: string; manifest: CacheManifest }> {
  const o = {
    root: opts.root ?? defaultCacheRoot(),
    thumbSize: opts.thumbSize ?? 320,
    proxyImageSize: opts.proxyImageSize ?? 1920,
    proxyVideoHeight: opts.proxyVideoHeight ?? 720,
    concurrency: opts.concurrency ?? Math.max(1, Math.min(4, os.cpus().length - 1)),
    ffmpeg: opts.ffmpeg ?? 'ffmpeg',
    ffprobe: opts.ffprobe ?? 'ffprobe',
  };
  const log = opts.log ?? (() => {});
  const sources = new Map(p.sources.map((s) => [s.id, s]));
  await assertCacheOutsideProject(o.root, projectFile, p);
  const entries: Record<string, CacheEntry> = {};
  const queue = p.media.filter((m) => sources.get(m.sourceId)?.type === 'localFolder');
  let done = 0;
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const file = resolveMediaPath(projectFile, sources.get(item.sourceId)?.rootPath, item.uri);
      entries[item.id] = await buildItem(file, item, o);
      done += 1;
      log(`[${done}/${p.media.length}] ${item.id}${entries[item.id].error ? ' — ' + entries[item.id].error : ''}`);
    }
  };
  await Promise.all(Array.from({ length: o.concurrency }, worker));
  const manifest: CacheManifest = { format: CACHE_FORMAT, projectId: p.id, builtAt: new Date().toISOString(), entries };
  await writeAtomic(manifestPath(o.root, p.id), JSON.stringify(manifest, null, 2));
  return { root: o.root, manifest };
}

/** Copy probed sizes and durations into media items that lack them. Returns the same object if nothing changed. */
export function applyProbes(p: Travelogue, m: CacheManifest): Travelogue {
  let changed = false;
  const media = p.media.map((item) => {
    const pr = m.entries[item.id]?.probe;
    if (!pr) return item;
    const next = {
      ...item,
      width: item.width ?? pr.width,
      height: item.height ?? pr.height,
      durationSec: item.durationSec ?? (item.kind !== 'image' ? pr.durationSec : undefined),
    };
    if (next.width !== item.width || next.height !== item.height || next.durationSec !== item.durationSec) {
      changed = true;
      return next;
    }
    return item;
  });
  return changed ? { ...p, media } : p;
}
