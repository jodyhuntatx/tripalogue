/**
 * Map settings (MV-3, MV-5, MV-6, MV-8, PE-18): the "Map" popover in the
 * player controls. The map itself is a layer of the render model, drawn by the
 * player on the stage (and in exports) from mapAt(); these controls only edit
 * the travelogue's mapView settings.
 */
import { DEFAULT_MAP_TRANSITION, type InsetCorner, type MapStyle, type MapViewSettings, type Travelogue } from '../core/index.js';
import type { ProjectSession } from './session.js';

export interface InsetView {
  /** Settings popover for the player controls. */
  settings: HTMLElement;
  /** Call when the project changes. */
  update(p: Travelogue): void;
  dispose(): void;
}

const CORNERS: [InsetCorner, string][] = [['topLeft', 'Top left'], ['topRight', 'Top right'], ['bottomLeft', 'Bottom left'], ['bottomRight', 'Bottom right']];
const STYLES: [MapStyle, string][] = [['light', 'Light'], ['dark', 'Dark'], ['terrain', 'Terrain']];
const LANGS: [string, string][] = [['', 'Local names'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['ja', 'Japanese'], ['zh', 'Chinese']];

export function pinsFor(p: Travelogue) {
  return p.chapters.flatMap((c, i) => (c.coordinates ? [{ id: c.id, index: i, lat: c.coordinates.lat, lng: c.coordinates.lng, title: c.title }] : []));
}

export function mountInset(s: ProjectSession, cfg: { tiles: boolean; attribution: string; languageLabels?: boolean }): InsetView {
  const set = (label: string, patch: Partial<MapViewSettings>, coalesce?: string) =>
    s.edit(label, (p) => ({ ...p, mapView: { ...p.mapView, ...patch } }), { coalesceKey: coalesce });

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    Object.assign(e, props);
    return e;
  };
  const check = (id: string, label: string, onChange: (v: boolean) => void) => {
    const i = el('input', { type: 'checkbox', id });
    i.addEventListener('change', () => onChange(i.checked));
    const l = el('label');
    l.append(i, ` ${label}`);
    return { input: i, row: l };
  };
  const select = (id: string, aria: string, opts: [string, string][], onChange: (v: string) => void) => {
    const sel = el('select', { id });
    sel.setAttribute('aria-label', aria);
    for (const [v, t] of opts) sel.append(new Option(t, v));
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  };

  const enabled = check('inset-enabled', 'Show the map', (v) => set(v ? 'Show map inset' : 'Hide map inset', { enabled: v }));
  const overview = check('inset-overview', 'Show the whole trip on title cards', (v) => set('Change map inset', { tripOverview: v }));
  const animate = check('inset-animate', 'Animate: travel between chapters, hop between items', (v) => set('Change map inset', { transitionAnimation: v }));
  const label = check('inset-label', 'Show "Chapter 3 of 8"', (v) => set('Change map inset', { chapterLabel: v }));
  const precise = check('inset-hide-precise', 'Hide precise locations (dots at the chapter\'s place)', (v) => set('Change map inset', { hidePreciseLocations: v }));
  const credits = check('credits-enabled', 'Photo credits ("Photo: Ana") on travelers\' photos', (v) => s.edit(v ? 'Show photo credits' : 'Hide photo credits', (p) => ({ ...p, credits: v || undefined })));
  const corner = select('inset-corner', 'Map inset corner', CORNERS, (v) => set('Move map inset', { corner: v as InsetCorner }));
  const shape = select('inset-shape', 'Map inset shape', [['rect', 'Rectangle'], ['circle', 'Circle']], (v) => set('Change map inset', { shape: v as 'rect' | 'circle' }));
  const style = select('inset-style', 'Map style', STYLES, (v) => set('Map style', { style: v as MapStyle }));
  const lang = select('inset-lang', 'Map label language', LANGS, (v) => set('Map labels', { labelLanguage: v || undefined }));
  const mode = select('inset-transition', 'Chapter transitions', [['inset', 'In the inset, over the title card'], ['fullFrame', 'Full frame, before the title card']], (v) =>
    set('Chapter transitions', { transition: { ...(s.state.mapView.transition ?? DEFAULT_MAP_TRANSITION), mode: v as 'inset' | 'fullFrame' } }));
  const dur = el('input', { type: 'number', id: 'inset-transition-sec', min: '0.5', max: '15', step: '0.5', className: 'num' });
  dur.setAttribute('aria-label', 'Chapter transition length, seconds');
  dur.addEventListener('change', () => {
    const v = Math.max(0.5, Math.min(15, Number(dur.value) || DEFAULT_MAP_TRANSITION.durationSec));
    set('Chapter transitions', { transition: { ...(s.state.mapView.transition ?? DEFAULT_MAP_TRANSITION), durationSec: v } });
  });
  const size = el('input', { type: 'range', id: 'inset-size', min: '10', max: '30', step: '1' });
  size.setAttribute('aria-label', 'Map inset size, percent of frame width');
  const sizeOut = el('span');
  size.addEventListener('input', () => set('Resize map inset', { size: Number(size.value) / 100 }, 'inset-size'));

  const note = el('p', { className: 'muted small', id: 'inset-note' });
  const langNote = el('p', { className: 'muted small', id: 'inset-lang-note' });
  const row = (...kids: (Node | string)[]): HTMLDivElement => {
    const d = document.createElement('div');
    d.className = 'row';
    d.append(...kids);
    return d;
  };
  const sizeRow = el('label');
  sizeRow.append('Size ', size, sizeOut);
  const transRow = row(mode, dur, 's');
  const panel = el('div', { className: 'inset-panel' });
  const h4 = (t: string) => {
    const e = document.createElement('h4');
    e.textContent = t;
    return e;
  };
  const parts: Node[] = [enabled.row, row(corner, shape, style), sizeRow, h4('Story'), overview.row, animate.row, label.row, transRow,
    h4('Labels and privacy'), row(lang), langNote, precise.row, credits.row, note];
  panel.append(...parts);
  const summary = el('summary', { textContent: 'Map', title: 'Map inset settings' });
  const settings = el('details', { className: 'inset-settings', id: 'inset-settings' });
  settings.append(summary, panel);

  function update(p: Travelogue) {
    const mv = p.mapView;
    const tr = mv.transition ?? DEFAULT_MAP_TRANSITION;
    enabled.input.checked = mv.enabled;
    overview.input.checked = mv.tripOverview;
    animate.input.checked = mv.transitionAnimation;
    label.input.checked = mv.chapterLabel !== false;
    precise.input.checked = mv.hidePreciseLocations;
    credits.input.checked = !!p.credits;
    corner.value = mv.corner;
    shape.value = mv.shape;
    style.value = mv.style;
    lang.value = mv.labelLanguage ?? '';
    mode.value = tr.mode;
    if (document.activeElement !== dur) dur.value = String(tr.durationSec);
    const pct = Math.round(mv.size * 100);
    if (document.activeElement !== size) size.value = String(pct);
    sizeOut.textContent = ` ${pct}%`;
    const controls: (HTMLInputElement | HTMLSelectElement)[] = [enabled.input, overview.input, animate.input, label.input, precise.input, credits.input, corner, shape, style, lang, mode, dur, size];
    for (const c of controls) c.disabled = !s.canEdit;
    const pins = pinsFor(p).length;
    const without = p.chapters.filter((c) => !c.coordinates).length;
    note.textContent = pins === 0
      ? 'Add a place to a chapter in the Itinerary view to see it on the map.'
      : without ? `${without} chapter${without === 1 ? ' has' : 's have'} no place: the map hides while ${without === 1 ? 'it plays' : 'they play'}.` : '';
    langNote.textContent = cfg.languageLabels
      ? ''
      : 'Place names on the map tiles are the tile provider\'s (local names with OpenStreetMap). The language applies where the provider offers it.';
  }
  update(s.state);
  void cfg;
  return { settings, update, dispose() {} };
}
