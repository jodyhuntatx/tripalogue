/**
 * EXIF orientation of JPEG photos. Phones often save a photo sideways and add
 * a tag saying how to turn it. ffmpeg versions differ on whether they honour
 * that tag (and ffprobe reports the stored size either way), so processing
 * reads the tag here, turns ffmpeg's automatic rotation off, and applies the
 * turn itself: the same result on every ffmpeg.
 */
import { promises as fs } from 'node:fs';

/** The EXIF orientation (1–8) of a JPEG file, or 1 when it has none or is not a JPEG. */
export async function jpegOrientation(file: string): Promise<number> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return orientationFromJpeg(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

export function orientationFromJpeg(b: Buffer): number {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    if (marker === 0xda || marker === 0xd9) break; // image data: no more metadata
    const len = b.readUInt16BE(p + 2);
    if (marker === 0xe1 && b.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      const t = p + 10;
      const le = b.toString('latin1', t, t + 2) === 'II';
      const r16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
      const r32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
      if (t + 8 > b.length) return 1;
      const ifd = t + r32(t + 4);
      if (ifd + 2 > b.length) return 1;
      const n = r16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > b.length) return 1;
        if (r16(e) === 0x0112) {
          const v = r16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    p += 2 + len;
  }
  return 1;
}

/** ffmpeg filters that turn a stored picture upright for an EXIF orientation. */
export function orientationFilters(o: number): string[] {
  switch (o) {
    case 2: return ['hflip'];
    case 3: return ['hflip', 'vflip'];
    case 4: return ['vflip'];
    case 5: return ['transpose=cclock_flip'];
    case 6: return ['transpose=clock'];
    case 7: return ['transpose=clock_flip'];
    case 8: return ['transpose=cclock'];
    default: return [];
  }
}

/** Orientations that swap width and height. */
export const swapsSides = (o: number) => o >= 5 && o <= 8;
