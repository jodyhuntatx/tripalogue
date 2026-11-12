/**
 * Projects: storage, roles, the operation log (F-9), version history (F-1),
 * the single-editor lock and invitations (F-8).
 *
 * Every change to a project, from a browser or from the server itself (an
 * upload finishing, a media job completing), is a batch of operations with an
 * author, an origin and a revision number. Phase 0 allows one editor at a time
 * (the lock); a client batch based on an older revision is still accepted when
 * everything in between came from the server, because those changes touch
 * different fields (media status, assets) and are id-addressed. Phase 7
 * replaces this rule with full merging.
 */
import { randomBytes } from 'node:crypto';
import {
  applyOps, createProject, defaultCue, diff, isOperation, parseProject, serializeProject, spreadKeys,
  SCHEMA_VERSION, validate, keyBetween, type Id, type MediaItem, type Operation, type Travelogue, mediaIdsIn } from '../core/index.js';
import { newId, sha256, token, type Auth, type User } from './auth.js';
import type { ServerConfig } from './config.js';
import type { Db } from './db.js';
import { HttpError } from './http.js';
import type { Mailer } from './mailer.js';

export type Role = 'owner' | 'editor' | 'contributor' | 'viewer';
export const ROLES: Role[] = ['owner', 'editor', 'contributor', 'viewer'];
const RANK: Record<Role, number> = { viewer: 0, contributor: 1, editor: 2, owner: 3 };

export const LOCK_TTL_MS = 60_000;
const AUTO_VERSION_EVERY = 50;
export const SYSTEM_USER = 'system';

export interface OpRecord {
  rev: number;
  author: string;
  origin: 'client' | 'server';
  at: number;
  label: string;
  ops: Operation[];
}

export interface LockInfo {
  userId: string;
  name: string;
  expiresAt: number;
}

export class Projects {
  constructor(private readonly db: Db, private readonly cfg: ServerConfig, private readonly mailer: Mailer, private readonly auth: Auth) {}

  // ---- access ----

  roleOf(projectId: string, userId: string): Role | undefined {
    return this.db.get<{ role: Role }>('SELECT role FROM members WHERE project_id = ? AND user_id = ?', projectId, userId)?.role;
  }

  /** Throws 404 for non-members (no information leak) and 403 for too-low roles. */
  require(projectId: string, user: User, min: Role): Role {
    const role = this.roleOf(projectId, user.id);
    if (!role) throw new HttpError(404, 'Project not found', 'not_found');
    if (RANK[role] < RANK[min]) throw new HttpError(403, `This needs the ${min} role or higher; you are a ${role}`, 'forbidden');
    return role;
  }

  // ---- create, import, read ----

  create(user: User, title: string): Travelogue {
    const p = createProject({ title });
    p.id = newId('trv');
    this.insertProject(user, p, 'Created');
    return p;
  }

  /**
   * Import a project file (any supported schema version). The project gets a
   * new id; entity ids are kept. Every media item is marked pending until its
   * original is uploaded.
   */
  import(user: User, text: string): { project: Travelogue; pending: { mediaId: string; uri: string }[] } {
    let parsed: Travelogue;
    try {
      parsed = parseProject(text).project;
    } catch (e) {
      throw new HttpError(422, (e as Error).message, 'invalid_project');
    }
    const now = new Date().toISOString();
    const project: Travelogue = {
      ...parsed,
      id: newId('trv'),
      createdAt: now,
      updatedAt: now,
      sources: parsed.sources.map((s) => ({ ...s, type: 'upload' as const, contributorId: s.contributorId ?? user.id })),
      media: parsed.media.map((m) => {
        const { storageKey: _k, contentHash: _h, assets: _a, error: _e, ...rest } = m;
        return { ...rest, status: 'pending' as const };
      }),
    };
    this.insertProject(user, project, 'Imported');
    return { project, pending: project.media.map((m) => ({ mediaId: m.id, uri: m.uri })) };
  }

  private insertProject(user: User, p: Travelogue, label: string) {
    const issues = validate(p).filter((i) => i.level === 'error');
    if (issues.length) throw new HttpError(422, `Invalid project: ${issues[0].path} ${issues[0].message}`, 'invalid_project');
    const now = Date.now();
    this.db.tx(() => {
      this.db.run('INSERT INTO projects (id, owner_id, title, rev, doc, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)', p.id, user.id, p.title, JSON.stringify(p), now, now);
      this.db.run('INSERT INTO members (project_id, user_id, role, invited_by, joined_at) VALUES (?, ?, ?, NULL, ?)', p.id, user.id, 'owner', now);
      this.snapshot(p.id, 0, user.id, label, false, p);
    });
  }

  load(projectId: string): { doc: Travelogue; rev: number } {
    const row = this.db.get<{ doc: string; rev: number }>('SELECT doc, rev FROM projects WHERE id = ?', projectId);
    if (!row) throw new HttpError(404, 'Project not found', 'not_found');
    return { doc: JSON.parse(row.doc) as Travelogue, rev: row.rev };
  }

  list(user: User): { id: string; title: string; role: Role; updatedAt: number; items: number }[] {
    return this.db.all<{ id: string; title: string; role: Role; updated_at: number; doc: string }>(
      'SELECT p.id, p.title, m.role, p.updated_at, p.doc FROM projects p JOIN members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.updated_at DESC', user.id,
    ).map((r) => ({ id: r.id, title: r.title, role: r.role, updatedAt: r.updated_at, items: (JSON.parse(r.doc) as Travelogue).media.length }));
  }

  exportText(projectId: string): string {
    const { doc } = this.load(projectId);
    // Storage keys and processing state are server internals; the export is portable.
    return serializeProject({
      ...doc,
      media: doc.media.map(({ storageKey: _k, status: _s, assets: _a, error: _e, ...m }) => m),
    });
  }

  // ---- the operation log ----

  /**
   * Commit a batch. Returns the new revision and any extra operations the
   * server added (attribution stamps, and server changes the client had not
   * seen yet) so the client can bring its copy level.
   */
  commit(
    projectId: string, authorId: string, origin: 'client' | 'server', label: string, ops: unknown, baseRev?: number,
  ): { rev: number; catchUp: OpRecord[]; stamps: Operation[] } {
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > 5000 || !ops.every(isOperation)) throw new HttpError(400, 'ops must be a non-empty list of operations', 'bad_ops');
    return this.db.tx(() => {
      const { doc, rev } = this.load(projectId);
      let catchUp: OpRecord[] = [];
      if (origin === 'client') {
        if (typeof baseRev !== 'number' || baseRev > rev || baseRev < 0) throw new HttpError(400, 'baseRev is missing or invalid', 'bad_rev');
        if (baseRev < rev) {
          catchUp = this.opsSince(projectId, baseRev);
          if (catchUp.some((r) => r.origin === 'client')) {
            throw new HttpError(409, 'The project changed since your last save', 'conflict');
          }
        }
      }
      let next: Travelogue;
      try {
        next = applyOps(doc, ops as Operation[]);
      } catch (e) {
        throw new HttpError(409, `Could not apply change: ${(e as Error).message}`, 'conflict');
      }
      if (next.id !== projectId || next.schemaVersion !== SCHEMA_VERSION) throw new HttpError(400, 'A change may not alter the project id or schema version', 'bad_ops');
      // Media deleted for good stays deleted: an edit that would bring one back (a stale Undo in another browser) is refused.
      if (origin === 'client') {
        const before = mediaIdsIn(doc);
        const back = [...mediaIdsIn(next)].filter((id) => !before.has(id));
        if (back.length) {
          const purged = this.db.all<{ media_id: string }>(`SELECT media_id FROM purged_media WHERE project_id = ? AND media_id IN (${back.map(() => '?').join(',')})`, projectId, ...back);
          if (purged.length) throw new HttpError(409, 'That change would bring back media that was deleted for good', 'purged');
        }
      }
      const stamps = authorId === SYSTEM_USER ? [] : attributionStamps(ops as Operation[], next, authorId);
      if (stamps.length) next = applyOps(next, stamps);
      const errors = validate(next).filter((i) => i.level === 'error');
      if (errors.length) throw new HttpError(422, `That change would make the project invalid: ${errors[0].path} ${errors[0].message}`, 'invalid');
      const newRev = rev + 1;
      const now = Date.now();
      this.db.run('UPDATE projects SET doc = ?, rev = ?, title = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), newRev, next.title, now, projectId);
      this.db.run('INSERT INTO operations (project_id, rev, author_id, origin, at, label, ops) VALUES (?, ?, ?, ?, ?, ?, ?)',
        projectId, newRev, authorId, origin, now, label.slice(0, 200), JSON.stringify([...(ops as Operation[]), ...stamps]));
      const lastAuto = this.db.get<{ rev: number }>('SELECT MAX(rev) AS rev FROM versions WHERE project_id = ?', projectId)?.rev ?? 0;
      if (newRev - lastAuto >= AUTO_VERSION_EVERY) this.snapshot(projectId, newRev, authorId, `Autosave at revision ${newRev}`, true, next);
      return { rev: newRev, catchUp, stamps };
    });
  }

  /** Apply a server-side change computed from the current document. */
  serverChange(projectId: string, authorId: string, label: string, change: (doc: Travelogue) => Travelogue): number | undefined {
    return this.db.tx(() => {
      const { doc } = this.load(projectId);
      const ops = diff(doc, change(doc));
      if (!ops.length) return undefined;
      return this.commit(projectId, authorId, 'server', label, ops).rev;
    });
  }

  opsSince(projectId: string, sinceRev: number, limit = 1000): OpRecord[] {
    return this.db.all<{ rev: number; author_id: string; origin: 'client' | 'server'; at: number; label: string; ops: string }>(
      'SELECT rev, author_id, origin, at, label, ops FROM operations WHERE project_id = ? AND rev > ? ORDER BY rev LIMIT ?', projectId, sinceRev, limit,
    ).map((r) => ({ rev: r.rev, author: r.author_id, origin: r.origin, at: r.at, label: r.label, ops: JSON.parse(r.ops) as Operation[] }));
  }

  // ---- versions ----

  snapshot(projectId: string, rev: number, authorId: string, label: string, auto: boolean, doc?: Travelogue): string {
    const d = doc ?? this.load(projectId).doc;
    const id = newId('ver');
    this.db.run('INSERT INTO versions (id, project_id, rev, author_id, at, label, auto, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, projectId, rev, authorId, Date.now(), label.slice(0, 200), auto ? 1 : 0, JSON.stringify(d));
    return id;
  }

  versions(projectId: string) {
    return this.db.all<{ id: string; rev: number; author: string; at: number; label: string; auto: number }>(
      'SELECT v.id, v.rev, COALESCE(u.name, v.author_id) AS author, v.at, v.label, v.auto FROM versions v LEFT JOIN users u ON u.id = v.author_id WHERE v.project_id = ? ORDER BY v.rev DESC, v.at DESC',
      projectId,
    ).map((v) => ({ ...v, auto: !!v.auto }));
  }

  /** Restore = a new revision that changes the document back; it is itself in the log and can be undone the same way. */
  restore(projectId: string, versionId: string, user: User): number {
    const v = this.db.get<{ snapshot: string; label: string }>('SELECT snapshot, label FROM versions WHERE id = ? AND project_id = ?', versionId, projectId);
    if (!v) throw new HttpError(404, 'Version not found', 'not_found');
    return this.db.tx(() => {
      const { doc, rev } = this.load(projectId);
      const target = JSON.parse(v.snapshot) as Travelogue;
      // Keep what processing learned about each item since the snapshot (status, assets, metadata).
      const now = [...doc.media, ...(doc.removed ?? []).map((r) => r.item)];
      const keep = new Map(now.map((m) => [m.id, m]));
      const fresh = (m: MediaItem) => (keep.get(m.id)?.status === 'ready' ? { ...m, ...pickMediaState(keep.get(m.id)!) } : m);
      // Media the snapshot does not know (uploaded after it) is not lost: it goes to the Removed bin, from where it
      // can be put back, and is deleted for good later like anything else removed.
      const known = mediaIdsIn(target);
      const binned = new Map((doc.removed ?? []).map((r) => [r.item.id, r]));
      const at = new Date().toISOString();
      const extra = now.filter((m) => !known.has(m.id)).map((item) => binned.get(item.id)
        ?? { item, ...(doc.cues.find((c) => c.itemId === item.id) ? { cue: doc.cues.find((c) => c.itemId === item.id)! } : {}), removedAt: at, removedBy: user.id });
      const restored: Travelogue = {
        ...target,
        id: projectId,
        media: target.media.map(fresh),
        removed: [...(target.removed ?? []).map((r) => ({ ...r, item: fresh(r.item) })), ...extra],
      };
      if (!restored.removed!.length) delete restored.removed;
      const ops = diff(doc, restored);
      if (!ops.length) return rev;
      const out = this.commit(projectId, user.id, 'server', `Restored "${v.label}"`, ops);
      this.snapshot(projectId, out.rev, user.id, `Restored "${v.label}"`, false);
      return out.rev;
    });
  }

  // ---- single-editor lock (until Phase 7) ----

  lockInfo(projectId: string): LockInfo | undefined {
    const r = this.db.get<{ user_id: string; expires_at: number; name: string }>(
      'SELECT l.user_id, l.expires_at, u.name FROM edit_locks l JOIN users u ON u.id = l.user_id WHERE l.project_id = ? AND l.expires_at > ?', projectId, Date.now(),
    );
    return r ? { userId: r.user_id, name: r.name, expiresAt: r.expires_at } : undefined;
  }

  /** Acquire or renew. Returns the holder: you if it worked, someone else if not. */
  acquireLock(projectId: string, user: User): LockInfo {
    return this.db.tx(() => {
      const cur = this.lockInfo(projectId);
      if (cur && cur.userId !== user.id) return cur;
      const expiresAt = Date.now() + LOCK_TTL_MS;
      this.db.run('INSERT INTO edit_locks (project_id, user_id, expires_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at', projectId, user.id, expiresAt);
      return { userId: user.id, name: user.name, expiresAt };
    });
  }

  releaseLock(projectId: string, user: User): void {
    this.db.run('DELETE FROM edit_locks WHERE project_id = ? AND user_id = ?', projectId, user.id);
  }

  requireLock(projectId: string, user: User): void {
    const cur = this.lockInfo(projectId);
    if (!cur || cur.userId !== user.id) {
      throw new HttpError(423, cur ? `${cur.name} is editing this travelogue right now` : 'Open the travelogue for editing first', 'locked');
    }
  }

  // ---- members and invitations ----

  members(projectId: string) {
    return this.db.all<{ user_id: string; name: string; email: string; role: Role; joined_at: number }>(
      'SELECT m.user_id, u.name, u.email, m.role, m.joined_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.joined_at', projectId,
    ).map((m) => ({ userId: m.user_id, name: m.name, email: m.email, role: m.role, joinedAt: m.joined_at }));
  }

  async invite(projectId: string, by: User, emailIn: unknown, role: unknown): Promise<void> {
    const email = this.auth.normalizeEmail(emailIn);
    if (!ROLES.includes(role as Role) || role === 'owner') throw new HttpError(400, 'role must be editor, contributor or viewer', 'invalid');
    const t = token();
    this.db.run('INSERT INTO invites (token_hash, project_id, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sha256(t), projectId, email, role, by.id, Date.now(), Date.now() + 14 * 86400_000);
    const { doc } = this.load(projectId);
    await this.mailer.send({
      to: email,
      subject: `${by.name} invited you to "${doc.title}" on TripAlogue`,
      text: `${by.name} invited you to join the travelogue "${doc.title}" as ${role === 'contributor' ? 'a contributor' : `an ${role}`}.\n\nOpen the invitation:\n\n${this.cfg.baseUrl}/api/invites/accept?token=${t}\n\nThe invitation expires in 14 days.`
        + (role === 'contributor' || role === 'editor' || role === 'owner'
          ? `\n\nAdding your photos and videos? Please upload the originals, not copies from a chat app, so they land in the right part of the trip and on the map. A one-page guide:\n\n${this.cfg.baseUrl}/guide-contributors.html`
          : ''),
    });
  }

  /** Accept an invitation as the signed-in user (who may use a different email address). */
  acceptInvite(t: string, user: User): string {
    return this.db.tx(() => {
      const inv = this.db.get<{ project_id: string; role: Role; invited_by: string; expires_at: number; accepted_by: string | null }>(
        'SELECT project_id, role, invited_by, expires_at, accepted_by FROM invites WHERE token_hash = ?', sha256(t),
      );
      if (!inv || inv.expires_at < Date.now() || (inv.accepted_by && inv.accepted_by !== user.id)) throw new HttpError(400, 'This invitation is invalid or has expired', 'bad_invite');
      this.db.run('UPDATE invites SET accepted_by = ? WHERE token_hash = ?', user.id, sha256(t));
      const existing = this.roleOf(inv.project_id, user.id);
      if (!existing) {
        this.db.run('INSERT INTO members (project_id, user_id, role, invited_by, joined_at) VALUES (?, ?, ?, ?, ?)', inv.project_id, user.id, inv.role, inv.invited_by, Date.now());
      } else if (RANK[inv.role] > RANK[existing]) {
        this.db.run('UPDATE members SET role = ? WHERE project_id = ? AND user_id = ?', inv.role, inv.project_id, user.id);
      }
      return inv.project_id;
    });
  }

  setRole(projectId: string, userId: string, role: unknown): void {
    if (!ROLES.includes(role as Role) || role === 'owner') throw new HttpError(400, 'role must be editor, contributor or viewer', 'invalid');
    if (this.roleOf(projectId, userId) === 'owner') throw new HttpError(400, 'The owner keeps the owner role', 'invalid');
    const r = this.db.run('UPDATE members SET role = ? WHERE project_id = ? AND user_id = ?', role, projectId, userId);
    if (!Number(r.changes)) throw new HttpError(404, 'Member not found', 'not_found');
  }

  removeMember(projectId: string, userId: string): void {
    if (this.roleOf(projectId, userId) === 'owner') throw new HttpError(400, 'The owner cannot be removed', 'invalid');
    this.db.run('DELETE FROM members WHERE project_id = ? AND user_id = ?', projectId, userId);
    this.db.run('DELETE FROM edit_locks WHERE project_id = ? AND user_id = ?', projectId, userId);
  }

  // ---- media items created by uploads ----

  /** Add a media item (and its default cue) for a new upload; it starts in the Unassigned bin. */
  addUploadedItem(projectId: string, user: User, fileName: string, kind: MediaItem['kind'], fileModifiedAt?: string): string {
    const id = `m_${randomBytes(6).toString('base64url')}`;
    this.serverChange(projectId, user.id, `Upload ${fileName}`, (doc) => {
      // The person's own uploads source (not a source they imported, and not one of their per-camera sources).
      let source = doc.sources.find((s) => s.id === `src_${user.id}`);
      const sources = source ? doc.sources : [...doc.sources, (source = { id: `src_${user.id}`, type: 'upload' as const, displayName: `${user.name}'s uploads`, clockOffsetSec: 0, contributorId: user.id })];
      const item: MediaItem = { id, sourceId: source.id, uri: fileName, kind, chapterId: null, status: 'uploading', uploadedBy: user.id, ...(fileModifiedAt ? { fileModifiedAt } : {}) };
      const unassigned = doc.cues.filter((c) => doc.media.find((m) => m.id === c.itemId)?.chapterId === null).map((c) => c.order).sort();
      const order = unassigned.length ? keyBetween(unassigned[unassigned.length - 1], null) : spreadKeys(1)[0];
      return { ...doc, sources, media: [...doc.media, item], cues: [...doc.cues, defaultCue(item, doc.cueProfile, order)] };
    });
    return id;
  }
}

function pickMediaState(m: MediaItem): Partial<MediaItem> {
  return { storageKey: m.storageKey, contentHash: m.contentHash, sizeBytes: m.sizeBytes, status: m.status, assets: m.assets, width: m.width, height: m.height, durationSec: m.durationSec, error: undefined,
    capturedAt: m.capturedAt, timestampConfidence: m.timestampConfidence, fileModifiedAt: m.fileModifiedAt };
}

/** Stamp updatedBy/updatedAt on every chapter, media item and cue an operation batch touched. */
function attributionStamps(ops: Operation[], doc: Travelogue, authorId: Id): Operation[] {
  const at = new Date().toISOString();
  const touched = new Set<string>();
  for (const o of ops) {
    const [coll, seg] = o.path;
    if ((coll === 'chapters' || coll === 'media' || coll === 'cues') && seg && typeof seg === 'object') touched.add(`${coll}\u0000${seg.key}`);
    if ((coll === 'chapters' || coll === 'media' || coll === 'cues') && o.path.length === 1 && o.op === 'insert') {
      const k = (o.value as { id?: string; itemId?: string }).id ?? (o.value as { itemId?: string }).itemId;
      if (k) touched.add(`${coll}\u0000${k}`);
    }
  }
  const out: Operation[] = [];
  for (const t of touched) {
    const [coll, key] = t.split('\u0000') as ['chapters' | 'media' | 'cues', string];
    const list = doc[coll] as { id?: string; itemId?: string }[];
    if (!list.some((e) => (e.id ?? e.itemId) === key)) continue; // removed in this batch
    out.push({ op: 'set', path: [coll, { key }, 'updatedBy'], value: authorId }, { op: 'set', path: [coll, { key }, 'updatedAt'], value: at });
  }
  return out;
}


