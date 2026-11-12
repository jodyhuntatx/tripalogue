/**
 * Deleting for good: media in the Removed bin, and whole projects.
 *
 * Media: an item is deleted for good by hand ("Delete now" in the Removed bin)
 * or automatically once it has been in the bin for `purgeAfterDays`. The item
 * is first taken out of the travelogue and out of every saved version, and its
 * id is recorded so that an edit trying to bring it back (a stale Undo in
 * another browser) is refused. Only then are its original and derived files
 * erased: once nothing can bring the item back.
 *
 * Projects: the owner deletes a project and everything in it at once
 * (the database rows cascade; stored files and unfinished uploads are erased).
 */
import { mediaIdsIn, stripMedia, expiredRemovals, type MediaItem, type Travelogue } from '../core/index.js';
import type { BlobStore } from './blobstore.js';
import type { Db } from './db.js';
import { HttpError } from './http.js';
import { SYSTEM_USER, type Projects } from './projects.js';
import type { Uploads } from './uploads.js';

export class Deletion {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: Db, private readonly blobs: BlobStore, private readonly projects: Projects,
    private readonly uploads: Uploads, private readonly o: { purgeAfterDays: number; log?: (m: string) => void },
  ) {}

  /** Ids deleted for good in a project. */
  purgedIds(projectId: string): Set<string> {
    return new Set(this.db.all<{ media_id: string }>('SELECT media_id FROM purged_media WHERE project_id = ?', projectId).map((r) => r.media_id));
  }

  /**
   * Delete removed items for good. Only items in the Removed bin can be deleted this way (an item still in the
   * travelogue is removed first, so the step can be undone until now). Returns the ids deleted.
   */
  async purge(projectId: string, ids: string[], userId: string, label = 'Deleted for good'): Promise<string[]> {
    const doc = this.projects.load(projectId).doc;
    const binned = new Map((doc.removed ?? []).map((r) => [r.item.id, r.item]));
    const items = ids.filter((id) => binned.has(id)).map((id) => binned.get(id)!);
    if (!items.length) return [];
    const gone = items.map((m) => m.id);
    this.db.tx(() => {
      this.projects.serverChange(projectId, userId, gone.length === 1 ? label : `${label}: ${gone.length} items`, (d) => stripMedia(d, gone));
      // Saved versions: take the items out, so restoring a version cannot bring them back.
      const versions = this.db.all<{ id: string; snapshot: string }>('SELECT id, snapshot FROM versions WHERE project_id = ?', projectId);
      for (const v of versions) {
        const snap = JSON.parse(v.snapshot) as Travelogue;
        if (!gone.some((id) => mediaIdsIn(snap).has(id))) continue;
        this.db.run('UPDATE versions SET snapshot = ? WHERE id = ?', JSON.stringify(stripMedia(snap, gone)), v.id);
      }
      const now = Date.now();
      for (const id of gone) this.db.run('INSERT OR IGNORE INTO purged_media (project_id, media_id, purged_at) VALUES (?, ?, ?)', projectId, id, now);
      this.db.run(`DELETE FROM jobs WHERE project_id = ? AND media_id IN (${gone.map(() => '?').join(',')})`, projectId, ...gone);
    });
    // Nothing refers to them any more: erase the files.
    await this.uploads.discard(projectId, gone);
    for (const m of items) await this.eraseFiles(projectId, m);
    return gone;
  }

  private async eraseFiles(projectId: string, m: MediaItem): Promise<void> {
    if (m.storageKey) await this.blobs.delete(m.storageKey).catch(() => {});
    for (const key of Object.values(m.assets ?? {})) if (key) await this.blobs.delete(key).catch(() => {});
    await this.blobs.deletePrefix(`derived/${projectId}/${m.id}/`).catch(() => {});
  }

  /** Delete items whose time in the Removed bin is up, in every project. */
  async sweep(now = Date.now()): Promise<number> {
    let n = 0;
    const projects = this.db.all<{ id: string; doc: string }>("SELECT id, doc FROM projects WHERE doc LIKE '%\"removed\"%'");
    for (const p of projects) {
      const due = expiredRemovals(JSON.parse(p.doc) as Travelogue, now, this.o.purgeAfterDays);
      if (due.length) n += (await this.purge(p.id, due, SYSTEM_USER, `Deleted for good after ${this.o.purgeAfterDays} days in the Removed bin`)).length;
    }
    if (n) this.o.log?.(`deleted ${n} removed item(s) for good after ${this.o.purgeAfterDays} days`);
    return n;
  }

  start(intervalMs = 60 * 60 * 1000): void {
    void this.sweep().catch((e) => this.o.log?.(`removed-item sweep failed: ${(e as Error).message}`));
    this.timer = setInterval(() => void this.sweep().catch((e) => this.o.log?.(`removed-item sweep failed: ${(e as Error).message}`)), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Delete a whole project and everything in it. The caller checks the user is the owner. */
  async deleteProject(projectId: string, confirmTitle: unknown): Promise<void> {
    const row = this.db.get<{ title: string }>('SELECT title FROM projects WHERE id = ?', projectId);
    if (!row) throw new HttpError(404, 'No such project', 'not_found');
    if (typeof confirmTitle !== 'string' || confirmTitle.trim() !== row.title.trim()) {
      throw new HttpError(400, 'Type the travelogue’s title exactly to confirm', 'confirm');
    }
    await this.uploads.discard(projectId);
    this.db.tx(() => {
      this.db.run('DELETE FROM jobs WHERE project_id = ?', projectId);
      this.db.run('DELETE FROM projects WHERE id = ?', projectId); // members, invites, operations, versions, locks, uploads, purged ids cascade
    });
    await this.blobs.deletePrefix(`originals/${projectId}/`).catch(() => {});
    await this.blobs.deletePrefix(`derived/${projectId}/`).catch(() => {});
  }
}
