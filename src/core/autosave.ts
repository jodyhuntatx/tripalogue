/**
 * Autosave policy (F-1, PRD Section 7): save at least every 30 s while there
 * are unsaved changes, and shortly after every structural edit. Platform
 * neutral: the caller supplies the save function and (in tests) the timers.
 */

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface AutosaverOptions<T> {
  save: (state: T) => Promise<void>;
  getState: () => T;
  intervalMs?: number;
  structuralDebounceMs?: number;
  timers?: Timers;
  onError?: (e: unknown) => void;
  onSaved?: () => void;
}

export class Autosaver<T> {
  private dirty = false;
  private saving: Promise<void> | null = null;
  private pendingAfterSave = false;
  private debounce: unknown = null;
  private interval: unknown;
  private readonly timers: Timers;
  saves = 0;

  constructor(private readonly o: AutosaverOptions<T>) {
    this.timers = o.timers ?? realTimers;
    this.interval = this.timers.setInterval(() => {
      if (this.dirty) void this.flush();
    }, o.intervalMs ?? 30_000);
  }

  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  markDirty(structural = false): void {
    this.dirty = true;
    if (structural) {
      if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
      this.debounce = this.timers.setTimeout(() => {
        this.debounce = null;
        void this.flush();
      }, this.o.structuralDebounceMs ?? 750);
    }
  }

  /** Save now if dirty. Concurrent calls share one in-flight save, then re-save if edits arrived meanwhile. */
  async flush(): Promise<void> {
    if (this.saving) {
      this.pendingAfterSave = true;
      return this.saving;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const state = this.o.getState();
    this.saving = this.o
      .save(state)
      .then(() => {
        this.saves += 1;
        this.o.onSaved?.();
      })
      .catch((e) => {
        this.dirty = true;
        this.o.onError?.(e);
      })
      .finally(() => {
        this.saving = null;
      });
    await this.saving;
    if (this.pendingAfterSave) {
      this.pendingAfterSave = false;
      if (this.dirty) await this.flush();
    }
  }

  async dispose(): Promise<void> {
    this.timers.clearInterval(this.interval);
    if (this.debounce !== null) this.timers.clearTimeout(this.debounce);
    await this.flush();
  }
}
