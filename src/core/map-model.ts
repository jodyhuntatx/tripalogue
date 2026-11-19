/**
 * The map view as part of the shared render model (MV-3 to MV-8, VX-8): a pure
 * function from (project, timeline, time) to what the map shows, so the preview
 * and the export draw the same map, frame for frame.
 *
 * - Chapter view (MV-4): the chapter's place and the places of its photos and
 *   videos, framed; the item on screen highlighted; the path walked so far as a
 *   trail, with a marker that hops to each item as it comes on screen.
 * - Itinerary progress (MV-5): every chapter pin and the route, chapters done
 *   marked, the current one highlighted, "Chapter 3 of 8".
 * - Chapter transitions (MV-6): at each chapter's opening the map shows the
 *   whole trip, a marker travels along the route from the last chapter to this
 *   one, then the view zooms in. In the inset during the title card, or with
 *   the map filling the frame before it.
 * - Fallbacks (MV-7): an item without a place uses its chapter's pin; a chapter
 *   without a place hides the map.
 * - On or off per travelogue, chapter or item (MV-3); hide precise locations.
 */
import { segmentIndexAt, DEFAULT_MAP_TRANSITION, type Segment, type Timeline } from './timeline.js';
import type { Chapter, InsetCorner, LatLng, MapStyle, Travelogue } from './schema.js';
import { distanceKm } from './contributors.js';
import { mediaPlaces } from './places.js';

export interface MapCamera {
  lat: number;
  lng: number;
  /** Continuous web-mercator zoom (256-pixel tiles). */
  zoom: number;
}

export interface MapPinState {
  id: string;
  index: number;
  lat: number;
  lng: number;
  title: string;
  state: 'visited' | 'current' | 'ahead';
}

export interface MapDotState {
  lat: number;
  lng: number;
  state: 'past' | 'shown' | 'current' | 'ahead';
}

export interface MapState {
  style: MapStyle;
  labelLanguage?: string;
  camera: MapCamera;
  pins: MapPinState[];
  /** Route legs (between consecutive chapters with a place) are solid up to this pin index, dashed after. */
  routeDoneTo: number;
  /** While travelling between chapters: the leg being travelled and how far along (0..1). */
  travel?: { from: LatLng; to: LatLng; f: number };
  dots: MapDotState[];
  /** The path walked so far in this chapter, ending at the marker. */
  trail: LatLng[];
  marker?: LatLng & { pulse: number };
  label?: string;
  view: 'trip' | 'travel' | 'zoom' | 'chapter';
}

export interface MapLayout {
  /** Where the map is drawn, in frame pixels. */
  rect: { x: number; y: number; w: number; h: number };
  circle: boolean;
  /** The map fills the frame (MV-6 full-frame transition). */
  full: boolean;
  opacity: number;
}

const TILE = 256;
const MAX_LAT = 85.05112878;
/** Items further than this from their chapter's place are drawn but do not widen the chapter view. */
export const FIT_KM = 50;
/** How long the marker takes to hop to the next item. */
export const HOP_SEC = 0.8;
const MAX_ZOOM = 15;
const SINGLE_POINT_ZOOM = 12;

export function worldXY(lat: number, lng: number): { x: number; y: number } {
  const la = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return { x: ((lng + 180) / 360) * TILE, y: ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * TILE };
}

export function worldLatLng(x: number, y: number): LatLng {
  const lng = (x / TILE) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / TILE;
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng };
}


/** The camera that shows every point in a viewport of the given size, with padding (a share of each side). */
export function fitCamera(points: LatLng[], view: { w: number; h: number }, pad = 0.18, maxZoom = MAX_ZOOM): MapCamera {
  if (!points.length) return { lat: 20, lng: 0, zoom: 1 };
  const xy = points.map((p) => worldXY(p.lat, p.lng));
  const xs = xy.map((p) => p.x), ys = xy.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const c = worldLatLng((minX + maxX) / 2, (minY + maxY) / 2);
  const dx = maxX - minX, dy = maxY - minY;
  if (dx < 1e-9 && dy < 1e-9) return { ...c, zoom: Math.min(maxZoom, SINGLE_POINT_ZOOM) };
  const usable = 1 - 2 * pad;
  const z = Math.log2(Math.min((view.w * usable) / Math.max(dx, 1e-9), (view.h * usable) / Math.max(dy, 1e-9)));
  return { ...c, zoom: Math.max(0, Math.min(maxZoom, z)) };
}

/** Smooth start and end (0..1 → 0..1). */
export const ease = (f: number) => { const x = Math.max(0, Math.min(1, f)); return x * x * (3 - 2 * x); };

/** Between two cameras: centre in world space and zoom, both eased (a simple fly). */
export function lerpCamera(a: MapCamera, b: MapCamera, f: number): MapCamera {
  const k = ease(f);
  const pa = worldXY(a.lat, a.lng), pb = worldXY(b.lat, b.lng);
  const c = worldLatLng(pa.x + (pb.x - pa.x) * k, pa.y + (pb.y - pa.y) * k);
  return { ...c, zoom: a.zoom + (b.zoom - a.zoom) * k };
}

const lerpLL = (a: LatLng, b: LatLng, f: number): LatLng => {
  const k = ease(f);
  const pa = worldXY(a.lat, a.lng), pb = worldXY(b.lat, b.lng);
  return worldLatLng(pa.x + (pb.x - pa.x) * k, pa.y + (pb.y - pa.y) * k);
};

/** Where the inset sits in a frame (MV-3): a corner, a share of the frame's width, 4:3 or a circle. */
export function insetRect(mv: Travelogue['mapView'], frame: { w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const w = Math.round(frame.w * Math.max(0.1, Math.min(0.3, mv.size)));
  const h = Math.round(mv.shape === 'circle' ? w : (w * 3) / 4);
  const m = Math.round(Math.min(frame.w, frame.h) * 0.03);
  const corner: InsetCorner = mv.corner;
  const x = corner.endsWith('Left') ? m : frame.w - w - m;
  const y = corner.startsWith('top') ? m : frame.h - h - m;
  return { x, y, w, h };
}

/** MV-3: whether the map shows for a chapter and (optionally) an item. Item over chapter over travelogue. */
export function mapShownFor(p: Travelogue, ch: Chapter, itemOverride?: 'on' | 'off'): boolean {
  if (!ch.coordinates) return false; // MV-7: a chapter without a place hides the map
  if (itemOverride) return itemOverride === 'on';
  if (ch.mapInset) return ch.mapInset === 'on';
  return p.mapView.enabled;
}

/** The place an item is drawn at: its own, or its chapter's pin (MV-7, and when precise locations are hidden). */
export function itemPlace(p: Travelogue, loc: LatLng | undefined, ch: Chapter | undefined): LatLng | undefined {
  if (!ch?.coordinates) return loc;
  if (!loc || p.mapView.hidePreciseLocations) return ch.coordinates;
  return loc;
}

/**
 * Where the map is drawn at time t and how it looks, or undefined when it is hidden. `frame` is the stage size.
 */
export function mapAt(p: Travelogue, tl: Timeline, t: number, frame: { w: number; h: number }): { layout: MapLayout; state: MapState } | undefined {
  const i = segmentIndexAt(tl, t);
  if (i < 0) return undefined;
  const seg = tl.segments[i];
  const chIndex = seg.chapterIndex;
  const ch = p.chapters[chIndex];
  if (!ch) return undefined;
  const mv = p.mapView;
  const pinsAll = p.chapters.map((c, index) => ({ c, index })).filter((x) => !!x.c.coordinates);
  if (!pinsAll.length || !ch.coordinates) return undefined;
  const local = t - seg.start;
  const tr = mv.transition ?? DEFAULT_MAP_TRANSITION;
  // Full-frame map before a chapter's title card (MV-6).
  const fullPhase = seg.kind === 'title' && seg.mapSec > 0 && local < seg.mapSec;
  const shown = fullPhase || mapShownFor(p, ch, seg.kind === 'title' ? undefined : seg.cue.mapInset);
  if (!shown) return undefined;

  const rect = fullPhase ? { x: 0, y: 0, w: frame.w, h: frame.h } : insetRect(mv, frame);
  const view = { w: rect.w, h: rect.h };
  const opacity = fullPhase ? edgeFade(local, seg.mapSec, 0.4) : 1;
  const layout: MapLayout = { rect, circle: !fullPhase && mv.shape === 'circle', full: fullPhase, opacity };

  const pins: MapPinState[] = pinsAll.map(({ c, index }) => ({
    id: c.id, index, lat: c.coordinates!.lat, lng: c.coordinates!.lng, title: c.title,
    state: index < chIndex ? 'visited' : index === chIndex ? 'current' : 'ahead',
  }));
  const trip = fitCamera(pins, view);
  const chapterCam = chapterCamera(p, tl, chIndex, view);
  const prevPin = [...pinsAll].reverse().find((x) => x.index < chIndex)?.c.coordinates;
  const here = ch.coordinates;
  const label = mv.chapterLabel === false ? undefined : `Chapter ${chIndex + 1} of ${p.chapters.length}`;
  const base = { style: mv.style, labelLanguage: mv.labelLanguage, pins, label };
  const story = storyAt(p, tl, i, local, mv.transitionAnimation);

  if (seg.kind === 'title') {
    // The chapter's opening: the transition plays over the full-frame map, or over the title card in the inset.
    const d = fullPhase || seg.mapSec > 0 ? seg.mapSec : Math.min(tr.durationSec, seg.duration);
    const tt = fullPhase ? local : seg.mapSec > 0 ? Number.POSITIVE_INFINITY : local; // inset after a full-frame map: arrived
    const startCam = mv.tripOverview ? trip : prevPin ? fitCamera([prevPin, here], view) : trip;
    if (!mv.transitionAnimation) {
      const cam = mv.tripOverview && !(seg.mapSec > 0 && !fullPhase) ? trip : chapterCam;
      return { layout, state: { ...base, camera: cam, routeDoneTo: chIndex, dots: story.dots, trail: [], view: cam === trip ? 'trip' : 'chapter' } };
    }
    const travelEnd = 0.45 * d;
    if (tt < travelEnd && prevPin) {
      const f = tt / travelEnd;
      return { layout, state: { ...base, camera: startCam, routeDoneTo: chIndex - 1, travel: { from: prevPin, to: here, f: ease(f) }, marker: { ...lerpLL(prevPin, here, f), pulse: 0 }, dots: story.pastDots, trail: [], view: 'travel' } };
    }
    if (tt < d) {
      const f = (tt - travelEnd) / (d - travelEnd);
      return { layout, state: { ...base, camera: lerpCamera(startCam, chapterCam, f), routeDoneTo: chIndex, marker: { ...here, pulse: 0 }, dots: story.dots, trail: [], view: 'zoom' } };
    }
    return { layout, state: { ...base, camera: chapterCam, routeDoneTo: chIndex, marker: { ...here, pulse: 0 }, dots: story.dots, trail: [], view: 'chapter' } };
  }
  return {
    layout,
    state: { ...base, camera: chapterCam, routeDoneTo: chIndex, dots: story.dots, trail: story.trail, marker: story.marker, view: 'chapter' },
  };
}

function edgeFade(local: number, d: number, ramp: number): number {
  return Math.max(0, Math.min(1, local / ramp, (d - local) / ramp));
}

/** The chapter view (MV-4): its place and the places of its items (those near it), framed. */
export function chapterCamera(p: Travelogue, tl: Timeline, chIndex: number, view: { w: number; h: number }): MapCamera {
  const ch = p.chapters[chIndex];
  const pts: LatLng[] = ch.coordinates ? [ch.coordinates] : [];
  const places = mediaPlaces(p);
  for (const s of tl.segments) {
    if (s.kind === 'title' || s.chapterIndex !== chIndex) continue;
    const loc = itemPlace(p, places.get(s.item.id), ch);
    if (loc && (!ch.coordinates || distanceKm(ch.coordinates, loc) <= FIT_KM)) pts.push(loc);
  }
  return fitCamera(pts, view, 0.15);
}

/**
 * Dots and trail for segment i at `local` seconds into it: the chapter's items still to come are rings, those shown
 * are filled and joined in play order, earlier chapters' items faint; the marker hops to the item on screen.
 */
export function storyAt(p: Travelogue, tl: Timeline, i: number, local: number, animate = true): {
  dots: MapDotState[]; pastDots: MapDotState[]; trail: LatLng[]; marker?: LatLng & { pulse: number };
} {
  const seg: Segment = tl.segments[i];
  const ch = p.chapters[seg.chapterIndex];
  const dots: MapDotState[] = [];
  const pastDots: MapDotState[] = [];
  const shownPath: LatLng[] = [];
  let current: LatLng | undefined;
  // An item without a location of its own is placed where the last earlier located item was taken.
  const places = mediaPlaces(p);
  tl.segments.forEach((g, k) => {
    if (g.kind === 'title') return;
    const gch = p.chapters[g.chapterIndex];
    const loc = places.get(g.item.id);
    const own = loc ? itemPlace(p, loc, gch) : undefined;
    if (g.chapterIndex === seg.chapterIndex) {
      const place = itemPlace(p, loc, ch); // MV-7: no place → the chapter's pin
      const state = k < i ? 'shown' : k === i ? 'current' : 'ahead';
      if (own) dots.push({ ...own, state });
      if (place && state !== 'ahead') shownPath.push(place);
      if (state === 'current') current = place;
    } else if (g.chapterIndex < seg.chapterIndex && own) {
      const d: MapDotState = { ...own, state: 'past' };
      dots.push(d);
      pastDots.push(d);
    }
  });
  if (seg.kind === 'title' || !current) return { dots, pastDots, trail: [], marker: ch?.coordinates ? { ...ch.coordinates, pulse: 0 } : undefined };
  // Hop from the previous place to this one at the start of the item.
  const prev = shownPath.length > 1 ? shownPath[shownPath.length - 2] : ch?.coordinates;
  const f = animate && prev ? Math.min(1, local / HOP_SEC) : 1;
  const at = prev && f < 1 ? lerpLL(prev, current, f) : current;
  const trail = [...shownPath.slice(0, -1), at];
  const pulse = f >= 1 ? Math.max(0, 1 - (local - HOP_SEC) / 0.6) : 0;
  return { dots, pastDots, trail, marker: { ...at, pulse } };
}

/** Tiles (at an integer zoom) a camera needs to fill a viewport. */
export function tilesFor(cam: MapCamera, view: { w: number; h: number }): { z: number; x: number; y: number; ux: number }[] {
  const z = Math.max(0, Math.min(18, Math.round(cam.zoom)));
  const scale = 2 ** (cam.zoom - z);
  const c = worldXY(cam.lat, cam.lng);
  const cx = c.x * 2 ** z, cy = c.y * 2 ** z; // pixels at zoom z
  const halfW = view.w / 2 / scale, halfH = view.h / 2 / scale;
  const n = 2 ** z;
  const out: { z: number; x: number; y: number; ux: number }[] = [];
  const x0 = Math.floor((cx - halfW) / TILE), x1 = Math.floor((cx + halfW) / TILE);
  const y0 = Math.max(0, Math.floor((cy - halfH) / TILE)), y1 = Math.min(n - 1, Math.floor((cy + halfH) / TILE));
  // x wraps around the antimeridian; ux is the unwrapped column (where to draw it).
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ z, x: ((x % n) + n) % n, y, ux: x });
  return out;
}

/** Attribution the tile provider's terms require (MV-8), by style. */
export function mapAttribution(style: MapStyle, base: string): string {
  return style === 'terrain' ? `${base}, SRTM | © OpenTopoMap (CC-BY-SA)` : base;
}
