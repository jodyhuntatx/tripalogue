/**
 * Phase 3 browser test: the presentation editor, scripted like the G3 usability tasks.
 *
 * Builds a 12-minute auto-draft (the sample trip plus 150 generated photos, 30 of them portrait), imports it with
 * its originals, adds a song and a voice memo, then in the Edit view:
 *   1. cuts the draft to about 5 minutes against a 5:00 target: bulk durations, excluding a run of clips with the
 *      Delete key, dragging a clip's edge, reordering by drag (and across chapters, keeping the time), restoring;
 *   2. repositions three portrait photos on the stage (custom placement, drag to a third, shrink from a corner);
 *   3. lays the song under one chapter (Music lane) and the memo on a picture (Narration), checks the anchored
 *      memo follows its picture through a reorder and a trim, and that music ducks under narration;
 * plus play-this-chapter, reset-chapter, edit-to-preview latency, a reload, and a 300-item travelogue played
 * through without stalls. Report and screenshots go to docs/phase3-test/.
 *
 *   node --import tsx scripts/phase3-test.ts
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Page } from 'playwright';
import { parseProject, serializeProject, spreadKeys, defaultCue, createProject, type MediaItem, type Travelogue } from '../src/core/index.js';
import { startApp } from '../src/server/app.js';
import { geoConfigFromEnv } from '../src/server/geo.js';
import type {} from '../src/web/main.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/phase3-test');
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
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tripalogue-p3-'));
const gen = path.join(dataDir, 'generated');
mkdirSync(gen);

// ---- the 12-minute draft: the sample plus 150 photos spread over the four chapters ----
const colors = (i: number) => `0x${((i * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')}`;
async function still(file: string, color: string, size: string) {
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', '-q:v', '5', file]);
}
const sample = parseProject(readFileSync(path.join(sampleDir, 'trip.travelogue.json'), 'utf8')).project;
const days: Record<string, string[]> = { 'ch-lisbon': ['2026-05-01', '2026-05-02', '2026-05-03'], 'ch-sintra': ['2026-05-04'], 'ch-porto': ['2026-05-05', '2026-05-06', '2026-05-07'], 'ch-douro': ['2026-05-08', '2026-05-09', '2026-05-10'] };
const extra: MediaItem[] = [];
const chIds = Object.keys(days);
for (let i = 0; i < 150; i++) {
  const ch = chIds[i % 4];
  const day = days[ch][Math.floor(i / 4) % days[ch].length];
  const portrait = i % 5 === 2;
  const minute = 9 * 60 + ((i * 7) % 600);
  extra.push({
    id: `g${String(i).padStart(3, '0')}`, sourceId: 'src-camera', uri: `gen-${String(i).padStart(3, '0')}.jpg`, kind: 'image',
    capturedAt: `${day}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`, timestampConfidence: 'high',
    width: portrait ? 480 : 640, height: portrait ? 640 : 480, chapterId: ch,
  });
}
await Promise.all(Array.from({ length: 8 }, async (_, k) => {
  for (let i = k; i < extra.length; i += 8) await still(path.join(gen, extra[i].uri), colors(i + 1), `${extra[i].width}x${extra[i].height}`);
}));
function withExtra(p: Travelogue, items: MediaItem[]): Travelogue {
  let cues = p.cues.slice();
  for (const ch of p.chapters) {
    const mine = items.filter((m) => m.chapterId === ch.id);
    const existing = p.cues.filter((c) => p.media.find((m) => m.id === c.itemId)?.chapterId === ch.id).sort((a, b) => (a.order < b.order ? -1 : 1));
    // Re-key the whole chapter: sample items first, then the new ones.
    const keys = spreadKeys(existing.length + mine.length);
    const rekey = new Map(existing.map((c, i) => [c.itemId, keys[i]]));
    cues = cues.map((c) => (rekey.has(c.itemId) ? { ...c, order: rekey.get(c.itemId)! } : c));
    cues.push(...mine.map((m, i) => defaultCue(m, p.cueProfile, keys[existing.length + i])));
  }
  return { ...p, media: [...p.media, ...items], cues };
}
const draft = withExtra(sample, extra);
const draftFile = path.join(gen, 'draft.travelogue.json');
writeFileSync(draftFile, serializeProject({ ...draft, title: 'Portugal draft (12 min)' }));
const draftMedia = [...readdirSync(path.join(sampleDir, 'media')).map((f) => path.join(sampleDir, 'media', f)), ...extra.map((m) => path.join(gen, m.uri))];

// Audio: a 90 s song and a 6 s voice memo (no capture time: they wait in "Audio to place").
const song = path.join(gen, 'Fado song.m4a');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=90', '-c:a', 'aac', '-b:a', '64k', song]);
const memo = path.join(gen, 'Memo bridge.m4a');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=6', '-c:a', 'aac', '-b:a', '64k', memo]);

// ---- a 300-item travelogue for the playback check ----
const big = createProject({ title: 'Three hundred', now: new Date('2026-06-01T00:00:00Z') });
const bigChapters = ['Day one', 'Day two', 'Day three'].map((title, i) => ({
  id: `b${i}`, title, locationName: '', start: `2026-06-0${i + 1}T00:00`, end: `2026-06-0${i + 1}T23:59`, timeZone: 'UTC', description: '', titleCard: { enabled: true },
}));
const bigItems: MediaItem[] = Array.from({ length: 300 }, (_, i) => ({
  id: `p${i}`, sourceId: 'src-big', uri: `big-${String(i).padStart(3, '0')}.jpg`, kind: 'image', width: 640, height: 360,
  capturedAt: `2026-06-0${Math.floor(i / 100) + 1}T${String(8 + Math.floor((i % 100) / 10)).padStart(2, '0')}:${String((i % 10) * 5).padStart(2, '0')}:00`,
  timestampConfidence: 'high', chapterId: `b${Math.floor(i / 100)}`,
}));
const bigProject: Travelogue = {
  ...big, chapters: bigChapters, sources: [{ id: 'src-big', type: 'upload', displayName: 'Big camera', clockOffsetSec: 0 }],
  media: bigItems,
  cues: bigChapters.flatMap((c) => { const ms = bigItems.filter((m) => m.chapterId === c.id); const k = spreadKeys(ms.length); return ms.map((m, i) => ({ ...defaultCue(m, big.cueProfile, k[i]), durationSec: 1 })); }),
};
await Promise.all(Array.from({ length: 8 }, async (_, k) => {
  for (let i = k; i < bigItems.length; i += 8) await still(path.join(gen, bigItems[i].uri), colors(1000 + i), '640x360');
}));
const bigFile = path.join(gen, 'big.travelogue.json');
writeFileSync(bigFile, serializeProject(bigProject));

const app = await startApp({ dataDir, port: 0, log: () => {}, geo: geoConfigFromEnv(dataDir, { tileUrl: '', geocoderUrl: '' }) });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
/** Upload, Members and Versions live in the Itinerary view's travelogue panel (lower right). */
const panelTab = async (t: 'Upload' | 'Versions') => {
  await page.click('#view-itinerary');
  await page.click(`#project-panel button[data-tab="${t}"]`);
};
const consoleErrors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(e.stack ?? e.message));
page.on('response', (r) => { if (r.status() === 404) consoleErrors.push(`404 ${r.request().method()} ${new URL(r.url()).pathname}`); });
const shot = (name: string) => page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
const saved = (p: Page) => p.waitForFunction(() => window.tripalogue!.session!.unsaved === 0 && window.tripalogue!.session!.status === 'saved', null, { timeout: 10_000 });
const settle = () => page.waitForTimeout(200);
const state = () => page.evaluate(() => window.tripalogue!.session!.state);
const tl = () => page.evaluate(() => {
  const t = window.tripalogue!.player!.timeline;
  return {
    duration: t.duration,
    chapters: t.chapters.map((c) => ({ id: c.chapterId, start: c.start, end: c.end })),
    segs: t.segments.filter((s) => s.kind !== 'title').map((s) => ({ id: (s as { item: { id: string } }).item.id, start: s.start, duration: s.duration, chapterId: s.chapterId })),
    audio: t.audio.map((c) => ({ id: c.item.id, start: c.start, duration: c.duration, laneId: c.laneId, anchorItemId: c.anchorItemId, chapterId: c.chapterId })),
  };
});
const clip = (id: string) => page.locator(`#pe-visual .pe-clip[data-item="${id}"]`);
const clipBox = async (id: string) => {
  await clip(id).scrollIntoViewIfNeeded();
  return (await clip(id).boundingBox())!;
};

async function importProject(file: string, media: string[], count: number) {
  await page.goto(`${app.url}#/projects`);
  await page.waitForSelector('#import-json');
  await page.setInputFiles('#import-json', file);
  await page.setInputFiles('#import-media', media);
  await page.click('#import-start');
  await page.waitForURL(/#\/p\//, { timeout: 180_000 });
  await page.waitForFunction((n) => document.getElementById('meta')?.dataset.ready === String(n), count, { timeout: 300_000, polling: 500 });
  return page.url().split('#/p/')[1].split('/')[0];
}

try {
  await page.goto(app.url);
  const pid = await importProject(draftFile, draftMedia, 170);

  // The song and the memo, from the Upload tab.
  await page.click('#view-mix');
  await panelTab('Upload');
  await page.setInputFiles('#upload-input', [song, memo]);
  await page.click('#upload-start');
  await page.waitForFunction(() => { const m = window.tripalogue!.session!.state.media.filter((x) => x.kind === 'audio'); return m.length === 2 && m.every((x) => x.status === 'ready'); }, null, { timeout: 60_000 });
  const audioId = async (name: string) => (await state()).media.find((m) => m.uri.endsWith(name))!.id;
  const songId = await audioId('Fado song.m4a');
  const memoId = await audioId('Memo bridge.m4a');

  // ---- the Edit view ----
  await page.click('#view-mix');
  await page.waitForSelector('#pe-timeline:not([hidden]) #pe-visual .pe-clip[data-item]');
  const t0 = await tl();
  const clipsShown = await page.locator('#pe-visual .pe-clip[data-item]').count();
  check('the Edit view shows the whole travelogue as a timeline grouped by chapter, each clip as long as it plays (PE-1)',
    clipsShown === t0.segs.length && await page.locator('#pe-timeline .pe-chapter').count() === 4 && t0.duration > 11 * 60,
    `${clipsShown} clips in 4 chapters, ${fmt(t0.duration)} draft`);
  const w1 = (await clipBox(t0.segs[0].id)).width, w2 = (await clipBox(t0.segs.find((s) => Math.abs(s.duration - 6) < 0.01)!.id)).width;
  check('clip widths follow their durations', Math.abs(w2 / w1 - 6 / 4) < 0.1, `${w1.toFixed(0)} px for 4 s, ${w2.toFixed(0)} px for 6 s`);
  await shot('01-edit-view');

  // ---- Task 1: cut to about 5 minutes ----
  await page.fill('#pe-target', '5:00');
  await page.locator('#pe-target').press('Enter');
  await page.locator('#pe-target').blur();
  await saved(page);
  check('a 5:00 target is set and the runtime shows against it (PE-9)', (await state()).targetSec === 300 && await page.locator('#pe-bar.over').count() === 1
    && /Runtime 1[12]:/.test(await page.textContent('#pe-total') ?? ''), await page.textContent('#pe-total') ?? '');

  // Bulk: every clip to 2.5 s (click the first, Shift-click the last).
  await clip(t0.segs[0].id).click();
  await clip(t0.segs[t0.segs.length - 1].id).click({ modifiers: ['Shift'] });
  const nSel = await page.evaluate(() => window.tripalogue!.editor!.selection().length);
  await page.fill('#pe-duration', '2.5');
  await page.locator('#pe-duration').dispatchEvent('change');
  await saved(page);
  const t1 = await tl();
  check('select every clip with Shift-click and set them all to 2.5 s; videos are trimmed to it (PE-8, PE-5)',
    nSel === t0.segs.length && t1.segs.every((s) => Math.abs(s.duration - 2.5) < 0.01), `${nSel} selected; now ${fmt(t1.duration)}`);

  // Exclude a run of 60 clips in Porto and Douro with the Delete key.
  const later = t1.segs.filter((s) => s.chapterId === 'ch-porto' || s.chapterId === 'ch-douro');
  const run1 = later.slice(5, 65).map((s) => s.id);
  await clip(run1[0]).click();
  await clip(run1[run1.length - 1]).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Delete');
  await saved(page);
  const t2 = await tl();
  const excludedCount = Number((await page.textContent('#pe-excluded summary .count'))?.trim());
  check('Delete takes the selected clips out of the cut; they wait in the Excluded tray (PE-4)',
    excludedCount === 61 /* the sample's m14 was already out */ && t2.segs.length === t1.segs.length - 60 && (await state()).media.length === 172, `${excludedCount} excluded; now ${fmt(t2.duration)}`);

  // Drag one picture's right edge to make it 5 s.
  const longOne = t2.segs.find((s) => s.chapterId === 'ch-sintra' && s.id.startsWith('g'))!;
  const b = await clipBox(longOne.id);
  const pps = b.width / 2.5;
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + pps * 1.25, b.y + b.height / 2, { steps: 6 });
  await page.mouse.move(b.x + b.width + pps * 2.5, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  await saved(page);
  const lengthened = (await tl()).segs.find((s) => s.id === longOne.id)!;
  check('dragging a clip\'s right edge changes how long it shows (PE-5)', Math.abs(lengthened.duration - 5) <= 0.3, `${lengthened.duration} s`);

  // Reorder within Lisbon: drag the 4th clip before the 1st.
  const lis = (await tl()).segs.filter((s) => s.chapterId === 'ch-lisbon');
  const from = await clipBox(lis[3].id);
  const to = await clipBox(lis[0].id);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 - 20, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + 3, to.y + to.height / 2, { steps: 8 });
  await shot('02-drag-reorder');
  await page.mouse.up();
  await saved(page);
  const lis2 = (await tl()).segs.filter((s) => s.chapterId === 'ch-lisbon');
  check('dragging a clip reorders it within its chapter (PE-3)', lis2[0].id === lis[3].id && lis2[1].id === lis[0].id, lis2.slice(0, 4).map((s) => s.id).join(' '));

  // Across chapters: zoom out, then drag a late Lisbon clip into Sintra, keeping its time.
  await page.click('#pe-zoom-out');
  await page.click('#pe-zoom-out');
  await page.click('#pe-zoom-out');
  const mover = lis2[lis2.length - 3].id;
  const sintraFirst = (await tl()).segs.find((s) => s.chapterId === 'ch-sintra')!;
  const sb = await clipBox(sintraFirst.id);
  const mb = await clipBox(mover);
  check('zoomed out, the end of Lisbon and the start of Sintra are both in view', sb.x > 0 && mb.x > 0 && (await clipBox(sintraFirst.id)).x === sb.x);
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.mouse.down();
  await page.mouse.move(mb.x + mb.width / 2 + 30, mb.y + mb.height / 2, { steps: 4 });
  await page.mouse.move(sb.x + sb.width * 0.75, sb.y + sb.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForSelector('#pe-move-dialog[open]');
  await page.locator('#pe-move-dialog').screenshot({ path: path.join(outDir, '03-move-across-chapters.png') });
  const question = await page.textContent('#pe-move-dialog h3');
  await page.click('#pe-move-dialog [data-answer="keep"]');
  await page.waitForFunction((id) => window.tripalogue!.session!.state.media.find((m) => m.id === id)!.chapterId === 'ch-sintra', mover, { timeout: 5000 }).catch(() => {});
  await saved(page);
  const moved = (await state()).media.find((m) => m.id === mover)!;
  const sin = (await tl()).segs.filter((s) => s.chapterId === 'ch-sintra');
  check('moving a clip into another chapter asks whether to change its time; "Keep the time" holds it there (PE-3)',
    /Move .* to Sintra/.test(question ?? '') && moved.chapterId === 'ch-sintra' && moved.chapterLocked === true && !moved.userTimestamp && sin[1].id === mover,
    `${question}; chapter ${moved.chapterId}, held ${moved.chapterLocked}, time ${moved.userTimestamp ?? 'unchanged'}, Sintra starts ${sin.slice(0, 3).map((x) => x.id).join(' ')}`);

  // Restore one excluded clip from the tray.
  await page.click('#pe-excluded summary');
  await page.click(`#pe-excluded [data-restore="${run1[0]}"]`);
  await saved(page);
  const t3 = await tl();
  check('an excluded clip is restored from the Excluded tray, back in its place (PE-4)', t3.segs.some((s) => s.id === run1[0]) && Number((await page.textContent('#pe-excluded summary .count'))?.trim()) === 60);
  check('the 12-minute draft is cut to about 5 minutes', Math.abs(t3.duration - 300) <= 30, `${fmt(t0.duration)} → ${fmt(t3.duration)} (target 5:00)`);
  await shot('04-cut-to-five-minutes');

  // ---- Task 2: reposition three portrait photos on the stage ----
  const portraits = (await tl()).segs.filter((s) => s.id.startsWith('g') && Number(s.id.slice(1)) % 5 === 2).slice(0, 3).map((s) => s.id);
  const targets = [1 / 3, 2 / 3, 0.5];
  const movedCentres: number[] = [];
  for (let k = 0; k < portraits.length; k++) {
    const id = portraits[k];
    await clip(id).click();
    await page.selectOption('#pe-placement', 'custom');
    await saved(page);
    await page.waitForSelector('#stage-box:not([hidden])');
    await page.locator('#stage-wrap').scrollIntoViewIfNeeded();
    const canvas = (await page.locator('#stage').boundingBox())!;
    await page.waitForTimeout(150);
    let bx = (await page.locator('#stage-box').boundingBox())!;
    // Move it so its centre sits near a third (it snaps), then shrink it from the bottom-right corner.
    const want = canvas.x + canvas.width * targets[k];
    await page.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2);
    await page.mouse.down();
    await page.mouse.move(bx.x + bx.width / 2 + 10, bx.y + bx.height / 2, { steps: 3 });
    await page.mouse.move(want + 5, bx.y + bx.height / 2 + 4, { steps: 8 });
    await page.mouse.up();
    await saved(page);
    const r = (await state()).cues.find((c) => c.itemId === id)!.placement.rect!;
    movedCentres.push(r.x + r.w / 2);
    bx = (await page.locator('#stage-box').boundingBox())!;
    await page.mouse.move(bx.x + bx.width - 5, bx.y + bx.height - 5);
    await page.mouse.down();
    await page.mouse.move(bx.x + bx.width - 65, bx.y + bx.height - 65, { steps: 5 });
    await page.mouse.up();
    await saved(page);
  }
  await page.locator('#stage-wrap').screenshot({ path: path.join(outDir, '05-stage-placement.png') });
  const placed = (await state()).cues.filter((c) => portraits.includes(c.itemId));
  check('three portrait photos are moved on the stage, their centres snapping to a third or the centre (PE-6)',
    placed.length === 3 && placed.every((c) => c.placement.mode === 'custom') && movedCentres.every((x, k) => Math.abs(x - targets[k]) < 0.002),
    movedCentres.map((x) => x.toFixed(3)).join(', '));
  // A portrait photo (3:4) in a 16:9 frame: width/height as fractions of the frame = (3/4) × (9/16).
  const shape = (3 / 4) * (9 / 16);
  check('…and resized from a corner, keeping the photo\'s portrait shape', placed.every((c) => { const r = c.placement.rect!; return r.h < 0.95 && Math.abs(r.w / r.h - shape) < 0.01; }),
    placed.map((c) => `${c.placement.rect!.w.toFixed(3)}×${c.placement.rect!.h.toFixed(3)}`).join(', '));

  // ---- Task 3: music under one chapter, a memo on a picture ----
  for (let i = 0; i < 3; i++) await page.click('#pe-zoom-in');
  const lane = async (kind: string) => (await page.locator(`#pe-lane-${kind}`).boundingBox())!;
  const tl3 = await tl();
  const porto = tl3.chapters.find((c) => c.id === 'ch-porto')!;
  const portoFirst = tl3.segs.find((s) => s.chapterId === 'ch-porto')!;
  await clip(portoFirst.id).scrollIntoViewIfNeeded();
  let pf = await clipBox(portoFirst.id);
  const ppsNow = pf.width / portoFirst.duration;
  const xFor = (t: number) => pf.x + (t - portoFirst.start) * ppsNow;
  const dragChip = async (id: string, toX: number, laneKind: string) => {
    await page.locator(`[data-audio="${id}"]`).scrollIntoViewIfNeeded();
    const chip = (await page.locator(`[data-audio="${id}"]`).boundingBox())!;
    const l = await lane(laneKind);
    await page.mouse.move(chip.x + 10, chip.y + chip.height / 2);
    await page.mouse.down();
    await page.mouse.move(chip.x + 40, chip.y - 20, { steps: 4 });
    await page.mouse.move(toX, l.y + l.height / 2, { steps: 12 });
    await page.mouse.up();
    await saved(page);
  };
  await dragChip(songId, xFor(porto.start + 0.3), 'music');
  const songCue = (await state()).cues.find((c) => c.itemId === songId)!;
  const songClip = (await tl()).audio.find((c) => c.id === songId)!;
  const tlEnd = tl3.chapters[tl3.chapters.length - 1].end;
  check('a song dragged onto the Music lane plays from its time in the chapter on into the next chapters, to the travelogue\'s end (AU-1, AU-2)',
    songCue.audio?.laneId === 'lane-music' && songCue.audio.anchor.type === 'chapterTime' && songCue.audio.spanChapters === true && songClip.chapterId === 'ch-porto'
      && Math.abs(songClip.start - porto.start) < 1 && Math.abs(songClip.start + songClip.duration - tlEnd) < 0.01,
    `${fmt(songClip.start)}–${fmt(songClip.start + songClip.duration)} (Porto ${fmt(porto.start)}–${fmt(porto.end)}, the travelogue ends ${fmt(tlEnd)})`);

  // Trim it by dragging its edges, then keep it inside Porto with the checkbox; Undo puts it all back.
  const songEl = page.locator(`#pe-lane-music .pe-clip.audio[data-item="${songId}"]`);
  await songEl.scrollIntoViewIfNeeded();
  const dragEdge = async (side: 'left' | 'right', dSec: number) => {
    const handle = songEl.locator(`[data-edge="${side}"]`);
    await handle.scrollIntoViewIfNeeded();
    const b = (await handle.boundingBox())!;
    const x0 = b.x + b.width / 2, y0 = b.y + b.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + dSec * ppsNow, y0, { steps: 10 });
    await page.mouse.up();
    await saved(page);
    await page.waitForTimeout(150); // the player's timeline follows the project within 40 ms
  };
  await dragEdge('right', -10);
  const endTrim = (await tl()).audio.find((c) => c.id === songId)!;
  await dragEdge('left', 2);
  const startTrim = (await tl()).audio.find((c) => c.id === songId)!;
  const startCue = (await state()).cues.find((c) => c.itemId === songId)!;
  await shot('06b-music-across-chapters');
  check('drag a music clip\'s edges to trim its end and its start; trimming the start keeps the rest where it was',
    Math.abs(endTrim.start + endTrim.duration - (tlEnd - 10)) < 0.3 && Math.abs(startTrim.start - (songClip.start + 2)) < 0.3
      && Math.abs(startTrim.start + startTrim.duration - (endTrim.start + endTrim.duration)) < 0.05 && Math.abs((startCue.inPointSec ?? 0) - 2) < 0.3,
    `ends ${fmt(endTrim.start + endTrim.duration)} after trimming 10 s; then starts ${(startTrim.start - songClip.start).toFixed(2)} s later at ${(startCue.inPointSec ?? 0).toFixed(2)} s into the file`);
  await page.click('#pe-span');
  await saved(page);
  await page.waitForTimeout(150);
  const inside = (await tl()).audio.find((c) => c.id === songId)!;
  check('"Play on into the next chapters" off: the song stops at the end of its chapter again',
    Math.abs(inside.start + inside.duration - porto.end) < 0.01, `${fmt(inside.start)}–${fmt(inside.start + inside.duration)}`);
  for (let i = 0; i < 3; i++) await page.click('#undo');
  await saved(page);
  await page.waitForTimeout(150);
  const restored = (await tl()).audio.find((c) => c.id === songId)!;
  check('Undo puts the song back as dropped', Math.abs(restored.start - songClip.start) < 0.01 && Math.abs(restored.duration - songClip.duration) < 0.01,
    `${fmt(restored.start)}–${fmt(restored.start + restored.duration)}`);
  // Back to the start of Porto for the memo (the edge drags scrolled the timeline).
  await clip(portoFirst.id).scrollIntoViewIfNeeded();
  pf = await clipBox(portoFirst.id);

  const host = (await tl()).segs.filter((s) => s.chapterId === 'ch-porto')[4];
  await dragChip(memoId, xFor(host.start + 0.5), 'narration');
  const memoCue = (await state()).cues.find((c) => c.itemId === memoId)!;
  check('a voice memo dropped on the Narration lane is anchored to the picture it starts on (AU-2)',
    memoCue.audio?.anchor.type === 'item' && (memoCue.audio.anchor as { itemId: string }).itemId === host.id, JSON.stringify(memoCue.audio?.anchor));
  await shot('06-audio-lanes');

  // Reorder the anchor picture and trim the one before it: the memo stays on its picture within a frame.
  const off = (memoCue.audio!.anchor as { offsetSec: number }).offsetSec;
  const portoSegs = (await tl()).segs.filter((s) => s.chapterId === 'ch-porto');
  const hb = await clipBox(host.id);
  const tb = await clipBox(portoSegs[1].id);
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - 30, hb.y + hb.height / 2, { steps: 4 });
  await page.mouse.move(tb.x + 2, tb.y + tb.height / 2, { steps: 8 });
  await page.mouse.up();
  await saved(page);
  await clip(portoSegs[0].id).click();
  await page.fill('#pe-duration', '4');
  await page.locator('#pe-duration').dispatchEvent('change');
  await saved(page);
  const t4 = await tl();
  const hostNow = t4.segs.find((s) => s.id === host.id)!;
  const memoNow = t4.audio.find((c) => c.id === memoId)!;
  check('after a reorder and a trim, the memo still starts on its picture, within one frame (acceptance)',
    hostNow.start < host.start - 1 && Math.abs(memoNow.start - (hostNow.start + off)) < 1 / 30, `picture now at ${hostNow.start.toFixed(2)} s, memo at ${memoNow.start.toFixed(2)} s`);

  // The mix: music ducks while the memo plays; muting narration lifts it.
  await page.evaluate((t) => window.tripalogue!.player!.seek(t), memoNow.start + 2);
  await page.waitForTimeout(150);
  const mix = await page.evaluate(() => window.tripalogue!.player!.mix.map((v) => ({ id: v.itemId, gain: v.gain })));
  const g = Object.fromEntries(mix.map((v) => [v.id, v.gain]));
  await page.click('.pe-head[data-lane="lane-narration"] [data-act="mute"]');
  await saved(page);
  await page.evaluate((t) => window.tripalogue!.player!.seek(t), memoNow.start + 2.1);
  await page.waitForTimeout(150);
  const g2 = Object.fromEntries((await page.evaluate(() => window.tripalogue!.player!.mix.map((v) => ({ id: v.itemId, gain: v.gain })))).map((v) => [v.id, v.gain]));
  check('music plays at 70% and ducks 12 dB under narration; muting the narration lane silences it and lifts the music (AU-3, AU-4)',
    Math.abs(g[songId] - 0.7 * 10 ** (-12 / 20)) < 0.01 && Math.abs(g[memoId] - 1) < 0.01 && g2[memoId] === 0 && Math.abs(g2[songId] - 0.7) < 0.01,
    `music ${g[songId]?.toFixed(3)}, memo ${g[memoId]?.toFixed(2)}; muted: music ${g2[songId]?.toFixed(2)}`);
  await page.click('.pe-head[data-lane="lane-narration"] [data-act="mute"]');
  await saved(page);
  const waves = await page.locator('#pe-lane-music .pe-clip.audio').evaluate((e) => getComputedStyle(e).backgroundImage);
  check('audio clips show their waveforms on the lanes (AU-4)', /thumb/.test(waves), waves.slice(0, 60));

  // Real playback: the song element plays and keeps to the clock.
  await page.evaluate((t) => { const p = window.tripalogue!.player!; p.setMuted(true); p.seek(t); p.play(); }, songClip.start + 5);
  await page.waitForTimeout(2500);
  const drift = await page.evaluate((id) => {
    const p = window.tripalogue!.player!;
    const v = p.mix.find((x) => x.itemId === id)!;
    const el = p.elementFor(id) as HTMLAudioElement | undefined;
    return { playing: !!el && !el.paused, drift: el && v ? Math.abs(el.currentTime - v.mediaTimeSec) : 99 };
  }, songId);
  await page.evaluate(() => window.tripalogue!.player!.pause());
  check('in playback the song plays alongside the pictures, kept to the timeline clock', drift.playing && drift.drift < 0.25, `drift ${drift.drift.toFixed(3)} s`);

  // A busy browser (long frames every half second) must not make the player re-seek the song: re-seeks are
  // heard as gaps and seen as jumps. The playhead follows the song's own clock instead.
  await page.evaluate((t) => { const p = window.tripalogue!.player!; p.seek(t); p.play(); }, songClip.start + 10);
  await page.waitForTimeout(800);
  // Passed as a string: tsx's helpers for named functions do not exist in the page.
  const jank = await page.evaluate(`(async () => {
    const p = window.tripalogue.player;
    const id = ${JSON.stringify(songId)};
    const el = p.elementFor(id);
    let seeks = 0;
    const count = () => { seeks += 1; };
    el.addEventListener('seeking', count);
    const t0 = p.time;
    const w0 = performance.now();
    const iv = setInterval(() => { const end = performance.now() + 180; while (performance.now() < end) {} }, 500);
    await new Promise((r) => setTimeout(r, 6000));
    clearInterval(iv);
    await new Promise((r) => setTimeout(r, 300));
    el.removeEventListener('seeking', count);
    const v = p.mix.find((x) => x.itemId === id);
    return { seeks, advanced: p.time - t0, wall: (performance.now() - w0) / 1000, drift: Math.abs(el.currentTime - v.mediaTimeSec), playing: !el.paused };
  })()`) as { seeks: number; advanced: number; wall: number; drift: number; playing: boolean };
  await page.evaluate(() => window.tripalogue!.player!.pause());
  check('with a busy browser the song plays on without re-seeks, and the playhead keeps real time',
    jank.playing && jank.seeks === 0 && jank.drift < 0.1 && Math.abs(jank.advanced - jank.wall) < 0.4,
    `${jank.seeks} re-seeks; playhead ${jank.advanced.toFixed(2)} s in ${jank.wall.toFixed(2)} s; drift ${jank.drift.toFixed(3)} s`);

  // Safari's rule, recreated in Chromium: a media element may play with sound only once it has been played
  // inside a click or key handler (not in a later frame). A video that starts under the song must not silence the song.
  await page.evaluate(`(() => {
    let inGesture = false;
    for (const type of ['click', 'keydown']) window.addEventListener(type, () => { inGesture = true; setTimeout(() => { inGesture = false; }, 0); }, true);
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!this.__unlocked) {
        if (inGesture) this.__unlocked = true;
        else if (!this.muted) return Promise.reject(new DOMException('Needs a user gesture', 'NotAllowedError'));
      }
      return play.call(this);
    };
    window.__blocked = 0;
  })()`);
  const vid = await page.evaluate(`(() => {
    const p = window.tripalogue.player;
    const song = p.timeline.audio.find((c) => c.item.id === ${JSON.stringify(songId)});
    const v = p.timeline.segments.find((s) => s.kind === 'video' && s.start > song.start + 2 && s.start + 2 < song.start + song.duration);
    return v ? { id: v.item.id, start: v.start } : null;
  })()`) as { id: string; start: number } | null;
  let gesture = { songPlaying: false, songMuted: true, videoPlaying: false, videoMuted: true, note: true };
  if (vid) {
    await page.evaluate((t) => { const p = window.tripalogue!.player!; p.setMuted(false); p.seek(t); }, vid.start - 1.2);
    await page.click('#play');
    await page.waitForTimeout(2500);
    gesture = await page.evaluate(`(() => {
      const p = window.tripalogue.player;
      const song = p.elementFor(${JSON.stringify(songId)});
      const video = p.elementFor(${JSON.stringify(vid.id)});
      return { songPlaying: !song.paused, songMuted: song.muted, videoPlaying: !!video && !video.paused, videoMuted: !video || video.muted,
        note: document.getElementById('sound-note')?.hidden === false };
    })()`) as typeof gesture;
    await page.click('#play');
  }
  check('when Play is clicked, a video that starts later under the song plays with sound, and the song keeps playing (Safari\'s autoplay rule)',
    !!vid && gesture.songPlaying && !gesture.songMuted && gesture.videoPlaying && !gesture.videoMuted && !gesture.note,
    vid ? JSON.stringify(gesture) : 'no video under the song');

  // ---- play this chapter, reset a chapter ----
  await page.click('#pe-timeline .pe-chapter[data-chapter="ch-sintra"]');
  const sintra = (await tl()).chapters.find((c) => c.id === 'ch-sintra')!;
  await page.evaluate(() => window.tripalogue!.player!.setRate(8));
  await page.click('#pe-play-this-chapter');
  await page.waitForFunction(() => window.tripalogue!.player!.state === 'paused', null, { timeout: 30_000 });
  const stoppedAt = await page.evaluate(() => window.tripalogue!.player!.time);
  await page.evaluate(() => window.tripalogue!.player!.setRate(1));
  check('"Play this chapter" plays the chapter and stops at its end (PE-2)', Math.abs(stoppedAt - sintra.end) < 0.6, `stopped at ${stoppedAt.toFixed(2)} s; Sintra ends at ${sintra.end.toFixed(2)} s`);
  await page.click('#pe-reset-chapter');
  await saved(page);
  const sintraSegs = (await tl()).segs.filter((s) => s.chapterId === 'ch-sintra');
  check('"Reset chapter to defaults" puts its pictures back to the cue profile (PE-7)', sintraSegs.filter((s) => !s.id.startsWith('m')).every((s) => Math.abs(s.duration - 4) < 0.01), `${sintraSegs.length} items back to 4 s`);
  await page.keyboard.press('Control+z');
  await saved(page);

  // ---- an edit shows in the preview in under 200 ms ----
  const victim = (await tl()).segs.find((s) => s.chapterId === 'ch-douro')!.id;
  await clip(victim).click();
  // (A string, so the bundler adds no helpers to the code that runs in the page.)
  const latency = await page.evaluate(`new Promise((resolve) => {
    const id = ${JSON.stringify(victim)};
    let t0 = 0;
    addEventListener('keydown', () => { t0 = performance.now(); }, { capture: true, once: true });
    const tick = () => {
      const gone = !window.tripalogue.player.timeline.segments.some((s) => s.kind !== 'title' && s.item.id === id) && !document.querySelector('#pe-visual [data-item="' + id + '"]');
      if (t0 && gone) resolve(performance.now() - t0);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.querySelector('#pe-visual [data-item="' + id + '"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  })`) as number;
  check('an edit shows in the preview in under 200 ms (acceptance)', latency < 200, `${latency.toFixed(0)} ms from Delete to the player and timeline`);
  await saved(page);
  await page.keyboard.press('Control+z');
  await saved(page);

  // ---- everything survives a reload ----
  const before = await state();
  await page.reload();
  await page.waitForSelector('#pe-visual .pe-clip[data-item]');
  const after = await state();
  const same = (id: string) => JSON.stringify(before.cues.find((c) => c.itemId === id)) === JSON.stringify(after.cues.find((c) => c.itemId === id));
  check('the cut, placements and audio survive a reload', after.targetSec === 300 && [songId, memoId, ...portraits, mover].every(same)
    && after.media.find((m) => m.id === mover)!.chapterLocked === true && (await tl()).duration === (await page.evaluate(() => window.tripalogue!.player!.duration)));

  // ---- a 300-item travelogue plays without stalls ----
  const bigPid = await importProject(bigFile, bigItems.map((m) => path.join(gen, m.uri)), 300);
  await page.goto(`${app.url}#/p/${bigPid}/mix`);
  await page.waitForSelector('#pe-visual .pe-clip[data-item]');
  const renderMs = await page.evaluate(() => {
    const t0 = performance.now();
    window.tripalogue!.editor!.setActive(true);
    return performance.now() - t0;
  });
  const bigTl = await tl();
  await page.evaluate(() => { const p = window.tripalogue!.player!; p.setMuted(true); p.setRate(4); p.seek(0); p.play(); });
  const t5 = Date.now();
  await page.waitForFunction(() => document.body.dataset.state === 'ended', null, { timeout: (bigTl.duration / 4 + 90) * 1000, polling: 250 });
  const stats = await page.evaluate(() => ({ ...window.tripalogue!.player!.stats }));
  const share = stats.placeholderFrames / Math.max(1, stats.framesDrawn);
  check('a 300-item travelogue plays without stalls (acceptance)', bigTl.segs.length === 300 && share < 0.02 && stats.mediaErrors.length === 0,
    `${bigTl.segs.length} items, ${fmt(bigTl.duration)} at 4x in ${((Date.now() - t5) / 1000).toFixed(0)} s; ${stats.placeholderFrames} of ${stats.framesDrawn} frames waited (${(share * 100).toFixed(2)}%); timeline drawn in ${renderMs.toFixed(0)} ms`);
  await shot('07-300-items');

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
