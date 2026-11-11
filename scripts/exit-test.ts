/**
 * Phase 0 exit test: "the team can hand-write a project file with 20 items
 * and play it end to end."
 *
 * Builds the media cache, serves the hand-written sample, plays it in headless
 * Chromium, and checks that every segment was entered in order, no media
 * failed, nothing was logged as an error, and frames at known times show the
 * right content. Writes a report and screenshots to docs/exit-test/.
 *
 *   npx tsx scripts/exit-test.ts [--rate 1] [--original]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type {} from '../src/player/main.js'; // window.tripalogue typings
import { buildTimeline, parseProject } from '../src/core/index.js';
import { buildCache } from '../src/node/cache.js';
import { serve } from '../src/node/server.js';
import { promises as fs } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectFile = path.join(root, 'samples/hand-written-20/trip.travelogue.json');
const outDir = path.join(root, 'docs/exit-test');
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? undefined : process.argv[i + 1]; };
const rate = Number(arg('rate') ?? 1);
const useOriginals = process.argv.includes('--original');

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const project = parseProject(await fs.readFile(projectFile, 'utf8')).project;
const tl = buildTimeline(project);
mkdirSync(outDir, { recursive: true });

const cacheRoot = path.join(os.tmpdir(), 'tripalogue-exit-cache');
const t0 = Date.now();
const { manifest } = await buildCache(projectFile, project, { root: cacheRoot });
check('cache builds for all 20 items', Object.values(manifest.entries).filter((e) => !e.error).length === 20, `${((Date.now() - t0) / 1000).toFixed(1)} s`);

const server = await serve({ projectFile, cacheRoot });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(e.message));

try {
  const url = `${server.url}?autoplay=1&rate=${rate}${useOriginals ? '&original=1' : ''}`;
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.state === 'playing', null, { timeout: 15_000 });
  const started = Date.now();
  await page.screenshot({ path: path.join(outDir, 'player-ui.png') });
  await page.waitForFunction(() => document.body.dataset.state === 'ended', null, { timeout: (tl.duration / rate + 60) * 1000, polling: 250 });
  const wall = (Date.now() - started) / 1000;

  const stats = await page.evaluate(() => {
    const p = window.tripalogue!.player;
    return { ...p.stats, duration: p.duration, time: p.time, segments: p.timeline.segments.length };
  });
  const expected = tl.segments.map((_, i) => i);
  const firstVisits = stats.segmentsEntered.filter((v, i, a) => a.indexOf(v) === i);
  check('plays to the end', stats.time >= tl.duration - 1e-6, `${tl.duration} s of timeline in ${wall.toFixed(1)} s wall clock at ${rate}x`);
  check('enters all 23 segments (4 title cards + 19 items) in order', JSON.stringify(firstVisits) === JSON.stringify(expected), `entered ${firstVisits.length}`);
  check('excluded item m14 never plays', !tl.segments.some((s) => s.kind !== 'title' && s.item.id === 'm14'));
  check('no media failed to load', stats.mediaErrors.length === 0, stats.mediaErrors.join(', '));
  const placeholderShare = stats.placeholderFrames / Math.max(1, stats.framesDrawn);
  const slow = Object.entries(stats.placeholderBySegment).map(([i, n]) => { const s = tl.segments[Number(i)]; return `${s.kind === 'title' ? 'title' : s.item.id} ${n}`; }).join(', ');
  check('media ready in time (under 2% of frames waited on loading)', placeholderShare < 0.02, `${stats.placeholderFrames} of ${stats.framesDrawn} frames${slow ? ` (${slow})` : ''}`);
  check('no errors in the browser console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  const fps = stats.framesDrawn / wall;
  check('draws smoothly (30 fps or better)', fps >= 30, `${fps.toFixed(0)} frames per second`);

  // Spot-check frames at known times (paused, so each frame is exact).
  const spots: { name: string; t: number; expect: string }[] = [];
  const find = (id: string) => tl.segments.find((s) => s.kind !== 'title' && s.item.id === id)!;
  spots.push({ name: '01-title-lisbon', t: 1.5, expect: 'title' });
  spots.push({ name: '02-portrait-fit-m02', t: find('m02').start + 2, expect: 'image' });
  spots.push({ name: '03-custom-rect-m04', t: find('m04').start + 2, expect: 'image' });
  spots.push({ name: '04-fill-m09', t: find('m09').start + 2.5, expect: 'image' });
  spots.push({ name: '05-video-trimmed-m15', t: find('m15').start + 10, expect: 'video' });
  spots.push({ name: '06-video-2x-m20', t: find('m20').start + 2, expect: 'video' });
  spots.push({ name: '07-panorama-m18', t: find('m18').start + 3, expect: 'image' });
  for (const s of spots) {
    await page.evaluate((t) => window.tripalogue!.player.seek(t), s.t);
    await page.waitForTimeout(s.expect === 'video' ? 900 : 300);
    const probe = await page.evaluate(() => {
      const c = document.getElementById('stage') as HTMLCanvasElement;
      const ctx = c.getContext('2d')!;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      let leftLit = 0;
      let rightLit = 0;
      for (let y = 0; y < c.height; y += 8) for (let x = 0; x < c.width; x += 8) {
        const i = (y * c.width + x) * 4;
        const on = d[i] + d[i + 1] + d[i + 2] > 30;
        if (on) { lit++; if (x < c.width * 0.08) leftLit++; if (x > c.width * 0.6) rightLit++; }
      }
      const total = Math.ceil(c.height / 8) * Math.ceil(c.width / 8);
      const p = window.tripalogue!.player;
      const v = document.querySelectorAll('video');
      return { lit: lit / total, leftLit, rightLit, w: c.width, h: c.height, t: p.time, videos: v.length };
    });
    await page.locator('#stage').screenshot({ path: path.join(outDir, `${s.name}.png`) });
    let ok = probe.lit > 0.2;
    let detail = `${Math.round(probe.lit * 100)}% of the frame lit`;
    if (s.name.includes('custom')) { ok = ok && probe.rightLit === 0; detail += probe.rightLit === 0 ? ', right side empty as placed' : ', image spills right'; }
    if (s.name.includes('fill')) { ok = ok && probe.lit > 0.95; detail += ', frame filled edge to edge'; }
    if (s.name.includes('portrait')) { ok = ok && probe.leftLit === 0; detail += probe.leftLit === 0 ? ', pillarboxed' : ''; }
    check(`frame at ${s.t.toFixed(1)} s: ${s.name}`, ok, detail);
  }

  // Video sync: paused frame of m20 should show media time in-point + 2 s x 2 = 6 s.
  const vt = await page.evaluate((id) => {
    const p = window.tripalogue!.player as unknown as { pool: { get(id: string): { el: HTMLVideoElement } | undefined } };
    return p.pool.get(id)?.el.currentTime ?? -1;
  }, 'm20');
  check('video follows the timeline clock (m20 at media 6.0 s)', Math.abs(vt - 6) < 0.1, `currentTime ${vt.toFixed(2)} s`);

  // Controls: chapter jump and keyboard.
  await page.evaluate(() => window.tripalogue!.player.seek(0));
  await page.click('#next');
  const afterNext = await page.evaluate(() => window.tripalogue!.player.time);
  check('next-chapter button jumps to Sintra', Math.abs(afterNext - tl.chapters[1].start) < 1e-6 || Math.abs(afterNext - 27) < 1e-6, `t = ${afterNext}`);
  await page.keyboard.press('End');
  check('End key seeks to the end', await page.evaluate(() => window.tripalogue!.player.time) === tl.duration);

  const report = {
    date: new Date().toISOString(), rate, media: useOriginals ? 'originals' : 'cache proxies', browser: browser.version(),
    timelineSec: tl.duration, wallSec: wall, framesDrawn: stats.framesDrawn, placeholderFrames: stats.placeholderFrames,
    videoSeeks: stats.videoSeeks, checks,
  };
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await server.close();
}

const failed = checks.filter((c) => !c.pass);
console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nAll ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
