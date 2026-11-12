import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  diff, expiredRemovals, parseProject, removeMedia, restoreMedia, stripMedia, validate, type Operation, type Travelogue,
} from '../src/core/index.js';
import { startApp, type App } from '../src/server/app.js';
import type { OutboxMailer } from '../src/server/mailer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.resolve(here, '../samples/hand-written-20');
const sample = async () => parseProject(await fs.readFile(path.join(SAMPLE_DIR, 'trip.travelogue.json'), 'utf8')).project;

describe('the Removed bin (core)', () => {
  it('removes items with their cues, puts them back exactly, and stays valid throughout', async () => {
    const p = await sample();
    const cue = p.cues.find((c) => c.itemId === 'm03')!;
    const q = removeMedia(p, ['m03', 'm04', 'nope'], '2026-11-01T10:00:00Z', 'u1');
    assert.deepEqual([q.media.length, q.cues.length, q.removed!.length], [p.media.length - 2, p.cues.length - 2, 2]);
    assert.deepEqual(q.removed![0], { item: p.media.find((m) => m.id === 'm03'), cue, removedAt: '2026-11-01T10:00:00Z', removedBy: 'u1' });
    assert.equal(validate(q).filter((i) => i.level === 'error').length, 0);
    const back = restoreMedia(q, ['m03']);
    assert.deepEqual(back.cues.find((c) => c.itemId === 'm03'), cue, 'same cue, same place');
    assert.deepEqual(back.removed!.map((r) => r.item.id), ['m04']);
    assert.equal(validate(back).filter((i) => i.level === 'error').length, 0);
    assert.equal(removeMedia(p, ['nope'], 'x'), p, 'nothing to remove: unchanged');
  });

  it('refuses an id that is both in the travelogue and in the bin', async () => {
    const p = await sample();
    const q = removeMedia(p, ['m03'], '2026-11-01T10:00:00Z');
    const bad: Travelogue = { ...q, media: [...q.media, q.removed![0].item] };
    assert.ok(validate(bad).some((i) => i.level === 'error' && /both in the travelogue and removed/.test(i.message)));
  });

  it('strips items completely, and finds those whose time in the bin is up', async () => {
    const p = removeMedia(removeMedia(await sample(), ['m01'], '2026-10-01T00:00:00Z'), ['m02'], '2026-11-10T00:00:00Z');
    assert.deepEqual(expiredRemovals(p, Date.parse('2026-11-11T00:00:00Z'), 30), ['m01']);
    const s = stripMedia(p, ['m01', 'm05']);
    assert.deepEqual([s.removed!.map((r) => r.item.id), s.media.some((m) => m.id === 'm05'), s.cues.some((c) => c.itemId === 'm05')], [['m02'], false, false]);
  });
});

// ---------------------------------------------------------------- server

let app: App;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-del-'));
class Client {
  cookie = '';
  async req(method: string, p: string, body?: unknown, raw?: Buffer | string) {
    const headers: Record<string, string> = method === 'GET' ? {} : { 'x-tripalogue-client': '1' };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(new URL(p, app.url), { method, headers, body: (raw ?? (body !== undefined ? JSON.stringify(body) : undefined)) as BodyInit | undefined, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let json: Record<string, any> = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
    return { status: res.status, json, text };
  }
  async signIn(email: string) {
    await this.req('POST', '/api/auth/email', { email });
    const link = new URL(/https?:\/\/\S+/.exec((await (app.mailer as OutboxMailer).latestFor(email))!.text)![0]);
    await this.req('GET', link.pathname + link.search);
    return (await this.req('GET', '/api/me')).json.user as { id: string };
  }
}

const owner = new Client();
const editor = new Client();
const contributor = new Client();
let pid = '';
let ownerId = '';

async function doc(): Promise<{ doc: Travelogue; rev: number }> {
  const r = await owner.req('GET', `/api/projects/${pid}`);
  return { doc: r.json.project, rev: r.json.rev };
}
/** Make an edit as the owner, the way the browser does: compute the new document and send the difference. */
async function edit(label: string, change: (p: Travelogue) => Travelogue, c = owner) {
  const { doc: d, rev } = await doc();
  const ops: Operation[] = diff(d, change(d));
  return c.req('POST', `/api/projects/${pid}/ops`, { baseRev: rev, label, ops });
}
async function upload(file: string, mediaId: string) {
  const data = await fs.readFile(file);
  const c = await owner.req('POST', `/api/projects/${pid}/uploads`, { fileName: path.basename(file), size: data.length, mediaId });
  let offset = c.json.offset as number;
  while (offset < data.length) offset = (await owner.req('PUT', `/api/uploads/${c.json.uploadId}?offset=${offset}`, undefined, data.subarray(offset, offset + c.json.chunkBytes))).json.offset;
}
const exists = async (key: string) => !!(await app.blobs.stat(key));
const dirExists = (p: string) => fs.stat(path.join(tmp, 'blobs', p)).then(() => true, () => false);

before(async () => {
  app = await startApp({ dataDir: tmp, port: 0, log: () => {}, webDir: path.join(tmp, 'web'), runWorker: true, purgeAfterDays: 30 });
  await fs.mkdir(path.join(tmp, 'web'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'web', 'index.html'), 'ok');
  ownerId = (await owner.signIn('owner@example.com')).id;
  pid = (await owner.req('POST', '/api/projects/import', undefined, await fs.readFile(path.join(SAMPLE_DIR, 'trip.travelogue.json'), 'utf8'))).json.id;
  for (const [c, email, role] of [[editor, 'ed@example.com', 'editor'], [contributor, 'co@example.com', 'contributor']] as const) {
    await owner.req('POST', `/api/projects/${pid}/invites`, { email, role });
    const invite = new URL(/https?:\/\/\S+accept\S+/.exec((await (app.mailer as OutboxMailer).latestFor(email))!.text)![0]);
    await c.signIn(email);
    await c.req('GET', invite.pathname + invite.search);
  }
  await upload(path.join(SAMPLE_DIR, 'media/ch1-01-alfama.jpg'), 'm01');
  await upload(path.join(SAMPLE_DIR, 'media/ch1-02-tram28.jpg'), 'm02');
  await upload(path.join(SAMPLE_DIR, 'media/ch1-03-belem.jpg'), 'm03');
  await app.jobs.idle();
  assert.equal((await owner.req('POST', `/api/projects/${pid}/lock`, {})).status, 200);
});
after(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('removing and deleting media for good (server)', () => {
  it('a removed item keeps its files while anything can still bring it back: Undo, Put back, or a saved version', async () => {
    const before = (await doc()).doc.media.find((m) => m.id === 'm01')!;
    assert.equal(before.status, 'ready');
    const v = await owner.req('POST', `/api/projects/${pid}/versions`, { label: 'Before removing' });
    assert.equal(v.status, 201, v.text);
    assert.equal((await edit('Remove item', (p) => removeMedia(p, ['m01'], new Date().toISOString(), ownerId))).status, 200);
    const d = (await doc()).doc;
    assert.ok(!d.media.some((m) => m.id === 'm01') && d.removed!.some((r) => r.item.id === 'm01'));
    assert.ok(await exists(before.storageKey!) && await exists(before.assets!.thumb!), 'files kept');
    // Restoring the version brings it back.
    const r = await owner.req('POST', `/api/projects/${pid}/versions/${v.json.id}/restore`, {});
    assert.equal(r.status, 200, r.text);
    assert.ok((await doc()).doc.media.some((m) => m.id === 'm01'));
  });

  it('restoring a version moves media it does not know to the bin instead of losing it', async () => {
    const v = (await owner.req('GET', `/api/projects/${pid}/versions`)).json.versions.at(-1);
    const r = await owner.req('POST', `/api/projects/${pid}/versions/${v.id}/restore`, {}); // the import: before any uploads were processed
    assert.equal(r.status, 200, r.text);
    const d = (await doc()).doc;
    assert.equal(validate(d).filter((i) => i.level === 'error').length, 0);
    assert.equal(d.media.length + (d.removed?.length ?? 0), 20, 'nothing lost');
  });

  it('deletes removed items for good: out of every version, files erased, and no edit can bring them back', async () => {
    const before = (await doc()).doc.media.find((m) => m.id === 'm02')!;
    const v = await owner.req('POST', `/api/projects/${pid}/versions`, { label: 'With m02' });
    assert.equal((await edit('Remove item', (p) => removeMedia(p, ['m02'], new Date().toISOString(), ownerId))).status, 200);
    const stale = (await doc()).doc; // a browser that still remembers m02 in its bin
    assert.equal((await contributor.req('POST', `/api/projects/${pid}/media/purge`, { mediaIds: ['m02'] })).status, 403, 'contributors cannot');
    assert.deepEqual((await editor.req('POST', `/api/projects/${pid}/media/purge`, { mediaIds: ['m02', 'm03'] })).json.deleted, ['m02'], 'only items in the bin');
    const d = (await doc()).doc;
    assert.ok(!d.media.some((m) => m.id === 'm02') && !(d.removed ?? []).some((r) => r.item.id === 'm02'));
    assert.ok(!(await exists(before.storageKey!)) && !(await exists(before.assets!.thumb!)) && !(await dirExists(`derived/${pid}/m02`)), 'files erased');
    const snaps = app.db.all<{ snapshot: string }>('SELECT snapshot FROM versions WHERE project_id = ?', pid);
    assert.ok(snaps.every((s) => !s.snapshot.includes('"m02"')), 'gone from every saved version');
    assert.equal((await owner.req('POST', `/api/projects/${pid}/versions/${v.json.id}/restore`, {})).status, 200);
    assert.ok(!(await doc()).doc.media.some((m) => m.id === 'm02'), 'restoring the version does not bring it back');
    const undo = await edit('Undo', () => restoreMedia(stale, ['m02']));
    assert.equal(undo.status, 409);
    assert.equal(undo.json.code, 'purged');
  });

  it('deletes items automatically once they have been in the bin for the set number of days', async () => {
    const before = (await doc()).doc.media.find((m) => m.id === 'm03')!;
    const longAgo = new Date(Date.now() - 31 * 86_400_000).toISOString();
    assert.equal((await edit('Remove item', (p) => removeMedia(p, ['m03'], longAgo, ownerId))).status, 200);
    assert.equal((await edit('Remove item', (p) => removeMedia(p, ['m04'], new Date().toISOString(), ownerId))).status, 200);
    assert.equal(await app.deletion.sweep(), 1);
    const d = (await doc()).doc;
    assert.deepEqual((d.removed ?? []).map((r) => r.item.id).filter((id) => id === 'm03' || id === 'm04'), ['m04'], 'only the expired one');
    assert.ok(!(await exists(before.storageKey!)));
    assert.deepEqual(expiredRemovals(d, Date.now(), 30), []);
  });
});

describe('deleting a project', () => {
  it('only the owner, only with the exact title, and then everything is gone', async () => {
    const title = (await doc()).doc.title;
    const keys = (await doc()).doc.media.filter((m) => m.storageKey).map((m) => m.storageKey!);
    assert.ok(keys.length > 0 && await exists(keys[0]));
    assert.equal((await editor.req('DELETE', `/api/projects/${pid}`, { confirmTitle: title })).status, 403);
    assert.equal((await owner.req('DELETE', `/api/projects/${pid}`, { confirmTitle: 'Portugal' })).status, 400);
    const r = await owner.req('DELETE', `/api/projects/${pid}`, { confirmTitle: ` ${title} ` });
    assert.equal(r.status, 200, r.text);
    assert.equal((await owner.req('GET', `/api/projects/${pid}`)).status, 404);
    assert.ok(!(await owner.req('GET', '/api/projects')).json.projects.some((p: { id: string }) => p.id === pid));
    for (const k of keys) assert.ok(!(await exists(k)), k);
    assert.ok(!(await dirExists(`originals/${pid}`)) && !(await dirExists(`derived/${pid}`)));
    for (const t of ['members', 'operations', 'versions', 'uploads', 'jobs', 'purged_media', 'invites']) {
      assert.equal(app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, pid)!.n, 0, t);
    }
  });
});
