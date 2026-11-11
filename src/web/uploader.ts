/**
 * Resumable uploads from the browser (F-7). Files go up in chunks, each sent
 * at the server's current offset; a dropped connection is retried with
 * back-off, and an interrupted upload resumes from the server's offset after a
 * page reload (the upload id is remembered in localStorage). The file's bytes
 * are sent unaltered, so capture time and location survive.
 */
import { samplePrefix, sampleRanges } from '../core/samplehash.js';
import { api, ApiError } from './api.js';

export interface UploadProgress {
  file: File;
  sent: number;
  total: number;
  state: 'queued' | 'checking' | 'uploading' | 'retrying' | 'done' | 'skipped' | 'failed';
  error?: string;
  mediaId?: string;
}

const memo = (projectId: string, f: File, mediaId?: string) => `tl-up:${projectId}:${mediaId ?? f.name}:${f.size}:${f.lastModified}`;

function store(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export async function uploadFile(projectId: string, file: File, opts: { mediaId?: string; onProgress?: (p: UploadProgress) => void } = {}): Promise<string> {
  const p: UploadProgress = { file, sent: 0, total: file.size, state: 'uploading', mediaId: opts.mediaId };
  const report = () => opts.onProgress?.({ ...p });
  report();
  const key = memo(projectId, file, opts.mediaId);
  let uploadId = store()?.getItem(key) ?? undefined;
  let offset = 0;
  let chunk = 8 * 1024 * 1024;
  if (uploadId) {
    try {
      const st = await api<{ offset: number; complete: boolean; mediaId: string }>('GET', `/api/uploads/${uploadId}`);
      if (st.complete) {
        store()?.removeItem(key);
        p.sent = file.size;
        p.state = 'done';
        p.mediaId = st.mediaId;
        report();
        return st.mediaId;
      }
      offset = st.offset;
      p.mediaId = st.mediaId;
    } catch {
      uploadId = undefined;
    }
  }
  if (!uploadId) {
    const created = await api<{ uploadId: string; mediaId: string; offset: number; chunkBytes: number }>('POST', `/api/projects/${projectId}/uploads`, {
      fileName: file.name, size: file.size, mediaId: opts.mediaId, lastModified: file.lastModified,
    });
    uploadId = created.uploadId;
    offset = created.offset;
    chunk = created.chunkBytes;
    p.mediaId = created.mediaId;
    store()?.setItem(key, uploadId);
  }
  p.sent = offset;
  report();
  let failures = 0;
  while (offset < file.size) {
    try {
      const r = await api<{ offset: number; complete: boolean }>('PUT', `/api/uploads/${uploadId}?offset=${offset}`, undefined, { raw: file.slice(offset, Math.min(file.size, offset + chunk)) });
      offset = r.offset;
      failures = 0;
      p.sent = offset;
      p.state = 'uploading';
      report();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'offset_mismatch' || err.offline || err.status >= 500 || err.code === 'busy') {
        if (++failures > 6) throw e;
        p.state = 'retrying';
        report();
        await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** failures)));
        const st = await api<{ offset: number }>('GET', `/api/uploads/${uploadId}`).catch(() => ({ offset }));
        offset = st.offset;
        continue;
      }
      throw e;
    }
  }
  store()?.removeItem(key);
  p.state = 'done';
  report();
  return p.mediaId!;
}

/** Sample hash of a file in the browser (see core/samplehash.ts); undefined where Web Crypto is unavailable (plain http). */
export async function sampleHash(file: Blob): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const parts: Uint8Array[] = [samplePrefix(file.size)];
  for (const [a, b] of sampleRanges(file.size)) parts.push(new Uint8Array(await file.slice(a, b).arrayBuffer()));
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { all.set(x, o); o += x.length; }
  const digest = new Uint8Array(await subtle.digest('SHA-256', all));
  return [...digest].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** MM-7: which new files the project already has, by sample hash. Failures just mean "upload everything". */
async function alreadyUploaded(projectId: string, files: File[]): Promise<Map<number, { mediaId: string; uri: string }>> {
  const out = new Map<number, { mediaId: string; uri: string }>();
  try {
    const hashes: (string | undefined)[] = [];
    for (const f of files) hashes.push(await sampleHash(f));
    const asked = files.map((f, i) => ({ i, size: f.size, sampleHash: hashes[i] })).filter((x) => x.sampleHash);
    if (!asked.length) return out;
    const r = await api<{ known: { index: number; mediaId: string; uri: string }[] }>('POST', `/api/projects/${projectId}/uploads/check`, { files: asked.map(({ size, sampleHash }) => ({ size, sampleHash })) });
    for (const k of r.known) out.set(asked[k.index].i, { mediaId: k.mediaId, uri: k.uri });
  } catch {
    /* check unavailable: upload everything */
  }
  return out;
}

/** Upload several files, a few at a time. New files the project already has (same content) are skipped (MM-7). */
export async function uploadAll(
  projectId: string, jobs: { file: File; mediaId?: string }[], onProgress: (all: UploadProgress[]) => void, parallel = 3,
): Promise<UploadProgress[]> {
  const state: UploadProgress[] = jobs.map((j) => ({ file: j.file, sent: 0, total: j.file.size, state: j.mediaId ? 'queued' : 'checking', mediaId: j.mediaId }));
  const emit = () => onProgress(state.map((s) => ({ ...s })));
  emit();
  const fresh = jobs.map((j, i) => ({ j, i })).filter((x) => !x.j.mediaId);
  const known = await alreadyUploaded(projectId, fresh.map((x) => x.j.file));
  const skip = new Set<number>();
  for (const [k, v] of known) {
    const i = fresh[k].i;
    skip.add(i);
    state[i] = { ...state[i], state: 'skipped', sent: state[i].total, mediaId: v.mediaId, error: `already uploaded as ${v.uri.split('/').pop()}` };
  }
  for (const s of state) if (s.state === 'checking') s.state = 'queued';
  emit();
  const queue = jobs.map((j, i) => ({ ...j, i })).filter((x) => !skip.has(x.i));
  const worker = async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      const i = j.i;
      try {
        await uploadFile(projectId, j.file, { mediaId: j.mediaId, onProgress: (p) => { state[i] = p; emit(); } });
      } catch (e) {
        state[i] = { ...state[i], state: 'failed', error: (e as Error).message };
        emit();
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return state;
}

// ---------------------------------------------------------------- picking files and folders (MM-1)

const SUPPORTED = /\.(jpe?g|png|heic|heif|webp|gif|mp4|mov|m4v|webm|mp3|m4a|aac|wav)$/i;

/** Photo, video and audio files only, skipping hidden and system files (".DS_Store", "._IMG_1.JPG", "Thumbs.db"). */
export function mediaFiles(files: Iterable<File>): File[] {
  return [...files].filter((f) => !f.name.startsWith('.') && SUPPORTED.test(f.name));
}

interface Entry { isFile: boolean; isDirectory: boolean; name: string; file?: (ok: (f: File) => void, err: (e: unknown) => void) => void; createReader?: () => { readEntries: (ok: (e: Entry[]) => void, err: (e: unknown) => void) => void } }

async function walk(entry: Entry, out: File[]): Promise<void> {
  if (entry.name.startsWith('.')) return;
  if (entry.isFile && entry.file) {
    out.push(await new Promise<File>((ok, err) => entry.file!(ok, err)));
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // readEntries returns at most ~100 entries per call: keep asking until it returns none.
    for (;;) {
      const batch = await new Promise<Entry[]>((ok, err) => reader.readEntries(ok, err));
      if (!batch.length) break;
      for (const e of batch) await walk(e, out);
    }
  }
}

/** Every media file in a drop, looking inside dropped folders (and their subfolders). */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => (i.kind === 'file' ? (i as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.() : null));
  if (!entries.some(Boolean)) return mediaFiles(dt.files);
  const out: File[] = [];
  for (const e of entries) if (e) await walk(e, out);
  return mediaFiles(out);
}
