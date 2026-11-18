/**
 * The export page (VX-7, VX-8): opened by the server in a headless browser, it
 * draws one stretch of an export's frames with the preview's own code (the
 * render model and draw.ts) and sends each frame back as raw RGBA.
 *
 * Every frame waits until everything it shows is loaded: photos (decoded from
 * the originals), video frames (decoded in order by the server) and map tiles
 * (fetched into storage before the render). Nothing depends on timing, so the
 * same project gives the same frames.
 */
import { buildTimeline, frameAt, tilesFor, type Frame, type MapStyle, type PictureLayer, type RenderSetup, type Size } from '../core/index.js';
import { drawFrame, type Drawable, type DrawSources } from '../player/draw.js';

const q = new URLSearchParams(location.hash.slice(1));
const token = q.get('token') ?? '';
const chunk = Number(q.get('chunk'));
const from = Number(q.get('from'));
const to = Number(q.get('to'));
const base = `/api/render/${encodeURIComponent(token)}`;
const HEADERS = { 'x-tripalogue-client': '1' };

class LoadError extends Error {
  constructor(message: string, readonly itemId?: string, readonly reason?: string) {
    super(message);
  }
}

async function main() {
  const setup = (await (await fetch(`${base}/setup`)).json()) as RenderSetup;
  const { doc, fps, start, size } = setup;
  const tl = buildTimeline(doc);
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
  const sizeOf = (item: { id: string; width?: number; height?: number }): Size | undefined =>
    setup.sizes[item.id] ?? (item.width && item.height ? { w: item.width, h: item.height } : undefined);

  // Photos: decoded once, upright, at no more than twice the size that covers the frame.
  const images = new Map<string, Promise<Drawable>>();
  const order: string[] = [];
  const image = (id: string): Promise<Drawable> => {
    let p = images.get(id);
    if (!p) {
      p = (async () => {
        const res = await fetch(`${base}/image/${encodeURIComponent(id)}`);
        if (!res.ok) throw new LoadError((await res.json().catch(() => ({}))).error ?? `could not be read (${res.status})`, id, res.status === 404 ? 'missing' : undefined);
        const blob = await res.blob();
        const up = setup.sizes[id];
        const k = up ? Math.min(1, 2 * Math.max(size.w / up.w, size.h / up.h)) : 1;
        const opts: ImageBitmapOptions = { imageOrientation: 'from-image' };
        if (up && k < 1) {
          opts.resizeWidth = Math.max(1, Math.round(up.w * k));
          opts.resizeHeight = Math.max(1, Math.round(up.h * k));
          opts.resizeQuality = 'high';
        }
        let bmp: ImageBitmap;
        try {
          bmp = await createImageBitmap(blob, opts);
        } catch {
          throw new LoadError('is in a format the browser cannot draw', id);
        }
        return { image: bmp, scale: up ? bmp.width / up.w : 1 };
      })();
      images.set(id, p);
      order.push(id);
      // Keep a handful decoded; older ones are released.
      while (order.length > 10) {
        const old = order.shift()!;
        void images.get(old)?.then((d) => (d.image as ImageBitmap).close()).catch(() => {});
        images.delete(old);
      }
    }
    return p;
  };

  // Video frames: from the server's decoder for this stretch, at the layer's media time.
  const videoFrame = async (layer: PictureLayer): Promise<Drawable> => {
    const u = `${base}/video/${encodeURIComponent(layer.itemId)}?chunk=${chunk}&t=${layer.mediaTimeSec.toFixed(6)}&speed=${layer.speed}`;
    const res = await fetch(u);
    if (!res.ok) throw new LoadError((await res.json().catch(() => ({}))).error ?? `could not be read (${res.status})`, layer.itemId);
    const w = Number(res.headers.get('X-Width')), h = Number(res.headers.get('X-Height'));
    const data = new Uint8ClampedArray(await res.arrayBuffer());
    const bmp = await createImageBitmap(new ImageData(data, w, h));
    const up = setup.sizes[layer.itemId];
    return { image: bmp, scale: up ? w / up.w : 1 };
  };

  // Map tiles, fetched into storage before the render; one missing is drawn as plain map background.
  const tiles = new Map<string, ImageBitmap | null>();
  const tileKey = (style: MapStyle, z: number, x: number, y: number) => `${style === 'terrain' ? 'terrain' : 'light'}/${z}/${x}/${y}`;
  const loadTile = async (style: MapStyle, z: number, x: number, y: number) => {
    const key = tileKey(style, z, x, y);
    if (tiles.has(key)) return;
    const lang = doc.mapView.labelLanguage ? `?lang=${encodeURIComponent(doc.mapView.labelLanguage)}` : '';
    try {
      const res = await fetch(`/api/tiles/${key}${lang}`);
      tiles.set(key, res.ok ? await createImageBitmap(await res.blob()) : null);
    } catch {
      tiles.set(key, null);
    }
    if (tiles.size > 800) {
      const first = tiles.keys().next().value!;
      tiles.get(first)?.close();
      tiles.delete(first);
    }
  };

  for (let k = from; k < to; k++) {
    const t = start + k / fps;
    const frame: Frame = frameAt(tl, t, size, sizeOf, doc);
    // Load everything this frame shows.
    const pictures = new Map<string, Drawable>();
    const videoFrames: ImageBitmap[] = [];
    const key = (l: PictureLayer) => `${l.kind}:${l.itemId}:${l.mediaTimeSec}`;
    const wanted: PictureLayer[] = [];
    for (const l of frame.layers) {
      if (l.kind === 'image' || l.kind === 'video') wanted.push(l);
      else if (l.kind === 'title' && l.background) wanted.push(l.background);
    }
    await Promise.all(wanted.map(async (l) => {
      const d = l.kind === 'video' ? await videoFrame(l) : await image(l.itemId);
      if (l.kind === 'video') videoFrames.push(d.image as ImageBitmap);
      pictures.set(key(l), d);
    }));
    if (setup.tiles) {
      const loads: Promise<void>[] = [];
      for (const l of frame.layers) {
        if (l.kind !== 'map') continue;
        for (const tl2 of tilesFor(l.state.camera, l.layout.rect)) loads.push(loadTile(l.state.style, tl2.z, tl2.x, tl2.y));
      }
      await Promise.all(loads);
    }
    const sources: DrawSources = {
      picture: (l) => pictures.get(key(l)) ?? 'loading',
      tile: (style, z, x, y) => tiles.get(tileKey(style, z, x, y)) ?? undefined,
      attribution: setup.attribution,
    };
    drawFrame(ctx, frame, size, sources);
    for (const b of videoFrames) b.close();
    const pixels = ctx.getImageData(0, 0, size.w, size.h).data;
    const res = await fetch(`${base}/frame?chunk=${chunk}&k=${k}`, { method: 'POST', headers: HEADERS, body: pixels });
    const reply = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new LoadError(reply.error ?? `frame ${k} was refused`);
  }
}

main().catch(async (e: unknown) => {
  const err = e instanceof LoadError ? e : new LoadError(String((e as Error)?.message ?? e));
  await fetch(`${base}/fail`, {
    method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ chunk, message: err.message, itemId: err.itemId, reason: err.reason }),
  }).catch(() => {});
});
