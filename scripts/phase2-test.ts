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
async function photo(name: string, color: string, exif?: Parameters<typeof exifTiff>, size = '4032x3024') {
  const plain = path.join(files, `plain-${name}`);
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', plain]);
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
// Ana, a second traveler, sends originals from her phone (time, offset, GPS). One was taken in Porto on a Lisbon day.
const anaPhone = { make: 'Apple', model: 'iPhone 14', offset: '+01:00' };
const ana = [
  await photo('IMG_7001.jpg', 'pink', ['2026:05:02 12:00:00', 1, { ...anaPhone, gps: { lat: 38.7139, lng: -9.1394 } }]),
  await photo('IMG_7002.jpg', 'olive', ['2026:05:02 18:00:00', 1, { ...anaPhone, gps: { lat: 41.1496, lng: -8.6109 } }]),
];
// Ben, a third, forwards WhatsApp copies: small, no camera time or place.
const ben = [
  await photo('IMG-20260504-WA0007.jpg', 'maroon', undefined, '1600x1200'),
  await photo('IMG-20260504-WA0008.jpg', 'silver', undefined, '1600x1200'),
];
// A voice memo recorded in Porto.
const memo = path.join(files, 'Memo Porto.m4a');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-c:a', 'aac', '-metadata', 'creation_time=2026-05-06T19:15:00Z', memo]);
// The same traveler's phone keeps network time: its late-night Lisbon photo must not move when the Canon is fixed.
const phone = await photo('IMG_3002.jpg', 'yellow', ['2026:05:03 23:30:00', 1, { make: 'Apple', model: 'iPhone 15 Pro', offset: '+01:00' }]);

/** Another traveler, uploading through the API from their own device. */
class Traveler {
  cookie = '';
  constructor(readonly email: string) {}
  async req(method: string, p: string, body?: unknown, raw?: Buffer) {
    const headers: Record<string, string> = { 'x-tripalogue-client': '1' };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(new URL(p, app.url), { method, headers, body: (raw ?? (body !== undefined ? JSON.stringify(body) : undefined)) as BodyInit | undefined, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, json: text.startsWith('{') ? JSON.parse(text) : {}, headers: res.headers };
  }
  async signInFromLink(link: string) {
    await this.req('POST', '/api/auth/email', { email: this.email });
    const v = new URL(/https?:\/\/\S+/.exec((await (app.mailer as OutboxMailer).latestFor(this.email))!.text)![0]);
    await this.req('GET', v.pathname + v.search);
    const inv = new URL(link);
    await this.req('GET', inv.pathname + inv.search);
  }
  async upload(pid: string, file: string) {
    const data = await fs.readFile(file);
    const st = await fs.stat(file);
    const c = await this.req('POST', `/api/projects/${pid}/uploads`, { fileName: path.basename(file), size: data.length, lastModified: st.mtimeMs });
    let offset = c.json.offset as number;
    while (offset < data.length) offset = (await this.req('PUT', `/api/uploads/${c.json.uploadId}?offset=${offset}`, undefined, data.subarray(offset, offset + c.json.chunkBytes))).json.offset;
  }
}

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
  await page.waitForFunction(() => /1 already uploaded, skipped/.test(document.getElementById('upload-summary')?.textContent ?? '') && window.tripalogue!.session!.state.media.length === 26
    && window.tripalogue!.session!.state.media.every((m) => !m.status || m.status === 'ready'), null, { timeout: 90_000 });
  check('uploaded photos are filed by their capture time with no clicks', await chapterOf('DSC_0103.jpg') === 'ch-sintra' && await chapterOf('IMG_3002.jpg') === 'ch-lisbon',
    `DSC_0103 → ${await chapterOf('DSC_0103.jpg')}`);
  check('a byte-for-byte copy of a photo already in the travelogue is not uploaded again (MM-7)', !(await page.evaluate(() => window.tripalogue!.session!.state.media.some((m) => m.uri === 'copy-of-alfama.jpg'))),
    await page.textContent('#upload-summary') ?? '');
  check('the slow camera puts its late-night photos in the wrong chapter (the planted error)', await chapterOf('DSC_0101.jpg') === 'ch-lisbon' && await chapterOf('DSC_0102.jpg') === 'ch-lisbon');
  const srcs = await page.evaluate(() => window.tripalogue!.session!.state.sources.map((x) => x.displayName));
  check('uploads are grouped by camera, so one camera’s clock can be fixed alone', (await byName('DSC_0101.jpg')).sourceId !== (await byName('IMG_3002.jpg')).sourceId && srcs.some((n) => /Canon EOS R6/.test(n)) && srcs.some((n) => /iPhone 15 Pro/.test(n)),
    srcs.join(' | '));

  // Two more travelers join as contributors and upload from their own devices.
  // Ana also uploads, from her own device, a copy of a photo Jody already added (she was sent it): a duplicate (MM-8).
  for (const [who, list] of [['ana@example.com', [...ana, dupe]], ['ben@example.com', ben]] as const) {
    await page.evaluate(async ([p, email]) => fetch(`/api/projects/${p}/invites`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tripalogue-client': '1' }, body: JSON.stringify({ email, role: 'contributor' }) }), [pid, who]);
    const invite = /https?:\/\/\S+accept\S+/.exec((await (app.mailer as OutboxMailer).latestFor(who))!.text)![0];
    const t = new Traveler(who);
    await t.signInFromLink(invite);
    for (const f of list) await t.upload(pid, f);
  }
  await page.click('.tabs button[data-tab="Upload"]');
  await page.setInputFiles('#upload-input', [memo]);
  await page.click('#upload-start');
  await app.jobs.idle();
  await page.waitForFunction(() => window.tripalogue!.session!.state.media.length === 32, null, { timeout: 30_000 });

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
  check('the Unassigned bin is listed first with its count', unassigned === 5 && /5 unassigned/.test(summary ?? ''), summary ?? '');
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
  // An unrelated update (autosave status, another upload finishing) must not wipe what was typed.
  await page.evaluate(() => { window.tripalogue!.media!.update(); window.tripalogue!.media!.update(); });
  const kept = [await page.inputValue('#shift-hours'), await page.inputValue('#shift-minutes')];
  check('typing in the inspector survives unrelated updates', kept[0] === '0' && kept[1] === '30', kept.join(' h '));
  await page.click('#apply-shift');
  await saved(page);
  const shifted = await byName('DSC_0101.jpg');
  check('Shift-click selects a range, and Shift moves all of them', sel >= 3 && shifted.userTimestamp === '2026-05-03T23:50:00Z', `${sel} selected; DSC_0101 now ${shifted.userTimestamp}`);

  // ---- slice C: contributors, the metadata check, locations, audio ----
  await page.waitForSelector('.media-contributors .contributor');
  const reportText = async (email: string) => {
    const uid = (await app.auth.upsertUser(email)).id;
    return page.locator(`.media-contributors .contributor[data-contributor="${uid}"]`).textContent();
  };
  const anaReport = await reportText('ana@example.com');
  const benReport = await reportText('ben@example.com');
  check('the contributor check finds who sent copies stripped of time and place (G2)', !/WhatsApp/.test(anaReport ?? '') && /2 without a capture time/.test(benReport ?? '') && /2 without a location/.test(benReport ?? '') && /2 look like copies \(WhatsApp\)/.test(benReport ?? ''),
    `Ana: ${anaReport?.replace(/\s+/g, ' ').trim()} | Ben: ${benReport?.replace(/\s+/g, ' ').trim()}`);
  const benId = (await app.auth.upsertUser('ben@example.com')).id;
  await page.click(`.media-contributors button[data-ask="${benId}"]`);
  const note = await page.inputValue('#ask-text');
  check('a ready-to-send note asks Ben for the originals', /^Hi ben,/i.test(note) && /WhatsApp/.test(note) && /Options/.test(note), note.split('\n')[2]?.slice(0, 120));
  await page.locator('#ask-dialog').screenshot({ path: path.join(outDir, '03-ask-for-originals.png') });
  await page.click('#ask-close');
  await page.click('.media-contributors .contributor[data-contributor="' + benId + '"] button[data-check="noPlace"]');
  await settle();
  check('a contributor’s problem items can be shown on their own', await page.locator('#media-grid .tile').count() === 2 && /Showing: .*without a location \(2\)/.test(await page.textContent('#media-focus') ?? ''));
  await page.click('#clear-focus');

  const far = await byName('IMG_7002.jpg');
  await page.click('.media-filters button[data-filter="far"]');
  await settle();
  check('a photo taken far from its chapter is flagged (likely misassigned)', far.chapterId === 'ch-lisbon' && await page.locator('#media-grid .tile').count() === 1 && /km/.test((await tile('IMG_7002.jpg').textContent()) ?? ''),
    `${(await tile('IMG_7002.jpg').textContent())?.replace(/\s+/g, ' ')}`);
  await page.click('.media-filters button[data-filter="all"]');

  // Locations: from the chapter, by clicking the map, and copy/paste.
  await tile('DSC_0101.jpg').click();
  await page.click('#loc-chapter');
  await saved(page);
  const fromChapter = (await byName('DSC_0101.jpg')).location;
  await page.click('#loc-copy');
  await tile('DSC_0103.jpg').click();
  await page.click('#loc-paste');
  await saved(page);
  const pasted = (await byName('DSC_0103.jpg')).location;
  await tile('DSC_0102.jpg').click();
  await page.click('#loc-pick');
  const mapBox = (await page.locator('#media-map canvas').boundingBox())!;
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await saved(page);
  const picked = (await byName('DSC_0102.jpg')).location;
  check('a location can be set from the chapter, pasted from another item, or picked on the map (MM-9)', !!fromChapter && JSON.stringify(pasted) === JSON.stringify(fromChapter) && !!picked && JSON.stringify(picked) !== JSON.stringify(fromChapter),
    `${JSON.stringify(fromChapter)} / picked ${JSON.stringify(picked)}`);
  const dots = await page.evaluate(() => window.tripalogue!.session!.state.media.filter((m) => m.location).length);
  await page.locator('.media-map-box').screenshot({ path: path.join(outDir, '04-media-map.png') });
  check('the media map shows a dot for every located item', /\d+ of 32 items have a location/.test(await page.textContent('#media-map-hint') ?? '') && dots >= 5, await page.textContent('#media-map-hint') ?? '');

  const memoItem = await byName('Memo Porto.m4a');
  check('a voice memo is filed by its recording time, with a waveform thumbnail (MM-15)', memoItem.kind === 'audio' && memoItem.chapterId === 'ch-porto' && !!memoItem.assets?.thumb && Math.round(memoItem.durationSec ?? 0) === 3);

  // MM-16: name the traveler behind the imported sample source.
  const anaId = (await app.auth.upsertUser('ana@example.com')).id;
  await page.selectOption('.media-sources .source[data-source="src-camera"] select.traveler', anaId);
  await saved(page);
  await settle();
  check('a source can be credited to a traveler, and items show who sent them (MM-16)', (await page.evaluate(() => window.tripalogue!.session!.state.sources.find((x) => x.id === 'src-camera')!.contributorId)) === anaId
    && await page.locator('#media-grid .tile .who').count() === 32);
  const guide = await page.evaluate(async () => (await fetch('/guide-contributors.html')).status);
  check('the contributor guide is linked from the Upload tab and served (MM-18)', guide === 200);

  // ---- slice D: drag-and-drop and folder uploads, skipping what is already uploaded ----
  const folder = path.join(files, 'Trip folder');
  mkdirSync(path.join(folder, 'Day 2', 'Evening'), { recursive: true });
  await photo('IMG_9001.jpg', 'brown', ['2026:05:07 09:00:00', 1, { make: 'Apple', model: 'iPhone 15 Pro', offset: '+01:00' }]);
  await fs.rename(path.join(files, 'IMG_9001.jpg'), path.join(folder, 'IMG_9001.jpg'));
  await fs.copyFile(slow[0], path.join(folder, 'Day 2', 'DSC_0101.jpg')); // already uploaded
  await photo('IMG_9002.jpg', 'coral', ['2026:05:09 20:00:00', 1, { make: 'Apple', model: 'iPhone 15 Pro', offset: '+01:00' }]);
  await fs.rename(path.join(files, 'IMG_9002.jpg'), path.join(folder, 'Day 2', 'Evening', 'IMG_9002.jpg'));
  await fs.writeFile(path.join(folder, '.DS_Store'), 'x');
  await fs.writeFile(path.join(folder, 'notes.txt'), 'packing list');
  const before = await page.evaluate(() => window.tripalogue!.session!.state.media.length);
  await page.click('#view-play');
  await page.click('.tabs button[data-tab="Upload"]');
  await page.locator('#drop-zone').screenshot({ path: path.join(outDir, '05-drop-zone.png') });
  await page.setInputFiles('#upload-folder', folder);
  await page.waitForFunction(() => /already uploaded, skipped/.test(document.getElementById('upload-summary')?.textContent ?? '') && /2 of 2 files/.test(document.getElementById('upload-summary')?.textContent ?? ''), null, { timeout: 60_000 });
  const folderSummary = await page.textContent('#upload-summary');
  await app.jobs.idle();
  await page.waitForFunction((n) => window.tripalogue!.session!.state.media.length === n + 2
    && window.tripalogue!.session!.state.media.filter((m) => /IMG_900[12]/.test(m.uri)).every((m) => m.status === 'ready'), before, { timeout: 30_000 });
  check('a whole folder uploads its media (subfolders included), skipping system files, text files and files already uploaded (MM-1, MM-7)',
    await chapterOf('IMG_9001.jpg') === 'ch-porto' && await chapterOf('IMG_9002.jpg') === 'ch-douro' && /1 already uploaded, skipped/.test(folderSummary ?? ''),
    `${folderSummary}; IMG_9001 → ${await chapterOf('IMG_9001.jpg')}, IMG_9002 → ${await chapterOf('IMG_9002.jpg')}; uris ${(await page.evaluate(() => window.tripalogue!.session!.state.media.slice(-2).map((m) => m.uri))).join(', ')}`);
  // The same files picked again: nothing is sent twice.
  await page.setInputFiles('#upload-input', [path.join(folder, 'IMG_9001.jpg'), phone]);
  await page.click('#upload-start');
  await page.waitForFunction(() => /2 already uploaded, skipped/.test(document.getElementById('upload-summary')?.textContent ?? ''), null, { timeout: 30_000 });
  check('picking files that are already uploaded uploads nothing', await page.evaluate(() => window.tripalogue!.session!.state.media.length) === before + 2);
  // Drag-and-drop onto the drop zone (a file built in the page, dropped as a browser would).
  const dropped = await page.evaluateHandle(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 64, height: 48 });
    c.getContext('2d')!.fillRect(0, 0, 64, 48);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'dropped.jpg', { type: 'image/jpeg', lastModified: Date.parse('2026-05-08T12:00:00Z') }));
    return dt;
  });
  await page.dispatchEvent('#drop-zone', 'drop', { dataTransfer: dropped });
  await page.waitForFunction(() => window.tripalogue!.session!.state.media.some((m) => m.uri === 'dropped.jpg' && m.status === 'ready'), null, { timeout: 30_000 });
  check('files dropped on the Upload tab are uploaded and filed (by file date when they have no camera time)', await chapterOf('dropped.jpg') === 'ch-douro');
  await page.click('#view-media');

  // Everything is saved on the server and survives a reload.
  await page.reload();
  await page.waitForSelector('#media-grid .tile');
  const doc = app.projects.load(pid).doc;
  const where = (n: string) => doc.media.find((m) => m.uri.endsWith(n))!.chapterId;
  check('all fixes are saved and survive a reload', where('IMG_3001.jpg') === 'ch-porto' && where('Screenshot 2026-05-20.jpg') === 'ch-douro' && where('DSC_0102.jpg') === 'ch-sintra'
    && doc.sources.find((s) => s.id === src)!.clockOffsetSec === 3600 && !!doc.media.find((m) => m.uri === 'DSC_0102.jpg')!.location);

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
