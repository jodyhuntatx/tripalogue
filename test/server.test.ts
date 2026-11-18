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
import { withExif } from '../src/server/heif.js';
import { exifTiff, isBlue, isRed, look, writeHeic } from './helpers/heic.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.resolve(here, '../samples/hand-written-20');
const SAMPLE_JSON = readFileSync(path.join(SAMPLE_DIR, 'trip.travelogue.json'), 'utf8');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tripalogue-server-'));

let app: App;

/** A tiny browser: sends the client header on writes. There is no sign-in: every request is the local user. */
class Client {
  constructor(readonly name: string) {}
  async req(method: string, p: string, body?: unknown, opts: { raw?: Buffer | string; header?: boolean; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.header !== false && method !== 'GET') headers['x-tripalogue-client'] = '1';
    let payload: Buffer | string | undefined;
    if (opts.raw !== undefined) payload = opts.raw;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(new URL(p, app.url), { method, headers, body: payload as BodyInit | undefined, redirect: "manual" });
    const text = await res.text();
    let json: Record<string, any> = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
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

describe('one local user, no sign-in', () => {
  it('acts as the local user without signing in', async () => {
    const c = new Client('me');
    const me = (await c.req('GET', '/api/me')).json.user;
    assert.equal(me.email, 'me@this-computer');
    assert.equal(me.id, app.auth.user.id);
    assert.equal((await c.req('GET', '/api/projects')).status, 200);
  });

  it('has no sign-in, invitation or member routes', async () => {
    const c = new Client('me');
    for (const [m, p] of [['POST', '/api/auth/email'], ['GET', '/api/auth/verify'], ['POST', '/api/auth/logout'], ['GET', '/api/invites/accept'], ['GET', '/api/projects/x/members'], ['POST', '/api/projects/x/invites']] as const) {
      assert.equal((await c.req(m, p, m === 'POST' ? {} : undefined)).status, 404, `${m} ${p}`);
    }
  });

  it('listens on this computer only and answers only to a local Host', async () => {
    assert.equal(app.cfg.host, '127.0.0.1');
    const port = new URL(app.url).port;
    const asHost = (host: string) => new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/me', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(await asHost('evil.example'), 403, 'a DNS-rebinding page is refused');
    assert.equal(await asHost(`localhost:${port}`), 200);
    assert.equal(await asHost(`127.0.0.1:${port}`), 200);
  });

  it('refuses writes without the client header (cross-site request forgery)', async () => {
    const c = new Client('me');
    const r = await c.req('POST', '/api/projects', { title: 'x' }, { header: false });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'csrf');
  });
});

describe('projects, operation log and edit lock (F-1, F-8, F-9)', () => {
  const owner = new Client('owner');
  let pid = '';
  let doc: Travelogue;
  let rev = 0;

  before(async () => {
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

  it('requires the edit lock before changes are accepted', async () => {
    const ops: Operation[] = [{ op: 'set', path: ['title'], value: 'Portugal, revised' }];
    assert.equal((await owner.req('POST', `/api/projects/${pid}/ops`, { baseRev: rev, label: 'Rename', ops })).status, 423);
    assert.equal((await owner.req('POST', `/api/projects/${pid}/lock`, {})).status, 200);
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

  it('serves the operation log', async () => {
    const r = await owner.req('GET', `/api/projects/${pid}/ops?since=0`);
    assert.equal(r.status, 200);
    assert.equal(r.json.rev, rev);
    assert.ok(r.json.ops.length >= 4);
    assert.ok(r.json.ops.every((o: { author: string; origin: string }) => o.author && (o.origin === 'client' || o.origin === 'server')));
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
    const versions = (await owner.req('GET', `/api/projects/${pid}/versions`)).json.versions;
    assert.ok(versions.some((v: { label: string }) => v.label === 'Imported'));
    assert.ok(versions.some((v: { label: string }) => v.label.startsWith('Restored')));
  });

  it('releases the lock', async () => {
    assert.equal((await owner.req('DELETE', `/api/projects/${pid}/lock`)).status, 200);
    assert.equal(app.projects.lockInfo(pid), undefined);
  });

  it('exports a portable file without server internals', async () => {
    const r = await owner.req('GET', `/api/projects/${pid}/export`);
    assert.match(r.headers.get('content-disposition')!, /attachment; filename=".*\.travelogue\.json"/);
    const exported = JSON.parse(r.text) as Travelogue;
    assert.ok(exported.media.every((m) => m.storageKey === undefined && m.status === undefined));
  });
});

describe('odd request paths', () => {
  it('answers "//", "//x" and "///api/me" instead of crashing the server', async () => {
    for (const p of ['//', '//evil.example/x', '///api/me']) {
      const r = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: new URL(app.url).port, path: p }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('error', reject);
        req.end();
      });
      assert.ok(r > 0 && r < 500, `${p} → ${r}`);
    }
    assert.equal((await new Client('x').req('GET', '/api/me')).status, 200, 'server still up');
  });
});

describe('uploads, processing and media links (F-4, F-7)', () => {
  const owner = new Client('uploader');
  let pid = '';

  before(async () => {
    pid = (await owner.req('POST', '/api/projects/import', undefined, { raw: SAMPLE_JSON })).json.id;
  });

  async function upload(c: Client, file: string, body: Record<string, unknown>) {
    const data = await fs.readFile(file);
    const created = await c.req('POST', `/api/projects/${pid}/uploads`, { fileName: path.basename(file), size: data.length, ...body });
    assert.equal(created.status, 201, created.text);
    return finishUpload(c, created, data);
  }
  async function finishUpload(c: Client, created: { status: number; text: string; json: Record<string, any> }, data: Buffer) {
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

  it('reports a broken ffmpeg install, and retries failed items from their stored originals once it is fixed', async () => {
    const good = app.cfg.ffprobe;
    app.cfg.ffprobe = '/nonexistent/ffprobe';
    try {
      const tools = (await owner.req('GET', '/api/media-tools?recheck=1')).json;
      assert.equal(tools.ok, false);
      assert.match(tools.problems.join(' '), /ffprobe was not found/);
      const { mediaId } = await upload(owner, path.join(SAMPLE_DIR, 'media/ch3-01-ribeira.jpg'), { mediaId: 'm11' });
      await app.jobs.idle();
      let item = (await owner.req('GET', `/api/projects/${pid}`)).json.project.media.find((m: { id: string }) => m.id === mediaId);
      assert.equal(item.status, 'failed');
      assert.ok(item.storageKey, 'the original is stored even though processing failed');
      // Still broken: the retry runs, fails again, and the answer says why.
      const stillBroken = await owner.req('POST', `/api/projects/${pid}/media/retry`, { mediaIds: [mediaId] });
      assert.deepEqual(stillBroken.json.queued, [mediaId]);
      assert.equal(stillBroken.json.media.ok, false);
      await app.jobs.idle();
      // "Install" ffprobe, then retry everything that failed: no re-upload needed.
      app.cfg.ffprobe = good;
      const fixed = await owner.req('POST', `/api/projects/${pid}/media/retry`, {});
      assert.equal(fixed.status, 200, fixed.text);
      assert.ok(fixed.json.queued.includes(mediaId));
      assert.equal(fixed.json.media.ok, true);
      await app.jobs.idle();
      item = (await owner.req('GET', `/api/projects/${pid}`)).json.project.media.find((m: { id: string }) => m.id === mediaId);
      assert.equal(item.status, 'ready');
      assert.equal(item.error, undefined);
      assert.deepEqual((await owner.req('POST', `/api/projects/${pid}/media/retry`, {})).json.queued, [], 'nothing left to retry');
    } finally {
      app.cfg.ffprobe = good;
      await owner.req('GET', '/api/media-tools?recheck=1');
    }
  });

  const ff = (args: string[]) => new Promise<void>((resolve, reject) => import('node:child_process').then(({ execFile }) =>
    execFile('ffmpeg', ['-v', 'error', '-y', ...args], (e) => (e ? reject(e) : resolve()))));
  const itemOf = async (mediaId: string) => (await owner.req('GET', `/api/projects/${pid}`)).json.project.media.find((m: { id: string }) => m.id === mediaId) as Record<string, any>;

  it('reads capture time and GPS from a photo and files it in the right chapter (MM-2, MM-3, MM-9)', async () => {
    const plain = path.join(tmp, 'plain-sintra.jpg');
    await ff(['-f', 'lavfi', '-i', 'color=c=green:s=64x48', '-frames:v', '1', plain]);
    const file = path.join(tmp, 'IMG_1001.jpg');
    await fs.writeFile(file, withExif(await fs.readFile(plain), exifTiff('2026:05:04 15:10:00', 1, { offset: '+01:00', gps: { lat: 38.7876, lng: -9.3906 }, make: 'Apple', model: 'iPhone 15 Pro' })));
    const { mediaId } = await upload(owner, file, { lastModified: Date.UTC(2026, 9, 1) });
    await app.jobs.idle();
    const item = await itemOf(mediaId);
    assert.equal(item.capturedAt, '2026-05-04T15:10:00+01:00');
    assert.equal(item.timestampConfidence, 'high');
    assert.equal(item.chapterId, 'ch-sintra', 'Sintra is 4 May');
    assert.ok(Math.abs(item.location.lat - 38.7876) < 1e-4 && Math.abs(item.location.lng + 9.3906) < 1e-4);
    const src = (await owner.req('GET', `/api/projects/${pid}`)).json.project.sources.find((x: { id: string }) => x.id === item.sourceId);
    assert.equal(src.camera, 'Apple iPhone 15 Pro', 'grouped by camera');
    assert.match(src.displayName, /Apple iPhone 15 Pro/);
  });

  it('falls back to the file’s modified time, marked low confidence, when a file has no capture time', async () => {
    const file = path.join(tmp, 'screenshot.jpg');
    await ff(['-f', 'lavfi', '-i', 'color=c=gray:s=64x48', '-frames:v', '1', file]);
    const { mediaId } = await upload(owner, file, { lastModified: Date.parse('2026-05-06T11:00:00Z') });
    await app.jobs.idle();
    const item = await itemOf(mediaId);
    assert.equal(item.capturedAt, '2026-05-06T11:00:00.000Z');
    assert.equal(item.timestampConfidence, 'low');
    assert.equal(item.chapterId, 'ch-porto');
  });

  it('reads a video’s QuickTime creation time and location', async () => {
    const file = path.join(tmp, 'VID_2001.mp4');
    await ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x120:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-metadata', 'creation_time=2026-05-09T09:30:00Z', '-metadata', 'location=+41.1906-007.5458/', file]);
    const { mediaId } = await upload(owner, file, {});
    await app.jobs.idle();
    const item = await itemOf(mediaId);
    assert.equal(item.capturedAt, '2026-05-09T09:30:00Z');
    assert.equal(item.chapterId, 'ch-douro');
    assert.deepEqual(item.location, { lat: 41.1906, lng: -7.5458 });
  });

  it('imports a voice memo: duration, recording time, waveform thumbnail, playable copy, and its chapter (MM-15)', async () => {
    const file = path.join(tmp, 'Memo 2026-05-06.m4a');
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:a', 'aac', '-metadata', 'creation_time=2026-05-06T19:15:00Z', file]);
    const { mediaId } = await upload(owner, file, {});
    await app.jobs.idle();
    const item = await itemOf(mediaId);
    assert.equal(item.kind, 'audio');
    assert.equal(item.status, 'ready', item.error);
    assert.ok(Math.abs(item.durationSec - 4) < 0.2, String(item.durationSec));
    assert.equal(item.capturedAt, '2026-05-06T19:15:00Z');
    assert.equal(item.chapterId, 'ch-porto');
    assert.match(item.assets.thumb, /thumb\.jpg$/);
    assert.match(item.assets.proxy, /proxy\.m4a$/);
    const wave = await look(await app.blobs.localPath(item.assets.thumb), 2, 2);
    assert.deepEqual([wave.w, wave.h], [480, 160], 'a waveform picture');
  });

  it('tells the browser which files are already uploaded, by size and sample hash (MM-7)', async () => {
    const { sampleHashOfFile } = await import('../src/server/samplehash.js');
    const have = path.join(SAMPLE_DIR, 'media/ch1-04-pasteis.jpg'); // uploaded earlier in this suite
    const other = path.join(SAMPLE_DIR, 'media/ch4-03-river.jpg'); // not uploaded
    const files = await Promise.all([have, other].map(async (f) => ({ size: (await fs.stat(f)).size, sampleHash: await sampleHashOfFile(f) })));
    const r = await owner.req('POST', `/api/projects/${pid}/uploads/check`, { files });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.known.map((k: { index: number; mediaId: string }) => [k.index, k.mediaId]), [[0, 'm04']]);
    // An original stored before sample hashes existed is fingerprinted on first comparison.
    const before = app.projects.load(pid).doc.media.find((m) => m.id === 'm04')!;
    app.projects.serverChange(pid, 'system', 'drop sample hash', (d) => ({ ...d, media: d.media.map((m) => (m.id === 'm04' ? { ...m, sampleHash: undefined } : m)) }));
    assert.deepEqual((await owner.req('POST', `/api/projects/${pid}/uploads/check`, { files })).json.known.map((k: { index: number }) => k.index), [0]);
    assert.ok(before.sampleHash && /^[0-9a-f]{64}$/.test(before.sampleHash), 'stored at upload');
    assert.equal((await owner.req('POST', `/api/projects/${pid}/uploads/check`, { files: 'nope' })).status, 400);
  });

  it('leaves an item with no time at all in Unassigned', async () => {
    const file = path.join(tmp, 'mystery.jpg');
    await ff(['-f', 'lavfi', '-i', 'color=c=white:s=64x48', '-frames:v', '1', file]);
    const { mediaId } = await upload(owner, file, {});
    await app.jobs.idle();
    const item = await itemOf(mediaId);
    assert.equal(item.capturedAt, undefined);
    assert.equal(item.chapterId, null);
  });

  it('files a traveler’s photos under them, per camera (MM-16)', async () => {
    // Name a traveler (an ordinary edit), then upload photos they sent.
    assert.equal((await owner.req('POST', `/api/projects/${pid}/lock`, {})).status, 200);
    const base = (await owner.req('GET', `/api/projects/${pid}`)).json.rev;
    const named = await owner.req('POST', `/api/projects/${pid}/ops`, { baseRev: base, label: 'Add traveler', ops: [{ op: 'set', path: ['travelers'], value: [{ id: 'trv_carl', name: 'Carl' }] }] });
    assert.equal(named.status, 200, named.text);
    const { mediaId } = await upload(owner, path.join(SAMPLE_DIR, 'media/ch2-01-pena.jpg'), { travelerId: 'trv_carl' });
    const file = path.join(tmp, 'IMG_carl.jpg');
    await ff(['-f', 'lavfi', '-i', 'color=c=teal:s=64x48', '-frames:v', '1', path.join(tmp, 'plain-carl.jpg')]);
    await fs.writeFile(file, withExif(await fs.readFile(path.join(tmp, 'plain-carl.jpg')), exifTiff('2026:05:04 12:00:00', 1, { make: 'Google', model: 'Pixel 8' })));
    const phone = await upload(owner, file, { travelerId: 'trv_carl' });
    await app.jobs.idle();
    const p = (await owner.req('GET', `/api/projects/${pid}`)).json.project as Travelogue;
    const item = p.media.find((m) => m.id === mediaId)!;
    assert.equal(item.chapterId, null);
    assert.equal(item.status, 'ready');
    assert.ok(p.cues.some((c) => c.itemId === mediaId), 'a default cue is created');
    const src = p.sources.find((s) => s.id === item.sourceId)!;
    assert.deepEqual([src.displayName, src.contributorId], ["Carl's photos", 'trv_carl']);
    const cam = p.sources.find((s) => s.id === p.media.find((m) => m.id === phone.mediaId)!.sourceId)!;
    assert.deepEqual([cam.displayName, cam.contributorId], ['Carl · Google Pixel 8', 'trv_carl']);
    assert.equal((await owner.req('POST', `/api/projects/${pid}/uploads`, { fileName: 'a.jpg', size: 10, travelerId: 'trv_nobody' })).status, 400);
    await owner.req('DELETE', `/api/projects/${pid}/lock`);
  });

  it('rejects unsupported and oversized uploads', async () => {
    assert.equal((await owner.req('POST', `/api/projects/${pid}/uploads`, { fileName: 'notes.txt', size: 10 })).status, 415);
    assert.equal((await owner.req('POST', `/api/projects/${pid}/uploads`, { fileName: 'big.mp4', size: 51 * 1024 * 1024 })).status, 413);
  });

  it('serves media through short-lived signed links with byte ranges', async () => {
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
    assert.equal((await owner.req('GET', `/api/projects/${pid}/media/m10/proxy`)).status, 404, 'not uploaded yet');
  });

  it('refuses blob keys that try to leave the store', async () => {
    const r = await fetch(new URL(`/blob/..%2F..%2Ftripalogue.db?exp=9999999999&sig=x`, app.url));
    assert.equal(r.status, 403);
  });
});
