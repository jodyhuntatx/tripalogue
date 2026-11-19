/**
 * The export page converts its frames to YUV 4:2:0 itself; it must match what ffmpeg made of the same RGBA.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toYuv420 } from '../src/web/yuv.js';

const run = promisify(execFile);

/** ffmpeg's conversion, as the Phase 5 renderer used it before the page converted frames itself. */
async function ffmpegYuv(rgba: Uint8ClampedArray, w: number, h: number): Promise<Buffer> {
  const p = run('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', '-',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  p.child.stdin!.end(Buffer.from(rgba.buffer));
  return (await p).stdout;
}

function picture(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Gradients, primaries and greys, so every channel and range end is covered.
      const band = Math.floor((x / w) * 8);
      const v = Math.round((y / (h - 1)) * 255);
      const prim = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 255, 255], [0, 0, 0]][band];
      d[i] = y < h / 2 ? prim[0] : v;
      d[i + 1] = y < h / 2 ? prim[1] : (x * 7) % 256;
      d[i + 2] = y < h / 2 ? prim[2] : 255 - v;
      d[i + 3] = 255;
    }
  }
  return d;
}

describe('YUV 4:2:0 conversion for the export (VX-7)', () => {
  it('matches ffmpeg\'s BT.709 limited-range conversion within one level', async () => {
    const w = 320, h = 180;
    const rgba = picture(w, h);
    const ours = new Uint8Array(w * h * 1.5);
    toYuv420(rgba, w, h, ours);
    const ref = await ffmpegYuv(rgba, w, h);
    assert.equal(ref.length, ours.length);
    let worstY = 0, worstC = 0, sumC = 0;
    for (let i = 0; i < ours.length; i++) {
      const d = Math.abs(ours[i] - ref[i]);
      if (i < w * h) worstY = Math.max(worstY, d);
      else { worstC = Math.max(worstC, d); sumC += d; }
    }
    assert.ok(worstY <= 1, `luma differs by up to ${worstY}`);
    // ffmpeg's chroma downsampling filters a little differently from a plain 2×2 average at hard edges.
    assert.ok(sumC / (w * h * 0.5) < 1, `chroma differs by ${(sumC / (w * h * 0.5)).toFixed(2)} on average (worst ${worstC})`);
  });

  it('maps black and white to 16 and 235, and greys to neutral chroma', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    const out = new Uint8Array(4 * 2 * 1.5);
    toYuv420(rgba, 4, 2, out);
    assert.deepEqual([...out.subarray(0, 8)], [16, 16, 235, 235, 16, 16, 235, 235]);
    assert.deepEqual([...out.subarray(8)], [128, 128, 128, 128]);
  });
});
