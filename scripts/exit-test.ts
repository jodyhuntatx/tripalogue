/**
 * Phase 0 exit test (web): "the team can hand-write a project with 20 items,
 * import it into an account, and play it end to end in a browser from cloud
 * storage."
 *
 * Starts the web app on a fresh data folder, then in headless Chromium:
 * opens the app (no sign-in), imports the hand-written project by uploading
 * its 20 files through the browser, waits for processing, plays the whole
 * travelogue, spot-checks frames, and checks that an edit autosaves, survives
 * a reload, and can be undone. Writes a report and screenshots to
 * docs/exit-test/.
 *
 *   node --import tsx scripts/exit-test.ts [--rate 1]
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildTimeline, parseProject } from '../src/core/index.js';
import { startApp } from '../src/server/app.js';
import { geoConfigFromEnv } from '../src/server/geo.js';
import type {} from '../src/web/main.js'; // window.tripalogue typings
import { writeHeic } from '../test/helpers/heic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sampleDir = path.join(root, 'samples/hand-written-20');
const projectFile = path.join(sampleDir, 'trip.travelogue.json');
const outDir = path.join(root, 'docs/exit-test');
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const rate = Number(arg('rate') ?? 1);

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const tl = buildTimeline(parseProject(await fs.readFile(projectFile, 'utf8')).project);
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.png') || f.endsWith('.json')) await fs.rm(path.join(outDir, f));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tripalogue-exit-'));
// No internet here: map tiles and place search off (the inset map draws its pins on a plain background).
const app = await startApp({ dataDir, port: 0, log: () => {}, geo: geoConfigFromEnv(dataDir, { tileUrl: '', geocoderUrl: '' }) });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
/** Upload, Members and Versions live in the Itinerary view's travelogue panel (lower right). */
const panelTab = async (t: 'Upload' | 'Versions') => {
  await page.click('#view-itinerary');
  await page.click(`#project-panel button[data-tab="${t}"]`);
};
/** The item list is a tab of the Mix view's side panel. */
const itemsTab = async () => {
  await page.click('#view-mix');
  await page.click('#side-panel button[data-tab="Items"]');
};
const consoleErrors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(e.message));
const shot = (name: string) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

try {
  // 1. Open the app: no sign-in, straight to your travelogues.
  await page.goto(app.url);
  await page.waitForSelector('#import-json');
  await shot('01-travelogues');
  check('opens straight to your travelogues, with no sign-in', await page.locator('input[type=email]').count() === 0);

  // 2. Import the hand-written project and upload its 20 files through the browser.
  const media = readdirSync(path.join(sampleDir, 'media')).map((f) => path.join(sampleDir, 'media', f));
  await page.setInputFiles('#import-json', projectFile);
  await page.setInputFiles('#import-media', media);
  const t0 = Date.now();
  await page.click('#import-start');
  await page.waitForURL(/#\/p\//, { timeout: 120_000 });
  const uploadSec = (Date.now() - t0) / 1000;
  await page.waitForFunction(() => document.getElementById('meta')?.dataset.ready === '20', null, { timeout: 180_000, polling: 500 });
  const readySec = (Date.now() - t0) / 1000;
  const totalBytes = (await Promise.all(media.map((f) => fs.stat(f)))).reduce((a, s) => a + s.size, 0);
  check('imports and uploads all 20 originals through the browser', true, `${(totalBytes / 1e6).toFixed(1)} MB uploaded in ${uploadSec.toFixed(1)} s; all processed after ${readySec.toFixed(1)} s`);
  const pid = page.url().split('#/p/')[1].split('/')[0];
  const stored = app.projects.load(pid).doc;
  check('originals are stored byte for byte', stored.media.every((m) => m.contentHash && m.status === 'ready'), `${stored.media.filter((m) => m.contentHash).length} of 20 hashed`);
  await shot('02-project');

  // 3. Play end to end.
  await page.evaluate((r) => { window.tripalogue!.player!.setMuted(true); window.tripalogue!.player!.setRate(r); }, rate);
  await page.click('#play');
  const started = Date.now();
  await page.waitForFunction(() => document.body.dataset.state === 'ended', null, { timeout: (tl.duration / rate + 60) * 1000, polling: 250 });
  const wall = (Date.now() - started) / 1000;
  const stats = await page.evaluate(() => {
    const p = window.tripalogue!.player!;
    return { ...p.stats, time: p.time, duration: p.duration, segments: p.timeline.segments.length };
  });
  const firstVisits = stats.segmentsEntered.filter((v, i, a) => a.indexOf(v) === i);
  check('plays to the end', stats.time >= tl.duration - 1e-6, `${tl.duration} s of timeline in ${wall.toFixed(1)} s at ${rate}x`);
  check('enters all 23 segments (4 title cards + 19 items) in order', JSON.stringify(firstVisits) === JSON.stringify(tl.segments.map((_, i) => i)), `entered ${firstVisits.length}`);
  check('no media failed to load', stats.mediaErrors.length === 0, stats.mediaErrors.join(', '));
  const slow = Object.entries(stats.placeholderBySegment).map(([i, n]) => `${tl.segments[Number(i)].kind} ${i}: ${n}`).join(', ');
  check('media ready in time (under 2% of frames waited on loading)', stats.placeholderFrames / Math.max(1, stats.framesDrawn) < 0.02, `${stats.placeholderFrames} of ${stats.framesDrawn} frames${slow ? ` (${slow})` : ''}`);
  check('draws smoothly (30 fps or better)', stats.framesDrawn / wall >= 30, `${(stats.framesDrawn / wall).toFixed(0)} frames per second`);

  // 4. Spot-check frames.
  const find = (id: string) => tl.segments.find((s) => s.kind !== 'title' && s.item.id === id)!;
  const spots = [
    { name: '03-title-lisbon', t: 1.5 }, { name: '04-portrait-fit-m02', t: find('m02').start + 2 },
    { name: '05-custom-rect-m04', t: find('m04').start + 2 }, { name: '06-fill-m09', t: find('m09').start + 2.5 },
    { name: '07-video-full-m15', t: find('m15').start + 10 }, { name: '08-video-2x-m20', t: find('m20').start + 2 },
  ];
  for (const s of spots) {
    await page.evaluate((t) => window.tripalogue!.player!.seek(t), s.t);
    await page.waitForTimeout(s.name.includes('video') ? 1200 : 400);
    const lit = await page.evaluate(() => {
      const c = document.getElementById('stage') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let on = 0, right = 0, left = 0, total = 0;
      for (let y = 0; y < c.height; y += 8) for (let x = 0; x < c.width; x += 8) {
        total++;
        const i = (y * c.width + x) * 4;
        if (d[i] + d[i + 1] + d[i + 2] > 30) { on++; if (x > c.width * 0.6 && y < c.height * 0.6) right++; if (x < c.width * 0.08) left++; }
      }
      return { share: on / total, right, left };
    });
    await page.locator('#stage').screenshot({ path: path.join(outDir, `${s.name}.png`) });
    let ok = lit.share > 0.2;
    if (s.name.includes('custom')) ok &&= lit.right === 0;
    if (s.name.includes('fill')) ok &&= lit.share > 0.95;
    if (s.name.includes('portrait')) ok &&= lit.left === 0;
    check(`frame at ${s.t.toFixed(1)} s: ${s.name.slice(3)}`, ok, `${Math.round(lit.share * 100)}% of the frame lit`);
  }

  // 4b. The map inset follows the story: the whole trip on a title card, the chapter while its media plays.
  const insetAt = async (t: number) => {
    await page.evaluate((x) => window.tripalogue!.player!.seek(x), t);
    await page.waitForTimeout(400); // the player draws the seeked frame
    // The inset is part of the drawn frame (Phase 5): read it from the player's render model.
    return page.evaluate(() => {
      const m = window.tripalogue!.player!.frame?.layers.find((l) => l.kind === 'map') as { layout: { rect: { w: number } }; state: { view: string; camera: { zoom: number }; pins: { id: string; state: string }[] } } | undefined;
      const cur = m?.state.pins.find((p) => p.state === 'current');
      return { visible: !!m && m.layout.rect.w > 100, focus: !m || m.state.view === 'trip' || !cur ? 'trip' : cur.id, view: m?.state.view, zoom: m?.state.camera.zoom ?? 0 };
    });
  };
  // MV-6: a title card opens on the whole trip, then travels and zooms into its chapter.
  const titleStart = await page.evaluate(() => window.tripalogue!.player!.timeline.segments.find((x) => x.kind === 'title')!.start);
  const onTitle = await insetAt(titleStart + 0.05);
  const inFirst = await insetAt(find('m02').start + 2);
  const inLater = await insetAt(find('m09').start + 2.5);
  await page.locator('#stage-wrap').screenshot({ path: path.join(outDir, '08b-map-inset.png') });
  check('the map inset shows the whole trip on a title card, then the chapter being played',
    onTitle.visible && onTitle.zoom < inFirst.zoom - 1 && inFirst.focus === find('m02').chapterId && inLater.focus === find('m09').chapterId,
    `title opens at zoom ${onTitle.zoom.toFixed(1)} (${onTitle.view}); m02: ${inFirst.focus} at zoom ${inFirst.zoom.toFixed(1)}; m09: ${inLater.focus}`);

  // 4c. Photo locations as dots in the inset: this chapter's items shown so far joined by a trail, the current one
  // marked, the rest still ahead; moving on to the next item animates the hop to it.
  type Story = { dots: { lat: number; lng: number; state: string }[]; trail: { lat: number; lng: number }[]; marker?: { lat: number; lng: number } };
  const story = () => page.evaluate(() => {
    const m = window.tripalogue!.player!.frame?.layers.find((l) => l.kind === 'map') as { state: Story } | undefined;
    return m ? { dots: m.state.dots, trail: m.state.trail, marker: m.state.marker } : { dots: [], trail: [] };
  });
  const storyAt = async (t: number, wait = 300) => {
    await page.evaluate((x) => window.tripalogue!.player!.seek(x), t);
    await page.waitForTimeout(wait);
    return story();
  };
  const st03 = await storyAt(find('m03').start + 1.5);
  const count = (s: Story, state: string) => s.dots.filter((d) => d.state === state).length;
  await page.locator('#stage-wrap').screenshot({ path: path.join(outDir, '08c-inset-dots.png') });
  const ats = await storyAt(find('m04').start + 0.3);
  const settled = await storyAt(find('m04').start + 1.5);
  const same = (a?: { lat: number; lng: number }, b?: { lat: number; lng: number }) => !!a && !!b && Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
  check('the inset shows where each photo was taken and moves through the chapter as it plays',
    count(st03, 'current') === 1 && count(st03, 'shown') === 2 && count(st03, 'ahead') >= 1 && st03.trail.length >= 3
      && !same(ats.marker, settled.marker) && same(settled.marker, settled.trail.at(-1)),
    `at m03: ${count(st03, 'shown')} shown, ${count(st03, 'ahead')} ahead, trail ${st03.trail.length}; hop animates: ${!same(ats.marker, settled.marker)}`);

  // 5. Edit, autosave, reload, undo (in the Mix view's Items tab).
  const previewWidth = await page.evaluate(() => document.getElementById('stage-wrap')!.getBoundingClientRect().width);
  const previewSide = await page.evaluate(() => !!document.getElementById('side-panel')!.getClientRects().length);
  await page.click('#view-mix');
  await itemsTab();
  await page.uncheck('li[data-item="m02"] input[type=checkbox]');
  await page.waitForFunction(() => window.tripalogue!.session!.unsaved === 0 && window.tripalogue!.session!.status === 'saved', null, { timeout: 10_000 });
  const savedOnServer = app.projects.load(pid).doc.cues.find((c) => c.itemId === 'm02')!.included === false;
  await page.reload();
  await itemsTab();
  await page.waitForSelector('li[data-item="m02"]');
  const afterReload = await page.isChecked('li[data-item="m02"] input[type=checkbox]');
  check('an edit autosaves and survives a reload', savedOnServer && !afterReload);
  await page.uncheck('li[data-item="m03"] input[type=checkbox]');
  await page.waitForFunction(() => window.tripalogue!.session!.unsaved === 0 && window.tripalogue!.session!.status === 'saved', null, { timeout: 10_000 });
  await page.click('#undo');
  await page.waitForFunction(() => window.tripalogue!.session!.unsaved === 0 && window.tripalogue!.session!.status === 'saved', null, { timeout: 10_000 });
  const undone = app.projects.load(pid).doc.cues.find((c) => c.itemId === 'm03')!.included === true;
  check('undo reverts the change on the server too', undone);
  const log = app.projects.opsSince(pid, 0);
  check('every change is in the operation log with its author', log.length > 0 && log.every((o) => o.author), `${log.length} revisions`);
  // 6. Preview is just the player at full width; in Mix the side panel folds away, and the choice is remembered.
  const layout = () => page.evaluate(() => ({
    stage: document.getElementById('stage-wrap')!.getBoundingClientRect().width,
    side: !!document.getElementById('side-panel')!.getClientRects().length,
    btn: document.getElementById('toggle-panel')!.textContent,
  }));
  const open = await layout();
  await page.click('#toggle-panel');
  await page.waitForTimeout(300);
  const folded = await layout();
  await page.reload();
  await page.waitForSelector('#toggle-panel');
  await page.waitForTimeout(300);
  const remembered = await layout();
  await page.locator('#stage').focus().catch(() => {});
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  const back = await layout();
  check('Preview has no side panel and the player uses the width; in Mix the panel hides, is remembered, and P brings it back',
    !previewSide && previewWidth > open.stage + 100 && open.side && !folded.side && !remembered.side && back.side,
    `player ${Math.round(previewWidth)} px wide in Preview, ${Math.round(open.stage)} px in Mix with the panel`);
  await page.click('#view-preview');
  await page.evaluate(() => window.tripalogue!.player!.seek(1.5)); // t = 0 is the title card's fade from black
  await page.waitForTimeout(1800);
  const lit = await page.evaluate(() => {
    const c = document.getElementById('stage') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let on = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) { n++; if (d[i] + d[i + 1] + d[i + 2] > 30) on++; }
    return on / n;
  });
  check('the wider player redraws its frame', lit > 0.5, `${Math.round(lit * 100)}% of the frame lit`);
  await page.screenshot({ path: path.join(outDir, '10-preview-full-width.png') });
  await page.click('#view-mix');

  // 7. A phone's HEIC photo uploads, gets a full-size JPG, and shows upright.
  const heic = path.join(dataDir, 'IMG_0420.HEIC');
  await writeHeic(heic, { width: 320, height: 240, tile: 128, rotateCcw: 90, capturedAt: '2026:05:03 14:22:10', exifOrientation: 6 });
  await panelTab('Upload');
  await page.setInputFiles('#upload-input', heic);
  await page.click('#upload-start');
  await page.waitForFunction(() => window.tripalogue!.session!.state.media.some((m) => m.uri.endsWith('IMG_0420.HEIC') && m.status === 'ready'), null, { timeout: 60_000 });
  await itemsTab();
  const row = page.locator('li[data-item]', { hasText: 'IMG_0420.HEIC' });
  await row.locator('img').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('li[data-item] img')].some((i) => i.closest('li')!.textContent!.includes('IMG_0420') && i.naturalWidth > 0));
  const thumb = await row.locator('img').evaluate((i: HTMLImageElement) => ({ w: i.naturalWidth, h: i.naturalHeight }));
  const jpg = await row.locator('a.badge.jpg').getAttribute('download');
  const heicItem = app.projects.load(pid).doc.media.find((m) => m.uri.endsWith('IMG_0420.HEIC'))!;
  check('a HEIC photo uploads, is converted to a full-size JPG, and shows upright', thumb.h > thumb.w && jpg === 'IMG_0420.jpg' && heicItem.width === 240 && heicItem.height === 320,
    `thumbnail ${thumb.w}×${thumb.h}, download "${jpg}", item ${heicItem.width}×${heicItem.height}`);
  await page.waitForTimeout(500);
  await page.locator('li[data-item]', { hasText: 'IMG_0420.HEIC' }).scrollIntoViewIfNeeded();
  await page.locator('#side-panel').screenshot({ path: path.join(outDir, '11-heic-item.png') });

  // 8. A broken ffmpeg install is reported in the Upload tab, and failed items are processed again with Retry.
  const goodProbe = app.cfg.ffprobe;
  app.cfg.ffprobe = path.join(dataDir, 'no-such-ffprobe');
  const broken = path.join(dataDir, 'IMG_0500.jpg');
  // A new photo (a copy of a sample photo would now be recognised as already uploaded and skipped).
  await new Promise<void>((resolve, reject) => import('node:child_process').then(({ execFile }) =>
    execFile('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=olive:s=640x480', '-frames:v', '1', broken], (e) => (e ? reject(e) : resolve()))));
  await panelTab('Upload');
  await page.setInputFiles('#upload-input', broken);
  await page.click('#upload-start');
  await page.waitForFunction(() => window.tripalogue!.session!.state.media.some((m) => m.uri.endsWith('IMG_0500.jpg') && m.status === 'failed'), null, { timeout: 60_000 });
  await itemsTab();
  const retryBtn = page.locator('button.retry[aria-label="Retry processing IMG_0500.jpg"]');
  await retryBtn.waitFor();
  await panelTab('Upload');
  await page.waitForSelector('#retry-failed');
  // The banner shows once the page knows about the problem (the page loaded before ffprobe broke): ask again.
  const recheck = await page.evaluate(async () => (await fetch('/api/media-tools?recheck=1')).json());
  await page.reload();
  await page.waitForFunction(() => !!window.tripalogue?.session);
  await panelTab('Upload');
  const banner = await page.locator('#media-problems').textContent({ timeout: 10_000 }).catch(() => '');
  await page.screenshot({ path: path.join(outDir, '12-media-problems.png') });
  app.cfg.ffprobe = goodProbe; // "install" ffprobe
  await page.click('#media-recheck');
  await page.waitForSelector('#media-problems', { state: 'detached' });
  await page.click('#retry-failed');
  await page.waitForFunction(() => window.tripalogue!.session!.state.media.some((m) => m.uri.endsWith('IMG_0500.jpg') && m.status === 'ready'), null, { timeout: 60_000 });
  check('a broken ffmpeg is reported, and Retry processes failed uploads once it is fixed',
    recheck.ok === false && /ffprobe was not found/.test(banner ?? '') && (await page.locator('#retry-failed').count()) === 0,
    (banner ?? '').slice(0, 90));

  check('no errors in the browser console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  await page.waitForTimeout(400); // let the status label catch up before the screenshot
  await shot('09-after-edits');

  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
    date: new Date().toISOString(), rate, browser: browser.version(), timelineSec: tl.duration, wallSec: wall,
    uploadSec, readySec, framesDrawn: stats.framesDrawn, placeholderFrames: stats.placeholderFrames, checks,
  }, null, 2));
} finally {
  await browser.close();
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.pass);
console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nAll ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
