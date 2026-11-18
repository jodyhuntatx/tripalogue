/**
 * Phase 5 controls in the side panel. Each section is built from the current project and edits it through the
 * session, so every change is one undoable, saved edit.
 *
 * - Clip: entrance and exit (PE-10, PE-12, PE-16), motion (PE-11), speed and sound (PE-13), text on the picture
 *   (PE-14), the map inset for the item (MV-3), copy, paste and presets (PE-17)
 * - Chapter: the title card (PE-15), the map inset and photo credits (MV-3, MV-7, PE-18)
 * - Audio: loop, crossfade, fit to the chapter (AU-7, AU-8), fit the pictures to a narration (AU-9)
 * - Lanes: how much each lane lowers the others (AU-6)
 */
import {
  addAnnotation, ANNOTATION_STYLES, annotationsOf, applyPreset, cueStyleOf, deletePreset, fitAudioToChapter, fitVisualsToNarration,
  MAX_SPEED, MIN_SPEED, newId, pasteCueStyle, removeAnnotation, savePreset, setChapterOverride, setItemMapInset, setLaneDuck, setMotion,
  setMute, setSpeed, setTitleCard, setTransition, updateAnnotation,
  type AnnotationKind, type AnnotationStyle, type Cue, type CueStyle, type Direction, type Id, type MediaItem, type Timeline,
  type TitleLayout, type Transition, type TransitionType, type Travelogue,
} from '../core/index.js';
import { h, type Child } from './dom.js';
import type { ProjectSession } from './session.js';

/** What the stage overlay is editing: a picture's start and end views, or one text box. */
export interface StageFocus {
  motionItem: Id | null;
  annotation: Id | null;
}

export interface CuePanelContext {
  session: ProjectSession;
  timeline: () => Timeline;
  focus: StageFocus;
  /** The stage focus changed (the overlay redraws, the player seeks to show it). */
  onFocus: () => void;
  /** Seek the player to a time. */
  seek: (t: number) => void;
  time: () => number;
}

type Edit = (label: string, fn: (p: Travelogue) => Travelogue, opts?: { coalesceKey?: string }) => void;

/** Copied cues, shared by every clip (PE-17). */
let clipboard: CueStyle | null = null;

const fmt1 = (sec: number) => (Math.round(sec * 10) / 10).toFixed(1);
const ENTRANCES: [TransitionType, string][] = [['cut', 'Cut'], ['fade', 'Fade'], ['slide', 'Slide'], ['zoom', 'Zoom'], ['crossfade', 'Crossfade']];
const EXITS: [TransitionType, string][] = [['cut', 'Cut'], ['fade', 'Fade'], ['slide', 'Slide']];
const DIRS: [Direction, string][] = [['left', 'from the left'], ['right', 'from the right'], ['up', 'from the top'], ['down', 'from the bottom']];
const EXIT_DIRS: [Direction, string][] = [['left', 'to the left'], ['right', 'to the right'], ['up', 'to the top'], ['down', 'to the bottom']];

function section(title: string, id: string, ...children: Child[]): HTMLElement {
  return h('details', { class: 'cue-section', id, open: true }, h('summary', {}, title), ...children);
}

function field(label: string, forId: string | null, ...children: Child[]): HTMLElement {
  return h('div', { class: 'field' }, forId ? h('label', { for: forId }, label) : h('label', {}, label), ...children);
}

/** One value shared by all the cues, or undefined when they differ. */
function common<T>(cues: Cue[], get: (c: Cue) => T): T | undefined {
  const first = JSON.stringify(get(cues[0]));
  return cues.every((c) => JSON.stringify(get(c)) === first) ? get(cues[0]) : undefined;
}

// ---------------------------------------------------------------- Clip tab

export function clipSections(cx: CuePanelContext, items: MediaItem[]): HTMLElement[] {
  const s = cx.session;
  const p = s.state;
  const editable = s.canEdit;
  const edit: Edit = (label, fn, opts) => { s.edit(label, fn, opts); };
  const ids = items.map((m) => m.id);
  const cues = ids.map((id) => p.cues.find((c) => c.itemId === id)).filter((c): c is Cue => !!c);
  if (!cues.length) return [];
  const one = items.length === 1 ? items[0] : null;
  const images = items.filter((m) => m.kind === 'image');
  const videos = items.filter((m) => m.kind === 'video');
  const n = ids.length;
  const many = (what: string) => (n === 1 ? what : `${what} (${n} items)`);
  const out: HTMLElement[] = [];

  // Entrance and exit.
  const transitionRow = (which: 'entrance' | 'exit') => {
    const tr = common(cues, (c) => c[which]);
    const opts = which === 'entrance' ? ENTRANCES : EXITS;
    const sel = h('select', { id: `pe-${which}`, disabled: !editable, 'aria-label': which === 'entrance' ? 'Entrance' : 'Exit' },
      ...(tr ? [] : [h('option', { value: '', selected: true }, 'Mixed')]),
      ...opts.map(([v, label]) => h('option', { value: v, selected: tr?.type === v }, label)));
    const dur = h('input', { type: 'number', id: `pe-${which}-sec`, class: 'num', min: '0', max: '5', step: '0.1', disabled: !editable || tr?.type === 'cut',
      value: tr && tr.type !== 'cut' ? fmt1(tr.durationSec) : '', placeholder: 's', 'aria-label': `${which === 'entrance' ? 'Entrance' : 'Exit'} seconds` });
    const dirs = which === 'entrance' ? DIRS : EXIT_DIRS;
    const dir = h('select', { id: `pe-${which}-dir`, disabled: !editable, hidden: tr?.type !== 'slide', 'aria-label': 'Direction' },
      ...dirs.map(([v, label]) => h('option', { value: v, selected: (tr?.direction ?? (which === 'entrance' ? 'right' : 'left')) === v }, label)));
    const apply = (patch: Partial<Transition>) => {
      const base: Transition = tr ?? { type: 'fade', durationSec: 0.5 };
      const type = (patch.type ?? base.type) as TransitionType;
      const durationSec = patch.durationSec ?? (base.type === 'cut' && type !== 'cut' ? (type === 'crossfade' ? 1 : 0.5) : base.durationSec);
      edit(many(which === 'entrance' ? `Entrance: ${type}` : `Exit: ${type}`), (q) => setTransition(q, ids, which, { type, durationSec, direction: patch.direction ?? base.direction }));
    };
    sel.addEventListener('change', () => { if (sel.value) apply({ type: sel.value as TransitionType }); });
    dur.addEventListener('change', () => apply({ durationSec: Math.max(0, Number(dur.value) || 0) }));
    dir.addEventListener('change', () => apply({ direction: dir.value as Direction }));
    return field(which === 'entrance' ? 'Comes in with' : 'Leaves with', `pe-${which}`,
      h('div', { class: 'row' }, sel, dur, h('span', { class: 'small muted' }, 's'), dir),
      which === 'entrance' && tr?.type === 'crossfade' && h('p', { class: 'muted small' }, 'Dissolves over the picture before it, which leaves without its own exit.'));
  };
  out.push(section('Transitions', 'pe-sec-transitions', transitionRow('entrance'), transitionRow('exit')));

  // Motion (photos).
  if (images.length) {
    const imgCues = cues.filter((c) => images.some((m) => m.id === c.itemId));
    const kind = common(imgCues, (c) => (c.animation.type === 'none' ? 'none' : c.animation.auto ? 'auto' : 'custom'));
    const radio = (v: 'none' | 'auto' | 'custom', label: string) => h('label', { class: 'small' },
      h('input', { type: 'radio', name: 'pe-motion', value: v, id: `pe-motion-${v}`, checked: kind === v, disabled: !editable || (v === 'custom' && !one),
        onchange: () => {
          if (v === 'custom') {
            const cue = imgCues[0];
            const start = cue.animation.type === 'kenBurns' ? { from: cue.animation.from, to: cue.animation.to }
              : { from: { x: 0, y: 0, w: 1, h: 1 }, to: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } };
            edit('Motion: custom', (q) => setMotion(q, ids, start));
            focusMotion(cx, one!.id);
          } else {
            edit(many(v === 'none' ? 'Motion: none' : 'Motion: auto'), (q) => setMotion(q, ids, v));
            if (cx.focus.motionItem) { cx.focus.motionItem = null; cx.onFocus(); }
          }
        } }), ` ${label}`);
    const editing = one && cx.focus.motionItem === one.id;
    out.push(section('Motion', 'pe-sec-motion',
      h('div', { class: 'row wrap' }, radio('none', 'Still'), radio('auto', 'Auto pan & zoom'), radio('custom', 'Custom')),
      one && kind === 'custom' && h('div', { class: 'row' },
        h('button', { id: 'pe-motion-edit', class: editing ? 'primary' : '', disabled: !editable,
          onclick: () => (editing ? (cx.focus.motionItem = null, cx.onFocus()) : focusMotion(cx, one.id)) }, editing ? 'Done' : 'Set start and end on the stage')),
      editing && h('p', { class: 'muted small' }, 'The whole photo is shown. Drag the green frame (start) and the red frame (end); drag a corner to zoom.'),
      !one && kind === 'custom' && h('p', { class: 'muted small' }, 'Select one photo to change its start and end views.')));
  }

  // Speed and sound (videos).
  if (videos.length) {
    const vidCues = cues.filter((c) => videos.some((m) => m.id === c.itemId));
    const speed = common(vidCues, (c) => c.speed);
    const mute = common(vidCues, (c) => !!c.mute);
    const speedSel = h('select', { id: 'pe-speed', disabled: !editable, 'aria-label': 'Speed' },
      ...(speed === undefined ? [h('option', { value: '', selected: true }, 'Mixed')] : []),
      ...[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((v) => h('option', { value: String(v), selected: speed === v }, `${v}×`)),
      ...(speed !== undefined && ![0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].includes(speed) ? [h('option', { value: String(speed), selected: true }, `${speed}×`)] : []));
    speedSel.addEventListener('change', () => { if (speedSel.value) edit(many(`Speed ${speedSel.value}×`), (q) => setSpeed(q, ids, Number(speedSel.value))); });
    out.push(section('Speed and sound', 'pe-sec-speed',
      field(`Speed (${MIN_SPEED}× to ${MAX_SPEED}×)`, 'pe-speed', speedSel),
      h('div', { class: 'field' }, h('label', { class: 'small' }, h('input', { type: 'checkbox', id: 'pe-mute', checked: mute === true, disabled: !editable,
        onchange: (e: Event) => edit(many((e.target as HTMLInputElement).checked ? 'Mute clip' : 'Unmute clip'), (q) => setMute(q, ids, (e.target as HTMLInputElement).checked)) }),
        ' Mute its own sound')),
      speed !== undefined && speed !== 1 && h('p', { class: 'muted small' }, `Plays ${speed < 1 ? 'slower' : 'faster'}; its sound keeps its pitch.`)));
  }

  // Text on the picture (one item).
  if (one) out.push(textSection(cx, one));

  // Map inset for these items.
  const inset = common(cues, (c) => c.mapInset ?? null);
  const insetSel = h('select', { id: 'pe-item-map', disabled: !editable, 'aria-label': 'Map inset' },
    ...(inset === undefined ? [h('option', { value: 'mixed', selected: true }, 'Mixed')] : []),
    h('option', { value: '', selected: inset === null }, 'As the chapter'), h('option', { value: 'on', selected: inset === 'on' }, 'Show'), h('option', { value: 'off', selected: inset === 'off' }, 'Hide'));
  insetSel.addEventListener('change', () => { if (insetSel.value !== 'mixed') edit(many('Map inset'), (q) => setItemMapInset(q, ids, (insetSel.value || null) as 'on' | 'off' | null)); });
  out.push(section('Map', 'pe-sec-map', field('Map inset', 'pe-item-map', insetSel)));

  // Copy, paste and presets.
  const presets = p.cuePresets ?? [];
  const presetSel = h('select', { id: 'pe-preset', disabled: !editable || !presets.length, 'aria-label': 'Apply a preset' },
    h('option', { value: '' }, presets.length ? 'Apply a preset…' : 'No presets yet'), ...presets.map((x) => h('option', { value: x.id }, x.name)));
  presetSel.addEventListener('change', () => {
    const preset = presets.find((x) => x.id === presetSel.value);
    if (preset) edit(many(`Apply preset ${preset.name}`), (q) => applyPreset(q, ids, preset.id));
  });
  const nameIn = h('input', { id: 'pe-preset-name', placeholder: 'Preset name', disabled: !editable || !one, 'aria-label': 'Preset name', size: 12 });
  out.push(section('Copy and presets', 'pe-sec-presets',
    h('div', { class: 'row' },
      h('button', { id: 'pe-copy-cues', disabled: !one, onclick: () => { clipboard = cueStyleOf(cues[0]); (document.getElementById('pe-paste-cues') as HTMLButtonElement | null)?.removeAttribute('disabled'); } }, 'Copy cues'),
      h('button', { id: 'pe-paste-cues', disabled: !editable || !clipboard, onclick: () => { if (clipboard) edit(many('Paste cues'), (q) => pasteCueStyle(q, ids, clipboard!)); } }, n > 1 ? `Paste to ${n}` : 'Paste cues')),
    h('div', { class: 'row' }, presetSel),
    h('div', { class: 'row' }, nameIn,
      h('button', { id: 'pe-save-preset', disabled: !editable || !one, onclick: () => {
        const name = nameIn.value.trim();
        if (!name) { nameIn.focus(); return; }
        const existing = presets.find((x) => x.name.toLowerCase() === name.toLowerCase());
        edit(`Save preset ${name}`, (q) => savePreset(q, existing?.id ?? newId('preset'), name, cueStyleOf(cues[0])));
      } }, 'Save as preset')),
    presets.length > 0 && h('ul', { class: 'cue-presets' }, ...presets.map((x) => h('li', {}, h('span', {}, x.name),
      h('button', { class: 'icon', 'aria-label': `Delete preset ${x.name}`, disabled: !editable, onclick: () => edit(`Delete preset ${x.name}`, (q) => deletePreset(q, x.id)) }, '×')))),
    h('p', { class: 'muted small' }, 'Copies the transitions, motion, placement, duration, speed and sound. Paste onto any selection.')));
  return out;
}

function focusMotion(cx: CuePanelContext, itemId: Id) {
  cx.focus.motionItem = itemId;
  cx.focus.annotation = null;
  const seg = cx.timeline().segments.find((x) => x.kind !== 'title' && x.item.id === itemId);
  if (seg) {
    const t = cx.time();
    if (t < seg.start || t >= seg.start + seg.duration) cx.seek(seg.start + Math.min(0.5, seg.duration / 2));
  }
  cx.onFocus();
}

/** PE-14: captions, place labels and date stamps on one item. */
function textSection(cx: CuePanelContext, item: MediaItem): HTMLElement {
  const s = cx.session;
  const editable = s.canEdit;
  const list = annotationsOf(s.state, item.id);
  const seg = cx.timeline().segments.find((x) => x.kind !== 'title' && x.item.id === item.id);
  const add = (kind: AnnotationKind) => {
    const id = newId('ann');
    s.edit(kind === 'caption' ? 'Add caption' : kind === 'place' ? 'Add place label' : 'Add date stamp', (q) => addAnnotation(q, item.id, kind, id));
    cx.focus.annotation = id;
    cx.focus.motionItem = null;
    if (seg && (cx.time() < seg.start || cx.time() >= seg.start + seg.duration)) cx.seek(seg.start + Math.min(0.6, seg.duration / 2));
    cx.onFocus();
    setTimeout(() => (document.getElementById(`ann-text-${id}`) as HTMLInputElement | null)?.focus(), 30);
  };
  const rows = list.map((a) => {
    const focused = cx.focus.annotation === a.id;
    const text = h('input', { id: `ann-text-${a.id}`, class: 'ann-text', value: a.text, disabled: !editable,
      placeholder: a.kind === 'place' ? 'The chapter\'s place' : a.kind === 'date' ? 'The day it was taken' : 'Caption', 'aria-label': 'Text' });
    text.addEventListener('input', () => s.edit('Edit text', (q) => updateAnnotation(q, a.id, { text: text.value }), { coalesceKey: `ann-${a.id}` }));
    text.addEventListener('focus', () => { if (cx.focus.annotation !== a.id) { cx.focus.annotation = a.id; cx.focus.motionItem = null; cx.onFocus(); } });
    const style = h('select', { id: `ann-style-${a.id}`, disabled: !editable, 'aria-label': 'Style' },
      ...(Object.keys(ANNOTATION_STYLES).filter((k) => k !== 'credit') as AnnotationStyle[]).map((k) => h('option', { value: k, selected: a.style === k }, ANNOTATION_STYLES[k].label)));
    style.addEventListener('change', () => s.edit('Text style', (q) => updateAnnotation(q, a.id, { style: style.value })));
    const from = h('input', { type: 'number', id: `ann-from-${a.id}`, class: 'num', min: '0', step: '0.1', value: fmt1(a.startSec), disabled: !editable, 'aria-label': 'Shows from (seconds into the item)' });
    const len = h('input', { type: 'number', id: `ann-len-${a.id}`, class: 'num', min: '0', step: '0.1', value: a.durationSec ? fmt1(a.durationSec) : '', placeholder: 'to end', disabled: !editable, 'aria-label': 'For how many seconds (empty: until the item ends)' });
    from.addEventListener('change', () => s.edit('Text timing', (q) => updateAnnotation(q, a.id, { startSec: Math.max(0, Number(from.value) || 0) })));
    len.addEventListener('change', () => s.edit('Text timing', (q) => updateAnnotation(q, a.id, { durationSec: Math.max(0, Number(len.value) || 0) })));
    return h('li', { class: `ann${focused ? ' focused' : ''}`, 'data-annotation': a.id },
      h('div', { class: 'row' }, h('span', { class: 'ann-kind' }, a.kind === 'place' ? 'Place' : a.kind === 'date' ? 'Date' : 'Caption'), text,
        h('button', { class: 'icon', 'aria-label': 'Remove text', disabled: !editable, onclick: () => {
          if (cx.focus.annotation === a.id) cx.focus.annotation = null;
          s.edit('Remove text', (q) => removeAnnotation(q, a.id));
          cx.onFocus();
        } }, '×')),
      h('div', { class: 'row small' }, style, h('span', {}, 'from'), from, h('span', {}, 's for'), len, h('span', {}, 's')));
  });
  return section('Text', 'pe-sec-text',
    h('div', { class: 'row' },
      h('button', { id: 'pe-add-caption', disabled: !editable, onclick: () => add('caption') }, '+ Caption'),
      h('button', { id: 'pe-add-place', disabled: !editable, onclick: () => add('place') }, '+ Place'),
      h('button', { id: 'pe-add-date', disabled: !editable, onclick: () => add('date') }, '+ Date')),
    list.length ? h('ul', { class: 'ann-list' }, ...rows) : h('p', { class: 'muted small' }, 'No text on this picture.'),
    list.length > 0 && h('p', { class: 'muted small' }, 'Drag a text box on the stage to move it; drag its corner to resize. Times count from when the picture starts.'));
}

// ---------------------------------------------------------------- Chapter

export function chapterSections(cx: CuePanelContext, chapterId: Id): HTMLElement[] {
  const s = cx.session;
  const p = s.state;
  const editable = s.canEdit;
  const ch = p.chapters.find((c) => c.id === chapterId);
  if (!ch) return [];
  const tc = ch.titleCard;
  const edit = (label: string, fn: (q: Travelogue) => Travelogue, key?: string) => s.edit(label, fn, key ? { coalesceKey: key } : undefined);
  const on = h('input', { type: 'checkbox', id: 'tc-enabled', checked: tc.enabled, disabled: !editable,
    onchange: (e: Event) => edit((e.target as HTMLInputElement).checked ? 'Show title card' : 'Hide title card', (q) => setTitleCard(q, chapterId, { enabled: (e.target as HTMLInputElement).checked })) });
  const title = h('input', { id: 'tc-title', value: tc.title ?? '', placeholder: ch.title, disabled: !editable, 'aria-label': 'Title' });
  title.addEventListener('input', () => edit('Title card text', (q) => setTitleCard(q, chapterId, { title: title.value }), `tc-title-${chapterId}`));
  const sub = h('input', { id: 'tc-subtitle', value: tc.subtitle ?? '', placeholder: 'Place and dates', disabled: !editable, 'aria-label': 'Subtitle' });
  sub.addEventListener('input', () => edit('Title card text', (q) => setTitleCard(q, chapterId, { subtitle: sub.value }), `tc-sub-${chapterId}`));
  const desc = h('textarea', { id: 'tc-description', rows: 2, placeholder: ch.description || 'A line about the chapter', disabled: !editable, 'aria-label': 'Line under the title' }, tc.description ?? '');
  desc.addEventListener('input', () => edit('Title card text', (q) => setTitleCard(q, chapterId, { description: desc.value }), `tc-desc-${chapterId}`));
  const layout = h('select', { id: 'tc-layout', disabled: !editable, 'aria-label': 'Layout' },
    ...([['center', 'Centred'], ['left', 'Left'], ['lower', 'Lower third']] as [TitleLayout, string][]).map(([v, l]) => h('option', { value: v, selected: (tc.layout ?? 'center') === v }, l)));
  layout.addEventListener('change', () => edit('Title card layout', (q) => setTitleCard(q, chapterId, { layout: layout.value as TitleLayout })));
  const pics = cx.timeline().segments.filter((x) => x.kind !== 'title' && x.chapterId === chapterId).map((x) => (x as { item: MediaItem }).item);
  const bg = h('select', { id: 'tc-background', disabled: !editable, 'aria-label': 'Background picture' },
    h('option', { value: '' }, 'Plain'), ...pics.map((m) => h('option', { value: m.id, selected: tc.backgroundItemId === m.id }, m.uri.split('/').pop() ?? m.id)));
  bg.addEventListener('change', () => edit('Title card background', (q) => setTitleCard(q, chapterId, { backgroundItemId: bg.value })));
  const dur = h('input', { type: 'number', id: 'tc-seconds', class: 'num', min: '1', max: '20', step: '0.5', value: tc.durationSec !== undefined ? fmt1(tc.durationSec) : '',
    placeholder: fmt1(p.cueProfile.titleCardSec), disabled: !editable, 'aria-label': 'Seconds' });
  dur.addEventListener('change', () => {
    const v = Number(dur.value);
    edit('Title card length', (q) => setTitleCard(q, chapterId, { durationSec: dur.value && v > 0 ? Math.min(20, v) : undefined }));
  });
  const override = (key: 'mapInset' | 'credits', id: string, label: string) => {
    const sel = h('select', { id, disabled: !editable, 'aria-label': label },
      h('option', { value: '', selected: !ch[key] }, 'As the travelogue'), h('option', { value: 'on', selected: ch[key] === 'on' }, 'Show'), h('option', { value: 'off', selected: ch[key] === 'off' }, 'Hide'));
    sel.addEventListener('change', () => edit(label, (q) => setChapterOverride(q, chapterId, key, (sel.value || null) as 'on' | 'off' | null)));
    return field(label, id, sel);
  };
  return [
    section('Title card', 'pe-sec-titlecard',
      h('div', { class: 'field' }, h('label', { class: 'small' }, on, ' Show a title card')),
      field('Title', 'tc-title', title), field('Subtitle', 'tc-subtitle', sub), field('Line under it', 'tc-description', desc),
      h('div', { class: 'row' }, field('Layout', 'tc-layout', layout), field('Seconds', 'tc-seconds', dur)),
      field('Background', 'tc-background', bg),
      h('p', { class: 'muted small' }, 'Leave a box empty to use the chapter\'s own title, place and dates.')),
    section('Map and credits', 'pe-sec-chapter-map',
      override('mapInset', 'ch-map', 'Map inset'),
      !ch.coordinates && h('p', { class: 'warn small', id: 'ch-no-place' }, 'This chapter has no place, so the map is hidden here. Set its place in the Itinerary.'),
      override('credits', 'ch-credits', 'Photo credits')),
  ];
}

// ---------------------------------------------------------------- Audio

export function audioSections(cx: CuePanelContext, item: MediaItem): HTMLElement[] {
  const s = cx.session;
  const editable = s.canEdit;
  const cue = s.state.cues.find((c) => c.itemId === item.id);
  const au = cue?.audio;
  if (!au) return [];
  const lane = s.state.audioLanes.find((l) => l.id === au.laneId);
  const clip = cx.timeline().audio.find((c) => c.item.id === item.id);
  const check = (id: string, checked: boolean, label: string, fn: (v: boolean) => void, disabled = false) =>
    h('div', { class: 'field' }, h('label', { class: 'small' }, h('input', { type: 'checkbox', id, checked, disabled: !editable || disabled,
      onchange: (e: Event) => fn((e.target as HTMLInputElement).checked) }), ` ${label}`));
  return [section('Fit and repeat', 'pe-sec-audio-fit',
    check('pe-loop', !!au.loop, 'Repeat until it stops', (v) => s.edit(v ? 'Loop audio' : 'Stop looping audio', (q) => setAudioCueFlag(q, item.id, 'loop', v))),
    check('pe-crossfade', !!au.crossfade, 'Crossfade with the clip before it', (v) => s.edit(v ? 'Crossfade audio' : 'No audio crossfade', (q) => setAudioCueFlag(q, item.id, 'crossfade', v)), au.fadeInSec <= 0),
    au.fadeInSec <= 0 && h('p', { class: 'muted small' }, 'Give it a fade-in to crossfade.'),
    h('div', { class: 'row wrap' },
      h('button', { id: 'pe-fit-chapter', disabled: !editable || !clip, onclick: () => s.edit('Fit audio to chapter', (q) => fitAudioToChapter(q, item.id, cx.timeline())) }, 'Fit to the chapter'),
      lane?.kind === 'narration' && h('button', { id: 'pe-fit-visuals', disabled: !editable || !clip?.anchorItemId,
        onclick: () => s.edit('Fit pictures to narration', (q) => fitVisualsToNarration(q, item.id, cx.timeline())) }, 'Fit pictures to it')),
    h('p', { class: 'muted small' }, lane?.kind === 'narration'
      ? '"Fit pictures to it" stretches the photos it plays over so they last as long as it does.'
      : '"Fit to the chapter" trims it to end with the chapter, or repeats it when it is shorter.'))];
}

function setAudioCueFlag(p: Travelogue, itemId: Id, key: 'loop' | 'crossfade', v: boolean): Travelogue {
  return {
    ...p,
    cues: p.cues.map((c) => {
      if (c.itemId !== itemId || !c.audio) return c;
      const audio = { ...c.audio };
      if (v) audio[key] = true;
      else delete audio[key];
      return { ...c, audio };
    }),
  };
}

/** AU-6: how much each lane lowers the others while it plays. */
export function laneSection(cx: CuePanelContext): HTMLElement {
  const s = cx.session;
  const lanes = s.state.audioLanes;
  const name = (k: string) => (k === 'narration' ? 'Narration' : k === 'music' ? 'Music' : 'Clip sound');
  const rows: HTMLElement[] = [];
  for (const l of lanes.filter((x) => x.kind !== 'clipSound')) {
    for (const t of lanes.filter((x) => x.id !== l.id && !(l.kind === 'music' && x.kind === 'narration'))) {
      const db = l.ducks.find((d) => d.laneId === t.id)?.db ?? 0;
      const id = `duck-${l.kind}-${t.kind}`;
      const input = h('input', { type: 'range', id, min: '-30', max: '0', step: '1', value: String(db), disabled: !s.canEdit, 'aria-label': `${name(l.kind)} lowers ${name(t.kind)} by dB` });
      const out = h('span', { class: 'small num-out' }, db ? `${db} dB` : 'off');
      input.addEventListener('input', () => {
        out.textContent = Number(input.value) ? `${input.value} dB` : 'off';
        s.edit('Lane ducking', (q) => setLaneDuck(q, l.id, t.id, Number(input.value)), { coalesceKey: id });
      });
      rows.push(h('div', { class: 'field' }, h('label', { for: id, class: 'small' }, `${name(l.kind)} lowers ${name(t.kind).toLowerCase()}`), h('div', { class: 'row' }, input, out)));
    }
  }
  return section('Ducking', 'pe-sec-ducking', ...rows,
    h('p', { class: 'muted small' }, 'Only clips with "Lower music and clip sound while this plays" switched on do this.'));
}
