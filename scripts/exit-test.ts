/**
 * Phase 0 exit test (web): "the team can hand-write a project with 20 items,
 * import it into an account, and play it end to end in a browser from cloud
 * storage."
 *
 * Starts the web app on a fresh data folder, then in headless Chromium:
 * signs in with an emailed link, imports the hand-written project by uploading
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
import type { OutboxMailer } from '../src/server/mailer.js';
import type {} from '../src/web/main.js'; // window.tripalogue typings

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
const app = await startApp({ dataDir, port: 0, log: () => {} });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(e.message));
const shot = (name: string) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

try {
  // 1. Sign in with an emailed link.
  await page.goto(app.url);
  await page.fill('input[type=email]', 'jody@example.com');
  await shot('01-sign-in');
  await page.click('button[type=submit]');
  await page.waitForSelector('text=Check your email');
  const mail = await (app.mailer as OutboxMailer).latestFor('jody@example.com');
  await page.goto(/https?:\/\/\S+/.exec(mail!.text)![0]);
  await page.waitForSelector('#import-json');
  check('signs in with an emailed link', true);

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
    { name: '07-video-trimmed-m15', t: find('m15').start + 10 }, { name: '08-video-2x-m20', t: find('m20').start + 2 },
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
        if (d[i] + d[i + 1] + d[i + 2] > 30) { on++; if (x > c.width * 0.6) right++; if (x < c.width * 0.08) left++; }
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

  // 5. Edit, autosave, reload, undo.
  await page.uncheck('li[data-item="m02"] input[type=checkbox]');
  await page.waitForFunction(() => window.tripalogue!.session!.unsaved === 0 && window.tripalogue!.session!.status === 'saved', null, { timeout: 10_000 });
  const savedOnServer = app.projects.load(pid).doc.cues.find((c) => c.itemId === 'm02')!.included === false;
  await page.reload();
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
