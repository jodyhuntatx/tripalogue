/**
 * Presentation editor (Phase 3): the Edit view's timeline and clip inspector.
 *
 * - PE-1 timeline of the whole travelogue grouped by chapter, each clip as long as it plays
 * - PE-2 play this chapter, play from the selection, click the ruler to scrub
 * - PE-3 drag clips to reorder, within and across chapters (asking whether to change the item's time)
 * - PE-4 exclude (Delete key) and restore from the Excluded tray
 * - PE-5 drag a clip's right edge for an image's duration or a video's out-point; type seconds
 * - PE-7 reset an item or a whole chapter; PE-8 multi-select and bulk edits; PE-9 runtime against a target
 * - AU-1..AU-4 narration and music lanes with waveforms, anchors, trims, volumes, mute and solo
 *
 * Stage placement (PE-6) is in stage-edit.ts. Every change is an ordinary session edit: undoable and saved.
 */
import {
  buildTimeline, MIN_CLIP_SEC, place, MIN_IMAGE_SEC, moveAudio, moveClips, placeAudio, resetChapter, resetCues, setAudioAnchorKind, setAudioCue,
  setDurations, setIncludedMany, setLane, setPlacements, setTarget, setVideoTrim, setVolumes, unplaceAudio,
  type AudioClip, type Id, type MediaItem, type MediaSegment, type PlacementMode, type Timeline, type Travelogue,
} from '../core/index.js';
import { Api } from './api.js';
import { fill, h } from './dom.js';
import type { ProjectSession } from './session.js';
import type { Player } from '../player/player.js';

export interface EditorView {
  /** The timeline panel, under the player. */
  el: HTMLElement;
  /** The Clip tab of the side panel. */
  inspector: HTMLElement;
  selection(): Id[];
  select(ids: Id[], seek?: boolean): void;
  update(): void;
  onTime(t: number): void;
  /** Called when the Edit view is shown or hidden. */
  setActive(on: boolean): void;
  /** Keyboard shortcuts while the Edit view is shown; true when the key was used. */
  handleKey(e: KeyboardEvent): boolean;
  dispose(): void;
}

export interface EditorContext {
  projectId: string;
  player: Player;
  /** Selection changed (the stage handles follow it). */
  onSelect?: (ids: Id[]) => void;
}

const ZOOMS = [4, 8, 14, 24, 40, 64, 100];
const fmt = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmt1 = (sec: number) => (Math.round(sec * 10) / 10).toFixed(1);
const nameOf = (m: MediaItem) => m.uri.split('/').pop() ?? m.uri;
/** "5:00", "300", "5m" → seconds. */
export function parseDuration(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  const mmss = /^(\d+):(\d{1,2})$/.exec(s);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const m = /^(\d+(?:\.\d+)?)\s*m(in)?$/i.exec(s);
  if (m) return Number(m[1]) * 60;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function mountEditor(s: ProjectSession, ctx: EditorContext): EditorView {
  let zoom = 3;
  let selected: Id[] = [];
  let anchorId: Id | null = null;
  let chapterSel: Id | null = null;
  let tl: Timeline = buildTimeline(s.state);
  let lastState: Travelogue | null = null;
  let stopAt: number | null = null;
  let active = false;
  const pps = () => ZOOMS[zoom];

  // ---- DOM ----
  const total = h('span', { id: 'pe-total', class: 'pe-total' });
  const targetIn = h('input', { id: 'pe-target', class: 'num', placeholder: 'm:ss', 'aria-label': 'Target length (minutes:seconds)', size: 5 });
  const bar = h('div', { class: 'pe-bar', id: 'pe-bar' }, h('div', { class: 'fill' }));
  const zoomOut = h('button', { class: 'icon', 'aria-label': 'Zoom out', id: 'pe-zoom-out', onclick: () => setZoom(zoom - 1) }, '−');
  const zoomIn = h('button', { class: 'icon', 'aria-label': 'Zoom in', id: 'pe-zoom-in', onclick: () => setZoom(zoom + 1) }, '+');
  const playChapterBtn = h('button', { id: 'pe-play-chapter', onclick: () => playChapter() }, '▶ Chapter');
  const playSelBtn = h('button', { id: 'pe-play-selection', onclick: () => playFromSelection() }, '▶ From selection');
  const toolbar = h('div', { class: 'pe-toolbar row' }, playChapterBtn, playSelBtn,
    h('span', { class: 'spacer' }), total, h('label', { class: 'small muted', for: 'pe-target' }, 'Target'), targetIn, bar,
    h('span', { class: 'muted small' }, 'Zoom'), zoomOut, zoomIn);

  const heads = h('div', { class: 'pe-heads' });
  const ruler = h('div', { class: 'pe-row pe-ruler', id: 'pe-ruler' });
  const chapterRow = h('div', { class: 'pe-row pe-chapters' });
  const visualRow = h('div', { class: 'pe-row pe-visual', id: 'pe-visual' });
  const laneRows = new Map<Id, HTMLElement>();
  const clipSoundRow = h('div', { class: 'pe-row pe-lane pe-clipsound', id: 'pe-lane-clip' });
  const playhead = h('div', { class: 'pe-playhead', id: 'pe-playhead' });
  const marker = h('div', { class: 'pe-marker', hidden: true });
  const content = h('div', { class: 'pe-content' });
  const scroller = h('div', { class: 'pe-scroller', id: 'pe-scroller' }, content);
  const tracks = h('div', { class: 'pe-tracks' }, heads, scroller);
  const toPlace = h('div', { class: 'pe-tray', id: 'pe-audio-tray' });
  const excludedTray = h('details', { class: 'pe-tray', id: 'pe-excluded' });
  const el = h('section', { class: 'pe card', id: 'pe-timeline', 'aria-label': 'Presentation timeline' }, toolbar, tracks, toPlace, excludedTray);
  const inspector = h('div', { class: 'pe-inspector', id: 'pe-inspector' });
  const dialog = h('dialog', { class: 'pe-dialog', id: 'pe-move-dialog' }) as HTMLDialogElement;
  document.body.append(dialog);

  // ---- helpers ----
  const media = () => new Map(s.state.media.map((m) => [m.id, m]));
  const cueOf = (id: Id) => s.state.cues.find((c) => c.itemId === id);
  const visualSegs = () => tl.segments.filter((x): x is MediaSegment => x.kind !== 'title');
  const segOf = (id: Id) => visualSegs().find((x) => x.item.id === id);
  const clipOf = (id: Id) => tl.audio.find((c) => c.item.id === id);
  const x = (t: number) => Math.round(t * pps());
  const tAt = (clientX: number) => (clientX - content.getBoundingClientRect().left) / pps();
  const edit = (label: string, fn: (p: Travelogue) => Travelogue, opts?: { coalesceKey?: string; structural?: boolean }) => s.edit(label, fn, opts);

  function setZoom(z: number) {
    const t = ctx.player.time;
    zoom = Math.max(0, Math.min(ZOOMS.length - 1, z));
    render();
    scroller.scrollLeft = Math.max(0, x(t) - scroller.clientWidth / 2);
  }

  // ---- render ----
  // Clips are kept and updated in place (keyed by item), so an element the user is pointing at survives updates.
  const cache = { chapters: new Map<string, HTMLElement>(), visual: new Map<string, HTMLElement>(), audio: new Map<string, HTMLElement>(), sound: new Map<string, HTMLElement>() };
  function reconcile(row: HTMLElement, store: Map<string, HTMLElement>, entries: [string, () => HTMLElement, (e: HTMLElement) => void][]) {
    const keep = new Set<string>();
    for (const [key, make, upd] of entries) {
      let e = store.get(key);
      if (!e || e.parentElement !== row) {
        e?.remove();
        e = make();
        store.set(key, e);
        row.append(e);
      }
      upd(e);
      keep.add(key);
    }
    for (const [k, e] of store) if (!keep.has(k)) { e.remove(); store.delete(k); }
  }
  const span = (e: HTMLElement, start: number, dur: number, min = 2) => {
    e.style.left = `${x(start)}px`;
    e.style.width = `${Math.max(min, x(start + dur) - x(start) - 1)}px`;
  };
  let headsKey = '';

  function render() {
    const p = s.state;
    tl = ctx.player.timeline;
    const m = media();
    const width = Math.max(x(tl.duration) + 120, scroller.clientWidth || 600);
    content.style.width = `${width}px`;
    // Ruler: a tick every 5, 10, 30 or 60 s depending on zoom.
    const step = [60, 30, 10, 10, 5, 5, 2][zoom];
    const ticks: HTMLElement[] = [];
    for (let t = 0; t <= tl.duration + step; t += step) {
      const tick = h('span', { class: 'tick' }, fmt(t));
      tick.style.left = `${x(t)}px`;
      ticks.push(tick);
    }
    ruler.replaceChildren(...ticks);
    // Chapter bands with their runtime (PE-9).
    reconcile(chapterRow, cache.chapters, tl.chapters.map((c) => [c.chapterId,
      () => h('button', { class: 'pe-chapter', 'data-chapter': c.chapterId, onclick: () => {
        const span0 = tl.chapters.find((q) => q.chapterId === c.chapterId);
        chapterSel = c.chapterId; selected = []; renderSelection(); renderInspector(); ctx.onSelect?.([]);
        if (span0) ctx.player.seek(span0.start);
      } }, h('strong', {}), h('span', { class: 'muted' })),
      (e) => {
        e.title = `${c.index + 1}. ${c.title} · ${fmt(c.end - c.start)}`;
        e.querySelector('strong')!.textContent = `${c.index + 1}. ${c.title || 'Untitled'}`;
        e.querySelector('span')!.textContent = ` ${fmt(c.end - c.start)}`;
        span(e, c.start, c.end - c.start, 2);
      }]));
    // Visual track (PE-1).
    reconcile(visualRow, cache.visual, tl.segments.map((seg) => {
      if (seg.kind === 'title') {
        return [`title:${seg.chapterId}`, () => h('div', { class: 'pe-clip title', 'data-chapter': seg.chapterId }, h('span', {}, 'Title')), (e: HTMLElement) => {
          e.title = `Title card · ${fmt1(seg.duration)} s`;
          span(e, seg.start, seg.duration);
        }] as [string, () => HTMLElement, (e: HTMLElement) => void];
      }
      const it = seg.item;
      return [it.id, () => h('div', { class: `pe-clip ${seg.kind}`, 'data-item': it.id, tabindex: '0' }, h('span', { class: 'label' }),
        s.canEdit && h('span', { class: 'edge', 'data-edge': 'right', title: seg.kind === 'image' ? 'Drag to change how long it shows' : 'Drag to trim the end' })),
      (e: HTMLElement) => {
        e.dataset.chapter = seg.chapterId;
        e.title = `${nameOf(it)} · ${fmt1(seg.duration)} s`;
        e.setAttribute('aria-label', `${nameOf(it)}, ${fmt1(seg.duration)} seconds`);
        e.querySelector('.label')!.textContent = `${seg.kind === 'video' ? '▶ ' : ''}${fmt1(seg.duration)}s`;
        const edge = e.querySelector('.edge');
        if (edge && !s.canEdit) edge.remove();
        else if (!edge && s.canEdit) e.append(h('span', { class: 'edge', 'data-edge': 'right' }));
        span(e, seg.start, seg.duration, 3);
        // Narrow clips (zoomed out) are for picking up and moving; their edge handle would cover them.
        e.classList.toggle('narrow', seg.duration * pps() < 24);
        const thumb = it.assets?.thumb ? `url("${Api.mediaUrl(ctx.projectId, it.id, 'thumb')}")` : '';
        if (e.style.backgroundImage !== thumb) e.style.backgroundImage = thumb;
      }];
    }));
    // Audio lanes (AU-1, AU-4): headers on the left, clips with their waveforms on the right.
    const lanes = p.audioLanes.filter((l) => l.kind !== 'clipSound');
    const clipLane = p.audioLanes.find((l) => l.kind === 'clipSound');
    const laneName = (k: string) => (k === 'narration' ? 'Narration' : k === 'music' ? 'Music' : 'Clip sound');
    const hk = JSON.stringify([p.audioLanes, s.canEdit]);
    if (hk !== headsKey) {
      headsKey = hk;
      const laneHead = (id: Id, name: string) => {
        const l = p.audioLanes.find((q) => q.id === id)!;
        const vol = h('input', { type: 'range', min: '0', max: '1.5', step: '0.05', value: String(l.volume), 'aria-label': `${name} volume`, title: `${name} volume ${Math.round(l.volume * 100)}%`, class: 'pe-vol', disabled: !s.canEdit });
        vol.addEventListener('input', () => edit(`${name} volume`, (q) => setLane(q, id, { volume: Number(vol.value) }), { coalesceKey: `lane-vol-${id}` }));
        return h('div', { class: 'pe-head lane', 'data-lane': id },
          h('span', { class: 'name' }, name),
          h('button', { class: `icon${l.mute ? ' on' : ''}`, 'aria-pressed': String(l.mute), 'aria-label': `Mute ${name}`, title: 'Mute', 'data-act': 'mute', disabled: !s.canEdit,
            onclick: () => { const cur = s.state.audioLanes.find((q) => q.id === id)!; edit(cur.mute ? `Unmute ${name}` : `Mute ${name}`, (q) => setLane(q, id, { mute: !cur.mute })); } }, 'M'),
          h('button', { class: `icon${l.solo ? ' on' : ''}`, 'aria-pressed': String(!!l.solo), 'aria-label': `Solo ${name}`, title: 'Solo', 'data-act': 'solo', disabled: !s.canEdit,
            onclick: () => { const cur = s.state.audioLanes.find((q) => q.id === id)!; edit(cur.solo ? `Unsolo ${name}` : `Solo ${name}`, (q) => setLane(q, id, { solo: !cur.solo })); } }, 'S'),
          vol);
      };
      fill(heads,
        h('div', { class: 'pe-head ruler' }, h('span', { class: 'muted small' }, 'Time')),
        h('div', { class: 'pe-head chapters' }, h('span', { class: 'muted small' }, 'Chapters')),
        h('div', { class: 'pe-head visual' }, h('span', {}, 'Pictures')),
        ...lanes.map((l) => laneHead(l.id, laneName(l.kind))),
        clipLane && laneHead(clipLane.id, 'Clip sound'));
    }
    for (const l of lanes) {
      let row = laneRows.get(l.id);
      if (!row) {
        row = h('div', { class: 'pe-row pe-lane', 'data-lane': l.id, id: `pe-lane-${l.kind}` });
        laneRows.set(l.id, row);
      }
    }
    for (const [id, row] of laneRows) if (!lanes.some((l) => l.id === id)) { row.remove(); laneRows.delete(id); }
    // Audio clips: one store across lanes; a clip moved to the other lane is rebuilt there.
    const byLane = new Map<Id, AudioClip[]>(lanes.map((l) => [l.id, tl.audio.filter((c) => c.laneId === l.id)]));
    const keepAudio = new Set<string>();
    for (const [laneId, clips] of byLane) {
      const row = laneRows.get(laneId)!;
      for (const c of clips) {
        let e = cache.audio.get(c.item.id);
        if (!e || e.parentElement !== row) {
          e?.remove();
          e = h('div', { class: 'pe-clip audio', 'data-item': c.item.id, tabindex: '0' }, h('span', { class: 'label' }));
          cache.audio.set(c.item.id, e);
          row.append(e);
        }
        updateAudioClip(e, c);
        keepAudio.add(c.item.id);
      }
    }
    for (const [k, e] of cache.audio) if (!keepAudio.has(k)) { e.remove(); cache.audio.delete(k); }
    reconcile(clipSoundRow, cache.sound, visualSegs().filter((v) => v.kind === 'video').map((v) => [v.item.id,
      () => h('div', { class: 'pe-clipsound-span' }),
      (e) => { e.title = `${nameOf(v.item)}: sound inside the video`; span(e, v.start, v.duration); }]));
    const rows = [ruler, chapterRow, visualRow, ...lanes.map((l) => laneRows.get(l.id)!), clipSoundRow, playhead, marker];
    if (rows.length !== content.children.length || rows.some((r, i) => content.children[i] !== r)) content.replaceChildren(...rows);
    // Runtime against the target (PE-9).
    total.textContent = `Runtime ${fmt(tl.duration)}`;
    if (document.activeElement !== targetIn) targetIn.value = p.targetSec ? fmt(p.targetSec) : '';
    targetIn.disabled = !s.canEdit;
    const over = p.targetSec ? tl.duration / p.targetSec : 0;
    bar.hidden = !p.targetSec;
    (bar.firstChild as HTMLElement).style.width = `${Math.min(100, over * 100)}%`;
    bar.classList.toggle('over', over > 1.02);
    bar.title = p.targetSec ? `${fmt(tl.duration)} of ${fmt(p.targetSec)} (${Math.round(over * 100)}%)` : '';
    total.dataset.over = String(over > 1.02);
    renderTrays(m);
    renderSelection();
    onTime(ctx.player.time);
  }

  function updateAudioClip(e: HTMLElement, c: AudioClip) {
    const anchorName = c.anchorItemId ? nameOf(s.state.media.find((m) => m.id === c.anchorItemId) ?? c.item) : '';
    e.classList.toggle('anchored', !!c.anchorItemId);
    e.title = `${nameOf(c.item)} · ${fmt1(c.duration)} s · ${c.anchorItemId ? `moves with ${anchorName}` : 'at a time in the chapter'}${c.cutSec > 0.05 ? ` · ${fmt1(c.cutSec)} s cut at the chapter end` : ''}`;
    e.querySelector('.label')!.textContent = `${c.anchorItemId ? '⚓ ' : ''}${nameOf(c.item)}`;
    e.style.transform = '';
    span(e, c.start, c.duration, 4);
    const wave = c.item.assets?.thumb ? `url("${Api.mediaUrl(ctx.projectId, c.item.id, 'thumb')}")` : '';
    if (wave) {
      // The waveform covers the whole file; show the part that plays.
      const full = c.item.durationSec ?? c.duration;
      if (e.style.backgroundImage !== wave) e.style.backgroundImage = wave;
      e.style.backgroundSize = `${Math.max(1, full * pps())}px 100%`;
      e.style.backgroundPosition = `${-c.inPointSec * pps()}px 0`;
    }
  }

  function renderTrays(m: Map<Id, MediaItem>) {
    const p = s.state;
    // Audio not on a lane yet (AU-1): drag onto Narration or Music.
    const placed = new Set(p.cues.filter((c) => c.audio).map((c) => c.itemId));
    const loose = p.media.filter((x) => x.kind === 'audio' && !placed.has(x.id));
    fill(toPlace, loose.length
      ? h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Audio to place — drag onto Narration or Music:'),
        ...loose.map((a) => h('span', {
          class: `pe-chip audio${selected.includes(a.id) ? ' selected' : ''}`, 'data-audio': a.id, tabindex: '0',
          title: `${nameOf(a)}${a.durationSec ? ` · ${fmt(a.durationSec)}` : ''}`,
        }, `♪ ${nameOf(a)}${a.durationSec ? ` · ${fmt(a.durationSec)}` : ''}`)))
      : null);
    toPlace.hidden = !loose.length;
    // Excluded items (PE-4): kept, ready to restore.
    const excluded = p.cues.filter((c) => !c.included && m.get(c.itemId)?.kind !== 'audio' && m.get(c.itemId)?.chapterId);
    const open = excludedTray.open;
    fill(excludedTray,
      h('summary', {}, h('span', {}, 'Excluded'), h('span', { class: 'count' }, ` ${excluded.length}`),
        h('span', { class: 'muted small' }, '  Not in the cut, but kept. Restore puts an item back where it was.')),
      h('div', { class: 'row' }, ...excluded.map((c) => {
        const it = m.get(c.itemId)!;
        return h('span', { class: `pe-chip${selected.includes(it.id) ? ' selected' : ''}`, 'data-excluded': it.id, tabindex: '0' },
          it.assets?.thumb ? h('img', { src: Api.mediaUrl(ctx.projectId, it.id, 'thumb'), alt: '' }) : null, nameOf(it),
          s.canEdit && h('button', { class: 'icon', 'aria-label': `Restore ${nameOf(it)}`, 'data-restore': it.id, onclick: (e: Event) => { e.stopPropagation(); edit('Restore item', (q) => setIncludedMany(q, [it.id], true)); } }, 'Restore'));
      })));
    excludedTray.open = open;
    excludedTray.hidden = !excluded.length;
  }

  function renderSelection() {
    const sel = new Set(selected);
    el.querySelectorAll<HTMLElement>('[data-item],[data-audio],[data-excluded]').forEach((c) => {
      const id = c.dataset.item ?? c.dataset.audio ?? c.dataset.excluded!;
      c.classList.toggle('selected', sel.has(id));
    });
    chapterRow.querySelectorAll<HTMLElement>('.pe-chapter').forEach((b) => b.classList.toggle('selected', b.dataset.chapter === chapterSel));
  }

  function onTime(t: number) {
    playhead.style.left = `${x(t)}px`;
    if (stopAt !== null && t >= stopAt - 0.02) {
      stopAt = null;
      ctx.player.pause();
    }
    if (ctx.player.state === 'playing' && active) {
      // Keep the playhead in view while playing.
      const px = x(t);
      if (px < scroller.scrollLeft || px > scroller.scrollLeft + scroller.clientWidth - 40) scroller.scrollLeft = Math.max(0, px - 80);
    }
  }

  // ---- selection ----
  function select(ids: Id[], seek = true) {
    selected = ids;
    chapterSel = null;
    renderSelection();
    renderInspector();
    ctx.onSelect?.(ids);
    if (seek && ids.length === 1) {
      const seg = segOf(ids[0]);
      const clip = clipOf(ids[0]);
      // Show the item fully faded in, so it can be placed on the stage.
      if (seg) ctx.player.seek(seg.start + Math.min(seg.duration / 2, 1));
      else if (clip) ctx.player.seek(clip.start);
    }
  }

  // ---- PE-2 ----
  function playChapter() {
    const t = ctx.player.time;
    const ch = (chapterSel && tl.chapters.find((c) => c.chapterId === chapterSel))
      || (selected[0] && tl.chapters.find((c) => c.chapterId === segOf(selected[0])?.chapterId))
      || tl.chapters.find((c) => t >= c.start && t < c.end) || tl.chapters[0];
    if (!ch) return;
    ctx.player.seek(ch.start);
    stopAt = ch.end;
    ctx.player.play();
  }
  function playFromSelection() {
    const starts = selected.map((id) => segOf(id)?.start ?? clipOf(id)?.start).filter((v): v is number => v !== undefined);
    ctx.player.seek(starts.length ? Math.min(...starts) : ctx.player.time);
    stopAt = null;
    ctx.player.play();
  }

  // ---- pointer: select, drag to reorder, drag edges, drag audio, scrub ----
  let narrowOnUp: Id | null = null;
  let drag: null | {
    kind: 'reorder' | 'edge' | 'audio' | 'place' | 'scrub';
    id: Id; x0: number; moved: boolean; ghost?: HTMLElement; base?: number; startT?: number; laneId?: Id;
  } = null;

  function laneAt(clientY: number): Id | undefined {
    for (const [id, row] of laneRows) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return id;
    }
    return undefined;
  }

  /** Where a reorder drop at clientX lands: the chapter and the item to go before (null = chapter end). */
  function dropAt(clientX: number): { chapterId: Id; beforeId: Id | null; x: number } | undefined {
    const t = tAt(clientX);
    const ch = tl.chapters.find((c) => t >= c.start && t < c.end) ?? (t >= tl.duration ? tl.chapters[tl.chapters.length - 1] : tl.chapters[0]);
    if (!ch) return undefined;
    const segs = visualSegs().filter((v) => v.chapterId === ch.chapterId && !selected.includes(v.item.id));
    const next = segs.find((v) => t < v.start + v.duration / 2);
    return { chapterId: ch.chapterId, beforeId: next?.item.id ?? null, x: next ? x(next.start) : x(ch.end) };
  }

  content.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const clip = target.closest<HTMLElement>('.pe-clip[data-item]');
    if (target.closest('.pe-ruler') || (!clip && !target.closest('.pe-chapter'))) {
      if (target.closest('.pe-ruler') || target === content || target.classList.contains('pe-row')) {
        drag = { kind: 'scrub', id: '', x0: e.clientX, moved: false };
        ctx.player.seek(Math.max(0, tAt(e.clientX)));
        content.setPointerCapture(e.pointerId);
      }
      return;
    }
    if (!clip) return;
    const id = clip.dataset.item!;
    // Selection first.
    if (e.shiftKey && anchorId) {
      const order = visualSegs().map((v) => v.item.id);
      const [a, b] = [order.indexOf(anchorId), order.indexOf(id)].sort((p, q) => p - q);
      if (a >= 0 && b >= 0) select([...new Set([...selected, ...order.slice(a, b + 1)])], false);
    } else if (e.metaKey || e.ctrlKey) {
      select(selected.includes(id) ? selected.filter((q) => q !== id) : [...selected, id], false);
      anchorId = id;
    } else if (!selected.includes(id)) {
      anchorId = id;
      select([id]);
    } else {
      // Already selected: a drag moves the whole selection; a plain click (no drag) selects just this one.
      anchorId = id;
      narrowOnUp = id;
    }
    if (!s.canEdit) {
      if (narrowOnUp) { select([narrowOnUp]); narrowOnUp = null; }
      return;
    }
    const isAudio = clip.classList.contains('audio');
    const edge = target.dataset.edge === 'right';
    if (edge) {
      const seg = segOf(id)!;
      drag = { kind: 'edge', id, x0: e.clientX, moved: false, base: seg.duration };
    } else if (isAudio) {
      drag = { kind: 'audio', id, x0: e.clientX, moved: false, startT: clipOf(id)?.start ?? 0, laneId: cueOf(id)?.audio?.laneId };
    } else drag = { kind: 'reorder', id, x0: e.clientX, moved: false };
    content.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  content.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 4 && drag.kind !== 'scrub') return;
    drag.moved = true;
    if (drag.kind === 'scrub') return void ctx.player.seek(Math.max(0, tAt(e.clientX)));
    if (drag.kind === 'edge') {
      const clipEl = visualRow.querySelector<HTMLElement>(`[data-item="${drag.id}"]`);
      const d = Math.max(MIN_IMAGE_SEC, drag.base! + dx / pps());
      if (clipEl) {
        clipEl.style.width = `${Math.max(3, d * pps())}px`;
        clipEl.querySelector('.label')!.textContent = `${fmt1(d)}s`;
      }
      return;
    }
    if (drag.kind === 'audio') {
      const clipEl = el.querySelector<HTMLElement>(`.pe-clip.audio[data-item="${drag.id}"]`);
      if (clipEl) {
        clipEl.style.transform = `translateX(${dx}px)`;
        const lane = laneAt(e.clientY);
        el.querySelectorAll('.pe-lane').forEach((r) => r.classList.toggle('drop-on', (r as HTMLElement).dataset.lane === lane && lane !== drag!.laneId));
      }
      return;
    }
    // Reorder: a marker where the clips would land.
    const at = dropAt(e.clientX);
    if (!drag.ghost) {
      drag.ghost = h('div', { class: 'pe-ghost' }, selected.length > 1 ? `${selected.length} items` : nameOf(media().get(drag.id)!));
      document.body.append(drag.ghost);
      el.classList.add('dragging');
    }
    drag.ghost.style.left = `${e.clientX + 8}px`;
    drag.ghost.style.top = `${e.clientY + 8}px`;
    marker.hidden = !at;
    if (at) marker.style.left = `${at.x - 1}px`;
  });

  const endDrag = async (e: PointerEvent) => {
    const d = drag;
    drag = null;
    const narrow = narrowOnUp;
    narrowOnUp = null;
    if (narrow && (!d || !d.moved)) select([narrow]);
    marker.hidden = true;
    el.classList.remove('dragging');
    d?.ghost?.remove();
    el.querySelectorAll('.drop-on').forEach((r) => r.classList.remove('drop-on'));
    if (!d || !d.moved || e.type === 'pointercancel') {
      if (d?.kind === 'audio') render();
      return;
    }
    const dx = e.clientX - d.x0;
    if (d.kind === 'edge') {
      const seg = segOf(d.id);
      if (!seg) return render();
      const want = Math.max(MIN_IMAGE_SEC, d.base! + dx / pps());
      // Snap to tenths; whole seconds when zoomed out.
      const snapped = zoom <= 2 ? Math.round(want) || MIN_IMAGE_SEC : Math.round(want * 10) / 10;
      if (seg.kind === 'image') edit('Change duration', (q) => setDurations(q, [d.id], snapped));
      else edit('Trim end', (q) => setVideoTrim(q, d.id, seg.inPointSec, seg.inPointSec + Math.max(MIN_CLIP_SEC, snapped) * seg.speed));
      return;
    }
    if (d.kind === 'audio') {
      const lane = laneAt(e.clientY) ?? d.laneId;
      const t = Math.max(0, d.startT! + dx / pps());
      edit('Move audio', (q) => moveAudio(q, d.id, t, lane, tl));
      return;
    }
    if (d.kind === 'reorder') {
      const at = dropAt(e.clientX);
      if (!at) return;
      const ids = selected.includes(d.id) ? selected.filter((id) => segOf(id)) : [d.id];
      await moveWithQuestion(ids, at.chapterId, at.beforeId);
    }
  };
  content.addEventListener('pointerup', (e) => void endDrag(e));
  content.addEventListener('pointercancel', (e) => void endDrag(e));

  /** PE-3: moving into another chapter asks whether the items' times should change to fit it. */
  async function moveWithQuestion(ids: Id[], chapterId: Id, beforeId: Id | null) {
    const m = media();
    const leaving = ids.filter((id) => m.get(id)?.chapterId !== chapterId);
    let setTime = false;
    if (leaving.length) {
      const ch = s.state.chapters.find((c) => c.id === chapterId);
      const answer = await ask(
        leaving.length === 1 ? `Move ${nameOf(m.get(leaving[0])!)} to ${ch?.title || 'this chapter'}?` : `Move ${leaving.length} items to ${ch?.title || 'this chapter'}?`,
        'Its time puts it in another chapter. Change the time to fit, or keep the time and hold it here by hand (it stays until you change its time).',
        [['settime', 'Change the time to fit', 'primary'], ['keep', 'Keep the time'], ['cancel', 'Cancel']]);
      if (answer === 'cancel') return;
      setTime = answer === 'settime';
    }
    edit(ids.length === 1 ? 'Move item' : `Move ${ids.length} items`, (q) => moveClips(q, ids, chapterId, beforeId, { setTime }), { structural: true });
  }

  function ask(title: string, body: string, buttons: [string, string, string?][]): Promise<string> {
    return new Promise((resolve) => {
      fill(dialog, h('form', { method: 'dialog' },
        h('h3', {}, title), h('p', { class: 'muted' }, body),
        h('div', { class: 'row' }, ...buttons.map(([v, label, cls]) => h('button', { value: v, class: cls ?? '', 'data-answer': v }, label)))));
      dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true });
      dialog.showModal();
    });
  }

  // Audio chips: drag onto a lane (AU-1); excluded chips: select.
  el.addEventListener('pointerdown', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-audio]');
    if (!chip || e.button !== 0) return;
    const id = chip.dataset.audio!;
    select([id], false);
    if (!s.canEdit) return;
    const ghost = h('div', { class: 'pe-ghost' }, chip.textContent ?? '');
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      if (!moved) document.body.append(ghost);
      moved = true;
      ghost.style.left = `${ev.clientX + 8}px`;
      ghost.style.top = `${ev.clientY + 8}px`;
      const lane = laneAt(ev.clientY);
      el.querySelectorAll('.pe-lane').forEach((r) => r.classList.toggle('drop-on', (r as HTMLElement).dataset.lane === lane));
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      ghost.remove();
      el.querySelectorAll('.drop-on').forEach((r) => r.classList.remove('drop-on'));
      const lane = laneAt(ev.clientY);
      if (!moved || !lane) return;
      const t = Math.max(0, tAt(ev.clientX));
      edit('Place audio', (q) => placeAudio(q, id, lane, t, undefined, tl));
      selected = [id];
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    e.preventDefault();
  });
  el.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-excluded]');
    if (chip && !(e.target as HTMLElement).closest('button')) select([chip.dataset.excluded!], false);
  });

  /** Keys in the Edit view (the page calls this): Delete excludes (PE-4), Escape clears, Enter selects. */
  function handleKey(e: KeyboardEvent): boolean {
    if ((e.target as HTMLElement).matches?.('input, textarea, select')) return false;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length && s.canEdit) {
      e.preventDefault();
      excludeSelected();
      return true;
    }
    if (e.key === 'Escape' && (selected.length || chapterSel)) {
      chapterSel = null;
      select([], false);
      return true;
    }
    if (e.key === 'Enter' && (e.target as HTMLElement).dataset?.item) {
      select([(e.target as HTMLElement).dataset.item!]);
      return true;
    }
    return false;
  }

  function excludeSelected() {
    const visual = selected.filter((id) => segOf(id));
    const audio = selected.filter((id) => clipOf(id));
    if (visual.length) edit(visual.length === 1 ? 'Exclude item' : `Exclude ${visual.length} items`, (q) => setIncludedMany(q, visual, false));
    for (const id of audio) edit('Take audio off its lane', (q) => unplaceAudio(q, id));
    select([], false);
  }

  targetIn.addEventListener('change', () => {
    const v = parseDuration(targetIn.value);
    edit(v ? 'Set target length' : 'Clear target length', (q) => setTarget(q, v));
  });

  // ---- inspector (Clip tab) ----
  let inspectorKey = '';
  function renderInspector(force = false) {
    const p = s.state;
    const items = selected.map((id) => p.media.find((m) => m.id === id)).filter((m): m is MediaItem => !!m);
    const key = JSON.stringify([selected, chapterSel, items.map((m) => [m.status, m.durationSec]), selected.map((id) => cueOf(id)), s.canEdit,
      tl.audio.filter((c) => selected.includes(c.item.id)).map((c) => [c.start, c.anchorItemId]), p.audioLanes]);
    if (!force && key === inspectorKey) return;
    inspectorKey = key;
    const editable = s.canEdit;
    if (chapterSel) return renderChapterInspector(chapterSel);
    if (!items.length) {
      fill(inspector, h('h3', {}, 'Edit the cut'),
        h('p', { class: 'muted' }, 'Click a clip in the timeline to change it; Ctrl/Cmd-click or Shift-click to select several. Drag clips to reorder them, or their right edge to change how long they play. Delete takes a clip out of the cut (it waits in Excluded).'),
        h('p', { class: 'muted' }, 'Drag a voice memo or a song from "Audio to place" onto Narration or Music. Narration moves with the picture it starts on; music stays at its time in the chapter.'),
        h('p', { class: 'muted small' }, 'With one picture selected, drag it on the stage to move it, or its corners to resize it.'));
      return;
    }
    const audioItems = items.filter((m) => m.kind === 'audio');
    if (audioItems.length === 1 && items.length === 1) return renderAudioInspector(audioItems[0]);
    const visual = items.filter((m) => m.kind !== 'audio');
    if (!visual.length) return fill(inspector, h('p', { class: 'muted' }, `${items.length} audio items selected.`));
    const ids = visual.map((m) => m.id);
    const cues = ids.map((id) => cueOf(id)!).filter(Boolean);
    const one = visual.length === 1 ? visual[0] : null;
    const seg = one ? segOf(one.id) : undefined;
    const cue = one ? cueOf(one.id) : undefined;
    const allIncluded = cues.every((c) => c.included);
    const durIn = h('input', { type: 'number', id: 'pe-duration', class: 'num', min: String(MIN_IMAGE_SEC), step: '0.1', disabled: !editable,
      value: seg ? fmt1(seg.duration) : '', placeholder: one ? '' : 'seconds', 'aria-label': 'Seconds on screen' });
    durIn.addEventListener('change', () => { const v = Number(durIn.value); if (v > 0) edit(ids.length === 1 ? 'Change duration' : `Change duration of ${ids.length} items`, (q) => setDurations(q, ids, v)); });
    const modes = new Set(cues.map((c) => c.placement.mode));
    const placeSel = h('select', { id: 'pe-placement', disabled: !editable, 'aria-label': 'Placement' },
      ...(modes.size > 1 ? [h('option', { value: '', selected: true }, 'Mixed')] : []),
      ...(['fit', 'fill', 'custom'] as PlacementMode[]).map((v) => h('option', { value: v, selected: modes.size === 1 && modes.has(v), disabled: v === 'custom' && !one }, v === 'fit' ? 'Fit (whole picture)' : v === 'fill' ? 'Fill (crop to frame)' : 'Custom (drag on the stage)')));
    placeSel.addEventListener('change', () => {
      const v = placeSel.value as PlacementMode;
      if (!v) return;
      if (v === 'custom' && one) {
        // Start the custom rectangle from where the whole picture shows now (fit), so it keeps its shape.
        const out = { w: p.output.width, h: p.output.height };
        const { dst } = place({ mode: 'fit' }, one.width && one.height ? { w: one.width, h: one.height } : out, out);
        edit('Custom placement', (q) => setPlacements(q, ids, { mode: 'custom', rect: { x: dst.x / out.w, y: dst.y / out.h, w: dst.w / out.w, h: dst.h / out.h } }));
      } else edit(`Placement: ${v}`, (q) => setPlacements(q, ids, { mode: v }));
    });
    const video = one?.kind === 'video' ? one : null;
    let trimRow: HTMLElement | null = null;
    if (video && cue) {
      const inIn = h('input', { type: 'number', id: 'pe-trim-in', class: 'num', min: '0', step: '0.1', value: fmt1(cue.inPointSec ?? 0), disabled: !editable, 'aria-label': 'Start at (seconds into the video)' });
      const outIn = h('input', { type: 'number', id: 'pe-trim-out', class: 'num', min: '0', step: '0.1', value: fmt1(cue.outPointSec ?? video.durationSec ?? 0), disabled: !editable, 'aria-label': 'End at (seconds into the video)' });
      inIn.addEventListener('change', () => edit('Trim start', (q) => setVideoTrim(q, video.id, Number(inIn.value), cue.outPointSec ?? null)));
      outIn.addEventListener('change', () => edit('Trim end', (q) => setVideoTrim(q, video.id, cue.inPointSec ?? 0, Number(outIn.value))));
      trimRow = h('div', { class: 'field' }, h('label', {}, 'Plays from'), h('div', { class: 'row' }, inIn, h('span', { class: 'small' }, 's to'), outIn, h('span', { class: 'small' }, `s of ${fmt1(video.durationSec ?? 0)} s`)));
    }
    const volIn = video && cue ? h('input', { type: 'range', id: 'pe-volume', min: '0', max: '2', step: '0.05', value: String(cue.volume), disabled: !editable, 'aria-label': 'Clip sound volume' }) : null;
    volIn?.addEventListener('input', () => edit('Clip volume', (q) => setVolumes(q, ids, Number(volIn.value)), { coalesceKey: `vol-${ids.join()}` }));
    fill(inspector,
      h('h3', {}, one ? nameOf(one) : `${visual.length} items selected`),
      one && seg && h('p', { class: 'muted small' }, `${tl.chapters[seg.chapterIndex] ? `${seg.chapterIndex + 1}. ${tl.chapters[seg.chapterIndex].title}` : ''} · starts at ${fmt(seg.start)}`),
      h('div', { class: 'field' }, h('label', {},
        h('input', { type: 'checkbox', id: 'pe-included', checked: allIncluded, disabled: !editable,
          onchange: (e: Event) => edit((e.target as HTMLInputElement).checked ? 'Include' : 'Exclude', (q) => setIncludedMany(q, ids, (e.target as HTMLInputElement).checked)) }),
        ' In the cut')),
      (one?.kind !== 'video' || !one) && h('div', { class: 'field' }, h('label', { for: 'pe-duration' }, one ? 'Seconds on screen' : 'Seconds on screen (pictures; videos are trimmed to it)'), h('div', { class: 'row' }, durIn, h('span', { class: 'small muted' }, 's'))),
      trimRow,
      h('div', { class: 'field' }, h('label', { for: 'pe-placement' }, 'Placement'), placeSel,
        one && cue?.placement.mode === 'custom' && h('p', { class: 'muted small' }, 'Drag the picture on the stage to move it; drag a corner to resize. It snaps to the centre and thirds.')),
      volIn && h('div', { class: 'field' }, h('label', { for: 'pe-volume' }, `Clip sound ${Math.round((cue?.volume ?? 1) * 100)}%`), volIn),
      h('div', { class: 'row' },
        h('button', { id: 'pe-reset', disabled: !editable, onclick: () => edit(ids.length === 1 ? 'Reset to defaults' : `Reset ${ids.length} items`, (q) => resetCues(q, ids)) }, 'Reset to defaults'),
        h('button', { id: 'pe-exclude', class: 'danger-outline', disabled: !editable, onclick: () => excludeSelected() }, 'Exclude'),
        h('button', { onclick: () => playFromSelection() }, '▶ Play from here')));
  }

  function renderChapterInspector(chapterId: Id) {
    const span = tl.chapters.find((c) => c.chapterId === chapterId);
    const count = visualSegs().filter((v) => v.chapterId === chapterId).length;
    fill(inspector,
      h('h3', {}, span ? `${span.index + 1}. ${span.title}` : 'Chapter'),
      span && h('p', { class: 'muted' }, `${count} items playing · ${fmt(span.end - span.start)}`),
      h('div', { class: 'row' },
        h('button', { id: 'pe-play-this-chapter', onclick: () => playChapter() }, '▶ Play this chapter'),
        h('button', { id: 'pe-reset-chapter', disabled: !s.canEdit, onclick: () => edit('Reset chapter to defaults', (q) => resetChapter(q, chapterId)) }, 'Reset chapter to defaults')),
      h('p', { class: 'muted small' }, 'Resetting puts every item in the chapter back to the cue profile: durations, trims, placement and fades. Order and what is excluded are kept.'));
  }

  function renderAudioInspector(a: MediaItem) {
    const p = s.state;
    const cue = cueOf(a.id);
    const clip = clipOf(a.id);
    const editable = s.canEdit;
    const lanes = p.audioLanes.filter((l) => l.kind !== 'clipSound');
    if (!cue?.audio) {
      fill(inspector, h('h3', {}, nameOf(a)), h('p', { class: 'muted' }, `${a.durationSec ? fmt(a.durationSec) : 'Length not known yet'} · not on a lane yet.`),
        h('div', { class: 'row' }, ...lanes.map((l) => h('button', { 'data-place-lane': l.id, disabled: !editable || a.durationSec === undefined,
          onclick: () => edit('Place audio', (q) => placeAudio(q, a.id, l.id, ctx.player.time, undefined, tl)) }, `Put on ${l.kind === 'narration' ? 'Narration' : 'Music'} at the playhead`))));
      return;
    }
    const au = cue.audio;
    const anchorItem = au.anchor.type === 'item' ? p.media.find((m) => m.id === (au.anchor as { itemId: Id }).itemId) : undefined;
    const inIn = h('input', { type: 'number', id: 'pe-audio-in', class: 'num', min: '0', step: '0.1', value: fmt1(cue.inPointSec ?? 0), disabled: !editable, 'aria-label': 'Start at (seconds into the file)' });
    const outIn = h('input', { type: 'number', id: 'pe-audio-out', class: 'num', min: '0', step: '0.1', value: fmt1(cue.outPointSec ?? a.durationSec ?? 0), disabled: !editable, 'aria-label': 'End at (seconds into the file)' });
    inIn.addEventListener('change', () => edit('Trim audio start', (q) => setVideoTrim(q, a.id, Number(inIn.value), cue.outPointSec ?? null)));
    outIn.addEventListener('change', () => edit('Trim audio end', (q) => setVideoTrim(q, a.id, cue.inPointSec ?? 0, Number(outIn.value))));
    const vol = h('input', { type: 'range', id: 'pe-audio-volume', min: '0', max: '2', step: '0.05', value: String(cue.volume), disabled: !editable, 'aria-label': 'Clip volume' });
    vol.addEventListener('input', () => edit('Audio volume', (q) => setVolumes(q, [a.id], Number(vol.value)), { coalesceKey: `vol-${a.id}` }));
    const fadeIn = h('input', { type: 'number', id: 'pe-fade-in', class: 'num', min: '0', step: '0.1', value: fmt1(au.fadeInSec), disabled: !editable, 'aria-label': 'Fade in seconds' });
    const fadeOut = h('input', { type: 'number', id: 'pe-fade-out', class: 'num', min: '0', step: '0.1', value: fmt1(au.fadeOutSec), disabled: !editable, 'aria-label': 'Fade out seconds' });
    fadeIn.addEventListener('change', () => edit('Audio fade', (q) => setAudioCue(q, a.id, { fadeInSec: Math.max(0, Number(fadeIn.value) || 0) })));
    fadeOut.addEventListener('change', () => edit('Audio fade', (q) => setAudioCue(q, a.id, { fadeOutSec: Math.max(0, Number(fadeOut.value) || 0) })));
    const laneSel = h('select', { id: 'pe-audio-lane', disabled: !editable, 'aria-label': 'Lane' },
      ...lanes.map((l) => h('option', { value: l.id, selected: l.id === au.laneId }, l.kind === 'narration' ? 'Narration' : 'Music')));
    laneSel.addEventListener('change', () => edit('Move audio to lane', (q) => moveAudio(q, a.id, clip?.start ?? 0, laneSel.value, tl)));
    const radio = (kind: 'item' | 'chapterTime', label: string) => h('label', { class: 'small' },
      h('input', { type: 'radio', name: 'pe-anchor', value: kind, id: `pe-anchor-${kind}`, checked: au.anchor.type === kind, disabled: !editable,
        onchange: () => edit(kind === 'item' ? 'Anchor audio to item' : 'Anchor audio to chapter time', (q) => setAudioAnchorKind(q, a.id, kind, tl)) }), ` ${label}`);
    fill(inspector,
      h('h3', {}, nameOf(a)),
      h('p', { class: 'muted small', id: 'pe-audio-summary' }, clip
        ? `Plays ${fmt1(clip.duration)} s from ${fmt(clip.start)}${clip.cutSec > 0.05 ? ` (the last ${fmt1(clip.cutSec)} s fall after the chapter ends and are cut)` : ''}.`
        : 'Not playing: its anchor item is not in the cut.'),
      h('div', { class: 'field' }, h('label', { for: 'pe-audio-lane' }, 'Lane'), laneSel),
      h('div', { class: 'field' }, h('label', {}, 'Anchored'),
        radio('item', anchorItem ? `to ${nameOf(anchorItem)} (moves with it)` : 'to the picture it starts on (moves with it)'),
        radio('chapterTime', 'to its time in the chapter')),
      h('div', { class: 'field' }, h('label', {}, 'Plays from'), h('div', { class: 'row' }, inIn, h('span', { class: 'small' }, 's to'), outIn, h('span', { class: 'small' }, `s of ${fmt1(a.durationSec ?? 0)} s`))),
      h('div', { class: 'field' }, h('label', { for: 'pe-audio-volume' }, `Volume ${Math.round(cue.volume * 100)}%`), vol),
      h('div', { class: 'field' }, h('label', {}, 'Fades'), h('div', { class: 'row' }, h('span', { class: 'small' }, 'in'), fadeIn, h('span', { class: 'small' }, 'out'), fadeOut, h('span', { class: 'small' }, 's'))),
      h('div', { class: 'field' }, h('label', { class: 'small' }, h('input', { type: 'checkbox', id: 'pe-duck', checked: au.duck, disabled: !editable,
        onchange: (e: Event) => edit('Audio ducking', (q) => setAudioCue(q, a.id, { duck: (e.target as HTMLInputElement).checked })) }),
        ' Lower music and clip sound while this plays')),
      h('div', { class: 'row' },
        h('button', { id: 'pe-unplace', class: 'danger-outline', disabled: !editable, onclick: () => { edit('Take audio off its lane', (q) => unplaceAudio(q, a.id)); select([], false); } }, 'Take off the lane'),
        h('button', { onclick: () => playFromSelection() }, '▶ Play from here')));
  }

  // ---- lifecycle ----
  function update() {
    if (s.state === lastState && tl === ctx.player.timeline) return;
    lastState = s.state;
    const p = s.state;
    const known = new Set([...p.media.map((m) => m.id)]);
    selected = selected.filter((id) => known.has(id));
    if (chapterSel && !p.chapters.some((c) => c.id === chapterSel)) chapterSel = null;
    render();
    renderInspector();
  }

  return {
    el, inspector,
    selection: () => selected.slice(),
    select: (ids, seek = true) => select(ids, seek),
    update,
    onTime,
    handleKey,
    setActive(on: boolean) {
      active = on;
      if (on) { lastState = null; update(); renderInspector(true); }
    },
    dispose() {
      dialog.remove();
    },
  };
}
