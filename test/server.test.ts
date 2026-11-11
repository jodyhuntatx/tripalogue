import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, promises as fs, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Operation, Travelogue } from '../src/core/index.js';
import { startApp, type App } from '../src/server/app.js';
import type { OutboxMailer } from '../src/server/mailer.js';
import { withExif } from '../src/server/heif.js';
import { exifTiff, isBlue, isRed, look, writeHeic } from './helpers/heic.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.resolve(here, '../samples/hand-written-20');
const SAMPLE_JSON = readFileSync(path.join(SAMPLE_DIR, 'trip.travelogue.json'), 'utf8');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tripalogue-server-'));

let app: App;
const outbox = () => app.mailer as OutboxMailer;

/** A tiny browser: keeps cookies, sends the client header on writes. */
class Client {
  cookie = '';
  constructor(readonly name: string) {}
  async req(method: string, p: string, body?: unknown, opts: { raw?: Buffer | string; header?: boolean; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (opts.header !== false && method !== 'GET') headers['x-tripalogue-client'] = '1';
    let payload: Buffer | string | undefined;
    if (opts.raw !== undefined) payload = opts.raw;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(new URL(p, app.url), { method, headers, body: payload as BodyInit | undefined, redirect: "manual" });
    const set = res.headers.get('set-cookie');
    if (set) {
      const [kv] = set.split(';');
      this.cookie = kv.endsWith('=') ? '' : kv;
    }
    const text = await res.text();
    let json: Record<string, any> = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  async signIn(email: string) {
    const r = await this.req('POST', '/api/auth/email', { email });
    assert.equal(r.status, 200);
    const mail = await outbox().latestFor(email);
    const link = new URL(/https?:\/\/\S+/.exec(mail!.text)![0]);
    const v = await this.req('GET', link.pathname + link.search);
    assert.equal(v.status, 302);
    assert.ok(this.cookie.startsWith('tl_session='));
    return (await this.req('GET', '/api/me')).json.user as { id: string; email: string };
  }
}

before(async () => {
  app = await startApp({ dataDir: tmp, port: 0, chunkBytes: 64 * 1024, maxUploadBytes: 50 * 1024 * 1024, log: () => {}, webDir: path.join(tmp, 'web') });
  await fs.mkdir(path.join(tmp, 'web'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'web', 'index.html'), '<!doctype html>ok');
});
after(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('accounts and sessions (F-6)', () => {
  it('signs in with an emailed one-time link and keeps a session', async () => {
    const c = new Client('ana');
    const user = await c.signIn('Ana@Example.com');
    assert.equal(user.email, 'ana@example.com');
    const mail = await outbox().latestFor('ana@example.com');
    const link = new URL(/https?:\/\/\S+/.exec(mail!.text)![0]);
    const again = await new Client('x').req('GET', link.pathname + link.search);
    assert.equal(again.status, 302);
    assert.match(again.headers.get('location')!, /error=.*invalid/i, 'a link works only once');
  });

  it('answers the same way for known and unknown addresses, and rejects bad ones', async () => {
    const c = new Client('anon');
    assert.deepEqual((await c.req('POST', '/api/auth/email', { email: 'nobody@example.com' })).json, { sent: true });
    assert.equal((await c.req('POST', '/api/auth/email', { email: 'not-an-email' })).status, 400);
    assert.deepEqual((await c.req('GET', '/api/me')).json.user, null);
    assert.equal((await c.req('GET', '/api/projects')).status, 401);
  });

  it('sets a hardened session cookie and signs out for real', async () => {
    const c = new Client('ben');
    await c.req('POST', '/api/auth/email', { email: 'ben@example.com' });
    const link = new URL(/https?:\/\/\S+/.exec((await outbox().latestFor('ben@example.com'))!.text)![0]);
    const v = await c.req('GET', link.pathname + link.search);
    assert.match(v.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+/);
    const old = c.cookie;
    await c.req('POST', '/api/auth/logout', {});
    c.cookie = old;
    assert.equal((await c.req('GET', '/api/projects')).status, 401, 'old session id no longer works');
  });

  it('refuses writes without the client header (cross-site request forgery)', async () => {
    const c = new Client('cara');
    await c.signIn('cara@example.com');
    const r = await c.req('POST', '/api/projects', { title: 'x' }, { header: false });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'csrf');
  });
});

describe('Google sign-in (OAuth code flow with PKCE)', () => {
  it('redirects to Google and signs in from a verified ID token', async () => {
    let tokenRequest = '';
    const fake = http.createServer(async (req, res) => {
      for await (const c of req) tokenRequest += c;
      const claims = { iss: 'https://accounts.example', aud: 'cid', exp: Math.floor(Date.now() / 1000) + 300, email: 'gina@example.com', email_verified: true, name: 'Gina' };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y` }));
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const port = (fake.address() as { port: number }).port;
    app.cfg.google = { clientId: 'cid', clientSecret: 'sec', tokenUrl: `http://127.0.0.1:${port}/token`, issuer: 'https://accounts.example' };
    try {
      const c = new Client('gina');
      const start = await c.req('GET', '/api/auth/google/start?next=/%23/projects');
      const loc = new URL(start.headers.get('location')!);
      assert.equal(loc.searchParams.get('client_id'), 'cid');
      assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
      const state = loc.searchParams.get('state')!;
      const bad = await c.req('GET', `/api/auth/google/callback?code=abc&state=wrong`);
      assert.match(bad.headers.get('location')!, /error=/);
      const cb = await c.req('GET', `/api/auth/google/callback?code=abc&state=${state}`);
      assert.equal(cb.status, 302);
      assert.match(tokenRequest, /code_verifier=/);
      assert.equal((await c.req('GET', '/api/me')).json.user.email, 'gina@example.com');
    } finally {
      app.cfg.google = undefined;
      fake.close();
    }
  });
});

describe('projects, operation log and edit lock (F-1, F-8, F-9)', () => {
  const owner = new Client('owner');
  const editor = new Client('editor');
  const viewer = new Client('viewer');
  let pid = '';
  let doc: Travelogue;
  let rev = 0;

  before(async () => {
    await owner.signIn('olga@example.com');
    await editor.signIn('eddie@example.com');
    await viewer.signIn('vera@example.com');
    const r = await owner.req('POST', '/api/projects/import', undefined, { raw: SAMPLE_JSON });
    assert.equal(r.status, 201);
    pid = r.json.id;
    assert.equal(r.json.pending.length, 20);
    const g = await owner.req('GET', `/api/projects/${pid}`);
    doc = g.json.project;
    rev = g.json.rev;
  });

  it('imports a v1 file as a v2 project with every original pending', () => {
    assert.equal(doc.schemaVersion, 2);
    assert.equal(doc.id, pid);
    assert.ok(doc.media.every((m) => m.status === 'pending'));
    assert.ok(doc.sources.every((s) => s.type === 'upload'));
  });

  it('hides projects from non-members', async () => {
    assert.equal((await editor.req('GET', `/api/projects/${pid}`)).status, 404);
    assert.equal((await editor.req('GET', '/api/projects')).json.projects.length, 0);
  });

  it('invites by email; accepting grants the role', async () => {
    for (const [c, email, role] of [[editor, 'eddie@example.com', 'editor'], [viewer, 'vera@example.com', 'viewer']] as const) {
      assert.equal((await owner.req('POST', `/api/projects/${pid}/invites`, { email, role })).status, 201);
      const mail = await outbox().latestFor(email);
      assert.match(mail!.subject, /invited you/);
      const link = new URL(/https?:\/\/\S+/.exec(mail!.text)![0]);
      const acc = await c.req('GET', link.pathname + link.search);
      assert.equal(acc.headers.get('location'), `/#/p/${pid}`);
    }
    const members = (await owner.req('GET', `/api/projects/${pid}/members`)).json.members;
    assert.deepEqual(members.map((m: { role: string }) => m.role), ['owner', 'editor', 'viewer']);
    assert.equal((await editor.req('POST', `/api/projects/${pid}/invites`, { email: 'x@example.com', role: 'viewer' })).status, 403, 'only the owner invites');
  });

  it('requires the edit lock, and only one editor holds it at a time', async () => {
    const ops: Operation[] = [{ op: 'set', path: ['title'], value: 'Portugal, revised' }];
    assert.equal((await owner.req('POST', `/api/projects/${pid}/ops`, { baseRev: rev, label: 'Rename', ops })).status, 423);
    assert.equal((await owner.req('POST', `/api/projects/${pid}/lock`, {})).status, 200);
    const other = await editor.req('POST', `/api/projects/${pid}/lock`, {});
    assert.equal(other.status, 423);
    assert.equal(other.json.lock.name, 'olga');
    assert.equal((await viewer.req('POST', `/api/projects/${pid}/lock`, {})).status, 403, 'viewers cannot edit');
    const r = await owner.req('POST', `/api/projects/${pid}/ops`, { baseRev: rev, label: 'Rename', ops });
    assert.equal(r.status, 200);
    assert.equal(r.json.rev, rev + 1);
    rev = r.json.rev;
  });

  it('stamps who changed each entity', async () => {
    const ops: Operation[] = [{ op: 'set', path: ['cues', { key: 'm01' }, 'durationSec'], value: 6 }];
    const r = await owner.req('POST', `/api/projects/${pid}/ops`, { baseRev: rev, label: 'Duration', ops });
    rev = r.json.rev;
    const stamp = r.json.stamps.find((o: Operation) => o.path[2] === 'updatedBy');
    assert.ok(stamp, 'stamps returned to the client');
    const cue = (await owner.req('GET', `/api/projects/${pid}`)).json.project.cues.find((c: { itemId: string }) => c.itemId === 'm01');
    assert.equal(cue.durationSec, 6);
    assert.match(cue.updatedBy, /^usr_/);
    assert.ok(cue.updatedAt);
  });

  it('accepts a stale base revision only when the changes in between came from the server', async () => {
    const before = rev;
    await app.projects.serverChange(pid, 'system', 'Test server change', (d) => ({ ...d, media: d.media.map((m) => (m.id === 'm02' ? { ...m, error: 'x' } : m)) }));
    const ok = await owner.req('POST', `/api/projects/${pid}/ops`, { baseRev: before, label: 'Exclude', ops: [{ op: 'set', path: ['cues', { key: 'm03' }, 'included'], value: false }] });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.catchUp.length, 1, 'the client is sent what it missed');
    rev = ok.json.rev;
    const stale = await owner.req('POST', `/api/projects/${pid}/ops`, { baseRev: before, label: 'Again', ops: [{ op: 'set', path: ['title'], value: 'x' }] });
    assert.equal(stale.status, 409, 'a client change in between is a conflict');
  });

  it('rejects malformed operations and changes that would break the project', async () => {
    assert.equal((await owner.req('POST', `/api/projects/${pid}/ops`, { baseRev: rev, ops: [{ op: 'nope' }] })).status, 400);
    const bad = await owner.req('POST', `/api/projects/${pid}/ops`, { baseRev: rev, ops: [{ op: 'set', path: ['cues', { key: 'm01' }, 'order'], value: 'BAD' }] });
    assert.equal(bad.status, 422);
    const idChange = await owner.req('POST', `/api/projects/${pid}/ops`, { baseRev: rev, ops: [{ op: 'set', path: ['id'], value: 'trv_other' }] });
    assert.equal(idChange.status, 400);
    assert.equal((await owner.req('GET', `/api/projects/${pid}`)).json.rev, rev, 'nothing was applied');
  });

  it('serves the operation log to every member', async () => {
    const r = await viewer.req('GET', `/api/projects/${pid}/ops?since=0`);
    assert.equal(r.status, 200);
    assert.equal(r.json.rev, rev);
    assert.ok(r.json.ops.length >= 4);
    assert.ok(r.json.ops.every((o: { author: string; origin: string }) => o.author && (o.origin === 'client' || o.origin === 'server')));
    assert.equal((await viewer.req('POST', `/api/projects/${pid}/ops`, { baseRev: rev, ops: [{ op: 'set', path: ['title'], value: 'v' }] })).status, 403);
  });

  it('saves and restores versions; a restore is itself a new revision', async () => {
    const saved = await owner.req('POST', `/api/projects/${pid}/versions`, { label: 'Before big change' });
    assert.equal(saved.status, 201);
    const r = await owner.req('POST', `/api/projects/${pid}/ops`, { baseRev: rev, label: 'Rename', ops: [{ op: 'set', path: ['title'], value: 'Wrong title' }] });
    rev = r.json.rev;
    const res = await owner.req('POST', `/api/projects/${pid}/versions/${saved.json.id}/restore`, {});
    assert.equal(res.status, 200);
    assert.equal(res.json.rev, rev + 1);
    rev = res.json.rev;
    const g = await owner.req('GET', `/api/projects/${pid}`);
    assert.equal(g.json.project.title, 'Portugal, revised');
    const versions = (await viewer.req('GET', `/api/projects/${pid}/versions`)).json.versions;
    assert.ok(versions.some((v: { label: string }) => v.label === 'Imported'));
    assert.ok(versions.some((v: { label: string }) => v.label.startsWith('Restored')));
  });

  it('releases the lock so another editor can take over', async () => {
    await owner.req('DELETE', `/api/projects/${pid}/lock`);
    assert.equal((await editor.req('POST', `/api/projects/${pid}/lock`, {})).status, 200);
    await editor.req('DELETE', `/api/projects/${pid}/lock`);
  });

  it('exports a portable file without server internals', async () => {
    const r = await owner.req('GET', `/api/projects/${pid}/export`);
    assert.match(r.headers.get('content-disposition')!, /attachment; filename=".*\.travelogue\.json"/);
    const exported = JSON.parse(r.text) as Travelogue;
    assert.ok(exported.media.every((m) => m.storageKey === undefined && m.status === undefined));
    assert.equal((await viewer.req('GET', `/api/projects/${pid}/export`)).status, 403);
  });
});

describe('uploads, processing and media links (F-4, F-7)', () => {
  const owner = new Client('uploader');
  const contributor = new Client('contrib');
  const outsider = new Client('outsider');
  let pid = '';

  before(async () => {
    await owner.signIn('uma@example.com');
    await contributor.signIn('carl@example.com');
    await outsider.signIn('otto@example.com');
    pid = (await owner.req('POST', '/api/projects/import', undefined, { raw: SAMPLE_JSON })).json.id;
    await owner.req('POST', `/api/projects/${pid}/invites`, { email: 'carl@example.com', role: 'contributor' });
    const link = new URL(/https?:\/\/\S+/.exec((await outbox().latestFor('carl@example.com'))!.text)![0]);
    await contributor.req('GET', link.pathname + link.search);
  });

  async function upload(c: Client, file: string, body: Record<string, unknown>) {
    const data = await fs.readFile(file);
    const created = await c.req('POST', `/api/projects/${pid}/uploads`, { fileName: path.basename(file), size: data.length, ...body });
    assert.equal(created.status, 201, created.text);
    const { uploadId, chunkBytes } = created.json;
    let offset = created.json.offset;
    while (offset < data.length) {
      const r = await c.req('PUT', `/api/uploads/${uploadId}?offset=${offset}`, undefined, { raw: data.subarray(offset, offset + chunkBytes) });
      assert.equal(r.status, 200, r.text);
      offset = r.json.offset;
    }
    return { uploadId, mediaId: created.json.mediaId as string, data };
  }

  it('uploads in chunks, refuses out-of-place chunks, and resumes from the server offset', async () => {
    const file = path.join(SAMPLE_DIR, 'media/ch1-04-pasteis.jpg');
    const data = await fs.readFile(file);
    const created = await owner.req('POST', `/api/projects/${pid}/uploads`, { fileName: 'ch1-04-pasteis.jpg', size: data.length, mediaId: 'm04' });
    const { uploadId, chunkBytes } = created.json;
    await owner.req('PUT', `/api/uploads/${uploadId}?offset=0`, undefined, { raw: data.subarray(0, chunkBytes) });
    const wrong = await owner.req('PUT', `/api/uploads/${uploadId}?offset=0`, undefined, { raw: data.subarray(0, chunkBytes) });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json.code, 'offset_mismatch');
    // "Reload": asking to upload the same item again resumes the same upload.
    const again = await owner.req('POST', `/api/projects/${pid}/uploads`, { fileName: 'ch1-04-pasteis.jpg', size: data.length, mediaId: 'm04' });
    assert.equal(again.json.uploadId, uploadId);
    assert.equal(again.json.offset, chunkBytes);
    let offset = again.json.offset;
    while (offset < data.length) offset = (await owner.req('PUT', `/api/uploads/${uploadId}?offset=${offset}`, undefined, { raw: data.subarray(offset, offset + chunkBytes) })).json.offset;
    assert.equal((await owner.req('GET', `/api/uploads/${uploadId}`)).json.complete, true);
    await app.jobs.idle();
    const item = (await owner.req('GET', `/api/projects/${pid}`)).json.project.media.find((m: { id: string }) => m.id === 'm04');
    assert.equal(item.status, 'ready');
    assert.equal(item.contentHash, createHash('sha256').update(data).digest('hex'), 'stored byte for byte');
    assert.ok(item.assets.thumb && item.assets.proxy);
  });

  it('processes video into a proxy and fills in its duration', async () => {
    const { mediaId } = await upload(owner, path.join(SAMPLE_DIR, 'media/ch1-05-fado.mp4'), { mediaId: 'm05' });
    await app.jobs.idle();
    const item = (await owner.req('GET', `/api/projects/${pid}`)).json.project.media.find((m: { id: string }) => m.id === mediaId);
    assert.equal(item.status, 'ready');
    assert.match(item.assets.proxy, /proxy\.mp4$/);
  });

  it('turns a HEIC photo into a full-size JPEG, keeps the original, and makes an upright thumbnail and proxy', async () => {
    const file = path.join(tmp, 'IMG_0420.HEIC');
    await writeHeic(file, { width: 320, height: 240, tile: 128, rotateCcw: 90, capturedAt: '2026:05:03 14:22:10', exifOrientation: 6 });
    const { mediaId, data } = await upload(owner, file, {});
    await app.jobs.idle();
    const item = (await owner.req('GET', `/api/projects/${pid}`)).json.project.media.find((m: { id: string }) => m.id === mediaId);
    assert.equal(item.status, 'ready', item.error);
    assert.equal(item.kind, 'image');
    assert.deepEqual([item.width, item.height], [240, 320], 'the upright size');
    assert.equal(item.contentHash, createHash('sha256').update(data).digest('hex'), 'the HEIC original is stored byte for byte');
    assert.match(item.assets.jpeg, /full\.jpg$/);
    const full = await app.blobs.localPath(item.assets.jpeg);
    const fullTop = await look(full, 5, 5);
    assert.deepEqual([fullTop.w, fullTop.h], [240, 320]);
    assert.ok(isRed((await look(full, 5, 314)).rgb) && isBlue(fullTop.rgb), 'turned as the HEIC says');
    assert.ok((await fs.readFile(full)).includes('2026:05:03 14:22:10'), 'capture time kept in the JPEG');
    for (const k of ['proxy', 'thumb'] as const) {
      const f = await app.blobs.localPath(item.assets[k]);
      const p = await look(f, 2, 2);
      assert.ok(p.h > p.w, `${k} is portrait`);
      assert.ok(isBlue(p.rgb) && isRed((await look(f, 2, p.h - 3)).rgb), `${k} is upright`);
    }
    const link = await owner.req('GET', `/api/projects/${pid}/media/${mediaId}/jpeg`);
    assert.equal(link.status, 302, 'the JPEG can be downloaded');
  });

  it('stands a sideways phone JPEG upright using its orientation tag', async () => {
    const plain = path.join(tmp, 'side.jpg');
    await new Promise<void>((resolve, reject) => import('node:child_process').then(({ execFile }) => execFile('ffmpeg',
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240,drawbox=x=0:y=0:w=80:h=60:c=red:t=fill', '-frames:v', '1', plain], (e) => (e ? reject(e) : resolve()))));
    const tagged = path.join(tmp, 'IMG_0421.jpg');
    await fs.writeFile(tagged, withExif(await fs.readFile(plain), exifTiff('2026:05:04 09:00:00', 6)));
    const { mediaId } = await upload(owner, tagged, {});
    await app.jobs.idle();
    const item = (await owner.req('GET', `/api/projects/${pid}`)).json.project.media.find((m: { id: string }) => m.id === mediaId);
    assert.equal(item.status, 'ready', item.error);
    assert.deepEqual([item.width, item.height], [240, 320]);
    assert.equal(item.assets.jpeg, undefined, 'JPEGs need no conversion');
    const proxy = await app.blobs.localPath(item.assets.proxy);
    const p = await look(proxy, 2, 2);
    assert.deepEqual([p.w, p.h], [240, 320]);
    assert.ok(isRed((await look(proxy, 237, 2)).rgb), 'turned a quarter clockwise: the red block is top-right');
  });

  it('lets a contributor add new media (to Unassigned), but not edit the travelogue', async () => {
    const { mediaId } = await upload(contributor, path.join(SAMPLE_DIR, 'media/ch2-01-pena.jpg'), {});
    await app.jobs.idle();
    const p = (await owner.req('GET', `/api/projects/${pid}`)).json.project as Travelogue;
    const item = p.media.find((m) => m.id === mediaId)!;
    assert.equal(item.chapterId, null);
    assert.equal(item.status, 'ready');
    assert.ok(p.cues.some((c) => c.itemId === mediaId), 'a default cue is created');
    const src = p.sources.find((s) => s.id === item.sourceId)!;
    assert.match(src.displayName, /carl's uploads/);
    assert.equal((await contributor.req('POST', `/api/projects/${pid}/lock`, {})).status, 403);
  });

  it('rejects unsupported, oversized and non-member uploads', async () => {
    assert.equal((await owner.req('POST', `/api/projects/${pid}/uploads`, { fileName: 'notes.txt', size: 10 })).status, 415);
    assert.equal((await owner.req('POST', `/api/projects/${pid}/uploads`, { fileName: 'big.mp4', size: 51 * 1024 * 1024 })).status, 413);
    assert.equal((await outsider.req('POST', `/api/projects/${pid}/uploads`, { fileName: 'a.jpg', size: 10 })).status, 404);
  });

  it('serves media only to members, through short-lived signed links with byte ranges', async () => {
    const r = await owner.req('GET', `/api/projects/${pid}/media/m05/proxy`);
    assert.equal(r.status, 302);
    const loc = r.headers.get('location')!;
    assert.match(loc, /^\/blob\/derived\/.+proxy\.mp4\?exp=\d+&sig=/);
    const part = await fetch(new URL(loc, app.url), { headers: { Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    const forged = loc.replace(/sig=([^&]+)/, 'sig=AAAA$1');
    assert.equal((await fetch(new URL(forged, app.url))).status, 403);
    const key = new URL(loc, app.url).pathname.slice('/blob/'.length);
    assert.equal((await fetch(new URL(app.auth.signBlobUrl(key, -5), app.url))).status, 403, 'expired');
    assert.equal((await outsider.req('GET', `/api/projects/${pid}/media/m05/proxy`)).status, 404);
    assert.equal((await owner.req('GET', `/api/projects/${pid}/media/m10/proxy`)).status, 404, 'not uploaded yet');
  });

  it('refuses blob keys that try to leave the store', async () => {
    const r = await fetch(new URL(`/blob/..%2F..%2Ftripalogue.db?exp=9999999999&sig=x`, app.url));
    assert.equal(r.status, 403);
  });
});
