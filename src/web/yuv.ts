/** Frame conversion for the export page (VX-7): the encoder takes YUV 4:2:0. */

/**
 * RGBA (opaque) → planar YUV 4:2:0, BT.709, limited range: the conversion ffmpeg would otherwise make. Fixed point
 * (16-bit fractions); chroma is the average of each 2×2 block.
 */
export function toYuv420(rgba: Uint8ClampedArray, w: number, h: number, out: Uint8Array): void {
  const S = 65536;
  // Y = 16 + 219/255 · (0.2126 R + 0.7152 G + 0.0722 B)
  const yr = Math.round(0.2126 * 219 / 255 * S), yg = Math.round(0.7152 * 219 / 255 * S), yb = Math.round(0.0722 * 219 / 255 * S);
  // Cb = 128 + 224/255 · (−0.1146 R − 0.3854 G + 0.5 B);  Cr = 128 + 224/255 · (0.5 R − 0.4542 G − 0.0458 B)
  const k = 224 / 255;
  const ur = Math.round(-0.114572 * k * S), ug = Math.round(-0.385428 * k * S), ub = Math.round(0.5 * k * S);
  const vr = Math.round(0.5 * k * S), vg = Math.round(-0.454153 * k * S), vb = Math.round(-0.045847 * k * S);
  const half = S >> 1;
  const yOff = 16 * S + half;
  for (let i = 0, j = 0, n = w * h; j < n; i += 4, j++) out[j] = (yr * rgba[i] + yg * rgba[i + 1] + yb * rgba[i + 2] + yOff) >> 16;
  const cw = w >> 1, ch = h >> 1;
  const uBase = w * h, vBase = uBase + cw * ch;
  const cOff = 128 * S * 4 + 2 * S; // ×4 for the sum of four pixels, plus rounding
  for (let y = 0; y < ch; y++) {
    let a = (2 * y) * w * 4, b = a + w * 4, o = y * cw;
    for (let x = 0; x < cw; x++, a += 8, b += 8, o++) {
      const r = rgba[a] + rgba[a + 4] + rgba[b] + rgba[b + 4];
      const g = rgba[a + 1] + rgba[a + 5] + rgba[b + 1] + rgba[b + 5];
      const bl = rgba[a + 2] + rgba[a + 6] + rgba[b + 2] + rgba[b + 6];
      out[uBase + o] = Math.min(255, Math.max(0, (ur * r + ug * g + ub * bl + cOff) >> 18));
      out[vBase + o] = Math.min(255, Math.max(0, (vr * r + vg * g + vb * bl + cOff) >> 18));
    }
  }
}
