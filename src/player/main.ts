/**
 * Player page bootstrap: loads the project from the local server, wires the
 * controls, and exposes `window.tripalogue` for automated playback tests.
 *
 * URL parameters:
 *   rate=N        playback-rate multiplier (tests)
 *   original=1    use original media even when cache proxies exist
 *   telemetry=1   opt in to session telemetry (only if the server enables it)
 *   autoplay=1    start playing on load (muted, per browser autoplay rules)
 */
import { parseProject } from '../core/project.js';
import { Telemetry, type TelemetryEvent } from '../core/telemetry.js';
import { Player, type PlayerState } from './player.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

declare global {
  interface Window {
    tripalogue?: { player: Player; telemetry: Telemetry; state: () => PlayerState };
  }
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

function setStatus(s: PlayerState, msg = '') {
  document.body.dataset.state = s;
  $('status').textContent = msg;
}

async function boot() {
  setStatus('loading', 'Loading project…');
  const [projRes, cacheRes, cfgRes] = await Promise.all([fetch('api/project'), fetch('api/cache-manifest'), fetch('api/config')]);
  if (!projRes.ok) throw new Error(`Could not load the project (${projRes.status})`);
  const { project, warnings } = parseProject(await projRes.text());
  const cache = cacheRes.ok ? ((await cacheRes.json()) as { available: boolean; items: Record<string, { proxy: boolean }> }) : { available: false, items: {} };
  const cfg = cfgRes.ok ? ((await cfgRes.json()) as { telemetryEndpoint: string | null }) : { telemetryEndpoint: null };
  const useProxies = cache.available && params.get('original') !== '1';

  // Telemetry: off unless the user opted in via ?telemetry=1 AND the server enabled the endpoint.
  const telemetry = new Telemetry();
  const queue: TelemetryEvent[] = [];
  if (params.get('telemetry') === '1' && cfg.telemetryEndpoint) {
    telemetry.setEnabled(true);
    telemetry.addSink((e) => queue.push(e));
    const flush = () => {
      if (!queue.length) return;
      const body = JSON.stringify(queue.splice(0));
      navigator.sendBeacon?.(cfg.telemetryEndpoint!, new Blob([body], { type: 'application/json' })) ||
        void fetch(cfg.telemetryEndpoint!, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    };
    setInterval(flush, 5000);
    addEventListener('pagehide', flush);
    $('telemetry-badge').hidden = false;
  }

  document.title = `${project.title} — TripAlogue`;
  $('title').textContent = project.title;
  const canvas = $<HTMLCanvasElement>('stage');
  const stageWrap = $('stage-wrap');
  stageWrap.style.aspectRatio = `${project.output.width} / ${project.output.height}`;

  const player = new Player({
    canvas,
    project,
    rate: Number(params.get('rate') ?? 1) || 1,
    urlFor: (id) => (useProxies && cache.items[id]?.proxy ? `api/cache/${encodeURIComponent(id)}/proxy` : `api/media/${encodeURIComponent(id)}`),
    onState: (s) => {
      setStatus(s, s === 'ended' ? 'End of travelogue' : '');
      $('play').textContent = s === 'playing' ? 'Pause' : s === 'ended' ? 'Replay' : 'Play';
      $('play').setAttribute('aria-label', s === 'playing' ? 'Pause' : 'Play');
    },
    onTime: (t, frame) => {
      const scrub = $<HTMLInputElement>('scrub');
      if (document.activeElement !== scrub) scrub.value = String(t);
      $('time').textContent = `${fmt(t)} / ${fmt(player.duration)}`;
      const ch = player.timeline.chapters[frame.chapterIndex];
      $('chapter').textContent = ch ? `${ch.index + 1}. ${ch.title}` : '';
      document.querySelectorAll<HTMLElement>('.chapter-mark').forEach((el) => el.classList.toggle('current', Number(el.dataset.index) === frame.chapterIndex));
    },
    onEvent: (name, props) => telemetry.track(`player_${name}`, props ?? {}),
  });

  // Canvas backing store follows its on-screen size (capped at the output resolution).
  const fit = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.max(2, Math.round(Math.min(project.output.width, r.width * dpr)));
    canvas.height = Math.max(2, Math.round(Math.min(project.output.height, r.height * dpr)));
    player.redraw();
  };
  new ResizeObserver(fit).observe(canvas);
  fit();

  // Controls.
  const scrub = $<HTMLInputElement>('scrub');
  scrub.max = String(player.duration);
  scrub.step = '0.01';
  scrub.addEventListener('input', () => player.seek(Number(scrub.value)));
  $('play').addEventListener('click', () => player.toggle());
  $('prev').addEventListener('click', () => player.seekChapter(-1));
  $('next').addEventListener('click', () => player.seekChapter(1));
  const mute = $<HTMLButtonElement>('mute');
  mute.addEventListener('click', () => {
    const m = mute.getAttribute('aria-pressed') !== 'true';
    mute.setAttribute('aria-pressed', String(m));
    mute.textContent = m ? 'Unmute' : 'Mute';
    player.setMuted(m);
  });
  canvas.addEventListener('click', () => player.toggle());
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' && e.key !== ' ') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'ArrowLeft') player.seek(player.time - 5);
    else if (e.key === 'ArrowRight') player.seek(player.time + 5);
    else if (e.key === 'Home') player.seek(0);
    else if (e.key === 'End') player.seek(player.duration);
    else if (e.key === '[') player.seekChapter(-1);
    else if (e.key === ']') player.seekChapter(1);
  });

  // Chapter markers on the scrub bar and in the chapter list.
  const marks = $('marks');
  const list = $('chapters');
  for (const c of player.timeline.chapters) {
    const m = document.createElement('button');
    m.className = 'chapter-mark';
    m.dataset.index = String(c.index);
    m.style.left = `${(c.start / player.duration) * 100}%`;
    m.title = `${c.index + 1}. ${c.title}`;
    m.setAttribute('aria-label', `Go to chapter ${c.index + 1}: ${c.title}`);
    m.addEventListener('click', () => player.seek(c.start));
    marks.append(m);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'chapter-mark';
    b.dataset.index = String(c.index);
    b.textContent = `${c.index + 1}. ${c.title}  ·  ${fmt(c.start)}`;
    b.addEventListener('click', () => player.seek(c.start));
    li.append(b);
    list.append(li);
  }
  const playing = player.timeline.segments.filter((s) => s.kind !== 'title').length;
  const visual = project.media.filter((m) => m.kind !== 'audio').length;
  $('meta').textContent = `${project.chapters.length} chapters · ${playing === visual ? `${playing} items` : `${playing} of ${visual} items playing`} · ${fmt(player.duration)}` +
    (useProxies ? ' · proxies' : '') + (warnings.length ? ` · ${warnings.length} warning(s)` : '') +
    (player.timeline.skipped.length ? ` · ${player.timeline.skipped.length} skipped` : '');

  window.tripalogue = { player, telemetry, state: () => player.state };
  if (params.get('autoplay') === '1') {
    player.setMuted(true);
    mute.setAttribute('aria-pressed', 'true');
    mute.textContent = 'Unmute';
    player.play();
  }
}

boot().catch((e) => {
  console.error(e);
  setStatus('error', (e as Error).message);
});
