/**
 * Drawing the render model's layers on a 2D canvas: the one drawing code the
 * preview player and the export page share (VX-7, VX-8), so they draw the same
 * pictures, title cards, captions and map.
 *
 * Where pictures and map tiles come from is up to the caller (DrawSources):
 * the player's media elements and tile images, or the export page's decoded
 * originals and tiles fetched into storage before the render.
 */
import { ANNOTATION_STYLES, type Frame, type MapLayer, type PictureLayer, type Size, type TextLayer, type TitleLayer } from '../core/render-model.js';
import { mapAttribution, worldXY, tilesFor, type MapState } from '../core/map-model.js';
import type { MapStyle } from '../core/schema.js';

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A picture ready to draw, and how many of its pixels make one pixel of the layer's src rect (1 = natural size). */
export interface Drawable {
  image: CanvasImageSource;
  scale: number;
}

export interface DrawSources {
  /** The picture for a layer, or 'loading' / 'failed' (a placeholder is drawn). */
  picture(layer: PictureLayer): Drawable | 'loading' | 'failed';
  /** A map tile, if loaded (undefined: draw what is there, and ask for it). */
  tile(style: MapStyle, z: number, x: number, y: number): CanvasImageSource | undefined;
  /** The tile provider's attribution, or '' when tiles are off. */
  attribution: string;
}

export interface DrawResult {
  /** Layers drawn as placeholders because their picture was not ready. */
  placeholders: number;
  /** Map tiles that were not loaded yet. */
  missingTiles: number;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export function drawFrame(ctx: Ctx, frame: Frame, size: Size, src: DrawSources): DrawResult {
  const res: DrawResult = { placeholders: 0, missingTiles: 0 };
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size.w, size.h);
  for (const layer of frame.layers) {
    ctx.save();
    if (layer.kind === 'title') drawTitle(ctx, layer, size, src, res);
    else if (layer.kind === 'text') drawText(ctx, layer, size);
    else if (layer.kind === 'map') res.missingTiles += drawMap(ctx, layer, src);
    else drawPicture(ctx, layer, src, res);
    ctx.restore();
  }
  ctx.restore();
  return res;
}

function drawPicture(ctx: Ctx, layer: PictureLayer, src: DrawSources, res: DrawResult) {
  if (layer.opacity <= 0) return;
  ctx.globalAlpha = layer.opacity;
  const p = src.picture(layer);
  if (p === 'loading' || p === 'failed') {
    res.placeholders += 1;
    drawPlaceholder(ctx, layer.dst, p === 'failed' ? 'Media not found' : 'Loading…');
    return;
  }
  const s = layer.src, d = layer.dst, k = p.scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(p.image, s.x * k, s.y * k, s.w * k, s.h * k, d.x, d.y, d.w, d.h);
}

export function drawPlaceholder(ctx: Ctx, r: { x: number; y: number; w: number; h: number }, label: string) {
  ctx.fillStyle = '#16181d';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = '#8a8f98';
  ctx.font = `${Math.round(Math.max(12, r.h * 0.04))}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
}

// ---------------------------------------------------------------- title cards (IT-5, PE-15)

function drawTitle(ctx: Ctx, layer: TitleLayer, size: Size, src: DrawSources, res: DrawResult) {
  ctx.globalAlpha = layer.opacity;
  if (layer.background) {
    const p = src.picture({ ...layer.background, opacity: 1 });
    if (p !== 'loading' && p !== 'failed') {
      const s = layer.background.src, d = layer.background.dst, k = p.scale;
      ctx.drawImage(p.image, s.x * k, s.y * k, s.w * k, s.h * k, d.x, d.y, d.w, d.h);
      // Dim it so the text reads.
      const g = ctx.createLinearGradient(0, 0, 0, size.h);
      g.addColorStop(0, 'rgba(8,12,24,0.55)');
      g.addColorStop(1, 'rgba(8,12,24,0.75)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size.w, size.h);
    } else {
      res.placeholders += p === 'loading' ? 1 : 0;
      gradient(ctx, size);
    }
  } else gradient(ctx, size);
  drawTitleText(ctx, layer, size);
}

function gradient(ctx: Ctx, size: Size) {
  const g = ctx.createLinearGradient(0, 0, size.w, size.h);
  g.addColorStop(0, '#10233a');
  g.addColorStop(1, '#1d1430');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size.w, size.h);
}

/** A chapter's title card text, in its layout: centred, left-aligned, or as a lower third. */
export function drawTitleCard(
  ctx: Ctx,
  card: { title: string; subtitle: string; description: string; chapterIndex: number; layout?: TitleLayer['layout'] },
  size: Size,
): void {
  gradient(ctx, size);
  drawTitleText(ctx, { ...card, layout: card.layout ?? 'center' }, size);
}

function drawTitleText(ctx: Ctx, card: { title: string; subtitle: string; description: string; chapterIndex: number; layout: TitleLayer['layout'] }, size: Size) {
  const u = Math.min(size.w, size.h);
  const left = card.layout !== 'center';
  const x = left ? size.w * 0.08 : size.w / 2;
  const maxW = left ? size.w * 0.84 : size.w * 0.9;
  ctx.textAlign = left ? 'left' : 'center';
  ctx.textBaseline = 'alphabetic';
  const descFont = `italic 400 ${Math.round(u * 0.036)}px ${FONT}`;
  ctx.font = descFont;
  const lines = card.description ? wrapText(ctx, card.description, size.w * (left ? 0.7 : 0.78), 4) : [];
  const lineH = u * 0.036 * 1.4;
  // Where the block sits: centred (moving up for a description), or low in the frame for a lower third.
  const block = size.h * 0.21 + (lines.length ? size.h * 0.05 + lines.length * lineH : 0);
  const top = card.layout === 'lower' ? size.h * 0.9 - block : size.h * 0.5 - block / 2;
  if (card.layout === 'lower') {
    const g = ctx.createLinearGradient(0, top - size.h * 0.08, 0, size.h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, top - size.h * 0.08, size.w, size.h - top + size.h * 0.08);
    ctx.fillStyle = '#4f9cf7';
    ctx.fillRect(x - u * 0.025, top + size.h * 0.02, u * 0.008, size.h * 0.19);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `600 ${Math.round(u * 0.035)}px ${FONT}`;
  ctx.fillText(`CHAPTER ${card.chapterIndex + 1}`, x, top + size.h * 0.04, maxW);
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(u * 0.085)}px ${FONT}`;
  ctx.fillText(card.title, x, top + size.h * 0.16, maxW);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = `400 ${Math.round(u * 0.04)}px ${FONT}`;
  ctx.fillText(card.subtitle, x, top + size.h * 0.25, maxW);
  if (!lines.length) return;
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.font = descFont;
  const y0 = top + size.h * 0.25 + size.h * 0.05 + lineH * 0.75;
  lines.forEach((line, i) => ctx.fillText(line, x, y0 + i * lineH, maxW));
}

/**
 * Break text into lines no wider than maxWidth (in the context's current font), keeping the author's own line
 * breaks; past maxLines the last line ends with an ellipsis.
 */
export function wrapText(ctx: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, maxWidth: number, maxLines: number): string[] {
  const fits = (s: string) => ctx.measureText(s).width <= maxWidth;
  const out: string[] = [];
  for (const para of text.split(/\r?\n/).map((p) => p.trim()).filter(Boolean)) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (fits(next) || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  if (out.length <= maxLines) return out;
  const kept = out.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && !fits(`${last}…`)) last = last.replace(/\s*\S+$/, '');
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

// ---------------------------------------------------------------- captions and credits (PE-14, PE-18)

/** A text layer in its style preset, inside its box. */
export function drawText(ctx: Ctx, layer: TextLayer, size: Size) {
  if (layer.opacity <= 0) return;
  ctx.globalAlpha = layer.opacity;
  const st = layer.style;
  const px = Math.max(10, Math.round(ANNOTATION_STYLES[st].size * size.h));
  const b = layer.box;
  const weight = st === 'headline' ? 800 : st === 'lowerThird' ? 700 : st === 'credit' ? 500 : 600;
  ctx.font = `${weight} ${px}px ${FONT}`;
  const pad = px * 0.45;
  const lines = wrapText(ctx, layer.text, Math.max(px, b.w - 2 * pad), st === 'headline' ? 2 : 3);
  const lineH = px * 1.25;
  const textH = lines.length * lineH;
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
  ctx.textBaseline = 'middle';
  const align = st === 'subtitle' || st === 'headline' ? 'center' : st === 'stamp' ? 'right' : 'left';
  ctx.textAlign = align;
  const tx = align === 'center' ? b.x + b.w / 2 : align === 'right' ? b.x + b.w - pad : b.x + pad;
  const top = b.y + Math.max(0, (b.h - textH) / 2);
  // Backgrounds: a soft box for subtitles and tags, a bar and band for lower thirds; shadows for the rest.
  if (st === 'subtitle' || st === 'tag') {
    const w = widest + 2 * pad, h = textH + pad;
    const x = align === 'center' ? tx - w / 2 : b.x;
    roundRect(ctx, x, top - pad / 2, w, h, pad * 0.6);
    ctx.fillStyle = st === 'tag' ? 'rgba(79,156,247,0.92)' : 'rgba(0,0,0,0.6)';
    ctx.fill();
  } else if (st === 'lowerThird') {
    const w = widest + 3 * pad;
    ctx.fillStyle = 'rgba(10,14,24,0.72)';
    ctx.fillRect(b.x, top - pad / 2, w, textH + pad);
    ctx.fillStyle = '#4f9cf7';
    ctx.fillRect(b.x, top - pad / 2, pad * 0.35, textH + pad);
  } else {
    ctx.shadowColor = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur = px * 0.25;
    ctx.shadowOffsetY = px * 0.06;
  }
  ctx.fillStyle = st === 'credit' ? 'rgba(255,255,255,0.85)' : '#fff';
  const offset = st === 'lowerThird' ? pad * 0.8 : 0;
  lines.forEach((l, i) => ctx.fillText(l, tx + offset, top + lineH * (i + 0.5)));
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------- the map (MV-3 to MV-8)

const STYLE = {
  light: { bg: '#dfe6ee', route: '#24476e', ink: '#1a2433', paper: '#ffffff' },
  dark: { bg: '#1b2430', route: '#9cc6ff', ink: '#e8eef7', paper: '#0e141d' },
  terrain: { bg: '#e8e4d8', route: '#5a3d1e', ink: '#2c2416', paper: '#fffaf0' },
} as const;
const ACCENT = '#f2a33a';
/** Tiles are drawn darker this way for the dark style (one set of tiles, two looks). */
const DARK_FILTER = 'invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.88) saturate(0.7)';

/** Draw the map layer; returns how many tiles it wanted that were not loaded. */
export function drawMap(ctx: Ctx, layer: MapLayer, src: DrawSources): number {
  const { rect, circle } = layer.layout;
  const st = layer.state;
  const look = STYLE[st.style] ?? STYLE.light;
  const u = Math.max(0.6, rect.w / 320); // scale for line widths and text
  ctx.globalAlpha = layer.opacity;
  ctx.beginPath();
  if (circle) ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, Math.min(rect.w, rect.h) / 2, 0, Math.PI * 2);
  else ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = look.bg;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  const missing = src.attribution ? drawTiles(ctx, st, rect, src) : 0;
  const pt = projector(st, rect);
  // Route legs: done solid, ahead dashed; the leg being travelled fills in.
  const pins = st.pins;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let k = 0; k + 1 < pins.length; k++) {
    const a = pt(pins[k]), b = pt(pins[k + 1]);
    const done = pins[k + 1].index <= st.routeDoneTo;
    ctx.strokeStyle = look.route;
    ctx.lineWidth = 2.2 * u;
    ctx.globalAlpha = layer.opacity * (done ? 0.9 : 0.55);
    ctx.setLineDash(done ? [] : [5 * u, 5 * u]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (st.travel) {
    const a = pt(st.travel.from), b = pt(st.travel.to);
    ctx.globalAlpha = layer.opacity;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 3 * u;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(a.x + (b.x - a.x) * st.travel.f, a.y + (b.y - a.y) * st.travel.f);
    ctx.stroke();
  }
  // Item dots, then the trail walked so far.
  for (const d of st.dots) {
    const p = pt(d);
    ctx.globalAlpha = layer.opacity * (d.state === 'past' ? 0.35 : 1);
    ctx.beginPath();
    ctx.arc(p.x, p.y, (d.state === 'current' ? 4.8 : d.state === 'past' ? 2.6 : 3.4) * u, 0, Math.PI * 2);
    if (d.state === 'ahead') {
      ctx.strokeStyle = look.route;
      ctx.lineWidth = 1.5 * u;
      ctx.stroke();
    } else {
      ctx.fillStyle = d.state === 'current' ? ACCENT : look.route;
      ctx.fill();
    }
  }
  if (st.trail.length > 1) {
    ctx.globalAlpha = layer.opacity * 0.9;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    st.trail.forEach((ll, k) => {
      const p = pt(ll);
      if (k === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }
  // Chapter pins, numbered.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const pin of pins) {
    const p = pt(pin);
    const r = (pin.state === 'current' ? 10.5 : 8) * u;
    ctx.globalAlpha = layer.opacity;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = pin.state === 'current' ? ACCENT : pin.state === 'visited' ? look.route : look.paper;
    ctx.fill();
    ctx.lineWidth = 1.5 * u;
    ctx.strokeStyle = pin.state === 'ahead' ? look.route : look.paper;
    ctx.stroke();
    ctx.fillStyle = pin.state === 'ahead' ? look.route : '#fff';
    ctx.font = `700 ${Math.round(r * 1.15)}px ${FONT}`;
    ctx.fillText(String(pin.index + 1), p.x, p.y + 0.5);
  }
  // The marker, with a ring that pulses on arrival.
  if (st.marker) {
    const p = pt(st.marker);
    ctx.globalAlpha = layer.opacity;
    if (st.marker.pulse > 0) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2 * u;
      ctx.globalAlpha = layer.opacity * st.marker.pulse;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (6.5 + 12 * (1 - st.marker.pulse)) * u, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = layer.opacity;
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6 * u, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT;
    ctx.fill();
    ctx.lineWidth = 1.6 * u;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }
  // "Chapter 3 of 8" (MV-5) and the provider's attribution (MV-8).
  ctx.globalAlpha = layer.opacity;
  if (st.label) {
    ctx.font = `700 ${Math.round(9.5 * u)}px ${FONT}`;
    const w = ctx.measureText(st.label).width + 12 * u;
    const lx = circle ? rect.x + rect.w / 2 - w / 2 : rect.x + 6 * u;
    const ly = rect.y + (circle ? 18 : 6) * u;
    roundRect(ctx, lx, ly, w, 16 * u, 8 * u);
    ctx.fillStyle = 'rgba(10,14,24,0.78)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(st.label, lx + 6 * u, ly + 8.5 * u);
  }
  if (src.attribution) {
    const text = mapAttribution(st.style, src.attribution);
    ctx.font = `400 ${Math.max(7, Math.round(6.5 * u))}px ${FONT}`;
    const w = ctx.measureText(text).width + 6 * u;
    const ax = circle ? rect.x + rect.w / 2 - w / 2 : rect.x + rect.w - w;
    const ay = rect.y + rect.h - (circle ? 22 : 10) * u;
    ctx.fillStyle = st.style === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.75)';
    ctx.fillRect(ax, ay, w, 10 * u);
    ctx.fillStyle = look.ink;
    ctx.textAlign = 'left';
    ctx.fillText(text, ax + 3 * u, ay + 5.5 * u);
  }
  ctx.restore(); // clip
  // A thin frame around the inset (not around a full-frame map).
  if (!layer.layout.full) {
    ctx.globalAlpha = layer.opacity;
    ctx.lineWidth = 2 * u;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    if (circle) ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, Math.min(rect.w, rect.h) / 2 - u, 0, Math.PI * 2);
    else ctx.rect(rect.x + u, rect.y + u, rect.w - 2 * u, rect.h - 2 * u);
    ctx.stroke();
  }
  return missing;
}

/** From latitude/longitude to pixels inside the map's rectangle, for the state's camera. */
export function projector(st: MapState, rect: { x: number; y: number; w: number; h: number }) {
  const s = 2 ** st.camera.zoom;
  const c = worldXY(st.camera.lat, st.camera.lng);
  return (ll: { lat: number; lng: number }) => {
    const p = worldXY(ll.lat, ll.lng);
    return { x: rect.x + rect.w / 2 + (p.x - c.x) * s, y: rect.y + rect.h / 2 + (p.y - c.y) * s };
  };
}

function drawTiles(ctx: Ctx, st: MapState, rect: { x: number; y: number; w: number; h: number }, src: DrawSources): number {
  const cam = st.camera;
  const tiles = tilesFor(cam, rect);
  if (!tiles.length) return 0;
  const z = tiles[0].z;
  const scale = 2 ** (cam.zoom - z);
  const c = worldXY(cam.lat, cam.lng);
  const cx = c.x * 2 ** z, cy = c.y * 2 ** z;
  let missing = 0;
  if (st.style === 'dark') ctx.filter = DARK_FILTER;
  const size = 256 * scale;
  for (const t of tiles) {
    // Placed by its unwrapped column (tiles repeat across the antimeridian).
    const dx = rect.x + rect.w / 2 + (t.ux * 256 - cx) * scale;
    const dy = rect.y + rect.h / 2 + (t.y * 256 - cy) * scale;
    const img = src.tile(st.style, t.z, t.x, t.y);
    if (img) {
      ctx.drawImage(img, dx, dy, size + 0.5, size + 0.5);
      continue;
    }
    missing += 1;
    // Meanwhile the parent tile, magnified, if it is there.
    if (z > 0) {
      const parent = src.tile(st.style, z - 1, t.x >> 1, t.y >> 1);
      if (parent) ctx.drawImage(parent, (t.x & 1) * 128, (t.y & 1) * 128, 128, 128, dx, dy, size + 0.5, size + 0.5);
    }
  }
  ctx.filter = 'none';
  return missing;
}
