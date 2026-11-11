/**
 * Route map (MV-1): chapters as numbered pins joined in order by a route line,
 * on web-mercator tiles served through the TripAlogue server. Drag to pan,
 * scroll or use the buttons to zoom, click a pin to select its chapter, and in
 * pick mode click anywhere to drop a pin. Works without tiles (offline or no
 * provider): pins and route still draw on a plain background.
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
}

const TILE = 256;
const MAX_LAT = 85.05112878;

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

  constructor(private readonly o: RouteMapOptions) {
    this.el = document.createElement('div');
    this.el.className = 'route-map';
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
    this.el.append(this.canvas, controls, attr, this.hint);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.bindPointer();
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
    if (changed && !this.userMoved) this.fit();
    else this.redraw();
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
    const r = this.el.getBoundingClientRect();
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    if (!this.userMoved) this.fit();
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
    const { ctx, w, h, z } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#1b2230';
    ctx.fillRect(0, 0, w, h);
    const n = 2 ** z;
    const left = this.cx - w / 2;
    const top = this.cy - h / 2;
    if (this.o.tileUrl) {
      for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
          const t = this.tile(z, ((tx % n) + n) % n, ty);
          if (t?.ok) ctx.drawImage(t.img, Math.round(tx * TILE - left), Math.round(ty * TILE - top), TILE, TILE);
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
    if (pts.length > 1) {
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(79,156,247,0.9)';
      ctx.setLineDash([]);
      ctx.beginPath();
      pts.forEach(({ s }, i) => (i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y)));
      ctx.stroke();
    }
    for (const { p, s } of pts) {
      const sel = p.id === this.selected;
      ctx.beginPath();
      ctx.arc(s.x, s.y, sel ? 14 : 11, 0, Math.PI * 2);
      ctx.fillStyle = sel ? '#ffffff' : '#4f9cf7';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = sel ? '#4f9cf7' : '#0d0f13';
      ctx.stroke();
      ctx.fillStyle = sel ? '#0d0f13' : '#ffffff';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.index + 1), s.x, s.y + 0.5);
    }
  }
}
