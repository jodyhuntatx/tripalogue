/**
 * TripAlogue web client (Phase 0 shell): sign-in, projects, import and
 * upload, the player, a few edits (title, include, order) with undo/redo and
 * autosave, members and invitations, and version history.
 *
 * Routes: #/signin · #/projects · #/p/<projectId>
 */
import { effectiveInstant, moveItem, parseProject, setIncluded, setTitle, Telemetry, type TelemetryEvent, type Travelogue } from '../core/index.js';
import { Player, type PlayerState } from '../player/player.js';
import { Api, ApiError, type MediaToolStatus, type Role, type User } from './api.js';
import { mountInset, type InsetView } from './inset.js';
import { mountItinerary, type ItineraryView } from './itinerary.js';
import { ProjectSession } from './session.js';
import { uploadAll, type UploadProgress } from './uploader.js';

declare global {
  interface Window {
    tripalogue?: { player?: Player; session?: ProjectSession; itinerary?: ItineraryView; inset?: InsetView; state?: () => PlayerState | undefined; telemetry: Telemetry };
  }
}

type Child = Node | string | false | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false || v === null) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== false && c !== null && c !== undefined) el.append(c);
  return el;
}

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};

const telemetry = new Telemetry();
window.tripalogue = { telemetry };
let me: User | undefined;
type View = 'itinerary' | 'play';
let current: { id: string; session: ProjectSession; player: Player; setView: (v: View) => void; dispose: () => void } | undefined;

function setTelemetry(endpoint: string | null) {
  if (params.get('telemetry') !== '1' || !endpoint) return;
  telemetry.setEnabled(true);
  const queue: TelemetryEvent[] = [];
  telemetry.addSink((e) => queue.push(e));
  const flush = () => {
    if (!queue.length) return;
    void fetch(endpoint, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-TripAlogue-Client': '1' }, body: JSON.stringify(queue.splice(0)) });
  };
  setInterval(flush, 5000);
  addEventListener('pagehide', flush);
}

function banner(text: string, kind: 'info' | 'error' = 'info') {
  return h('div', { class: `banner ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
}

async function route() {
  const hash = location.hash || '#/projects';
  const pm = /^#\/p\/([^/?]+)(?:\/(itinerary|play))?/.exec(hash);
  // Switching views inside the open project keeps the session (and its edit lock) alive.
  if (current && pm && decodeURIComponent(pm[1]) === current.id) return current.setView((pm[2] as View) ?? 'play');
  if (current) {
    current.dispose();
    current = undefined;
  }
  if (!me) {
    try {
      me = (await Api.me()).user ?? undefined;
    } catch {
      me = undefined;
    }
  }
  if (!me || hash.startsWith('#/signin')) return renderSignIn();
  if (pm) return renderProject(decodeURIComponent(pm[1]), pm[2] as View | undefined);
  return renderProjects();
}

// ---------------- sign in ----------------

async function renderSignIn() {
  if (me) {
    location.hash = '#/projects';
    return;
  }
  document.title = 'Sign in — TripAlogue';
  const cfg = await Api.config().catch(() => ({ google: false }));
  const next = params.get('next') ?? '/';
  const email = h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com', 'aria-label': 'Email address' });
  const msg = h('div', { class: 'form-msg', role: 'status' });
  const form = h('form', {
    class: 'card signin',
    onsubmit: async (e: Event) => {
      e.preventDefault();
      msg.textContent = 'Sending…';
      try {
        await Api.requestLink(email.value, next);
        form.replaceChildren(h('h1', {}, 'Check your email'), h('p', {}, `We sent a sign-in link to ${email.value}. It works once and expires in 15 minutes.`));
      } catch (err) {
        msg.textContent = (err as Error).message;
      }
    },
  },
  h('h1', {}, 'TripAlogue'),
  h('p', { class: 'muted' }, 'Sign in with a link sent to your email. No password needed.'),
  params.get('error') && banner(params.get('error')!, 'error'),
  email,
  h('button', { type: 'submit', class: 'primary' }, 'Email me a sign-in link'),
  cfg.google && h('a', { class: 'button', href: `/api/auth/google/start?next=${encodeURIComponent(next)}` }, 'Sign in with Google'),
  msg);
  app.replaceChildren(form);
  email.focus();
}

// ---------------- projects ----------------

function topbar(...extra: Child[]) {
  return h('header', { class: 'topbar' },
    h('a', { href: '#/projects', class: 'brand' }, 'TripAlogue'),
    ...extra,
    h('span', { class: 'spacer' }),
    me && h('span', { class: 'muted' }, me.email),
    h('button', { onclick: async () => { await Api.logout(); me = undefined; location.hash = '#/signin'; } }, 'Sign out'));
}

async function renderProjects() {
  document.title = 'Travelogues — TripAlogue';
  const { projects } = await Api.projects();
  const title = h('input', { placeholder: 'Trip name', 'aria-label': 'New travelogue name', required: true });
  const jsonInput = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Project file', id: 'import-json' });
  const mediaInput = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*,audio/*', 'aria-label': 'Media files', id: 'import-media' });
  const folderInput = h('input', { type: 'file', multiple: true, 'aria-label': 'Media folder', id: 'import-folder' });
  folderInput.setAttribute('webkitdirectory', '');
  const progress = h('div', { class: 'progress-list', id: 'import-progress' });
  const importMsg = h('div', { class: 'form-msg', role: 'status' });

  app.replaceChildren(
    topbar(),
    h('main', { class: 'page' },
      h('section', { class: 'card' },
        h('h2', {}, 'Your travelogues'),
        projects.length
          ? h('ul', { class: 'project-list' }, ...projects.map((p) => h('li', {},
            h('a', { href: `#/p/${encodeURIComponent(p.id)}` }, p.title),
            h('span', { class: 'muted' }, ` · ${p.items} items · ${p.role} · updated ${ago(p.updatedAt)}`))))
          : h('p', { class: 'muted' }, 'None yet. Start one below, or import a project file.')),
      h('section', { class: 'card' },
        h('h2', {}, 'New travelogue'),
        h('form', { class: 'row', onsubmit: async (e: Event) => { e.preventDefault(); const r = await Api.createProject(title.value); location.hash = `#/p/${r.id}`; } },
          title, h('button', { type: 'submit', class: 'primary' }, 'Create'))),
      h('section', { class: 'card' },
        h('h2', {}, 'Import a project file'),
        h('p', { class: 'muted' }, 'Choose a .travelogue.json file and the photos and videos it refers to (files or a whole folder). Originals are uploaded unaltered.'),
        h('label', {}, 'Project file ', jsonInput),
        h('label', {}, 'Media files ', mediaInput),
        h('label', {}, 'or a media folder ', folderInput),
        h('button', { class: 'primary', id: 'import-start', onclick: () => void startImport() }, 'Import and upload'),
        importMsg, progress)));

  async function startImport() {
    const json = jsonInput.files?.[0];
    if (!json) return void (importMsg.textContent = 'Choose a project file first.');
    const files = [...(mediaInput.files ?? []), ...(folderInput.files ?? [])];
    const text = await json.text();
    try {
      parseProject(text);
    } catch (e) {
      return void (importMsg.textContent = (e as Error).message);
    }
    importMsg.textContent = 'Creating project…';
    const r = await Api.importProject(text).catch((e: Error) => { importMsg.textContent = e.message; return undefined; });
    if (!r) return;
    const byName = new Map(files.map((f) => [f.name, f]));
    const jobs = r.pending.flatMap((p) => {
      const f = byName.get(p.uri.split('/').pop()!);
      return f ? [{ file: f, mediaId: p.mediaId }] : [];
    });
    const missing = r.pending.length - jobs.length;
    importMsg.textContent = `Uploading ${jobs.length} of ${r.pending.length} files${missing ? ` (${missing} not chosen; you can upload them later from the project)` : ''}…`;
    const done = await uploadAll(r.id, jobs, (all) => renderProgress(progress, all));
    const failed = done.filter((d) => d.state === 'failed').length;
    importMsg.textContent = failed ? `${failed} uploads failed; open the project to retry.` : 'Upload finished. Processing continues in the background.';
    location.hash = `#/p/${r.id}`;
  }
}

function renderProgress(el: HTMLElement, all: UploadProgress[]) {
  const total = all.reduce((a, p) => a + p.total, 0);
  const sent = all.reduce((a, p) => a + p.sent, 0);
  const done = all.filter((p) => p.state === 'done').length;
  el.replaceChildren(
    h('div', { class: 'muted', id: 'upload-summary' }, `${done} of ${all.length} files · ${mb(sent)} of ${mb(total)}`),
    h('progress', { max: total || 1, value: sent }),
    ...all.filter((p) => p.state === 'failed' || p.state === 'retrying').map((p) => h('div', { class: p.state === 'failed' ? 'error' : 'muted' }, `${p.file.name}: ${p.state === 'failed' ? p.error : 'retrying…'}`)),
  );
}

// ---------------- project ----------------

async function renderProject(id: string, initialView?: View) {
  let session: ProjectSession;
  try {
    session = await ProjectSession.open(id);
  } catch (e) {
    app.replaceChildren(topbar(), h('main', { class: 'page' }, banner((e as ApiError).message, 'error'), h('a', { href: '#/projects' }, 'Back to your travelogues')));
    return;
  }
  const s = session;
  const canvas = h('canvas', { id: 'stage', 'aria-label': 'Travelogue playback' });
  const stageWrap = h('div', { id: 'stage-wrap' }, canvas);
  const playBtn = h('button', { id: 'play', class: 'primary', 'aria-label': 'Play' }, 'Play');
  const scrub = h('input', { id: 'scrub', type: 'range', min: '0', value: '0', step: '0.01', 'aria-label': 'Playback position' });
  const marks = h('div', { id: 'marks' });
  const time = h('span', { id: 'time' }, '0:00 / 0:00');
  const muteBtn = h('button', { id: 'mute', 'aria-pressed': 'false' }, 'Mute');
  const chapterLabel = h('div', { id: 'chapter', class: 'muted' });
  const statusChip = h('span', { id: 'save-status', class: 'chip', role: 'status', 'aria-live': 'polite' });
  const titleInput = h('input', { id: 'title', class: 'title-input', 'aria-label': 'Travelogue title', value: s.state.title });
  const undoBtn = h('button', { id: 'undo', onclick: () => s.undo() }, 'Undo');
  const redoBtn = h('button', { id: 'redo', onclick: () => s.redo() }, 'Redo');
  const meta = h('div', { id: 'meta', class: 'muted' });
  const side = h('div', { class: 'side-body' });
  const tabs = ['Items', 'Upload', 'Members', 'Versions'] as const;
  let tab: (typeof tabs)[number] = 'Items';
  const tabBar = h('div', { class: 'tabs', role: 'tablist' }, ...tabs.map((t) => h('button', { role: 'tab', 'data-tab': t, onclick: () => { tab = t; renderSide(); } }, t)));

  titleInput.addEventListener('input', () => s.edit('Rename travelogue', (p) => setTitle(p, titleInput.value), { coalesceKey: 'title' }));
  const exportLink = h('a', { class: 'button', href: `/api/projects/${encodeURIComponent(id)}/export`, download: '' }, 'Export file');

  let view: View = initialView ?? (s.state.chapters.length === 0 || s.state.media.length === 0 ? 'itinerary' : 'play');
  const viewTabs = h('nav', { class: 'view-tabs', 'aria-label': 'Views' },
    h('a', { href: `#/p/${encodeURIComponent(id)}/itinerary`, 'data-view': 'itinerary', id: 'view-itinerary' }, 'Itinerary'),
    h('a', { href: `#/p/${encodeURIComponent(id)}/play`, 'data-view': 'play', id: 'view-play' }, 'Play'));
  const cfg = await Api.config().catch(() => ({ map: { tiles: false, search: false, attribution: '' }, media: undefined as MediaToolStatus | undefined }));
  let mediaTools: MediaToolStatus | undefined = cfg.media;
  // Process failed items again from their stored originals (all of them, or the ids given).
  const retry = async (ids?: string[]) => {
    try {
      const r = await Api.retryMedia(id, ids);
      mediaTools = r.media;
      void s.poll();
    } catch (e) {
      alert((e as ApiError).message);
    }
    renderSide();
  };
  const itinerary = mountItinerary(s, {
    map: cfg.map,
    preview: (chapterId) => {
      location.hash = `#/p/${encodeURIComponent(id)}/play`;
      const ch = player.timeline.chapters.find((c) => c.chapterId === chapterId);
      player.seek(ch?.start ?? 0);
      player.play();
    },
  });
  const inset = mountInset(s, stageWrap, cfg.map);
  const playMain = h('main', { class: 'project' },
      h('section', {},
        stageWrap,
        h('div', { class: 'controls' },
          h('button', { id: 'prev', 'aria-label': 'Previous chapter', onclick: () => player.seekChapter(-1) }, '⏮'),
          playBtn,
          h('button', { id: 'next', 'aria-label': 'Next chapter', onclick: () => player.seekChapter(1) }, '⏭'),
          h('div', { class: 'scrub-wrap' }, scrub, marks),
          time, muteBtn, inset.settings),
        chapterLabel, meta),
      h('aside', { class: 'side card', id: 'side-panel' }, tabBar, side));

  // The side panel (Items, Upload, Members, Versions) folds away so playback can use the whole width.
  // Remembered per browser; storage can be unavailable, so it is best effort.
  const PANEL_KEY = 'tripalogue.panelCollapsed';
  const panelBtn = h('button', { id: 'toggle-panel', 'aria-controls': 'side-panel', title: 'Show or hide the side panel (P)' });
  const setPanel = (collapsed: boolean, remember = true) => {
    playMain.classList.toggle('panel-collapsed', collapsed);
    panelBtn.setAttribute('aria-expanded', String(!collapsed));
    panelBtn.textContent = collapsed ? 'Show panel' : 'Hide panel';
    if (remember) try { localStorage.setItem(PANEL_KEY, collapsed ? '1' : '0'); } catch { /* not remembered */ }
  };
  panelBtn.addEventListener('click', () => setPanel(!playMain.classList.contains('panel-collapsed')));
  let startCollapsed = false;
  try { startCollapsed = localStorage.getItem(PANEL_KEY) === '1'; } catch { /* default: shown */ }
  setPanel(startCollapsed, false);
  playMain.querySelector('.controls')!.append(panelBtn);
  app.replaceChildren(topbar(viewTabs, titleInput, statusChip, undoBtn, redoBtn, s.mayEdit && exportLink), itinerary.el, playMain);

  function setView(v: View) {
    view = v;
    itinerary.el.hidden = v !== 'itinerary';
    playMain.hidden = v !== 'play';
    viewTabs.querySelectorAll<HTMLElement>('a').forEach((a) => (a.dataset.view === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    if (v !== 'play') player.pause();
    else player.redraw();
    const want = `#/p/${encodeURIComponent(id)}/${v}`;
    if (location.hash !== want) history.replaceState(null, '', want);
  }

  const urlFor = (itemId: string) => Api.mediaUrl(id, itemId, 'proxy');
  const player = new Player({
    canvas, project: s.state, urlFor, rate: Number(params.get('rate') ?? 1) || 1,
    onState: (st) => {
      document.body.dataset.state = st;
      playBtn.textContent = st === 'playing' ? 'Pause' : st === 'ended' ? 'Replay' : 'Play';
    },
    onTime: (t, frame) => {
      if (document.activeElement !== scrub) scrub.value = String(t);
      time.textContent = `${fmt(t)} / ${fmt(player.duration)}`;
      const ch = player.timeline.chapters[frame.chapterIndex];
      chapterLabel.textContent = ch ? `${ch.index + 1}. ${ch.title}` : '';
      marks.querySelectorAll<HTMLElement>('.chapter-mark').forEach((el) => el.classList.toggle('current', Number(el.dataset.index) === frame.chapterIndex));
      inset.onFrame(frame, player.timeline);
    },
    onEvent: (name, props) => telemetry.track(`player_${name}`, props ?? {}),
  });
  document.body.dataset.state = player.state;
  stageWrap.style.aspectRatio = `${s.state.output.width} / ${s.state.output.height}`;
  // Keep the frame's shape when the window is wider than the available height allows.
  stageWrap.style.maxWidth = `calc((100vh - 190px) * ${s.state.output.width / s.state.output.height})`;
  const fit = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.max(2, Math.round(Math.min(s.state.output.width, r.width * dpr)));
    canvas.height = Math.max(2, Math.round(Math.min(s.state.output.height, r.height * dpr)));
    player.redraw();
  };
  const ro = new ResizeObserver(fit);
  ro.observe(canvas);
  fit();

  playBtn.addEventListener('click', () => player.toggle());
  canvas.addEventListener('click', () => player.toggle());
  scrub.addEventListener('input', () => player.seek(Number(scrub.value)));
  muteBtn.addEventListener('click', () => {
    const m = muteBtn.getAttribute('aria-pressed') !== 'true';
    muteBtn.setAttribute('aria-pressed', String(m));
    muteBtn.textContent = m ? 'Unmute' : 'Mute';
    player.setMuted(m);
  });
  const onKey = (e: KeyboardEvent) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      if (e.shiftKey) s.redo(); else s.undo();
      return;
    }
    if (typing || view !== 'play') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'ArrowLeft') player.seek(player.time - 5);
    else if (e.key === 'ArrowRight') player.seek(player.time + 5);
    else if (e.key === 'Home') player.seek(0);
    else if (e.key === 'End') player.seek(player.duration);
    else if (e.key === '[') player.seekChapter(-1);
    else if (e.key === ']') player.seekChapter(1);
    else if (e.key.toLowerCase() === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey) panelBtn.click();
  };
  addEventListener('keydown', onKey);
  const onHide = () => {
    s.flushOnExit();
    void s.close();
  };
  addEventListener('pagehide', onHide);

  let lastProject: Travelogue = s.state;
  let refresh = 0;
  const unsub = s.subscribe(() => {
    clearTimeout(refresh);
    refresh = window.setTimeout(update, 120);
  });

  function renderMarks() {
    marks.replaceChildren(...player.timeline.chapters.map((c) => {
      const b = h('button', { class: 'chapter-mark', 'data-index': String(c.index), title: `${c.index + 1}. ${c.title}`, 'aria-label': `Go to chapter ${c.index + 1}: ${c.title}`, onclick: () => player.seek(c.start) });
      b.style.left = `${player.duration ? (c.start / player.duration) * 100 : 0}%`;
      return b;
    }));
  }

  function update() {
    const p = s.state;
    if (p !== lastProject) {
      player.setProject(p);
      lastProject = p;
    }
    scrub.max = String(player.duration);
    if (document.activeElement !== titleInput && titleInput.value !== p.title) titleInput.value = p.title;
    titleInput.readOnly = !s.canEdit;
    document.title = `${p.title} — TripAlogue`;
    undoBtn.disabled = !s.canEdit || !s.history.canUndo;
    redoBtn.disabled = !s.canEdit || !s.history.canRedo;
    undoBtn.title = s.history.undoLabel ? `Undo ${s.history.undoLabel}` : '';
    redoBtn.title = s.history.redoLabel ? `Redo ${s.history.redoLabel}` : '';
    const label: Record<string, string> = { saved: 'All changes saved', saving: 'Saving…', offline: 'Offline', readonly: s.mayEdit ? `${s.lock?.name ?? 'Someone'} is editing` : `View only (${s.role})`, error: 'Not saved' };
    statusChip.textContent = label[s.status];
    statusChip.dataset.status = s.status;
    statusChip.title = s.message;
    const playing = player.timeline.segments.filter((x) => x.kind !== 'title').length;
    const visual = p.media.filter((m) => m.kind !== 'audio').length;
    const ready = p.media.filter((m) => !m.status || m.status === 'ready').length;
    meta.textContent = `${p.chapters.length} chapters · ${playing === visual ? `${playing} items` : `${playing} of ${visual} items playing`} · ${fmt(player.duration)}` +
      (ready < p.media.length ? ` · ${ready} of ${p.media.length} media ready${s.pendingJobs ? ` (processing ${s.pendingJobs})` : ''}` : '');
    meta.dataset.ready = String(ready);
    meta.dataset.total = String(p.media.length);
    renderMarks();
    if (tab === 'Items' || tab === 'Upload') renderSide();
    itinerary.update();
    inset.update(p);
  }

  // ---- side panel ----
  const uploadProgress = h('div', { class: 'progress-list', id: 'upload-progress' });
  let uploads: UploadProgress[] = [];

  function renderSide() {
    tabBar.querySelectorAll<HTMLElement>('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (tab === 'Items') return renderItems();
    if (tab === 'Upload') return renderUpload();
    if (tab === 'Members') return void renderMembers();
    return void renderVersions();
  }

  /** An item's time as the trip saw it: local time in its chapter's zone (or the first chapter's for Unassigned). */
  function itemTime(p: Travelogue, m: Travelogue['media'][number]): string {
    const ch = p.chapters.find((c) => c.id === m.chapterId) ?? p.chapters[0];
    const tz = ch?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const t = effectiveInstant(m, p.sources.find((x) => x.id === m.sourceId), tz);
    if (Number.isNaN(t)) return '';
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(t);
  }

  function renderItems() {
    const p = s.state;
    const cueOf = new Map(p.cues.map((c) => [c.itemId, c]));
    const groups: { title: string; items: typeof p.media }[] = [
      ...p.chapters.map((c) => ({ title: c.title, items: p.media.filter((m) => m.chapterId === c.id) })),
      { title: 'Unassigned', items: p.media.filter((m) => m.chapterId === null) },
    ].filter((g) => g.items.length);
    side.replaceChildren(...groups.map((g) => {
      const sorted = g.items.slice().sort((a, b) => ((cueOf.get(a.id)?.order ?? '~') < (cueOf.get(b.id)?.order ?? '~') ? -1 : 1));
      return h('div', { class: 'group' }, h('h3', {}, g.title, h('span', { class: 'count' }, ` ${g.items.length}`)), h('ul', { class: 'items' }, ...sorted.map((m, i) => {
        const cue = cueOf.get(m.id);
        const ready = !m.status || m.status === 'ready';
        return h('li', { 'data-item': m.id, class: cue?.included === false ? 'excluded' : '' },
          ready && m.assets?.thumb ? h('img', { src: Api.mediaUrl(id, m.id, 'thumb'), alt: '', loading: 'lazy' }) : h('span', { class: 'thumb-placeholder' }),
          h('span', { class: 'name', title: m.uri }, m.uri.split('/').pop() ?? m.uri,
            itemTime(p, m) && h('span', { class: 'when' }, itemTime(p, m))),
          m.timestampConfidence === 'low' && !m.userTimestamp && h('span', { class: 'badge low', title: 'Time taken from the file date, not the camera: it may be wrong' }, 'time?'),
          !ready && h('span', { class: `badge ${m.status}`, title: m.status === 'failed' ? m.error ?? '' : '' }, m.status ?? ''),
          m.status === 'failed' && m.storageKey && s.role !== 'viewer' && h('button', { class: 'retry', 'aria-label': `Retry processing ${m.uri}`, title: m.error ?? '', onclick: () => void retry([m.id]) }, 'Retry'),
          ready && m.assets?.jpeg && h('a', { class: 'badge jpg', href: Api.mediaUrl(id, m.id, 'jpeg'), download: `${(m.uri.split('/').pop() ?? 'photo').replace(/\.[^.]+$/, '')}.jpg`,
            title: 'Converted from HEIC. Download the full-size JPG (the original HEIC is kept too).' }, 'JPG'),
          cue && h('label', { class: 'inc', title: 'Include in the travelogue' },
            h('input', { type: 'checkbox', checked: cue.included, disabled: !s.canEdit, 'aria-label': `Include ${m.uri}`, onchange: (e: Event) => s.edit(cue.included ? 'Exclude item' : 'Include item', (q) => setIncluded(q, m.id, (e.target as HTMLInputElement).checked)) })),
          s.canEdit && cue && h('button', { class: 'icon', 'aria-label': `Move ${m.uri} up`, disabled: i === 0, onclick: () => s.edit('Move item', (q) => moveItem(q, m.id, i - 1)) }, '↑'),
          s.canEdit && cue && h('button', { class: 'icon', 'aria-label': `Move ${m.uri} down`, disabled: i === sorted.length - 1, onclick: () => s.edit('Move item', (q) => moveItem(q, m.id, i + 1)) }, '↓'));
      })));
    }));
  }

  function renderUpload() {
    const p = s.state;
    const mayUpload = s.role !== 'viewer';
    // Waiting for an original (never uploaded, or the upload failed) vs uploaded but processing failed.
    const pending = p.media.filter((m) => m.status === 'pending' || m.status === 'uploading' || (m.status === 'failed' && !m.storageKey));
    const failedProcessing = p.media.filter((m) => m.status === 'failed' && m.storageKey);
    const toolsBanner = mediaTools && !mediaTools.ok
      ? h('div', { class: 'banner error', id: 'media-problems', role: 'alert' },
        h('strong', {}, 'Media processing is not working on this server.'),
        h('ul', {}, ...mediaTools.problems.map((t) => h('li', {}, t))),
        h('button', { id: 'media-recheck', onclick: async () => { mediaTools = await Api.mediaTools(true).catch(() => mediaTools); renderSide(); } }, 'Check again'))
      : null;
    const failedBlock = failedProcessing.length
      ? h('div', { class: 'failed-processing' },
        h('p', {}, `${failedProcessing.length} uploaded item(s) could not be processed. Their originals are stored, so they can be processed again without re-uploading.`),
        h('ul', { class: 'pending' }, ...failedProcessing.slice(0, 50).map((m) => h('li', { class: 'muted' }, `${m.uri.split('/').pop()}${m.error ? ` · ${m.error}` : ''}`))),
        mayUpload && h('button', { class: 'primary', id: 'retry-failed', onclick: () => void retry() }, `Retry processing (${failedProcessing.length})`))
      : null;
    const input = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*,audio/*', id: 'upload-input', 'aria-label': 'Choose photos and videos' });
    const start = async () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      const byName = new Map(pending.map((m) => [m.uri.split('/').pop()!, m.id]));
      const jobs = files.map((f) => ({ file: f, mediaId: byName.get(f.name) }));
      uploads = jobs.map((j) => ({ file: j.file, sent: 0, total: j.file.size, state: 'queued' as const }));
      renderProgress(uploadProgress, uploads);
      await uploadAll(id, jobs, (all) => { uploads = all; renderProgress(uploadProgress, all); });
      void s.poll();
    };
    side.replaceChildren(
      mayUpload
        ? h('div', {},
          h('p', { class: 'muted' }, pending.length
            ? `${pending.length} item(s) are waiting for their original. Choose the matching files to finish the upload, or add new photos and videos (they go to Unassigned).`
            : 'Add photos and videos. Originals upload unaltered, so capture time and location are kept. New items go to Unassigned.'),
          input,
          h('button', { class: 'primary', id: 'upload-start', onclick: () => void start() }, 'Upload'),
          uploadProgress,
          pending.length ? h('ul', { class: 'pending' }, ...pending.slice(0, 50).map((m) => h('li', { class: 'muted' }, `${m.uri.split('/').pop()} · ${m.status}${m.error ? ` · ${m.error}` : ''}`))) : null)
        : h('p', { class: 'muted' }, 'Viewers cannot upload media.'));
    if (failedBlock) side.append(failedBlock);
    if (toolsBanner) side.prepend(toolsBanner);
  }

  async function renderMembers() {
    const { members } = await Api.members(id).catch(() => ({ members: [] as { userId: string; name: string; email: string; role: Role; joinedAt: number }[] }));
    if (tab !== 'Members') return;
    const owner = s.role === 'owner';
    const email = h('input', { type: 'email', placeholder: 'friend@example.com', 'aria-label': 'Email to invite', required: true });
    const role = h('select', { 'aria-label': 'Role' }, ...(['editor', 'contributor', 'viewer'] as const).map((r) => h('option', { value: r }, r)));
    const msg = h('div', { class: 'form-msg', role: 'status' });
    side.replaceChildren(
      h('ul', { class: 'members' }, ...members.map((m) => h('li', {},
        h('span', {}, `${m.name} `, h('span', { class: 'muted' }, m.email)),
        owner && m.role !== 'owner'
          ? h('select', { 'aria-label': `Role for ${m.email}`, onchange: async (e: Event) => { await Api.setRole(id, m.userId, (e.target as HTMLSelectElement).value as Role); void renderMembers(); } },
            ...(['editor', 'contributor', 'viewer'] as const).map((r) => h('option', { value: r, selected: r === m.role }, r)))
          : h('span', { class: 'chip' }, m.role),
        owner && m.role !== 'owner' && h('button', { class: 'icon', 'aria-label': `Remove ${m.email}`, onclick: async () => { await Api.removeMember(id, m.userId); void renderMembers(); } }, '✕')))),
      owner ? h('form', { class: 'invite', onsubmit: async (e: Event) => {
        e.preventDefault();
        try {
          await Api.invite(id, email.value, role.value as Role);
          msg.textContent = `Invitation sent to ${email.value}.`;
          email.value = '';
        } catch (err) {
          msg.textContent = (err as Error).message;
        }
      } }, h('h3', {}, 'Invite someone'), email, role, h('button', { type: 'submit', class: 'primary' }, 'Send invite'), msg) : '',
      h('p', { class: 'muted small' }, 'Editors change the travelogue (one at a time until live co-editing arrives). Contributors upload media. Viewers watch.'));
  }

  async function renderVersions() {
    const { versions } = await Api.versions(id).catch(() => ({ versions: [] as { id: string; rev: number; author: string; at: number; label: string; auto: boolean }[] }));
    if (tab !== 'Versions') return;
    const label = h('input', { placeholder: 'e.g. Before trimming Porto', 'aria-label': 'Version name', required: true });
    const msg = h('div', { class: 'form-msg', role: 'status' });
    side.replaceChildren(
      s.mayEdit ? h('form', { class: 'row', onsubmit: async (e: Event) => { e.preventDefault(); await s.flush().catch(() => {}); await Api.saveVersion(id, label.value); void renderVersions(); } },
        label, h('button', { type: 'submit' }, 'Save version')) : '',
      h('ul', { class: 'versions' }, ...versions.map((v) => h('li', {},
        h('span', {}, v.label, h('span', { class: 'muted' }, ` · ${v.author} · ${ago(v.at)}`)),
        s.canEdit && h('button', { onclick: async () => {
          await s.flush().catch(() => {});
          try {
            await Api.restore(id, v.id);
            await s.reload();
            msg.textContent = `Restored "${v.label}". Restoring again from this list can take you back.`;
            void renderVersions();
          } catch (err) {
            msg.textContent = (err as Error).message;
          }
        } }, 'Restore')))),
      msg);
  }

  renderSide();
  update();
  setView(view);
  window.tripalogue = { telemetry, player, session: s, itinerary, inset, state: () => player.state };
  if (params.get('autoplay') === '1') {
    player.setMuted(true);
    player.play();
  }
  current = {
    id, session: s, player, setView,
    dispose: () => {
      unsub();
      itinerary.dispose();
      inset.dispose();
      ro.disconnect();
      removeEventListener('keydown', onKey);
      removeEventListener('pagehide', onHide);
      player.destroy();
      void s.close();
    },
  };
}

addEventListener('hashchange', () => void route());
Api.config().then((c) => setTelemetry(c.telemetryEndpoint)).catch(() => {});
void route();
