/**
 * Loads and keeps the media elements the player needs: a small LRU of decoded
 * images and video elements, preloading the segments just ahead of the
 * playhead so playback does not stall on segment boundaries.
 */
export type MediaEl = HTMLImageElement | HTMLVideoElement | HTMLAudioElement;
export type MediaKindToLoad = 'image' | 'video' | 'audio';

export interface PoolEntry {
  el: MediaEl;
  ready: boolean;
  failed: boolean;
  lastUsed: number;
  /** Removes this entry's listeners when its element goes back to the spares. */
  off?: AbortController;
}

/** How many unlocked spare elements to keep ready for clips that load later. */
const SPARE_VIDEO = 8;
const SPARE_AUDIO = 4;

export class MediaPool {
  private entries = new Map<string, PoolEntry>();
  /**
   * Media elements with no source, kept for reuse. Safari lets an element play
   * sound only after it has been played during a click or key press; such an
   * element stays allowed when it gets a new source, so the player unlocks
   * these when Play is pressed and hands them to clips as they load.
   */
  private spares: { video: HTMLVideoElement[]; audio: HTMLAudioElement[] } = { video: [], audio: [] };
  private silentUrl: string | undefined;
  onError: (itemId: string, kind: string) => void = () => {};
  onReady: (itemId: string) => void = () => {};

  constructor(
    private readonly urlFor: (itemId: string, kind: MediaKindToLoad) => string,
    private readonly capacity = 16,
  ) {}

  get(itemId: string): PoolEntry | undefined {
    const e = this.entries.get(itemId);
    if (e) e.lastUsed = performance.now();
    return e;
  }

  ensure(itemId: string, kind: MediaKindToLoad): PoolEntry {
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
      const v = this.takeSpare(kind);
      const off = new AbortController();
      entry = { el: v, ready: false, failed: false, lastUsed: performance.now(), off };
      v.addEventListener('loadeddata', () => {
        entry.ready = true;
        this.onReady(itemId);
      }, { signal: off.signal });
      v.addEventListener('error', () => {
        if (this.entries.get(itemId) !== entry) return;
        entry.failed = true;
        this.onError(itemId, kind);
      }, { signal: off.signal });
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
    if (e.el instanceof HTMLMediaElement) {
      this.release(e);
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

  /** Pause every video and audio element except the ones playing now. */
  pauseAllExcept(keep?: string | Set<string>): void {
    const has = (id: string) => (typeof keep === 'string' ? id === keep : !!keep?.has(id));
    for (const [id, e] of this.entries) {
      if (!has(id) && e.el instanceof HTMLMediaElement && !e.el.paused) e.el.pause();
    }
  }

  /**
   * Call from inside a click or key handler (Play): plays and pauses every
   * paused element, and the spares, so the browser lets them play sound later.
   */
  unlock(): void {
    while (this.spares.video.length < SPARE_VIDEO) this.spares.video.push(this.blank('video') as HTMLVideoElement);
    while (this.spares.audio.length < SPARE_AUDIO) this.spares.audio.push(this.blank('audio') as HTMLAudioElement);
    const els: HTMLMediaElement[] = [...this.spares.video, ...this.spares.audio];
    for (const e of this.entries.values()) if (e.el instanceof HTMLMediaElement && e.el.paused) els.push(e.el);
    for (const el of els) {
      const spare = !el.currentSrc || el.currentSrc === this.silentUrl;
      if (spare) el.src = this.silent();
      const muted = el.muted;
      el.muted = false;
      const done = el.play();
      el.pause();
      el.muted = muted;
      done?.catch(() => {});
    }
  }

  setMuted(muted: boolean): void {
    for (const e of this.entries.values()) if (e.el instanceof HTMLMediaElement) e.el.muted = muted;
  }

  private blank(kind: 'video' | 'audio'): HTMLMediaElement {
    const v = document.createElement(kind);
    v.preload = 'auto';
    if (v instanceof HTMLVideoElement) v.playsInline = true;
    v.crossOrigin = 'anonymous';
    return v;
  }

  private takeSpare(kind: MediaKindToLoad): HTMLMediaElement {
    const list = kind === 'audio' ? this.spares.audio : this.spares.video;
    const el = list.pop() ?? this.blank(kind === 'audio' ? 'audio' : 'video');
    el.volume = 1;
    el.playbackRate = 1;
    return el;
  }

  /** Detach an element from its clip and keep it (it stays unlocked) for the next one. */
  private release(e: PoolEntry): void {
    const el = e.el as HTMLMediaElement;
    e.off?.abort();
    el.pause();
    el.removeAttribute('src');
    el.load();
    const list: HTMLMediaElement[] = el instanceof HTMLVideoElement ? this.spares.video : this.spares.audio;
    if (list.length < (el instanceof HTMLVideoElement ? SPARE_VIDEO : SPARE_AUDIO)) list.push(el);
  }

  /** A tenth of a second of silence (as a WAV blob), the source spares play while being unlocked. */
  private silent(): string {
    if (this.silentUrl) return this.silentUrl;
    const rate = 8000, n = 800;
    const b = new DataView(new ArrayBuffer(44 + n * 2));
    const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) b.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, rate, true);
    b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); str(36, 'data'); b.setUint32(40, n * 2, true);
    this.silentUrl = URL.createObjectURL(new Blob([b.buffer], { type: 'audio/wav' }));
    return this.silentUrl;
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
      if (e.el instanceof HTMLMediaElement) {
        this.release(e);
      } else {
        e.el.onload = null;
        e.el.onerror = null;
        e.el.removeAttribute('src');
      }
    }
  }
}
