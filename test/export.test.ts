/**
 * Phase 4: the export plan (pure) and the server's MP4 render, on the sample trip.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildTimeline, exportSize, frameAt, frameTime, parseProject, planVideo, resolveRange, settingsProblem, audioSources, exportFileName, DEFAULT_EXPORT,
  type ExportSettings, type Travelogue,
} from '../src/core/index.js';
import { startApp, type App } from '../src/server/app.js';
import { geoConfigFromEnv } from '../src/server/geo.js';
import type { ExportInfo } from '../src/server/exports.js';
import { withExif } from '../src/server/heif.js';
import { exifTiff } from './helpers/heic.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.resolve(here, '../samples/hand-written-20');
const sample = () => parseProject(readFileSync(path.join(SAMPLE_DIR, 'trip.travelogue.json'), 'utf8')).project;
const sizeOf = (item: { width?: number; height?: number }) => (item.width && item.height ? { w: item.width, h: item.height } : undefined);

describe('export plan', () => {
  it('sizes every resolution and aspect (VX-1, VX-6)', () => {
    assert.deepEqual(exportSize('1080p', '16:9'), { w: 1920, h: 1080 });
    assert.deepEqual(exportSize('720p', '16:9'), { w: 1280, h: 720 });
    assert.deepEqual(exportSize('4k', '16:9'), { w: 3840, h: 2160 });
    assert.deepEqual(exportSize('1080p', '9:16'), { w: 1080, h: 1920 });
    assert.deepEqual(exportSize('1080p', '1:1'), { w: 1080, h: 1080 });
    assert.deepEqual(exportSize('4k', '9:16'), { w: 2160, h: 3840 });
  });

  it('plans one frame per 1/30 s of the range; frame k is the travelogue at start + k/30 (VX-2)', () => {
    const tl = buildTimeline(sample());
    const plan = planVideo(tl, DEFAULT_EXPORT);
    assert.equal(plan.totalFrames, Math.round(tl.duration * 30));
    assert.equal(frameTime(plan, 90), 3);
    const ch = tl.chapters[1];
    const one = planVideo(tl, { ...DEFAULT_EXPORT, range: { kind: 'chapter', chapterId: ch.chapterId } });
    assert.equal(one.start, ch.start);
    assert.equal(one.totalFrames, Math.round((ch.end - ch.start) * 30));
    assert.equal(frameTime(one, 0), ch.start);
    const span = planVideo(tl, { ...DEFAULT_EXPORT, range: { kind: 'span', from: 3.25, to: 10 } });
    assert.equal(span.totalFrames, Math.round(6.75 * 30));
    assert.deepEqual(resolveRange(tl, { kind: 'span', from: 0, to: 1e6 }), { start: 0, end: tl.duration });
    assert.throws(() => resolveRange(tl, { kind: 'chapter', chapterId: 'nope' }));
    assert.deepEqual(planVideo(tl, { ...DEFAULT_EXPORT, aspect: '9:16' }).size, { w: 1080, h: 1920 });
  });

  it('checks settings and names files', () => {
    assert.equal(settingsProblem(DEFAULT_EXPORT), undefined);
    assert.match(settingsProblem({ ...DEFAULT_EXPORT, resolution: '8k' as never })!, /resolution/);
    assert.match(settingsProblem({ ...DEFAULT_EXPORT, range: { kind: 'span', from: 5, to: 2 } })!, /from < to/);
    const tl = buildTimeline(sample());
    assert.equal(exportFileName('Portugal', tl, DEFAULT_EXPORT), 'Portugal - 1080p.mp4');
    assert.equal(exportFileName('Portugal', tl, { ...DEFAULT_EXPORT, aspect: '9:16', range: { kind: 'chapter', chapterId: tl.chapters[1].chapterId } }), `Portugal - ${tl.chapters[1].title} - 1080p 9x16.mp4`);
  });

  it('lists the sound sources a range needs', () => {
    const tl = buildTimeline(sample());
    const src = audioSources(tl, 0, tl.duration);
    assert.equal(src.filter((s) => s.kind === 'video').length, 4, 'each video\'s own sound');
  });
});

// ---------------------------------------------------------------- the render

const tmp = mkdtempSync(path.join(os.tmpdir(), 'tripalogue-export-'));
let app: App;
let pid = '';

async function req(method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-tripalogue-client'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(new URL(p, app.url), { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function uploadFile(file: string, mediaId?: string) {
  const data = await fs.readFile(file);
  const created = await req('POST', `/api/projects/${pid}/uploads`, { fileName: path.basename(file), size: data.length, ...(mediaId ? { mediaId } : {}) });
  assert.equal(created.status, 201, created.text);
  let offset = created.json.offset;
  while (offset < data.length) {
    const res = await fetch(new URL(`/api/uploads/${created.json.uploadId}?offset=${offset}`, app.url), { method: 'PUT', headers: { 'x-tripalogue-client': '1' }, body: data.subarray(offset, offset + created.json.chunkBytes) });
    offset = (await res.json() as { offset: number }).offset;
  }
  return created.json.mediaId as string;
}
async function waitFor(id: string, done = (e: ExportInfo) => !['queued', 'running'].includes(e.status), timeoutMs = 240_000): Promise<ExportInfo> {
  const t0 = Date.now();
  for (;;) {
    const e = (await req('GET', `/api/projects/${pid}/renders`)).json.renders.find((x: ExportInfo) => x.id === id) as ExportInfo;
    if (done(e)) return e;
    if (Date.now() - t0 > timeoutMs) throw new Error(`export ${id} still ${e.status} at ${e.progress}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
const ffprobeJson = async (file: string) => JSON.parse((await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-count_frames', file])).stdout);
async function pixel(file: string, t: number, x: number, y: number): Promise<[number, number, number]> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
  return [stdout[0], stdout[1], stdout[2]];
}
const chapterExport = (chapterId: string, extra: Partial<ExportSettings> = {}): ExportSettings => ({ ...DEFAULT_EXPORT, resolution: '720p', range: { kind: 'chapter', chapterId }, ...extra });

describe('MP4 export from the originals', { timeout: 900_000 }, () => {
  before(async () => {
    // The export page the render worker opens (normally built by npm run build).
    const web = path.join(tmp, 'web');
    await fs.mkdir(web, { recursive: true });
    const esbuild = await import('esbuild');
    await esbuild.build({ entryPoints: [path.resolve(here, '../src/web/render-page.ts')], outfile: path.join(web, 'render.js'), bundle: true, format: 'iife', logLevel: 'error' });
    await esbuild.build({ entryPoints: [path.resolve(here, '../src/web/render-worker.ts')], outfile: path.join(web, 'render-worker.js'), bundle: true, format: 'iife', logLevel: 'error' });
    await fs.copyFile(path.resolve(here, '../src/web/render.html'), path.join(web, 'render.html'));
    app = await startApp({ dataDir: tmp, port: 0, log: () => {}, webDir: web, geo: geoConfigFromEnv(tmp, { tileUrl: '', geocoderUrl: '' }) });
    const imported = await req('POST', '/api/projects/import', readFileSync(path.join(SAMPLE_DIR, 'trip.travelogue.json'), 'utf8'));
    assert.equal(imported.status, 201, imported.text);
    pid = imported.json.id;
    const doc = (await req('GET', `/api/projects/${pid}`)).json.project as Travelogue;
    for (const m of doc.media) await uploadFile(path.join(SAMPLE_DIR, 'media', m.uri), m.id);
    // A 40 s song laid under the first chapter, on the Music lane.
    const song = path.join(tmp, 'song.m4a');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=40', '-c:a', 'aac', '-b:a', '96k', song]);
    const songId = await uploadFile(song);
    await app.jobs.idle();
    app.projects.serverChange(pid, app.auth.user.id, 'Place the song', (d) => ({
      ...d, cues: d.cues.map((c) => (c.itemId === songId ? { ...c, audio: { laneId: 'lane-music', anchor: { type: 'chapterTime', chapterId: d.chapters[0].id, offsetSec: 0 }, fadeInSec: 1, fadeOutSec: 1, duck: false } } : c)),
    }));
  });
  after(async () => {
    await app.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  let firstFile = '';
  let firstInfo: ExportInfo;

  it('renders a chapter to an H.264/AAC MP4 with exactly the planned frames, normalised to -16 LUFS (VX-1, VX-9)', async () => {
    const doc = (await req('GET', `/api/projects/${pid}`)).json.project as Travelogue;
    const tl = buildTimeline(doc);
    const ch = tl.chapters[0];
    const settings = chapterExport(ch.chapterId);
    const plan = planVideo(tl, settings);
    const created = await req('POST', `/api/projects/${pid}/renders`, { settings });
    assert.equal(created.status, 201, created.text);
    const done = await waitFor(created.json.render.id);
    assert.equal(done.status, 'done', JSON.stringify(done.error));
    firstInfo = done;
    firstFile = done.path!;
    const info = await ffprobeJson(firstFile);
    const v = info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    const a = info.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
    assert.equal(v.codec_name, 'h264');
    assert.equal(v.pix_fmt, 'yuv420p');
    assert.deepEqual([v.width, v.height], [1280, 720]);
    assert.equal(v.r_frame_rate, '30/1');
    assert.equal(Number(v.nb_read_frames), plan.totalFrames, 'every planned frame, no more, no less');
    assert.equal(a.codec_name, 'aac');
    assert.equal(a.channels, 2);
    assert.equal(Number(a.sample_rate), 48000);
    assert.ok(Math.abs(Number(info.format.duration) - plan.totalFrames / 30) < 0.08, `duration ${info.format.duration}`);
    // Loudness of the whole file.
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', firstFile, '-map', '0:a', '-af', 'ebur128', '-f', 'null', '-']);
    const lufs = Number(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(stderr)?.[1]);
    assert.ok(Math.abs(lufs + 16) < 1.5, `integrated loudness ${lufs} LUFS`);
    assert.match(done.name, /720p\.mp4$/);
    assert.equal(path.basename(firstFile), done.name, 'saved under its readable name');
  });

  it('draws the frames the preview draws: black where a fade starts, the picture where it is fully in', async () => {
    const doc = (await req('GET', `/api/projects/${pid}`)).json.project as Travelogue;
    const tl = buildTimeline(doc);
    const black = await pixel(firstFile, 0, 640, 360);
    assert.ok(black.every((c) => c < 24), `first frame is black (title fading in): ${black}`);
    const seg = tl.segments.find((x) => x.chapterIndex === 0 && x.kind === 'image' && x.cue.placement.mode === 'fit')!;
    assert.ok(seg && seg.kind === 'image');
    const mid = seg.start + seg.duration / 2 - tl.chapters[0].start;
    const got = await pixel(firstFile, mid, 640, 360);
    // The original's centre pixel, fitted and centred as the preview places it.
    const layer = frameAt(tl, seg.start + seg.duration / 2, { w: 1280, h: 720 }, sizeOf).layers[0];
    assert.ok(layer.kind === 'image');
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', path.join(SAMPLE_DIR, 'media', seg.item.uri), '-vf', `scale=${Math.round(layer.dst.w)}:${Math.round(layer.dst.h)},format=rgb24,crop=1:1:${Math.round(640 - layer.dst.x)}:${Math.round(360 - layer.dst.y)}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
    const want = [stdout[0], stdout[1], stdout[2]];
    assert.ok(got.every((c, i) => Math.abs(c - want[i]) < 24), `centre ${got} vs original ${want}`);
  });

  it('downloads the file, with its name, and marks it seen', async () => {
    const res = await fetch(new URL(`/api/projects/${pid}/renders/${firstInfo.id}/file`, app.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename=/);
    assert.equal(Number(res.headers.get('content-length')), (await fs.stat(firstFile)).size);
    await res.arrayBuffer();
    const ranged = await fetch(new URL(`/api/projects/${pid}/renders/${firstInfo.id}/file`, app.url), { headers: { range: 'bytes=0-99' } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);
    const after = (await req('GET', `/api/projects/${pid}/renders`)).json.renders.find((x: ExportInfo) => x.id === firstInfo.id);
    assert.equal(after.seen, true);
  });

  it('renders the same frames every time (deterministic export)', async () => {
    const doc = (await req('GET', `/api/projects/${pid}`)).json.project as Travelogue;
    const created = await req('POST', `/api/projects/${pid}/renders`, { settings: chapterExport(doc.chapters[0].id) });
    const again = await waitFor(created.json.render.id);
    assert.equal(again.status, 'done');
    const md5 = async (f: string) => (await run('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v', '-f', 'md5', '-'])).stdout.trim();
    assert.equal(await md5(again.path!), await md5(firstFile));
  });

  it('exports a 9:16 square-free phone version of a chapter (VX-6)', async () => {
    const doc = (await req('GET', `/api/projects/${pid}`)).json.project as Travelogue;
    const created = await req('POST', `/api/projects/${pid}/renders`, { settings: chapterExport(doc.chapters[1].id, { aspect: '9:16' }) });
    const done = await waitFor(created.json.render.id);
    assert.equal(done.status, 'done', JSON.stringify(done.error));
    const v = (await ffprobeJson(done.path!)).streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    assert.deepEqual([v.width, v.height], [720, 1280]);
  });

  it('cancels an export; it leaves no file (VX-3)', async () => {
    const created = await req('POST', `/api/projects/${pid}/renders`, { settings: { ...DEFAULT_EXPORT, resolution: '720p' } });
    const id = created.json.render.id;
    await waitFor(id, (e) => e.status === 'running' && e.progress > 0);
    const c = await req('POST', `/api/projects/${pid}/renders/${id}/cancel`);
    assert.equal(c.status, 200);
    const done = await waitFor(id);
    assert.equal(done.status, 'cancelled');
    assert.equal(done.path, null);
    assert.deepEqual((await fs.readdir(path.join(tmp, 'exports', pid, id)).catch(() => [])).filter((f) => f.endsWith('.mp4')), []);
  });

  it('reports progress and time remaining while it runs, and keeps the snapshot it started from', async () => {
    const doc = (await req('GET', `/api/projects/${pid}`)).json.project as Travelogue;
    const created = await req('POST', `/api/projects/${pid}/renders`, { settings: chapterExport(doc.chapters[2].id) });
    const id = created.json.render.id;
    const mid = await waitFor(id, (e) => e.status === 'running' && e.progress > 0.1 && e.etaSec !== null);
    assert.ok(mid.etaSec! >= 0 && mid.step);
    // Editing meanwhile: the export still renders the travelogue as it was.
    app.projects.serverChange(pid, app.auth.user.id, 'Rename', (d) => ({ ...d, chapters: d.chapters.map((c, i) => (i === 2 ? { ...c, title: 'Renamed later' } : c)) }));
    const done = await waitFor(id);
    assert.equal(done.status, 'done');
    assert.equal(done.rev, created.json.render.rev);
    assert.doesNotMatch(done.name, /Renamed later/);
  });

  it('names the item that failed when an original is missing, and links to it (VX-4)', async () => {
    const doc = (await req('GET', `/api/projects/${pid}`)).json.project as Travelogue;
    const victim = doc.media.find((m) => m.chapterId === doc.chapters[3].id && m.kind === 'image')!;
    const file = await app.blobs.localPath(victim.storageKey!);
    await fs.rename(file, `${file}.away`);
    try {
      const created = await req('POST', `/api/projects/${pid}/renders`, { settings: chapterExport(doc.chapters[3].id) });
      const done = await waitFor(created.json.render.id);
      assert.equal(done.status, 'failed');
      assert.equal(done.error?.itemId, victim.id, JSON.stringify(done.error));
      assert.equal(done.error?.reason, 'missing');
      assert.match(done.error!.message, new RegExp(victim.uri.replace('.', '\\.')));
      assert.equal(done.seen, false, 'a failure is news too');
    } finally {
      await fs.rename(`${file}.away`, file);
    }
  });

  it('starts an interrupted export again when TripAlogue restarts (VX-10)', async () => {
    const doc = (await req('GET', `/api/projects/${pid}`)).json.project as Travelogue;
    const created = await req('POST', `/api/projects/${pid}/renders`, { settings: chapterExport(doc.chapters[1].id) });
    const id = created.json.render.id;
    await waitFor(id, (e) => e.status === 'running' && e.progress > 0);
    await app.exports.stop();
    assert.equal(app.exports.get(pid, id).status, 'queued');
    app.exports.start();
    const done = await waitFor(id);
    assert.equal(done.status, 'done', JSON.stringify(done.error));
  });

  it('keeps a sideways-stored phone photo upright and unstretched, even when the project recorded its sideways size', async () => {
    // Blue, with a red block top-left, stored 320×240 and tagged "turn a quarter clockwise": upright it is 240×320, red top-right.
    const plain = path.join(tmp, 'side.jpg');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240,drawbox=x=0:y=0:w=80:h=60:c=red:t=fill', '-frames:v', '1', plain]);
    const tagged = path.join(tmp, 'IMG_SIDE.jpg');
    await fs.writeFile(tagged, withExif(await fs.readFile(plain), exifTiff('2026:05:04 09:00:00', 6)));
    const id = await uploadFile(tagged);
    await app.jobs.idle();
    // As an older version recorded it: the stored (sideways) size. Put it first in chapter 1, filling the frame.
    app.projects.serverChange(pid, app.auth.user.id, 'Old size', (d) => ({
      ...d,
      media: d.media.map((m) => (m.id === id ? { ...m, width: 320, height: 240, chapterId: d.chapters[0].id, chapterLocked: true } : m)),
      cues: d.cues.map((c) => (c.itemId === id ? { ...c, order: '1', durationSec: 4, placement: { mode: 'fill' as const } } : c)),
    }));
    const doc = (await req('GET', `/api/projects/${pid}`)).json.project as Travelogue;
    const tl = buildTimeline(doc);
    const seg = tl.segments.find((x) => x.kind !== 'title' && x.item.id === id)!;
    const created = await req('POST', `/api/projects/${pid}/renders`, { settings: chapterExport(doc.chapters[0].id) });
    const done = await waitFor(created.json.render.id);
    assert.equal(done.status, 'done', JSON.stringify(done.error));
    const mid = seg.start + seg.duration / 2 - tl.chapters[0].start;
    // Filling a 1280×720 frame with an upright portrait picture crops a band across its middle: all blue.
    // Stretched to the frame instead, its red corner would show at the top right.
    const corner = await pixel(done.path!, mid, 1270, 10);
    const centre = await pixel(done.path!, mid, 640, 360);
    assert.ok(corner[2] > 150 && corner[0] < 90, `top-right is blue, not the red corner: ${corner}`);
    assert.ok(centre[2] > 150 && centre[0] < 90, `centre is blue: ${centre}`);
    // Processing again (here a retry after a failure) records the upright size over the old one.
    app.projects.serverChange(pid, app.auth.user.id, 'Fail', (d) => ({ ...d, media: d.media.map((m) => (m.id === id ? { ...m, status: 'failed' as const } : m)) }));
    await req('POST', `/api/projects/${pid}/media/retry`, { mediaIds: [id] });
    await app.jobs.idle();
    const again = (await req('GET', `/api/projects/${pid}`)).json.project.media.find((m: { id: string }) => m.id === id);
    assert.deepEqual([again.width, again.height], [240, 320]);
  });

  it('refuses bad settings and empty ranges', async () => {
    assert.equal((await req('POST', `/api/projects/${pid}/renders`, { settings: { ...DEFAULT_EXPORT, aspect: '4:3' } })).status, 400);
    assert.equal((await req('POST', `/api/projects/${pid}/renders`, { settings: { ...DEFAULT_EXPORT, range: { kind: 'chapter', chapterId: 'nope' } } })).status, 400);
  });

  it('deletes an export and its file; deleting the travelogue deletes all its exports', async () => {
    const list = (await req('GET', `/api/projects/${pid}`.concat('/renders'))).json.renders as ExportInfo[];
    const one = list.find((e) => e.status === 'done')!;
    assert.equal((await req('DELETE', `/api/projects/${pid}/renders/${one.id}`)).status, 200);
    await assert.rejects(fs.stat(one.path!));
    const title = (await req('GET', `/api/projects/${pid}`)).json.project.title;
    assert.equal((await req('DELETE', `/api/projects/${pid}`, { confirmTitle: title })).status, 200);
    await assert.rejects(fs.stat(path.join(tmp, 'exports', pid)));
    assert.equal(app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM exports WHERE project_id = ?', pid)?.n, 0);
  });
});
