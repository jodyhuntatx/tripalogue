import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { detectHeicTools, HeicConverter, isHeif } from '../src/server/heic.js';
import { heifToJpegWithFfmpeg, planHeif, withExif } from '../src/server/heif.js';
import { orientationFilters, orientationFromJpeg, swapsSides } from '../src/server/orientation.js';
import { exifTiff, isBlue, isRed, look, writeHeic } from './helpers/heic.js';

const run = promisify(execFile);
let dir = '';

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-heic-test-'));
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('HEIC detection', () => {
  it('recognises HEIC by content, not by name', async () => {
    const heic = path.join(dir, 'photo.jpg'); // misnamed on purpose
    await writeHeic(heic);
    assert.equal(await isHeif(heic), true);
    const jpg = path.join(dir, 'real.heic');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', jpg.replace('.heic', '.jpg')]);
    await fs.rename(jpg.replace('.heic', '.jpg'), jpg);
    assert.equal(await isHeif(jpg), false);
  });

  it('leaves AVIF alone (browsers and ffmpeg read it)', async () => {
    const avif = path.join(dir, 'x.avif');
    const ftyp = Buffer.alloc(32);
    ftyp.writeUInt32BE(32, 0);
    ftyp.write('ftypavif', 4, 'latin1');
    ftyp.write('mif1avifmiaf', 16, 'latin1');
    await fs.writeFile(avif, ftyp);
    assert.equal(await isHeif(avif), false);
  });
});

describe('built-in HEIC reader (ffmpeg)', () => {
  it('converts a rotated photo: upright pixels, capture time kept, orientation tag reset', async () => {
    const src = path.join(dir, 'rot.heic');
    await writeHeic(src, { width: 320, height: 240, rotateCcw: 90, capturedAt: '2026:05:03 14:22:10', exifOrientation: 6 });
    const plan = planHeif(await fs.readFile(src));
    assert.deepEqual([plan.width, plan.height], [240, 320]);
    const out = path.join(dir, 'rot.jpg');
    await heifToJpegWithFfmpeg(src, out);
    const tl = await look(out, 5, 5);
    const bl = await look(out, 5, 314);
    assert.deepEqual([tl.w, tl.h], [240, 320], 'portrait after a quarter turn');
    assert.ok(isRed(bl.rgb) && isBlue(tl.rgb), 'the red top-left block turns to the bottom-left');
    const jpeg = await fs.readFile(out);
    assert.equal(orientationFromJpeg(jpeg), 1, 'rotation is in the pixels, so the tag says upright');
    assert.ok(jpeg.includes('2026:05:03 14:22:10'), 'capture time copied from the HEIC');
  });

  it('reassembles an iPhone-style tile grid, crops the padding and turns it', async () => {
    const src = path.join(dir, 'grid.heic');
    await writeHeic(src, { width: 300, height: 200, tile: 128, rotateCcw: 270 });
    const plan = planHeif(await fs.readFile(src));
    assert.equal(plan.tiles, 6);
    const out = path.join(dir, 'grid.jpg');
    await heifToJpegWithFfmpeg(src, out);
    const tr = await look(out, 195, 5);
    const br = await look(out, 195, 295);
    assert.deepEqual([tr.w, tr.h], [200, 300]);
    assert.ok(isRed(tr.rgb), 'a quarter turn clockwise puts the red block top-right');
    assert.ok(isBlue(br.rgb), 'no padding from the 384 × 256 tile grid shows');
  });

  it('refuses layouts it does not cover, with a message that says so', () => {
    const fake = Buffer.alloc(0);
    assert.throws(() => planHeif(fake), /HEIF/);
  });
});

describe('choosing a converter', () => {
  it('finds the built-in converter by converting a sample, and skips tools that only claim HEIC support', async () => {
    const tools = await detectHeicTools({ setting: 'auto' });
    assert.equal(tools[0], 'ffmpeg');
    for (const t of tools) assert.ok(['ffmpeg', 'heif-dec', 'heif-convert', 'sips', 'magick', 'convert'].includes(t));
  });

  it('can be turned off, and then explains what to install', async () => {
    const c = new HeicConverter({ setting: 'off' });
    const src = path.join(dir, 'off.heic');
    await writeHeic(src);
    await assert.rejects(c.toJpeg(src, path.join(dir, 'off.jpg')), /Install libheif/);
  });

  it('rejects an unknown converter name', async () => {
    await assert.rejects(detectHeicTools({ setting: 'photoshop' }), /unknown converter/);
  });
});

describe('JPEG orientation', () => {
  it('reads the EXIF orientation tag (big- and little-endian) and maps it to ffmpeg filters', async () => {
    const jpg = path.join(dir, 'plain.jpg');
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x16', '-frames:v', '1', jpg]);
    const plain = await fs.readFile(jpg);
    assert.equal(orientationFromJpeg(plain), 1);
    assert.equal(orientationFromJpeg(withExif(plain, exifTiff('2026:01:01 00:00:00', 6))), 6);
    // Same tag written little-endian, as many cameras do.
    const leTiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(orientationFromJpeg(withExif(plain, leTiff)), 8);
    assert.deepEqual(orientationFilters(6), ['transpose=clock']);
    assert.deepEqual(orientationFilters(1), []);
    assert.equal(swapsSides(6), true);
    assert.equal(swapsSides(3), false);
  });
});

describe('media tool check', () => {
  it('passes with a full ffmpeg and explains what is missing otherwise', async () => {
    const { checkMediaTools } = await import('../src/server/toolcheck.js');
    const ok = await checkMediaTools();
    assert.equal(ok.ok, true, ok.problems.join('; '));
    assert.ok(ok.ffmpeg);
    const bad = await checkMediaTools('/nope/ffmpeg', '/nope/ffprobe');
    assert.equal(bad.ok, false);
    assert.equal(bad.problems.length, 2);
    assert.match(bad.problems[0], /ffprobe was not found/);
    assert.match(bad.problems[1], /ffmpeg was not found .* README/);
  });
});
