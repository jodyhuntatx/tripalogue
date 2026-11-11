/**
 * Player shell (F-3): plays a Travelogue by drawing the shared render model's
 * layers on a canvas at the project's aspect ratio. The timeline clock is the
 * master; video elements follow it and are corrected when they drift.
 */
import { frameAt, type Frame, type Layer, type Size } from '../core/render-model.js';
import { buildTimeline, type MediaSegment, type Timeline } from '../core/timeline.js';
import type { Travelogue } from '../core/schema.js';
import { MediaPool } from './media-pool.js';

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
  urlFor: (itemId: string, kind: 'image' | 'video') => string;
  /** Playback-rate multiplier (tests use 4 to 8). */
  rate?: number;
  onState?: (s: PlayerState) => void;
  onTime?: (t: number, frame: Frame) => void;
  onEvent?: (name: string, props?: Record<string, unknown>) => void;
}

const PRELOAD_AHEAD = 3;
const PRELOAD_SECONDS = 10;

export class Player {
  readonly timeline: Timeline;
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
  private needsDraw = true;

  constructor(private readonly o: PlayerOptions) {
    this.timeline = buildTimeline(o.project);
    this.rate = o.rate ?? 1;
    const ctx = o.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.pool = new MediaPool(o.urlFor);
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
  }

  setRate(r: number): void {
    this.rate = r;
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
    // Look ahead at least PRELOAD_AHEAD segments, or 10 s of playback at the current rate, capped at 8 items.
    const horizon = t + PRELOAD_SECONDS * this.rate;
    for (let k = i, n = 0; k < segs.length && n < 8 && (k <= i + PRELOAD_AHEAD || segs[k].start < horizon); k++) {
      const s = segs[k];
      if (s.kind !== 'title') n++;
      if (s.kind !== 'title') {
        const e = this.pool.ensure(s.item.id, s.kind);
        if (e.el instanceof HTMLVideoElement) {
          e.el.muted = this.muted;
          // Park upcoming clips on their in-point so the first frame is decoded before the segment starts.
          if (k !== i || this.t <= s.start) this.parkVideo(e.el, s.inPointSec);
        }
      }
    }
  }

  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    if (this.stateValue === 'playing') {
      const dt = Math.min(0.25, (now - this.lastTick) / 1000) * this.rate;
      this.lastTick = now;
      this.t = Math.min(this.duration, this.t + dt);
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

  private render(): Frame {
    const c = this.o.canvas;
    const size: Size = { w: c.width, h: c.height };
    const segs = this.timeline.segments;
    const frame = frameAt(this.timeline, this.t, size, (seg: MediaSegment) => this.naturalSize(seg));
    if (frame.segmentIndex !== this.lastSegment && frame.segmentIndex >= 0) {
      this.lastSegment = frame.segmentIndex;
      this.stats.segmentsEntered.push(frame.segmentIndex);
      this.preload(this.t);
      const seg = segs[frame.segmentIndex];
      this.pool.pauseAllExcept(seg.kind === 'video' ? seg.item.id : undefined);
    }
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size.w, size.h);
    for (const layer of frame.layers) this.drawLayer(layer, size);
    ctx.globalAlpha = 1;
    this.stats.framesDrawn += 1;
    return frame;
  }

  private naturalSize(seg: MediaSegment): Size | undefined {
    const e = this.pool.get(seg.item.id);
    if (e?.ready) {
      const el = e.el;
      const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
      const h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
      if (w && h) return { w, h };
    }
    return seg.item.width && seg.item.height ? { w: seg.item.width, h: seg.item.height } : undefined;
  }

  private drawLayer(layer: Layer, size: Size) {
    const ctx = this.ctx;
    ctx.globalAlpha = layer.opacity;
    if (layer.kind === 'title') {
      this.drawTitle(layer.title, layer.subtitle, layer.chapterIndex, size);
      return;
    }
    const e = this.pool.ensure(layer.itemId, layer.kind);
    if (e.failed) {
      this.drawPlaceholder(layer.dst, 'Media not found');
      return;
    }
    if (layer.kind === 'video' && e.el instanceof HTMLVideoElement) this.syncVideo(e.el, layer.mediaTimeSec, layer.speed);
    const drawable = e.ready && (!(e.el instanceof HTMLVideoElement) || e.el.readyState >= 2);
    if (!drawable) {
      this.stats.placeholderFrames += 1;
      this.stats.placeholderBySegment[this.lastSegment] = (this.stats.placeholderBySegment[this.lastSegment] ?? 0) + 1;
      this.drawPlaceholder(layer.dst, 'Loading…');
      this.needsDraw = true;
      return;
    }
    const { src, dst } = layer;
    ctx.drawImage(e.el, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
  }

  private parkVideo(v: HTMLVideoElement, at: number) {
    if (!v.paused) return;
    const go = () => {
      if (v.paused && Math.abs(v.currentTime - at) > 0.05) v.currentTime = at;
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
  }

  private syncVideo(v: HTMLVideoElement, mediaTime: number, speed: number) {
    const playing = this.stateValue === 'playing';
    const targetRate = Math.min(16, speed * this.rate);
    if (Math.abs(v.playbackRate - targetRate) > 0.01) v.playbackRate = targetRate;
    const drift = Math.abs(v.currentTime - mediaTime);
    const tolerance = playing ? 0.3 * Math.max(1, this.rate) : 0.04;
    if (drift > tolerance && !v.seeking) {
      v.currentTime = mediaTime;
      this.stats.videoSeeks += 1;
      this.needsDraw = true;
    }
    if (playing && v.paused) v.play().catch(() => { v.muted = true; this.muted = true; void v.play().catch(() => {}); });
    if (!playing && !v.paused) v.pause();
  }

  private drawPlaceholder(r: { x: number; y: number; w: number; h: number }, label: string) {
    const ctx = this.ctx;
    ctx.fillStyle = '#16181d';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#8a8f98';
    ctx.font = `${Math.round(Math.max(12, r.h * 0.04))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
  }

  private drawTitle(title: string, subtitle: string, chapterIndex: number, size: Size) {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, size.w, size.h);
    g.addColorStop(0, '#10233a');
    g.addColorStop(1, '#1d1430');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size.w, size.h);
    const u = Math.min(size.w, size.h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `600 ${Math.round(u * 0.035)}px system-ui, sans-serif`;
    ctx.fillText(`CHAPTER ${chapterIndex + 1}`, size.w / 2, size.h * 0.42);
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(u * 0.085)}px system-ui, sans-serif`;
    ctx.fillText(title, size.w / 2, size.h * 0.54, size.w * 0.9);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `400 ${Math.round(u * 0.04)}px system-ui, sans-serif`;
    ctx.fillText(subtitle, size.w / 2, size.h * 0.63, size.w * 0.9);
  }
}
