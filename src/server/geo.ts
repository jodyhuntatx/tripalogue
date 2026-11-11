/**
 * Place search and map tiles for the itinerary editor (IT-8, MV-1).
 *
 * The browser never talks to a map provider directly: the server proxies,
 * identifies itself, caches and rate-limits, which is what the providers'
 * usage policies ask for and what keeps API keys (later) off the client.
 *
 * Defaults are OpenStreetMap's public services, which are fine for local
 * development and small usability tests but not for production traffic:
 *   - Nominatim search: at most one request per second, a real User-Agent,
 *     results cached, searches only on an explicit action (no autocomplete).
 *   - tile.openstreetmap.org: a real User-Agent, tiles cached locally,
 *     "© OpenStreetMap contributors" shown on the map.
 * Choosing a production provider is an open question in the PRD; set
 * TRIPALOGUE_GEOCODER_URL and TRIPALOGUE_TILE_URL to switch.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.js';

export interface GeoConfig {
  /** Nominatim-compatible search endpoint. Empty string disables search. */
  geocoderUrl: string;
  /** Tile URL template with {z}, {x}, {y}. Empty string disables tiles. */
  tileUrl: string;
  attribution: string;
  userAgent: string;
  /** Minimum spacing between upstream searches (Nominatim: 1 per second). */
  minSearchIntervalMs: number;
  tileMaxAgeMs: number;
  cacheDir: string;
}

export interface Place {
  name: string;
  displayName: string;
  lat: number;
  lng: number;
  kind?: string;
}

export function geoConfigFromEnv(dataDir: string, overrides: Partial<GeoConfig> = {}): GeoConfig {
  const env = process.env;
  const contact = env.TRIPALOGUE_CONTACT_EMAIL ? ` (${env.TRIPALOGUE_CONTACT_EMAIL})` : '';
  return {
    geocoderUrl: env.TRIPALOGUE_GEOCODER_URL ?? 'https://nominatim.openstreetmap.org/search',
    tileUrl: env.TRIPALOGUE_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: env.TRIPALOGUE_TILE_ATTRIBUTION ?? '© OpenStreetMap contributors',
    userAgent: `TripAlogue/0.1 (travelogue editor; development)${contact}`,
    minSearchIntervalMs: 1100,
    tileMaxAgeMs: 14 * 86400_000,
    cacheDir: path.join(dataDir, 'tiles'),
    ...overrides,
  };
}

export class Geo {
  private cache = new Map<string, { at: number; places: Place[] }>();
  private nextSlot = 0;
  private inflight = new Map<string, Promise<Buffer>>();

  constructor(readonly cfg: GeoConfig) {}

  /** Search for places by name. Cached for a week; queued to respect the provider's rate limit. */
  async search(qIn: string, lang?: string): Promise<Place[]> {
    const q = qIn.trim().replace(/\s+/g, ' ');
    if (!this.cfg.geocoderUrl) throw new HttpError(503, 'Place search is not configured', 'not_configured');
    if (q.length < 2 || q.length > 200) throw new HttpError(400, 'Type at least two characters to search', 'invalid');
    const key = `${(lang ?? '').toLowerCase()}|${q.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 7 * 86400_000) return hit.places;
    const wait = Math.max(0, this.nextSlot - Date.now());
    this.nextSlot = Math.max(Date.now(), this.nextSlot) + this.cfg.minSearchIntervalMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const u = new URL(this.cfg.geocoderUrl);
    u.search = new URLSearchParams({ q, format: 'jsonv2', limit: '6', addressdetails: '0' }).toString();
    let res: Response;
    try {
      res = await fetch(u, { headers: { 'User-Agent': this.cfg.userAgent, ...(lang ? { 'Accept-Language': lang } : {}) }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new HttpError(502, 'Place search is unreachable right now; try again, or drop a pin on the map', 'upstream');
    }
    if (!res.ok) throw new HttpError(502, `Place search failed (${res.status}); try again shortly`, 'upstream');
    const raw = (await res.json()) as { name?: string; display_name?: string; lat?: string; lon?: string; type?: string; category?: string }[];
    const places = (Array.isArray(raw) ? raw : []).flatMap((r) => {
      const lat = Number(r.lat);
      const lng = Number(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
      const displayName = String(r.display_name ?? r.name ?? '');
      return [{ name: String(r.name || displayName.split(',')[0]).trim(), displayName, lat, lng, kind: r.type ?? r.category }];
    });
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: Date.now(), places });
    return places;
  }

  /** A map tile, from the disk cache when fresh enough, else from the provider (stale copy if the provider fails). */
  async tile(zIn: string, xIn: string, yIn: string): Promise<Buffer> {
    if (!this.cfg.tileUrl) throw new HttpError(503, 'Map tiles are not configured', 'not_configured');
    const z = Number(zIn);
    const x = Number(xIn);
    const y = Number(yIn.replace(/\.png$/, ''));
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      throw new HttpError(400, 'Invalid tile coordinates', 'invalid');
    }
    const file = path.join(this.cfg.cacheDir, String(z), String(x), `${y}.png`);
    let stale: Buffer | undefined;
    try {
      const st = await fs.stat(file);
      const buf = await fs.readFile(file);
      if (Date.now() - st.mtimeMs < this.cfg.tileMaxAgeMs) return buf;
      stale = buf;
    } catch {
      /* not cached */
    }
    const key = `${z}/${x}/${y}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.fetchTile(z, x, y, file).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    try {
      return await p;
    } catch (e) {
      if (stale) return stale;
      throw e;
    }
  }

  private async fetchTile(z: number, x: number, y: number, file: string): Promise<Buffer> {
    const url = this.cfg.tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': this.cfg.userAgent }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new HttpError(502, 'Map tiles are unreachable', 'upstream');
    }
    if (!res.ok) throw new HttpError(502, `Map tile request failed (${res.status})`, 'upstream');
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
    return buf;
  }
}
