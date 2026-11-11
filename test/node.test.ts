import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, promises as fs, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseProject, setTitle, type Travelogue } from '../src/core/index.js';
import { applyProbes, buildCache, CacheLocationError, readManifest } from '../src/node/cache.js';
import { serve } from '../src/node/server.js';
import { autosavePath, autosaveProject, discardRecovery, openProject, saveProject } from '../src/node/storage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.resolve(here, '../samples/hand-written-20');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tripalogue-test-'));
after(() => fs.rm(tmp, { recursive: true, force: true }));

/** Copy the sample's project file (and link its media folder) into a fresh dir. */
async function sampleCopy(name: string): Promise<string> {
  const dir = path.join(tmp, name);
  await fs.mkdir(dir, { recursive: true });
  cpSync(path.join(SAMPLE_DIR, 'trip.travelogue.json'), path.join(dir, 'trip.travelogue.json'));
  await fs.symlink(path.join(SAMPLE_DIR, 'media'), path.join(dir, 'media'));
  return path.join(dir, 'trip.travelogue.json');
}

describe('storage: atomic save, autosave, recovery (F-1)', () => {
  it('saves atomically and leaves no temp files behind', async () => {
    const file = await sampleCopy('save');
    const { project } = await openProject(file);
    await saveProject(file, setTitle(project, 'Saved'));
    const names = await fs.readdir(path.dirname(file));
    assert.ok(!names.some((n) => n.endsWith('.tmp')), names.join());
    assert.equal((await openProject(file)).project.title, 'Saved');
  });

  it('offers a newer autosave as crash recovery, and a save clears it', async () => {
    const file = await sampleCopy('recover');
    const { project } = await openProject(file);
    await autosaveProject(file, setTitle(project, 'Unsaved work'));
    const later = new Date(Date.now() + 5000);
    utimesSync(autosavePath(file), later, later);
    const r = await openProject(file);
    assert.equal(r.project.title, 'Portugal in Ten Days');
    assert.equal(r.recovery?.project.title, 'Unsaved work');
    await saveProject(file, r.recovery!.project);
    assert.equal((await openProject(file)).recovery, undefined);
    await assert.rejects(fs.access(autosavePath(file)));
  });

  it('ignores a corrupt autosave and still opens the project', async () => {
    const file = await sampleCopy('corrupt');
    await fs.writeFile(autosavePath(file), '{"half": ');
    const later = new Date(Date.now() + 5000);
    utimesSync(autosavePath(file), later, later);
    const r = await openProject(file);
    assert.equal(r.recovery, undefined);
    await discardRecovery(file);
  });
});

describe('thumbnail and proxy cache (F-4)', () => {
  let file: string;
  let project: Travelogue;
  const root = path.join(tmp, 'cache-root');
  before(async () => {
    file = await sampleCopy('cache');
    const p = (await openProject(file)).project;
    // Keep the test quick: one still and one clip.
    project = { ...p, media: p.media.filter((m) => m.id === 'm01' || m.id === 'm05'), cues: p.cues.filter((c) => c.itemId === 'm01' || c.itemId === 'm05') };
  });

  it('builds thumbnails and proxies outside the project, with probed sizes', async () => {
    const { manifest } = await buildCache(file, project, { root });
    const still = manifest.entries.m01;
    const clip = manifest.entries.m05;
    assert.equal(still.error, undefined);
    assert.deepEqual([still.probe?.width, still.probe?.height, still.probe?.durationSec], [1600, 1200, undefined]);
    assert.equal(clip.probe?.durationSec, 6);
    assert.equal(clip.probe?.hasAudio, true);
    for (const rel of [still.thumb, still.proxy, clip.thumb, clip.proxy]) await fs.access(path.join(root, rel!));
    assert.deepEqual((await fs.readdir(path.join(SAMPLE_DIR, 'media'))).filter((n) => !/\.(jpg|mp4)$/.test(n)), [], 'nothing written into the media folder');
    assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['media', 'trip.travelogue.json'], 'nothing written next to the project');
    assert.deepEqual(await readManifest(root, project.id), JSON.parse(JSON.stringify(manifest)));
  });

  it('reuses entries for unchanged files and rebuilds when the original changes', async () => {
    const first = (await readManifest(root, project.id))!;
    const again = (await buildCache(file, project, { root })).manifest;
    assert.equal(again.entries.m01.thumb, first.entries.m01.thumb);
    const media = path.join(path.dirname(file), 'm-copy');
    await fs.mkdir(media);
    const copy = path.join(media, 'ch1-01-alfama.jpg');
    cpSync(path.join(SAMPLE_DIR, 'media/ch1-01-alfama.jpg'), copy);
    const p2: Travelogue = { ...project, sources: [{ ...project.sources[0], rootPath: 'm-copy' }], media: [project.media[0]], cues: [project.cues[0]] };
    const a = (await buildCache(file, p2, { root })).manifest.entries.m01.thumb;
    const later = new Date(Date.now() + 10_000);
    utimesSync(copy, later, later);
    const b = (await buildCache(file, p2, { root })).manifest.entries.m01.thumb;
    assert.notEqual(a, b);
  });

  it('records an error for missing media instead of failing the whole build', async () => {
    const broken: Travelogue = { ...project, media: [{ ...project.media[0], uri: 'missing.jpg' }] };
    const { manifest } = await buildCache(file, broken, { root });
    assert.match(manifest.entries.m01.error ?? '', /missing\.jpg|No such file/);
  });

  it('refuses a cache folder inside the project or a media folder, even through a symlink', async () => {
    for (const bad of [path.dirname(file), path.join(path.dirname(file), 'media', 'cache'), path.join(path.dirname(file), 'thumbs')]) {
      await assert.rejects(buildCache(file, project, { root: bad }), CacheLocationError, bad);
    }
    assert.deepEqual((await fs.readdir(path.join(SAMPLE_DIR, 'media'))).filter((n) => !/\.(jpg|mp4)$/.test(n)), []);
  });

  it('applyProbes fills only unknown sizes and durations', () => {
    const bare: Travelogue = { ...project, media: project.media.map(({ width: _w, height: _h, durationSec: _d, ...m }) => m) };
    const m = { format: 1, projectId: project.id, builtAt: '', entries: { m01: { itemId: 'm01', probe: { width: 10, height: 20 } }, m05: { itemId: 'm05', probe: { width: 1, height: 2, durationSec: 6 } } } };
    const out = applyProbes(bare, m);
    assert.deepEqual(out.media.map((x) => [x.width, x.height, x.durationSec]), [[10, 20, undefined], [1, 2, 6]]);
    assert.equal(applyProbes(out, m), out, 'no change returns the same object');
  });
});

describe('local preview server', () => {
  let s: Awaited<ReturnType<typeof serve>>;
  let teleDir: string;
  before(async () => {
    const file = await sampleCopy('serve');
    const playerDir = path.join(tmp, 'player');
    await fs.mkdir(playerDir, { recursive: true });
    await fs.writeFile(path.join(playerDir, 'index.html'), '<!doctype html>ok');
    teleDir = path.join(tmp, 'telemetry');
    s = await serve({ projectFile: file, playerDir, cacheRoot: path.join(tmp, 'empty-cache'), telemetryDir: teleDir });
  });
  after(() => s.close());

  it('serves the project and media by id, with byte ranges for video seeking', async () => {
    const proj = await fetch(new URL('api/project', s.url));
    assert.equal(parseProject(await proj.text()).project.id, 'trv-sample-portugal');
    const full = await fetch(new URL('api/media/m05', s.url));
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    const size = Number(full.headers.get('content-length'));
    await full.arrayBuffer();
    const part = await fetch(new URL('api/media/m05', s.url), { headers: { Range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 100-199/${size}`);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
  });

  it('never serves files outside the player folder or unknown media', async () => {
    assert.equal((await fetch(new URL('api/media/nope', s.url))).status, 404);
    const res = await fetch(`${s.url}..%2f..%2fetc%2fpasswd`);
    assert.ok([403, 404].includes(res.status), String(res.status));
    assert.equal((await fetch(new URL('index.html', s.url))).status, 200);
  });

  it('reports no cache, and writes opt-in telemetry as JSON lines', async () => {
    assert.deepEqual(await (await fetch(new URL('api/cache-manifest', s.url))).json(), { available: false, items: {} });
    const res = await fetch(new URL('api/telemetry', s.url), { method: 'POST', body: JSON.stringify([{ name: 'player_play', sessionId: 's-1', at: 1, props: {} }]) });
    assert.equal(res.status, 204);
    assert.match(await fs.readFile(path.join(teleDir, 's-1.jsonl'), 'utf8'), /player_play/);
  });
});
