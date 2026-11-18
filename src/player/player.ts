/**
 * Player shell (F-3): plays a Travelogue by drawing the shared render model's
 * layers on a canvas at the project's aspect ratio. The timeline clock is the
 * master; video elements follow it and are corrected when they drift.
 */
import { frameAt, mixAt, type Frame, type PictureLayer, type Size, type Voice } from '../core/render-model.js';
import { buildTimeline, type Timeline } from '../core/timeline.js';
import type { AudioLane, MapStyle, MediaItem, Travelogue } from '../core/schema.js';
import { drawFrame, type Drawable, type DrawSources } from './draw.js';
import { MediaPool, type MediaKindToLoad } from './media-pool.js';

export { drawTitleCard, wrapText } from './draw.js';

/** Map tiles for the map layer: where to load them, and the provider's attribution. */
export interface TileSource {
  url: (style: MapStyle, z: number, x: number, y: number) => string;
  attribution: string;
}

export type PlayerState = 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerStats {
  framesDrawn: number;
  /** Every segment index entered during playback, in order (repeats allowed after seeks). */
  segmentsEntered: number[];
  mediaErrors: string[];
  /** Frames drawn while the current media was not ready yet. */
  placeholderFrames: number;
  /** Placeholder frames per segment index, to find which media is slow. */
  placeholderBySegment: Record<number, number>;
  videoSeeks: number;
}

export interface PlayerOptions {
  canvas: HTMLCanvasElement;
  project: Travelogue;
  urlFor: (itemId: string, kind: MediaKindToLoad) => string;
  /** Playback-rate multiplier (tests use 4 to 8). */
  rate?: number;
  onState?: (s: PlayerState) => void;
  onTime?: (t: number, frame: Frame) => void;
  onEvent?: (name: string, props?: Record<string, unknown>) => void;
  /** Map tiles (absent: the map draws on a plain background). */
  tiles?: TileSource;
}

const PRELOAD_AHEAD = 3;
const PRELOAD_SECONDS = 10;

export class Player {
  timeline: Timeline;
  readonly stats: PlayerStats = { framesDrawn: 0, segmentsEntered: [], mediaErrors: [], placeholderFrames: 0, placeholderBySegment: {}, videoSeeks: 0 };
  private readonly ctx: CanvasRenderingContext2D;
  private readonly pool: MediaPool;
  private t = 0;
  private stateValue: PlayerState = 'loading';
  private raf = 0;
  private lastTick = 0;
  private lastSegment = -1;
  private rate: number;
  private muted = false;
  /** Elements the browser would not let play with sound (no click yet); they play muted until the next Play. */
  private blocked = new Set<HTMLMediaElement>();
  private needsDraw = true;
  private lanes: AudioLane[];
  /** The sounds of the last drawn frame, with their levels (AU-4; tests read it). */
  mix: Voice[] = [];
  /** The playhead time the mix above was computed for. */
  private mixT = 0;
  private project: Travelogue;
  /** The last frame drawn (tests and the stage editor read it). */
  frame: Frame | undefined;
  private tileImages = new Map<string, { img: HTMLImageElement; ok: boolean; failed: boolean }>();

  constructor(private readonly o: PlayerOptions) {
    this.timeline = buildTimeline(o.project);
    this.project = o.project;
    this.lanes = o.project.audioLanes;
    this.rate = o.rate ?? 1;
    const ctx = o.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.pool = new MediaPool(o.urlFor);
    this.sources.attribution = o.tiles?.attribution ?? '';
    this.pool.onError = (id, kind) => {
      this.stats.mediaErrors.push(id);
      o.onEvent?.('media_error', { itemId: id, kind });
      this.needsDraw = true;
    };
    this.pool.onReady = () => {
      this.needsDraw = true;
    };
    this.preload(0);
    this.setState('ready');
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  get state(): PlayerState {
    return this.stateValue;
  }
  get time(): number {
    return this.t;
  }
  get duration(): number {
    return this.timeline.duration;
  }

  play(): void {
    if (!this.timeline.segments.length) return;
    if (this.stateValue === 'ended' || this.t >= this.duration) this.seek(0);
    // Play is pressed in a click or key handler: the moment the browser lets media start with sound.
    this.pool.unlock();
    for (const el of this.blocked) el.muted = this.muted;
    this.blocked.clear();
    this.lastTick = performance.now();
    this.setState('playing');
    this.o.onEvent?.('play', { t: this.t });
  }

  pause(): void {
    if (this.stateValue !== 'playing') return;
    this.pool.pauseAllExcept(undefined);
    this.setState('paused');
    this.o.onEvent?.('pause', { t: this.t });
  }

  toggle(): void {
    if (this.stateValue === 'playing') this.pause();
    else this.play();
  }

  seek(t: number): void {
    this.t = Math.max(0, Math.min(this.duration, t));
    if (this.stateValue === 'ended') this.setState('paused');
    this.lastSegment = -1;
    this.needsDraw = true;
    this.preload(this.t);
    this.o.onEvent?.('seek', { t: this.t });
  }

  seekChapter(delta: number): void {
    const chs = this.timeline.chapters;
    const cur = chs.findIndex((c) => this.t >= c.start && this.t < c.end);
    const target = chs[Math.max(0, Math.min(chs.length - 1, (cur < 0 ? 0 : cur) + delta))];
    if (target) this.seek(target.start);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.pool.setMuted(m);
    for (const el of this.blocked) el.muted = true;
  }

  setRate(r: number): void {
    this.rate = r;
  }

  /**
   * Swap in an updated project (an edit, an upload finishing). Playback keeps
   * its position; media whose files changed are reloaded.
   */
  setProject(project: Travelogue): void {
    const before = new Map(this.timeline.segments.flatMap((s) => (s.kind === 'title' ? [] : [[s.item.id, s.item] as const])));
    this.timeline = buildTimeline(project);
    this.project = project;
    this.lanes = project.audioLanes;
    for (const c of this.timeline.audio) {
      const old = this.pool.get(c.item.id);
      if (old?.failed) this.pool.forget(c.item.id);
    }
    for (const s of this.timeline.segments) {
      if (s.kind === 'title') continue;
      const old = before.get(s.item.id);
      if (old && (old.storageKey !== s.item.storageKey || old.assets?.proxy !== s.item.assets?.proxy)) this.pool.forget(s.item.id);
    }
    for (const m of project.media) if (m.status === 'ready') this.pool.forgetIfFailed(m.id);
    this.t = Math.min(this.t, this.timeline.duration);
    if (this.stateValue === 'ended' && this.t < this.timeline.duration) this.setState('paused');
    this.lastSegment = -1;
    this.needsDraw = true;
    this.preload(this.t);
  }

  /** The loaded media element for an item, if any (tests check audio sync with it). */
  elementFor(itemId: string): HTMLImageElement | HTMLMediaElement | undefined {
    return this.pool.get(itemId)?.el;
  }

  /** Re-render the current frame now (after a canvas resize). */
  redraw(): void {
    this.needsDraw = true;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.pool.pauseAllExcept(undefined);
  }

  private setState(s: PlayerState) {
    if (this.stateValue === s) return;
    this.stateValue = s;
    this.o.onState?.(s);
  }

  private preload(t: number) {
    const segs = this.timeline.segments;
    let i = segs.findIndex((s) => s.start + s.duration > t);
    if (i < 0) i = segs.length - 1;
    if (i < 0) return; // empty timeline (a project with no chapters yet)
    // Look ahead at least PRELOAD_AHEAD segments, or 10 s of playback at the current rate, capped at 8 items.
    const horizon = t + PRELOAD_SECONDS * this.rate;
    for (let k = i, n = 0; k < segs.length && n < 8 && (k <= i + PRELOAD_AHEAD || segs[k].start < horizon); k++) {
      const s = segs[k];
      if (s.kind !== 'title') n++;
      if (s.kind !== 'title') {
        const e = this.pool.ensure(s.item.id, s.kind);
        if (e.el instanceof HTMLVideoElement) {
          e.el.muted = this.mutedFor(e.el);
          // Park upcoming clips on their in-point so the first frame is decoded before the segment starts.
          if (k !== i || this.t <= s.start) this.parkVideo(e.el, s.inPointSec);
        }
      }
    }
    // Narration and music starting soon, parked on their in-points.
    for (const c of this.timeline.audio) {
      if (c.start > horizon || c.start + c.duration <= t) continue;
      const e = this.pool.ensure(c.item.id, 'audio');
      if (e.el instanceof HTMLMediaElement) {
        e.el.muted = this.mutedFor(e.el);
        if (c.start > t) this.parkVideo(e.el, c.inPointSec);
      }
    }
  }

  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    if (this.stateValue === 'playing') {
      // Wall-clock time, so a dropped frame does not slow the playhead; long gaps (a hidden tab) are capped.
      const dt = Math.min(1, Math.max(0, now - this.lastTick) / 1000) * this.rate;
      this.lastTick = now;
      this.t = Math.min(this.duration, this.t + dt + this.clockCorrection(dt));
      this.needsDraw = true;
    }
    if (!this.needsDraw) return;
    this.needsDraw = false;
    const frame = this.render();
    this.o.onTime?.(this.t, frame);
    if (this.stateValue === 'playing' && this.t >= this.duration) {
      this.pool.pauseAllExcept(undefined);
      this.setState('ended');
      this.o.onEvent?.('ended', { framesDrawn: this.stats.framesDrawn, placeholderFrames: this.stats.placeholderFrames });
    }
  }

  /**
   * Follow the sound that is playing: the playhead is nudged toward the media
   * element's own clock (an audio clip first, else the video on screen), so
   * picture and sound stay together without re-seeking the media. Bounded to
   * half a frame's step so time never runs backwards.
   */
  private clockCorrection(dt: number): number {
    if (dt <= 0) return 0;
    const pick = this.mix.find((v) => v.kind === 'audio' && this.steady(v.itemId)) ?? this.mix.find((v) => v.kind === 'video' && this.steady(v.itemId));
    if (!pick) return 0;
    const el = this.pool.get(pick.itemId)!.el as HTMLMediaElement;
    const mediaT = this.mixT + (el.currentTime - pick.mediaTimeSec) / (pick.speed || 1);
    const ahead = mediaT - (this.t + dt);
    if (Math.abs(ahead) > 0.5) return 0; // far apart: let syncMedia re-seek the element instead
    return Math.max(-dt / 2, Math.min(dt / 2, ahead * 0.2));
  }

  private steady(itemId: string): boolean {
    const e = this.pool.get(itemId);
    return !!e && !e.failed && e.el instanceof HTMLMediaElement && !e.el.paused && !e.el.seeking && e.el.readyState >= 3;
  }

  private render(): Frame {
    const c = this.o.canvas;
    const size: Size = { w: c.width, h: c.height };
    const frame = frameAt(this.timeline, this.t, size, (item) => this.naturalSize(item), this.project);
    if (frame.segmentIndex !== this.lastSegment && frame.segmentIndex >= 0) {
      this.lastSegment = frame.segmentIndex;
      this.stats.segmentsEntered.push(frame.segmentIndex);
      this.preload(this.t);
    }
    const res = drawFrame(this.ctx, frame, size, this.sources);
    if (res.placeholders) {
      this.stats.placeholderFrames += 1;
      this.stats.placeholderBySegment[this.lastSegment] = (this.stats.placeholderBySegment[this.lastSegment] ?? 0) + 1;
      this.needsDraw = true;
    }
    this.frame = frame;
    this.stats.framesDrawn += 1;
    this.playMix(frame);
    return frame;
  }

  /** Pictures from the media pool (videos kept on the layer's media time), tiles from the tile cache. */
  private readonly sources: DrawSources = {
    picture: (layer: PictureLayer): Drawable | 'loading' | 'failed' => {
      const e = this.pool.ensure(layer.itemId, layer.kind);
      if (e.failed) return 'failed';
      if (layer.kind === 'video' && e.el instanceof HTMLVideoElement) this.syncMedia(e.el, layer.mediaTimeSec, layer.speed, 0.3);
      const drawable = e.ready && (!(e.el instanceof HTMLVideoElement) || e.el.readyState >= 2);
      if (!drawable || e.el instanceof HTMLAudioElement) return 'loading';
      return { image: e.el, scale: 1 };
    },
    tile: (style, z, x, y) => this.tile(style, z, x, y),
    attribution: '',
  };

  private tile(style: MapStyle, z: number, x: number, y: number): HTMLImageElement | undefined {
    const t = this.o.tiles;
    if (!t) return undefined;
    const key = `${style === 'terrain' ? 'terrain' : 'base'}/${z}/${x}/${y}`;
    let e = this.tileImages.get(key);
    if (!e) {
      const img = new Image();
      img.decoding = 'async';
      const entry = { img, ok: false, failed: false };
      img.onload = () => { entry.ok = true; this.needsDraw = true; };
      img.onerror = () => { entry.failed = true; };
      img.src = t.url(style, z, x, y);
      this.tileImages.set(key, entry);
      // Keep the cache bounded: drop the oldest tiles.
      if (this.tileImages.size > 600) this.tileImages.delete(this.tileImages.keys().next().value!);
      e = entry;
    }
    return e.ok ? e.img : undefined;
  }

  /** AU-4: set every sound's level from the shared mix, keep audio clips in step, and silence the rest. */
  private playMix(frame: Frame) {
    const voices = mixAt(this.timeline, this.lanes, this.t);
    this.mix = voices;
    this.mixT = this.t;
    const keep = new Set<string>();
    const seg = this.timeline.segments[frame.segmentIndex];
    if (seg && seg.kind === 'video') keep.add(seg.item.id);
    for (const v of voices) {
      keep.add(v.itemId);
      const e = v.kind === 'video' ? this.pool.get(v.itemId) : this.pool.ensure(v.itemId, 'audio');
      if (!e || e.failed || !(e.el instanceof HTMLMediaElement)) continue;
      // Element volume tops out at 1; levels above 100% play at full volume in the preview.
      const vol = Math.max(0, Math.min(1, v.gain));
      if (Math.abs(e.el.volume - vol) > 0.004) e.el.volume = vol;
      if (v.kind === 'audio') {
        e.el.muted = this.mutedFor(e.el);
        if (e.el.readyState >= 1) this.syncMedia(e.el, v.mediaTimeSec, 1, 0.25);
        else this.needsDraw = true;
      }
    }
    this.pool.pauseAllExcept(keep);
  }

  private naturalSize(item: MediaItem): Size | undefined {
    const e = this.pool.get(item.id);
    if (e?.ready) {
      const el = e.el;
      if (el instanceof HTMLAudioElement) return undefined;
      const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
      const h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
      if (w && h) return { w, h };
    }
    return item.width && item.height ? { w: item.width, h: item.height } : undefined;
  }

  private parkVideo(v: HTMLMediaElement, at: number) {
    if (!v.paused) return;
    const go = () => {
      if (v.paused && Math.abs(v.currentTime - at) > 0.05) v.currentTime = at;
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
  }

  private mutedFor(el: HTMLMediaElement): boolean {
    return this.muted || this.blocked.has(el);
  }

  private syncMedia(v: HTMLMediaElement, mediaTime: number, speed: number, playingTolerance: number) {
    const playing = this.stateValue === 'playing';
    const targetRate = Math.min(16, speed * this.rate);
    if (Math.abs(v.playbackRate - targetRate) > 0.01) v.playbackRate = targetRate;
    const drift = Math.abs(v.currentTime - mediaTime);
    const tolerance = playing ? playingTolerance * Math.max(1, this.rate) : 0.04;
    if (drift > tolerance && !v.seeking) {
      v.currentTime = mediaTime;
      this.stats.videoSeeks += 1;
      this.needsDraw = true;
    }
    if (playing && v.paused) {
      v.play().catch((err: DOMException) => {
        // An interrupted play() (a pause or seek) is routine. A browser autoplay block silences only this
        // element, so the music and the rest of the mix keep playing; the next Play lifts it.
        if (err?.name !== 'NotAllowedError' || this.stateValue !== 'playing') return;
        this.blocked.add(v);
        v.muted = true;
        this.o.onEvent?.('sound_blocked', {});
        void v.play().catch(() => {});
      });
    }
    if (!playing && !v.paused) v.pause();
  }
}
