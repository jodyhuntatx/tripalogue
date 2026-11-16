/**
 * The shared render model (PRD Section 4): a pure function from
 * (timeline, time, frame size) to the layers to draw. The browser player draws
 * these layers on a canvas; the Phase 4 exporter will draw the same layers into
 * video frames, which is what makes preview/export parity testable.
 */
import { segmentIndexAt, type MediaSegment, type Segment, type Timeline } from './timeline.js';
import type { AudioLane, NormRect, Placement, Transition } from './schema.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export type Layer =
  | { kind: 'title'; opacity: number; title: string; subtitle: string; description: string; chapterIndex: number }
  | { kind: 'image' | 'video'; opacity: number; itemId: string; src: Rect; dst: Rect; mediaTimeSec: number; speed: number };

export interface Frame {
  t: number;
  segmentIndex: number;
  chapterIndex: number;
  layers: Layer[];
}

/** Source and destination rectangles for a placement (pixels). */
export function place(placement: Placement, media: Size, frame: Size): { src: Rect; dst: Rect } {
  const full: Rect = { x: 0, y: 0, w: media.w, h: media.h };
  if (placement.mode === 'fit') {
    const s = Math.min(frame.w / media.w, frame.h / media.h);
    const w = media.w * s;
    const h = media.h * s;
    return { src: full, dst: { x: (frame.w - w) / 2, y: (frame.h - h) / 2, w, h } };
  }
  const box: Rect =
    placement.mode === 'custom' && placement.rect
      ? denorm(placement.rect, frame)
      : { x: 0, y: 0, w: frame.w, h: frame.h };
  return { src: coverCrop(media, box), dst: box };
}

function denorm(r: NormRect, f: Size): Rect {
  return { x: r.x * f.w, y: r.y * f.h, w: r.w * f.w, h: r.h * f.h };
}

/** The centred part of the media that covers a box of the given shape. */
function coverCrop(media: Size, box: Rect): Rect {
  const s = Math.max(box.w / media.w, box.h / media.h);
  const w = box.w / s;
  const h = box.h / s;
  return { x: (media.w - w) / 2, y: (media.h - h) / 2, w, h };
}

/** Opacity from entrance and exit fades; fades are shortened proportionally if they overlap. */
export function fadeOpacity(local: number, duration: number, entrance: Transition, exit: Transition): number {
  let fin = entrance.type === 'fade' ? entrance.durationSec : 0;
  let fout = exit.type === 'fade' ? exit.durationSec : 0;
  if (fin + fout > duration && fin + fout > 0) {
    const k = duration / (fin + fout);
    fin *= k;
    fout *= k;
  }
  let o = 1;
  if (fin > 0 && local < fin) o = Math.min(o, local / fin);
  if (fout > 0 && local > duration - fout) o = Math.min(o, (duration - local) / fout);
  return Math.max(0, Math.min(1, o));
}

export function frameAt(tl: Timeline, t: number, frame: Size, sizeOf: (seg: MediaSegment) => Size | undefined = defaultSize): Frame {
  const i = segmentIndexAt(tl, t);
  if (i < 0) return { t, segmentIndex: -1, chapterIndex: -1, layers: [] };
  const seg: Segment = tl.segments[i];
  const local = Math.min(Math.max(t - seg.start, 0), seg.duration);
  if (seg.kind === 'title') {
    return {
      t, segmentIndex: i, chapterIndex: seg.chapterIndex,
      layers: [{ kind: 'title', opacity: fadeOpacity(local, seg.duration, seg.entrance, seg.exit), title: seg.title, subtitle: seg.subtitle, description: seg.description, chapterIndex: seg.chapterIndex }],
    };
  }
  const size = sizeOf(seg) ?? frame;
  const { src, dst } = place(seg.cue.placement, size, frame);
  return {
    t, segmentIndex: i, chapterIndex: seg.chapterIndex,
    layers: [{
      kind: seg.kind, opacity: fadeOpacity(local, seg.duration, seg.cue.entrance, seg.cue.exit),
      itemId: seg.item.id, src, dst,
      mediaTimeSec: seg.kind === 'video' ? seg.inPointSec + local * seg.speed : 0,
      speed: seg.speed,
    }],
  };
}

function defaultSize(seg: MediaSegment): Size | undefined {
  return seg.item.width && seg.item.height ? { w: seg.item.width, h: seg.item.height } : undefined;
}

// ---------------------------------------------------------------- audio mix (AU-4)

/** One sound playing at a moment: a video's own sound or an audio clip, with its level. */
export interface Voice {
  itemId: string;
  kind: 'video' | 'audio';
  laneId: string;
  /** Where in the media file playback should be. */
  mediaTimeSec: number;
  /** Linear gain, 0..2 (clip volume × lane volume × fades × ducking). */
  gain: number;
  speed: number;
}

/** Ducking ramps in and out over this long at the edges of the clip that causes it. */
export const DUCK_RAMP_SEC = 0.3;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function edgeFade(local: number, duration: number, fin: number, fout: number): number {
  let g = 1;
  if (fin > 0) g = Math.min(g, local / fin);
  if (fout > 0) g = Math.min(g, (duration - local) / fout);
  return clamp01(g);
}

/**
 * The mix at time t: the shared audio model the preview plays and the export will render. Narration, music and
 * clip sound each take their lane's volume (muted or not soloed = silent); a clip on a lane that ducks others
 * lowers them by the lane's dB while it plays, ramping over DUCK_RAMP_SEC.
 */
export function mixAt(tl: Timeline, lanes: AudioLane[], t: number): Voice[] {
  const byId = new Map(lanes.map((l) => [l.id, l]));
  const anySolo = lanes.some((l) => l.solo);
  const laneGain = (id: string) => {
    const l = byId.get(id);
    if (!l) return 1;
    return l.mute || (anySolo && !l.solo) ? 0 : l.volume;
  };
  const active = tl.audio.filter((c) => t >= c.start && t < c.start + c.duration);
  const duckDb = new Map<string, number>();
  for (const c of active) {
    const lane = byId.get(c.laneId);
    if (!lane || !c.duck || !lane.ducks.length || laneGain(c.laneId) === 0) continue;
    const amount = clamp01(Math.min((t - c.start) / DUCK_RAMP_SEC, (c.start + c.duration - t) / DUCK_RAMP_SEC));
    for (const d of lane.ducks) duckDb.set(d.laneId, Math.min(duckDb.get(d.laneId) ?? 0, d.db * amount));
  }
  const duck = (laneId: string) => 10 ** ((duckDb.get(laneId) ?? 0) / 20);
  const voices: Voice[] = [];
  const i = segmentIndexAt(tl, t);
  const seg = i >= 0 ? tl.segments[i] : undefined;
  if (seg && seg.kind === 'video') {
    const clipLane = lanes.find((l) => l.kind === 'clipSound')?.id ?? 'lane-clip';
    const local = Math.min(Math.max(t - seg.start, 0), seg.duration);
    voices.push({
      itemId: seg.item.id, kind: 'video', laneId: clipLane, speed: seg.speed,
      mediaTimeSec: seg.inPointSec + local * seg.speed,
      gain: seg.cue.volume * laneGain(clipLane) * fadeOpacity(local, seg.duration, seg.cue.entrance, seg.cue.exit) * duck(clipLane),
    });
  }
  for (const c of active) {
    const local = t - c.start;
    voices.push({
      itemId: c.item.id, kind: 'audio', laneId: c.laneId, speed: 1,
      mediaTimeSec: c.inPointSec + local,
      gain: c.cue.volume * laneGain(c.laneId) * edgeFade(local, c.duration, c.fadeInSec, c.fadeOutSec) * duck(c.laneId),
    });
  }
  return voices;
}
