/**
 * Built-in HEIC/HEIF still-image reader for the ffmpeg-based converter.
 *
 * A HEIC is an ISO base media file whose `meta` box lists image items. Phones
 * store the photo as a grid of HEVC-coded tiles (an iPhone's 12 MP photo is
 * 8 × 6 tiles of 512 × 512) plus transforms (crop, rotation, mirroring) and an
 * Exif item. This module parses just enough of that to hand ffmpeg the tiles
 * as one HEVC stream and the filters that rebuild the picture: tile → crop to
 * the grid's size → the item's transforms in order. The Exif block is copied
 * into the JPEG with its orientation set to normal, since the rotation has
 * been applied to the pixels.
 *
 * Covers what phones and cameras write (hvc1 items and grids of them). Other
 * layouts (overlays, AVIF-coded HEIF, per-tile parameter sets) raise an error
 * that names what is not supported; libheif handles those when installed.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

interface Box { type: string; start: number; end: number; body: number }
interface ItemLoc { method: number; extents: { offset: number; length: number }[] }
interface Prop { type: string; data: Buffer }
export interface HeifImage {
  primary: number;
  types: Map<number, string>;
  props: Map<number, { prop: Prop; essential: boolean }[]>;
  refs: { type: string; from: number; to: number[] }[];
  read: (id: number) => Buffer;
}

function boxes(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let body = p + 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); body = p + 16; } else if (size === 0) size = end - p;
    if (size < 8 || p + size > end) throw new Error(`HEIF: broken ${type} box`);
    out.push({ type, start: p, end: p + size, body });
    p += size;
  }
  return out;
}

const readN = (b: Buffer, o: number, n: number) => (n === 0 ? 0 : n === 2 ? b.readUInt16BE(o) : n === 4 ? b.readUInt32BE(o) : n === 8 ? Number(b.readBigUInt64BE(o)) : NaN);

/** Parse the item structure of a HEIF file. */
export function parseHeif(buf: Buffer): HeifImage {
  const top = boxes(buf, 0, buf.length);
  const meta = top.find((b) => b.type === 'meta');
  if (!meta) throw new Error('HEIF: no meta box');
  const kids = boxes(buf, meta.body + 4, meta.end);
  const get = (t: string) => kids.find((b) => b.type === t);

  const pitm = get('pitm');
  if (!pitm) throw new Error('HEIF: no primary item');
  const primary = buf[pitm.body] === 0 ? buf.readUInt16BE(pitm.body + 4) : buf.readUInt32BE(pitm.body + 4);

  const types = new Map<number, string>();
  const iinf = get('iinf');
  if (!iinf) throw new Error('HEIF: no item list');
  const iv = buf[iinf.body];
  for (const e of boxes(buf, iinf.body + 4 + (iv === 0 ? 2 : 4), iinf.end)) {
    if (e.type !== 'infe') continue;
    const v = buf[e.body];
    if (v < 2) continue;
    const id = v === 2 ? buf.readUInt16BE(e.body + 4) : buf.readUInt32BE(e.body + 4);
    const t = e.body + 4 + (v === 2 ? 2 : 4) + 2;
    types.set(id, buf.toString('latin1', t, t + 4));
  }

  const locs = new Map<number, ItemLoc>();
  const iloc = get('iloc');
  if (!iloc) throw new Error('HEIF: no item locations');
  {
    let p = iloc.body;
    const v = buf[p];
    p += 4;
    const offSize = buf[p] >> 4, lenSize = buf[p] & 15, baseSize = buf[p + 1] >> 4, idxSize = v > 0 ? buf[p + 1] & 15 : 0;
    p += 2;
    const count = v < 2 ? buf.readUInt16BE(p) : buf.readUInt32BE(p);
    p += v < 2 ? 2 : 4;
    for (let i = 0; i < count; i++) {
      const id = v < 2 ? buf.readUInt16BE(p) : buf.readUInt32BE(p);
      p += v < 2 ? 2 : 4;
      let method = 0;
      if (v > 0) { method = buf.readUInt16BE(p) & 15; p += 2; }
      p += 2; // data_reference_index
      const base = readN(buf, p, baseSize);
      p += baseSize;
      const n = buf.readUInt16BE(p);
      p += 2;
      const extents: ItemLoc['extents'] = [];
      for (let k = 0; k < n; k++) {
        p += idxSize;
        const offset = readN(buf, p, offSize);
        p += offSize;
        const length = readN(buf, p, lenSize);
        p += lenSize;
        extents.push({ offset: base + offset, length });
      }
      locs.set(id, { method, extents });
    }
  }

  const refs: HeifImage['refs'] = [];
  const iref = get('iref');
  if (iref) {
    const v = buf[iref.body];
    const w = v === 0 ? 2 : 4;
    for (const r of boxes(buf, iref.body + 4, iref.end)) {
      let p = r.body;
      const from = readN(buf, p, w);
      p += w;
      const n = buf.readUInt16BE(p);
      p += 2;
      const to: number[] = [];
      for (let k = 0; k < n; k++, p += w) to.push(readN(buf, p, w));
      refs.push({ type: r.type, from, to });
    }
  }

  const props = new Map<number, { prop: Prop; essential: boolean }[]>();
  const iprp = get('iprp');
  if (iprp) {
    const parts = boxes(buf, iprp.body, iprp.end);
    const ipco = parts.find((b) => b.type === 'ipco');
    const list: Prop[] = ipco ? boxes(buf, ipco.body, ipco.end).map((b) => ({ type: b.type, data: buf.subarray(b.body, b.end) })) : [];
    for (const ipma of parts.filter((b) => b.type === 'ipma')) {
      const v = buf[ipma.body];
      const flags = buf.readUIntBE(ipma.body + 1, 3);
      let p = ipma.body + 4;
      const n = buf.readUInt32BE(p);
      p += 4;
      for (let i = 0; i < n; i++) {
        const id = v < 1 ? buf.readUInt16BE(p) : buf.readUInt32BE(p);
        p += v < 1 ? 2 : 4;
        const c = buf[p++];
        const arr = props.get(id) ?? [];
        for (let k = 0; k < c; k++) {
          let raw: number;
          if (flags & 1) { raw = buf.readUInt16BE(p); p += 2; } else raw = buf[p++];
          const big = (flags & 1) !== 0;
          const index = raw & (big ? 0x7fff : 0x7f);
          const essential = (raw & (big ? 0x8000 : 0x80)) !== 0;
          if (index > 0 && list[index - 1]) arr.push({ prop: list[index - 1], essential });
        }
        props.set(id, arr);
      }
    }
  }

  const idat = get('idat');
  const read = (id: number) => {
    const l = locs.get(id);
    if (!l) throw new Error(`HEIF: item ${id} has no data`);
    if (l.method === 1 && !idat) throw new Error('HEIF: item data in a missing idat box');
    if (l.method > 1) throw new Error('HEIF: item data stored by reference is not supported');
    const origin = l.method === 1 ? idat!.body : 0;
    const total = l.extents.length === 1 && l.extents[0].length === 0 ? [{ offset: l.extents[0].offset, length: (l.method === 1 ? idat!.end - idat!.body : buf.length) - l.extents[0].offset }] : l.extents;
    return Buffer.concat(total.map((e) => buf.subarray(origin + e.offset, origin + e.offset + e.length)));
  };
  return { primary, types, props, refs, read };
}

const findProp = (h: HeifImage, id: number, type: string) => h.props.get(id)?.find((p) => p.prop.type === type)?.prop.data;

/** Parameter-set NAL units (VPS, SPS, PPS…) and the NAL length size from an hvcC box. */
function hvcCInfo(data: Buffer): { lengthSize: number; params: Buffer[] } {
  const lengthSize = (data[21] & 3) + 1;
  const arrays = data[22];
  const params: Buffer[] = [];
  let p = 23;
  for (let i = 0; i < arrays; i++) {
    p += 1;
    const n = data.readUInt16BE(p);
    p += 2;
    for (let k = 0; k < n; k++) {
      const len = data.readUInt16BE(p);
      p += 2;
      params.push(data.subarray(p, p + len));
      p += len;
    }
  }
  return { lengthSize, params };
}

const START = Buffer.from([0, 0, 0, 1]);

function toAnnexB(sample: Buffer, lengthSize: number): Buffer[] {
  const out: Buffer[] = [];
  let p = 0;
  while (p + lengthSize <= sample.length) {
    const n = sample.readUIntBE(p, lengthSize);
    p += lengthSize;
    out.push(START, sample.subarray(p, p + n));
    p += n;
  }
  return out;
}

export interface HeifPlan {
  /** HEVC elementary stream: parameter sets once, then one coded picture per tile. */
  stream: Buffer;
  tiles: number;
  filters: string[];
  width: number;
  height: number;
  exif?: Buffer;
}

/** Work out how to rebuild the primary image with ffmpeg. */
export function planHeif(buf: Buffer): HeifPlan {
  const h = parseHeif(buf);
  const type = h.types.get(h.primary);
  let tiles: number[];
  const filters: string[] = [];
  let width: number, height: number;
  const ispe = (id: number) => { const d = findProp(h, id, 'ispe'); return d ? { w: d.readUInt32BE(4), h: d.readUInt32BE(8) } : undefined; };
  if (type === 'hvc1') {
    tiles = [h.primary];
    const s = ispe(h.primary);
    if (!s) throw new Error('HEIF: image has no size');
    width = s.w;
    height = s.h;
  } else if (type === 'grid') {
    const g = h.read(h.primary);
    const rows = g[2] + 1, cols = g[3] + 1;
    const wide = (g[1] & 1) !== 0;
    width = wide ? g.readUInt32BE(4) : g.readUInt16BE(4);
    height = wide ? g.readUInt32BE(8) : g.readUInt16BE(6);
    tiles = h.refs.find((r) => r.type === 'dimg' && r.from === h.primary)?.to ?? [];
    if (tiles.length !== rows * cols) throw new Error(`HEIF: grid lists ${tiles.length} tiles for ${cols}×${rows}`);
    if (tiles.some((t) => h.types.get(t) !== 'hvc1')) throw new Error('HEIF: grid tiles that are not HEVC are not supported');
    const t = ispe(tiles[0]);
    if (!t) throw new Error('HEIF: tile has no size');
    filters.push(`tile=${cols}x${rows}`);
    if (t.w * cols !== width || t.h * rows !== height) filters.push(`crop=${width}:${height}:0:0`);
  } else {
    throw new Error(`HEIF: primary image of type "${type ?? 'unknown'}" is not supported by the built-in reader`);
  }

  const hvcCs = tiles.map((t) => findProp(h, t, 'hvcC'));
  if (hvcCs.some((c) => !c)) throw new Error('HEIF: tile without decoder configuration');
  if (hvcCs.some((c) => !c!.equals(hvcCs[0]!))) throw new Error('HEIF: tiles with different decoder configurations are not supported');
  const { lengthSize, params } = hvcCInfo(hvcCs[0]!);
  const parts: Buffer[] = params.flatMap((n) => [START, n]);
  for (const t of tiles) parts.push(...toAnnexB(h.read(t), lengthSize));

  // Transforms on the primary item, in the order listed (HEIF applies them in that order).
  for (const { prop } of h.props.get(h.primary) ?? []) {
    if (prop.type === 'clap') {
      const d = prop.data;
      const frac = (o: number) => d.readInt32BE(o) / d.readInt32BE(o + 4);
      const cw = Math.round(frac(0)), ch = Math.round(frac(8));
      const x = Math.round((width - cw) / 2 + frac(16)), y = Math.round((height - ch) / 2 + frac(24));
      if (cw > 0 && ch > 0 && (cw !== width || ch !== height)) {
        filters.push(`crop=${cw}:${ch}:${Math.max(0, x)}:${Math.max(0, y)}`);
        width = cw;
        height = ch;
      }
    } else if (prop.type === 'irot') {
      const a = prop.data[0] & 3; // anticlockwise quarter turns
      if (a === 1) filters.push('transpose=cclock');
      else if (a === 2) filters.push('hflip', 'vflip');
      else if (a === 3) filters.push('transpose=clock');
      if (a % 2) [width, height] = [height, width];
    } else if (prop.type === 'imir') {
      filters.push((prop.data[0] & 1) === 0 ? 'hflip' : 'vflip');
    }
  }

  // Exif: the item that describes ("cdsc") the primary, else any Exif item. Its data starts with the offset to the TIFF header.
  let exifId = [...h.types].find(([id, t]) => t === 'Exif' && h.refs.some((r) => r.type === 'cdsc' && r.from === id && r.to.includes(h.primary)))?.[0];
  exifId ??= [...h.types].find(([, t]) => t === 'Exif')?.[0];
  let exif: Buffer | undefined;
  if (exifId !== undefined) {
    try {
      const d = h.read(exifId);
      const tiff = Buffer.from(d.subarray(4 + d.readUInt32BE(0)));
      if (tiff.length >= 8 && (tiff.toString('latin1', 0, 2) === 'MM' || tiff.toString('latin1', 0, 2) === 'II')) exif = tiff;
    } catch {
      /* unreadable Exif: convert without it */
    }
  }
  return { stream: Buffer.concat(parts), tiles: tiles.length, filters, width, height, exif };
}

/** Set the TIFF orientation tag (0x0112) in IFD0 to 1, in place. Returns false when there is none. */
export function resetTiffOrientation(tiff: Buffer): boolean {
  const le = tiff.toString('latin1', 0, 2) === 'II';
  const r16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const ifd = le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
  if (ifd + 2 > tiff.length) return false;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) return false;
    if (r16(e) === 0x0112) {
      if (le) tiff.writeUInt16LE(1, e + 8); else tiff.writeUInt16BE(1, e + 8);
      return true;
    }
  }
  return false;
}

/** Insert an Exif APP1 segment (from a TIFF block) into a JPEG, after its SOI and any JFIF APP0. */
export function withExif(jpeg: Buffer, tiff: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  if (payload.length + 2 > 0xffff || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.alloc(2), payload]);
  seg.writeUInt16BE(payload.length + 2, 2);
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + jpeg.readUInt16BE(4);
  return Buffer.concat([jpeg.subarray(0, at), seg, jpeg.subarray(at)]);
}

/** Convert a HEIC/HEIF file to a JPEG with ffmpeg: the built-in converter. */
export async function heifToJpegWithFfmpeg(src: string, dst: string, ffmpeg = 'ffmpeg', quality = 92): Promise<void> {
  const plan = planHeif(await fs.readFile(src));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-heif-'));
  try {
    const stream = path.join(tmp, 'tiles.hevc');
    await fs.writeFile(stream, plan.stream);
    // ffmpeg's JPEG quality scale runs 2 (best) to 31; 92% maps to about 3.
    const q = Math.max(2, Math.min(31, Math.round(2 + ((100 - quality) / 100) * 12)));
    const vf = [...plan.filters, 'format=yuvj444p'].join(',');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'hevc', '-i', stream, '-vf', vf, '-frames:v', '1', '-q:v', String(q), '-update', '1', dst],
      { timeout: 180_000, maxBuffer: 8 << 20 });
    if (plan.exif) {
      resetTiffOrientation(plan.exif);
      await fs.writeFile(dst, withExif(await fs.readFile(dst), plan.exif));
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
