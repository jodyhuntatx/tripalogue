/** Thin client for the TripAlogue JSON API. */
import type { Operation, Travelogue } from '../core/index.js';

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

export const Api = {
  config: () => api<{ google: boolean; telemetryEndpoint: string | null; chunkBytes: number; maxUploadBytes: number; map: { tiles: boolean; search: boolean; attribution: string }; media?: MediaToolStatus }>('GET', '/api/config'),
  mediaTools: (recheck = false) => api<MediaToolStatus>('GET', `/api/media-tools${recheck ? '?recheck=1' : ''}`),
  retryMedia: (id: string, mediaIds?: string[]) => api<{ queued: string[]; media: MediaToolStatus }>('POST', `/api/projects/${encodeURIComponent(id)}/media/retry`, mediaIds ? { mediaIds } : {}),
  geoSearch: (q: string, lang?: string) => api<{ places: { name: string; displayName: string; lat: number; lng: number; kind?: string }[] }>('GET', `/api/geo/search?q=${encodeURIComponent(q)}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`),
  me: () => api<{ user: User | null }>('GET', '/api/me'),
  requestLink: (email: string, next?: string) => api('POST', '/api/auth/email', { email, next }),
  logout: () => api('POST', '/api/auth/logout', {}),
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
  members: (id: string) => api<{ members: { userId: string; name: string; email: string; role: Role; joinedAt: number }[] }>('GET', `/api/projects/${id}/members`),
  invite: (id: string, email: string, role: Role) => api('POST', `/api/projects/${id}/invites`, { email, role }),
  setRole: (id: string, uid: string, role: Role) => api('PATCH', `/api/projects/${id}/members/${uid}`, { role }),
  removeMember: (id: string, uid: string) => api('DELETE', `/api/projects/${id}/members/${uid}`),
  mediaUrl: (id: string, mediaId: string, variant: 'proxy' | 'thumb' | 'original' | 'jpeg') => `/api/projects/${encodeURIComponent(id)}/media/${encodeURIComponent(mediaId)}/${variant}`,
};
