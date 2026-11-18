/**
 * The shared render model (PRD Section 4): a pure function from
 * (timeline, time, frame size) to the layers to draw. The browser player draws
 * these layers on a canvas; the exporter (export-plan.ts, server/render.ts)
 * renders the same layers into video frames, which is what makes preview/export
 * parity testable.
 */
import { segmentIndexAt, type MediaSegment, type Segment, type TitleSegment, type Timeline } from './timeline.js';
import type { AnnotationStyle, AudioLane, Direction, MediaItem, NormRect, Placement, TitleLayout, Transition, Travelogue } from './schema.js';
import { mapAt, type MapLayout, type MapState } from './map-model.js';
import { travelerName } from './contributors.js';

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

/** A photo or a video frame: the part of it to draw (src, in its upright pixels) and where (dst, frame pixels). */
export interface PictureLayer {
  kind: 'image' | 'video';
  opacity: number;
  itemId: string;
  src: Rect;
  dst: Rect;
  mediaTimeSec: number;
  speed: number;
}

/** A chapter title card (PE-15: its text, layout and a dimmed picture behind it). */
export interface TitleLayer {
  kind: 'title';
  opacity: number;
  title: string;
  subtitle: string;
  description: string;
  chapterIndex: number;
  layout: TitleLayout;
  background?: PictureLayer;
}

/** On-screen text: a caption, place or date (PE-14), or a photo credit (PE-18). */
export interface TextLayer {
  kind: 'text';
  opacity: number;
  text: string;
  style: AnnotationStyle | 'credit';
  /** The box the text sits in (frame pixels). */
  box: Rect;
  /** The annotation it shows, if any (for editing on the stage). */
  annotationId?: string;
}

/** The map, inset or filling the frame (MV-3 to MV-8). */
export interface MapLayer {
  kind: 'map';
  opacity: number;
  layout: MapLayout;
  state: MapState;
}

export type Layer = PictureLayer | TitleLayer | TextLayer | MapLayer;

export interface Frame {
  t: number;
  segmentIndex: number;
  chapterIndex: number;
  layers: Layer[];
}

/** How an item's upright size is known: from its loaded picture (preview) or its file (export). */
export type SizeOf = (item: MediaItem) => Size | undefined;

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

/**
 * Entrance and exit lengths for a segment (any effect but a cut takes time); shortened proportionally if together
 * they are longer than the segment.
 */
export function fadeTimes(duration: number, entrance: Transition, exit: Transition): { fin: number; fout: number } {
  let fin = entrance.type === 'cut' ? 0 : entrance.durationSec;
  let fout = exit.type === 'cut' ? 0 : exit.durationSec;
  if (fin + fout > duration && fin + fout > 0) {
    const k = duration / (fin + fout);
    fin *= k;
    fout *= k;
  }
  return { fin, fout };
}

/** Opacity from the entrance and exit (fades, zooms and crossfades ramp it; slides and cuts do not). */
export function fadeOpacity(local: number, duration: number, entrance: Transition, exit: Transition): number {
  const { fin, fout } = fadeTimes(duration, entrance, exit);
  let o = 1;
  if (fin > 0 && local < fin && entrance.type !== 'slide') o = Math.min(o, local / fin);
  if (fout > 0 && local > duration - fout && exit.type !== 'slide') o = Math.min(o, (duration - local) / fout);
  return Math.max(0, Math.min(1, o));
}

const easeOut = (f: number) => 1 - (1 - Math.max(0, Math.min(1, f))) ** 3;
const easeIn = (f: number) => Math.max(0, Math.min(1, f)) ** 3;
const DIR: Record<Direction, { x: number; y: number }> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };
/** PE-10: a zoom entrance grows from this share of its size. */
export const ZOOM_FROM = 0.6;

/** Where a picture is at `local` seconds, after its entrance and exit moves (PE-10, PE-12). */
export function moveBox(dst: Rect, local: number, duration: number, entrance: Transition, exit: Transition, frame: Size): Rect {
  const { fin, fout } = fadeTimes(duration, entrance, exit);
  let { x, y, w, h } = dst;
  if (fin > 0 && local < fin) {
    const f = local / fin;
    if (entrance.type === 'slide') {
      const d = DIR[entrance.direction ?? 'right'];
      x += d.x * frame.w * (1 - easeOut(f));
      y += d.y * frame.h * (1 - easeOut(f));
    } else if (entrance.type === 'zoom') {
      const k = ZOOM_FROM + (1 - ZOOM_FROM) * easeOut(f);
      x += (w * (1 - k)) / 2;
      y += (h * (1 - k)) / 2;
      w *= k;
      h *= k;
    }
  }
  if (fout > 0 && local > duration - fout && exit.type === 'slide') {
    const f = 1 - (duration - local) / fout;
    const d = DIR[exit.direction ?? 'left'];
    x += d.x * frame.w * easeIn(f);
    y += d.y * frame.h * easeIn(f);
  }
  return { x, y, w, h };
}

/**
 * PE-11 Ken Burns: the part of the picture in view at `f` (0..1 through the item), moving in a straight line from
 * `from` to `to`, then trimmed to the box's shape about its centre so the picture is never stretched.
 */
export function kenBurnsCrop(from: NormRect, to: NormRect, f: number, media: Size, box: Size): Rect {
  const k = Math.max(0, Math.min(1, f));
  const lerp = (a: number, b: number) => a + (b - a) * k;
  let w = lerp(from.w, to.w) * media.w;
  let h = lerp(from.h, to.h) * media.h;
  const cx = (lerp(from.x, to.x) * media.w) + w / 2;
  const cy = (lerp(from.y, to.y) * media.h) + h / 2;
  const want = box.w / box.h;
  if (w / h > want) w = h * want;
  else h = w / want;
  w = Math.min(w, media.w);
  h = Math.min(h, media.h);
  const x = Math.max(0, Math.min(media.w - w, cx - w / 2));
  const y = Math.max(0, Math.min(media.h - h, cy - h / 2));
  return { x, y, w, h };
}

/** PE-11 "auto": a gentle pan and zoom chosen from the item's id, so it is the same every time. */
export function autoKenBurns(itemId: string): { from: NormRect; to: NormRect } {
  let hsh = 2166136261;
  for (let i = 0; i < itemId.length; i++) hsh = Math.imul(hsh ^ itemId.charCodeAt(i), 16777619) >>> 0;
  const pick = hsh % 4;
  const full: NormRect = { x: 0, y: 0, w: 1, h: 1 };
  const z = 0.82; // end on 82% of the picture: about a 1.2x zoom
  const corner = (cx: number, cy: number): NormRect => ({ x: (1 - z) * cx, y: (1 - z) * cy, w: z, h: z });
  const pts: [number, number][] = [[0.5, 0.5], [0.2, 0.35], [0.8, 0.4], [0.5, 0.25]];
  const [cx, cy] = pts[pick];
  // Even ids zoom in, odd ones zoom out, so a run of photos does not all move the same way.
  return (hsh >> 3) % 2 === 0 ? { from: full, to: corner(cx, cy) } : { from: corner(cx, cy), to: full };
}

/** PE-14 presets: size (share of frame height) and look, applied by the drawing code. */
export const ANNOTATION_STYLES: Record<AnnotationStyle | 'credit', { size: number; label: string }> = {
  subtitle: { size: 0.045, label: 'Subtitle' },
  lowerThird: { size: 0.05, label: 'Lower third' },
  headline: { size: 0.085, label: 'Headline' },
  stamp: { size: 0.035, label: 'Stamp' },
  tag: { size: 0.035, label: 'Tag' },
  credit: { size: 0.026, label: 'Credit' },
};

/** Default box for a new annotation of a style (fractions of the frame). */
export function defaultAnnotationBox(style: AnnotationStyle): NormRect {
  if (style === 'subtitle') return { x: 0.1, y: 0.82, w: 0.8, h: 0.1 };
  if (style === 'lowerThird') return { x: 0.05, y: 0.74, w: 0.55, h: 0.12 };
  if (style === 'headline') return { x: 0.08, y: 0.08, w: 0.84, h: 0.16 };
  if (style === 'stamp') return { x: 0.7, y: 0.06, w: 0.26, h: 0.07 };
  return { x: 0.04, y: 0.06, w: 0.3, h: 0.07 };
}

/** How long an annotation takes to fade in and out. */
export const TEXT_FADE_SEC = 0.3;

/** The text an annotation shows: typed text, or for place and date what the item and its chapter say. */
export function annotationText(p: Travelogue, kind: string | undefined, text: string, item: MediaItem | undefined, chapterIndex: number): string {
  if (text.trim() || !kind || kind === 'caption') return text;
  const ch = p.chapters[chapterIndex];
  if (kind === 'place') return ch?.locationName || ch?.title || '';
  const when = item?.userTimestamp ?? item?.capturedAt;
  if (!when) return '';
  // Timestamps without an offset are local to the chapter; with one, shown in the chapter's zone.
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(when);
  const d = new Date(hasZone ? when : `${when.slice(0, 19)}Z`);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: hasZone && ch?.timeZone ? ch.timeZone : 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * The layers to draw at time t (frame size `frame`). With the project `p`, annotations, photo credits and the map
 * are added; without it, pictures and title cards only.
 */
export function frameAt(tl: Timeline, t: number, frame: Size, sizeOf: SizeOf = defaultSize, p?: Travelogue): Frame {
  const i = segmentIndexAt(tl, t);
  if (i < 0) return { t, segmentIndex: -1, chapterIndex: -1, layers: [] };
  const seg: Segment = tl.segments[i];
  const layers: Layer[] = [];
  // PE-16: during a crossfade the item before still shows underneath.
  if (seg.kind !== 'title' && seg.overlapSec > 0 && t - seg.start < seg.overlapSec && i > 0) {
    layers.push(...segmentLayers(tl, i - 1, t, frame, sizeOf, p, true));
  }
  layers.push(...segmentLayers(tl, i, t, frame, sizeOf, p, false));
  if (p) {
    const m = mapAt(p, tl, t, frame);
    if (m) layers.push({ kind: 'map', opacity: m.layout.opacity, layout: m.layout, state: m.state });
  }
  return { t, segmentIndex: i, chapterIndex: seg.chapterIndex, layers };
}

function segmentLayers(tl: Timeline, i: number, t: number, frame: Size, sizeOf: SizeOf, p: Travelogue | undefined, under: boolean): Layer[] {
  const seg = tl.segments[i];
  const local = Math.min(Math.max(t - seg.start, 0), seg.duration);
  if (seg.kind === 'title') return titleLayers(seg, local, frame, sizeOf, p);
  const cue = seg.cue;
  // Under a crossfade, the item keeps its picture until the one over it has faded in (no exit of its own).
  const exit: Transition = under ? { type: 'cut', durationSec: 0 } : cue.exit;
  const opacity = fadeOpacity(local, seg.duration, cue.entrance, exit);
  const pic = picture(seg, local, frame, sizeOf, opacity, exit);
  const out: Layer[] = [pic];
  if (!p || under) return out;
  // Annotations (PE-14), faded in and out, and with the picture.
  for (const a of p.annotations) {
    if (a.target.type !== 'item' || a.target.itemId !== seg.item.id) continue;
    const end = a.durationSec > 0 ? Math.min(seg.duration, a.startSec + a.durationSec) : seg.duration;
    if (local < a.startSec || local >= end) continue;
    const text = annotationText(p, a.kind, a.text, seg.item, seg.chapterIndex);
    if (!text.trim()) continue;
    const o = Math.min(1, (local - a.startSec) / TEXT_FADE_SEC, (end - local) / TEXT_FADE_SEC) * opacity;
    out.push({ kind: 'text', opacity: Math.max(0, o), text, style: (a.style in ANNOTATION_STYLES ? a.style : 'subtitle') as AnnotationStyle, box: denorm(a.position, frame), annotationId: a.id });
  }
  // Photo credits (PE-18): the traveler who sent it.
  const ch = p.chapters[seg.chapterIndex];
  const creditsOn = ch?.credits ? ch.credits === 'on' : !!p.credits;
  const contributor = creditsOn ? p.sources.find((s) => s.id === seg.item.sourceId)?.contributorId : undefined;
  if (contributor) {
    const text = `${seg.kind === 'video' ? 'Video' : 'Photo'}: ${travelerName(p, contributor)}`;
    out.push({ kind: 'text', opacity, text, style: 'credit', box: { x: frame.w * 0.03, y: frame.h * 0.9, w: frame.w * 0.4, h: frame.h * 0.06 } });
  }
  return out;
}

function picture(seg: MediaSegment, local: number, frame: Size, sizeOf: SizeOf, opacity: number, exit: Transition): PictureLayer {
  const cue = seg.cue;
  const size = sizeOf(seg.item) ?? frame;
  let { src, dst } = place(cue.placement, size, frame);
  if (cue.animation.type === 'kenBurns') src = kenBurnsCrop(cue.animation.from, cue.animation.to, local / seg.duration, size, dst);
  dst = moveBox(dst, local, seg.duration, cue.entrance, exit, frame);
  return {
    kind: seg.kind, opacity, itemId: seg.item.id, src, dst,
    mediaTimeSec: seg.kind === 'video' ? seg.inPointSec + local * seg.speed : 0,
    speed: seg.speed,
  };
}

function titleLayers(seg: TitleSegment, local: number, frame: Size, sizeOf: SizeOf, p: Travelogue | undefined): Layer[] {
  if (!seg.card || local < seg.mapSec) return []; // the full-frame map shows first (MV-6)
  const l = local - seg.mapSec;
  const d = seg.duration - seg.mapSec;
  const opacity = fadeOpacity(l, d, seg.entrance, seg.exit);
  let background: PictureLayer | undefined;
  if (seg.background) {
    const size = sizeOf(seg.background) ?? frame;
    const { src, dst } = place({ mode: 'fill' }, size, frame);
    background = { kind: seg.background.kind === 'video' ? 'video' : 'image', opacity, itemId: seg.background.id, src, dst, mediaTimeSec: 0, speed: 1 };
  }
  const out: Layer[] = [{
    kind: 'title', opacity, title: seg.title, subtitle: seg.subtitle, description: seg.description, chapterIndex: seg.chapterIndex,
    layout: seg.layout, background,
  }];
  if (p) {
    for (const a of p.annotations) {
      if (a.target.type !== 'chapter' || a.target.chapterId !== seg.chapterId) continue;
      const end = a.durationSec > 0 ? Math.min(d, a.startSec + a.durationSec) : d;
      if (l < a.startSec || l >= end || !a.text.trim()) continue;
      out.push({ kind: 'text', opacity: opacity * Math.max(0, Math.min(1, (l - a.startSec) / TEXT_FADE_SEC, (end - l) / TEXT_FADE_SEC)), text: a.text, style: (a.style in ANNOTATION_STYLES ? a.style : 'subtitle') as AnnotationStyle, box: denorm(a.position, frame), annotationId: a.id });
    }
  }
  return out;
}

function defaultSize(item: MediaItem): Size | undefined {
  return item.width && item.height ? { w: item.width, h: item.height } : undefined;
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
  const clipLane = lanes.find((l) => l.kind === 'clipSound')?.id ?? 'lane-clip';
  const videoVoice = (seg: MediaSegment, fade: number) => {
    const local = Math.min(Math.max(t - seg.start, 0), seg.duration);
    const { fin, fout } = fadeTimes(seg.duration, seg.cue.entrance, seg.cue.exit);
    voices.push({
      itemId: seg.item.id, kind: 'video', laneId: clipLane, speed: seg.speed,
      mediaTimeSec: seg.inPointSec + local * seg.speed,
      gain: (seg.cue.mute ? 0 : seg.cue.volume) * laneGain(clipLane) * edgeFade(local, seg.duration, fin, fout) * fade * duck(clipLane),
    });
  };
  const seg = i >= 0 ? tl.segments[i] : undefined;
  if (seg && seg.kind !== 'title') {
    // PE-16: under a crossfade, the item before fades out as this one fades in.
    const prev = i > 0 ? tl.segments[i - 1] : undefined;
    const into = t - seg.start;
    if (seg.overlapSec > 0 && into < seg.overlapSec && prev?.kind === 'video') {
      const local = t - prev.start;
      const { fin } = fadeTimes(prev.duration, prev.cue.entrance, { type: 'cut', durationSec: 0 });
      voices.push({
        itemId: prev.item.id, kind: 'video', laneId: clipLane, speed: prev.speed, mediaTimeSec: prev.inPointSec + local * prev.speed,
        gain: (prev.cue.mute ? 0 : prev.cue.volume) * laneGain(clipLane) * edgeFade(local, prev.duration, fin, 0) * (1 - into / seg.overlapSec) * duck(clipLane),
      });
    }
    if (seg.kind === 'video') videoVoice(seg, 1);
  }
  for (const c of active) {
    const local = t - c.start;
    // AU-8: a looping clip goes round its trimmed part.
    const media = c.loopSec ? c.inPointSec + (local % c.loopSec) : c.inPointSec + local;
    voices.push({
      itemId: c.item.id, kind: 'audio', laneId: c.laneId, speed: 1,
      mediaTimeSec: media,
      gain: c.cue.volume * laneGain(c.laneId) * edgeFade(local, c.duration, c.fadeInSec, c.fadeOutSec) * duck(c.laneId),
    });
  }
  return voices;
}
