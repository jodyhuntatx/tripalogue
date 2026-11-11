/**
 * The shared render model (PRD Section 4): a pure function from
 * (timeline, time, frame size) to the layers to draw. The browser player draws
 * these layers on a canvas; the Phase 4 exporter will draw the same layers into
 * video frames, which is what makes preview/export parity testable.
 */
import { segmentIndexAt, type MediaSegment, type Segment, type Timeline } from './timeline.js';
import type { NormRect, Placement, Transition } from './schema.js';

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
  | { kind: 'title'; opacity: number; title: string; subtitle: string; chapterIndex: number }
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
      layers: [{ kind: 'title', opacity: fadeOpacity(local, seg.duration, seg.entrance, seg.exit), title: seg.title, subtitle: seg.subtitle, chapterIndex: seg.chapterIndex }],
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
