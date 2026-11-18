/**
 * The exporter's render worker (VX-1, VX-2, VX-9): renders an export plan to an
 * MP4 from the originals with ffmpeg.
 *
 * - Pictures: each run of frames from the shared plan (export-plan.ts) is one
 *   ffmpeg pass: the original, turned upright, cropped and scaled to the
 *   placement the preview uses, laid on black, faded with the preview's fade
 *   times, encoded as H.264. Runs are encoded in parallel, then joined without
 *   re-encoding.
 * - Sound: every source is decoded to PCM and mixed here in JavaScript with the
 *   shared mixAt() gains (volume, fades, ducking, mute and solo), the same
 *   model the preview plays, then normalised to -16 LUFS and encoded as AAC.
 *
 * Same project and settings in, same frames out: nothing depends on the clock.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  audioSources, buildTimeline, mixAt, planVideo, type AudioSource, type ExportSettings, type MediaItem, type MediaRun, type Run, type Size,
  type Timeline, type Travelogue, type VideoPlan,
} from '../core/index.js';
import type { BlobStore } from './blobstore.js';
import { probe } from './media.js';
import { jpegOrientation, orientationFilters } from './orientation.js';

const run = promisify(execFile);

export const AUDIO_RATE = 48_000;
/** VX-9: integrated loudness of the exported soundtrack. */
export const TARGET_LUFS = -16;

/** A failure tied to one item (VX-4): the UI names it and links to it. */
export class RenderError extends Error {
  constructor(message: string, readonly itemId?: string, readonly reason: 'missing' | 'unsupported' | 'failed' | 'cancelled' = 'failed') {
    super(message);
  }
}

export interface RenderInput {
  doc: Travelogue;
  settings: ExportSettings;
  /** Title card pictures drawn by the browser (the preview's own drawing), by segment index. */
  titleCards: Map<number, string>;
  outFile: string;
  workDir: string;
  signal: AbortSignal;
  /** 0..1, and a short note on the step. */
  onProgress: (fraction: number, step: string) => void;
}

export interface RenderOptions {
  ffmpeg: string;
  ffprobe: string;
  /** Parallel ffmpeg passes (default: half the CPU cores, 1–4). */
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

const nameOf = (m: MediaItem) => m.uri.split('/').pop() ?? m.id;

export class Renderer {
  constructor(private readonly blobs: BlobStore, private readonly o: RenderOptions) {}

  async render(input: RenderInput): Promise<RenderResult> {
    const { doc, settings, signal } = input;
    const tl = buildTimeline(doc);
    const items = new Map(doc.media.map((m) => [m.id, m]));
    const sizes = await this.uprightSizes(tl, items, signal);
    const plan = planVideo(tl, settings, (seg) => sizes.get(seg.item.id));
    if (!plan.totalFrames || !plan.runs.length) throw new RenderError('There is nothing to export in that part of the travelogue');
    await fs.mkdir(input.workDir, { recursive: true });

    // Weights for progress: pictures are most of the work.
    const W_VIDEO = 0.85, W_AUDIO = 0.1;
    let framesDone = 0;
    const report = (step: string) => input.onProgress(Math.min(0.999, W_VIDEO * (framesDone / plan.totalFrames)), step);
    report('Rendering pictures');

    const segFiles: string[] = new Array(plan.runs.length);
    const n = this.o.concurrency ?? Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
    let next = 0;
    const worker = async () => {
      while (next < plan.runs.length) {
        const i = next++;
        if (signal.aborted) return;
        const r = plan.runs[i];
        const file = path.join(input.workDir, `run-${String(i).padStart(5, '0')}.mp4`);
        await this.encodeRun(r, plan, items, sizes, input, file);
        segFiles[i] = file;
        framesDone += r.frames;
        report('Rendering pictures');
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, plan.runs.length) }, worker));
    this.checkAbort(signal);

    input.onProgress(W_VIDEO, 'Mixing sound');
    const audioFile = path.join(input.workDir, 'sound.m4a');
    const loudness = await this.renderAudio(tl, doc, plan, items, input, audioFile, (f) => input.onProgress(W_VIDEO + W_AUDIO * f, 'Mixing sound'));
    this.checkAbort(signal);

    input.onProgress(W_VIDEO + W_AUDIO, 'Writing the MP4');
    const list = path.join(input.workDir, 'runs.txt');
    await fs.writeFile(list, segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const tmpOut = `${input.outFile}.part.mp4`;
    await this.ff([
      '-f', 'concat', '-safe', '0', '-i', list, '-i', audioFile,
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', '-tag:v', 'avc1', tmpOut,
    ], signal);
    await fs.rename(tmpOut, input.outFile);
    input.onProgress(1, 'Done');
    return { frames: plan.totalFrames, durationSec: plan.totalFrames / plan.fps, loudnessLufs: loudness };
  }

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

  /** Upright size of every playing item: from the project, or probed from the original when the project lacks it. */
  private async uprightSizes(tl: Timeline, items: Map<string, MediaItem>, signal: AbortSignal): Promise<Map<string, Size>> {
    const out = new Map<string, Size>();
    for (const seg of tl.segments) {
      if (seg.kind === 'title') continue;
      const m = items.get(seg.item.id)!;
      if (m.width && m.height) {
        out.set(m.id, { w: m.width, h: m.height });
        continue;
      }
      this.checkAbort(signal);
      const file = await this.pictureFile(m);
      const pr = await probe(file, this.o.ffprobe).catch(() => undefined);
      if (pr?.width && pr.height) out.set(m.id, { w: pr.width, h: pr.height });
    }
    return out;
  }

  /** The file a picture is rendered from: the original (HEIC photos: their full-size JPEG). */
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

  private async encodeRun(r: Run, plan: VideoPlan, items: Map<string, MediaItem>, sizes: Map<string, Size>, input: RenderInput, out: string): Promise<void> {
    const { w: W, h: H } = plan.size;
    const fps = plan.fps;
    // Frame j of the run is at segment-local time localStart + j/fps: shift timestamps so the fades read local time.
    const fades = [
      `setpts=PTS-STARTPTS+${r.localStart.toFixed(6)}/TB`,
      r.fadeIn > 0 ? `fade=t=in:st=0:d=${r.fadeIn.toFixed(6)}` : '',
      r.fadeOut > 0 ? `fade=t=out:st=${(r.duration - r.fadeOut).toFixed(6)}:d=${r.fadeOut.toFixed(6)}` : '',
      'setpts=PTS-STARTPTS',
    ].filter(Boolean).join(',');
    const encode = [
      '-frames:v', String(r.frames), '-r', String(fps), '-an',
      '-c:v', 'libx264', '-preset', this.o.preset ?? 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-g', String(fps * 2), '-video_track_timescale', String(fps * 512),
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', out,
    ];
    if (r.kind === 'title') {
      const card = input.titleCards.get(r.segmentIndex);
      // Without the browser's drawing (an export started from a script), a plain card in the title's colours.
      const src = card ? ['-loop', '1', '-framerate', String(fps), '-i', card] : ['-f', 'lavfi', '-i', `color=c=0x16192f:s=${W}x${H}:r=${fps}`];
      await this.ff([...src, '-vf', `scale=${W}:${H},format=yuv420p,${fades},format=yuv420p`, ...encode], input.signal)
        .catch((e) => { throw this.wrap(e, undefined, `the title card of chapter ${r.chapterIndex + 1}`); });
      return;
    }
    const m = items.get(r.itemId)!;
    const file = await this.pictureFile(m);
    const place = this.placeFilter(r, sizes.get(m.id) ?? { w: r.src.x * 2 + r.src.w, h: r.src.y * 2 + r.src.h });
    try {
      if (r.kind === 'image') {
        const turn = orientationFilters(await jpegOrientation(file).catch(() => 1));
        await this.ff([
          '-noautorotate', '-loop', '1', '-framerate', String(fps), '-i', file,
          '-filter_complex', `color=c=black:s=${W}x${H}:r=${fps}[bg];[0:v]${[...turn, place.fg].join(',')}[fg];[bg][fg]overlay=${place.at}:format=auto,format=yuv420p,${fades},format=yuv420p[v]`,
          '-map', '[v]', ...encode,
        ], input.signal);
      } else {
        // Video: start at the run's media time, play at its speed, one frame per output frame (the last frame holds if it ends early).
        await this.ff([
          '-ss', r.mediaStart.toFixed(6), '-i', file,
          '-filter_complex', `color=c=black:s=${W}x${H}:r=${fps}[bg];[0:v]setpts=(PTS-STARTPTS)/${r.speed},fps=${fps},${place.fg}[fg];[bg][fg]overlay=${place.at}:format=auto:eof_action=repeat,format=yuv420p,${fades},format=yuv420p[v]`,
          '-map', '[v]', ...encode,
        ], input.signal);
      }
    } catch (e) {
      throw this.wrap(e, m);
    }
  }

  /**
   * Crop to the placement's source rectangle and scale to its destination, as the canvas drawImage does. The crop
   * is given as fractions of the picture, so it holds whatever size the decoded original turns out to be.
   */
  private placeFilter(r: MediaRun, size: Size): { fg: string; at: string } {
    const { src, dst } = r;
    const f = (v: number) => Math.max(0, Math.min(1, v)).toFixed(6);
    const fw = f(src.w / size.w), fh = f(src.h / size.h), fx = f(src.x / size.w), fy = f(src.y / size.h);
    const dw = Math.max(2, Math.round(dst.w)), dh = Math.max(2, Math.round(dst.h));
    return {
      fg: `crop=w='max(1,iw*${fw})':h='max(1,ih*${fh})':x='iw*${fx}':y='ih*${fy}',scale=${dw}:${dh}:flags=bicubic,setsar=1`,
      at: `${Math.round(dst.x)}:${Math.round(dst.y)}`,
    };
  }

  private wrap(e: unknown, m?: MediaItem, what?: string): RenderError {
    if (e instanceof RenderError) return e;
    const err = e as { stderr?: string; message?: string };
    const text = String(err.stderr ?? err.message ?? e);
    const last = text.trim().split('\n').filter((l) => l.trim()).slice(-1)[0] ?? 'ffmpeg failed';
    this.o.log?.(`export: ${m ? m.id : what}: ${text.slice(-2000)}`);
    const name = m ? nameOf(m) : what ?? 'a picture';
    if (/No such file|does not exist/i.test(text)) return new RenderError(`The original of ${name} is missing`, m?.id, 'missing');
    if (/Decoder .* not found|Invalid data found|could not find codec|Unsupported codec|unknown codec|no decoder/i.test(text)) {
      return new RenderError(`${name} uses a format TripAlogue cannot read (${last.trim().slice(0, 160)})`, m?.id, 'unsupported');
    }
    return new RenderError(`Could not render ${name}: ${last.trim().slice(0, 200)}`, m?.id, 'failed');
  }

  // ------------------------------------------------------------------ sound

  private async renderAudio(
    tl: Timeline, doc: Travelogue, plan: VideoPlan, items: Map<string, MediaItem>, input: RenderInput, out: string, progress: (f: number) => void,
  ): Promise<number | null> {
    const { signal } = input;
    const totalSamples = Math.round((plan.totalFrames / plan.fps) * AUDIO_RATE);
    const sources = audioSources(tl, plan.start, plan.start + plan.totalFrames / plan.fps);
    // Decode each source to 48 kHz stereo float PCM, already at timeline speed.
    const decoded = new Map<string, { src: AudioSource; file: string; samples: number }>();
    let k = 0;
    for (const src of sources) {
      this.checkAbort(signal);
      const m = items.get(src.itemId)!;
      const pcm = path.join(input.workDir, `pcm-${k++}.f32`);
      const ok = await this.decode(src, m, pcm, signal);
      if (ok) decoded.set(`${src.kind}:${src.itemId}`, { src, file: pcm, samples: ok });
      progress((0.4 * k) / Math.max(1, sources.length));
    }
    // Mix in blocks of one second, with every gain from the shared model every 10 ms (linear in between: no clicks).
    const mixFile = path.join(input.workDir, 'mix.f32');
    const fh = await fs.open(mixFile, 'w');
    const handles = new Map<string, fs.FileHandle>();
    try {
      for (const [key, d] of decoded) handles.set(key, await fs.open(d.file, 'r'));
      const BLOCK = AUDIO_RATE, STEP = AUDIO_RATE / 100;
      const outBuf = new Float32Array(BLOCK * 2);
      for (let b0 = 0; b0 < totalSamples; b0 += BLOCK) {
        this.checkAbort(signal);
        const len = Math.min(BLOCK, totalSamples - b0);
        outBuf.fill(0);
        // Gains at each 10 ms step of the block (and one past its end), per source.
        const steps = Math.ceil(len / STEP) + 1;
        const gains = new Map<string, Float32Array>();
        for (let s = 0; s < steps; s++) {
          const t = plan.start + (b0 + s * STEP) / AUDIO_RATE;
          for (const v of mixAt(tl, doc.audioLanes, t)) {
            const key = `${v.kind}:${v.itemId}`;
            if (!decoded.has(key)) continue;
            let g = gains.get(key);
            if (!g) gains.set(key, (g = new Float32Array(steps)));
            g[s] = v.gain;
          }
        }
        for (const [key, g] of gains) {
          const d = decoded.get(key)!;
          // Sample index in the decoded file: timeline time since the source starts.
          const first = Math.round((plan.start + b0 / AUDIO_RATE - d.src.start) * AUDIO_RATE);
          const from = Math.max(0, first);
          const to = Math.min(d.samples, first + len);
          if (to <= from) continue;
          const buf = Buffer.alloc((to - from) * 8);
          await handles.get(key)!.read(buf, 0, buf.length, from * 8);
          const pcm = new Float32Array(buf.buffer, buf.byteOffset, (to - from) * 2);
          for (let i = from; i < to; i++) {
            const j = i - first; // sample in this block
            const pos = j / STEP;
            const s = Math.floor(pos);
            const gain = g[s] + (g[Math.min(steps - 1, s + 1)] - g[s]) * (pos - s);
            if (gain === 0) continue;
            const p = (i - from) * 2;
            outBuf[j * 2] += pcm[p] * gain;
            outBuf[j * 2 + 1] += pcm[p + 1] * gain;
          }
        }
        await fh.write(Buffer.from(outBuf.buffer, 0, len * 8));
        progress(0.4 + (0.4 * (b0 + len)) / totalSamples);
      }
    } finally {
      await fh.close();
      for (const h of handles.values()) await h.close();
    }
    // VX-9: measure, then normalise to the target loudness in a second pass. Silence stays silent.
    const raw = ['-f', 'f32le', '-ar', String(AUDIO_RATE), '-ac', '2', '-i', mixFile];
    const target = `I=${TARGET_LUFS}:TP=-1.5:LRA=11`;
    const { stderr } = await this.ff([...raw, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'], signal);
    const m = /\{[\s\S]*"input_i"[\s\S]*\}/.exec(stderr);
    const meas = m ? (JSON.parse(m[0]) as Record<string, string>) : undefined;
    const inputI = Number(meas?.input_i);
    const audible = meas && Number.isFinite(inputI) && inputI > -70;
    const af = audible
      ? `loudnorm=${target}:measured_I=${meas.input_i}:measured_TP=${meas.input_tp}:measured_LRA=${meas.input_lra}:measured_thresh=${meas.input_thresh}:offset=${meas.target_offset}:linear=true,aresample=${AUDIO_RATE}`
      : 'anull';
    await this.ff([...raw, '-af', af, '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE), out], signal);
    progress(1);
    return audible ? TARGET_LUFS : null;
  }

  /** Decode a source's span to PCM at timeline speed; returns its length in samples, or 0 when it has no sound. */
  private async decode(src: AudioSource, m: MediaItem, out: string, signal: AbortSignal): Promise<number> {
    const file = await this.pictureFile(m); // a narration or music file that is gone is named like a picture
    if (src.kind === 'video') {
      const pr = await probe(file, this.o.ffprobe).catch(() => undefined);
      if (!pr?.hasAudio) return 0;
    }
    const dur = (src.end - src.start) * src.speed;
    const tempo = atempoChain(src.speed);
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
