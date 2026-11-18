/**
 * Phase 4 browser test: export to MP4, scripted like the G4 tasks.
 *
 * Imports the sample trip (four chapters, 16 photos, 4 videos) with a song under the first chapter and a short
 * narration beep anchored to a photo in the third, then from the Export MP4 dialog:
 *   1. exports the whole travelogue at 1080p while the user keeps editing, and times it against its length;
 *   2. checks the file: H.264 High / AAC, plays from the start (faststart), -16 LUFS, every frame present;
 *   3. compares 5 random frames of the export with the preview drawing the same moment (acceptance);
 *   4. checks the narration starts within one frame of its picture (audio sync);
 *   5. exports one chapter as a 9:16 phone video, closes the window meanwhile, and finds the "ready" notice later;
 *   6. cancels an export; makes one fail on a missing original and follows the link to the item.
 * Report and screenshots go to docs/phase4-test/.
 *
 *   node --import tsx scripts/phase4-test.ts
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Page } from 'playwright';
import { parseProject, serializeProject, type MediaItem, type Travelogue } from '../src/core/index.js';
import { startApp } from '../src/server/app.js';
import { geoConfigFromEnv } from '../src/server/geo.js';
import type { RenderInfo } from '../src/web/api.js';
import type {} from '../src/web/main.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/phase4-test');
const sampleDir = path.join(root, 'samples/hand-written-20');

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) await fs.rm(path.join(outDir, f));
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tripalogue-p4-'));
const gen = path.join(dataDir, 'generated');
mkdirSync(gen);

// ---- the sample trip, plus a song under Lisbon and a narration beep on a photo in Porto ----
const song = path.join(gen, 'Fado song.m4a');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=40', '-c:a', 'aac', '-b:a', '96k', song]);
const beep = path.join(gen, 'Beep.wav');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.3', '-af', 'apad=pad_dur=0.7', beep]);
const sample = parseProject(readFileSync(path.join(sampleDir, 'trip.travelogue.json'), 'utf8')).project;
const porto = sample.chapters[2];
const portoPhoto = sample.media.find((m) => m.chapterId === porto.id && m.kind === 'image')!;
const audioItems: MediaItem[] = [
  { id: 'a-song', sourceId: sample.sources[0].id, uri: 'Fado song.m4a', kind: 'audio', chapterId: null },
  { id: 'a-beep', sourceId: sample.sources[0].id, uri: 'Beep.wav', kind: 'audio', chapterId: null },
];
const base = sample.cues[0];
const trip: Travelogue = {
  ...sample, title: 'Portugal export test', media: [...sample.media, ...audioItems],
  cues: [...sample.cues,
    { ...base, itemId: 'a-song', order: 'zy', audio: { laneId: 'lane-music', anchor: { type: 'chapterTime', chapterId: sample.chapters[0].id, offsetSec: 0 }, fadeInSec: 1, fadeOutSec: 1, duck: false } },
    { ...base, itemId: 'a-beep', order: 'zz', audio: { laneId: 'lane-narration', anchor: { type: 'item', itemId: portoPhoto.id, offsetSec: 0 }, fadeInSec: 0, fadeOutSec: 0, duck: true } },
  ],
};
const tripFile = path.join(gen, 'trip.travelogue.json');
writeFileSync(tripFile, serializeProject(trip));
const tripMedia = [...readdirSync(path.join(sampleDir, 'media')).map((f) => path.join(sampleDir, 'media', f)), song, beep];

const app = await startApp({ dataDir, port: 0, log: () => {}, geo: geoConfigFromEnv(dataDir, { tileUrl: '', geocoderUrl: '' }) });
// A UTF-8 locale, as on people's computers (downloads keep accented names).
const browser = await chromium.launch({ env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
let page = await context.newPage();
const consoleErrors: string[] = [];
const watch = (p: Page) => {
  p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  p.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
};
watch(page);
const shot = (name: string) => page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
const renders = async (pid: string) => (await (await fetch(`${app.url}api/projects/${pid}/renders`)).json() as { renders: RenderInfo[] }).renders;
async function waitRender(pid: string, id: string, until = (e: RenderInfo) => !['queued', 'running'].includes(e.status), timeoutMs = 2_400_000) {
  const t0 = Date.now();
  for (;;) {
    const e = (await renders(pid)).find((x) => x.id === id)!;
    if (until(e)) return e;
    if (Date.now() - t0 > timeoutMs) throw new Error(`export still ${e.status}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
/** Start an export from the dialog; returns the new export's id. */
async function startExport(pid: string, o: { resolution?: string; aspect?: string; chapterId?: string } = {}) {
  const before = new Set((await renders(pid)).map((e) => e.id));
  await page.click('#export-open');
  await page.waitForSelector('#export-dialog[open]');
  if (o.resolution) await page.selectOption('#export-resolution', o.resolution);
  if (o.aspect) await page.selectOption('#export-aspect', o.aspect);
  await page.selectOption('#export-part', o.chapterId ? 'chapter' : 'all');
  if (o.chapterId) await page.selectOption('#export-chapter', o.chapterId);
  await page.click('#export-start');
  for (let i = 0; i < 100; i++) {
    const fresh = (await renders(pid)).find((e) => !before.has(e.id));
    if (fresh) return fresh.id;
    await page.waitForTimeout(100);
  }
  throw new Error('the export did not start');
}
const closeDialog = () => page.click('#export-close');
const probeJson = async (f: string, extra: string[] = []) => JSON.parse((await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', ...extra, f])).stdout);
/** A frame as small RGB, for comparing pictures without caring about the last bit of sharpness. */
const SMALL = { w: 192, h: 108 };
async function smallRgb(args: string[]): Promise<Buffer> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', ...args, '-vf', `scale=${SMALL.w}:${SMALL.h}:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
  return stdout;
}
const meanDiff = (a: Buffer, b: Buffer) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };

try {
  // ---- import ----
  await page.goto(`${app.url}#/projects`);
  await page.waitForSelector('#import-json');
  await page.setInputFiles('#import-json', tripFile);
  await page.setInputFiles('#import-media', tripMedia);
  await page.click('#import-start');
  await page.waitForURL(/#\/p\//, { timeout: 180_000 });
  await page.waitForFunction(() => { const s = window.tripalogue?.session?.state; return !!s && s.media.every((m) => m.status === 'ready'); }, null, { timeout: 300_000, polling: 500 });
  const pid = page.url().split('#/p/')[1].split('/')[0];
  await page.click('#view-preview');
  await page.waitForTimeout(300); // the preview takes up the processed project within 40 ms
  const duration = await page.evaluate(() => window.tripalogue!.player!.duration);

  // ---- 1. the whole travelogue at 1080p, editing meanwhile ----
  await page.click('#export-open');
  await page.waitForSelector('#export-dialog[open]');
  const defaults = await page.evaluate(() => ({
    res: (document.getElementById('export-resolution') as HTMLSelectElement).value,
    aspect: (document.getElementById('export-aspect') as HTMLSelectElement).value,
    part: (document.getElementById('export-part') as HTMLSelectElement).value,
    summary: document.getElementById('export-summary')!.textContent ?? '',
  }));
  check('the Export dialog offers 1080p, 16:9, the whole travelogue, and says how long and how big (VX-1)',
    defaults.res === '1080p' && defaults.aspect === '16:9' && defaults.part === 'all' && /1920×1080/.test(defaults.summary) && defaults.summary.startsWith(fmt(duration)),
    defaults.summary);
  await shot('01-export-dialog');
  await closeDialog();
  const t0 = Date.now();
  const fullId = await startExport(pid);
  await waitRender(pid, fullId, (e) => e.status === 'running' && e.progress > 0.15 && e.etaSec !== null);
  await page.waitForSelector(`#export-list .export-row[data-id="${fullId}"] progress`);
  const rowText = await page.textContent(`#export-list .export-row[data-id="${fullId}"] .export-status`);
  await shot('02-export-progress');
  check('while it renders, the dialog shows progress and the time left (VX-3)', /\d+%.*about \d+:\d\d left/.test(rowText ?? ''), rowText ?? '');
  await closeDialog();
  // Keep editing: rename a chapter in the Itinerary view.
  await page.click('#view-itinerary');
  const titleField = page.locator('[aria-label="Chapter title"]').nth(1);
  await titleField.fill('Sintra (edited while exporting)');
  await page.waitForFunction(() => window.tripalogue!.session!.unsaved === 0 && window.tripalogue!.session!.status === 'saved', null, { timeout: 10_000 });
  const stillRunning = (await renders(pid)).find((e) => e.id === fullId)!.status === 'running';
  check('editing goes on while the export renders; the edit is saved (VX-3)', stillRunning && (await page.evaluate(() => window.tripalogue!.session!.state.chapters[1].title)) === 'Sintra (edited while exporting)');
  await page.click('#view-media');
  const full = await waitRender(pid, fullId);
  const elapsed = (Date.now() - t0) / 1000;
  await page.waitForSelector('#export-toast:not([hidden]) #toast-download', { timeout: 15_000 });
  await shot('03-ready-notice');
  check('when the file is ready the app says so, in whichever view is open, with a Download button (VX-10)', full.status === 'done' && await page.isVisible('#toast-download'), full.name);
  const ratio = elapsed / duration;
  check(`renders in at most twice its length (acceptance; this machine has ${os.cpus().length} cores)`, ratio <= 2, `${fmt(duration)} of travelogue in ${elapsed.toFixed(0)} s (${ratio.toFixed(2)}× its length)`);
  const dl = page.waitForEvent('download');
  await page.click('#toast-download');
  const download = await dl;
  check('Download saves the MP4 under the travelogue\'s name', download.suggestedFilename() === 'Portugal export test - 1080p.mp4', download.suggestedFilename());
  await download.cancel().catch(() => {});

  // ---- 2. the file ----
  const file = full.path!;
  const info = await probeJson(file, ['-count_frames']);
  const v = info.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const a = info.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  const head = (await fs.readFile(file)).subarray(0, 4096).toString('latin1');
  const moovFirst = head.indexOf('moov') >= 0 && (head.indexOf('mdat') < 0 || head.indexOf('moov') < head.indexOf('mdat'));
  const frames = Math.round(duration * 30);
  check('H.264 High, 1920×1080 at 30 fps, yuv420p, AAC-LC stereo 48 kHz, playable while it downloads (VX-1; QuickTime, VLC, iOS and Android all take this)',
    v.codec_name === 'h264' && v.profile === 'High' && v.width === 1920 && v.height === 1080 && v.r_frame_rate === '30/1' && v.pix_fmt === 'yuv420p' && Number(v.level) <= 42
      && v.codec_tag_string === 'avc1' && a.codec_name === 'aac' && a.profile === 'LC' && a.channels === 2 && Number(a.sample_rate) === 48000 && moovFirst,
    `${v.codec_name} ${v.profile} level ${v.level}, ${v.width}×${v.height}, ${v.r_frame_rate}, ${v.pix_fmt}; ${a.codec_name} ${a.profile} ${a.channels} ch ${a.sample_rate} Hz; moov first: ${moovFirst}`);
  check('every frame of the travelogue is there', Number(v.nb_read_frames) === frames, `${v.nb_read_frames} frames for ${duration.toFixed(2)} s`);
  const { stderr: r128 } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(r128)?.[1]);
  const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(r128)?.[1]);
  check('narration, music and clip sound mixed into one track at -16 LUFS (VX-9)', Math.abs(lufs + 16) <= 1, `${lufs} LUFS integrated, true peak ${peak} dBFS`);

  // ---- 3. five random frames against the preview ----
  await page.click('#view-preview');
  let seed = 20261118;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const picks = Array.from({ length: 5 }, () => Math.floor(rand() * frames));
  // Plus the middle of the first video, so a video frame is always among them.
  const firstVideo = await page.evaluate(() => { const s = window.tripalogue!.player!.timeline.segments.find((x) => x.kind === 'video')!; return s.start + s.duration / 2; });
  picks.push(Math.floor(firstVideo * 30));
  let control = 0;
  const diffs: string[] = [];
  let worst = 0;
  for (const k of picks) {
    const t = k / 30;
    // Passed as a string: tsx's helpers for named functions do not exist in the page.
    const png = await page.evaluate(`(async () => {
      const time = ${t};
      const p = window.tripalogue.player;
      const canvas = document.getElementById('stage');
      canvas.width = 1920;
      canvas.height = 1080;
      p.pause();
      p.seek(time);
      const seg = p.timeline.segments.find((s) => time >= s.start && time < s.start + s.duration);
      const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
      // Redraw until the player draws the picture itself (no "Loading…" placeholder) and a video sits on its frame.
      for (let i = 0; i < 300; i++) {
        const before = p.stats.placeholderFrames;
        p.redraw();
        await raf(); await raf();
        if (p.stats.placeholderFrames !== before) continue;
        if (seg.kind !== 'video') break;
        const el = p.elementFor(seg.item.id);
        const want = seg.inPointSec + (time - seg.start) * seg.speed;
        if (el && el.readyState >= 2 && !el.seeking && Math.abs(el.currentTime - want) < 0.04) { p.redraw(); await raf(); await raf(); break; }
      }
      return { url: canvas.toDataURL('image/png'), kind: seg.kind };
    })()`) as { url: string; kind: string };
    const pngFile = path.join(dataDir, `preview-${k}.png`);
    await fs.writeFile(pngFile, Buffer.from(png.url.split(',')[1], 'base64'));
    const fromPreview = await smallRgb(['-i', pngFile]);
    const exp = await (async () => {
      const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${k}),scale=${SMALL.w}:${SMALL.h}:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
      return stdout;
    })();
    const d = meanDiff(fromPreview, exp);
    worst = Math.max(worst, d);
    // Control: the same preview frame against an export frame 4 s later should differ clearly.
    const { stdout: other } = await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${(k + 120) % frames}),scale=${SMALL.w}:${SMALL.h}:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
    control += meanDiff(fromPreview, other) / picks.length;
    diffs.push(`frame ${k} (${fmt(t)}, ${png.kind}): ${d.toFixed(1)}`);
    if (k === picks[0]) {
      await fs.copyFile(pngFile, path.join(outDir, '04-preview-frame.png'));
      await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `select=eq(n\\,${k})`, '-frames:v', '1', path.join(outDir, '04-export-frame.png')]);
    }
  }
  check('5 random frames (and a video frame) of the export match the preview at the same moment (acceptance, VX-2)', worst < 10 && control > worst * 2,
    `mean difference per colour value (0–255): ${diffs.join('; ')}; against a frame 4 s off: ${control.toFixed(1)} on average`);

  // ---- 4. narration in sync with its picture ----
  const tl = await page.evaluate(() => {
    const t = window.tripalogue!.player!.timeline;
    return { segs: t.segments.map((s) => ({ id: s.kind === 'title' ? '' : s.item.id, start: s.start })), audio: t.audio.map((c) => ({ id: c.item.id, start: c.start })) };
  });
  const photoStart = tl.segs.find((s) => s.id === portoPhoto.id)!.start;
  const { stdout: pcm } = await run('ffmpeg', ['-v', 'error', '-ss', (photoStart - 0.5).toFixed(3), '-t', '1', '-i', file, '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
  // 1 kHz beep onset: the first 2 ms window whose level jumps well above what came before.
  let onset = NaN;
  const win = 96;
  const level = (i: number) => { let e = 0; for (let j = i; j < i + win; j++) e += samples[j] * samples[j]; return Math.sqrt(e / win); };
  const floor = level(0) + 1e-4;
  for (let i = 0; i + win < samples.length; i += 24) if (level(i) > Math.max(0.05, floor * 6)) { onset = photoStart - 0.5 + i / 48000; break; }
  check('narration starts on its picture, within one frame (audio sync)', Math.abs(onset - photoStart) <= 1 / 30, `beep at ${onset.toFixed(3)} s, picture at ${photoStart.toFixed(3)} s (${((onset - photoStart) * 1000).toFixed(0)} ms)`);

  // ---- 5. one chapter as a 9:16 phone video, with the window closed meanwhile ----
  const lisbon = sample.chapters[0].id;
  const phoneId = await startExport(pid, { resolution: '720p', aspect: '9:16', chapterId: lisbon });
  await page.close();
  const phone = await waitRender(pid, phoneId);
  page = await context.newPage();
  watch(page);
  await page.goto(`${app.url}#/projects`);
  await page.waitForSelector('#export-news');
  const newsText = await page.textContent('#export-news');
  await shot('05-ready-after-reopening');
  const pv = (await probeJson(phone.path!)).streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const lisbonLen = phone.durationSec ?? 0;
  check('one chapter exports as a 9:16 phone video (VX-5, VX-6)', pv.width === 720 && pv.height === 1280 && /Lisbon/.test(phone.name) && lisbonLen > 0, `${phone.name}: ${pv.width}×${pv.height}, ${fmt(lisbonLen)}`);
  check('closing the window does not stop an export; the travelogue list says it is ready when you come back (VX-10)', phone.status === 'done' && /is ready/.test(newsText ?? '') && newsText!.includes(phone.name), newsText?.trim().slice(0, 120));

  // ---- 6. cancel, and a failure that names its item ----
  await page.click('#export-news a[href^="#/p/"]');
  await page.waitForFunction(() => !!window.tripalogue?.player);
  const cancelId = await startExport(pid, { resolution: '720p' });
  await waitRender(pid, cancelId, (e) => e.status === 'running' && e.progress > 0);
  await page.click(`#export-list .export-row[data-id="${cancelId}"] .export-cancel`);
  const cancelled = await waitRender(pid, cancelId);
  await page.waitForSelector(`#export-list .export-row.cancelled[data-id="${cancelId}"]`);
  check('Cancel stops an export and leaves no file (VX-3)', cancelled.status === 'cancelled' && cancelled.path === null);
  await closeDialog();

  const douro = sample.chapters[3];
  const victim = (await page.evaluate(() => window.tripalogue!.session!.state.media)).find((m) => m.chapterId === douro.id && m.kind === 'video')!;
  const original = await app.blobs.localPath(victim.storageKey!);
  await fs.rename(original, `${original}.away`);
  const failId = await startExport(pid, { resolution: '720p', chapterId: douro.id });
  const failed = await waitRender(pid, failId);
  await page.waitForSelector(`#export-list .export-row.failed[data-id="${failId}"] .export-show-item`);
  const errText = await page.textContent(`#export-list .export-row[data-id="${failId}"] .export-error`);
  await shot('06-failure-names-item');
  await page.click(`#export-list .export-row[data-id="${failId}"] .export-show-item`);
  await page.waitForFunction(() => location.hash.endsWith('/media'));
  const selected = await page.evaluate(() => window.tripalogue!.media!.selected());
  await shot('07-failed-item-in-media');
  check('a missing original fails the export with the item\'s name and a link that opens it in Media (VX-4)',
    failed.status === 'failed' && failed.error?.itemId === victim.id && failed.error.reason === 'missing' && errText!.includes(victim.uri) && selected.includes(victim.id),
    errText?.trim());
  await fs.rename(`${original}.away`, original);

  check('no errors in the browser console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ date: new Date().toISOString(), browser: browser.version(), cores: os.cpus().length, checks }, null, 2));
} finally {
  await browser.close();
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
const failedChecks = checks.filter((c) => !c.pass);
console.log(failedChecks.length ? `\n${failedChecks.length} check(s) failed` : `\nAll ${checks.length} checks passed`);
process.exit(failedChecks.length ? 1 : 0);
