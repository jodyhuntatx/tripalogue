/**
 * Export MP4 (Phase 4): the dialog that starts an export, the list of exports
 * with progress, time left, cancel and download (VX-3), failures that name and
 * link to the item that caused them (VX-4), and the notice that a file is
 * ready, in whichever view is open, also after the tab was closed (VX-10).
 *
 * The server renders from the originals. The browser draws only the title
 * cards, with the player's own drawing code, so they look as in the preview.
 */
import {
  buildTimeline, exportSize, planVideo, resolveRange, DEFAULT_EXPORT, type ExportRange, type ExportResolution, type ExportSettings, type AspectRatio,
} from '../core/index.js';
import { drawTitleCard } from '../player/player.js';
import { Api, type RenderInfo } from './api.js';
import { h, fill } from './dom.js';
import type { ProjectSession } from './session.js';

export interface ExportView {
  /** The "Export MP4" button for the top bar. */
  button: HTMLButtonElement;
  dialog: HTMLDialogElement;
  toast: HTMLElement;
  open(): void;
  refresh(): Promise<void>;
  dispose(): void;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const parseTime = (v: string): number => {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(v);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : NaN;
};
const mb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
/** Rough sizes for the estimate: pictures at the encoder's quality, plus 192 kbit/s of sound. */
const MBIT: Record<ExportResolution, number> = { '720p': 1.6, '1080p': 3.5, '4k': 12 };
const SHAPES: [AspectRatio, string][] = [['16:9', 'Landscape 16:9'], ['9:16', 'Portrait 9:16 (phones)'], ['1:1', 'Square 1:1']];
const SIZES: [ExportResolution, string][] = [['720p', '720p (smaller file)'], ['1080p', '1080p HD'], ['4k', '4K Ultra HD']];

export function mountExport(s: ProjectSession, o: {
  projectId: string;
  /** Where the preview is now (seconds), to start a time span from. */
  playhead: () => number;
  /** Open the Media view on an item (a failure names it). */
  showItem: (itemId: string) => void;
}): ExportView {
  const id = o.projectId;
  let renders: RenderInfo[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const dismissed = new Set<string>();

  const button = h('button', { id: 'export-open', class: 'primary', title: 'Save the travelogue as an MP4 video' }, 'Export MP4');
  const resolution = h('select', { id: 'export-resolution', 'aria-label': 'Size' }, ...SIZES.map(([v, t]) => h('option', { value: v, selected: v === DEFAULT_EXPORT.resolution }, t)));
  const aspect = h('select', { id: 'export-aspect', 'aria-label': 'Shape' }, ...SHAPES.map(([v, t]) => h('option', { value: v, selected: v === s.state.output.aspect }, t)));
  const part = h('select', { id: 'export-part', 'aria-label': 'What to export' },
    h('option', { value: 'all' }, 'The whole travelogue'), h('option', { value: 'chapter' }, 'One chapter'), h('option', { value: 'span' }, 'A stretch of time'));
  const chapter = h('select', { id: 'export-chapter', 'aria-label': 'Chapter' });
  const from = h('input', { id: 'export-from', class: 'num', 'aria-label': 'From (minutes:seconds)', placeholder: '0:00' });
  const to = h('input', { id: 'export-to', class: 'num', 'aria-label': 'To (minutes:seconds)', placeholder: '1:00' });
  const chapterRow = h('div', { class: 'field', hidden: true }, h('label', { for: 'export-chapter' }, 'Chapter'), chapter);
  const spanRow = h('div', { class: 'field', hidden: true }, h('label', { for: 'export-from' }, 'From – to (minutes:seconds)'), h('div', { class: 'row' }, from, h('span', {}, '–'), to));
  const summary = h('p', { id: 'export-summary', class: 'muted small', role: 'status' });
  const start = h('button', { id: 'export-start', class: 'primary' }, 'Export');
  const problem = h('p', { id: 'export-problem', class: 'error small', hidden: true, role: 'alert' });
  const list = h('ul', { id: 'export-list', class: 'export-list' });
  const close = h('button', { id: 'export-close', 'aria-label': 'Close' }, 'Close');
  const dialog = h('dialog', { id: 'export-dialog', class: 'export-dialog', 'aria-labelledby': 'export-heading' },
    h('div', { class: 'row export-head' }, h('h2', { id: 'export-heading' }, 'Export MP4'), close),
    h('p', { class: 'muted small' }, 'Renders on this computer from your original photos and videos, with the sound mixed as in the preview. You can keep editing, or close the window: TripAlogue tells you here when the file is ready.'),
    h('div', { class: 'export-form' },
      h('div', { class: 'field' }, h('label', { for: 'export-resolution' }, 'Size'), resolution),
      h('div', { class: 'field' }, h('label', { for: 'export-aspect' }, 'Shape'), aspect),
      h('div', { class: 'field' }, h('label', { for: 'export-part' }, 'What to export'), part),
      chapterRow, spanRow),
    summary, problem,
    h('div', { class: 'row' }, start),
    h('h3', {}, 'Exports'), list) as HTMLDialogElement;
  const toast = h('div', { id: 'export-toast', class: 'export-toast', role: 'status', 'aria-live': 'polite', hidden: true });

  function range(): ExportRange | string {
    if (part.value === 'chapter') return chapter.value ? { kind: 'chapter', chapterId: chapter.value } : 'Pick a chapter';
    if (part.value === 'span') {
      const a = parseTime(from.value), b = parseTime(to.value);
      if (!(b > a) || a < 0) return 'Give a start and an end time, like 1:30 and 2:45';
      return { kind: 'span', from: a, to: b };
    }
    return { kind: 'all' };
  }
  const settings = (): ExportSettings | string => {
    const r = range();
    if (typeof r === 'string') return r;
    return { resolution: resolution.value as ExportResolution, aspect: aspect.value as AspectRatio, fps: DEFAULT_EXPORT.fps, range: r };
  };

  function renderForm() {
    const tl = buildTimeline(s.state);
    const want = chapter.value;
    fill(chapter, ...tl.chapters.map((c) => h('option', { value: c.chapterId, selected: c.chapterId === want }, `${c.index + 1}. ${c.title || 'Untitled'} (${fmt(c.end - c.start)})`)));
    chapterRow.hidden = part.value !== 'chapter';
    spanRow.hidden = part.value !== 'span';
    const st = settings();
    if (typeof st === 'string') {
      summary.textContent = st;
      start.disabled = true;
      return;
    }
    let r: { start: number; end: number };
    try {
      r = resolveRange(tl, st.range);
    } catch (e) {
      summary.textContent = (e as Error).message;
      start.disabled = true;
      return;
    }
    const len = Math.max(0, r.end - r.start);
    const size = exportSize(st.resolution, st.aspect);
    const skipped = tl.skipped.length ? ` ${tl.skipped.length} item${tl.skipped.length === 1 ? ' is' : 's are'} not ready and will be left out.` : '';
    summary.textContent = len > 0
      ? `${fmt(len)} long · ${size.w}×${size.h} · ${st.fps} fps · about ${mb((len * (MBIT[st.resolution] + 0.19) * 1e6) / 8)}.${skipped}`
      : 'There is nothing to export in that part of the travelogue.';
    start.disabled = !(len > 0) || !s.mayEdit;
  }

  function statusLine(e: RenderInfo): string {
    if (e.status === 'queued') return 'Waiting to start';
    if (e.status === 'running') return `${Math.round(e.progress * 100)}% · ${e.step ?? 'Rendering'}${e.etaSec !== null ? ` · about ${fmt(Math.ceil(e.etaSec))} left` : ''}`;
    if (e.status === 'done') return `Ready · ${e.durationSec !== null ? fmt(e.durationSec) : ''}${e.bytes ? ` · ${mb(e.bytes)}` : ''}`;
    if (e.status === 'cancelled') return 'Cancelled';
    return 'Failed';
  }

  function renderList() {
    if (!renders.length) return fill(list, h('li', { class: 'muted small' }, 'No exports yet.'));
    fill(list, ...renders.map((e) => {
      const active = e.status === 'queued' || e.status === 'running';
      const actions: (HTMLElement | false)[] = [
        active && h('button', { class: 'export-cancel', onclick: async () => { await Api.cancelRender(id, e.id); await refresh(); } }, 'Cancel'),
        e.status === 'done' && h('a', { class: 'button primary export-download', href: Api.renderFileUrl(id, e.id), download: e.name }, 'Download'),
        e.status === 'done' && h('a', { class: 'button export-watch', href: Api.renderFileUrl(id, e.id, true), target: '_blank', rel: 'noopener' }, 'Watch'),
        !active && h('button', { class: 'export-delete', title: 'Delete this export and its file', onclick: async () => {
          if (e.status === 'done' && !confirm(`Delete “${e.name}” from this computer?`)) return;
          await Api.deleteRender(id, e.id);
          await refresh();
        } }, 'Delete'),
      ];
      return h('li', { class: `export-row ${e.status}`, 'data-id': e.id },
        h('div', { class: 'row' }, h('strong', { class: 'export-name' }, e.name), h('span', { class: 'spacer' }), ...actions),
        active && h('progress', { class: 'export-progress', max: 1, value: e.progress, 'aria-label': `${e.name}: ${Math.round(e.progress * 100)}%` }),
        h('p', { class: 'small muted export-status' }, statusLine(e)),
        e.status === 'done' && e.path && h('p', { class: 'small muted export-path' }, 'Saved on this computer at ', h('code', {}, e.path)),
        e.status === 'failed' && e.error && h('p', { class: 'small error export-error' }, e.error.message,
          e.error.itemId ? h('span', {}, ' ', h('a', { href: '#', class: 'export-show-item', onclick: (ev: Event) => { ev.preventDefault(); dialog.close(); o.showItem(e.error!.itemId!); } }, 'Show the item')) : null));
    }));
  }

  /** The newest finished export this tab has not told about yet. */
  function renderToast() {
    const news = renders.find((e) => (e.status === 'done' || e.status === 'failed') && !e.seen && !dismissed.has(e.id));
    if (!news) {
      toast.hidden = true;
      return;
    }
    const dismiss = () => {
      dismissed.add(news.id);
      void Api.seenRender(id, news.id).catch(() => {});
      toast.hidden = true;
    };
    toast.hidden = false;
    toast.classList.toggle('failed', news.status === 'failed');
    fill(toast,
      news.status === 'done'
        ? h('span', {}, h('strong', {}, '“', news.name, '”'), ' is ready.')
        : h('span', {}, 'Export failed: ', news.error?.message ?? 'something went wrong'),
      news.status === 'done' && h('a', { class: 'button primary', id: 'toast-download', href: Api.renderFileUrl(id, news.id), download: news.name, onclick: () => setTimeout(dismiss, 0) }, 'Download'),
      news.status === 'failed' && news.error?.itemId && h('button', { id: 'toast-show-item', onclick: () => { dismiss(); o.showItem(news.error!.itemId!); } }, 'Show the item'),
      h('button', { id: 'toast-exports', onclick: () => { dismiss(); open(); } }, 'Exports'),
      h('button', { class: 'toast-close', 'aria-label': 'Dismiss', onclick: dismiss }, '×'));
  }

  async function refresh() {
    try {
      renders = (await Api.renders(id)).renders;
    } catch {
      return; // the server is away for a moment; the next poll tries again
    }
    renderList();
    renderToast();
    const active = renders.some((e) => e.status === 'queued' || e.status === 'running');
    schedule(active || dialog.open ? 1000 : 0);
  }

  function schedule(ms: number) {
    if (timer) clearInterval(timer);
    timer = ms ? setInterval(() => void refresh(), ms) : undefined;
  }

  /** Title cards at the export's size, drawn by the preview's code. */
  function titleCards(st: ExportSettings): Record<number, string> {
    const tl = buildTimeline(s.state);
    const plan = planVideo(tl, st, () => undefined);
    const size = plan.size;
    const canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const out: Record<number, string> = {};
    for (const r of plan.runs) {
      if (r.kind !== 'title' || out[r.segmentIndex]) continue;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size.w, size.h);
      drawTitleCard(ctx, r, size);
      out[r.segmentIndex] = canvas.toDataURL('image/jpeg', 0.93);
    }
    return out;
  }

  start.addEventListener('click', async () => {
    const st = settings();
    if (typeof st === 'string') return;
    start.disabled = true;
    problem.hidden = true;
    try {
      await s.flush(); // the server renders what it has: send the latest edits first
      await Api.startRender(id, st, titleCards(st));
      await refresh();
    } catch (e) {
      problem.textContent = (e as Error).message;
      problem.hidden = false;
    } finally {
      renderForm();
    }
  });
  for (const el of [resolution, aspect, part, chapter, from, to]) el.addEventListener('input', renderForm);
  part.addEventListener('change', () => {
    if (part.value === 'span' && !from.value) {
      const t = Math.floor(o.playhead());
      from.value = fmt(t);
      to.value = fmt(Math.min(buildTimeline(s.state).duration, t + 60));
    }
    renderForm();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => void refresh());

  function open() {
    renderForm();
    if (!dialog.open) dialog.showModal();
    void refresh();
  }
  button.addEventListener('click', open);
  void refresh();

  return {
    button, dialog, toast, open, refresh,
    dispose: () => schedule(0),
  };
}
