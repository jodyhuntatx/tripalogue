/**
 * Phase 1 browser test: the G1 usability tasks, scripted.
 *
 * Runs the web app against a stand-in map provider (place search and simple
 * generated tiles, so no internet is needed) and, in headless Chromium:
 * creates a travelogue, pastes most of an 8-chapter trip with a preview, adds
 * the rest by hand using place search, splits a day, fixes a planted overlap,
 * drops a pin on the map, checks everything survives a reload, and plays the
 * chapter title cards. Report and screenshots go to docs/phase1-test/.
 *
 *   node --import tsx scripts/phase1-test.ts
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { chromium, type Page } from 'playwright';
import { analyzeItinerary } from '../src/core/index.js';
import { startApp } from '../src/server/app.js';
import { geoConfigFromEnv } from '../src/server/geo.js';
import type { OutboxMailer } from '../src/server/mailer.js';
import type {} from '../src/web/main.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/phase1-test');

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---- stand-in map provider ----
const PLACES: Record<string, [string, string, number, number]> = {
  lisbon: ['Lisboa', 'Lisboa, Lisbon, Portugal', 38.7077, -9.1365],
  sintra: ['Sintra', 'Sintra, Lisbon, Portugal', 38.8029, -9.3817],
  porto: ['Porto', 'Porto, Portugal', 41.1579, -8.6291],
  pinhao: ['Pinhão', 'Pinhão, Alijó, Vila Real, Portugal', 41.1906, -7.5458],
  coimbra: ['Coimbra', 'Coimbra, Portugal', 40.2111, -8.4291],
  evora: ['Évora', 'Évora, Portugal', 38.5714, -7.9135],
  lagos: ['Lagos', 'Lagos, Faro, Portugal', 37.1028, -8.6730],
  nazare: ['Nazaré', 'Nazaré, Leiria, Portugal', 39.6012, -9.0700],
};
function png(z: number, x: number, y: number): Buffer {
  const w = 256;
  const raw = Buffer.alloc((w * 3 + 1) * w);
  const base = [[52, 72, 92], [58, 84, 66], [70, 80, 60]][(x + y + z) % 3];
  for (let r = 0; r < w; r++) {
    raw[r * (w * 3 + 1)] = 0;
    for (let c = 0; c < w; c++) {
      const line = r % 64 === 0 || c % 64 === 0;
      const o = r * (w * 3 + 1) + 1 + c * 3;
      raw[o] = line ? base[0] + 30 : base[0];
      raw[o + 1] = line ? base[1] + 30 : base[1];
      raw[o + 2] = line ? base[2] + 30 : base[2];
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const provider = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/search') {
    const q = (u.searchParams.get('q') ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const hits = Object.entries(PLACES).filter(([k]) => q.includes(k)).map(([, [name, display, lat, lon]]) => ({ name, display_name: display, lat: String(lat), lon: String(lon), type: 'city' }));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(hits));
  }
  const t = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(u.pathname);
  if (t) {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(png(+t[1], +t[2], +t[3]));
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) await fs.rm(path.join(outDir, f));
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tripalogue-p1-'));
const app = await startApp({
  dataDir, port: 0, log: () => {},
  geo: geoConfigFromEnv(dataDir, { geocoderUrl: `${providerUrl}/search`, tileUrl: `${providerUrl}/tiles/{z}/{x}/{y}.png`, attribution: '© Test tiles', minSearchIntervalMs: 50 }),
});
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('response', async (r) => { if (r.status() === 422) consoleErrors.push(`422 ${r.url()}: ${await r.text().catch(() => '')}`); });
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
const shot = (name: string) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
const saved = (p: Page) => p.waitForFunction(() => window.tripalogue!.session!.unsaved === 0 && window.tripalogue!.session!.status === 'saved', null, { timeout: 10_000 })
  .catch(async (e) => {
    const st = await p.evaluate(() => ({ status: window.tripalogue!.session!.status, unsaved: window.tripalogue!.session!.unsaved, err: (window.tripalogue!.session as unknown as { lastError?: string }).lastError }));
    throw new Error(`not saved: ${JSON.stringify(st)} console: ${consoleErrors.join(' | ')}`, { cause: e });
  });
const serverDoc = (id: string) => app.projects.load(id).doc;
const card = (n: number) => page.locator('#chapter-cards > li').nth(n - 1);

try {
  const t0 = Date.now();
  // Sign in and create a travelogue: an empty project opens in the Itinerary view.
  await page.goto(app.url);
  await page.fill('input[type=email]', 'traveler@example.com');
  await page.click('button[type=submit]');
  await page.waitForSelector('text=Check your email');
  await page.goto(/https?:\/\/\S+/.exec((await (app.mailer as OutboxMailer).latestFor('traveler@example.com'))!.text)![0]);
  await page.fill('input[aria-label="New travelogue name"]', 'Portugal by train');
  await page.click('text=Create');
  await page.waitForFunction(() => !!window.tripalogue?.session, null, { timeout: 10_000 }).catch(() => { throw new Error(`project did not open: ${consoleErrors.join(' | ')}`); });
  const pid = page.url().split('#/p/')[1].split('/')[0];
  check('a new travelogue opens in the Itinerary view', page.url().endsWith('/itinerary'));

  // Task 1a: paste most of the trip, check the preview, add.
  await page.click('#open-import');
  await page.fill('#import-tz', 'Europe/Lisbon');
  await page.fill('#import-text', [
    'May 1, 2026, Lisbon, arrive and explore Alfama',
    'May 2, 2026, Lisbon, Belém and pastéis',
    'May 3, 2026, Sintra, Pena Palace',
    '2026-05-04 to 2026-05-05  Coimbra — university and old town',
    'May 6-8, 2026 Porto - bookshops and port lodges',
    '5/9/2026, Pinhão, Douro valley by train',
    'not a real line',
  ].join('\n'));
  await page.waitForFunction(() => document.querySelectorAll('#import-preview tbody tr').length === 5);
  const previewText = await page.textContent('#import-preview');
  check('the paste preview shows 5 chapters, folds two Lisbon days, and flags the bad line',
    /consecutive days/.test(previewText ?? '') && /Line 7/.test(previewText ?? ''), '6 lines read as 5 chapters');
  await shot('01-import-preview');
  await page.click('#import-add');
  await saved(page);
  check('importing adds the chapters to the project on the server', serverDoc(pid).chapters.length === 5);

  // Task 1b: add three chapters by hand, with place search.
  for (const [placeName, start, end] of [['Évora', '2026-05-10T00:00', '2026-05-11T23:59'], ['Lagos', '2026-05-12T00:00', '2026-05-13T23:59'], ['Nazaré', '2026-05-14T00:00', '2026-05-14T23:59']] as const) {
    const n = (await page.locator('#chapter-cards > li').count()) + 1;
    await page.click('#add-chapter');
    await page.waitForFunction((k) => document.querySelectorAll('#chapter-cards > li').length === k, n);
    const c = card(n);
    await c.locator('input.place').fill(placeName);
    await c.locator('button', { hasText: 'Find' }).click();
    await c.locator('.place-results .result').first().click();
    await c.locator('input[aria-label="Start"]').fill(start);
    await c.locator('input[aria-label="End"]').fill(end);
    await c.locator('input[aria-label="End"]').press('Tab');
  }
  await saved(page);
  let doc = serverDoc(pid);
  check('three chapters added by hand, titled and pinned from place search', doc.chapters.length === 8 && doc.chapters.slice(5).every((c) => c.title && c.coordinates),
    doc.chapters.slice(5).map((c) => `${c.title} ${c.coordinates?.lat.toFixed(2)}`).join(', '));
  check('the 8-chapter trip has no overlaps or gaps', analyzeItinerary(doc).length === 0);
  const enterSec = (Date.now() - t0) / 1000;

  // Find places for the pasted chapters too, so the route map is complete except one.
  for (let n = 1; n <= 4; n++) {
    await card(n).locator('button', { hasText: 'Find' }).click();
    await card(n).locator('.place-results .result').first().click();
  }
  await saved(page);
  doc = serverDoc(pid);
  const pinned = doc.chapters.filter((c) => c.coordinates).length;
  check('place search pins every chapter it is used on', pinned === 7, `${pinned} of 8 pinned; Pinhão left for a dropped pin`);

  // Task: drop a pin for Pinhão by clicking the map.
  await card(5).locator('button', { hasText: 'Drop pin' }).click();
  await page.waitForSelector('.map-hint:not([hidden])');
  const target = await page.evaluate(() => {
    const m = window.tripalogue!.itinerary!.map;
    const porto = window.tripalogue!.session!.state.chapters.find((c) => c.locationName.startsWith('Porto'))!;
    const s = m.screenPos(porto.id)!;
    return { x: s.x + 40, y: s.y };
  });
  const box = (await page.locator('.route-map canvas').boundingBox())!;
  await page.mouse.click(box.x + target.x, box.y + target.y);
  await saved(page);
  doc = serverDoc(pid);
  const pinhao = doc.chapters[4];
  check('dropping a pin on the map sets the chapter location', !!pinhao.coordinates && pinhao.title === 'Pinhão' && pinhao.coordinates.lng > -8.6, `${pinhao.coordinates?.lat.toFixed(3)}, ${pinhao.coordinates?.lng.toFixed(3)}`);
  const mapPins = await page.evaluate(() => window.tripalogue!.session!.state.chapters.filter((c) => c.coordinates).length);
  check('the route map shows a numbered pin for every located chapter', mapPins === 8);
  await shot('02-itinerary-map-timeline');

  // Task 2: split the Porto chapter (3 days) into two.
  const portoIdx = doc.chapters.findIndex((c) => c.title === 'Porto') + 1;
  await card(portoIdx).locator('button', { hasText: 'Split…' }).click();
  await card(portoIdx).locator('input[aria-label="Split at"]').fill('2026-05-08T00:00');
  await card(portoIdx).locator('button', { hasText: 'Split here' }).click();
  await saved(page);
  doc = serverDoc(pid);
  check('splitting a chapter makes two back-to-back chapters', doc.chapters.length === 9 && doc.chapters[portoIdx - 1].end === '2026-05-08T00:00' && doc.chapters[portoIdx].start === '2026-05-08T00:00' && analyzeItinerary(doc).length === 0,
    `${doc.chapters[portoIdx - 1].title} | ${doc.chapters[portoIdx].title}`);
  await card(portoIdx + 1).locator('input.title').fill('Douro river cruise');
  await saved(page);

  // Task 3: a planted overlap is flagged and fixed.
  app.projects.acquireLock(pid, app.auth.upsertUser('traveler@example.com'));
  await page.evaluate(() => window.tripalogue!.session!.edit('Planted overlap', (p) => ({ ...p, chapters: p.chapters.map((c, i) => (i === 2 ? { ...c, start: '2026-05-03T12:00' } : c)) })));
  await page.waitForSelector('#itinerary-issues .issue.overlap');
  const issueText = await page.textContent('#itinerary-issues');
  check('an overlap is flagged in plain words, on the list and on the card', /overlap by 12 hours/.test(issueText ?? '') && (await card(3).getAttribute('class'))!.includes('has-issue'), issueText?.trim());
  await shot('03-overlap-flagged');
  await card(3).locator('input[aria-label="Start"]').fill('2026-05-04T00:00');
  await card(3).locator('input[aria-label="Start"]').press('Tab');
  await saved(page);
  check('fixing the date clears the warning', analyzeItinerary(serverDoc(pid)).length === 0 && (await page.locator('#itinerary-issues .issue').count()) === 0);

  // Timeline shows every chapter.
  const blocks = await page.locator('#itinerary-timeline .block').count();
  check('the timeline shows a block for every chapter', blocks === 9, `${blocks} blocks`);

  // Undo and redo across itinerary edits.
  const titleBefore = serverDoc(pid).chapters[portoIdx].title;
  await page.click('#undo');
  await saved(page);
  const undone = serverDoc(pid).chapters[2].start;
  await page.click('#redo');
  await saved(page);
  check('undo and redo work on itinerary edits and are saved', undone === '2026-05-03T12:00' && serverDoc(pid).chapters[2].start === '2026-05-04T00:00', `title still "${titleBefore}"`);

  // Reload: everything persisted.
  await page.reload();
  await page.waitForSelector('#chapter-cards > li');
  const afterReload = await page.locator('#chapter-cards > li').count();
  const titleAfter = await card(portoIdx + 1).locator('input.title').inputValue();
  check('the itinerary survives a reload', afterReload === 9 && titleAfter === 'Douro river cruise');

  // Task: play the chapter title cards (IT-5).
  await page.evaluate(() => window.tripalogue!.player!.setRate(8));
  await page.click('#play-title-cards');
  await page.waitForFunction(() => document.body.dataset.state === 'ended', null, { timeout: 30_000 });
  const stats = await page.evaluate(() => ({ entered: window.tripalogue!.player!.stats.segmentsEntered, n: window.tripalogue!.player!.timeline.segments.length, d: window.tripalogue!.player!.duration }));
  check('Play runs all 9 chapter title cards in order', stats.n === 9 && JSON.stringify([...new Set(stats.entered)]) === JSON.stringify([...Array(9).keys()]), `${stats.d} s`);
  await page.evaluate(() => window.tripalogue!.player!.seek(10.5));
  await page.waitForTimeout(300);
  await page.locator('#stage').screenshot({ path: path.join(outDir, '04-title-card.png') });

  check('no errors in the browser console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ date: new Date().toISOString(), browser: browser.version(), enterTripSec: enterSec, checks }, null, 2));
  console.log(`(scripted entry of the 8-chapter trip took ${enterSec.toFixed(1)} s; the G1 target for a person is under 10 minutes)`);
} finally {
  await browser.close();
  await app.close();
  provider.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.pass);
console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nAll ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
