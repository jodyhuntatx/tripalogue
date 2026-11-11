/**
 * Itinerary editor (Phase 1, IT-1 to IT-8 and MV-1).
 *
 * Chapters are edited in place as cards; every change goes through the
 * project session (undo, autosave, operation log). The timeline and route map
 * redraw from the same state, and issues (overlaps, gaps, order) are listed
 * above the cards and marked on them.
 */
import {
  analyzeItinerary, appendDrafts, chapterSpan, describeIssue, insertChapter, isValidTimeZone, mergeChapters, moveChapter, newChapter,
  parseItinerary, removeChapter, sortChapters, splitChapter, timeZones, deviceTimeZone, updateChapter,
  type Chapter, type ChapterDraft, type ItineraryIssue, type Travelogue,
} from '../core/index.js';
import { Api } from './api.js';
import { RouteMap } from './map.js';
import type { ProjectSession } from './session.js';

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

export interface ItineraryContext {
  map: { tiles: boolean; search: boolean; attribution: string };
  /** Switch to the Play view at a time (seconds). */
  preview: (chapterId: string) => void;
}

export interface ItineraryView {
  el: HTMLElement;
  update(): void;
  dispose(): void;
  map: RouteMap;
  select(id: string | null): void;
}

const fmtDay = (local: string) => {
  const d = new Date(`${local.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? local : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

export function mountItinerary(s: ProjectSession, ctx: ItineraryContext): ItineraryView {
  let selected: string | null = null;
  let pickFor: string | null = null;
  const cards = new Map<string, CardHandle>();

  const zoneList = h('datalist', { id: 'tz-list' }, ...timeZones().map((z) => h('option', { value: z })));
  const issuesBox = h('div', { class: 'issues', id: 'itinerary-issues', role: 'status', 'aria-live': 'polite' });
  const list = h('ol', { class: 'chapter-cards', id: 'chapter-cards' });
  const empty = h('div', { class: 'empty card' },
    h('h3', {}, 'Start with your itinerary'),
    h('p', { class: 'muted' }, 'Add a chapter for each stop of the trip, or paste the whole itinerary at once (one line per day or stop).'));
  const importPanel = h('div', { class: 'import-panel card', hidden: true, id: 'import-panel' });
  const addBtn = h('button', { class: 'primary', id: 'add-chapter', onclick: () => addChapter() }, '+ Add chapter');
  const importBtn = h('button', { id: 'open-import', onclick: () => toggleImport() }, 'Paste or import itinerary');
  const sortBtn = h('button', { id: 'sort-chapters', onclick: () => s.edit('Sort chapters by date', sortChapters, { structural: true }) }, 'Sort by date');
  const playBtn = h('button', { id: 'play-title-cards', onclick: () => s.state.chapters[0] && ctx.preview(s.state.chapters[0].id) }, '▶ Play');
  const timeline = h('div', { class: 'itinerary-timeline', id: 'itinerary-timeline', 'aria-label': 'Chapter timeline' });

  const map = new RouteMap({
    tileUrl: ctx.map.tiles ? (z, x, y) => `/api/tiles/${z}/${x}/${y}` : undefined,
    attribution: ctx.map.attribution,
    onSelect: (id) => select(id, true),
    onPick: (lat, lng) => {
      if (!pickFor) return;
      const id = pickFor;
      setPick(null);
      s.edit('Place pin', (p) => updateChapter(p, id, { coordinates: { lat, lng } }), { structural: true });
    },
  });

  const el = h('div', { class: 'itinerary', id: 'itinerary' },
    zoneList,
    h('section', { class: 'itinerary-main' },
      h('div', { class: 'row toolbar' }, addBtn, importBtn, sortBtn, playBtn),
      importPanel, issuesBox, empty, list),
    h('section', { class: 'itinerary-side' }, map.el, timeline));

  function addChapter() {
    const c = newChapter(s.state);
    s.edit('Add chapter', (p) => insertChapter(p, c), { structural: true });
    select(c.id, true);
    setTimeout(() => cards.get(c.id)?.focusTitle(), 50);
  }

  function setPick(id: string | null) {
    pickFor = id;
    const ch = s.state.chapters.find((c) => c.id === id);
    map.setPickMode(!!id, ch ? `Click the map to place ${ch.title || 'this chapter'} · Esc to cancel` : '');
    for (const [cid, card] of cards) card.setPicking(cid === id);
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && pickFor) setPick(null); };
  addEventListener('keydown', onKey);

  function select(id: string | null, scroll = false) {
    selected = id;
    map.setSelected(id);
    for (const [cid, card] of cards) card.el.classList.toggle('selected', cid === id);
    timeline.querySelectorAll<HTMLElement>('.block').forEach((b) => b.classList.toggle('selected', b.dataset.id === id));
    if (scroll && id) cards.get(id)?.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---- import (IT-6) ----
  function toggleImport() {
    if (!importPanel.hidden) return void (importPanel.hidden = true);
    importPanel.hidden = false;
    const text = h('textarea', { rows: 8, id: 'import-text', placeholder: 'May 1, 2026, Lisbon, arrive and explore Alfama\n2026-05-04, Sintra, palaces\nMay 5-7, 2026 Porto - bookshops and port lodges\n\nor a CSV with columns such as Date, Location, Notes, Time zone', 'aria-label': 'Itinerary text' });
    const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain', 'aria-label': 'Itinerary file', id: 'import-file' });
    const tz = h('input', { list: 'tz-list', value: s.state.chapters.at(-1)?.timeZone ?? deviceTimeZone(), 'aria-label': 'Time zone for rows without one', class: 'tz', id: 'import-tz' });
    const preview = h('div', { class: 'import-preview', id: 'import-preview' });
    const add = h('button', { class: 'primary', id: 'import-add', disabled: true }, 'Add chapters');
    let drafts: ChapterDraft[] = [];
    const run = () => {
      const zone = isValidTimeZone(tz.value) ? tz.value : deviceTimeZone();
      const r = parseItinerary(text.value, zone);
      drafts = r.chapters;
      add.disabled = !drafts.length || !s.canEdit;
      add.textContent = drafts.length ? `Add ${drafts.length} chapter${drafts.length === 1 ? '' : 's'}` : 'Add chapters';
      preview.replaceChildren(
        drafts.length ? h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Chapter'), h('th', {}, 'Place'), h('th', {}, 'Dates'), h('th', {}, 'Notes'))),
          h('tbody', {}, ...drafts.map((d, i) => h('tr', {},
            h('td', {}, String(s.state.chapters.length + i + 1)), h('td', {}, d.title), h('td', {}, d.locationName),
            h('td', {}, d.start.slice(0, 10) === d.end.slice(0, 10) ? fmtDay(d.start) : `${fmtDay(d.start)} – ${fmtDay(d.end)}`),
            h('td', { class: 'muted' }, d.description))))) : '',
        r.merged ? h('p', { class: 'muted small' }, r.merged === 1 ? 'Two consecutive days in the same place were combined into one chapter.' : `${r.merged} repeated days in the same place were folded into the chapter before them.`) : '',
        ...r.errors.map((e) => h('p', { class: 'error small' }, `Line ${e.line}: ${e.message}`)),
        /\d+\/\d+/.test(text.value) ? h('p', { class: 'muted small' }, 'Numeric dates are read as month/day/year.') : '',
      );
    };
    let t = 0;
    text.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(run, 150); });
    tz.addEventListener('change', run);
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (f) { text.value = await f.text(); run(); }
    });
    add.addEventListener('click', () => {
      if (!drafts.length) return;
      const before = new Set(s.state.chapters.map((c) => c.id));
      s.edit(`Import ${drafts.length} chapters`, (p) => appendDrafts(p, drafts), { structural: true });
      importPanel.hidden = true;
      const first = s.state.chapters.find((c) => !before.has(c.id));
      if (first) select(first.id, true);
    });
    importPanel.replaceChildren(
      h('h3', {}, 'Paste or import an itinerary'),
      h('p', { class: 'muted small' }, 'One line per day or stop: a date (or date range), a place, and optional notes. Or choose a CSV file. Nothing changes until you add the chapters, and you can undo it.'),
      text,
      h('div', { class: 'row' }, h('label', {}, 'File ', file), h('label', {}, 'Time zone ', tz)),
      preview,
      h('div', { class: 'row' }, add, h('button', { onclick: () => (importPanel.hidden = true) }, 'Cancel')),
    );
    text.focus();
  }

  // ---- timeline (IT-4) ----
  function renderTimeline(p: Travelogue) {
    const spans = p.chapters.map((c, i) => ({ c, i, ...chapterSpan(c) })).filter((x) => !Number.isNaN(x.start) && !Number.isNaN(x.end) && x.end >= x.start);
    if (!spans.length) return void timeline.replaceChildren(h('p', { class: 'muted small' }, 'The timeline appears once chapters have dates.'));
    const lo = Math.min(...spans.map((x) => x.start));
    const hi = Math.max(...spans.map((x) => x.end));
    const range = Math.max(hi - lo, 3_600_000);
    const lanes: number[] = [];
    const placed = spans.sort((a, b) => a.start - b.start).map((x) => {
      let lane = lanes.findIndex((end) => end <= x.start);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = x.end;
      return { ...x, lane };
    });
    const days = range / 86_400_000;
    const step = days <= 16 ? 1 : days <= 70 ? 7 : 30;
    const ticks: HTMLElement[] = [];
    const firstDay = new Date(lo);
    firstDay.setUTCHours(0, 0, 0, 0);
    for (let t = firstDay.getTime(); t <= hi; t += step * 86_400_000) {
      if (t < lo - 1) continue;
      const tick = h('span', { class: 'tick' }, new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }));
      tick.style.left = `${((t - lo) / range) * 100}%`;
      ticks.push(tick);
    }
    const blocks = placed.map((x) => {
      const b = h('button', { class: `block${x.c.id === selected ? ' selected' : ''}`, 'data-id': x.c.id, title: `${x.i + 1}. ${x.c.title || 'Untitled'} · ${fmtDay(x.c.start)} – ${fmtDay(x.c.end)}`, onclick: () => select(x.c.id, true) },
        `${x.i + 1}. ${x.c.title || 'Untitled'}`);
      b.style.left = `${((x.start - lo) / range) * 100}%`;
      b.style.width = `max(6px, calc(${((x.end - x.start) / range) * 100}% - 2px))`;
      b.style.top = `${22 + x.lane * 30}px`;
      return b;
    });
    timeline.style.height = `${30 + lanes.length * 30}px`;
    timeline.replaceChildren(...ticks, ...blocks);
  }

  // ---- update everything from state ----
  function update() {
    const p = s.state;
    const issues = analyzeItinerary(p);
    const byChapter = new Map<string, ItineraryIssue[]>();
    for (const i of issues) for (const id of i.chapterIds) byChapter.set(id, [...(byChapter.get(id) ?? []), i]);
    issuesBox.replaceChildren(...issues.map((i) => h('div', { class: `issue ${i.kind}`, 'data-kind': i.kind, onclick: () => select(i.chapterIds[0], true) }, describeIssue(i, p))));
    issuesBox.hidden = !issues.length;
    empty.hidden = p.chapters.length > 0;
    const editable = s.canEdit;
    for (const b of [addBtn, importBtn, sortBtn]) b.disabled = !editable;
    playBtn.disabled = !p.chapters.length;

    const seen = new Set<string>();
    p.chapters.forEach((c, i) => {
      seen.add(c.id);
      let card = cards.get(c.id);
      if (!card) {
        card = makeCard(c.id);
        cards.set(c.id, card);
      }
      card.update(c, i, p, byChapter.get(c.id) ?? [], editable);
      if (list.children[i] !== card.el) list.insertBefore(card.el, list.children[i] ?? null);
    });
    for (const [id, card] of cards) if (!seen.has(id)) { card.el.remove(); cards.delete(id); }
    if (pickFor && !seen.has(pickFor)) setPick(null);
    if (selected && !seen.has(selected)) selected = null;
    map.setPins(p.chapters.flatMap((c, i) => (c.coordinates ? [{ id: c.id, index: i, lat: c.coordinates.lat, lng: c.coordinates.lng, title: c.title }] : [])));
    map.setSelected(selected);
    renderTimeline(p);
  }

  // ---- chapter cards (IT-1, IT-2, IT-5, IT-7, IT-8) ----
  interface CardHandle {
    el: HTMLLIElement;
    update(c: Chapter, index: number, p: Travelogue, issues: ItineraryIssue[], editable: boolean): void;
    focusTitle(): void;
    setPicking(on: boolean): void;
  }

  function makeCard(id: string): CardHandle {
    const edit = (label: string, patch: Partial<Chapter>, coalesce?: string) =>
      s.edit(label, (p) => updateChapter(p, id, patch), coalesce ? { coalesceKey: `${id}:${coalesce}` } : { structural: true });
    const num = h('span', { class: 'num' });
    const title = h('input', { class: 'title', placeholder: 'Chapter title', 'aria-label': 'Chapter title', oninput: () => edit('Edit chapter title', { title: title.value }, 'title') });
    const up = h('button', { class: 'icon', 'aria-label': 'Move chapter up', onclick: () => s.edit('Move chapter', (p) => moveChapter(p, id, p.chapters.findIndex((c) => c.id === id) - 1), { structural: true }) }, '↑');
    const down = h('button', { class: 'icon', 'aria-label': 'Move chapter down', onclick: () => s.edit('Move chapter', (p) => moveChapter(p, id, p.chapters.findIndex((c) => c.id === id) + 1), { structural: true }) }, '↓');
    const place = h('input', { class: 'place', placeholder: 'Place, e.g. Lisbon, Portugal', 'aria-label': 'Place', oninput: () => edit('Edit place', { locationName: place.value }, 'place') });
    const findBtn = h('button', { 'aria-label': 'Find place on the map', onclick: () => void find() }, 'Find');
    const pinBtn = h('button', { 'aria-label': 'Drop a pin on the map', onclick: () => setPick(pickFor === id ? null : id) }, 'Drop pin');
    const coords = h('span', { class: 'muted small coords' });
    const clearPin = h('button', { class: 'link', onclick: () => edit('Remove pin', { coordinates: undefined }) }, 'remove pin');
    const results = h('div', { class: 'place-results', role: 'listbox', 'aria-label': 'Place search results' });
    // Moving one end past the other keeps the chapter's length, like a calendar, so an edit never leaves start after end.
    const cur = () => s.state.chapters.find((c) => c.id === id)!;
    const start = h('input', { type: 'datetime-local', 'aria-label': 'Start', onchange: () => {
      if (!start.value) return;
      const c = cur();
      const v = start.value.slice(0, 16);
      edit('Change start', v > c.end ? { start: v, end: shiftLocal(v, minutesBetween(c.start, c.end)) } : { start: v });
    } });
    const end = h('input', { type: 'datetime-local', 'aria-label': 'End', onchange: () => {
      if (!end.value) return;
      const c = cur();
      const v = end.value.slice(0, 16);
      edit('Change end', v < c.start ? { start: shiftLocal(v, -minutesBetween(c.start, c.end)), end: v } : { end: v });
    } });
    const tz = h('input', { list: 'tz-list', class: 'tz', 'aria-label': 'Time zone', onchange: () => {
      if (isValidTimeZone(tz.value)) edit('Change time zone', { timeZone: tz.value });
      else tz.setCustomValidity('Choose a time zone from the list');
      tz.reportValidity();
    }, oninput: () => tz.setCustomValidity('') });
    const days = h('span', { class: 'muted small' });
    const desc = h('textarea', { rows: 2, placeholder: 'What happened here (optional)', 'aria-label': 'Description', oninput: () => edit('Edit description', { description: desc.value }, 'desc') });
    const tcOn = h('input', { type: 'checkbox', 'aria-label': 'Show a title card', onchange: () => edit(tcOn.checked ? 'Show title card' : 'Hide title card', { titleCard: { ...currentTc(), enabled: tcOn.checked } }) });
    const tcSec = h('input', { type: 'number', min: '0', max: '60', step: '0.5', class: 'secs', 'aria-label': 'Title card seconds', onchange: () => {
      const v = tcSec.value === '' ? undefined : Math.max(0, Math.min(60, Number(tcSec.value)));
      edit('Change title card length', { titleCard: { ...currentTc(), durationSec: v } });
    } });
    const mediaCount = h('span', { class: 'chip' });
    const issueNote = h('div', { class: 'card-issues' });
    const previewBtn = h('button', { onclick: () => ctx.preview(id) }, 'Preview');
    const splitArea = h('div', { class: 'split-form', hidden: true });
    const splitBtn = h('button', { onclick: () => openSplit() }, 'Split…');
    const mergeBtn = h('button', { onclick: () => {
      const p = s.state;
      const i = p.chapters.findIndex((c) => c.id === id);
      const next = p.chapters[i + 1];
      if (next) s.edit('Merge chapters', (q) => mergeChapters(q, id, next.id), { structural: true });
    } }, 'Merge with next');
    let armed = 0;
    const delBtn = h('button', { class: 'danger', onclick: () => {
      if (!armed) {
        delBtn.textContent = 'Confirm delete';
        armed = window.setTimeout(() => { armed = 0; delBtn.textContent = 'Delete'; }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = 0;
      s.edit('Delete chapter', (p) => removeChapter(p, id), { structural: true });
    } }, 'Delete');

    const currentTc = () => s.state.chapters.find((c) => c.id === id)?.titleCard ?? { enabled: true };

    async function find() {
      const q = place.value.trim();
      if (q.length < 2) return void results.replaceChildren(h('p', { class: 'muted small' }, 'Type a place name first.'));
      results.replaceChildren(h('p', { class: 'muted small' }, 'Searching…'));
      try {
        const { places } = await Api.geoSearch(q, navigator.language);
        results.replaceChildren(...(places.length ? places.map((pl) => h('button', { class: 'result', role: 'option', onclick: () => {
          const cur = s.state.chapters.find((c) => c.id === id);
          const patch: Partial<Chapter> = { locationName: pl.displayName.split(',').slice(0, 2).join(',').trim(), coordinates: { lat: pl.lat, lng: pl.lng } };
          if (cur && !cur.title.trim()) patch.title = pl.name;
          edit('Choose place', patch);
          results.replaceChildren();
        } }, h('strong', {}, pl.name), h('span', { class: 'muted small' }, ` ${pl.displayName}`))) : [h('p', { class: 'muted small' }, 'No places found. Try a different spelling, or drop a pin on the map.')]),
        h('button', { class: 'link', onclick: () => results.replaceChildren() }, 'close'));
      } catch (e) {
        results.replaceChildren(h('p', { class: 'error small' }, (e as Error).message));
      }
    }

    function openSplit() {
      const c = s.state.chapters.find((x) => x.id === id);
      if (!c) return;
      const sp = chapterSpan(c);
      const mid = new Date((sp.start + sp.end) / 2);
      const defaultAt = `${c.start.slice(0, 10) === c.end.slice(0, 10) ? c.start.slice(0, 10) : new Date(Date.UTC(mid.getUTCFullYear(), mid.getUTCMonth(), mid.getUTCDate())).toISOString().slice(0, 10)}T12:00`;
      const at = h('input', { type: 'datetime-local', value: defaultAt, 'aria-label': 'Split at' });
      const msg = h('span', { class: 'error small' });
      splitArea.hidden = false;
      splitArea.replaceChildren(
        h('label', {}, 'Split at ', at),
        h('button', { class: 'primary', onclick: () => {
          try {
            let newId = '';
            s.edit('Split chapter', (p) => { const r = splitChapter(p, id, at.value.slice(0, 16)); newId = r.newId; return r.project; }, { structural: true });
            splitArea.hidden = true;
            if (newId) setTimeout(() => { select(newId, true); cards.get(newId)?.focusTitle(); }, 50);
          } catch (e) {
            msg.textContent = (e as Error).message;
          }
        } }, 'Split here'),
        h('button', { onclick: () => (splitArea.hidden = true) }, 'Cancel'),
        msg);
    }

    const el = h('li', { class: 'chapter-card card', 'data-id': id, onclick: (e: Event) => { if ((e.target as HTMLElement).tagName === 'LI') select(id); } },
      h('div', { class: 'row head' }, num, title, mediaCount, up, down),
      h('div', { class: 'row' }, place, findBtn, pinBtn),
      h('div', { class: 'row small' }, coords, clearPin),
      results,
      h('div', { class: 'row dates' }, h('label', {}, 'From ', start), h('label', {}, 'to ', end), days),
      h('div', { class: 'row' }, h('label', {}, 'Time zone ', tz)),
      desc,
      h('div', { class: 'row' }, h('label', { class: 'inline' }, tcOn, ' Title card'), h('label', { class: 'inline' }, tcSec, ' s'), h('span', { class: 'spacer' }), previewBtn, splitBtn, mergeBtn, delBtn),
      splitArea, issueNote);
    el.addEventListener('focusin', () => { if (selected !== id) select(id); });

    const setVal = (input: HTMLInputElement | HTMLTextAreaElement, v: string) => { if (document.activeElement !== input && input.value !== v) input.value = v; };

    return {
      el,
      focusTitle: () => title.focus(),
      setPicking: (on) => { pinBtn.textContent = on ? 'Cancel pin' : 'Drop pin'; pinBtn.classList.toggle('active', on); },
      update(c, index, p, issues, editable) {
        num.textContent = String(index + 1);
        setVal(title, c.title);
        setVal(place, c.locationName);
        setVal(start, c.start.slice(0, 16));
        setVal(end, c.end.slice(0, 16));
        setVal(tz, c.timeZone);
        setVal(desc, c.description);
        tcOn.checked = c.titleCard.enabled;
        setVal(tcSec, c.titleCard.durationSec === undefined ? '' : String(c.titleCard.durationSec));
        tcSec.placeholder = String(p.cueProfile.titleCardSec);
        coords.textContent = c.coordinates ? `📍 ${c.coordinates.lat.toFixed(4)}, ${c.coordinates.lng.toFixed(4)}` : 'No pin on the map yet';
        clearPin.hidden = !c.coordinates || !editable;
        const sp = chapterSpan(c);
        const n = Number.isNaN(sp.start) || Number.isNaN(sp.end) ? 0 : Math.max(1, Math.round((sp.end - sp.start) / 86_400_000));
        days.textContent = n ? `${n} day${n === 1 ? '' : 's'}` : '';
        const items = p.media.filter((m) => m.chapterId === c.id).length;
        mediaCount.textContent = items ? `${items} item${items === 1 ? '' : 's'}` : 'no media yet';
        up.disabled = !editable || index === 0;
        down.disabled = !editable || index === p.chapters.length - 1;
        mergeBtn.disabled = !editable || index === p.chapters.length - 1;
        for (const inp of [title, place, start, end, tz, desc, tcOn, tcSec]) inp.disabled = !editable;
        for (const b of [findBtn, pinBtn, splitBtn, delBtn]) b.disabled = !editable;
        findBtn.disabled ||= !ctx.map.search;
        el.classList.toggle('has-issue', issues.length > 0);
        issueNote.replaceChildren(...issues.map((i) => h('div', { class: `issue ${i.kind}` }, describeIssue(i, p))));
      },
    };
  }

  update();
  return {
    el, map, update, select: (id) => select(id),
    dispose() {
      removeEventListener('keydown', onKey);
      map.destroy();
    },
  };
}

// Wall-clock arithmetic on local date-times (no time zone involved: a chapter's length is kept as shown).
const localMs = (v: string) => Date.parse(`${v}:00Z`);
function minutesBetween(a: string, b: string): number {
  return Math.max(0, Math.round((localMs(b) - localMs(a)) / 60_000));
}
function shiftLocal(v: string, minutes: number): string {
  return new Date(localMs(v) + minutes * 60_000).toISOString().slice(0, 16);
}
