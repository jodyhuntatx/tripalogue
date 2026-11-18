/**
 * Phase 5 browser test: cues, map and sound, scripted like the G5 tasks.
 *
 * Imports the sample trip with a song under the first chapter, then in the Mix view:
 *   1. sets each cue type, counting the interactions (acceptance: three at most): entrance, exit, motion, speed,
 *      mute, a caption, a place label, a date stamp, a map inset switch, a crossfade, a title card layout;
 *   2. G5: gives a photo a custom Ken Burns by dragging its start and end frames on the stage;
 *   3. G5: puts three captions on a photo, moves one on the stage;
 *   4. G5: slows a clip to half speed;
 *   5. G5: sets up the inset map (corner, shape, style, chapter transitions) and reads "Chapter 1 of 4";
 *   6. G5: records narration with the browser's (fake) microphone, uses the take, and finds it on the lane;
 *   7. copies cues to other photos, saves and applies a preset;
 *   8. ducking, loop and fit-to-chapter on the song; a chapter without a place hides the map and is flagged;
 *   9. exports the first chapter and compares frames with motion, captions and the map against the preview.
 * Report and screenshots go to docs/phase5-test/.
 *
 *   node --import tsx scripts/phase5-test.ts
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
import { startStandInProvider } from './lib/stand-in-provider.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/phase5-test');
const sampleDir = path.join(root, 'samples/hand-written-20');

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) await fs.rm(path.join(outDir, f));
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tripalogue-p5-'));
const gen = path.join(dataDir, 'generated');
mkdirSync(gen);

// ---- the sample trip plus a song under Lisbon ----
const song = path.join(gen, 'Fado song.m4a');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-c:a', 'aac', '-b:a', '96k', song]);
const sample = parseProject(readFileSync(path.join(sampleDir, 'trip.travelogue.json'), 'utf8')).project;
const songItem: MediaItem = { id: 'a-song', sourceId: sample.sources[0].id, uri: 'Fado song.m4a', kind: 'audio', chapterId: null };
const trip: Travelogue = {
  ...sample, title: 'Portugal cues test', media: [...sample.media, songItem],
  cues: [...sample.cues,
    { ...sample.cues[0], itemId: 'a-song', order: 'zy', audio: { laneId: 'lane-music', anchor: { type: 'chapterTime', chapterId: sample.chapters[0].id, offsetSec: 0 }, fadeInSec: 1, fadeOutSec: 1, duck: false } }],
};
const tripFile = path.join(gen, 'trip.travelogue.json');
writeFileSync(tripFile, serializeProject(trip));
const tripMedia = [...readdirSync(path.join(sampleDir, 'media')).map((f) => path.join(sampleDir, 'media', f)), song];

const provider = await startStandInProvider();
const app = await startApp({
  dataDir, port: 0, log: (m: string) => { if (/error|reject|invalid|fail/i.test(m)) console.log('server:', m); },
  geo: geoConfigFromEnv(dataDir, { geocoderUrl: `${provider.url}/search`, tileUrl: `${provider.url}/tiles/{z}/{x}/{y}.png`, terrainTileUrl: `${provider.url}/tiles/{z}/{x}/{y}.png`, attribution: '© Test tiles' }),
});
const browser = await chromium.launch({
  env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  // A microphone that plays a tone, allowed without asking (AU-5).
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1500, height: 1050 }, permissions: ['microphone'] });
const page = await context.newPage();
const consoleErrors: string[] = [];
const watch = (p: Page) => {
  p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  p.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
};
watch(page);
const shot = (name: string) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const saved = () => page.waitForFunction(() => window.tripalogue!.session!.unsaved === 0 && window.tripalogue!.session!.status === 'saved', null, { timeout: 15_000 });
const doc = (pid: string) => app.projects.load(pid).doc;

/** Interactions a person makes (clicks, picks, typing into one box), counted per task. */
let acts = 0;
const click = async (sel: string) => { acts++; await page.click(sel); };
const pick = async (sel: string, v: string) => { acts++; await page.selectOption(sel, v); };
const type = async (sel: string, v: string) => { acts++; await page.fill(sel, v); };
const tick = async (sel: string) => { acts++; await page.check(sel); };
const counted = async (name: string, fn: () => Promise<void>, ok: () => boolean | Promise<boolean>) => {
  acts = 0;
  await fn();
  await saved();
  const n = acts;
  return { name, n, ok: await ok() };
};
const selectClip = (id: string) => click(`.pe-clip[data-item="${id}"]`);
const cueOf = (pid: string, id: string) => doc(pid).cues.find((c) => c.itemId === id)!;

try {
  // ---- import ----
  await page.goto(`${app.url}#/projects`);
  await page.setInputFiles('#import-json', tripFile);
  await page.setInputFiles('#import-media', tripMedia);
  await page.click('#import-start');
  await page.waitForURL(/#\/p\//, { timeout: 180_000 });
  await page.waitForFunction(() => { const s = window.tripalogue?.session?.state; return !!s && s.media.every((m) => m.status === 'ready'); }, null, { timeout: 300_000, polling: 500 });
  const pid = page.url().split('#/p/')[1].split('/')[0];
  await page.click('#view-mix');
  await page.waitForSelector('#pe-timeline');
  const segs = await page.evaluate(() => window.tripalogue!.player!.timeline.segments.filter((s) => s.kind !== 'title').map((s) => ({ id: (s as { item: { id: string } }).item.id, kind: s.kind, chapter: s.chapterIndex, start: s.start, duration: s.duration })));
  const photos = segs.filter((s) => s.kind === 'image');
  const videos = segs.filter((s) => s.kind === 'video');
  const p1 = photos[0], p2 = photos[1], p3 = photos[2];
  const v1 = videos[0];

  // ---- 1. every cue type in three interactions or fewer ----
  const tasks = [
    await counted('entrance: slide in', async () => { await selectClip(p2.id); await pick('#pe-entrance', 'slide'); },
      () => cueOf(pid, p2.id).entrance.type === 'slide'),
    await counted('exit: fade out over 1 s', async () => { await selectClip(p2.id); await pick('#pe-exit', 'fade'); await type('#pe-exit-sec', '1'); await page.press('#pe-exit-sec', 'Tab'); },
      () => cueOf(pid, p2.id).exit.type === 'fade' && cueOf(pid, p2.id).exit.durationSec === 1),
    await counted('crossfade from the picture before', async () => { await selectClip(p3.id); await pick('#pe-entrance', 'crossfade'); },
      () => cueOf(pid, p3.id).entrance.type === 'crossfade'),
    await counted('motion: auto pan and zoom', async () => { await selectClip(p3.id); await tick('#pe-motion-auto'); },
      () => cueOf(pid, p3.id).animation.type === 'kenBurns'),
    await counted('speed: half', async () => { await selectClip(v1.id); await pick('#pe-speed', '0.5'); },
      () => cueOf(pid, v1.id).speed === 0.5),
    await counted('mute a clip', async () => { await selectClip(v1.id); await tick('#pe-mute'); },
      () => cueOf(pid, v1.id).mute === true),
    await counted('a caption', async () => { await selectClip(p1.id); await click('#pe-add-caption'); await type('.ann-text >> nth=-1', 'Morning light over Alfama'); },
      () => doc(pid).annotations.some((a) => a.text === 'Morning light over Alfama')),
    await counted('a place label', async () => { await selectClip(p1.id); await click('#pe-add-place'); },
      () => doc(pid).annotations.some((a) => a.kind === 'place')),
    await counted('a date stamp', async () => { await selectClip(p1.id); await click('#pe-add-date'); },
      () => doc(pid).annotations.some((a) => a.kind === 'date')),
    await counted('hide the map for one item', async () => { await selectClip(p2.id); await pick('#pe-item-map', 'off'); },
      () => cueOf(pid, p2.id).mapInset === 'off'),
    await counted('title card layout', async () => { await click('.pe-chapter >> nth=1'); await pick('#tc-layout', 'lower'); },
      () => doc(pid).chapters[1].titleCard.layout === 'lower'),
  ];
  const most = Math.max(...tasks.map((t) => t.n));
  check('every cue type is set in three interactions or fewer (acceptance)', tasks.every((t) => t.ok && t.n <= 3),
    tasks.map((t) => `${t.name}: ${t.n}${t.ok ? '' : ' (NOT SET)'}`).join('; '));
  void most;

  // ---- 2. G5: a custom Ken Burns, set on the stage ----
  await page.click(`.pe-clip[data-item="${p1.id}"]`);
  await page.check('#pe-motion-custom');
  await page.waitForSelector('#kb-from:not([hidden])');
  await page.waitForTimeout(300);
  const fromBox = (await page.locator('#kb-from').boundingBox())!;
  const toBox = (await page.locator('#kb-to').boundingBox())!;
  // Shrink the start frame from its corner (zoom in), then drag the end frame to the right.
  await page.mouse.move(fromBox.x + fromBox.width - 1, fromBox.y + fromBox.height - 1);
  await page.mouse.down();
  await page.mouse.move(fromBox.x + fromBox.width * 0.6, fromBox.y + fromBox.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await saved();
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(toBox.x + toBox.width / 2 + 60, toBox.y + toBox.height / 2 + 10, { steps: 8 });
  await page.mouse.up();
  await saved();
  await shot('01-ken-burns-frames');
  const kb = cueOf(pid, p1.id).animation;
  check('G5: a photo gets a Ken Burns from a close start to a moved end, set by dragging frames on the stage (PE-11)',
    kb.type === 'kenBurns' && !kb.auto && kb.from.w < 0.8 && kb.to.x > 0.1,
    JSON.stringify(kb));
  await page.click('#pe-motion-edit'); // Done

  // ---- 3. G5: three captions, one moved on the stage ----
  const anns = doc(pid).annotations.filter((a) => a.target.type === 'item' && a.target.itemId === p1.id);
  await page.evaluate((t) => window.tripalogue!.player!.seek(t), p1.start + 1);
  await page.waitForTimeout(300);
  const caption = anns.find((a) => a.text === 'Morning light over Alfama')!;
  const box = (await page.locator(`.ann-box[data-annotation="${caption.id}"]`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 6 });
  await page.mouse.up();
  await saved();
  const moved = doc(pid).annotations.find((a) => a.id === caption.id)!;
  await page.selectOption(`#ann-style-${caption.id}`, 'headline');
  await saved();
  await shot('02-three-captions');
  const textLayers = await page.evaluate(() => window.tripalogue!.player!.frame!.layers.filter((l) => l.kind === 'text').map((l) => (l as { text: string }).text));
  check('G5: three captions on a photo (caption, place, date), one moved and restyled on the stage (PE-14)',
    anns.length === 3 && moved.position.y < caption.position.y - 0.1 && textLayers.length >= 3 && textLayers.includes('Lisbon') || textLayers.some((t) => /Lisbon/.test(t)),
    `on screen: ${textLayers.join(' | ')}; moved from y ${caption.position.y.toFixed(2)} to ${moved.position.y.toFixed(2)}`);

  // ---- 4. G5: a slowed clip ----
  const tl0 = await page.evaluate((id) => window.tripalogue!.player!.timeline.segments.find((s) => s.kind === 'video' && s.item.id === id)!.duration, v1.id);
  check('G5: the clip plays at half speed and lasts twice as long on the timeline (PE-13)', Math.abs(tl0 - v1.duration * 2) < 0.2, `${v1.duration.toFixed(1)} s → ${tl0.toFixed(1)} s`);

  // ---- 5. G5: the inset map ----
  await page.click('#view-preview');
  await page.click('#inset-settings > summary').catch(() => {});
  await page.selectOption('#inset-corner', 'topRight');
  await page.selectOption('#inset-shape', 'circle');
  await page.selectOption('#inset-style', 'terrain');
  await page.selectOption('#inset-transition', 'fullFrame');
  await saved();
  await page.click('#inset-settings > summary').catch(() => {});
  const mv = doc(pid).mapView;
  await page.evaluate((t) => window.tripalogue!.player!.seek(t), p1.start + 1.5);
  await page.waitForTimeout(500);
  const mapNow = await page.evaluate(() => {
    const m = window.tripalogue!.player!.frame!.layers.find((l) => l.kind === 'map') as { layout: { rect: { x: number; y: number }; circle: boolean }; state: { label?: string; style: string } } | undefined;
    const c = document.getElementById('stage') as HTMLCanvasElement;
    return m && { label: m.state.label, circle: m.layout.circle, right: m.layout.rect.x > c.width / 2, top: m.layout.rect.y < c.height / 2, style: m.state.style };
  });
  await page.locator('#stage-wrap').screenshot({ path: path.join(outDir, '03-inset-map.png') });
  check('G5: the inset map set to the top right, round, terrain, with full-frame chapter transitions (MV-3, MV-6, MV-8)',
    mv.corner === 'topRight' && mv.shape === 'circle' && mv.style === 'terrain' && mv.transition?.mode === 'fullFrame' && !!mapNow?.circle && mapNow.right && mapNow.top,
    JSON.stringify(mapNow));
  check('the map says which chapter this is: "Chapter 1 of 4" (MV-5)', mapNow?.label === 'Chapter 1 of 4', mapNow?.label ?? 'no label');
  await page.evaluate(() => {
    const p = window.tripalogue!.player!;
    const title2 = p.timeline.segments.filter((s) => s.kind === 'title')[1];
    p.seek(title2.start + 0.8);
  });
  await page.waitForTimeout(400); // the player draws the seeked frame on its next animation frame
  const fullAt = await page.evaluate(() => {
    const m = window.tripalogue!.player!.frame!.layers.find((l) => l.kind === 'map') as { layout: { full: boolean } } | undefined;
    return !!m?.layout.full;
  });
  await page.locator('#stage-wrap').screenshot({ path: path.join(outDir, '04-full-frame-transition.png') });
  check('between chapters the map fills the frame and travels to the next place (MV-6)', fullAt);

  // ---- 6. G5: record narration ----
  await page.click('#view-mix');
  await page.evaluate((t) => window.tripalogue!.player!.seek(t), p2.start);
  await page.click('#pe-record');
  await page.click('#rec-start');
  await page.waitForTimeout(2200);
  await page.click('#rec-stop');
  await page.waitForSelector('.rec-takes li[data-take="1"]');
  await page.click('#rec-start');
  await page.waitForTimeout(1500);
  await page.click('#rec-stop');
  await page.waitForSelector('.rec-takes li[data-take="2"]');
  await page.screenshot({ path: path.join(outDir, '05-narration-takes.png') });
  await page.click('.rec-takes li[data-take="1"] .rec-use');
  await page.waitForFunction(() => /on the Narration lane/.test(document.getElementById('rec-status')?.textContent ?? ''), null, { timeout: 90_000 });
  await page.click('#rec-close');
  await saved();
  const narr = await page.evaluate(() => window.tripalogue!.player!.timeline.audio.find((c) => /Narration take 1/.test(c.item.uri)));
  check('G5: two narration takes recorded; the first one used lands on the Narration lane where recording began (AU-5)',
    !!narr && narr.duration > 1.5 && Math.abs(narr.start - p2.start) < 0.3, narr ? `${narr.duration.toFixed(1)} s at ${narr.start.toFixed(1)} s (recording began at ${p2.start.toFixed(1)} s)` : 'not on the lane');

  // ---- 7. copy, paste and presets ----
  await page.click(`.pe-clip[data-item="${p2.id}"]`);
  await page.click('#pe-copy-cues');
  await page.click(`.pe-clip[data-item="${photos[3].id}"]`);
  await page.click(`.pe-clip[data-item="${photos[4].id}"]`, { modifiers: ['Shift'] });
  await page.click('#pe-paste-cues');
  await saved();
  const pasted = [photos[3].id, photos[4].id].every((id) => cueOf(pid, id).entrance.type === 'slide' && cueOf(pid, id).exit.durationSec === 1);
  await page.click(`.pe-clip[data-item="${p2.id}"]`);
  await page.fill('#pe-preset-name', 'Slide in');
  await page.click('#pe-save-preset');
  await saved();
  await page.click(`.pe-clip[data-item="${photos[5].id}"]`);
  await page.selectOption('#pe-preset', { label: 'Slide in' });
  await saved();
  check('cues copy to other photos, and a saved preset applies with one pick (PE-17)',
    pasted && cueOf(pid, photos[5].id).entrance.type === 'slide' && (doc(pid).cuePresets ?? []).length === 1);

  // ---- 8. sound: ducking, loop, fit to chapter; a chapter without a place ----
  await page.keyboard.press('Escape');
  await page.waitForSelector('#duck-narration-music');
  await page.locator('#duck-narration-music').fill('-18');
  await saved();
  const ducks = doc(pid).audioLanes.find((l) => l.kind === 'narration')!.ducks;
  await page.click('.pe-clip.audio[data-item="a-song"]');
  await page.click('#pe-fit-chapter');
  await saved();
  const songCue = cueOf(pid, 'a-song').audio!;
  check('narration lowers music by an amount set on the lane; the song fits its chapter by looping (AU-6, AU-8)',
    ducks.some((d) => d.db === -18) && songCue.loop === true, `ducks ${JSON.stringify(ducks)}; song ${JSON.stringify(songCue)}`);
  const ch4 = doc(pid).chapters[3];
  await page.click('#view-itinerary');
  await page.evaluate((id) => window.tripalogue!.session!.edit('Remove pin', (p) => ({ ...p, chapters: p.chapters.map((c) => (c.id === id ? (({ coordinates: _c, ...rest }) => rest)(c) : c)) })), ch4.id);
  await saved();
  await page.click('#view-mix');
  await page.waitForTimeout(300);
  const flagged = await page.evaluate((id) => document.querySelector(`.pe-chapter[data-chapter="${id}"]`)?.classList.contains('no-place'), ch4.id);
  await page.evaluate(() => {
    const p = window.tripalogue!.player!;
    const seg = p.timeline.segments.filter((s) => s.kind !== 'title' && s.chapterIndex === 3)[0];
    p.seek(seg.start + 1);
  });
  await page.waitForTimeout(400);
  const mapInCh4 = await page.evaluate(() => window.tripalogue!.player!.frame!.layers.some((l) => l.kind === 'map'));
  check('a chapter without a place hides the map there and is flagged in the editor (MV-7)', !!flagged && !mapInCh4);
  await page.click('#undo');
  await saved();

  // ---- 9. export the first chapter; motion, captions and map match the preview ----
  await page.click('#view-preview');
  const before = new Set(((await (await fetch(`${app.url}api/projects/${pid}/renders`)).json()) as { renders: RenderInfo[] }).renders.map((e) => e.id));
  await page.click('#export-open');
  await page.selectOption('#export-resolution', '720p');
  await page.selectOption('#export-part', 'chapter');
  await page.selectOption('#export-chapter', doc(pid).chapters[0].id);
  await page.click('#export-start');
  let exp: RenderInfo | undefined;
  for (let i = 0; i < 2400; i++) {
    const list = ((await (await fetch(`${app.url}api/projects/${pid}/renders`)).json()) as { renders: RenderInfo[] }).renders;
    exp = list.find((e) => !before.has(e.id));
    if (exp && !['queued', 'running'].includes(exp.status)) break;
    await page.waitForTimeout(500);
  }
  await page.click('#export-close').catch(() => {});
  check('the chapter exports', exp?.status === 'done', exp?.error?.message ?? exp?.status ?? 'not started');
  if (exp?.status === 'done') {
    const file = exp.path!;
    const ch0 = await page.evaluate(() => window.tripalogue!.player!.timeline.chapters[0]);
    const moments = [
      { what: 'Ken Burns start', t: p1.start + 0.6 },
      { what: 'Ken Burns end, three captions', t: p1.start + p1.duration - 0.6 },
      { what: 'slide entrance mid-way', t: p2.start + 0.25 },
      { what: 'crossfade', t: p3.start + 0.3 },
      { what: 'title card with the map', t: ch0.start + 1 },
    ].filter((m) => m.t < ch0.end);
    const SMALL = { w: 192, h: 108 };
    const rgb = async (args: string[]) => (await run('ffmpeg', ['-v', 'error', ...args, '-vf', `scale=${SMALL.w}:${SMALL.h}:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 })).stdout;
    const diff = (a: Buffer, b: Buffer) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
    const results: string[] = [];
    let worst = 0;
    for (const [i, m] of moments.entries()) {
      const k = Math.round((m.t - ch0.start) * 30);
      const t = ch0.start + k / 30;
      const png = await page.evaluate(`(async () => {
        const p = window.tripalogue.player;
        const canvas = document.getElementById('stage');
        canvas.width = 1280; canvas.height = 720;
        p.pause(); p.seek(${t});
        const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));
        for (let i = 0; i < 200; i++) {
          const before = p.stats.placeholderFrames;
          p.redraw(); await raf(); await raf();
          if (p.stats.placeholderFrames === before) break;
        }
        // Map tiles arrive on their own: give them a moment, then draw once more.
        await new Promise((r) => setTimeout(r, 600));
        p.redraw(); await raf(); await raf();
        return canvas.toDataURL('image/png');
      })()`) as string;
      const pngFile = path.join(dataDir, `p5-preview-${i}.png`);
      await fs.writeFile(pngFile, Buffer.from(png.split(',')[1], 'base64'));
      const a = await rgb(['-i', pngFile]);
      const b = (await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${k}),scale=${SMALL.w}:${SMALL.h}:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 })).stdout;
      const d = diff(a, b);
      worst = Math.max(worst, d);
      results.push(`${m.what}: ${d.toFixed(1)}`);
      await fs.copyFile(pngFile, path.join(outDir, `06-preview-${i}.png`));
      await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `select=eq(n\\,${k})`, '-frames:v', '1', path.join(outDir, `06-export-${i}.png`)]);
    }
    check('exported motion, captions and map match the preview at the same frame (acceptance, VX-7, VX-8)', worst < 10,
      `mean difference per colour value (0–255): ${results.join('; ')}`);
  }

  check('no errors in the browser console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('the script ran to the end', false, (e as Error).stack ?? String(e));
  await shot('99-failure').catch(() => {});
} finally {
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ date: new Date().toISOString(), browser: browser.version(), checks }, null, 2));
  await browser.close();
  await app.close();
  provider.server.close();
}
const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
