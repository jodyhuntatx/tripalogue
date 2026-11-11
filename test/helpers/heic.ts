/**
 * Test helper: write a real HEIC file (no HEIC encoder needed). The picture is
 * encoded as one HEVC frame with ffmpeg's libx265, then wrapped in a minimal
 * HEIF container written here: ftyp, meta (hdlr, pitm, iinf, iref, iprp with
 * hvcC/ispe/irot, iloc) and mdat, plus an Exif item carrying a capture time and
 * an orientation tag, laid out like a phone's HEIC.
 *
 * The picture is blue with a red block in its top-left corner, so a test can
 * tell whether rotation was applied: with `rotateCcw: 90` the block ends up
 * bottom-left and the image turns from landscape to portrait.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface HeicOptions {
  width?: number;
  height?: number;
  /** HEIF `irot`: rotation applied on display, anticlockwise, in steps of 90. */
  rotateCcw?: 0 | 90 | 180 | 270;
  /** EXIF DateTimeOriginal, "YYYY:MM:DD HH:MM:SS". */
  capturedAt?: string;
  /** EXIF orientation tag (phones write the same rotation here as in irot; HEIF readers must ignore it). */
  exifOrientation?: number;
  /** Store the picture as a grid of tiles of this size (like a phone), padded and cropped back to width × height. */
  tile?: number;
}

const u8 = (n: number) => Buffer.from([n & 255]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const fullBox = (type: string, version: number, flags: number, ...parts: Buffer[]) => box(type, u8(version), u8(flags >> 16), u8(flags >> 8), u8(flags), ...parts);

function nalUnits(annexB: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  let start = -1;
  while (i + 3 <= annexB.length) {
    const sc3 = annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1;
    const sc4 = i + 4 <= annexB.length && annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 0 && annexB[i + 3] === 1;
    if (sc3 || sc4) {
      if (start >= 0) out.push(annexB.subarray(start, i));
      i += sc4 ? 4 : 3;
      start = i;
    } else i++;
  }
  if (start >= 0) out.push(annexB.subarray(start));
  return out.map((n) => { let e = n.length; while (e > 0 && n[e - 1] === 0) e--; return n.subarray(0, e); });
}

const nalType = (n: Buffer) => (n[0] >> 1) & 0x3f;
const unescape = (n: Buffer) => { const o: number[] = []; for (let i = 0; i < n.length; i++) { if (i >= 2 && n[i] === 3 && n[i - 1] === 0 && n[i - 2] === 0) continue; o.push(n[i]); } return Buffer.from(o); };

function hvcC(vps: Buffer, sps: Buffer, pps: Buffer): Buffer {
  const r = unescape(sps); // [0..1] NAL header, [2] vps id / sub-layers, [3..14] profile_tier_level
  const ptl = r.subarray(3, 15);
  const arrays = [vps, sps, pps].map((n) => Buffer.concat([u8(0x80 | nalType(n)), u16(1), u16(n.length), n]));
  return box('hvcC',
    u8(1), ptl.subarray(0, 1), ptl.subarray(1, 5), ptl.subarray(5, 11), ptl.subarray(11, 12),
    u16(0xf000), u8(0xfc), u8(0xfd), u8(0xf8), u8(0xf8), u16(0), u8(0x0f), u8(arrays.length), ...arrays);
}

export function exifTiff(capturedAt: string, orientation: number, extra: { offset?: string; gps?: { lat: number; lng: number } } = {}): Buffer {
  // Big-endian TIFF: IFD0 (Orientation, Exif pointer, GPS pointer?), the Exif IFD (DateTimeOriginal, OffsetTimeOriginal?),
  // the GPS IFD (refs and degree/minute/second rationals), then the values that do not fit in an entry.
  const entry = (tag: number, type: number, count: number, value: Buffer) => Buffer.concat([u16(tag), u16(type), u32(count), value]);
  const date = Buffer.from(`${capturedAt}\0`, 'latin1');
  const off = extra.offset ? Buffer.from(`${extra.offset}\0`, 'latin1') : undefined;
  const gps = extra.gps;
  const ifd0Count = gps ? 3 : 2;
  const ifd0 = 8;
  const exifIfd = ifd0 + 2 + ifd0Count * 12 + 4;
  const exifCount = off ? 2 : 1;
  const gpsIfd = exifIfd + 2 + exifCount * 12 + 4;
  const gpsCount = gps ? 4 : 0;
  let data = gpsIfd + (gps ? 2 + gpsCount * 12 + 4 : 0);
  const dateAt = data; data += date.length;
  const offAt = data; data += off ? off.length : 0;
  const latAt = data; data += gps ? 24 : 0;
  const lngAt = data; data += gps ? 24 : 0;
  const dms = (v: number) => { const a = Math.abs(v); const d = Math.floor(a); const m = Math.floor((a - d) * 60); const sec = Math.round(((a - d) * 60 - m) * 60 * 10000); return Buffer.concat([u32(d), u32(1), u32(m), u32(1), u32(sec), u32(10000)]); };
  const ref = (c: string) => Buffer.from([c.charCodeAt(0), 0, 0, 0]);
  return Buffer.concat([
    Buffer.from('MM\0*', 'latin1'), u32(ifd0),
    u16(ifd0Count), entry(0x0112, 3, 1, Buffer.concat([u16(orientation), u16(0)])), entry(0x8769, 4, 1, u32(exifIfd)),
    ...(gps ? [entry(0x8825, 4, 1, u32(gpsIfd))] : []), u32(0),
    u16(exifCount), entry(0x9003, 2, date.length, u32(dateAt)), ...(off ? [entry(0x9011, 2, off.length, u32(offAt))] : []), u32(0),
    ...(gps ? [u16(gpsCount), entry(1, 2, 2, ref(gps.lat < 0 ? 'S' : 'N')), entry(2, 5, 3, u32(latAt)), entry(3, 2, 2, ref(gps.lng < 0 ? 'W' : 'E')), entry(4, 5, 3, u32(lngAt)), u32(0)] : []),
    date, ...(off ? [off] : []), ...(gps ? [dms(gps.lat), dms(gps.lng)] : []),
  ]);
}

/** Write a HEIC file at `file`. */
export async function writeHeic(file: string, o: HeicOptions = {}): Promise<void> {
  const w = o.width ?? 320;
  const h = o.height ?? 240;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'heic-'));
  try {
    const hevc = path.join(tmp, 'frame.hevc');
    const t = o.tile;
    const cols = t ? Math.ceil(w / t) : 1, rows = t ? Math.ceil(h / t) : 1;
    const picture = `color=c=blue:s=${w}x${h},drawbox=x=0:y=0:w=${Math.round(w / 4)}:h=${Math.round(h / 4)}:c=red:t=fill`;
    const split = t ? `,pad=${cols * t}:${rows * t}:0:0:green,untile=${cols}x${rows}` : '';
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', picture + split,
      '-frames:v', String(cols * rows), '-c:v', 'libx265', '-x265-params', 'log-level=error:keyint=1:bframes=0', '-pix_fmt', 'yuv420p', '-f', 'hevc', hevc]);
    const nals = nalUnits(await fs.readFile(hevc));
    const vps = nals.find((n) => nalType(n) === 32)!;
    const sps = nals.find((n) => nalType(n) === 33)!;
    const pps = nals.find((n) => nalType(n) === 34)!;
    const slices = nals.filter((n) => nalType(n) < 32); // one slice per picture: one per tile
    if (slices.length !== cols * rows) throw new Error(`expected ${cols * rows} coded tiles, got ${slices.length}`);
    const coded = slices.map((n) => Buffer.concat([u32(n.length), n]));
    const exif = o.capturedAt ? Buffer.concat([u32(0), exifTiff(o.capturedAt, o.exifOrientation ?? 1)]) : undefined;

    // Item ids: 1 = primary (the image, or the grid), 2..N+1 = tiles (grid only), then Exif.
    const tileIds = t ? coded.map((_, i) => i + 2) : [];
    const exifId = exif ? (t ? coded.length + 2 : 2) : 0;
    const gridData = t ? Buffer.concat([u8(0), u8(0), u8(rows - 1), u8(cols - 1), u16(w), u16(h)]) : undefined;
    const props = [hvcC(vps, sps, pps), fullBox('ispe', 0, 0, u32(t ?? w), u32(t ?? h)), fullBox('ispe', 0, 0, u32(w), u32(h))];
    if (o.rotateCcw) props.push(box('irot', u8(o.rotateCcw / 90)));
    const irot = o.rotateCcw ? [u8(0x80 | 4)] : [];
    const ipmaEntries = t
      ? [Buffer.concat([u16(1), u8(1 + irot.length), u8(3), ...irot]), ...tileIds.map((id) => Buffer.concat([u16(id), u8(2), u8(0x81), u8(2)]))]
      : [Buffer.concat([u16(1), u8(2 + irot.length), u8(0x81), u8(2), ...irot])];
    const iprp = box('iprp', box('ipco', ...props), fullBox('ipma', 0, 0, u32(ipmaEntries.length), ...ipmaEntries));
    const infe = (id: number, type: string) => fullBox('infe', 2, 0, u16(id), u16(0), Buffer.from(type, 'latin1'), u8(0));
    const items = t ? [infe(1, 'grid'), ...tileIds.map((id) => infe(id, 'hvc1'))] : [infe(1, 'hvc1')];
    if (exif) items.push(infe(exifId, 'Exif'));
    const iinf = fullBox('iinf', 0, 0, u16(items.length), ...items);
    const refs = [
      ...(t ? [box('dimg', u16(1), u16(tileIds.length), ...tileIds.map(u16))] : []),
      ...(exif ? [box('cdsc', u16(exifId), u16(1), u16(1))] : []),
    ];
    const iref = refs.length ? fullBox('iref', 0, 0, ...refs) : Buffer.alloc(0);
    const ftyp = box('ftyp', Buffer.from('heic', 'latin1'), u32(0), Buffer.from('mif1heic', 'latin1'));
    // Data: grid record in idat (construction method 1, as phones do), coded pictures and Exif in mdat.
    const idat = gridData ? box('idat', gridData) : Buffer.alloc(0);
    const payloads = [...(t ? coded : [Buffer.concat(coded)]), ...(exif ? [exif] : [])];
    const payloadIds = [...(t ? tileIds : [1]), ...(exif ? [exifId] : [])];
    const meta = (dataStart: number) => {
      let off = dataStart;
      const entries = payloadIds.map((id, i) => { const e = Buffer.concat([u16(id), u16(0), u16(0), u16(1), u32(off), u32(payloads[i].length)]); off += payloads[i].length; return e; });
      if (gridData) entries.unshift(Buffer.concat([u16(1), u16(1), u16(0), u16(1), u32(0), u32(gridData.length)]));
      return fullBox('meta', 0, 0,
        fullBox('hdlr', 0, 0, u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(12), u8(0)),
        fullBox('pitm', 0, 0, u16(1)), iinf, iref, iprp, idat,
        fullBox('iloc', 1, 0, u8(0x44), u8(0x00), u16(entries.length), ...entries));
    };
    const dataStart = ftyp.length + meta(0).length + 8;
    const out = Buffer.concat([ftyp, meta(dataStart), box('mdat', ...payloads)]);
    await fs.writeFile(file, out);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Size of an image and the colour at a point, via ffmpeg (no image library needed). */
export async function look(file: string, x: number, y: number): Promise<{ w: number; h: number; rgb: [number, number, number] }> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [w, h] = stdout.trim().split(',').map(Number);
  const px = await new Promise<Buffer>((resolve, reject) => {
    execFile('ffmpeg', ['-v', 'error', '-noautorotate', '-i', file, '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' },
      (e, out) => (e ? reject(e) : resolve(out)));
  });
  return { w, h, rgb: [px[0], px[1], px[2]] };
}
export const isRed = ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60;
export const isBlue = ([r, g, b]: number[]) => b > 200 && r < 60 && g < 60;
