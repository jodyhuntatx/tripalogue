/**
 * A project open in the browser: local undo history, the operation queue that
 * saves edits to the server, the edit lock, and polling for changes made
 * elsewhere (uploads finishing, media processed, other members).
 *
 * Every local edit becomes operations (diff of the before and after states),
 * queued and sent within about a second (autosave). If the connection drops,
 * edits stay queued and are sent when it returns. Changes from elsewhere are
 * folded into the undo history, so undo never reverts someone else's work.
 */
import { applyOps, Autosaver, diff, History, type EditOptions, type Operation, type Travelogue } from '../core/index.js';
import { Api, ApiError, type LockInfo, type Role, type User } from './api.js';

export type SaveStatus = 'saved' | 'saving' | 'offline' | 'readonly' | 'error';

const POLL_MS = 2500;
const LOCK_RENEW_MS = 20_000;

export class ProjectSession {
  readonly history: History<Travelogue>;
  rev: number;
  lock: LockInfo | null;
  pendingJobs: number;
  status: SaveStatus = 'saved';
  message = '';
  private queue: { label: string; ops: Operation[] }[] = [];
  private last: Travelogue;
  private autosaver: Autosaver<Travelogue>;
  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<() => void>();
  private polling = false;

  private constructor(readonly id: string, project: Travelogue, rev: number, readonly role: Role, readonly me: User, lock: LockInfo | null, pendingJobs: number) {
    this.history = new History(project, { limit: 200, coalesceMs: 800 });
    this.last = project;
    this.rev = rev;
    this.lock = lock;
    this.pendingJobs = pendingJobs;
    this.history.subscribe((state, change) => {
      if (change.kind === 'edit' || change.kind === 'undo' || change.kind === 'redo') {
        const ops = diff(this.last, state);
        if (ops.length) {
          const prev = this.queue[this.queue.length - 1];
          if (change.kind === 'edit' && prev && prev.label === change.label && this.status !== 'saving') prev.ops.push(...ops);
          else this.queue.push({ label: change.kind === 'edit' ? change.label : `${change.kind === 'undo' ? 'Undo' : 'Redo'} ${change.label}`, ops });
          this.autosaver.markDirty(true);
          this.setStatus(this.status === 'offline' ? 'offline' : 'saving');
        }
      }
      this.last = state;
      this.emit();
    });
    this.autosaver = new Autosaver({ getState: () => this.history.state, save: () => this.flush(), intervalMs: 2000, structuralDebounceMs: 300 });
  }

  static async open(id: string): Promise<ProjectSession> {
    const r = await Api.project(id);
    const s = new ProjectSession(id, r.project, r.rev, r.role, r.me, r.lock, r.pendingJobs);
    if (s.mayEdit) await s.takeLock();
    s.setStatus(s.canEdit ? 'saved' : 'readonly');
    s.timers.push(setInterval(() => void s.poll(), POLL_MS));
    if (s.mayEdit) s.timers.push(setInterval(() => void s.takeLock(), LOCK_RENEW_MS));
    return s;
  }

  get state(): Travelogue {
    return this.history.state;
  }
  /** Role allows editing. */
  get mayEdit(): boolean {
    return this.role === 'owner' || this.role === 'editor';
  }
  /** Role allows it and this session holds the edit lock. */
  get canEdit(): boolean {
    return this.mayEdit && this.lock?.userId === this.me.id;
  }
  get unsaved(): number {
    return this.queue.length;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }
  private setStatus(s: SaveStatus, message = '') {
    this.status = s;
    this.message = message;
    this.emit();
  }

  edit(label: string, fn: (p: Travelogue) => Travelogue, opts: EditOptions = {}): boolean {
    if (!this.canEdit) return false;
    return this.history.edit(label, fn, opts);
  }
  undo(): boolean {
    return this.canEdit && this.history.undo();
  }
  redo(): boolean {
    return this.canEdit && this.history.redo();
  }

  async takeLock(): Promise<void> {
    try {
      const r = await Api.lock(this.id);
      this.lock = r.lock;
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 423) this.lock = (err.data.lock as LockInfo | undefined) ?? this.lock;
    }
    if (!this.canEdit && this.status !== 'offline') this.setStatus('readonly');
    else if (this.status === 'readonly') this.setStatus('saved');
    else this.emit();
  }

  /** Send queued edits, oldest first. */
  async flush(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue[0];
      this.setStatus('saving');
      try {
        const r = await Api.commit(this.id, this.rev, batch.label, batch.ops);
        this.queue.shift();
        const remote = [...r.catchUp.flatMap((c) => c.ops), ...r.stamps];
        this.rev = r.rev;
        if (remote.length) this.applyRemote(remote);
      } catch (e) {
        const err = e as ApiError;
        if (err.offline || err.status >= 500) {
          this.setStatus('offline', 'Offline: your changes will be saved when the connection returns');
          throw e;
        }
        if (err.status === 423) {
          this.queue = [];
          await this.reload();
          this.setStatus('readonly', `Not saved: ${err.message}`);
          return;
        }
        // Conflict or rejected change: reload the server's copy so the screen is truthful.
        this.queue = [];
        await this.reload();
        this.setStatus('error', `Your last change was not saved: ${err.message}`);
        return;
      }
    }
    this.setStatus(this.canEdit ? 'saved' : 'readonly');
  }

  private applyRemote(ops: Operation[]) {
    this.history.rebase((s) => applyOps(s, ops));
    this.last = this.history.state;
  }

  async reload(): Promise<void> {
    const r = await Api.project(this.id);
    this.rev = r.rev;
    this.lock = r.lock;
    this.pendingJobs = r.pendingJobs;
    this.history.reset(r.project, 'Reloaded');
    this.last = r.project;
  }

  /** Pick up changes made elsewhere. Skipped while local edits are waiting to be saved. */
  async poll(): Promise<void> {
    if (this.polling || this.queue.length) return;
    this.polling = true;
    try {
      const r = await Api.opsSince(this.id, this.rev);
      if (this.queue.length) return;
      const mine = r.ops.filter((o) => o.rev > this.rev);
      if (mine.length) this.applyRemote(mine.flatMap((o) => o.ops));
      this.rev = Math.max(this.rev, r.rev);
      const lockChanged = (r.lock?.userId ?? null) !== (this.lock?.userId ?? null);
      this.lock = r.lock;
      this.pendingJobs = r.pendingJobs;
      if (this.status === 'offline') this.setStatus(this.canEdit ? 'saved' : 'readonly');
      else if (lockChanged) this.setStatus(this.canEdit ? 'saved' : 'readonly');
      else if (mine.length || r.pendingJobs) this.emit();
    } catch (e) {
      if ((e as ApiError).offline) this.setStatus('offline', 'Offline: reconnecting…');
    } finally {
      this.polling = false;
    }
  }

  /**
   * The page is going away: send whatever is still queued as one batch with
   * keepalive, which the browser completes even after the page has unloaded.
   */
  flushOnExit(): boolean {
    if (!this.queue.length || !this.canEdit) return false;
    const ops = this.queue.flatMap((q) => q.ops);
    const label = this.queue.length === 1 ? this.queue[0].label : `${this.queue.length} edits`;
    this.queue = [];
    void Api.commit(this.id, this.rev, label, ops, true).catch(() => {});
    this.exitSent = true;
    return true;
  }
  private exitSent = false;

  async close(): Promise<void> {
    this.flushOnExit();
    for (const t of this.timers) clearInterval(t);
    try {
      await this.autosaver.dispose();
    } catch {
      /* stays queued until the next visit only if offline; nothing else to do */
    }
    // If edits were just sent on the way out, let the lock expire on its own (about a minute)
    // rather than racing the release against that save.
    if (this.canEdit && !this.exitSent) await Api.unlock(this.id, true).catch(() => {});
  }
}
