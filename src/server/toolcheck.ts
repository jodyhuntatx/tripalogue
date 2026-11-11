/**
 * Startup check of the media tools. Media processing needs ffmpeg and ffprobe
 * with a handful of codecs; a missing or cut-down install used to show up only
 * as failed uploads. The server checks once at startup (and again before a
 * "Retry processing"), logs plain-language problems, and the web app shows
 * them in the Upload tab.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface MediaToolStatus {
  ok: boolean;
  /** ffmpeg version string, when found. */
  ffmpeg?: string;
  /** Plain-language problems, empty when everything is in place. */
  problems: string[];
  checkedAt: string;
}

const INSTALL = 'See "Installing ffmpeg" in the README, then press Check again (restart the server if it is still not found).';

async function output(cmd: string, args: string[]): Promise<string | { missing: true } | { error: string }> {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 15_000, maxBuffer: 8 << 20 });
    return stdout + stderr;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') return { missing: true };
    return { error: (err.stderr || err.message || String(e)).split('\n')[0] };
  }
}

/** Codec names in `ffmpeg -decoders` / `-encoders` output (the second column). */
function codecNames(list: string): Set<string> {
  const names = new Set<string>();
  for (const line of list.split('\n')) {
    const m = /^\s*[VAS.][A-Z.]{5}\s+(\S+)/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

export async function checkMediaTools(ffmpeg = 'ffmpeg', ffprobe = 'ffprobe'): Promise<MediaToolStatus> {
  const problems: string[] = [];
  const checkedAt = new Date().toISOString();
  const ver = await output(ffmpeg, ['-hide_banner', '-version']);
  const probeVer = await output(ffprobe, ['-hide_banner', '-version']);
  if (typeof probeVer !== 'string') {
    problems.push('missing' in probeVer
      ? `ffprobe was not found (looked for "${ffprobe}"), so uploaded photos and videos cannot be processed. ${INSTALL}`
      : `ffprobe did not run: ${probeVer.error}. ${INSTALL}`);
  }
  if (typeof ver !== 'string') {
    problems.push('missing' in ver
      ? `ffmpeg was not found (looked for "${ffmpeg}"), so thumbnails and previews cannot be made. ${INSTALL}`
      : `ffmpeg did not run: ${ver.error}. ${INSTALL}`);
    return { ok: false, problems, checkedAt };
  }
  const version = /ffmpeg version (\S+)/.exec(ver)?.[1];
  const dec = await output(ffmpeg, ['-hide_banner', '-decoders']);
  const enc = await output(ffmpeg, ['-hide_banner', '-encoders']);
  if (typeof dec === 'string' && typeof enc === 'string') {
    const d = codecNames(dec);
    const e = codecNames(enc);
    const need: [Set<string>, string, string][] = [
      [d, 'h264', 'cannot read most phone and camera videos (H.264)'],
      [d, 'hevc', 'cannot read HEVC videos or HEIC photos'],
      [d, 'mjpeg', 'cannot read JPEG photos'],
      [e, 'libx264', 'cannot make video previews (needs the libx264 encoder)'],
      [e, 'aac', 'cannot make video preview sound (needs the AAC encoder)'],
      [e, 'mjpeg', 'cannot make thumbnails (needs the JPEG encoder)'],
    ];
    const missing = need.filter(([set, name]) => !set.has(name));
    for (const [, , why] of missing) problems.push(`This ffmpeg ${why}. Install a full ffmpeg build. ${INSTALL}`);
  } else {
    problems.push('Could not list the codecs in this ffmpeg build.');
  }
  return { ok: problems.length === 0, ffmpeg: version, problems, checkedAt };
}

/** Caches the latest check; `recheck()` runs it again (for example after the user installs ffmpeg). */
export class MediaTools {
  private current?: Promise<MediaToolStatus>;
  /** `o` is read on every check, so a changed configuration is picked up by `recheck()`. */
  constructor(private readonly o: { ffmpeg: string; ffprobe: string; log?: (m: string) => void }) {}

  status(): Promise<MediaToolStatus> {
    this.current ??= this.run();
    return this.current;
  }

  recheck(): Promise<MediaToolStatus> {
    this.current = this.run();
    return this.current;
  }

  private async run(): Promise<MediaToolStatus> {
    const s = await checkMediaTools(this.o.ffmpeg, this.o.ffprobe);
    if (s.ok) this.o.log?.(`media tools: ffmpeg ${s.ffmpeg ?? '(version unknown)'} has everything processing needs`);
    else for (const p of s.problems) this.o.log?.(`media tools: ${p}`);
    return s;
  }
}
