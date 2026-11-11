/**
 * The TripAlogue web server: JSON API, signed media links, and the web client.
 *
 * Mutating API calls must carry the `X-TripAlogue-Client: 1` header. Browsers
 * cannot add custom headers to cross-site requests without a CORS preflight,
 * which this server never grants, so this blocks cross-site request forgery
 * on top of the SameSite session cookie.
 */
import { promises as fs, createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth, safeNext } from './auth.js';
import { FsBlobStore, type BlobStore } from './blobstore.js';
import { loadConfig, type ServerConfig } from './config.js';
import { Db } from './db.js';
import { HttpError, readBody, readJson, requireString, Router, sendJson, type Ctx, type Req, type Res } from './http.js';
import { OutboxMailer, type Mailer } from './mailer.js';
import { Jobs } from './media.js';
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
  blobs: BlobStore;
  mailer: Mailer;
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

export function defaultWebDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'dist', 'web');
}

export async function startApp(overrides: Partial<ServerConfig> = {}, deps: { mailer?: Mailer; blobs?: BlobStore } = {}): Promise<App> {
  const cfg = loadConfig(overrides);
  const db = Db.open(cfg.dataDir);
  const mailer = deps.mailer ?? new OutboxMailer(path.join(cfg.dataDir, 'outbox'), cfg.log);
  const blobs = deps.blobs ?? new FsBlobStore(path.join(cfg.dataDir, 'blobs'));
  const auth = new Auth(db, cfg, mailer);
  const projects = new Projects(db, cfg, mailer, auth);
  const jobs = new Jobs(db, cfg, blobs, projects);
  const uploads = new Uploads(db, cfg, blobs, projects, jobs);
  const webDir = cfg.webDir ?? defaultWebDir();
  const r = new Router();

  const me = (c: Ctx) => auth.require(c.req);
  const member = (c: Ctx, min: Role) => {
    const user = me(c);
    return { user, role: projects.require(c.params.id, user, min) };
  };

  // ---- auth ----
  r.on('POST', '/api/auth/email', async (c) => {
    const b = await readJson(c.req);
    await auth.requestEmailLink(b.email, b.next);
    sendJson(c.res, 200, { sent: true });
  });
  r.on('GET', '/api/auth/verify', (c) => {
    const { user, next } = auth.verifyEmailLink(c.url.searchParams.get('token') ?? '');
    auth.createSession(c.res, user.id);
    redirect(c.res, next);
  });
  r.on('GET', '/api/auth/google/start', (c) => {
    const { url, cookie } = auth.googleStart(c.url.searchParams.get('next'));
    c.res.setHeader('Set-Cookie', cookie);
    redirect(c.res, url);
  });
  r.on('GET', '/api/auth/google/callback', async (c) => {
    const { user, next } = await auth.googleCallback(c.req, c.url);
    auth.createSession(c.res, user.id);
    redirect(c.res, next);
  });
  r.on('POST', '/api/auth/logout', (c) => {
    auth.logout(c.req, c.res);
    sendJson(c.res, 200, { ok: true });
  });
  r.on('GET', '/api/me', (c) => sendJson(c.res, 200, { user: auth.userFor(c.req) ?? null, google: auth.googleEnabled }));
  r.on('GET', '/api/config', (c) => sendJson(c.res, 200, { google: auth.googleEnabled, telemetryEndpoint: cfg.telemetryDir ? '/api/telemetry' : null, chunkBytes: cfg.chunkBytes, maxUploadBytes: cfg.maxUploadBytes }));

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

  // ---- members ----
  r.on('GET', '/api/projects/:id/members', (c) => {
    member(c, 'viewer');
    sendJson(c.res, 200, { members: projects.members(c.params.id) });
  });
  r.on('POST', '/api/projects/:id/invites', async (c) => {
    const { user } = member(c, 'owner');
    const b = await readJson(c.req);
    await projects.invite(c.params.id, user, b.email, b.role);
    sendJson(c.res, 201, { sent: true });
  });
  r.on('PATCH', '/api/projects/:id/members/:uid', async (c) => {
    member(c, 'owner');
    const b = await readJson(c.req);
    projects.setRole(c.params.id, c.params.uid, b.role);
    sendJson(c.res, 200, { ok: true });
  });
  r.on('DELETE', '/api/projects/:id/members/:uid', (c) => {
    member(c, 'owner');
    projects.removeMember(c.params.id, c.params.uid);
    sendJson(c.res, 200, { ok: true });
  });
  r.on('GET', '/api/invites/accept', (c) => {
    const user = auth.userFor(c.req);
    const t = c.url.searchParams.get('token') ?? '';
    if (!user) return redirect(c.res, `/?next=${encodeURIComponent(`/api/invites/accept?token=${t}`)}#/signin`);
    redirect(c.res, `/#/p/${encodeURIComponent(projects.acceptInvite(t, user))}`);
  });

  // ---- uploads ----
  r.on('POST', '/api/projects/:id/uploads', async (c) => {
    const { user } = member(c, 'contributor');
    sendJson(c.res, 201, await uploads.create(c.params.id, user, await readJson(c.req)));
  });
  r.on('GET', '/api/uploads/:uid', (c) => sendJson(c.res, 200, uploads.status(c.params.uid, me(c))));
  r.on('PUT', '/api/uploads/:uid', async (c) => {
    const user = me(c);
    sendJson(c.res, 200, await uploads.putChunk(c.params.uid, user, Number(c.url.searchParams.get('offset')), c.req));
  });

  // ---- media: member-only, answered with a short-lived signed link ----
  r.on('GET', '/api/projects/:id/media/:mid/:variant', (c) => {
    member(c, 'viewer');
    const item = projects.load(c.params.id).doc.media.find((m) => m.id === c.params.mid);
    if (!item) throw new HttpError(404, 'Media not found', 'not_found');
    const v = c.params.variant;
    const key = v === 'original' ? item.storageKey : v === 'thumb' ? item.assets?.thumb : v === 'proxy' ? item.assets?.proxy ?? item.storageKey : undefined;
    if (!key) throw new HttpError(404, item.status && item.status !== 'ready' ? `Not ready yet (${item.status})` : 'No such file', 'not_ready');
    redirect(c.res, auth.signBlobUrl(key), 302, 'private, max-age=300');
  });

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
    const url = new URL(req.url ?? '/', 'http://local');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      if (url.pathname.startsWith('/blob/')) return await serveBlob(req, res, url);
      if (url.pathname.startsWith('/api/')) {
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
      // Links people click in email or that Google redirects to land on a page, not on JSON.
      const browserLanding = url.pathname === '/api/auth/verify' || url.pathname.startsWith('/api/auth/google/') || url.pathname === '/api/invites/accept';
      if (browserLanding) return redirect(res, `/?error=${encodeURIComponent(he.message)}#/signin`);
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
  if (!overrides.baseUrl && !process.env.TRIPALOGUE_BASE_URL) cfg.baseUrl = `http://${cfg.host}:${port}`;
  if (cfg.runWorker) jobs.start();

  return {
    cfg, db, auth, projects, uploads, jobs, blobs, mailer, server, url: `${cfg.baseUrl}/`,
    async close() {
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

export { safeNext };
