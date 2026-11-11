/**
 * Local preview server for the player shell.
 *
 * Serves only what the player needs: the player bundle, the project, each
 * media item by id (never arbitrary paths), cache proxies and thumbnails, and
 * an opt-in telemetry endpoint. Supports HTTP range requests so video seeking
 * works. Binds to 127.0.0.1 by default.
 */
import { createReadStream, promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProject } from '../core/project.js';
import type { Travelogue } from '../core/schema.js';
import { readManifest } from './cache.js';
import { resolveMediaPath } from './storage.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
};

export interface ServeOptions {
  projectFile: string;
  port?: number;
  host?: string;
  cacheRoot?: string;
  playerDir?: string;
  /** Directory for opt-in telemetry session logs (JSON lines). Absent = endpoint disabled. */
  telemetryDir?: string;
  log?: (msg: string) => void;
}

export function defaultPlayerDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Works from src/node (tsx) and dist/node (compiled): the bundle lives in dist/player.
  return path.resolve(here, '..', '..', 'dist', 'player');
}

async function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): Promise<void> {
  let st;
  try {
    st = await fs.stat(file);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404).end('Not found');
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let start = range[1] ? Number(range[1]) : NaN;
    let end = range[2] ? Number(range[2]) : st.size - 1;
    if (Number.isNaN(start)) {
      start = Math.max(0, st.size - end);
      end = st.size - 1;
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
      return;
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

export async function serve(o: ServeOptions): Promise<{ server: http.Server; url: string; close: () => Promise<void> }> {
  const playerDir = o.playerDir ?? defaultPlayerDir();
  const log = o.log ?? (() => {});
  const load = async (): Promise<Travelogue> => parseProject(await fs.readFile(o.projectFile, 'utf8')).project;
  await load(); // fail fast on a broken project

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = decodeURIComponent(url.pathname);
      if (req.method === 'POST' && p === '/api/telemetry') {
        if (!o.telemetryDir) return void res.writeHead(404).end();
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1 << 20) return void res.writeHead(413).end();
        }
        const events = JSON.parse(body) as { sessionId?: string }[];
        if (!Array.isArray(events)) return void res.writeHead(400).end();
        const sid = String(events[0]?.sessionId ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
        await fs.mkdir(o.telemetryDir, { recursive: true });
        await fs.appendFile(path.join(o.telemetryDir, `${sid}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
        return void res.writeHead(204).end();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();

      if (p === '/api/project') {
        const text = await fs.readFile(o.projectFile, 'utf8');
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
        return void res.end(text);
      }
      if (p === '/api/config') {
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        return void res.end(JSON.stringify({ telemetryEndpoint: o.telemetryDir ? '/api/telemetry' : null }));
      }
      if (p === '/api/cache-manifest') {
        const proj = await load();
        const m = o.cacheRoot ? await readManifest(o.cacheRoot, proj.id) : undefined;
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
        return void res.end(JSON.stringify(m ? { available: true, items: Object.fromEntries(Object.entries(m.entries).map(([id, e]) => [id, { thumb: !!e.thumb, proxy: !!e.proxy }])) } : { available: false, items: {} }));
      }
      let mm = /^\/api\/media\/([^/]+)$/.exec(p);
      if (mm) {
        const proj = await load();
        const item = proj.media.find((m) => m.id === mm![1]);
        const src = item && proj.sources.find((s) => s.id === item.sourceId);
        if (!item || !src || src.type !== 'localFolder') return void res.writeHead(404).end('Not found');
        return void (await sendFile(req, res, resolveMediaPath(o.projectFile, src.rootPath, item.uri)));
      }
      mm = /^\/api\/cache\/([^/]+)\/(thumb|proxy)$/.exec(p);
      if (mm) {
        const proj = await load();
        const m = o.cacheRoot ? await readManifest(o.cacheRoot, proj.id) : undefined;
        const rel = m?.entries[mm[1]]?.[mm[2] as 'thumb' | 'proxy'];
        if (!rel || !o.cacheRoot) return void res.writeHead(404).end('Not cached');
        const abs = path.resolve(o.cacheRoot, rel);
        if (!abs.startsWith(path.resolve(o.cacheRoot) + path.sep)) return void res.writeHead(403).end();
        return void (await sendFile(req, res, abs));
      }
      // Static player files.
      const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const abs = path.resolve(playerDir, rel);
      if (!abs.startsWith(path.resolve(playerDir) + path.sep)) return void res.writeHead(403).end();
      return void (await sendFile(req, res, abs));
    } catch (e) {
      log(`error: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end('Server error');
      else res.end();
    }
  });

  const host = o.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : o.port;
  return {
    server,
    url: `http://${host}:${port}/`,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
