/**
 * Media view (Phase 2 media manager): see where everything landed and fix
 * what the timestamps got wrong.
 *
 * - MM-6: a grid grouped by chapter, with the Unassigned bin first, per-chapter
 *   counts, thumbnails, kind, local time and badges (time uncertain, overlap,
 *   duplicate, processing state).
 * - MM-5: select one or many items (click, Ctrl/Cmd-click, Shift-click) and set
 *   or shift their time, or go back to the camera's time; drag items onto a
 *   chapter (or onto an item in it) to give them a time inside that chapter.
 * - MM-4: each source's clock offset, with a live preview of how many items
 *   would change chapter before applying it.
 * - MM-8: likely duplicates are badged and can be filtered.
 *
 * Every change goes through the project session, so it is undoable, saved and
 * followed by automatic reassignment.
 */
import {
  duplicateGroups, dropIntoChapter, itemInstant, localToUtc, overlapItems, previewClockOffset, setClockOffset, setUserTime, shiftUserTime,
  type Id, type MediaItem, type Travelogue,
} from '../core/index.js';
import { Api } from './api.js';
import { fill, h } from './dom.js';
import type { ProjectSession } from './session.js';

export interface MediaView {
  el: HTMLElement;
  update(): void;
  /** Ids currently selected (tests and other views). */
  selected(): Id[];
  select(ids: Id[]): void;
  dispose(): void;
}

type Filter = 'all' | 'unassigned' | 'uncertain' | 'overlap' | 'duplicate';
const FILTERS: [Filter, string][] = [['all', 'All'], ['unassigned', 'Unassigned'], ['uncertain', 'Time uncertain'], ['overlap', 'Overlaps'], ['duplicate', 'Duplicates']];

const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function mountMedia(s: ProjectSession, ctx: { projectId: string; play: (itemId: Id) => void }): MediaView {
  let selection = new Set<Id>();
  let anchor: Id | null = null;
  let filter: Filter = 'all';
  let derived = { dupes: new Map<Id, number>(), overlaps: new Set<Id>(), state: null as Travelogue | null };
  const tiles = new Map<Id, { el: HTMLElement; key: string }>();

  const summary = h('div', { class: 'media-summary', id: 'media-summary', role: 'status' });
  const filterBar = h('div', { class: 'media-filters', role: 'radiogroup', 'aria-label': 'Show' });
  const grid = h('div', { class: 'media-grid', id: 'media-grid' });
  const inspector = h('aside', { class: 'media-inspector card', id: 'media-inspector' });
  const sourcesBox = h('section', { class: 'media-sources', id: 'media-sources' });
  const el = h('main', { class: 'media', id: 'media' },
    h('section', { class: 'media-main' }, h('div', { class: 'media-toolbar' }, summary, filterBar), grid),
    h('div', { class: 'media-side' }, inspector, sourcesBox));

  const zoneFor = (p: Travelogue, m?: MediaItem) => (p.chapters.find((c) => c.id === m?.chapterId) ?? p.chapters[0])?.timeZone ?? deviceZone();
  const fmt = (t: number, tz: string, withYear = false) => Number.isNaN(t) ? '' : new Intl.DateTimeFormat(undefined, {
    timeZone: tz, ...(withYear ? { year: 'numeric' } : {}), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(t);
  /** datetime-local value for an instant in a zone. */
  const toInput = (t: number, tz: string) => {
    if (Number.isNaN(t)) return '';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(t).map((x) => [x.type, x.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
  };

  // ---------------------------------------------------------------- grid

  function visible(p: Travelogue, m: MediaItem): boolean {
    switch (filter) {
      case 'unassigned': return m.chapterId === null;
      case 'uncertain': return m.timestampConfidence === 'low' && !m.userTimestamp;
      case 'overlap': return derived.overlaps.has(m.id);
      case 'duplicate': return derived.dupes.has(m.id);
      default: return true;
    }
  }

  function tileFor(p: Travelogue, m: MediaItem): HTMLElement {
    const t = itemInstant(p, m);
    const tz = zoneFor(p, m);
    const ready = !m.status || m.status === 'ready';
    const dupe = derived.dupes.get(m.id);
    const key = JSON.stringify([m.status, m.assets?.thumb, t, tz, m.timestampConfidence, !!m.userTimestamp, dupe, derived.overlaps.has(m.id), m.kind, m.durationSec, m.uri]);
    const have = tiles.get(m.id);
    if (have && have.key === key) return have.el;
    const name = m.uri.split('/').pop() ?? m.uri;
    const badges = [
      m.userTimestamp && h('span', { class: 'badge user', title: 'Time set by hand' }, 'set'),
      m.timestampConfidence === 'low' && !m.userTimestamp && h('span', { class: 'badge low', title: 'Time taken from the file date, not the camera: it may be wrong' }, 'time?'),
      Number.isNaN(t) && h('span', { class: 'badge low', title: 'No capture time: set one, or drag it into a chapter' }, 'no time'),
      derived.overlaps.has(m.id) && h('span', { class: 'badge warn', title: 'Taken while two chapters overlap: placed in the earlier one' }, 'overlap'),
      dupe !== undefined && h('span', { class: 'badge warn', title: `Likely duplicate (group ${dupe})` }, `dup ${dupe}`),
      !ready && h('span', { class: `badge ${m.status}`, title: m.error ?? '' }, m.status ?? ''),
    ];
    const tileEl = h('figure', { class: 'tile', 'data-id': m.id, draggable: 'true', tabindex: '0', title: name },
      ready && m.assets?.thumb ? h('img', { src: Api.mediaUrl(ctx.projectId, m.id, 'thumb'), alt: '', loading: 'lazy', draggable: false })
        : h('div', { class: 'tile-placeholder' }, m.kind === 'audio' ? '♪' : m.kind === 'video' ? '▶' : ''),
      m.kind !== 'image' && h('span', { class: 'kind' }, m.kind === 'video' ? `▶ ${dur(m.durationSec)}` : `♪ ${dur(m.durationSec)}`),
      h('figcaption', {}, h('span', { class: 'when' }, Number.isNaN(t) ? name : fmt(t, tz)), h('span', { class: 'badges' }, ...badges)));
    tiles.set(m.id, { el: tileEl, key });
    return tileEl;
  }

  function render() {
    const p = s.state;
    if (derived.state !== p) derived = { dupes: duplicateGroups(p), overlaps: overlapItems(p), state: p };
    const byChapter = new Map<Id | null, MediaItem[]>([[null, []], ...p.chapters.map((c) => [c.id, []] as [Id, MediaItem[]])]);
    const order = new Map(p.cues.map((c) => [c.itemId, c.order]));
    for (const m of p.media) byChapter.get(m.chapterId)?.push(m) ?? byChapter.set(m.chapterId, [m]);
    const uncertain = p.media.filter((m) => m.timestampConfidence === 'low' && !m.userTimestamp).length;
    summary.textContent = `${p.media.length} items · ${byChapter.get(null)!.length} unassigned · ${uncertain} with uncertain times · ${derived.dupes.size} possible duplicates`;
    filterBar.replaceChildren(...FILTERS.map(([f, label]) => h('button', {
      role: 'radio', 'aria-checked': String(filter === f), class: filter === f ? 'on' : '', 'data-filter': f,
      onclick: () => { filter = f; render(); },
    }, label)));

    const sections: HTMLElement[] = [];
    const groups: [Id | null, string, string][] = [[null, 'Unassigned', 'Not in any chapter: no time, or a time outside every chapter'],
      ...p.chapters.map((c, i) => [c.id, `${i + 1}. ${c.title || 'Untitled chapter'}`, `${c.start.replace('T', ' ')} – ${c.end.replace('T', ' ')} · ${c.timeZone}`] as [Id, string, string])];
    for (const [cid, title, sub] of groups) {
      const all = (byChapter.get(cid) ?? []).slice().sort((a, b) => ((order.get(a.id) ?? '~') < (order.get(b.id) ?? '~') ? -1 : 1));
      if (cid === null && !all.length && filter === 'all') continue;
      const shown = all.filter((m) => visible(p, m));
      if (filter !== 'all' && !shown.length) continue;
      const body = h('div', { class: 'tiles' }, ...shown.map((m) => tileFor(p, m)));
      if (!shown.length) body.append(h('p', { class: 'muted empty' }, cid === null ? '' : 'No media yet. Drag items here to put them in this chapter.'));
      const sec = h('section', { class: `media-chapter${cid === null ? ' unassigned' : ''}`, 'data-chapter': cid ?? '' },
        h('header', {}, h('h3', {}, title, h('span', { class: 'count' }, ` ${all.length}`)), h('span', { class: 'muted' }, sub)),
        body);
      if (cid !== null) dropTarget(sec, cid);
      sections.push(sec);
    }
    if (!p.chapters.length) sections.unshift(h('p', { class: 'banner info' }, 'Add chapters in the Itinerary view first: media is sorted into chapters by time.'));
    grid.replaceChildren(...sections);
    for (const [id, t] of tiles) {
      if (!p.media.some((m) => m.id === id)) tiles.delete(id);
      else t.el.classList.toggle('selected', selection.has(id));
    }
    selection = new Set([...selection].filter((id) => p.media.some((m) => m.id === id)));
    renderInspector();
    renderSources();
  }

  // ---------------------------------------------------------------- selection

  const shownOrder = () => [...grid.querySelectorAll<HTMLElement>('.tile')].map((t) => t.dataset.id!);
  grid.addEventListener('click', (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile');
    if (!tile) {
      if (!(e.target as HTMLElement).closest('button')) setSelection([]);
      return;
    }
    const id = tile.dataset.id!;
    if (e.shiftKey && anchor) {
      const ids = shownOrder();
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
      setSelection([...new Set([...selection, ...ids.slice(a, b + 1)])]);
    } else if (e.metaKey || e.ctrlKey) {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id); else next.add(id);
      anchor = id;
      setSelection([...next]);
    } else {
      anchor = id;
      setSelection([id]);
    }
  });
  grid.addEventListener('dblclick', (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile');
    if (tile && s.state.media.find((m) => m.id === tile.dataset.id)?.chapterId) ctx.play(tile.dataset.id!);
  });
  grid.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setSelection([]);
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).classList.contains('tile')) {
      e.preventDefault();
      (e.target as HTMLElement).click();
    }
  });

  function setSelection(ids: Id[]) {
    selection = new Set(ids);
    for (const [id, t] of tiles) t.el.classList.toggle('selected', selection.has(id));
    renderInspector();
  }

  // ---------------------------------------------------------------- drag into a chapter (MM-5)

  grid.addEventListener('dragstart', (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile');
    if (!tile || !s.canEdit) return e.preventDefault();
    const id = tile.dataset.id!;
    if (!selection.has(id)) setSelection([id]);
    e.dataTransfer!.setData('application/x-tripalogue-items', JSON.stringify([...selection]));
    e.dataTransfer!.setData('text/plain', `${selection.size} item(s)`);
    e.dataTransfer!.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  grid.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    grid.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on'));
  });

  function dropTarget(sec: HTMLElement, chapterId: Id) {
    sec.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('application/x-tripalogue-items')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      grid.querySelectorAll('.drop-on').forEach((x) => x !== sec && x.classList.remove('drop-on'));
      sec.classList.add('drop-on');
    });
    sec.addEventListener('dragleave', (e) => {
      if (!sec.contains(e.relatedTarget as Node)) sec.classList.remove('drop-on');
    });
    sec.addEventListener('drop', (e) => {
      e.preventDefault();
      sec.classList.remove('drop-on');
      const raw = e.dataTransfer?.getData('application/x-tripalogue-items');
      if (!raw) return;
      const ids = JSON.parse(raw) as Id[];
      const before = (e.target as HTMLElement).closest<HTMLElement>('.tile')?.dataset.id;
      moveTo(ids, chapterId, before);
    });
  }

  function moveTo(ids: Id[], chapterId: Id, beforeId?: Id) {
    const ch = s.state.chapters.find((c) => c.id === chapterId);
    s.edit(`Move ${ids.length === 1 ? 'item' : `${ids.length} items`} to ${ch?.title || 'chapter'}`, (p) => dropIntoChapter(p, ids, chapterId, beforeId), { structural: true });
  }

  // ---------------------------------------------------------------- inspector (MM-5)

  function renderInspector() {
    const p = s.state;
    const items = p.media.filter((m) => selection.has(m.id));
    if (!items.length) {
      inspector.replaceChildren(h('h3', {}, 'Fix times'),
        h('p', { class: 'muted' }, 'Select items to set or shift their time, or drag them onto a chapter. Ctrl/Cmd-click adds to the selection, Shift-click selects a range.'));
      return;
    }
    const first = items[0];
    const tz = zoneFor(p, first);
    const times = items.map((m) => itemInstant(p, m)).filter((t) => !Number.isNaN(t));
    const earliest = times.length ? Math.min(...times) : NaN;
    const timeInput = h('input', { type: 'datetime-local', id: 'set-time', 'aria-label': `New time (${tz})`, value: toInput(earliest, tz) });
    const shiftSign = h('select', { id: 'shift-sign', 'aria-label': 'Earlier or later' }, h('option', { value: '1' }, 'later'), h('option', { value: '-1' }, 'earlier'));
    const shiftH = h('input', { type: 'number', id: 'shift-hours', min: '0', step: '1', value: '1', 'aria-label': 'Hours', class: 'num' });
    const shiftM = h('input', { type: 'number', id: 'shift-minutes', min: '0', max: '59', step: '1', value: '0', 'aria-label': 'Minutes', class: 'num' });
    const chapterSel = h('select', { id: 'move-chapter', 'aria-label': 'Chapter' }, ...p.chapters.map((c, i) => h('option', { value: c.id, selected: c.id === first.chapterId }, `${i + 1}. ${c.title || 'Untitled'}`)));
    const ids = items.map((m) => m.id);
    const editable = s.canEdit;
    const anyUser = items.some((m) => m.userTimestamp);
    const detail = items.length === 1 && itemDetail(p, first);
    fill(inspector,
      h('h3', {}, items.length === 1 ? (first.uri.split('/').pop() ?? first.uri) : `${items.length} items selected`),
      detail,
      h('div', { class: 'field' },
        h('label', { for: 'set-time' }, items.length === 1 ? 'Time' : 'Time of the earliest', h('span', { class: 'muted' }, ` (${tz})`)),
        h('div', { class: 'row' }, timeInput, h('button', {
          id: 'apply-time', disabled: !editable,
          onclick: () => {
            if (!timeInput.value) return;
            const at = localToUtc(timeInput.value, tz);
            s.edit(items.length === 1 ? 'Set time' : `Set time of ${items.length} items`, (q) => setUserTime(q, ids, at), { structural: true });
          },
        }, 'Set')),
        items.length > 1 && h('p', { class: 'muted small' }, 'The others keep their spacing from it.')),
      h('div', { class: 'field' },
        h('label', {}, 'Shift'),
        h('div', { class: 'row' }, shiftH, h('span', {}, 'h'), shiftM, h('span', {}, 'min'), shiftSign, h('button', {
          id: 'apply-shift', disabled: !editable,
          onclick: () => {
            const ms = (Number(shiftH.value || 0) * 60 + Number(shiftM.value || 0)) * 60_000 * Number(shiftSign.value);
            if (ms) s.edit(`Shift ${items.length === 1 ? 'item' : `${items.length} items`}`, (q) => shiftUserTime(q, ids, ms), { structural: true });
          },
        }, 'Shift'))),
      p.chapters.length > 0 && h('div', { class: 'field' },
        h('label', { for: 'move-chapter' }, 'Move to chapter'),
        h('div', { class: 'row' }, chapterSel, h('button', { id: 'apply-move', disabled: !editable, onclick: () => moveTo(ids, chapterSel.value) }, 'Move'))),
      anyUser && h('button', { id: 'clear-time', disabled: !editable, onclick: () => s.edit('Use camera time', (q) => setUserTime(q, ids, null), { structural: true }) }, 'Use the camera’s time again'),
      first.chapterId && items.length === 1 && h('button', { class: 'linkish', onclick: () => ctx.play(first.id) }, 'Play from here'),
    );
  }

  function itemDetail(p: Travelogue, m: MediaItem): HTMLElement {
    const src = p.sources.find((x) => x.id === m.sourceId);
    const tz = zoneFor(p, m);
    const rows: [string, string][] = [
      ['Kind', `${m.kind}${m.width ? ` · ${m.width}×${m.height}` : ''}${m.durationSec ? ` · ${dur(m.durationSec)}` : ''}`],
      ['Camera time', m.capturedAt ? `${m.capturedAt}${m.timestampConfidence === 'low' ? ' (from the file date)' : ''}` : 'none'],
      ...(src?.clockOffsetSec ? [['Clock offset', offsetLabel(src.clockOffsetSec)] as [string, string]] : []),
      ...(m.userTimestamp ? [['Set by hand', fmt(Date.parse(m.userTimestamp), tz, true)] as [string, string]] : []),
      ['Source', src?.displayName ?? '?'],
      ...(m.location ? [['Location', `${m.location.lat.toFixed(4)}, ${m.location.lng.toFixed(4)}`] as [string, string]] : []),
    ];
    return h('dl', { class: 'detail' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  }

  // ---------------------------------------------------------------- sources and clock offsets (MM-4)

  const draftOffsets = new Map<Id, number>();
  function renderSources() {
    const p = s.state;
    if (!p.sources.length) {
      sourcesBox.replaceChildren();
      return;
    }
    sourcesBox.replaceChildren(h('h3', {}, 'Sources and camera clocks'),
      h('p', { class: 'muted small' }, 'If a camera’s clock was wrong, set how far to move its times. You see how many items would change chapter before applying.'),
      ...p.sources.map((src) => {
        const count = p.media.filter((m) => m.sourceId === src.id).length;
        const draft = draftOffsets.get(src.id) ?? src.clockOffsetSec;
        const sign = h('select', { 'aria-label': `${src.displayName}: clock fast or slow` }, h('option', { value: '1', selected: draft >= 0 }, '+'), h('option', { value: '-1', selected: draft < 0 }, '−'));
        const hours = h('input', { type: 'number', min: '0', step: '1', class: 'num', value: String(Math.floor(Math.abs(draft) / 3600)), 'aria-label': `${src.displayName}: hours` });
        const mins = h('input', { type: 'number', min: '0', max: '59', step: '1', class: 'num', value: String(Math.round((Math.abs(draft) % 3600) / 60)), 'aria-label': `${src.displayName}: minutes` });
        const preview = h('p', { class: 'muted small preview', role: 'status' });
        const apply = h('button', { class: 'primary', disabled: true, 'data-source': src.id }, 'Apply');
        const read = () => Number(sign.value) * (Number(hours.value || 0) * 3600 + Number(mins.value || 0) * 60);
        const refresh = () => {
          const sec = read();
          draftOffsets.set(src.id, sec);
          const changed = sec !== src.clockOffsetSec;
          apply.disabled = !changed || !s.canEdit;
          if (!changed) {
            preview.textContent = src.clockOffsetSec ? `Times moved ${offsetLabel(src.clockOffsetSec)}.` : '';
            return;
          }
          const { moves } = previewClockOffset(s.state, src.id, sec);
          const name = (id: Id | null) => (id === null ? 'Unassigned' : s.state.chapters.find((c) => c.id === id)?.title || 'chapter');
          const routes = new Map<string, number>();
          for (const mv of moves) routes.set(`${name(mv.from)} → ${name(mv.to)}`, (routes.get(`${name(mv.from)} → ${name(mv.to)}`) ?? 0) + 1);
          preview.textContent = moves.length
            ? `Moving times ${offsetLabel(sec)} changes the chapter of ${moves.length} item${moves.length === 1 ? '' : 's'}: ${[...routes].map(([r, n]) => `${n} ${r}`).join('; ')}.`
            : `Moving times ${offsetLabel(sec)} changes no chapters.`;
        };
        for (const i of [sign, hours, mins]) i.addEventListener('input', refresh);
        apply.addEventListener('click', () => {
          const sec = read();
          draftOffsets.delete(src.id);
          s.edit(`Clock offset for ${src.displayName}`, (q) => setClockOffset(q, src.id, sec), { structural: true });
        });
        refresh();
        return h('div', { class: 'source', 'data-source': src.id },
          h('div', { class: 'row' }, h('strong', {}, src.displayName), h('span', { class: 'muted' }, ` ${count} item${count === 1 ? '' : 's'}`)),
          h('div', { class: 'row offset' }, h('span', { class: 'muted' }, 'Clock'), sign, hours, h('span', {}, 'h'), mins, h('span', {}, 'min'), apply),
          preview);
      }));
  }

  render();
  return {
    el,
    update: render,
    selected: () => [...selection],
    select: (ids) => setSelection(ids),
    dispose: () => tiles.clear(),
  };
}

const dur = (sec?: number) => {
  if (!sec) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function offsetLabel(sec: number): string {
  const a = Math.abs(sec);
  const hh = Math.floor(a / 3600), mm = Math.round((a % 3600) / 60);
  const text = [hh && `${hh} h`, mm && `${mm} min`].filter(Boolean).join(' ') || '0 min';
  return sec === 0 ? 'not at all' : `${sec > 0 ? 'later' : 'earlier'} by ${text}`;
}
