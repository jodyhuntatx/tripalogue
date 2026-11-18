/**
 * Server configuration, from environment variables or explicit options.
 *
 *   TRIPALOGUE_DATA_DIR     database, media storage and upload temp files (default ./data)
 *   PORT                    listen port (default 5173); the app listens on this computer only (127.0.0.1)
 *   TRIPALOGUE_SECRET       HMAC key for signed media links; generated into <data>/secret if unset
 *   TRIPALOGUE_MAX_UPLOAD_BYTES  per-file limit (default 10 GB)
 *   TRIPALOGUE_TELEMETRY_DIR     enable the opt-in telemetry endpoint, writing JSON lines here
 *   TRIPALOGUE_GEOCODER_URL / TRIPALOGUE_TILE_URL / TRIPALOGUE_TILE_ATTRIBUTION   place search and map tiles (default OpenStreetMap)
 *   TRIPALOGUE_CONTACT_EMAIL     contact address sent to the map providers in the User-Agent, as their policies ask
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { geoConfigFromEnv, type GeoConfig } from './geo.js';

export interface ServerConfig {
  dataDir: string;
  port: number;
  host: string;
  baseUrl: string;
  secret: string;
  maxUploadBytes: number;
  chunkBytes: number;
  telemetryDir?: string;
  /** Run the media worker inside the web process (default true). */
  runWorker: boolean;
  /** Static web client folder (dist/web). */
  webDir?: string;
  ffmpeg: string;
  ffprobe: string;
  /** Days an item stays in the Removed bin before it is deleted for good (TRIPALOGUE_PURGE_AFTER_DAYS). */
  purgeAfterDays: number;
  /** HEIC converter: auto (default), off, or a tool name (see heic.ts). */
  heicConverter: string;
  geo: GeoConfig;
  log: (msg: string) => void;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const env = process.env;
  const dataDir = path.resolve(overrides.dataDir ?? env.TRIPALOGUE_DATA_DIR ?? 'data');
  mkdirSync(dataDir, { recursive: true });
  const port = overrides.port ?? Number(env.PORT ?? 5173);
  // This computer only: a single-user app with no sign-in must not be reachable from the network.
  const host = overrides.host ?? '127.0.0.1';
  let secret = overrides.secret ?? env.TRIPALOGUE_SECRET;
  if (!secret) {
    const f = path.join(dataDir, 'secret');
    if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = readFileSync(f, 'utf8').trim();
  }
  return {
    dataDir,
    port,
    host,
    baseUrl: (overrides.baseUrl ?? `http://${host}:${port}`).replace(/\/+$/, ''),
    secret,
    maxUploadBytes: overrides.maxUploadBytes ?? Number(env.TRIPALOGUE_MAX_UPLOAD_BYTES ?? 10 * 1024 ** 3),
    chunkBytes: overrides.chunkBytes ?? 8 * 1024 * 1024,
    telemetryDir: overrides.telemetryDir ?? env.TRIPALOGUE_TELEMETRY_DIR,
    runWorker: overrides.runWorker ?? true,
    webDir: overrides.webDir,
    ffmpeg: overrides.ffmpeg ?? 'ffmpeg',
    ffprobe: overrides.ffprobe ?? 'ffprobe',
    heicConverter: overrides.heicConverter ?? env.TRIPALOGUE_HEIC_CONVERTER ?? 'auto',
    purgeAfterDays: overrides.purgeAfterDays ?? Math.max(1, Number(env.TRIPALOGUE_PURGE_AFTER_DAYS ?? 30) || 30),
    geo: overrides.geo ?? geoConfigFromEnv(dataDir),
    log: overrides.log ?? ((m) => console.error(m)),
  };
}
