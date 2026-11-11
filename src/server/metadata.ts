/**
 * Capture time and place from a media file's own metadata (MM-2, MM-9).
 *
 * Photos: EXIF in a JPEG (APP1) or in a HEIC's Exif item. The capture time is
 * DateTimeOriginal (else CreateDate, else DateTime) with its sub-seconds and,
 * when the camera wrote one, OffsetTimeOriginal: with an offset the time is
 * absolute; without one it is a plain local wall-clock time, which assignment
 * reads in the chapter's time zone. GPS latitude/longitude come from the GPS IFD.
 *
 * Videos and audio: QuickTime/MP4 tags as ffprobe reports them. Apple's
 * com.apple.quicktime.creationdate carries local time and offset and is
 * preferred; creation_time is UTC. Location is ISO 6709 ("+38.7139-009.1394/").
 */
import { promises as fs } from 'node:fs';
import type { LatLng } from '../core/index.js';
import { planHeif } from './heif.js';

export interface CaptureMeta {
  /** ISO-like time: with a UTC offset when known ("2026-05-03T14:22:10+01:00"), else local ("2026-05-03T14:22:10"). */
  capturedAt?: string;
  location?: LatLng;
}

// ---------------------------------------------------------------- EXIF

interface Tiff { b: Buffer; le: boolean }
const r16 = (t: Tiff, o: number) => (t.le ? t.b.readUInt16LE(o) : t.b.readUInt16BE(o));
const r32 = (t: Tiff, o: number) => (t.le ? t.b.readUInt32LE(o) : t.b.readUInt32BE(o));
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** Entries of one IFD: tag → { type, count, offset of the value }. */
function ifd(t: Tiff, at: number): Map<number, { type: number; count: number; at: number }> {
  const out = new Map<number, { type: number; count: number; at: number }>();
  if (at < 8 || at + 2 > t.b.length) return out;
  const n = r16(t, at);
  for (let i = 0; i < n; i++) {
    const e = at + 2 + i * 12;
    if (e + 12 > t.b.length) break;
    const type = r16(t, e + 2);
    const count = r32(t, e + 4);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    out.set(r16(t, e), { type, count, at: size <= 4 ? e + 8 : r32(t, e + 8) });
  }
  return out;
}

function ascii(t: Tiff, e?: { type: number; count: number; at: number }): string | undefined {
  if (!e || e.type !== 2 || e.at + e.count > t.b.length) return undefined;
  return t.b.toString('latin1', e.at, e.at + e.count).replace(/\0[\s\S]*$/, '').trim() || undefined;
}

function rationals(t: Tiff, e?: { type: number; count: number; at: number }): number[] | undefined {
  if (!e || (e.type !== 5 && e.type !== 10) || e.at + 8 * e.count > t.b.length) return undefined;
  const v: number[] = [];
  for (let i = 0; i < e.count; i++) {
    const n = r32(t, e.at + 8 * i), d = r32(t, e.at + 8 * i + 4);
    v.push(d ? n / d : NaN);
  }
  return v;
}

/** Capture time and GPS from a TIFF/EXIF block ("II*\0" or "MM\0*"). */
export function metaFromTiff(b: Buffer): CaptureMeta {
  if (b.length < 8) return {};
  const order = b.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return {};
  const t: Tiff = { b, le: order === 'II' };
  const ifd0 = ifd(t, r32(t, 4));
  const exifAt = ifd0.get(0x8769);
  const exif = exifAt ? ifd(t, r32(t, exifAt.at)) : new Map();
  const out: CaptureMeta = {};

  const raw = ascii(t, exif.get(0x9003)) ?? ascii(t, exif.get(0x9004)) ?? ascii(t, ifd0.get(0x0132));
  const m = raw && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (m && m[1] !== '0000' && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1) {
    const sub = ascii(t, exif.get(0x9291))?.replace(/\D/g, '').slice(0, 3);
    const off = ascii(t, exif.get(0x9011)) ?? ascii(t, exif.get(0x9010));
    const offset = off && /^[+-]\d{2}:\d{2}$/.test(off) ? off : '';
    out.capturedAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${sub ? `.${sub.padEnd(3, '0')}` : ''}${offset}`;
  }

  const gpsAt = ifd0.get(0x8825);
  if (gpsAt) {
    const gps = ifd(t, r32(t, gpsAt.at));
    const lat = rationals(t, gps.get(2));
    const lng = rationals(t, gps.get(4));
    const latRef = ascii(t, gps.get(1)) ?? 'N';
    const lngRef = ascii(t, gps.get(3)) ?? 'E';
    if (lat?.length === 3 && lng?.length === 3 && [...lat, ...lng].every(Number.isFinite)) {
      const dms = (v: number[]) => v[0] + v[1] / 60 + v[2] / 3600;
      const la = dms(lat) * (latRef.toUpperCase() === 'S' ? -1 : 1);
      const lo = dms(lng) * (lngRef.toUpperCase() === 'W' ? -1 : 1);
      // 0,0 is what some apps write when location was off: treat as none.
      if (Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0)) out.location = { lat: round6(la), lng: round6(lo) };
    }
  }
  return out;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** The TIFF block inside a JPEG's Exif APP1 segment, if any. */
export function tiffFromJpeg(b: Buffer): Buffer | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = b.readUInt16BE(p + 2);
    if (marker === 0xe1 && b.toString('latin1', p + 4, p + 10) === 'Exif\0\0') return b.subarray(p + 10, p + 2 + len);
    p += 2 + len;
  }
  return undefined;
}

/** Capture metadata of a photo file: JPEG (APP1 Exif) or HEIC/HEIF (Exif item). */
export async function photoMeta(file: string, heif: boolean): Promise<CaptureMeta> {
  try {
    if (heif) {
      const exif = planHeif(await fs.readFile(file)).exif;
      return exif ? metaFromTiff(exif) : {};
    }
    const fh = await fs.open(file, 'r');
    try {
      const head = Buffer.alloc(256 * 1024);
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      const tiff = tiffFromJpeg(head.subarray(0, bytesRead));
      return tiff ? metaFromTiff(tiff) : {};
    } finally {
      await fh.close();
    }
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- QuickTime / MP4 tags

/** ISO 6709 point ("+38.7139-009.1394+012.345/") to lat/lng. */
export function parseIso6709(s: string | undefined): LatLng | undefined {
  const m = s && /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(s.trim());
  if (!m) return undefined;
  const lat = Number(m[1]), lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return undefined;
  return { lat: round6(lat), lng: round6(lng) };
}

/** Capture time and place from ffprobe's format/stream tags (keys compared case-insensitively). */
export function metaFromTags(tags: Record<string, string | undefined>): CaptureMeta {
  const get = (k: string) => Object.entries(tags).find(([key]) => key.toLowerCase() === k)?.[1];
  const out: CaptureMeta = {};
  // Apple: local time with offset, e.g. "2026-05-03T14:22:10+0100".
  const apple = get('com.apple.quicktime.creationdate');
  const am = apple && /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?([+-])(\d{2}):?(\d{2})$/.exec(apple);
  if (am) out.capturedAt = `${am[1]}T${am[2]}${am[3]}${am[4]}:${am[5]}`;
  else {
    const ct = get('creation_time');
    const cm = ct && /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(ct);
    // 1904/1970 epochs are what encoders write when they had no clock: no capture time.
    if (cm && !/^(1904|1970)-01-01/.test(cm[1])) out.capturedAt = `${cm[1]}T${cm[2]}${cm[3] ? (cm[3] === 'Z' ? 'Z' : cm[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : 'Z'}`;
  }
  out.location = parseIso6709(get('com.apple.quicktime.location.iso6709') ?? get('location') ?? get('location-eng'));
  if (!out.location) delete out.location;
  return out;
}
