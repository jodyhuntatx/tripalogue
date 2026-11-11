/**
 * HEIC/HEIF photos: make a full-resolution JPEG for each, keeping the original.
 *
 * iPhones and many Android phones save photos as HEIC, which most browsers
 * cannot display and most ffmpeg builds cannot read. The original stays
 * unaltered in storage (F-7); processing adds a full-resolution JPEG with the
 * photo's crop, rotation and mirroring applied and its Exif metadata (capture
 * time, GPS) kept, and builds the thumbnail and proxy from that JPEG.
 *
 * Converters, tried in this order (TRIPALOGUE_HEIC_CONVERTER picks one, or "off"):
 *   ffmpeg                    built in (heif.ts): reads the HEIC and decodes its HEVC tiles with ffmpeg
 *   heif-dec / heif-convert   libheif's command-line tools, for layouts the built-in reader does not cover
 *   sips                      built into macOS
 *   magick / convert          ImageMagick built with HEIC support
 * A converter is used only if it converts a small sample HEIC correctly at startup.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { heifToJpegWithFfmpeg } from './heif.js';

const run = promisify(execFile);

export type HeicTool = 'ffmpeg' | 'heif-dec' | 'heif-convert' | 'sips' | 'magick' | 'convert';
export const HEIC_TOOLS: HeicTool[] = ['ffmpeg', 'heif-dec', 'heif-convert', 'sips', 'magick', 'convert'];

/** JPEG quality for the converted full-resolution image. */
export const HEIC_JPEG_QUALITY = 92;

// Brands of HEIC/HEIF still images. AVIF is left out: browsers and ffmpeg already read it.
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'mif2']);

/** True when the file is a HEIC/HEIF image, judged by its content (the ftyp box), not its name. */
export async function isHeif(file: string): Promise<boolean> {
  const fh = await fs.open(file, 'r');
  try {
    const b = Buffer.alloc(64);
    const { bytesRead } = await fh.read(b, 0, 64, 0);
    if (bytesRead < 16 || b.toString('latin1', 4, 8) !== 'ftyp') return false;
    const size = Math.min(b.readUInt32BE(0), bytesRead);
    const brands = [b.toString('latin1', 8, 12)];
    for (let o = 16; o + 4 <= size; o += 4) brands.push(b.toString('latin1', o, o + 4));
    if (brands.some((x) => x === 'avif' || x === 'avis')) return false;
    return brands.some((x) => HEIF_BRANDS.has(x));
  } finally {
    await fh.close();
  }
}

export const NO_HEIC_TOOL_MESSAGE =
  'This HEIC photo could not be converted. Install libheif (heif-dec) or ImageMagick with HEIC support on the server (on macOS, sips is built in), then retry.';

/** Convert one HEIC/HEIF file to a full-resolution JPEG with the given tool. */
export async function heicToJpeg(tool: HeicTool, src: string, dst: string, o: { ffmpeg?: string; quality?: number } = {}): Promise<void> {
  const quality = o.quality ?? HEIC_JPEG_QUALITY;
  const opts = { timeout: 180_000, maxBuffer: 8 << 20 };
  await fs.rm(dst, { force: true });
  switch (tool) {
    case 'ffmpeg':
      await heifToJpegWithFfmpeg(src, dst, o.ffmpeg ?? 'ffmpeg', quality);
      break;
    case 'heif-dec':
    case 'heif-convert':
      await run(tool, ['-q', String(quality), src, dst], opts);
      break;
    case 'sips':
      await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), src, '--out', dst], opts);
      break;
    case 'magick':
    case 'convert':
      // [0]: the primary image only. libheif has already applied the rotation, so the orientation tag is set to normal.
      await run(tool, [`${src}[0]`, '-orient', 'top-left', '-quality', String(quality), `jpeg:${dst}`], opts);
      break;
  }
  await fs.access(dst);
}

// A 550-byte HEIC: a 2 × 1 grid of 32 × 32 HEVC tiles, rotated a quarter turn anticlockwise, so it shows as 32 × 64.
// A converter passes only if it reassembles the grid and applies the rotation.
const SAMPLE_HEIC = Buffer.from('AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAABxm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAADnBpdG0AAAAAAAEAAABNaWluZgAAAAAAAwAAABVpbmZlAgAAAAABAABncmlkAAAAABVpbmZlAgAAAAACAABodmMxAAAAABVpbmZlAgAAAAADAABodmMxAAAAABxpcmVmAAAAAAAAABBkaW1nAAEAAgACAAMAAADSaXBycAAAAKtpcGNvAAAAcmh2Y0MBBAgAAACfqAAAAAAe8AD8/fj4AAAPA6AAAQAXQAEMAf//BAgAAAMAn6gAAAMAAB66AkChAAEAJ0IBAQQIAAADAJ+oAAADAAAeoEIIWW6uTK8BaAgAAAMACAAAAwGQQKIAAQAGRAHBc8CJAAAAFGlzcGUAAAAAAAAAIAAAACAAAAAUaXNwZQAAAAAAAABAAAAAIAAAAAlpcm90AQAAAB9pcG1hAAAAAAAAAAMAAQIDhAACAoECAAMCgQIAAAAQaWRhdAAAAAEAQAAgAAAAQGlsb2MBAAAARAAAAwABAAEAAAABAAAAAAAAAAgAAgAAAAAAAQAAAeYAAAArAAMAAAAAAAEAAAIRAAAAFQAAAEhtZGF0AAAAJygBr3jlBof+sO/2HYb4Erff2ibHLzf7wGfC4/JJf2gh+wW9dRCNuAAAABEoAa949wQD/+wCNB6TLH73TA==', 'base64');

async function jpegSize(file: string, ffprobe: string): Promise<{ w: number; h: number } | undefined> {
  try {
    const { stdout } = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { timeout: 10_000 });
    const [w, h] = stdout.trim().split(',').map(Number);
    return w && h ? { w, h } : undefined;
  } catch {
    return undefined;
  }
}

/** Which converters work on this machine, in order of preference. */
export async function detectHeicTools(o: { setting?: string; ffmpeg?: string; ffprobe?: string } = {}): Promise<HeicTool[]> {
  const setting = (o.setting ?? process.env.TRIPALOGUE_HEIC_CONVERTER ?? 'auto').trim().toLowerCase();
  if (setting === 'off' || setting === 'none') return [];
  let candidates = HEIC_TOOLS;
  if (setting && setting !== 'auto') {
    if (!HEIC_TOOLS.includes(setting as HeicTool)) throw new Error(`TRIPALOGUE_HEIC_CONVERTER: unknown converter "${setting}" (use auto, off, or one of ${HEIC_TOOLS.join(', ')})`);
    candidates = [setting as HeicTool];
  }
  if (process.platform !== 'darwin') candidates = candidates.filter((t) => t !== 'sips');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-heic-check-'));
  try {
    const src = path.join(dir, 'sample.heic');
    await fs.writeFile(src, SAMPLE_HEIC);
    const ok: HeicTool[] = [];
    for (const t of candidates) {
      const dst = path.join(dir, `${t}.jpg`);
      try {
        await heicToJpeg(t, src, dst, { ffmpeg: o.ffmpeg });
        const s = await jpegSize(dst, o.ffprobe ?? 'ffprobe');
        // sips may keep the rotation as an orientation tag rather than in the pixels; both are handled downstream.
        if (s && ((s.w === 32 && s.h === 64) || (t === 'sips' && s.w === 64 && s.h === 32))) ok.push(t);
      } catch {
        /* not installed, or cannot read HEIC */
      }
    }
    return ok;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Converts with the first working tool, falling back to the next when one fails on a particular file. */
export class HeicConverter {
  private tools?: Promise<HeicTool[]>;
  constructor(private readonly o: { setting?: string; ffmpeg?: string; ffprobe?: string; log?: (m: string) => void } = {}) {}

  available(): Promise<HeicTool[]> {
    this.tools ??= detectHeicTools(this.o).then((t) => {
      this.o.log?.(t.length ? `HEIC photos: converting with ${t.join(', then ')}` : 'HEIC photos: no working converter found; HEIC uploads will fail until one is installed');
      return t;
    }, (e: Error) => {
      this.o.log?.(`HEIC photos: ${e.message}`);
      return [];
    });
    return this.tools;
  }

  /** Returns the tool that did the conversion. */
  async toJpeg(src: string, dst: string): Promise<HeicTool> {
    const tools = await this.available();
    const errors: string[] = [];
    for (const t of tools) {
      try {
        await heicToJpeg(t, src, dst, { ffmpeg: this.o.ffmpeg });
        return t;
      } catch (e) {
        errors.push(`${t}: ${((e as Error).message ?? String(e)).split('\n')[0]}`);
      }
    }
    throw new Error(errors.length ? `${NO_HEIC_TOOL_MESSAGE} (${errors.join('; ')})` : NO_HEIC_TOOL_MESSAGE);
  }
}
