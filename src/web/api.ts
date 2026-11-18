/** Thin client for the TripAlogue JSON API. */
import type { ExportSettings, Operation, Travelogue } from '../core/index.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
  }
  /** Network failure (offline, server down) rather than a refusal. */
  get offline(): boolean {
    return this.status === 0;
  }
}

export interface User {
  id: string;
  email: string;
  name: string;
}
export type Role = 'owner' | 'editor' | 'contributor' | 'viewer';
export interface LockInfo {
  userId: string;
  name: string;
  expiresAt: number;
}
export interface OpRecord {
  rev: number;
  author: string;
  origin: 'client' | 'server';
  at: number;
  label: string;
  ops: Operation[];
}

/** Whether the server's ffmpeg can process media, and which HEIC converters work. */
export interface MediaToolStatus { ok: boolean; problems: string[]; heic: string[] }

export async function api<T = unknown>(method: string, path: string, body?: unknown, opts: { raw?: BodyInit; keepalive?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      keepalive: opts.keepalive,
      headers: {
        'X-TripAlogue-Client': '1',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.raw !== undefined ? { 'Content-Type': 'application/octet-stream' } : {}),
      },
      body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Cannot reach TripAlogue. Check your connection.');
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new ApiError(res.status, String(data.code ?? 'error'), String(data.error ?? res.statusText), data);
  return data as T;
}

/** An MP4 export, as the server reports it (server/exports.ts). */
export interface RenderInfo {
  id: string;
  projectId: string;
  rev: number;
  name: string;
  settings: ExportSettings;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  step: string | null;
  etaSec: number | null;
  error: { message: string; itemId?: string; reason?: string } | null;
  bytes: number | null;
  durationSec: number | null;
  path: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  seen: boolean;
}

export const Api = {
  config: () => api<{ telemetryEndpoint: string | null; chunkBytes: number; maxUploadBytes: number; map: { tiles: boolean; search: boolean; attribution: string }; media?: MediaToolStatus; purgeAfterDays?: number }>('GET', '/api/config'),
  mediaTools: (recheck = false) => api<MediaToolStatus>('GET', `/api/media-tools${recheck ? '?recheck=1' : ''}`),
  purgeMedia: (id: string, mediaIds: string[]) => api<{ deleted: string[] }>('POST', `/api/projects/${encodeURIComponent(id)}/media/purge`, { mediaIds }),
  deleteProject: (id: string, confirmTitle: string) => api<{ deleted: boolean }>('DELETE', `/api/projects/${encodeURIComponent(id)}`, { confirmTitle }),
  retryMedia: (id: string, mediaIds?: string[]) => api<{ queued: string[]; media: MediaToolStatus }>('POST', `/api/projects/${encodeURIComponent(id)}/media/retry`, mediaIds ? { mediaIds } : {}),
  geoSearch: (q: string, lang?: string) => api<{ places: { name: string; displayName: string; lat: number; lng: number; kind?: string }[] }>('GET', `/api/geo/search?q=${encodeURIComponent(q)}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`),
  me: () => api<{ user: User }>('GET', '/api/me'),
  projects: () => api<{ projects: { id: string; title: string; role: Role; updatedAt: number; items: number }[] }>('GET', '/api/projects'),
  createProject: (title: string) => api<{ id: string }>('POST', '/api/projects', { title }),
  importProject: (text: string) => api<{ id: string; pending: { mediaId: string; uri: string }[] }>('POST', '/api/projects/import', undefined, { raw: text }),
  project: (id: string) => api<{ project: Travelogue; rev: number; role: Role; me: User; lock: LockInfo | null; pendingJobs: number }>('GET', `/api/projects/${id}`),
  opsSince: (id: string, since: number) => api<{ rev: number; ops: OpRecord[]; lock: LockInfo | null; pendingJobs: number }>('GET', `/api/projects/${id}/ops?since=${since}`),
  commit: (id: string, baseRev: number, label: string, ops: Operation[], keepalive = false) => api<{ rev: number; catchUp: OpRecord[]; stamps: Operation[] }>('POST', `/api/projects/${id}/ops`, { baseRev, label, ops }, { keepalive }),
  lock: (id: string) => api<{ lock: LockInfo }>('POST', `/api/projects/${id}/lock`, {}),
  unlock: (id: string, keepalive = false) => api('DELETE', `/api/projects/${id}/lock`, undefined, { keepalive }),
  versions: (id: string) => api<{ versions: { id: string; rev: number; author: string; at: number; label: string; auto: boolean }[] }>('GET', `/api/projects/${id}/versions`),
  saveVersion: (id: string, label: string) => api<{ id: string }>('POST', `/api/projects/${id}/versions`, { label }),
  restore: (id: string, vid: string) => api<{ rev: number }>('POST', `/api/projects/${id}/versions/${vid}/restore`, {}),
  renders: (id: string) => api<{ renders: RenderInfo[] }>('GET', `/api/projects/${encodeURIComponent(id)}/renders`),
  unseenRenders: () => api<{ renders: RenderInfo[] }>('GET', '/api/renders/unseen'),
  startRender: (id: string, settings: ExportSettings, titleCards: Record<number, string>) =>
    api<{ render: RenderInfo }>('POST', `/api/projects/${encodeURIComponent(id)}/renders`, { settings, titleCards }),
  cancelRender: (id: string, rid: string) => api<{ render: RenderInfo }>('POST', `/api/projects/${encodeURIComponent(id)}/renders/${encodeURIComponent(rid)}/cancel`, {}),
  seenRender: (id: string, rid: string) => api<{ render: RenderInfo }>('POST', `/api/projects/${encodeURIComponent(id)}/renders/${encodeURIComponent(rid)}/seen`, {}),
  deleteRender: (id: string, rid: string) => api('DELETE', `/api/projects/${encodeURIComponent(id)}/renders/${encodeURIComponent(rid)}`),
  renderFileUrl: (id: string, rid: string, inline = false) => `/api/projects/${encodeURIComponent(id)}/renders/${encodeURIComponent(rid)}/file${inline ? '?inline=1' : ''}`,
  mediaUrl: (id: string, mediaId: string, variant: 'proxy' | 'thumb' | 'original' | 'jpeg') => `/api/projects/${encodeURIComponent(id)}/media/${encodeURIComponent(mediaId)}/${variant}`,
};
