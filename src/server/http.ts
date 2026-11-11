/** Minimal HTTP plumbing: a router, JSON helpers and typed errors. No framework. */
import type http from 'node:http';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'error') {
    super(message);
  }
}

export type Req = http.IncomingMessage & { url: string; method: string };
export type Res = http.ServerResponse;
export interface Ctx {
  req: Req;
  res: Res;
  url: URL;
  params: Record<string, string>;
}
export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const re = new RegExp(
      '^' + pattern.replace(/\/:([a-zA-Z]+)/g, (_, k: string) => {
        keys.push(k);
        return '/([^/]+)';
      }) + '$',
    );
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined {
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return undefined;
  }
}

export function sendJson(res: Res, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export async function readBody(req: Req, limit = 2 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new HttpError(413, 'Request body too large', 'too_large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T = Record<string, unknown>>(req: Req, limit?: number): Promise<T> {
  const buf = await readBody(req, limit);
  try {
    return JSON.parse(buf.toString('utf8') || '{}') as T;
  } catch {
    throw new HttpError(400, 'Body is not valid JSON', 'bad_json');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function requireString(v: unknown, name: string, max = 500): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpError(400, `${name} is required`, 'invalid');
  return v.trim();
}
