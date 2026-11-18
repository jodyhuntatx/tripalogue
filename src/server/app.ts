/**
 * The TripAlogue local server: JSON API, signed media links, and the web client, for one person on this computer.
 *
 * It listens on 127.0.0.1 only and has no sign-in: every request acts as the local user. Two checks keep other web
 * pages in the same browser out: mutating API calls must carry the `X-TripAlogue-Client: 1` header (browsers cannot
 * add custom headers to cross-site requests without a CORS preflight, which this server never grants), and the
 * Host header must name this computer (which defeats DNS-rebinding pages).
 */
import { promises as fs, createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth } from './auth.js';
import { FsBlobStore, type BlobStore } from './blobstore.js';
import { loadConfig, type ServerConfig } from './config.js';
import { Db } from './db.js';
import { HttpError, readBody, readJson, requireString, Router, sendJson, type Ctx, type Req, type Res } from './http.js';
import { Geo } from './geo.js';
import { Jobs } from './media.js';
import { MediaTools } from './toolcheck.js';
import { Deletion } from './deletion.js';
import { Exports, MAX_EXPORT_REQUEST_BYTES } from './exports.js';
import { LOCK_TTL_MS, Projects, type Role } from './projects.js';
import { Uploads } from './uploads.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
};

export interface App {
  cfg: ServerConfig;
  db: Db;
  auth: Auth;
  projects: Projects;
  uploads: Uploads;
  jobs: Jobs;
  exports: Exports;
  blobs: BlobStore;
  deletion: Deletion;
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

export function defaultWebDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'dist', 'web');
}

export async function startApp(overrides: Partial<ServerConfig> = {}, deps: { blobs?: BlobStore } = {}): Promise<App> {
  const cfg = loadConfig(overrides);
  const db = Db.open(cfg.dataDir);
  const blobs = deps.blobs ?? new FsBlobStore(path.join(cfg.dataDir, 'blobs'));
  const auth = new Auth(db, cfg);
  const projects = new Projects(db);
  const jobs = new Jobs(db, cfg, blobs, projects);
  const tools = new MediaTools(cfg); // reads cfg.ffmpeg / cfg.ffprobe / cfg.log at each check
  const uploads = new Uploads(db, cfg, blobs, projects, jobs);
  const exports = new Exports(db, cfg, blobs, projects, {
    serverUrl: () => cfg.baseUrl,
    // VX-8: tiles for exports go through the same cache as the preview's.
    tiles: { tile: (z, x, y, style, lang) => geo.tile(z, x, y, style, lang), attribution: cfg.geo.attribution, enabled: !!cfg.geo.tileUrl },
  });
  const deletion = new Deletion(db, blobs, projects, uploads, { purgeAfterDays: cfg.purgeAfterDays, log: cfg.log, exports });
  const geo = new Geo(cfg.geo);
  const webDir = cfg.webDir ?? defaultWebDir();
  const r = new Router();

  const me = (_c: Ctx) => auth.user;
  const member = (c: Ctx, min: Role) => {
    const user = me(c);
    return { user, role: projects.require(c.params.id, user, min) };
  };

  r.on('GET', '/api/me', (c) => sendJson(c.res, 200, { user: me(c) }));
  r.on('GET', '/api/config', async (c) => sendJson(c.res, 200, {
    telemetryEndpoint: cfg.telemetryDir ? '/api/telemetry' : null, chunkBytes: cfg.chunkBytes, maxUploadBytes: cfg.maxUploadBytes,
    map: { tiles: !!cfg.geo.tileUrl, search: !!cfg.geo.geocoderUrl, attribution: cfg.geo.attribution },
    media: await mediaStatus(),
    purgeAfterDays: cfg.purgeAfterDays,
  }));
  // The media tools' state, checked again on request (after installing ffmpeg, say) and before every retry.
  const mediaStatus = async (fresh = false) => {
    const t = await (fresh ? tools.recheck() : tools.status());
    return { ok: t.ok, problems: t.problems, heic: await jobs.heic.available() };
  };
  r.on('GET', '/api/media-tools', async (c) => {
    me(c);
    sendJson(c.res, 200, await mediaStatus(c.url.searchParams.get('recheck') === '1'));
  });

  // ---- places and map tiles (through this server, which adds the policy-required User-Agent and a cache) ----
  r.on('GET', '/api/geo/search', async (c) => {
    me(c);
    sendJson(c.res, 200, { places: await geo.search(c.url.searchParams.get('q') ?? '', c.url.searchParams.get('lang') ?? undefined) });
  });
  const sendTile = async (c: { res: import('node:http').ServerResponse; url: URL }, z: string, x: string, y: string, style?: string) => {
    const buf = await geo.tile(z, x, y, style, c.url.searchParams.get('lang') ?? '');
    c.res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' });
    c.res.end(buf);
  };
  r.on('GET', '/api/tiles/:z/:x/:y', async (c) => {
    me(c);
    await sendTile(c, c.params.z, c.params.x, c.params.y);
  });
  // MV-8: by style (terrain has its own tiles; light and dark share the standard ones).
  r.on('GET', '/api/tiles/:style/:z/:x/:y', async (c) => {
    me(c);
    await sendTile(c, c.params.z, c.params.x, c.params.y, c.params.style);
  });

  // ---- projects ----
  r.on('GET', '/api/projects', (c) => sendJson(c.res, 200, { projects: projects.list(me(c)) }));
  r.on('POST', '/api/projects', async (c) => {
    const b = await readJson(c.req);
    const p = projects.create(me(c), requireString(b.title, 'title', 200));
    sendJson(c.res, 201, { id: p.id });
  });
  r.on('POST', '/api/projects/import', async (c) => {
    const user = me(c);
    const text = (await readBody(c.req, 20 * 1024 * 1024)).toString('utf8');
    const out = projects.import(user, text);
    sendJson(c.res, 201, { id: out.project.id, pending: out.pending });
  });
  r.on('GET', '/api/projects/:id', (c) => {
    const { user, role } = member(c, 'viewer');
    const { doc, rev } = projects.load(c.params.id);
    sendJson(c.res, 200, { project: doc, rev, role, me: user, lock: projects.lockInfo(c.params.id) ?? null, pendingJobs: jobs.pending(c.params.id) });
  });
  r.on('GET', '/api/projects/:id/export', (c) => {
    member(c, 'editor');
    const text = projects.exportText(c.params.id);
    const name = `${projects.load(c.params.id).doc.title.replace(/[^\w\- ]+/g, '').trim() || 'travelogue'}.travelogue.json`;
    c.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
    c.res.end(text);
  });
  r.on('POST', '/api/projects/:id/ops', async (c) => {
    const { user } = member(c, 'editor');
    projects.requireLock(c.params.id, user);
    const b = await readJson(c.req, 10 * 1024 * 1024);
    const out = projects.commit(c.params.id, user.id, 'client', typeof b.label === 'string' ? b.label : 'Edit', b.ops, Number(b.baseRev));
    sendJson(c.res, 200, out);
  });
  r.on('GET', '/api/projects/:id/ops', (c) => {
    member(c, 'viewer');
    const since = Number(c.url.searchParams.get('since') ?? 0);
    const { rev } = projects.load(c.params.id);
    sendJson(c.res, 200, { rev, ops: projects.opsSince(c.params.id, since), lock: projects.lockInfo(c.params.id) ?? null, pendingJobs: jobs.pending(c.params.id) });
  });

  // ---- edit lock ----
  r.on('POST', '/api/projects/:id/lock', (c) => {
    const { user } = member(c, 'editor');
    const lock = projects.acquireLock(c.params.id, user);
    sendJson(c.res, lock.userId === user.id ? 200 : 423, { lock, ttlMs: LOCK_TTL_MS });
  });
  r.on('DELETE', '/api/projects/:id/lock', (c) => {
    const { user } = member(c, 'viewer');
    projects.releaseLock(c.params.id, user);
    sendJson(c.res, 200, { ok: true });
  });

  // ---- versions ----
  r.on('GET', '/api/projects/:id/versions', (c) => {
    member(c, 'viewer');
    sendJson(c.res, 200, { versions: projects.versions(c.params.id) });
  });
  r.on('POST', '/api/projects/:id/versions', async (c) => {
    const { user } = member(c, 'editor');
    const b = await readJson(c.req);
    const { rev } = projects.load(c.params.id);
    sendJson(c.res, 201, { id: projects.snapshot(c.params.id, rev, user.id, requireString(b.label, 'label', 200), false) });
  });
  r.on('POST', '/api/projects/:id/versions/:vid/restore', (c) => {
    const { user } = member(c, 'editor');
    projects.requireLock(c.params.id, user);
    sendJson(c.res, 200, { rev: projects.restore(c.params.id, c.params.vid, user) });
  });

  // ---- uploads ----
  r.on('POST', '/api/projects/:id/uploads', async (c) => {
    const { user } = member(c, 'contributor');
    sendJson(c.res, 201, await uploads.create(c.params.id, user, await readJson(c.req)));
  });
  r.on('POST', '/api/projects/:id/uploads/check', async (c) => {
    member(c, 'contributor');
    const body = (await readJson(c.req)) as { files?: unknown };
    sendJson(c.res, 200, await uploads.check(c.params.id, body.files));
  });
  r.on('GET', '/api/uploads/:uid', (c) => sendJson(c.res, 200, uploads.status(c.params.uid, me(c))));
  r.on('PUT', '/api/uploads/:uid', async (c) => {
    const user = me(c);
    sendJson(c.res, 200, await uploads.putChunk(c.params.uid, user, Number(c.url.searchParams.get('offset')), c.req));
  });

  // ---- processing again after a failure (the stored original is reused) ----
  // ---- deleting for good (items already in the Removed bin; the remove itself is an ordinary, undoable edit) ----
  r.on('POST', '/api/projects/:id/media/purge', async (c) => {
    const { user } = member(c, 'editor');
    const body = (await readJson(c.req)) as { mediaIds?: unknown };
    if (!Array.isArray(body.mediaIds) || !body.mediaIds.every((x) => typeof x === 'string')) throw new HttpError(400, 'mediaIds must be a list of ids', 'invalid');
    sendJson(c.res, 200, { deleted: await deletion.purge(c.params.id, body.mediaIds as string[], user.id) });
  });
  r.on('DELETE', '/api/projects/:id', async (c) => {
    member(c, 'owner');
    const body = (await readJson(c.req)) as { confirmTitle?: unknown };
    await deletion.deleteProject(c.params.id, body.confirmTitle);
    sendJson(c.res, 200, { deleted: true });
  });

  r.on('POST', '/api/projects/:id/media/retry', async (c) => {
    const { user } = member(c, 'contributor');
    const body = (await readJson(c.req)) as { mediaIds?: unknown };
    const ids = Array.isArray(body.mediaIds) ? body.mediaIds.filter((x): x is string => typeof x === 'string') : undefined;
    const status = await mediaStatus(true);
    sendJson(c.res, 200, { queued: jobs.retry(c.params.id, user.id, ids), media: status });
  });

  // ---- media: member-only, answered with a short-lived signed link ----
  r.on('GET', '/api/projects/:id/media/:mid/:variant', (c) => {
    member(c, 'viewer');
    const item = projects.load(c.params.id).doc.media.find((m) => m.id === c.params.mid);
    if (!item) throw new HttpError(404, 'Media not found', 'not_found');
    const v = c.params.variant;
    const key = v === 'original' ? item.storageKey : v === 'thumb' ? item.assets?.thumb : v === 'proxy' ? item.assets?.proxy ?? item.storageKey
      : v === 'jpeg' ? item.assets?.jpeg : undefined;
    if (!key) throw new HttpError(404, item.status && item.status !== 'ready' ? `Not ready yet (${item.status})` : 'No such file', 'not_ready');
    redirect(c.res, auth.signBlobUrl(key), 302, 'private, max-age=300');
  });

  // ---- MP4 exports (Phase 4): rendered in the background from the originals ----
  r.on('GET', '/api/renders/unseen', (c) => sendJson(c.res, 200, { renders: exports.unseen() }));
  r.on('GET', '/api/projects/:id/renders', (c) => {
    member(c, 'viewer');
    sendJson(c.res, 200, { renders: exports.list(c.params.id) });
  });
  r.on('POST', '/api/projects/:id/renders', async (c) => {
    member(c, 'editor');
    const body = (await readJson(c.req, MAX_EXPORT_REQUEST_BYTES)) as { settings?: unknown };
    sendJson(c.res, 201, { render: await exports.create(c.params.id, body.settings) });
  });
  r.on('POST', '/api/projects/:id/renders/:rid/cancel', (c) => {
    member(c, 'editor');
    sendJson(c.res, 200, { render: exports.cancel(c.params.id, c.params.rid) });
  });
  r.on('POST', '/api/projects/:id/renders/:rid/seen', (c) => {
    member(c, 'viewer');
    sendJson(c.res, 200, { render: exports.markSeen(c.params.id, c.params.rid) });
  });
  r.on('DELETE', '/api/projects/:id/renders/:rid', async (c) => {
    member(c, 'editor');
    await exports.remove(c.params.id, c.params.rid);
    sendJson(c.res, 200, { deleted: true });
  });
  r.on('GET', '/api/projects/:id/renders/:rid/file', async (c) => {
    member(c, 'viewer');
    const f = await exports.file(c.params.id, c.params.rid);
    exports.markSeen(c.params.id, c.params.rid);
    const inline = c.url.searchParams.get('inline') === '1';
    const disposition = `${inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(f.name)}`;
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Disposition': disposition, 'Cache-Control': 'no-store' };
    const m = c.req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(c.req.headers.range);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : f.size - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : f.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, f.size - 1);
      if (start > end) return void c.res.writeHead(416, { 'Content-Range': `bytes */${f.size}` }).end();
      c.res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${f.size}` });
      if (c.req.method === 'HEAD') return void c.res.end();
      return void createReadStream(f.path, { start, end }).pipe(c.res);
    }
    c.res.writeHead(200, { ...headers, 'Content-Length': f.size });
    if (c.req.method === 'HEAD') return void c.res.end();
    createReadStream(f.path).pipe(c.res);
  });

  // ---- the export page (server/render.ts): a headless browser here draws frames with the preview's code ----
  const renderer = exports.renderer;
  const renderCall = async (c: { res: import('node:http').ServerResponse }, fn: () => Promise<void> | void) => {
    try {
      await fn();
    } catch (e) {
      const err = e as Error & { itemId?: string };
      if (!c.res.headersSent) sendJson(c.res, 410, { error: err.message, itemId: err.itemId });
    }
  };
  r.on('GET', '/api/render/:token/setup', (c) => renderCall(c, () => sendJson(c.res, 200, renderer.setupFor(c.params.token))));
  r.on('GET', '/api/render/:token/image/:item', (c) => renderCall(c, async () => {
    const file = renderer.pictureFor(c.params.token, c.params.item);
    const st = await fs.stat(file);
    c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(c.res);
  }));
  r.on('GET', '/api/render/:token/video/:item', (c) => renderCall(c, async () => {
    const q = c.url.searchParams;
    const f = await renderer.videoFrame(c.params.token, Number(q.get('chunk')), c.params.item, Number(q.get('t')), Number(q.get('speed') || 1));
    c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.data.length, 'X-Width': String(f.w), 'X-Height': String(f.h), 'Cache-Control': 'no-store' });
    c.res.end(f.data);
  }));
  r.on('POST', '/api/render/:token/frame', (c) => renderCall(c, async () => {
    const q = c.url.searchParams;
    await renderer.acceptFrame(c.params.token, Number(q.get('chunk')), Number(q.get('k')), c.req);
    sendJson(c.res, 200, { ok: true });
  }));
  r.on('POST', '/api/render/:token/fail', (c) => renderCall(c, async () => {
    const body = (await readJson(c.req, 16 * 1024)) as { chunk?: number; message?: string; itemId?: string; reason?: string };
    renderer.pageFailed(c.params.token, Number(body.chunk), body);
    sendJson(c.res, 200, { ok: true });
  }));

  // ---- telemetry (opt-in) ----
  r.on('POST', '/api/telemetry', async (c) => {
    if (!cfg.telemetryDir) throw new HttpError(404, 'Telemetry is off', 'not_found');
    const events = JSON.parse((await readBody(c.req, 1 << 20)).toString('utf8')) as { sessionId?: string }[];
    if (!Array.isArray(events)) throw new HttpError(400, 'Expected a list of events', 'invalid');
    const sid = String(events[0]?.sessionId ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
    await fs.mkdir(cfg.telemetryDir, { recursive: true });
    await fs.appendFile(path.join(cfg.telemetryDir, `${sid}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    c.res.writeHead(204).end();
  });

  const server = http.createServer(async (rawReq, res) => {
    const req = rawReq as Req;
    // "//x" would parse as a host name (and "//" not at all): collapse leading slashes; refuse anything still unparseable.
    let url: URL;
    try {
      url = new URL((req.url ?? '/').replace(/^\/{2,}/, '/'), 'http://local');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      if (url.pathname.startsWith('/blob/')) return await serveBlob(req, res, url);
      if (url.pathname.startsWith('/api/')) {
        if (!localHost(req.headers.host)) throw new HttpError(403, 'TripAlogue only answers on this computer (localhost)', 'host');
        const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
        if (mutating && req.headers['x-tripalogue-client'] !== '1') throw new HttpError(403, 'Missing X-TripAlogue-Client header', 'csrf');
        const m = r.match(req.method, url.pathname);
        if (!m) throw new HttpError(404, 'Not found', 'not_found');
        return await m.handler({ req, res, url, params: m.params });
      }
      return await serveStatic(req, res, url.pathname);
    } catch (e) {
      const he = e instanceof HttpError ? e : new HttpError(500, 'Something went wrong on the server', 'server_error');
      if (!(e instanceof HttpError)) cfg.log(`error ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      if (res.headersSent) return void res.end();
      sendJson(res, he.status, { error: he.message, code: he.code });
    }
  });

  async function serveBlob(req: Req, res: Res, url: URL) {
    const key = decodeURIComponent(url.pathname.slice('/blob/'.length));
    if (!auth.verifyBlob(key, url.searchParams.get('exp'), url.searchParams.get('sig'))) throw new HttpError(403, 'This media link has expired', 'expired');
    const st = await blobs.stat(key);
    if (!st) throw new HttpError(404, 'Not found', 'not_found');
    const type = MIME[path.extname(key).toLowerCase()] ?? 'application/octet-stream';
    const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=600' };
    if (m) {
      let start = m[1] ? Number(m[1]) : NaN;
      let end = m[2] ? Number(m[2]) : st.size - 1;
      if (Number.isNaN(start)) { start = Math.max(0, st.size - end); end = st.size - 1; }
      if (start > end || start >= st.size) return void res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
      if (req.method === 'HEAD') return void res.end();
      return void blobs.read(key, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return void res.end();
    blobs.read(key).pipe(res);
  }

  async function serveStatic(req: Req, res: Res, pathname: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const abs = path.resolve(webDir, rel);
    if (!abs.startsWith(path.resolve(webDir) + path.sep)) throw new HttpError(403, 'Forbidden');
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    if (!st.isFile()) throw new HttpError(404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(abs).pipe(res);
  }

  await new Promise<void>((resolve) => server.listen(cfg.port, cfg.host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
  if (!overrides.baseUrl) cfg.baseUrl = `http://${cfg.host}:${port}`;
  void tools.status(); // check ffmpeg now, so problems are in the log at startup
  if (cfg.runWorker) {
    jobs.start();
    exports.start(); // queued or interrupted exports start again
    deletion.start(); // hourly: delete items whose time in the Removed bin is up
  }

  return {
    cfg, db, auth, projects, uploads, jobs, exports, blobs, server, deletion, url: `${cfg.baseUrl}/`,
    async close() {
      deletion.stop();
      await exports.stop();
      jobs.stop();
      await jobs.idle();
      await new Promise<void>((r2) => { server.closeAllConnections?.(); server.close(() => r2()); });
      db.close();
    },
  };
}

function redirect(res: Res, location: string, status = 302, cacheControl = 'no-store') {
  res.writeHead(status, { Location: location, 'Cache-Control': cacheControl }).end();
}

/** The Host header names this computer: localhost, 127.0.0.1 or [::1], with any port. */
export function localHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}
