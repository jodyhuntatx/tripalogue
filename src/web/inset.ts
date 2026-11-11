/**
 * Basic playback inset map (MV-2 basic, PRD Phase 1 follow-up): a small map in
 * a corner of the player that follows the story. On a chapter's title card it
 * shows the whole trip (trip-overview mode), then flies in to the chapter
 * being shown, with the chapters either side kept in view for context.
 * Chapters already shown are marked visited and the route ahead is dashed.
 *
 * Preview only for now: per-item locations, the animated travel transition,
 * per-chapter and per-item overrides, and drawing the inset into exported
 * video come with the full map view in Phase 5.
 */
import type { Frame, InsetCorner, MapViewSettings, Timeline, Travelogue } from '../core/index.js';
import { RouteMap, type MapFocus, type MapPin } from './map.js';
import type { ProjectSession } from './session.js';

export interface InsetView {
  /** Settings popover for the player controls. */
  settings: HTMLElement;
  map: RouteMap;
  /** Call on every drawn frame. */
  onFrame(frame: Frame, timeline: Timeline): void;
  /** Call when the project changes. */
  update(p: Travelogue): void;
  dispose(): void;
}

const CORNERS: [InsetCorner, string][] = [['topLeft', 'Top left'], ['topRight', 'Top right'], ['bottomLeft', 'Bottom left'], ['bottomRight', 'Bottom right']];

export function pinsFor(p: Travelogue): MapPin[] {
  return p.chapters.flatMap((c, i) => (c.coordinates ? [{ id: c.id, index: i, lat: c.coordinates.lat, lng: c.coordinates.lng, title: c.title }] : []));
}

export function mountInset(s: ProjectSession, stage: HTMLElement, cfg: { tiles: boolean; attribution: string }): InsetView {
  const map = new RouteMap({ tileUrl: cfg.tiles ? (z, x, y) => `/api/tiles/${z}/${x}/${y}` : undefined, attribution: cfg.attribution, inset: true });
  map.el.id = 'map-inset';
  stage.append(map.el);

  const set = (label: string, patch: Partial<MapViewSettings>) =>
    s.edit(label, (p) => ({ ...p, mapView: { ...p.mapView, ...patch } }), { coalesceKey: label === 'Resize map inset' ? 'inset-size' : undefined });

  const field = (label: string, input: HTMLElement) => {
    const l = document.createElement('label');
    l.append(input, ` ${label}`);
    return l;
  };
  const check = (id: string, onChange: (v: boolean) => void) => {
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.id = id;
    i.addEventListener('change', () => onChange(i.checked));
    return i;
  };
  const enabled = check('inset-enabled', (v) => set(v ? 'Show map inset' : 'Hide map inset', { enabled: v }));
  const overview = check('inset-overview', (v) => set('Change map inset', { tripOverview: v }));
  const animate = check('inset-animate', (v) => set('Change map inset', { transitionAnimation: v }));
  const corner = document.createElement('select');
  corner.id = 'inset-corner';
  corner.setAttribute('aria-label', 'Map inset corner');
  for (const [v, t] of CORNERS) corner.append(new Option(t, v));
  corner.addEventListener('change', () => set('Move map inset', { corner: corner.value as InsetCorner }));
  const shape = document.createElement('select');
  shape.id = 'inset-shape';
  shape.setAttribute('aria-label', 'Map inset shape');
  shape.append(new Option('Rectangle', 'rect'), new Option('Circle', 'circle'));
  shape.addEventListener('change', () => set('Change map inset', { shape: shape.value as 'rect' | 'circle' }));
  const size = document.createElement('input');
  size.type = 'range';
  size.id = 'inset-size';
  size.min = '10';
  size.max = '30';
  size.step = '1';
  size.setAttribute('aria-label', 'Map inset size, percent of frame width');
  const sizeOut = document.createElement('span');
  size.addEventListener('input', () => set('Resize map inset', { size: Number(size.value) / 100 }));

  const summary = document.createElement('summary');
  summary.textContent = 'Map';
  summary.title = 'Map inset settings';
  const panel = document.createElement('div');
  panel.className = 'inset-panel';
  const note = document.createElement('p');
  note.className = 'muted';
  note.id = 'inset-note';
  const sizeRow = document.createElement('label');
  sizeRow.append('Size ', size, sizeOut);
  const pick = document.createElement('div');
  pick.className = 'row';
  pick.append(corner, shape);
  panel.append(field('Show map inset', enabled), pick, sizeRow, field('Show the whole trip on title cards', overview), field('Animate between views', animate), note);
  const settings = document.createElement('details');
  settings.className = 'inset-settings';
  settings.id = 'inset-settings';
  settings.append(summary, panel);

  let lastKey = '';
  let lastPins = '';
  let mv: MapViewSettings = s.state.mapView;

  function layout(p: Travelogue) {
    mv = p.mapView;
    const pins = pinsFor(p);
    const st = map.el.style;
    const pct = Math.round(mv.size * 100);
    st.width = `${pct}%`;
    map.el.classList.toggle('circle', mv.shape === 'circle');
    map.el.dataset.corner = mv.corner;
    map.el.hidden = !mv.enabled || pins.length === 0;
    const key = JSON.stringify(pins);
    if (key !== lastPins) {
      lastPins = key;
      map.setPins(pins);
    }
    // Controls mirror the settings (and lock for view-only members).
    enabled.checked = mv.enabled;
    overview.checked = mv.tripOverview;
    animate.checked = mv.transitionAnimation;
    corner.value = mv.corner;
    shape.value = mv.shape;
    if (document.activeElement !== size) size.value = String(pct);
    sizeOut.textContent = ` ${pct}%`;
    for (const c of [enabled, overview, animate, corner, shape, size]) c.disabled = !s.canEdit;
    note.textContent = pins.length === 0
      ? 'Add a place to a chapter in the Itinerary view to see it on the map.'
      : `${pins.length} of ${p.chapters.length} chapters have a place. Preview only: the inset is not in exported video yet.`;
  }

  return {
    settings,
    map,
    onFrame(frame, timeline) {
      if (map.el.hidden) return;
      const seg = timeline.segments[frame.segmentIndex];
      const chapterId = seg?.chapterId ?? timeline.chapters[frame.chapterIndex]?.chapterId;
      const onTitle = seg?.kind === 'title';
      const target: MapFocus = !chapterId || (onTitle && mv.tripOverview) ? { kind: 'trip' } : { kind: 'chapter', id: chapterId };
      const key = `${target.kind}:${chapterId ?? ''}`;
      if (key === lastKey) return;
      lastKey = key;
      const chapterIndex = chapterId ? s.state.chapters.findIndex((c) => c.id === chapterId) : -1;
      map.setProgress(chapterIndex);
      map.setSelected(chapterId ?? null);
      map.el.dataset.focus = target.kind;
      map.focus(target, mv.transitionAnimation);
    },
    update(p) {
      const wasHidden = map.el.hidden;
      layout(p);
      if (wasHidden && !map.el.hidden) lastKey = ''; // refocus on the next frame
    },
    dispose() {
      map.destroy();
    },
  };
}
