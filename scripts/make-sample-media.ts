/**
 * Generates the synthetic media for samples/hand-written-20 with ffmpeg:
 * 16 stills in three shapes (landscape, portrait, panorama) and 4 short
 * clips with a test tone, each labelled so a viewer can tell what is playing.
 * The project file that references them is written by hand and committed.
 *
 *   npx tsx scripts/make-sample-media.ts [--force]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'samples/hand-written-20/media');
const force = process.argv.includes('--force');
mkdirSync(out, { recursive: true });

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
];
const font = FONT_CANDIDATES.find((f) => existsSync(f));
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019");

function label(text: string, sub: string, h: number): string {
  if (!font) return 'null';
  const f = `fontfile='${font.replace(/:/g, '\\:')}'`;
  const big = Math.round(h * 0.075);
  const small = Math.round(h * 0.04);
  return [
    `drawbox=x=0:y=ih*0.72:w=iw:h=ih*0.2:color=black@0.45:t=fill`,
    `drawtext=${f}:text='${esc(text)}':fontcolor=white:fontsize=${big}:x=(w-tw)/2:y=h*0.75`,
    `drawtext=${f}:text='${esc(sub)}':fontcolor=white@0.85:fontsize=${small}:x=(w-tw)/2:y=h*0.75+${Math.round(big * 1.35)}`,
  ].join(',');
}

type Still = { file: string; w: number; h: number; src: string; text: string; sub: string };
type Clip = { file: string; w: number; h: number; sec: number; src: string; hz: number; text: string; sub: string };

const L = [1600, 1200];
const P = [1080, 1440];
const W = [2400, 900];
const stills: Still[] = [
  ['ch1-01-alfama.jpg', L, 'testsrc2', 'Alfama rooftops', 'Lisbon · landscape 4:3'],
  ['ch1-02-tram28.jpg', P, 'smptehdbars', 'Tram 28', 'Lisbon · portrait 3:4'],
  ['ch1-03-belem.jpg', W, 'gradients=c0=0x2a6fdb:c1=0xf2b134', 'Belém waterfront', 'Lisbon · panorama 8:3'],
  ['ch1-04-pasteis.jpg', L, 'mandelbrot', 'Pastéis de nata', 'Lisbon · custom placement'],
  ['ch2-01-pena.jpg', L, 'gradients=c0=0xd9534f:c1=0xf0ad4e', 'Pena Palace', 'Sintra · landscape 4:3'],
  ['ch2-02-regaleira.jpg', P, 'cellauto=rule=110', 'Quinta da Regaleira well', 'Sintra · portrait 3:4'],
  ['ch2-03-moorish.jpg', W, 'testsrc2', 'Moorish Castle walls', 'Sintra · panorama 8:3'],
  ['ch2-04-cabo.jpg', L, 'gradients=c0=0x1b998b:c1=0x2d3047', 'Cabo da Roca', 'Sintra · fill placement'],
  ['ch3-01-ribeira.jpg', L, 'smptehdbars', 'Ribeira', 'Porto · landscape 4:3'],
  ['ch3-02-livraria.jpg', P, 'gradients=c0=0x6a4c93:c1=0xc77dff', 'Livraria Lello', 'Porto · portrait 3:4'],
  ['ch3-03-bridge.jpg', W, 'mandelbrot', 'Dom Luís I bridge', 'Porto · panorama 8:3'],
  ['ch3-04-port.jpg', L, 'testsrc2', 'Port lodge tasting', 'Porto · excluded from playback'],
  ['ch4-01-terraces.jpg', L, 'gradients=c0=0x55a630:c1=0xeeef20', 'Vineyard terraces', 'Douro · landscape 4:3'],
  ['ch4-02-pinhao.jpg', P, 'cellauto=rule=30', 'Pinhão station tiles', 'Douro · portrait 3:4'],
  ['ch4-03-river.jpg', W, 'gradients=c0=0x0077b6:c1=0x90e0ef', 'Douro river bend', 'Douro · panorama 8:3'],
  ['ch4-04-sunset.jpg', L, 'smptehdbars', 'Last sunset', 'Douro · cut transitions'],
].map(([file, [w, h], src, text, sub]) => ({ file, w, h, src, text, sub }) as Still);

const clips: Clip[] = [
  { file: 'ch1-05-fado.mp4', w: 1280, h: 720, sec: 6, src: 'testsrc2', hz: 440, text: 'Fado street singer', sub: 'Lisbon · video 6 s' },
  { file: 'ch2-05-forest.mp4', w: 720, h: 1280, sec: 5, src: 'gradients=c0=0x1b5e20:c1=0x8bc34a', hz: 523, text: 'Forest walk', sub: 'Sintra · portrait video 5 s' },
  { file: 'ch3-05-boat.mp4', w: 1280, h: 720, sec: 20, src: 'mandelbrot', hz: 330, text: 'Rabelo boat ride', sub: 'Porto · 20 s clip, played in full' },
  { file: 'ch4-05-train.mp4', w: 1280, h: 720, sec: 12, src: 'testsrc2', hz: 392, text: 'Train along the river', sub: 'Douro · 2x speed from 2 s' },
];

const lavfi = (src: string, opts: string) => `${src}${src.includes('=') ? ':' : '='}${opts}`;
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

for (const s of stills) {
  const dest = path.join(out, s.file);
  if (existsSync(dest) && !force) continue;
  ff(['-f', 'lavfi', '-i', lavfi(s.src, `size=${s.w}x${s.h}:rate=1`), '-vf', label(s.text, s.sub, s.h), '-frames:v', '1', '-q:v', '4', dest]);
  console.log(`still ${s.file}`);
}
for (const c of clips) {
  const dest = path.join(out, c.file);
  if (existsSync(dest) && !force) continue;
  const timer = font ? `,drawtext=fontfile='${font}':text='%{pts\\:hms}':fontcolor=white:fontsize=${Math.round(c.h * 0.05)}:x=20:y=20:box=1:boxcolor=black@0.5` : '';
  ff([
    '-f', 'lavfi', '-i', lavfi(c.src, `size=${c.w}x${c.h}:rate=30`),
    '-f', 'lavfi', '-i', `sine=frequency=${c.hz}:sample_rate=48000`,
    '-t', String(c.sec), '-vf', label(c.text, c.sub, c.h) + timer,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-g', '30',
    '-c:a', 'aac', '-b:a', '64k', '-af', 'volume=0.15', '-movflags', '+faststart', '-shortest', dest,
  ]);
  console.log(`clip  ${c.file}`);
}
console.log(`Sample media in ${path.relative(root, out)}`);
