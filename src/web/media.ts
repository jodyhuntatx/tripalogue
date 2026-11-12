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
 * - MM-9 / MV-2: a media map with each item's location around its chapter's
 *   pin, items far from their chapter flagged; set a location from the
 *   chapter, by clicking the map, or by copying it from another item.
 * - MM-16 / MM-17: who sent what (contributor chips and filters), and a check
 *   per contributor for items without a time or place or that look like
 *   messaging-app copies, with a ready-to-send note asking for originals.
 *
 * Every change goes through the project session, so it is undoable, saved and
 * followed by automatic reassignment.
 */
import {
  contributorOf, contributorReports, duplicateGroups, dropIntoChapter, farFromChapter, itemInstant, localToUtc, messagingApp,
  originalsRequest, overlapItems, previewClockOffset, removeMedia, renameSource, restoreMedia, setClockOffset, setItemLocation, setVideoTrim, MIN_CLIP_SEC, setSourceContributor, setUserTime, shiftUserTime,
  strippedSigns, type ContributorReport, type Id, type LatLng, type MediaItem, type Travelogue,
} from '../core/index.js';
import { Api } from './api.js';
import { fill, h } from './dom.js';
import { RouteMap } from './map.js';
import type { ProjectSession } from './session.js';

export interface MediaView {
  el: HTMLElement;
  update(): void;
  /** Ids currently selected (tests and other views). */
  selected(): Id[];
  select(ids: Id[]): void;
  dispose(): void;
}

type Filter = 'all' | 'unassigned' | 'uncertain' | 'overlap' | 'duplicate' | 'far';
const FILTERS: [Filter, string][] = [['all', 'All'], ['unassigned', 'Unassigned'], ['uncertain', 'Time uncertain'], ['overlap', 'Overlaps'], ['duplicate', 'Duplicates'], ['far', 'Far from chapter']];

interface Member { userId: string; name: string; email: string }

const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function mountMedia(s: ProjectSession, ctx: { projectId: string; play: (itemId: Id) => void; map: { tiles: boolean; attribution: string }; purgeAfterDays: number }): MediaView {
  let selection = new Set<Id>();
  let anchor: Id | null = null;
  let filter: Filter = 'all';
  let derived = { dupes: new Map<Id, number>(), overlaps: new Set<Id>(), far: new Map<Id, number>(), state: null as Travelogue | null };
  /** A focused subset from the contributor check ("Ana · no location"), shown on top of the filter. */
  let focus: { label: string; ids: Set<Id> } | null = null;
  let members: Member[] = [];
  let copiedPlace: LatLng | null = null;
  let binOpen = false;
  let picking = false;
  void Api.members(ctx.projectId).then((r) => { members = r.members; render(); }).catch(() => {});
  const memberName = (id: Id | null) => (id === null ? 'No traveler named' : members.find((m) => m.userId === id)?.name ?? 'A traveler');
  const tiles = new Map<Id, { el: HTMLElement; key: string }>();

  const summary = h('div', { class: 'media-summary', id: 'media-summary', role: 'status' });
  const filterBar = h('div', { class: 'media-filters', role: 'radiogroup', 'aria-label': 'Show' });
  const grid = h('div', { class: 'media-grid', id: 'media-grid' });
  const inspector = h('aside', { class: 'media-inspector card', id: 'media-inspector' });
  const sourcesBox = h('section', { class: 'media-sources', id: 'media-sources' });
  const contribBox = h('section', { class: 'media-contributors', id: 'media-contributors' });
  const focusBar = h('div', { class: 'media-focus', id: 'media-focus' });
  const mapHint = h('p', { class: 'muted small', id: 'media-map-hint' });
  const map = new RouteMap({
    tileUrl: ctx.map.tiles ? (z, x, y) => `/api/tiles/${z}/${x}/${y}` : undefined,
    attribution: ctx.map.attribution,
    onDot: (id) => { anchor = id; setSelection([id]); tiles.get(id)?.el.scrollIntoView({ block: 'nearest' }); },
    onPick: (lat, lng) => {
      const ids = [...selection];
      setPicking(false);
      if (ids.length) s.edit(ids.length === 1 ? 'Set location' : `Set location of ${ids.length} items`, (p) => setItemLocation(p, ids, { lat, lng }), { structural: true });
    },
  });
  map.el.classList.add('media-map');
  map.el.id = 'media-map';
  const mapBox = h('section', { class: 'media-map-box card' }, h('h3', {}, 'Where'), map.el, mapHint);
  const el = h('main', { class: 'media', id: 'media' },
    h('section', { class: 'media-main' }, h('div', { class: 'media-toolbar' }, summary, filterBar), focusBar, grid),
    h('div', { class: 'media-side' }, inspector, mapBox, contribBox, sourcesBox));

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
      case 'far': return derived.far.has(m.id);
      default: return true;
    }
  }

  function tileFor(p: Travelogue, m: MediaItem): HTMLElement {
    const t = itemInstant(p, m);
    const tz = zoneFor(p, m);
    const ready = !m.status || m.status === 'ready';
    const dupe = derived.dupes.get(m.id);
    const far = derived.far.get(m.id);
    const who = contributorOf(p, m);
    const multi = new Set(p.sources.map((x) => x.contributorId ?? null)).size > 1;
    const copy = strippedSigns(m);
    const key = JSON.stringify([m.status, m.assets?.thumb, t, tz, m.timestampConfidence, !!m.userTimestamp, dupe, derived.overlaps.has(m.id), m.kind, m.durationSec, m.uri, far, multi && who, memberName(who), copy, !!m.location]);
    const have = tiles.get(m.id);
    if (have && have.key === key) return have.el;
    const name = m.uri.split('/').pop() ?? m.uri;
    const badges = [
      m.userTimestamp && h('span', { class: 'badge user', title: 'Time set by hand' }, 'set'),
      m.timestampConfidence === 'low' && !m.userTimestamp && h('span', { class: 'badge low', title: 'Time taken from the file date, not the camera: it may be wrong' }, 'time?'),
      Number.isNaN(t) && h('span', { class: 'badge low', title: 'No capture time: set one, or drag it into a chapter' }, 'no time'),
      derived.overlaps.has(m.id) && h('span', { class: 'badge warn', title: 'Taken while two chapters overlap: placed in the earlier one' }, 'overlap'),
      dupe !== undefined && h('span', { class: 'badge warn', title: `Likely duplicate (group ${dupe})` }, `dup ${dupe}`),
      far !== undefined && h('span', { class: 'badge warn', title: `Taken ${far} km from this chapter’s place: is it in the right chapter?` }, `${far} km`),
      ready && copy.length > 0 && h('span', { class: 'badge low', title: copyReason(m) }, 'copy?'),
      !ready && h('span', { class: `badge ${m.status}`, title: m.error ?? '' }, m.status ?? ''),
    ];
    const binned = (p.removed ?? []).some((r) => r.item.id === m.id);
    const tileEl = h('figure', { class: binned ? 'tile removed' : 'tile', 'data-id': m.id, draggable: binned ? 'false' : 'true', tabindex: '0', title: name },
      ready && m.assets?.thumb ? h('img', { src: Api.mediaUrl(ctx.projectId, m.id, 'thumb'), alt: '', loading: 'lazy', draggable: false })
        : h('div', { class: 'tile-placeholder' }, m.kind === 'audio' ? '♪' : m.kind === 'video' ? '▶' : ''),
      m.kind !== 'image' && h('span', { class: 'kind' }, m.kind === 'video' ? `▶ ${dur(m.durationSec)}` : `♪ ${dur(m.durationSec)}`),
      multi && h('span', { class: 'who', title: memberName(who) }, initials(memberName(who))),
      h('figcaption', {}, h('span', { class: 'when' }, Number.isNaN(t) ? name : fmt(t, tz)), h('span', { class: 'badges' }, ...badges)));
    tiles.set(m.id, { el: tileEl, key });
    return tileEl;
  }

  function render() {
    const p = s.state;
    if (derived.state !== p) derived = { dupes: duplicateGroups(p), overlaps: overlapItems(p), far: farFromChapter(p), state: p };
    if (focus) focus.ids = new Set([...focus.ids].filter((id) => p.media.some((m) => m.id === id)));
    fill(focusBar, focus && h('span', { class: 'chip' }, `Showing: ${focus.label} (${focus.ids.size})`, h('button', { class: 'icon', 'aria-label': 'Show everything', id: 'clear-focus', onclick: () => { focus = null; render(); } }, '×')));
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
      const shown = all.filter((m) => visible(p, m) && (!focus || focus.ids.has(m.id)));
      if ((filter !== 'all' || focus) && !shown.length) continue;
      const body = h('div', { class: 'tiles' }, ...shown.map((m) => tileFor(p, m)));
      if (!shown.length) body.append(h('p', { class: 'muted empty' }, cid === null ? '' : 'No media yet. Drag items here to put them in this chapter.'));
      const sec = h('section', { class: `media-chapter${cid === null ? ' unassigned' : ''}`, 'data-chapter': cid ?? '' },
        h('header', {}, h('h3', {}, title, h('span', { class: 'count' }, ` ${all.length}`)), h('span', { class: 'muted' }, sub)),
        body);
      if (cid !== null) dropTarget(sec, cid);
      sections.push(sec);
    }
    if (!p.chapters.length) sections.unshift(h('p', { class: 'banner info' }, 'Add chapters in the Itinerary view first: media is sorted into chapters by time.'));
    // The Removed bin, last and folded: put items back, or delete them for good.
    const binned = (p.removed ?? []).slice().sort((a, b) => (a.removedAt < b.removedAt ? 1 : -1));
    if (binned.length) {
      const binEl = h('details', { class: 'media-chapter removed-bin', id: 'removed-bin', ...(binOpen ? { open: true } : {}) },
        h('summary', {}, h('h3', {}, 'Removed', h('span', { class: 'count' }, ` ${binned.length}`)),
          h('span', { class: 'muted' }, ` Not in the travelogue. Each is deleted for good ${ctx.purgeAfterDays} days after it was removed.`)),
        h('div', { class: 'tiles' }, ...binned.map((r) => tileFor(p, r.item))));
      binEl.addEventListener('toggle', () => { binOpen = binEl.open; });
      sections.push(binEl);
    }
    grid.replaceChildren(...sections);
    const ids = new Set([...p.media.map((m) => m.id), ...binned.map((r) => r.item.id)]);
    for (const [id, t] of tiles) {
      if (!ids.has(id)) tiles.delete(id);
      else t.el.classList.toggle('selected', selection.has(id));
    }
    selection = new Set([...selection].filter((id) => ids.has(id)));
    renderInspector();
    renderSources();
    renderContributors();
    renderMap();
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size && s.canEdit) {
      e.preventDefault();
      const live = [...selection].filter((id) => s.state.media.some((m) => m.id === id));
      if (live.length) removeSelected(live);
    }
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).classList.contains('tile')) {
      e.preventDefault();
      (e.target as HTMLElement).click();
    }
  });

  function setSelection(ids: Id[]) {
    selection = new Set(ids);
    for (const [id, t] of tiles) t.el.classList.toggle('selected', selection.has(id));
    if (!selection.size && picking) setPicking(false);
    renderInspector();
    renderMap();
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

  // Panels with inputs are rebuilt only when what they show changes, so typing is never wiped by an unrelated update
  // (an autosave, another item finishing processing).
  let inspectorKey = '';
  let sourcesKey = '';

  function removeSelected(ids: Id[]) {
    s.edit(ids.length === 1 ? 'Remove item' : `Remove ${ids.length} items`, (q) => removeMedia(q, ids, new Date().toISOString(), s.me.id), { structural: true });
    setSelection([]);
  }

  function renderInspector() {
    const p = s.state;
    const items = p.media.filter((m) => selection.has(m.id));
    const inBin = (p.removed ?? []).filter((r) => selection.has(r.item.id));
    const key = JSON.stringify([items.map((m) => [m.id, m.userTimestamp, m.capturedAt, m.location, m.chapterId, m.sourceId, m.uri, m.status]),
      p.chapters.map((c) => [c.id, c.title, c.timeZone, !!c.coordinates]), p.sources.map((x) => [x.id, x.clockOffsetSec, x.displayName]), s.canEdit, copiedPlace, picking,
      items.length === 1 && first0Trim(p, items[0])]);
    if (key === inspectorKey && !inBin.length) return;
    inspectorKey = key;
    if (inBin.length && !items.length) return renderBinInspector(inBin);
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
      items.length === 1 && first.kind === 'video' && trimField(p, first),
      locationField(p, items),
      p.chapters.length > 0 && h('div', { class: 'field' },
        h('label', { for: 'move-chapter' }, 'Move to chapter'),
        h('div', { class: 'row' }, chapterSel, h('button', { id: 'apply-move', disabled: !editable, onclick: () => moveTo(ids, chapterSel.value) }, 'Move'))),
      anyUser && h('button', { id: 'clear-time', disabled: !editable, onclick: () => s.edit('Use camera time', (q) => setUserTime(q, ids, null), { structural: true }) }, 'Use the camera’s time again'),
      first.chapterId && items.length === 1 && h('button', { class: 'linkish', onclick: () => ctx.play(first.id) }, 'Play from here'),
      h('div', { class: 'field remove-field' },
        h('button', { id: 'remove-items', class: 'danger-outline', disabled: !editable, onclick: () => removeSelected(ids) },
          items.length === 1 ? 'Remove from the travelogue' : `Remove ${items.length} items from the travelogue`),
        h('p', { class: 'muted small' }, `Removed items go to the Removed bin at the bottom, where you can put them back for ${ctx.purgeAfterDays} days.`)),
    );
  }

  /** What the trim field shows, for the inspector's rebuild key. */
  function first0Trim(p: Travelogue, m: MediaItem) {
    if (m.kind !== 'video') return null;
    const c = p.cues.find((x) => x.itemId === m.id);
    return [m.durationSec, m.assets?.proxy, c?.inPointSec, c?.outPointSec, c?.speed];
  }

  /** PE-5: a video plays in full by default; trim it from the beginning and/or the end. */
  function trimField(p: Travelogue, m: MediaItem): HTMLElement | null {
    const cue = p.cues.find((c) => c.itemId === m.id);
    if (!cue) return null;
    const len = m.durationSec;
    const inPt = cue.inPointSec ?? 0;
    const outPt = cue.outPointSec ?? len;
    const editable = s.canEdit && len !== undefined;
    const sec = (n: number | undefined) => (n === undefined ? '' : n.toFixed(1));
    const startIn = h('input', { type: 'number', id: 'trim-start', class: 'num', min: '0', step: '0.1', max: len !== undefined ? String(len) : undefined, value: sec(inPt), disabled: !editable, 'aria-label': 'Start at (seconds)' });
    const endIn = h('input', { type: 'number', id: 'trim-end', class: 'num', min: '0', step: '0.1', max: len !== undefined ? String(len) : undefined, value: sec(outPt), disabled: !editable, 'aria-label': 'End at (seconds)' });
    const apply = (a: number, b: number | null, label: string) => s.edit(label, (q) => setVideoTrim(q, m.id, a, b));
    const endVal = () => (endIn.value === '' ? null : Number(endIn.value));
    startIn.addEventListener('change', () => apply(Number(startIn.value || 0), cue.outPointSec ?? null, 'Trim start'));
    endIn.addEventListener('change', () => apply(cue.inPointSec ?? 0, endVal(), 'Trim end'));
    const ready = (!m.status || m.status === 'ready') && m.assets?.proxy;
    const video = ready ? h('video', { id: 'trim-video', src: Api.mediaUrl(ctx.projectId, m.id, 'proxy'), controls: true, preload: 'metadata', muted: true, playsinline: true, class: 'trim-video' }) as HTMLVideoElement : null;
    if (video) video.addEventListener('loadedmetadata', () => { if (inPt > 0) video.currentTime = inPt; }, { once: true });
    const trimmed = inPt > 0 || cue.outPointSec !== undefined;
    const plays = len === undefined ? 'Plays in full once the video is processed.'
      : `Plays ${((outPt! - inPt) / (cue.speed || 1)).toFixed(1)} s${trimmed ? ` of ${len.toFixed(1)} s` : ' (the whole video)'}${cue.speed && cue.speed !== 1 ? ` at ${cue.speed}× speed` : ''}.`;
    return h('div', { class: 'field trim-field', id: 'trim-field' },
      h('label', {}, 'Play'),
      video,
      h('div', { class: 'row' }, h('label', { for: 'trim-start', class: 'small' }, 'From'), startIn, h('span', { class: 'small' }, 's'),
        h('label', { for: 'trim-end', class: 'small' }, 'to'), endIn, h('span', { class: 'small' }, 's')),
      video && editable && h('div', { class: 'row' },
        h('button', { id: 'trim-start-here', onclick: () => apply(video.currentTime, cue.outPointSec ?? null, 'Trim start') }, 'Start here'),
        h('button', { id: 'trim-end-here', onclick: () => apply(cue.inPointSec ?? 0, video.currentTime, 'Trim end') }, 'End here')),
      h('p', { class: 'muted small', id: 'trim-summary' }, plays),
      trimmed && editable && h('button', { id: 'trim-reset', class: 'linkish', onclick: () => apply(0, null, 'Play whole video') }, 'Play the whole video'),
      editable && h('p', { class: 'muted small' }, `Shortest: ${MIN_CLIP_SEC} s.`));
  }

  function renderBinInspector(entries: NonNullable<Travelogue['removed']>) {
    const ids = entries.map((r) => r.item.id);
    const editable = s.canEdit;
    const until = (r: (typeof entries)[number]) => new Date(Date.parse(r.removedAt) + ctx.purgeAfterDays * 86_400_000)
      .toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const msg = h('p', { class: 'form-msg', role: 'status' });
    fill(inspector,
      h('h3', {}, entries.length === 1 ? (entries[0].item.uri.split('/').pop() ?? entries[0].item.uri) : `${entries.length} removed items`),
      h('p', { class: 'muted small' }, entries.length === 1
        ? `Removed ${new Date(entries[0].removedAt).toLocaleString()}. Deleted for good on ${until(entries[0])} unless you put it back.`
        : `Deleted for good from ${until(entries.reduce((a, b) => (a.removedAt < b.removedAt ? a : b)))} unless you put them back.`),
      h('div', { class: 'row' },
        h('button', { class: 'primary', id: 'restore-items', disabled: !editable, onclick: () => {
          s.edit(entries.length === 1 ? 'Put back' : `Put back ${entries.length} items`, (q) => restoreMedia(q, ids), { structural: true });
          setSelection(ids);
        } }, 'Put back'),
        h('button', { class: 'danger', id: 'purge-items', disabled: !editable, onclick: async () => {
          const what = entries.length === 1 ? 'this item' : `these ${entries.length} items`;
          if (!confirm(`Delete ${what} for good? Their original files are erased and they cannot be brought back, not even from a saved version.`)) return;
          try {
            await s.flush(); // the item must be in the bin on the server first
            await Api.purgeMedia(ctx.projectId, ids);
            setSelection([]);
            await s.poll();
          } catch (e) {
            msg.textContent = (e as Error).message;
          }
        } }, 'Delete for good now')),
      msg);
  }

  // ---------------------------------------------------------------- location (MM-9) and the media map (MV-2)

  function locationField(p: Travelogue, items: MediaItem[]): HTMLElement {
    const ids = items.map((m) => m.id);
    const located = items.filter((m) => m.location);
    const one = items.length === 1 ? items[0] : null;
    const ch = p.chapters.find((c) => c.id === (one ?? items[0]).chapterId);
    const set = (label: string, loc: LatLng | null) => s.edit(label, (q) => setItemLocation(q, ids, loc), { structural: true });
    const editable = s.canEdit;
    const status = one
      ? (one.location ? `${one.location.lat.toFixed(4)}, ${one.location.lng.toFixed(4)}` : 'No location')
      : `${located.length} of ${items.length} have a location`;
    return h('div', { class: 'field', id: 'location-field' },
      h('label', {}, 'Location ', h('span', { class: 'muted', id: 'location-status' }, status)),
      h('div', { class: 'row' },
        ch?.coordinates && h('button', { id: 'loc-chapter', disabled: !editable, title: `Use ${ch.locationName || ch.title}`, onclick: () => set('Set location from chapter', ch.coordinates!) }, 'Chapter’s place'),
        h('button', { id: 'loc-pick', disabled: !editable, 'aria-pressed': String(picking), onclick: () => setPicking(!picking) }, picking ? 'Cancel pick' : 'Pick on map'),
        one?.location && h('button', { id: 'loc-copy', onclick: () => { copiedPlace = one.location!; renderInspector(); } }, 'Copy'),
        copiedPlace && h('button', { id: 'loc-paste', disabled: !editable, title: `${copiedPlace.lat.toFixed(4)}, ${copiedPlace.lng.toFixed(4)}`, onclick: () => set('Paste location', copiedPlace) }, 'Paste'),
        located.length > 0 && h('button', { id: 'loc-clear', disabled: !editable, onclick: () => set('Clear location', null) }, 'Clear')));
  }

  function setPicking(on: boolean) {
    picking = on && selection.size > 0;
    map.setPickMode(picking, `Click the map to place ${selection.size === 1 ? 'this item' : `${selection.size} items`}`);
    renderInspector();
  }

  function renderMap() {
    const p = s.state;
    map.setPins(p.chapters.flatMap((c, i) => (c.coordinates ? [{ id: c.id, index: i, lat: c.coordinates.lat, lng: c.coordinates.lng, title: c.title }] : [])));
    map.setDots(p.media.filter((m) => m.location).map((m) => ({
      id: m.id, lat: m.location!.lat, lng: m.location!.lng,
      state: selection.has(m.id) ? 'selected' as const : derived.far.has(m.id) ? 'far' as const : m.chapterId === null ? 'unassigned' as const : undefined,
    })));
    const located = p.media.filter((m) => m.location).length;
    mapHint.textContent = picking ? 'Click the map to set the location.'
      : `${located} of ${p.media.length} items have a location${derived.far.size ? ` · ${derived.far.size} far from their chapter (amber)` : ''}. Click a dot to select its item.`;
  }

  // ---------------------------------------------------------------- contributors (MM-16, MM-17)

  function renderContributors() {
    const p = s.state;
    const reports = contributorReports(p);
    if (!reports.length) {
      fill(contribBox);
      return;
    }
    const show = (label: string, ids: Id[]) => { focus = { label, ids: new Set(ids) }; filter = 'all'; render(); grid.scrollIntoView({ block: 'start' }); };
    fill(contribBox, h('h3', {}, 'Contributors'),
      h('p', { class: 'muted small' }, 'Who sent what, and what is missing. Copies from chat apps lose the time and place: ask for the originals.'),
      ...reports.map((r) => {
        const name = memberName(r.contributorId);
        const mine = p.media.filter((m) => contributorOf(p, m) === r.contributorId).map((m) => m.id);
        const issue = (ids: Id[], text: string, id: string) => ids.length > 0 && h('li', {}, h('button', { class: 'linkish', 'data-check': id, onclick: () => show(`${name} · ${text}`, ids) }, `${ids.length} ${text}`));
        const clean = !r.noTime.length && !r.noPlace.length && !r.stripped.length;
        return h('div', { class: 'contributor', 'data-contributor': r.contributorId ?? '' },
          h('div', { class: 'row' }, h('span', { class: 'who' }, initials(name)), h('button', { class: 'linkish strong', onclick: () => show(name, mine) }, name), h('span', { class: 'muted' }, ` ${r.total} item${r.total === 1 ? '' : 's'}`)),
          clean ? h('p', { class: 'ok small' }, 'Everything has a time and a place.')
            : h('ul', { class: 'checks' },
              issue(r.noTime, 'without a capture time', 'noTime'),
              issue(r.noPlace, 'without a location', 'noPlace'),
              issue(r.stripped, `look like copies${r.apps.length ? ` (${r.apps.join(', ')})` : ''}`, 'stripped')),
          !clean && r.contributorId !== null && h('button', { class: 'ask', 'data-ask': r.contributorId, onclick: () => askFor(r) }, `Ask ${name.split(' ')[0]} for originals`));
      }));
  }

  function askFor(r: ContributorReport) {
    const p = s.state;
    const who = members.find((m) => m.userId === r.contributorId);
    const meName = s.me.name;
    const text = originalsRequest(r, { name: (who?.name ?? 'there').split(' ')[0], trip: p.title, from: meName });
    const area = h('textarea', { id: 'ask-text', rows: '14', 'aria-label': 'Message' });
    area.value = text;
    const dialog = h('dialog', { class: 'card ask-dialog', id: 'ask-dialog' },
      h('h3', {}, `Ask ${who?.name ?? 'them'} for the originals`),
      h('p', { class: 'muted small' }, 'Edit as you like, then copy it into a message or open it in your email.'),
      area,
      h('div', { class: 'row' },
        h('button', { class: 'primary', id: 'ask-copy', onclick: async () => {
          try { await navigator.clipboard.writeText(area.value); (document.getElementById('ask-copy') as HTMLButtonElement).textContent = 'Copied'; } catch { area.select(); }
        } }, 'Copy'),
        who?.email && h('a', { class: 'button', id: 'ask-email', href: `mailto:${encodeURIComponent(who.email)}?subject=${encodeURIComponent(`Originals for "${p.title}"`)}&body=${encodeURIComponent(area.value)}` }, 'Open in email'),
        h('button', { id: 'ask-close', onclick: () => { dialog.close(); dialog.remove(); } }, 'Close')));
    document.body.append(dialog);
    dialog.showModal();
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
    const key = JSON.stringify([p.sources, p.media.map((m) => m.sourceId), p.chapters.map((c) => [c.id, c.start, c.end, c.timeZone]), members, s.canEdit]);
    if (key === sourcesKey) return;
    sourcesKey = key;
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
        const traveler = h('select', { 'aria-label': `${src.displayName}: traveler`, class: 'traveler', disabled: !s.canEdit,
          onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; s.edit('Set traveler', (q) => setSourceContributor(q, src.id, v || null)); } },
          h('option', { value: '' }, 'No traveler named'),
          ...members.map((m) => h('option', { value: m.userId, selected: m.userId === src.contributorId }, m.name)));
        const nameInput = h('input', { value: src.displayName, class: 'source-name', 'aria-label': 'Source name', readOnly: !s.canEdit,
          onchange: (e: Event) => s.edit('Rename source', (q) => renameSource(q, src.id, (e.target as HTMLInputElement).value)) });
        return h('div', { class: 'source', 'data-source': src.id },
          h('div', { class: 'row' }, nameInput, h('span', { class: 'muted' }, ` ${count} item${count === 1 ? '' : 's'}`)),
          h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Traveler'), traveler),
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
    dispose: () => { tiles.clear(); map.destroy(); },
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

function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function copyReason(m: MediaItem): string {
  const why = strippedSigns(m).map((x) => (x === 'small' ? `only ${Math.max(m.width ?? 0, m.height ?? 0)} px` : x === 'lowVideo' ? '720p or less' : `named like a ${messagingApp(m.uri)} copy`));
  return `Looks like a reduced copy (${why.join(', ')}): the original may have more detail and keep the time and place.`;
}

