/**
 * Resumable uploads from the browser (F-7). Files go up in chunks, each sent
 * at the server's current offset; a dropped connection is retried with
 * back-off, and an interrupted upload resumes from the server's offset after a
 * page reload (the upload id is remembered in localStorage). The file's bytes
 * are sent unaltered, so capture time and location survive.
 */
import { api, ApiError } from './api.js';

export interface UploadProgress {
  file: File;
  sent: number;
  total: number;
  state: 'queued' | 'uploading' | 'retrying' | 'done' | 'failed';
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

/** Upload several files, a few at a time. */
export async function uploadAll(
  projectId: string, jobs: { file: File; mediaId?: string }[], onProgress: (all: UploadProgress[]) => void, parallel = 3,
): Promise<UploadProgress[]> {
  const state: UploadProgress[] = jobs.map((j) => ({ file: j.file, sent: 0, total: j.file.size, state: 'queued', mediaId: j.mediaId }));
  const queue = jobs.map((j, i) => ({ ...j, i }));
  const emit = () => onProgress(state.map((s) => ({ ...s })));
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
