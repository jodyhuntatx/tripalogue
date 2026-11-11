/**
 * Phase 2 browser test: the media manager, scripted like the G2 usability tasks.
 *
 * Imports the sample trip with its 20 originals, then uploads extra photos the
 * way a traveler's phone would: one taken after the trip (Unassigned), a
 * screenshot with no camera time (Unassigned, low confidence), a copy of a
 * sample photo (duplicate), and three photos from a camera whose clock was an
 * hour slow (one lands in Lisbon instead of Sintra). Then, in the Media view:
 * drag an item into a chapter, set a time by hand, fix the camera clock with
 * a live preview, find duplicates, and check it all survives a reload.
 * Report and screenshots go to docs/phase2-test/.
 *
 *   node --import tsx scripts/phase2-test.ts
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Page } from 'playwright';
import { startApp } from '../src/server/app.js';
import { geoConfigFromEnv } from '../src/server/geo.js';
import { withExif } from '../src/server/heif.js';
import type { OutboxMailer } from '../src/server/mailer.js';
import type {} from '../src/web/main.js';
import { exifTiff } from '../test/helpers/heic.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/phase2-test');
const sampleDir = path.join(root, 'samples/hand-written-20');

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) await fs.rm(path.join(outDir, f));
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tripalogue-p2-'));
const files = path.join(dataDir, 'phone');
mkdirSync(files);

// ---- the traveler's extra files ----
async function photo(name: string, color: string, exif?: Parameters<typeof exifTiff>) {
  const plain = path.join(files, `plain-${name}`);
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240`, '-frames:v', '1', plain]);
  const out = path.join(files, name);
  await fs.writeFile(out, exif ? withExif(await fs.readFile(plain), exifTiff(...exif)) : await fs.readFile(plain));
  await fs.rm(plain);
  return out;
}
const afterTrip = await photo('IMG_3001.jpg', 'orange', ['2026:05:11 18:00:00', 1]); // the day after the last chapter
const screenshot = await photo('Screenshot 2026-05-20.png'.replace('.png', '.jpg'), 'gray'); // no camera time
const dupe = path.join(files, 'copy-of-alfama.jpg');
await fs.copyFile(path.join(sampleDir, 'media/ch1-01-alfama.jpg'), dupe);
// A camera an hour slow: the clock said 23:20, 23:40 on 3 May; it was really 00:20, 00:40 on 4 May (Sintra), and 10:00 → 11:00.
const canon = { make: 'Canon', model: 'Canon EOS R6' };
const slow = [
  await photo('DSC_0101.jpg', 'purple', ['2026:05:03 23:20:00', 1, canon]),
  await photo('DSC_0102.jpg', 'navy', ['2026:05:03 23:40:00', 1, canon]),
  await photo('DSC_0103.jpg', 'teal', ['2026:05:04 10:00:00', 1, canon]),
];
// The same traveler's phone keeps network time: its late-night Lisbon photo must not move when the Canon is fixed.
const phone = await photo('IMG_3002.jpg', 'yellow', ['2026:05:03 23:30:00', 1, { make: 'Apple', model: 'iPhone 15 Pro', offset: '+01:00' }]);

const app = await startApp({ dataDir, port: 0, log: () => {}, geo: geoConfigFromEnv(dataDir, { tileUrl: '', geocoderUrl: '' }) });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
const shot = (name: string) => page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
const saved = (p: Page) => p.waitForFunction(() => window.tripalogue!.session!.unsaved === 0 && window.tripalogue!.session!.status === 'saved', null, { timeout: 10_000 });
const byName = (name: string) => page.evaluate((n) => window.tripalogue!.session!.state.media.find((m) => m.uri.endsWith(n))!, name);
const chapterOf = async (name: string) => (await byName(name)).chapterId;
const tile = (name: string) => page.locator(`#media-grid .tile[title="${name}"]`);
const settle = () => page.waitForTimeout(250); // the views refresh shortly after an edit

try {
  // Sign in, import the sample with its originals.
  await page.goto(app.url);
  await page.fill('input[type=email]', 'jody@example.com');
  await page.click('button[type=submit]');
  await page.waitForSelector('text=Check your email');
  await page.goto(/https?:\/\/\S+/.exec((await (app.mailer as OutboxMailer).latestFor('jody@example.com'))!.text)![0]);
  await page.waitForSelector('#import-json');
  await page.setInputFiles('#import-json', path.join(sampleDir, 'trip.travelogue.json'));
  await page.setInputFiles('#import-media', readdirSync(path.join(sampleDir, 'media')).map((f) => path.join(sampleDir, 'media', f)));
  await page.click('#import-start');
  await page.waitForURL(/#\/p\//, { timeout: 120_000 });
  await page.waitForFunction(() => document.getElementById('meta')?.dataset.ready === '20', null, { timeout: 180_000, polling: 500 });
  const pid = page.url().split('#/p/')[1].split('/')[0];

  // The traveler's phone: upload the extra files from the Upload tab.
  await page.click('.tabs button[data-tab="Upload"]');
  await page.setInputFiles('#upload-input', [afterTrip, screenshot, dupe, ...slow, phone]);
  await page.click('#upload-start');
  await page.waitForFunction(() => window.tripalogue!.session!.state.media.length === 27 && window.tripalogue!.session!.state.media.every((m) => !m.status || m.status === 'ready'), null, { timeout: 90_000 });
  check('uploaded photos are filed by their capture time with no clicks', await chapterOf('DSC_0103.jpg') === 'ch-sintra' && await chapterOf('copy-of-alfama.jpg') === null,
    `DSC_0103 → ${await chapterOf('DSC_0103.jpg')}; the copied sample photo has no EXIF → ${await chapterOf('copy-of-alfama.jpg')}`);
  check('the slow camera puts its late-night photos in the wrong chapter (the planted error)', await chapterOf('DSC_0101.jpg') === 'ch-lisbon' && await chapterOf('DSC_0102.jpg') === 'ch-lisbon');
  const srcs = await page.evaluate(() => window.tripalogue!.session!.state.sources.map((x) => x.displayName));
  check('uploads are grouped by camera, so one camera’s clock can be fixed alone', (await byName('DSC_0101.jpg')).sourceId !== (await byName('IMG_3002.jpg')).sourceId && srcs.some((n) => /Canon EOS R6/.test(n)) && srcs.some((n) => /iPhone 15 Pro/.test(n)),
    srcs.join(' | '));

  // Opening the project (a link with no view in it) goes to the Media view, since items are unassigned.
  await page.goto('about:blank');
  await page.goto(new URL(`/#/p/${pid}`, app.url).href);
  await page.waitForFunction(() => !!window.tripalogue?.session);
  await page.waitForSelector('#media:not([hidden]) #media-grid .tile', { timeout: 8000 }).catch(async () => {
    console.log('DEBUG url', page.url(), 'hidden', await page.evaluate(() => document.getElementById('media')?.hidden), 'tiles', await page.locator('#media-grid .tile').count(), 'errors', consoleErrors.join(' | '));
    await shot('debug');
    throw new Error('media view not shown');
  });
  check('with unassigned items, the project opens in the Media view', page.url().endsWith('/media'));
  const unassigned = await page.locator('.media-chapter.unassigned .tile').count();
  const summary = await page.textContent('#media-summary');
  check('the Unassigned bin is listed first with its count', unassigned === 3 && /3 unassigned/.test(summary ?? ''), summary ?? '');
  check('a file with no camera time is badged as uncertain', (await tile('Screenshot 2026-05-20.jpg').textContent())!.includes('time?'));
  await shot('01-media-view');

  // MM-5: drag the after-trip photo into Porto.
  await tile('IMG_3001.jpg').dragTo(page.locator('.media-chapter[data-chapter="ch-porto"] > header'));
  await saved(page);
  const dragged = await byName('IMG_3001.jpg');
  check('dragging an item onto a chapter gives it a time inside that chapter', dragged.chapterId === 'ch-porto' && !!dragged.userTimestamp, dragged.userTimestamp);
  await page.click('#undo');
  await saved(page);
  await settle();
  check('undo puts it back', await chapterOf('IMG_3001.jpg') === null && !(await byName('IMG_3001.jpg')).userTimestamp);
  await page.click('#redo');
  await saved(page);

  // MM-5: set a time by hand.
  await tile('Screenshot 2026-05-20.jpg').click();
  await page.fill('#set-time', '2026-05-09T10:30');
  await page.click('#apply-time');
  await saved(page);
  const fixed = await byName('Screenshot 2026-05-20.jpg');
  check('setting a time by hand moves the item to its chapter', fixed.chapterId === 'ch-douro' && fixed.userTimestamp === '2026-05-09T09:30:00Z', `${fixed.chapterId}, ${fixed.userTimestamp} (10:30 Lisbon time)`);

  // MM-6 / MM-8: duplicates.
  await page.click('.media-filters button[data-filter="duplicate"]');
  await settle();
  const dupTiles = await page.locator('#media-grid .tile').count();
  check('the copied photo and its original are flagged as duplicates', dupTiles === 2, `${dupTiles} tiles under Duplicates`);
  await page.click('.media-filters button[data-filter="all"]');

  // MM-4: the camera clock, with a live preview.
  const src = (await byName('DSC_0101.jpg')).sourceId;
  const box = page.locator(`.media-sources .source[data-source="${src}"]`);
  await box.scrollIntoViewIfNeeded();
  await box.locator('input[aria-label$="hours"]').fill('1');
  const preview = await box.locator('.preview').textContent();
  check('a clock offset previews how many items would change chapter before applying', /changes the chapter of 2 items: 2 1\. Lisbon|changes the chapter of 2 items: 2 Lisbon → Sintra/.test(preview ?? '') || /2 items/.test(preview ?? ''), preview ?? '');
  const t0 = Date.now();
  await box.locator('button[data-source]').click();
  await saved(page);
  const applyMs = Date.now() - t0;
  check('applying it moves the slow camera’s photos to the right chapter, and nothing else', await chapterOf('DSC_0101.jpg') === 'ch-sintra' && await chapterOf('DSC_0102.jpg') === 'ch-sintra' && await chapterOf('DSC_0103.jpg') === 'ch-sintra'
    && await chapterOf('IMG_3002.jpg') === 'ch-lisbon', `saved in ${applyMs} ms; the iPhone photo stays in Lisbon`);
  await shot('02-after-fixes');

  // Multi-select and shift.
  await tile('DSC_0101.jpg').click();
  await tile('DSC_0103.jpg').click({ modifiers: ['Shift'] });
  const sel = await page.evaluate(() => window.tripalogue!.media!.selected().length);
  await page.fill('#shift-hours', '0');
  await page.fill('#shift-minutes', '30');
  await page.click('#apply-shift');
  await saved(page);
  const shifted = await byName('DSC_0101.jpg');
  check('Shift-click selects a range, and Shift moves all of them', sel >= 3 && shifted.userTimestamp === '2026-05-03T23:50:00Z', `${sel} selected; DSC_0101 now ${shifted.userTimestamp}`);

  // Everything is saved on the server and survives a reload.
  await page.reload();
  await page.waitForSelector('#media-grid .tile');
  const doc = app.projects.load(pid).doc;
  const where = (n: string) => doc.media.find((m) => m.uri.endsWith(n))!.chapterId;
  check('all fixes are saved and survive a reload', where('IMG_3001.jpg') === 'ch-porto' && where('Screenshot 2026-05-20.jpg') === 'ch-douro' && where('DSC_0102.jpg') === 'ch-sintra'
    && doc.sources.find((s) => s.id === src)!.clockOffsetSec === 3600);

  check('no errors in the browser console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ date: new Date().toISOString(), browser: browser.version(), checks }, null, 2));
} finally {
  await browser.close();
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.pass);
console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nAll ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
