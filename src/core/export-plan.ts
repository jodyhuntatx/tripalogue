/**
 * Export plan (VX-1, VX-2, VX-5, VX-6): turns a timeline and export settings into
 * the exact frames to render, using the same render model as the preview.
 *
 * Export frame k shows the travelogue at t = start + k / fps, exactly as the
 * player would at that moment: the export page draws frameAt() for it with the
 * player's own drawing code (server/render.ts).
 */
import type { Size } from './render-model.js';
import type { Timeline } from './timeline.js';
import type { AspectRatio, Id } from './schema.js';

export type ExportResolution = '720p' | '1080p' | '4k';

export type ExportRange =
  | { kind: 'all' }
  | { kind: 'chapter'; chapterId: Id }
  | { kind: 'span'; from: number; to: number };

export interface ExportSettings {
  resolution: ExportResolution;
  aspect: AspectRatio;
  fps: number;
  range: ExportRange;
}

export const DEFAULT_EXPORT: ExportSettings = { resolution: '1080p', aspect: '16:9', fps: 30, range: { kind: 'all' } };

export const EXPORT_RESOLUTIONS: ExportResolution[] = ['720p', '1080p', '4k'];
export const EXPORT_ASPECTS: AspectRatio[] = ['16:9', '9:16', '1:1'];

const SHORT_SIDE: Record<ExportResolution, number> = { '720p': 720, '1080p': 1080, '4k': 2160 };

/** Frame size in pixels: 1080p 16:9 is 1920×1080, 9:16 is 1080×1920, 1:1 is 1080×1080. */
export function exportSize(resolution: ExportResolution, aspect: AspectRatio): Size {
  const s = SHORT_SIDE[resolution];
  const long = Math.round((s * 16) / 9 / 2) * 2;
  if (aspect === '16:9') return { w: long, h: s };
  if (aspect === '9:16') return { w: s, h: long };
  return { w: s, h: s };
}

/** Check settings from a request; returns a message for the first problem, or undefined. */
export function settingsProblem(s: Partial<ExportSettings> | undefined): string | undefined {
  if (!s || typeof s !== 'object') return 'settings are required';
  if (!EXPORT_RESOLUTIONS.includes(s.resolution as ExportResolution)) return 'resolution must be 720p, 1080p or 4k';
  if (!EXPORT_ASPECTS.includes(s.aspect as AspectRatio)) return 'aspect must be 16:9, 9:16 or 1:1';
  if (![24, 25, 30, 60].includes(Number(s.fps))) return 'fps must be 24, 25, 30 or 60';
  const r = s.range as ExportRange | undefined;
  if (!r || !['all', 'chapter', 'span'].includes(r.kind)) return 'range must be all, a chapter or a span';
  if (r.kind === 'chapter' && typeof r.chapterId !== 'string') return 'range.chapterId is required';
  if (r.kind === 'span' && !(Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from && r.from >= 0)) return 'range needs from < to, in seconds';
  return undefined;
}

/** The part of the timeline to export, in timeline seconds. */
export function resolveRange(tl: Timeline, range: ExportRange): { start: number; end: number } {
  if (range.kind === 'chapter') {
    const ch = tl.chapters.find((c) => c.chapterId === range.chapterId);
    if (!ch) throw new Error('That chapter is not in the travelogue');
    return { start: ch.start, end: ch.end };
  }
  if (range.kind === 'span') return { start: Math.max(0, range.from), end: Math.min(tl.duration, range.to) };
  return { start: 0, end: tl.duration };
}

export interface VideoPlan {
  size: Size;
  fps: number;
  /** Timeline seconds of the first frame, and just past the last. */
  start: number;
  end: number;
  totalFrames: number;
}

const EPS = 1e-6;
const frameIndex = (t: number, fps: number) => Math.max(0, Math.ceil(t * fps - EPS));

/** The frames to render: export frame k shows the travelogue at start + k / fps, exactly as the preview would. */
export function planVideo(tl: Timeline, settings: ExportSettings): VideoPlan {
  const size = exportSize(settings.resolution, settings.aspect);
  const { start, end } = resolveRange(tl, settings.range);
  return { size, fps: settings.fps, start, end, totalFrames: frameIndex(end - start, settings.fps) };
}

/** Timeline time of export frame k. */
export const frameTime = (plan: VideoPlan, k: number) => plan.start + k / plan.fps;

/** A sound file the mix needs: a video's own sound or a narration or music clip, and the media span used. */
export interface AudioSource {
  itemId: Id;
  kind: 'video' | 'audio';
  /** Timeline span the source plays in (clipped to the range). */
  start: number;
  end: number;
  /** Media time at `start`, and media seconds per timeline second. */
  mediaStart: number;
  /** Audio clips: the media time just past the part to decode. */
  mediaEnd?: number;
  speed: number;
}

/** Sound sources playing in the range, each with the media span to decode. */
export function audioSources(tl: Timeline, start: number, end: number): AudioSource[] {
  const out: AudioSource[] = [];
  for (const seg of tl.segments) {
    if (seg.kind !== 'video') continue;
    const a = Math.max(seg.start, start);
    const b = Math.min(seg.start + seg.duration, end);
    if (b - a <= EPS) continue;
    out.push({ itemId: seg.item.id, kind: 'video', start: a, end: b, mediaStart: seg.inPointSec + (a - seg.start) * seg.speed, speed: seg.speed });
  }
  for (const c of tl.audio) {
    const a = Math.max(c.start, start);
    const b = Math.min(c.start + c.duration, end);
    if (b - a <= EPS) continue;
    // Audio clips are decoded by media time (a looping clip only needs its trimmed part once).
    const mediaStart = c.loopSec ? c.inPointSec : c.inPointSec + (a - c.start);
    const mediaEnd = c.loopSec ? c.inPointSec + c.loopSec : c.inPointSec + (b - c.start);
    out.push({ itemId: c.item.id, kind: 'audio', start: a, end: b, mediaStart, mediaEnd, speed: 1 });
  }
  return out;
}

/**
 * A readable file name for an export: "Portugal in Ten Days - Sintra - 1080p.mp4". Plain hyphens between the
 * parts, so the name reads the same in any file system.
 */
export function exportFileName(title: string, tl: Timeline, settings: ExportSettings): string {
  const parts = [title.trim() || 'Travelogue'];
  if (settings.range.kind === 'chapter') {
    const id = settings.range.chapterId;
    const ch = tl.chapters.find((c) => c.chapterId === id);
    if (ch) parts.push(ch.title || `Chapter ${ch.index + 1}`);
  } else if (settings.range.kind === 'span') {
    const m = (s: number) => `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}`;
    parts.push(`${m(settings.range.from)}-${m(settings.range.to)}`);
  }
  parts.push(settings.aspect === '16:9' ? settings.resolution : `${settings.resolution} ${settings.aspect.replace(':', 'x')}`);
  return `${parts.join(' - ').replace(/[\\/:*?"<>|]+/g, '-')}.mp4`;
}

/** What the export page needs to draw its frames (served to it by the render worker, server/render.ts). */
export interface RenderSetup {
  doc: import('./schema.js').Travelogue;
  fps: number;
  /** Timeline seconds of export frame 0. */
  start: number;
  size: Size;
  /** Upright size of each picture's original (placement uses it, as the preview uses its proxy's). */
  sizes: Record<string, Size>;
  /** Whether map tiles are drawn, and the provider's attribution. */
  tiles: boolean;
  attribution: string;
}
