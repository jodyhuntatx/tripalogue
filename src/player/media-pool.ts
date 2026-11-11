/**
 * Loads and keeps the media elements the player needs: a small LRU of decoded
 * images and video elements, preloading the segments just ahead of the
 * playhead so playback does not stall on segment boundaries.
 */
export type MediaEl = HTMLImageElement | HTMLVideoElement;

export interface PoolEntry {
  el: MediaEl;
  ready: boolean;
  failed: boolean;
  lastUsed: number;
}

export class MediaPool {
  private entries = new Map<string, PoolEntry>();
  onError: (itemId: string, kind: string) => void = () => {};
  onReady: (itemId: string) => void = () => {};

  constructor(
    private readonly urlFor: (itemId: string, kind: 'image' | 'video') => string,
    private readonly capacity = 16,
  ) {}

  get(itemId: string): PoolEntry | undefined {
    const e = this.entries.get(itemId);
    if (e) e.lastUsed = performance.now();
    return e;
  }

  ensure(itemId: string, kind: 'image' | 'video'): PoolEntry {
    const existing = this.get(itemId);
    if (existing) return existing;
    let entry: PoolEntry;
    if (kind === 'image') {
      const img = new Image();
      img.decoding = 'async';
      entry = { el: img, ready: false, failed: false, lastUsed: performance.now() };
      img.onload = () => {
        img.decode().catch(() => {}).finally(() => {
          entry.ready = true;
          this.onReady(itemId);
        });
      };
      img.onerror = () => {
        if (this.entries.get(itemId) !== entry) return;
        entry.failed = true;
        this.onError(itemId, kind);
      };
      img.src = this.urlFor(itemId, kind);
    } else {
      const v = document.createElement('video');
      v.preload = 'auto';
      v.playsInline = true;
      v.crossOrigin = 'anonymous';
      entry = { el: v, ready: false, failed: false, lastUsed: performance.now() };
      v.addEventListener('loadeddata', () => {
        entry.ready = true;
        this.onReady(itemId);
      });
      v.addEventListener('error', () => {
        if (this.entries.get(itemId) !== entry) return;
        entry.failed = true;
        this.onError(itemId, kind);
      });
      v.src = this.urlFor(itemId, kind);
      v.load();
    }
    this.entries.set(itemId, entry);
    this.evict(itemId);
    return entry;
  }

  /** Drop an entry so the next use loads it again (its file changed). */
  forget(itemId: string): void {
    const e = this.entries.get(itemId);
    if (!e) return;
    this.entries.delete(itemId);
    if (e.el instanceof HTMLVideoElement) {
      e.el.pause();
      e.el.removeAttribute('src');
      e.el.load();
    } else {
      e.el.onload = null;
      e.el.onerror = null;
      e.el.removeAttribute('src');
    }
  }

  /** Retry an item that failed to load earlier (for example before its upload finished). */
  forgetIfFailed(itemId: string): void {
    if (this.entries.get(itemId)?.failed) this.forget(itemId);
  }

  /** Pause every video except the one playing now. */
  pauseAllExcept(itemId?: string): void {
    for (const [id, e] of this.entries) {
      if (id !== itemId && e.el instanceof HTMLVideoElement && !e.el.paused) e.el.pause();
    }
  }

  setMuted(muted: boolean): void {
    for (const e of this.entries.values()) if (e.el instanceof HTMLVideoElement) e.el.muted = muted;
  }

  private evict(keep: string): void {
    if (this.entries.size <= this.capacity) return;
    const victims = [...this.entries.entries()]
      .filter(([id]) => id !== keep)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, this.entries.size - this.capacity);
    for (const [id, e] of victims) {
      // Delete first: releasing the source fires an error event, which must not count as a media failure.
      this.entries.delete(id);
      if (e.el instanceof HTMLVideoElement) {
        e.el.pause();
        e.el.removeAttribute('src');
        e.el.load();
      } else {
        e.el.onload = null;
        e.el.onerror = null;
        e.el.removeAttribute('src');
      }
    }
  }
}
