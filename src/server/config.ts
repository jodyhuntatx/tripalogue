/**
 * Server configuration, from environment variables or explicit options.
 *
 *   TRIPALOGUE_DATA_DIR     database, blob storage, upload temp files, outbox (default ./data)
 *   TRIPALOGUE_BASE_URL     public URL, used in sign-in links and cookie flags (default http://127.0.0.1:<port>)
 *   PORT                    listen port (default 5173)
 *   TRIPALOGUE_SECRET       HMAC key for signed media links; generated into <data>/secret if unset
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   enable "Sign in with Google"
 *   TRIPALOGUE_MAX_UPLOAD_BYTES  per-file limit (default 10 GB)
 *   TRIPALOGUE_TELEMETRY_DIR     enable the opt-in telemetry endpoint, writing JSON lines here
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Overridable for tests. */
  authUrl?: string;
  tokenUrl?: string;
  /** Expected ID-token issuer; defaults to Google's. */
  issuer?: string;
}

export interface ServerConfig {
  dataDir: string;
  port: number;
  host: string;
  baseUrl: string;
  secret: string;
  maxUploadBytes: number;
  chunkBytes: number;
  google?: GoogleConfig;
  telemetryDir?: string;
  /** Run the media worker inside the web process (default true). */
  runWorker: boolean;
  /** Static web client folder (dist/web). */
  webDir?: string;
  ffmpeg: string;
  ffprobe: string;
  sessionDays: number;
  log: (msg: string) => void;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const env = process.env;
  const dataDir = path.resolve(overrides.dataDir ?? env.TRIPALOGUE_DATA_DIR ?? 'data');
  mkdirSync(dataDir, { recursive: true });
  const port = overrides.port ?? Number(env.PORT ?? 5173);
  const host = overrides.host ?? env.HOST ?? '127.0.0.1';
  let secret = overrides.secret ?? env.TRIPALOGUE_SECRET;
  if (!secret) {
    const f = path.join(dataDir, 'secret');
    if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = readFileSync(f, 'utf8').trim();
  }
  const google = overrides.google ?? (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : undefined);
  return {
    dataDir,
    port,
    host,
    baseUrl: (overrides.baseUrl ?? env.TRIPALOGUE_BASE_URL ?? `http://${host}:${port}`).replace(/\/+$/, ''),
    secret,
    maxUploadBytes: overrides.maxUploadBytes ?? Number(env.TRIPALOGUE_MAX_UPLOAD_BYTES ?? 10 * 1024 ** 3),
    chunkBytes: overrides.chunkBytes ?? 8 * 1024 * 1024,
    google,
    telemetryDir: overrides.telemetryDir ?? env.TRIPALOGUE_TELEMETRY_DIR,
    runWorker: overrides.runWorker ?? true,
    webDir: overrides.webDir,
    ffmpeg: overrides.ffmpeg ?? 'ffmpeg',
    ffprobe: overrides.ffprobe ?? 'ffprobe',
    sessionDays: overrides.sessionDays ?? 30,
    log: overrides.log ?? ((m) => console.error(m)),
  };
}
