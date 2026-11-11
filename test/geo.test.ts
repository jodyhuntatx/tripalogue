import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startApp, type App } from '../src/server/app.js';
import { geoConfigFromEnv } from '../src/server/geo.js';
import type { OutboxMailer } from '../src/server/mailer.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'tripalogue-geo-'));
let app: App;
let upstream: http.Server;
const seen: { url: string; ua: string; at: number }[] = [];
let failTiles = false;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a2c80000000049454e44ae426082', 'hex');
let cookie = '';

async function get(p: string, withCookie = true) {
  const res = await fetch(new URL(p, app.url), { headers: withCookie && cookie ? { cookie } : {}, redirect: 'manual' });
  return { status: res.status, type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
}

before(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', ua: String(req.headers['user-agent']), at: Date.now() });
    if (req.url?.startsWith('/search')) {
      const q = new URL(req.url, 'http://x').searchParams.get('q');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(q === 'Nowhereville' ? [] : [
        { name: 'Lisboa', display_name: 'Lisboa, Grande Lisboa, Portugal', lat: '38.7077', lon: '-9.1365', type: 'city' },
        { display_name: 'Lisbon, Maine, United States', lat: '44.03', lon: '-70.10', type: 'town' },
        { display_name: 'broken', lat: 'x', lon: 'y' },
      ]));
    }
    if (req.url?.startsWith('/tiles/')) {
      if (failTiles) return res.writeHead(503).end();
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  app = await startApp({
    dataDir: tmp, port: 0, log: () => {}, webDir: tmp,
    geo: geoConfigFromEnv(tmp, { geocoderUrl: `${base}/search`, tileUrl: `${base}/tiles/{z}/{x}/{y}.png`, minSearchIntervalMs: 300, tileMaxAgeMs: 60_000 }),
  });
  await fetch(new URL('/api/auth/email', app.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-tripalogue-client': '1' }, body: JSON.stringify({ email: 'map@example.com' }) });
  const mail = await (app.mailer as OutboxMailer).latestFor('map@example.com');
  const v = await fetch(/https?:\/\/\S+/.exec(mail!.text)![0], { redirect: 'manual' });
  cookie = v.headers.get('set-cookie')!.split(';')[0];
});
after(async () => {
  await app.close();
  upstream.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('place search proxy (IT-8)', () => {
  it('returns clean places and identifies itself to the provider', async () => {
    const r = await get('/api/geo/search?q=Lisbon');
    assert.equal(r.status, 200);
    const { places } = JSON.parse(r.body.toString());
    assert.deepEqual(places.map((p: { name: string }) => p.name), ['Lisboa', 'Lisbon']);
    assert.equal(places[0].lat, 38.7077);
    assert.match(seen.at(-1)!.ua, /^TripAlogue\//);
    assert.match(seen.at(-1)!.url, /format=jsonv2/);
  });

  it('caches repeated searches and spaces out new ones (provider rate limit)', async () => {
    const before = seen.length;
    await get('/api/geo/search?q=lisbon');
    assert.equal(seen.length, before, 'same search served from cache');
    await Promise.all([get('/api/geo/search?q=Porto'), get('/api/geo/search?q=Sintra')]);
    const [a, b] = seen.slice(-2);
    assert.ok(b.at - a.at >= 280, `requests ${b.at - a.at} ms apart`);
  });

  it('needs a signed-in user and a real query', async () => {
    assert.equal((await get('/api/geo/search?q=Lisbon', false)).status, 401);
    assert.equal((await get('/api/geo/search?q=x')).status, 400);
    assert.deepEqual(JSON.parse((await get('/api/geo/search?q=Nowhereville')).body.toString()).places, []);
  });
});

describe('map tile proxy (MV-1)', () => {
  it('serves tiles and caches them on disk', async () => {
    const r = await get('/api/tiles/3/4/2');
    assert.equal(r.status, 200);
    assert.equal(r.type, 'image/png');
    assert.deepEqual(r.body, PNG);
    const before = seen.length;
    await get('/api/tiles/3/4/2');
    assert.equal(seen.length, before, 'second request served from cache');
    await fs.access(path.join(tmp, 'tiles', '3', '4', '2.png'));
  });

  it('serves a stale tile when the provider fails, and rejects bad coordinates', async () => {
    const f = path.join(tmp, 'tiles', '3', '4', '2.png');
    const old = new Date(Date.now() - 3_600_000);
    await fs.utimes(f, old, old);
    failTiles = true;
    try {
      assert.equal((await get('/api/tiles/3/4/2')).status, 200, 'stale copy');
      assert.equal((await get('/api/tiles/3/5/2')).status, 502, 'no copy to fall back on');
    } finally {
      failTiles = false;
    }
    for (const bad of ['/api/tiles/3/8/0', '/api/tiles/20/0/0', '/api/tiles/a/b/c', '/api/tiles/-1/0/0']) assert.equal((await get(bad)).status, 400, bad);
    assert.equal((await get('/api/tiles/3/4/2', false)).status, 401);
  });

  it('tells the client what the map can do', async () => {
    const cfg = JSON.parse((await get('/api/config')).body.toString());
    assert.deepEqual(cfg.map, { tiles: true, search: true, attribution: '© OpenStreetMap contributors' });
  });
});
