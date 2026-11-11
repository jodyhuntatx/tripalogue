/**
 * Route map (MV-1): chapters as numbered pins joined in order by a route line,
 * on web-mercator tiles served through the TripAlogue server. Drag to pan,
 * scroll or use the buttons to zoom, click a pin to select its chapter, and in
 * pick mode click anywhere to drop a pin. Works without tiles (offline or no
 * provider): pins and route still draw on a plain background.
 *
 * Inset mode is the playback map: no controls or pointer input, smaller pins,
 * chapters already shown marked as visited and the route ahead dashed, and
 * smooth flights between the whole-trip view and a chapter view.
 */

export interface MapPin {
  id: string;
  index: number;
  lat: number;
  lng: number;
  title: string;
}

export interface RouteMapOptions {
  tileUrl?: (z: number, x: number, y: number) => string;
  attribution?: string;
  onSelect?: (id: string) => void;
  onPick?: (lat: number, lng: number) => void;
  /** Playback inset: no controls or input, compact pins, progress styling. */
  inset?: boolean;
}

/** What the inset should show: the whole trip, or one chapter with its neighbours for context. */
export type MapFocus = { kind: 'trip' } | { kind: 'chapter'; id: string };

const TILE = 256;
const MAX_LAT = 85.05112878;
/** CSS pixels; keeps the canvas well inside every browser's size limit. */
const MAX_CANVAS_PX = 2048;

export function project(lat: number, lng: number, z: number): { x: number; y: number } {
  const s = TILE * 2 ** z;
  const la = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return { x: ((lng + 180) / 360) * s, y: ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * s };
}

export function unproject(x: number, y: number, z: number): { lat: number; lng: number } {
  const s = TILE * 2 ** z;
  const lng = (x / s) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / s;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lng: ((((lng + 180) % 360) + 360) % 360) - 180 };
}

export class RouteMap {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pins: MapPin[] = [];
  private selected: string | null = null;
  private picking = false;
  private z = 2;
  private cx = 0; // world pixel centre at zoom z
  private cy = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private tiles = new Map<string, { img: HTMLImageElement; ok: boolean; failed: boolean }>();
  private raf = 0;
  private ro: ResizeObserver;
  private hint: HTMLDivElement;
  private userMoved = false;
  private progressIndex = -1;
  private focusTarget: MapFocus = { kind: 'trip' };
  private flight: { from: { z: number; nx: number; ny: number }; to: { z: number; nx: number; ny: number }; t0: number; ms: number } | null = null;

  constructor(private readonly o: RouteMapOptions) {
    this.el = document.createElement('div');
    this.el.className = o.inset ? 'route-map inset' : 'route-map';
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-label', 'Route map of the chapters');
    this.canvas.setAttribute('role', 'img');
    this.ctx = this.canvas.getContext('2d')!;
    const zoomIn = this.button('+', 'Zoom in', () => this.zoomBy(1));
    const zoomOut = this.button('−', 'Zoom out', () => this.zoomBy(-1));
    const fit = this.button('⤢', 'Show all chapters', () => { this.userMoved = false; this.fit(); });
    const controls = document.createElement('div');
    controls.className = 'map-controls';
    controls.append(zoomIn, zoomOut, fit);
    const attr = document.createElement('div');
    attr.className = 'map-attribution';
    attr.textContent = o.tileUrl ? o.attribution ?? '' : 'Map tiles off';
    this.hint = document.createElement('div');
    this.hint.className = 'map-hint';
    this.hint.hidden = true;
    if (o.inset) {
      this.canvas.setAttribute('aria-label', 'Map of the trip, following the story');
      this.el.append(this.canvas, attr);
    } else this.el.append(this.canvas, controls, attr, this.hint);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    if (!o.inset) this.bindPointer();
  }

  private button(text: string, label: string, fn: () => void) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', fn);
    return b;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
  }

  setPins(pins: MapPin[]) {
    const changed = JSON.stringify(pins.map((p) => [p.id, p.lat, p.lng])) !== JSON.stringify(this.pins.map((p) => [p.id, p.lat, p.lng]));
    this.pins = pins;
    if (this.o.inset) {
      if (changed) this.focus(this.focusTarget, false);
      else this.redraw();
    } else if (changed && !this.userMoved) this.fit();
    else this.redraw();
  }

  /** Inset: pins with an index below this are visited; this one is current; the route beyond it is dashed. */
  setProgress(index: number) {
    if (index === this.progressIndex) return;
    this.progressIndex = index;
    this.redraw();
  }

  /** Inset: show the whole trip or one chapter, flying there smoothly when `animate` is set. */
  focus(target: MapFocus, animate: boolean) {
    this.focusTarget = target;
    if (!this.w || !this.h) return;
    const to = this.viewFor(target);
    if (!to) return;
    const from = { z: this.z, nx: this.cx / 2 ** this.z, ny: this.cy / 2 ** this.z };
    const same = Math.abs(from.z - to.z) < 0.01 && Math.hypot(from.nx - to.nx, from.ny - to.ny) * 2 ** to.z < 1;
    if (same) return this.redraw();
    if (!animate) {
      this.flight = null;
      this.apply(to);
      return this.redraw();
    }
    const travel = Math.hypot(from.nx - to.nx, from.ny - to.ny) * 2 ** Math.max(from.z, to.z);
    this.flight = { from, to, t0: performance.now(), ms: Math.min(1600, 600 + travel / 2 + Math.abs(from.z - to.z) * 120) };
    this.redraw();
  }

  get focused(): MapFocus {
    return this.focusTarget;
  }

  private apply(v: { z: number; nx: number; ny: number }) {
    this.z = v.z;
    this.cx = v.nx * 2 ** v.z;
    this.cy = v.ny * 2 ** v.z;
  }

  /** Zoom and centre (normalised to zoom 0) for a focus target, or undefined when there is nothing to show. */
  private viewFor(target: MapFocus): { z: number; nx: number; ny: number } | undefined {
    const pad = this.o.inset ? 18 : 40;
    const fitAll = (pins: MapPin[], maxZ: number) => {
      let z = maxZ;
      for (; z > 0; z--) {
        const pts = pins.map((p) => project(p.lat, p.lng, z));
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        if (Math.max(...xs) - Math.min(...xs) <= this.w - 2 * pad && Math.max(...ys) - Math.min(...ys) <= this.h - 2 * pad) break;
      }
      const pts = pins.map((p) => project(p.lat, p.lng, 0));
      return { z, nx: (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2, ny: (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2 };
    };
    if (!this.pins.length) return { z: 1, nx: project(25, 0, 0).x, ny: project(25, 0, 0).y };
    const i = target.kind === 'chapter' ? this.pins.findIndex((p) => p.id === target.id) : -1;
    if (i < 0) return fitAll(this.pins, this.pins.length === 1 ? 9 : 12);
    // Chapter view: centred on the chapter, zoomed so the chapters either side stay in view for context,
    // but always at least two levels closer than the whole-trip view (a far neighbour is then off the edge,
    // with the route pointing to it), and no closer than city scale.
    const c = this.pins[i];
    const near = [this.pins[i - 1], this.pins[i + 1]].filter(Boolean) as MapPin[];
    const trip = fitAll(this.pins, this.pins.length === 1 ? 9 : 12).z;
    let z = 10;
    for (; z > 1; z--) {
      const cc = project(c.lat, c.lng, z);
      if (near.every((p) => { const q = project(p.lat, p.lng, z); return Math.abs(q.x - cc.x) <= this.w / 2 - pad && Math.abs(q.y - cc.y) <= this.h / 2 - pad; })) break;
    }
    z = Math.min(10, Math.max(z, trip + 2));
    const c0 = project(c.lat, c.lng, 0);
    return { z, nx: c0.x, ny: c0.y };
  }

  setSelected(id: string | null) {
    this.selected = id;
    this.redraw();
  }

  setPickMode(on: boolean, label = 'Click the map to place the pin') {
    this.picking = on;
    this.el.classList.toggle('picking', on);
    this.hint.hidden = !on;
    this.hint.textContent = label;
  }

  get pickMode(): boolean {
    return this.picking;
  }

  /** Screen position of a pin relative to the map element (tests and accessibility helpers). */
  screenPos(id: string): { x: number; y: number } | undefined {
    const p = this.pins.find((q) => q.id === id);
    if (!p) return undefined;
    const w = project(p.lat, p.lng, this.z);
    return { x: w.x - this.cx + this.w / 2, y: w.y - this.cy + this.h / 2 };
  }

  get view() {
    return { zoom: this.z, center: unproject(this.cx, this.cy, this.z) };
  }

  fit() {
    if (!this.w || !this.h) return;
    if (!this.pins.length) {
      this.z = this.w > 700 ? 2 : 1;
      const c = project(25, 0, this.z);
      [this.cx, this.cy] = [c.x, c.y];
      return this.redraw();
    }
    let z = 13;
    for (; z > 1; z--) {
      const pts = this.pins.map((p) => project(p.lat, p.lng, z));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      if (Math.max(...xs) - Math.min(...xs) <= this.w - 80 && Math.max(...ys) - Math.min(...ys) <= this.h - 80) break;
    }
    if (this.pins.length === 1) z = Math.min(z, 10);
    this.z = z;
    const pts = this.pins.map((p) => project(p.lat, p.lng, z));
    this.cx = (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2;
    this.cy = (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2;
    this.redraw();
  }

  private zoomBy(d: number, ax = this.w / 2, ay = this.h / 2) {
    const nz = Math.max(1, Math.min(18, this.z + d));
    if (nz === this.z) return;
    const f = 2 ** (nz - this.z);
    // Keep the point under the cursor fixed.
    const wx = this.cx + ax - this.w / 2;
    const wy = this.cy + ay - this.h / 2;
    this.cx = wx * f - (ax - this.w / 2);
    this.cy = wy * f - (ay - this.h / 2);
    this.z = nz;
    this.userMoved = true;
    this.redraw();
  }

  private resize() {
    // Size from the content box (inside the border). The canvas is positioned absolutely, so it can never stretch
    // its container: sizing it from the outer box made the inset grow without limit in some browsers.
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.w = Math.max(1, Math.min(MAX_CANVAS_PX, this.el.clientWidth));
    this.h = Math.max(1, Math.min(MAX_CANVAS_PX, this.el.clientHeight));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    if (this.o.inset) this.focus(this.focusTarget, false);
    else if (!this.userMoved) this.fit();
    else this.redraw();
  }

  private bindPointer() {
    let down: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      down = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false };
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) down.moved = true;
      if (down.moved) {
        this.cx = down.cx - dx;
        this.cy = down.cy - dy;
        this.userMoved = true;
        this.redraw();
      }
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || d.moved) return;
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (this.picking) {
        const ll = unproject(this.cx + x - this.w / 2, this.cy + y - this.h / 2, this.z);
        this.o.onPick?.(Math.round(ll.lat * 1e5) / 1e5, Math.round(ll.lng * 1e5) / 1e5);
        return;
      }
      const hit = this.pins.map((p) => ({ p, s: this.screenPos(p.id)! })).filter(({ s }) => Math.hypot(s.x - x, s.y - y) <= 14).pop();
      if (hit) this.o.onSelect?.(hit.p.id);
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      this.zoomBy(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }

  redraw() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.draw());
  }

  private tile(z: number, x: number, y: number) {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t && this.o.tileUrl) {
      const img = new Image();
      t = { img, ok: false, failed: false };
      const entry = t;
      img.onload = () => { entry.ok = true; this.redraw(); };
      img.onerror = () => { entry.failed = true; };
      img.src = this.o.tileUrl(z, x, y);
      this.tiles.set(key, t);
      if (this.tiles.size > 400) this.tiles.delete(this.tiles.keys().next().value!);
    }
    return t;
  }

  private draw() {
    // Hidden (e.g. the Play view is showing): fetch no tiles. The resize observer redraws when it is shown again.
    if (!this.el.isConnected || this.el.getClientRects().length === 0) return;
    if (this.flight) {
      const f = this.flight;
      const k = Math.min(1, (performance.now() - f.t0) / f.ms);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      this.apply({ z: f.from.z + (f.to.z - f.from.z) * e, nx: f.from.nx + (f.to.nx - f.from.nx) * e, ny: f.from.ny + (f.to.ny - f.from.ny) * e });
      if (k >= 1) this.flight = null;
      else this.redraw();
    }
    const { ctx, w, h, z } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#1b2230';
    ctx.fillRect(0, 0, w, h);
    // Fractional zoom (during inset flights): draw the nearest whole-zoom tiles, scaled.
    const tz = Math.max(0, Math.min(18, Math.round(z)));
    const ts = TILE * 2 ** (z - tz);
    const n = 2 ** tz;
    const left = this.cx - w / 2;
    const top = this.cy - h / 2;
    if (this.o.tileUrl) {
      for (let ty = Math.floor(top / ts); ty <= Math.floor((top + h) / ts); ty++) {
        if (ty < 0 || ty >= n) continue;
        for (let tx = Math.floor(left / ts); tx <= Math.floor((left + w) / ts); tx++) {
          const t = this.tile(tz, ((tx % n) + n) % n, ty);
          if (t?.ok) ctx.drawImage(t.img, Math.round(tx * ts - left), Math.round(ty * ts - top), Math.ceil(ts), Math.ceil(ts));
        }
      }
      // Dim the tiles so pins stand out in the dark theme.
      ctx.fillStyle = 'rgba(13,15,19,0.25)';
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      for (let gx = -((left % 64) + 64) % 64; gx < w; gx += 64) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
      for (let gy = -((top % 64) + 64) % 64; gy < h; gy += 64) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }
    }
    const pts = this.pins.map((p) => ({ p, s: this.screenPos(p.id)! }));
    const inset = !!this.o.inset;
    const prog = inset ? this.progressIndex : Infinity;
    if (pts.length > 1) {
      ctx.lineWidth = inset ? 2.5 : 3;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      // Travelled legs solid, legs still ahead dashed (inset); the editor map draws the whole route solid.
      for (let i = 1; i < pts.length; i++) {
        const ahead = pts[i].p.index > prog;
        ctx.strokeStyle = ahead ? 'rgba(79,156,247,0.55)' : 'rgba(79,156,247,0.95)';
        ctx.setLineDash(ahead ? [5, 5] : []);
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].s.x, pts[i - 1].s.y);
        ctx.lineTo(pts[i].s.x, pts[i].s.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    // The selected pin is drawn last so a chapter at the same place cannot hide it.
    const order = [...pts.filter((q) => q.p.id !== this.selected), ...pts.filter((q) => q.p.id === this.selected)];
    for (const { p, s } of order) {
      const sel = p.id === this.selected;
      const visited = p.index < prog;
      const r = inset ? (sel ? 11 : 8) : sel ? 14 : 11;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = sel ? '#ffffff' : visited ? '#2b5a91' : '#4f9cf7';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = sel ? '#4f9cf7' : '#0d0f13';
      ctx.stroke();
      ctx.fillStyle = sel ? '#0d0f13' : visited ? '#c9d6e8' : '#ffffff';
      ctx.font = `600 ${inset ? (sel ? 11 : 9) : 12}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.index + 1), s.x, s.y + 0.5);
    }
  }
}
