/**
 * Undo/redo history (F-2).
 *
 * State is treated as immutable: every edit is a function that returns a new
 * state sharing unchanged branches with the old one, so keeping hundreds of
 * snapshots costs only the changed paths. Consecutive edits with the same
 * coalesce key inside the window (e.g. dragging a duration handle) collapse
 * into one undo step.
 */

export interface EditOptions {
  /** Edits that change the project's structure trigger an immediate autosave. */
  structural?: boolean;
  /** Edits with the same key within coalesceMs merge into one undo step. */
  coalesceKey?: string;
}

export interface HistoryEntry<T> {
  label: string;
  before: T;
  after: T;
  at: number;
  coalesceKey?: string;
}

export type HistoryListener<T> = (state: T, change: { label: string; kind: 'edit' | 'undo' | 'redo' | 'reset' | 'remote'; structural: boolean }) => void;

export const MIN_HISTORY_DEPTH = 100;

export class History<T> {
  private past: HistoryEntry<T>[] = [];
  private future: HistoryEntry<T>[] = [];
  private listeners = new Set<HistoryListener<T>>();
  private current: T;
  readonly limit: number;

  constructor(
    initial: T,
    private readonly opts: { limit?: number; coalesceMs?: number; now?: () => number } = {},
  ) {
    this.current = initial;
    this.limit = Math.max(MIN_HISTORY_DEPTH, opts.limit ?? 200);
  }

  get state(): T {
    return this.current;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get undoLabel(): string | undefined {
    return this.past.at(-1)?.label;
  }
  get redoLabel(): string | undefined {
    return this.future.at(-1)?.label;
  }
  get depth(): { undo: number; redo: number } {
    return { undo: this.past.length, redo: this.future.length };
  }

  /** Apply an edit. Returns false (and records nothing) if the edit returned the same state. */
  edit(label: string, fn: (state: T) => T, options: EditOptions = {}): boolean {
    const before = this.current;
    const after = fn(before);
    if (after === before) return false;
    const now = (this.opts.now ?? Date.now)();
    const last = this.past.at(-1);
    const window = this.opts.coalesceMs ?? 1000;
    if (options.coalesceKey && last && last.coalesceKey === options.coalesceKey && now - last.at <= window && this.future.length === 0) {
      last.after = after;
      last.at = now;
    } else {
      this.past.push({ label, before, after, at: now, coalesceKey: options.coalesceKey });
      if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    }
    this.future = [];
    this.current = after;
    this.emit(label, 'edit', options.structural ?? false);
    return true;
  }

  undo(): boolean {
    const entry = this.past.pop();
    if (!entry) return false;
    this.future.push(entry);
    this.current = entry.before;
    this.emit(entry.label, 'undo', true);
    return true;
  }

  redo(): boolean {
    const entry = this.future.pop();
    if (!entry) return false;
    this.past.push(entry);
    this.current = entry.after;
    this.emit(entry.label, 'redo', true);
    return true;
  }

  /**
   * Fold a change made elsewhere (another session, or the server) into every
   * state this history holds, without adding an undo step. Undo and redo then
   * keep that change instead of reverting it. If the change cannot be applied
   * to an older state it is left as it was.
   */
  rebase(fn: (state: T) => T, label = 'Remote change'): void {
    const safe = (s: T) => {
      try {
        return fn(s);
      } catch {
        return s;
      }
    };
    for (const e of [...this.past, ...this.future]) {
      e.before = safe(e.before);
      e.after = safe(e.after);
    }
    this.current = fn(this.current);
    this.emit(label, 'remote', false);
  }

  /** Replace state without an undo step (open, recover). Clears history. */
  reset(state: T, label = 'Open'): void {
    this.past = [];
    this.future = [];
    this.current = state;
    this.emit(label, 'reset', false);
  }

  subscribe(fn: HistoryListener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(label: string, kind: 'edit' | 'undo' | 'redo' | 'reset' | 'remote', structural: boolean) {
    for (const l of this.listeners) l(this.current, { label, kind, structural });
  }
}
