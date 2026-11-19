/**
 * The exporter's render worker (VX-1, VX-2, VX-7, VX-8, VX-9).
 *
 * Pictures: a headless browser on this computer opens the export page, which
 * draws every frame with the preview's own code (render model + draw.ts), from
 * the originals: photos decoded by the browser, video frames decoded here by
 * ffmpeg and handed over in order, map tiles fetched into storage before the
 * render starts. Each page draws one stretch of frames and sends them back raw;
 * ffmpeg encodes each stretch, and the stretches are joined without
 * re-encoding.
 *
 * Sound: every source is decoded to PCM and mixed here with the shared mixAt()
 * gains (volume, fades, ducking, mute, solo, loops, crossfades), the model the
 * preview plays, then normalised to -16 LUFS and encoded as AAC.
 *
 * Same project and settings in, same frames out: nothing depends on the clock.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  audioSources, buildTimeline, frameTime, mapAt, mixAt, planVideo, tilesFor, type AudioSource, type ExportSettings, type MediaItem, type Size,
  type RenderSetup, type Timeline, type Travelogue, type VideoPlan,
} from '../core/index.js';
import type { BlobStore } from './blobstore.js';
import { acquireBrowser, BrowserUnavailable } from './browser.js';
import { probe } from './media.js';
import { jpegOrientation, swapsSides } from './orientation.js';

const run = promisify(execFile);

export const AUDIO_RATE = 48_000;
/** VX-9: integrated loudness of the exported soundtrack. */
export const TARGET_LUFS = -16;

/** A failure tied to one item (VX-4): the UI names it and links to it. */
export class RenderError extends Error {
  constructor(message: string, readonly itemId?: string, readonly reason: 'missing' | 'unsupported' | 'failed' | 'cancelled' | 'browser' = 'failed') {
    super(message);
  }
}

export interface RenderInput {
  doc: Travelogue;
  settings: ExportSettings;
  outFile: string;
  workDir: string;
  signal: AbortSignal;
  /** 0..1, and a short note on the step. */
  onProgress: (fraction: number, step: string) => void;
}

/** Map tiles, fetched into storage before the render (VX-8). */
export interface TileFetcher {
  tile(z: string, x: string, y: string, style?: string, lang?: string): Promise<Buffer>;
  readonly attribution: string;
  readonly enabled: boolean;
}

export interface RenderOptions {
  ffmpeg: string;
  ffprobe: string;
  /** This server's address, for the export page (http://127.0.0.1:port). */
  serverUrl: () => string;
  tiles?: TileFetcher;
  /** Pages drawing in parallel (default: one per CPU core, 1 to 4; each waits on its encoder part of the time). */
  concurrency?: number;
  /** x264 preset (default "veryfast"). */
  preset?: string;
  log?: (msg: string) => void;
}

export interface RenderResult {
  frames: number;
  durationSec: number;
  loudnessLufs: number | null;
}

interface Chunk {
  from: number;
  to: number;
  file: string;
  encoder: ChildProcess;
  encoderDone: Promise<void>;
  next: number;
  done: () => void;
  failed: (e: Error) => void;
  finished: Promise<void>;
  /** The last frame sent (repeated when the page says nothing changed). */
  last?: Buffer;
  /** Called after each accepted frame (the page recycling waits on it). */
  onAdvance?: () => void;
}

/**
 * Frames one export page draws before it is replaced by a fresh one: the browser keeps memory
 * from each frame upload for as long as the page lives, and stalls once a few GB build up.
 */
const FRAMES_PER_PAGE = 150;

interface Active {
  token: string;
  setup: RenderSetup;
  files: Map<string, string>;
  decoders: Map<string, FrameDecoder>;
  chunks: Chunk[];
  framesDone: number;
  lastActivity: number;
  onFrame: () => void;
  signal: AbortSignal;
}

const nameOf = (m: MediaItem) => m.uri.split('/').pop() ?? m.id;

export class Renderer {
  private readonly active = new Map<string, Active>();

  constructor(private readonly blobs: BlobStore, private readonly o: RenderOptions) {}

  async render(input: RenderInput): Promise<RenderResult> {
    const { doc, settings, signal } = input;
    const tl = buildTimeline(doc);
    const plan = planVideo(tl, settings);
    if (!plan.totalFrames) throw new RenderError('There is nothing to export in that part of the travelogue');
    await fs.mkdir(input.workDir, { recursive: true });
    const W_TILES = 0.04, W_VIDEO = 0.84, W_AUDIO = 0.1;

    // Every original the range needs, found and measured before drawing (VX-4: a missing one is named now).
    input.onProgress(0, 'Checking the originals');
    const items = new Map(doc.media.map((m) => [m.id, m]));
    const used = usedPictures(tl, plan);
    const files = new Map<string, string>();
    const sizes: Record<string, Size> = {};
    for (const id of used) {
      this.checkAbort(signal);
      const m = items.get(id);
      if (!m) continue;
      const file = await this.pictureFile(m);
      files.set(id, file);
      const s = await this.uprightSize(m, file);
      if (s) sizes[id] = s;
    }

    // VX-8: the map tiles every frame needs, into storage before the render starts.
    const tiles = this.o.tiles;
    if (tiles?.enabled) {
      const want = tilesNeeded(doc, tl, plan);
      let k = 0;
      const list = [...want.values()];
      const worker = async () => {
        while (k < list.length) {
          const t = list[k++];
          this.checkAbort(signal);
          await tiles.tile(String(t.z), String(t.x), String(t.y), t.style, t.lang).catch(() => undefined);
          input.onProgress((W_TILES * k) / list.length, `Fetching map tiles (${k} of ${list.length})`);
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
    }

    // Pictures: the export page draws them, a stretch per page; ffmpeg encodes each stretch.
    const token = randomBytes(18).toString('base64url');
    const n = Math.max(1, Math.min(plan.totalFrames, this.o.concurrency ?? Math.max(1, Math.min(4, os.cpus().length))));
    const per = Math.ceil(plan.totalFrames / n);
    const active: Active = {
      token, files, decoders: new Map(), chunks: [], framesDone: 0, lastActivity: Date.now(), signal,
      setup: { doc, fps: plan.fps, start: plan.start, size: plan.size, sizes, tiles: !!tiles?.enabled, attribution: tiles?.enabled ? tiles.attribution : '' },
      onFrame: () => input.onProgress(W_TILES + W_VIDEO * (active.framesDone / plan.totalFrames), 'Drawing frames'),
    };
    for (let c = 0; c < n; c++) {
      const from = c * per, to = Math.min(plan.totalFrames, from + per);
      if (to > from) active.chunks.push(this.startChunk(plan, path.join(input.workDir, `part-${c}.mp4`), from, to, signal));
    }
    this.active.set(token, active);
    const { browser, release } = await acquireBrowser(this.o.log).catch((e) => {
      this.active.delete(token);
      for (const ch of active.chunks) ch.encoder.kill('SIGKILL');
      throw e instanceof BrowserUnavailable ? new RenderError(e.message, undefined, 'browser') : e;
    });
    const contexts = await Promise.all(active.chunks.map(() => browser.newContext({ viewport: { width: 320, height: 200 } })));
    const watchdog = setInterval(() => {
      if (Date.now() - active.lastActivity > 120_000) for (const ch of active.chunks) ch.failed(new RenderError('Drawing frames stopped responding'));
    }, 5000);
    const onAbort = () => { for (const ch of active.chunks) ch.failed(new RenderError('Export cancelled', undefined, 'cancelled')); };
    signal.addEventListener('abort', onAbort);
    try {
      await Promise.all(active.chunks.map(async (ch, c) => {
        // Each stretch is drawn by a series of short-lived pages (see FRAMES_PER_PAGE).
        for (let from = ch.from; from < ch.to; from += FRAMES_PER_PAGE) {
          const to = Math.min(ch.to, from + FRAMES_PER_PAGE);
          const reached = new Promise<void>((resolve) => {
            ch.onAdvance = () => { if (ch.next >= to) resolve(); };
          });
          const page = await contexts[c].newPage();
          page.on('pageerror', (e) => ch.failed(new RenderError(`The export page failed: ${e.message}`)));
          await page.goto(`${this.o.serverUrl()}/render.html#token=${token}&chunk=${c}&from=${from}&to=${to}`);
          await Promise.race([reached, ch.finished]);
          await page.close().catch(() => {});
        }
        await ch.finished;
        ch.encoder.stdin?.end();
        await ch.encoderDone;
      }));
    } finally {
      signal.removeEventListener('abort', onAbort);
      clearInterval(watchdog);
      for (const ctx of contexts) await ctx.close().catch(() => {});
      await release();
      for (const d of active.decoders.values()) d.close();
      for (const ch of active.chunks) if (ch.encoder.exitCode === null) ch.encoder.kill('SIGKILL');
      this.active.delete(token);
    }
    this.checkAbort(signal);

    input.onProgress(W_TILES + W_VIDEO, 'Mixing sound');
    const audioFile = path.join(input.workDir, 'sound.m4a');
    const loudness = await this.renderAudio(tl, doc, plan, items, input, audioFile, (f) => input.onProgress(W_TILES + W_VIDEO + W_AUDIO * f, 'Mixing sound'));
    this.checkAbort(signal);

    input.onProgress(W_TILES + W_VIDEO + W_AUDIO, 'Writing the MP4');
    const list = path.join(input.workDir, 'parts.txt');
    await fs.writeFile(list, active.chunks.map((ch) => `file '${ch.file.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const tmpOut = `${input.outFile}.part.mp4`;
    await this.ff(['-f', 'concat', '-safe', '0', '-i', list, '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', '-tag:v', 'avc1', tmpOut], signal);
    await fs.rename(tmpOut, input.outFile);
    input.onProgress(1, 'Done');
    return { frames: plan.totalFrames, durationSec: plan.totalFrames / plan.fps, loudnessLufs: loudness };
  }

  /** An ffmpeg encoding one stretch of frames from raw YUV 4:2:0 on its stdin. */
  private startChunk(plan: VideoPlan, file: string, from: number, to: number, signal: AbortSignal): Chunk {
    const { w, h } = plan.size;
    const fps = plan.fps;
    const enc = spawn(this.o.ffmpeg, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      // The page sends YUV 4:2:0 (BT.709, limited range) already: nothing to convert.
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${w}x${h}`, '-r', String(fps), '-i', '-',
      '-c:v', 'libx264', '-preset', this.o.preset ?? 'veryfast', '-crf', '18', '-profile:v', 'high',
      '-g', String(fps * 2), '-video_track_timescale', String(fps * 512),
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      '-an', file,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    enc.stderr?.on('data', (d) => { err = (err + String(d)).slice(-4000); });
    enc.stdin?.on('error', () => {}); // a killed encoder: the close handler reports it
    const encoderDone = new Promise<void>((resolve, reject) => {
      enc.on('close', (code) => (code === 0 || signal.aborted ? resolve() : reject(new RenderError(`Encoding failed: ${err.trim().split('\n').pop() ?? code}`))));
      enc.on('error', reject);
    });
    let done!: () => void, failed!: (e: Error) => void;
    const finished = new Promise<void>((res, rej) => { done = res; failed = rej; });
    finished.catch(() => {});
    encoderDone.catch((e: Error) => failed(e));
    return { from, to, file, encoder: enc, encoderDone, next: from, done, failed, finished };
  }

  // ---------------------------------------------------------------- the export page's requests

  private job(token: string): Active {
    const a = this.active.get(token);
    if (!a) throw new RenderError('No such render');
    return a;
  }

  setupFor(token: string): RenderSetup {
    return this.job(token).setup;
  }

  /** The original a picture is drawn from (HEIC photos: their full-size JPEG). */
  pictureFor(token: string, itemId: string): string {
    const f = this.job(token).files.get(itemId);
    if (!f) throw new RenderError('Not in this render', itemId);
    return f;
  }

  /** The video frame at media time t, as a JPEG picture, decoded in order by ffmpeg for this page. */
  async videoFrame(token: string, chunk: number, itemId: string, t: number, speed: number): Promise<{ data: Buffer; w: number; h: number }> {
    const a = this.job(token);
    a.lastActivity = Date.now();
    const file = this.pictureFor(token, itemId);
    const key = `${chunk}:${itemId}:${speed}`;
    const step = speed / a.setup.fps;
    let d = a.decoders.get(key);
    const j = d ? Math.round((t - d.start) / step) : -1;
    if (!d || j < d.index - 1 || j > d.index + a.setup.fps * 3) {
      d?.close();
      const size = a.setup.sizes[itemId] ?? { w: a.setup.size.w, h: a.setup.size.h };
      // Decode at the size that covers the frame (no more), keeping the shape.
      const k = Math.min(1, Math.max(a.setup.size.w / size.w, a.setup.size.h / size.h));
      const w = Math.max(2, Math.round((size.w * k) / 2) * 2), h = Math.max(2, Math.round((size.h * k) / 2) * 2);
      d = new FrameDecoder(this.o.ffmpeg, file, t, step, w, h);
      a.decoders.set(key, d);
    }
    try {
      const data = await d.frame(Math.max(0, Math.round((t - d.start) / step)));
      return { data, w: d.w, h: d.h };
    } catch (e) {
      const m = a.setup.doc.media.find((x) => x.id === itemId);
      throw new RenderError(`Could not read the video ${m ? nameOf(m) : itemId}: ${(e as Error).message}`, itemId, 'unsupported');
    }
  }

  /**
   * One drawn frame (raw YUV 4:2:0) for a page's stretch, in order; or, with `repeat`, the stretch's last frame
   * again (the page found it would draw the same picture).
   */
  async acceptFrame(token: string, chunk: number, k: number, body: IncomingMessage, repeat = false): Promise<void> {
    const a = this.job(token);
    const ch = a.chunks[chunk];
    if (!ch || k !== ch.next) throw new RenderError(`Frame ${k} out of order`);
    a.lastActivity = Date.now();
    const bytes = (a.setup.size.w * a.setup.size.h * 3) / 2;
    let frame: Buffer;
    if (repeat) {
      body.resume();
      if (!ch.last) throw new RenderError(`Frame ${k} repeats a frame that was never sent`);
      frame = ch.last;
    } else {
      // A fresh buffer each time: the encoder may still be reading the previous one.
      frame = Buffer.allocUnsafe(bytes);
      let at = 0;
      for await (const part of body as AsyncIterable<Buffer>) {
        if (at + part.length > bytes) throw new RenderError(`Frame ${k} is larger than a ${a.setup.size.w}×${a.setup.size.h} picture`);
        part.copy(frame, at);
        at += part.length;
      }
      if (at !== bytes) throw new RenderError(`Frame ${k} is incomplete (${at} of ${bytes} bytes)`);
      ch.last = frame;
    }
    const stdin = ch.encoder.stdin!;
    if (!stdin.write(frame)) await new Promise<void>((resolve, reject) => {
      const off = () => { stdin.off('drain', ok); stdin.off('error', bad); ch.encoder.off('close', ok); };
      const ok = () => { off(); resolve(); };
      const bad = (e: Error) => { off(); reject(e); };
      stdin.once('drain', ok);
      stdin.once('error', bad);
      ch.encoder.once('close', ok);
    });
    ch.next += 1;
    a.framesDone += 1;
    a.onFrame();
    ch.onAdvance?.();
    if (ch.next >= ch.to) ch.done();
  }

  pageFailed(token: string, chunk: number, info: { message?: string; itemId?: string; reason?: string }): void {
    const a = this.active.get(token);
    const ch = a?.chunks[chunk];
    if (!ch) return;
    const m = info.itemId ? a!.setup.doc.media.find((x) => x.id === info.itemId) : undefined;
    const message = m ? `Could not draw ${nameOf(m)}: ${info.message ?? 'it did not load'}` : info.message ?? 'The export page failed';
    ch.failed(new RenderError(message, info.itemId, info.reason === 'missing' ? 'missing' : info.itemId ? 'unsupported' : 'failed'));
  }

  // ---------------------------------------------------------------- files

  private checkAbort(signal: AbortSignal) {
    if (signal.aborted) throw new RenderError('Export cancelled', undefined, 'cancelled');
  }

  private async ff(args: string[], signal: AbortSignal): Promise<{ stderr: string }> {
    try {
      const r = await run(this.o.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { maxBuffer: 64 << 20, signal });
      return { stderr: String(r.stderr) };
    } catch (e) {
      if (signal.aborted) throw new RenderError('Export cancelled', undefined, 'cancelled');
      throw e;
    }
  }

  /** The file a picture is drawn from: the original (HEIC photos: their full-size JPEG). */
  private async pictureFile(m: MediaItem): Promise<string> {
    const key = m.kind === 'image' ? m.assets?.jpeg ?? m.storageKey : m.storageKey;
    if (!key) throw new RenderError(`${nameOf(m)} has no stored original`, m.id, 'missing');
    try {
      const file = await this.blobs.localPath(key);
      await fs.access(file);
      return file;
    } catch {
      throw new RenderError(`The original of ${nameOf(m)} is missing`, m.id, 'missing');
    }
  }

  /**
   * Upright size of a picture, measured from the file drawn (turned by a photo's EXIF orientation), not taken from
   * the project: an item processed by an older version may record the sideways stored size.
   */
  private async uprightSize(m: MediaItem, file: string): Promise<Size | undefined> {
    const pr = await probe(file, this.o.ffprobe).catch(() => undefined);
    if (m.kind === 'video' && pr && !pr.width) throw new RenderError(`${nameOf(m)} has no picture TripAlogue can read`, m.id, 'unsupported');
    let w = pr?.width, h = pr?.height;
    if (m.kind === 'image' && pr?.storedWidth && pr.storedHeight) {
      const turned = swapsSides(await jpegOrientation(file).catch(() => 1));
      w = turned ? pr.storedHeight : pr.storedWidth;
      h = turned ? pr.storedWidth : pr.storedHeight;
    }
    if (w && h) return { w, h };
    return m.width && m.height ? { w: m.width, h: m.height } : undefined;
  }

  private wrap(e: unknown, m?: MediaItem): RenderError {
    if (e instanceof RenderError) return e;
    const err = e as { stderr?: string; message?: string };
    const text = String(err.stderr ?? err.message ?? e);
    const last = text.trim().split('\n').filter((l) => l.trim()).slice(-1)[0] ?? 'ffmpeg failed';
    this.o.log?.(`export: ${m?.id ?? ''}: ${text.slice(-2000)}`);
    const name = m ? nameOf(m) : 'a sound';
    if (/No such file|does not exist/i.test(text)) return new RenderError(`The original of ${name} is missing`, m?.id, 'missing');
    if (/Decoder .* not found|Invalid data found|could not find codec|Unsupported codec|unknown codec|no decoder/i.test(text)) {
      return new RenderError(`${name} uses a format TripAlogue cannot read (${last.trim().slice(0, 160)})`, m?.id, 'unsupported');
    }
    return new RenderError(`Could not render ${name}: ${last.trim().slice(0, 200)}`, m?.id, 'failed');
  }

  // ---------------------------------------------------------------- sound

  private async renderAudio(
    tl: Timeline, doc: Travelogue, plan: VideoPlan, items: Map<string, MediaItem>, input: RenderInput, out: string, progress: (f: number) => void,
  ): Promise<number | null> {
    const { signal } = input;
    const end = plan.start + plan.totalFrames / plan.fps;
    const totalSamples = Math.round((plan.totalFrames / plan.fps) * AUDIO_RATE);
    const muted = new Set(tl.segments.flatMap((g) => (g.kind === 'video' && g.cue.mute ? [g.item.id] : [])));
    const sources = audioSources(tl, plan.start, end).filter((s) => !(s.kind === 'video' && muted.has(s.itemId)));
    const decoded = new Map<string, { src: AudioSource; reader: PcmReader }>();
    let k = 0;
    try {
      for (const src of sources) {
        this.checkAbort(signal);
        const m = items.get(src.itemId)!;
        const pcm = path.join(input.workDir, `pcm-${k++}.f32`);
        const samples = await this.decode(src, m, pcm, signal);
        if (samples) decoded.set(`${src.kind}:${src.itemId}`, { src, reader: await PcmReader.open(pcm, samples) });
        progress((0.4 * k) / Math.max(1, sources.length));
      }
      // Mix in blocks of one second, every gain from the shared model every 10 ms (linear in between: no clicks).
      const mixFile = path.join(input.workDir, 'mix.f32');
      const fh = await fs.open(mixFile, 'w');
      try {
        const BLOCK = AUDIO_RATE, STEP = AUDIO_RATE / 100;
        const outBuf = new Float32Array(BLOCK * 2);
        for (let b0 = 0; b0 < totalSamples; b0 += BLOCK) {
          this.checkAbort(signal);
          const len = Math.min(BLOCK, totalSamples - b0);
          outBuf.fill(0);
          const steps = Math.ceil(len / STEP) + 1;
          const voices = new Map<string, { gain: Float32Array; media: Float64Array }>();
          for (let s = 0; s < steps; s++) {
            const t = plan.start + (b0 + s * STEP) / AUDIO_RATE;
            for (const v of mixAt(tl, doc.audioLanes, t)) {
              const key = `${v.kind}:${v.itemId}`;
              if (!decoded.has(key)) continue;
              let e = voices.get(key);
              if (!e) voices.set(key, (e = { gain: new Float32Array(steps), media: new Float64Array(steps).fill(Number.NaN) }));
              e.gain[s] = v.gain;
              e.media[s] = v.mediaTimeSec;
            }
          }
          for (const [key, e] of voices) {
            const d = decoded.get(key)!;
            const loop = (d.src.mediaEnd ?? Number.POSITIVE_INFINITY) - d.src.mediaStart;
            for (let j = 0; j < len; j++) {
              const pos = j / STEP;
              const s = Math.floor(pos);
              const gain = e.gain[s] + (e.gain[Math.min(steps - 1, s + 1)] - e.gain[s]) * (pos - s);
              if (gain === 0 || Number.isNaN(e.media[s])) continue;
              let idx: number;
              if (d.src.kind === 'video') {
                // Video sound is decoded at its speed, on the timeline's clock.
                idx = Math.round((plan.start + (b0 + j) / AUDIO_RATE - d.src.start) * AUDIO_RATE);
              } else {
                // Audio clips by media time (a looping clip goes round its trimmed part).
                let media = e.media[s] + (j - s * STEP) / AUDIO_RATE;
                if (media >= d.src.mediaStart + loop) media -= loop;
                idx = Math.round((media - d.src.mediaStart) * AUDIO_RATE);
              }
              const pcm = await d.reader.at(idx);
              if (!pcm) continue;
              outBuf[j * 2] += pcm[0] * gain;
              outBuf[j * 2 + 1] += pcm[1] * gain;
            }
          }
          await fh.write(Buffer.from(outBuf.buffer, 0, len * 8));
          progress(0.4 + (0.4 * (b0 + len)) / totalSamples);
        }
      } finally {
        await fh.close();
      }
      // VX-9: measure, then normalise to the target loudness in a second pass. Silence stays silent.
      const raw = ['-f', 'f32le', '-ar', String(AUDIO_RATE), '-ac', '2', '-i', mixFile];
      const target = `I=${TARGET_LUFS}:TP=-1.5:LRA=11`;
      const { stderr } = await this.ff([...raw, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'], signal);
      const mm = /\{[\s\S]*"input_i"[\s\S]*\}/.exec(stderr);
      const meas = mm ? (JSON.parse(mm[0]) as Record<string, string>) : undefined;
      const inputI = Number(meas?.input_i);
      const audible = meas && Number.isFinite(inputI) && inputI > -70;
      const af = audible
        ? `loudnorm=${target}:measured_I=${meas.input_i}:measured_TP=${meas.input_tp}:measured_LRA=${meas.input_lra}:measured_thresh=${meas.input_thresh}:offset=${meas.target_offset}:linear=true,aresample=${AUDIO_RATE}`
        : 'anull';
      await this.ff([...raw, '-af', af, '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE), out], signal);
      progress(1);
      return audible ? TARGET_LUFS : null;
    } finally {
      for (const d of decoded.values()) await d.reader.close();
    }
  }

  /** Decode a source to 48 kHz stereo float PCM; returns its length in samples, or 0 when it has no sound. */
  private async decode(src: AudioSource, m: MediaItem, out: string, signal: AbortSignal): Promise<number> {
    const file = await this.pictureFile(m);
    if (src.kind === 'video') {
      const pr = await probe(file, this.o.ffprobe).catch(() => undefined);
      if (!pr?.hasAudio) return 0;
    }
    const video = src.kind === 'video';
    const dur = video ? (src.end - src.start) * src.speed : (src.mediaEnd ?? src.mediaStart) - src.mediaStart;
    const tempo = video ? atempoChain(src.speed) : '';
    try {
      await this.ff([
        '-ss', src.mediaStart.toFixed(6), '-t', dur.toFixed(6), '-i', file, '-vn', '-map', '0:a:0',
        ...(tempo ? ['-af', tempo] : []), '-ac', '2', '-ar', String(AUDIO_RATE), '-f', 'f32le', '-c:a', 'pcm_f32le', out,
      ], signal);
    } catch (e) {
      throw this.wrap(e, m);
    }
    const st = await fs.stat(out);
    return Math.floor(st.size / 8);
  }
}

/** Pictures drawn in the range: the media of every segment that plays in it, and title cards' backgrounds. */
function usedPictures(tl: Timeline, plan: VideoPlan): Set<string> {
  const end = plan.start + plan.totalFrames / plan.fps;
  const out = new Set<string>();
  for (const s of tl.segments) {
    if (s.start + s.duration <= plan.start || s.start >= end) continue;
    if (s.kind === 'title') {
      if (s.background) out.add(s.background.id);
    } else out.add(s.item.id);
  }
  return out;
}

/** Every map tile the frames of the range draw (VX-8). */
function tilesNeeded(doc: Travelogue, tl: Timeline, plan: VideoPlan): Map<string, { z: number; x: number; y: number; style: string; lang: string }> {
  const out = new Map<string, { z: number; x: number; y: number; style: string; lang: string }>();
  const style = doc.mapView.style === 'terrain' ? 'terrain' : 'light';
  const lang = doc.mapView.labelLanguage ?? '';
  for (let k = 0; k < plan.totalFrames; k++) {
    const m = mapAt(doc, tl, frameTime(plan, k), plan.size);
    if (!m) continue;
    for (const t of tilesFor(m.state.camera, m.layout.rect)) out.set(`${t.z}/${t.x}/${t.y}`, { z: t.z, x: t.x, y: t.y, style, lang });
  }
  return out;
}

/** atempo takes 0.5–2 per filter: chain them for other speeds. */
function atempoChain(speed: number): string {
  if (Math.abs(speed - 1) < 1e-6) return '';
  const parts: string[] = [];
  let s = speed;
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(6)}`);
  return parts.join(',');
}

/** Random access to stereo float PCM in a file, through a two-second window. */
class PcmReader {
  private start = -1;
  private buf = new Float32Array(0);
  private readonly pair = new Float32Array(2);
  private constructor(private readonly fh: fs.FileHandle, private readonly samples: number) {}

  static async open(file: string, samples: number): Promise<PcmReader> {
    return new PcmReader(await fs.open(file, 'r'), samples);
  }

  async at(i: number): Promise<Float32Array | undefined> {
    if (i < 0 || i >= this.samples) return undefined;
    if (this.start < 0 || i < this.start || i >= this.start + this.buf.length / 2) {
      const n = Math.min(AUDIO_RATE * 2, this.samples - i);
      const b = Buffer.alloc(n * 8);
      await this.fh.read(b, 0, b.length, i * 8);
      this.buf = new Float32Array(b.buffer, b.byteOffset, n * 2);
      this.start = i;
    }
    const o = (i - this.start) * 2;
    this.pair[0] = this.buf[o];
    this.pair[1] = this.buf[o + 1];
    return this.pair;
  }

  async close() {
    await this.fh.close().catch(() => {});
  }
}

const EOI = Buffer.from([0xff, 0xd9]);

/**
 * A video decoded by ffmpeg, one frame every `step` media seconds from `start`, read in order, as JPEG pictures:
 * high quality, decoded natively by the browser, and a tenth of the raw pixels' size to hand over.
 */
class FrameDecoder {
  index = 0;
  private readonly proc: ChildProcess;
  private buf: Buffer = Buffer.alloc(0);
  private scanFrom = 0;
  private frames: Buffer[] = [];
  private last: Buffer | undefined;
  private ended = false;
  private error = '';
  private waiters: (() => void)[] = [];

  constructor(ffmpeg: string, file: string, readonly start: number, step: number, readonly w: number, readonly h: number) {
    this.proc = spawn(ffmpeg, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', Math.max(0, start).toFixed(6), '-i', file, '-an',
      '-vf', `fps=${(1 / step).toFixed(6)}:round=near,scale=${w}:${h}:flags=bicubic`,
      '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout!.on('data', (d: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      // Each picture ends with the EOI marker FF D9, which cannot occur inside JPEG data (FF bytes there are
      // followed by 00), and the encoder writes no embedded thumbnails.
      for (;;) {
        const end = this.buf.indexOf(EOI, this.scanFrom);
        if (end < 0) { this.scanFrom = Math.max(0, this.buf.length - 1); break; }
        this.frames.push(Buffer.from(this.buf.subarray(0, end + 2)));
        this.buf = this.buf.subarray(end + 2);
        this.scanFrom = 0;
      }
      if (this.frames.length > 8) this.proc.stdout!.pause();
      this.wake();
    });
    this.proc.stderr!.on('data', (d) => { this.error = (this.error + String(d)).slice(-2000); });
    this.proc.on('close', () => { this.ended = true; this.wake(); });
    this.proc.on('error', (e) => { this.error = e.message; this.ended = true; this.wake(); });
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Frame j (0 = at start); a request past the end of the video holds its last frame. */
  async frame(j: number): Promise<Buffer> {
    for (;;) {
      while (this.frames.length && this.index <= j) {
        this.last = this.frames.shift()!;
        this.index += 1;
        if (this.frames.length <= 4) this.proc.stdout?.resume();
      }
      if (this.index > j && this.last) return this.last;
      if (this.ended) {
        if (this.last) return this.last;
        throw new Error(this.error.trim().split('\n').pop() || 'no frames');
      }
      this.proc.stdout?.resume();
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  close() {
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
  }
}
