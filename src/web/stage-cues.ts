/**
 * Phase 5 editing on the stage.
 *
 * - PE-11: while a photo's custom motion is being set, the stage shows the whole photo with two frames over it,
 *   green where the motion starts and red where it ends. Drag a frame to move it; drag its corner to zoom. The
 *   frames keep the shape of the picture's box, so what is inside them is what plays.
 * - PE-14: the selected picture's text boxes. Drag one to move it, its corner to resize it; clicking one picks it
 *   in the side panel.
 *
 * Dragging previews live in the player; letting go saves one undoable edit.
 */
import {
  annotationsOf, kenBurnsCrop, place, setMotion, updateAnnotation,
  type Id, type MediaSegment, type NormRect, type Rect, type Size, type Travelogue,
} from '../core/index.js';
import type { StageFocus } from './cue-panel.js';
import { h } from './dom.js';
import type { ProjectSession } from './session.js';
import type { Player } from '../player/player.js';

export interface StageCues {
  /** The project the player shows: while a motion is being set, its photo is shown whole and still. */
  present(p: Travelogue): Travelogue;
  setSelection(ids: Id[]): void;
  setActive(on: boolean): void;
  /** Focus changed (from the side panel). */
  focusChanged(): void;
  refresh(): void;
}

export function mountStageCues(s: ProjectSession, player: Player, wrap: HTMLElement, canvas: HTMLCanvasElement, focus: StageFocus, onPick: () => void): StageCues {
  let ids: Id[] = [];
  let active = false;
  let dragging = false;
  const layer = h('div', { class: 'stage-cues', id: 'stage-cues' });
  wrap.append(layer);
  const frames = {
    from: frameEl('from', 'Start'),
    to: frameEl('to', 'End'),
  };
  const textBoxes = new Map<Id, HTMLElement>();

  function frameEl(which: 'from' | 'to', label: string): HTMLElement {
    const el = h('div', { class: `kb-frame ${which}`, id: `kb-${which}`, hidden: true, title: `${label}: drag to move · drag the corner to zoom` },
      h('span', { class: 'kb-label' }, label), h('span', { class: 'handle se', 'data-corner': 'se' }));
    layer.append(el);
    el.addEventListener('pointerdown', (e) => dragFrame(e, which, el));
    return el;
  }

  const segOf = (id: Id): MediaSegment | undefined =>
    player.timeline.segments.find((x) => x.kind !== 'title' && x.item.id === id) as MediaSegment | undefined;
  const onScreen = (seg: MediaSegment) => player.time >= seg.start && player.time <= seg.start + seg.duration;
  const out = (): Size => ({ w: s.state.output.width, h: s.state.output.height });
  const mediaSize = (seg: MediaSegment): Size => (seg.item.width && seg.item.height ? { w: seg.item.width, h: seg.item.height } : out());

  function present(p: Travelogue): Travelogue {
    const id = focus.motionItem;
    if (!id || !active) return p;
    return {
      ...p,
      cues: p.cues.map((c) => (c.itemId !== id ? c : {
        ...c,
        animation: { type: 'none' as const },
        placement: { mode: 'fit' as const },
        entrance: c.entrance.type === 'crossfade' ? c.entrance : { type: 'cut' as const, durationSec: 0 },
        exit: { type: 'cut' as const, durationSec: 0 },
      })),
    };
  }

  /** The photo shown whole on the stage, in canvas pixels of the frame (fractions → px via the client size). */
  function wholeRect(seg: MediaSegment): Rect {
    return place({ mode: 'fit' }, mediaSize(seg), out()).dst;
  }

  /** The box the photo plays in (its real placement), whose shape the frames keep. */
  function playBox(seg: MediaSegment): Size {
    const cue = s.state.cues.find((c) => c.itemId === seg.item.id)!;
    const { dst } = place(cue.placement, mediaSize(seg), out());
    return { w: dst.w, h: dst.h };
  }

  /** A crop of the photo (photo px) → client px over the stage. */
  function toClient(seg: MediaSegment, crop: Rect): Rect {
    const whole = wholeRect(seg);
    const m = mediaSize(seg);
    const kx = canvas.clientWidth / out().w, ky = canvas.clientHeight / out().h;
    const sx = whole.w / m.w, sy = whole.h / m.h;
    return { x: (whole.x + crop.x * sx) * kx, y: (whole.y + crop.y * sy) * ky, w: crop.w * sx * kx, h: crop.h * sy * ky };
  }

  function place_(el: HTMLElement, r: Rect) {
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
  }

  function refresh() {
    if (dragging) return;
    const paused = player.state !== 'playing';
    wrap.classList.toggle('kb-editing', !!focus.motionItem && active);
    // Ken Burns frames.
    const mseg = focus.motionItem && active && paused ? segOf(focus.motionItem) : undefined;
    const cue = mseg && s.state.cues.find((c) => c.itemId === mseg.item.id);
    const anim = cue?.animation.type === 'kenBurns' ? cue.animation : undefined;
    const showKb = !!(mseg && anim && onScreen(mseg) && s.canEdit);
    for (const which of ['from', 'to'] as const) {
      frames[which].hidden = !showKb;
      if (showKb) place_(frames[which], toClient(mseg!, kenBurnsCrop(anim![which], anim![which], 0, mediaSize(mseg!), playBox(mseg!))));
    }
    // Text boxes of the one selected picture.
    const one = ids.length === 1 && active && paused && !focus.motionItem ? segOf(ids[0]) : undefined;
    const anns = one && onScreen(one) && s.canEdit ? annotationsOf(s.state, one.item.id) : [];
    const keep = new Set(anns.map((a) => a.id));
    for (const [id, el] of textBoxes) if (!keep.has(id)) { el.remove(); textBoxes.delete(id); }
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    for (const a of anns) {
      let el = textBoxes.get(a.id);
      if (!el) {
        el = h('div', { class: 'ann-box', 'data-annotation': a.id, title: 'Drag to move · drag the corner to resize' }, h('span', { class: 'handle se', 'data-corner': 'se' }));
        el.addEventListener('pointerdown', (e) => dragText(e, a.id, el!));
        layer.append(el);
        textBoxes.set(a.id, el);
      }
      el.classList.toggle('focused', focus.annotation === a.id);
      place_(el, { x: a.position.x * cw, y: a.position.y * ch, w: a.position.w * cw, h: a.position.h * ch });
    }
  }

  function dragFrame(e: PointerEvent, which: 'from' | 'to', el: HTMLElement) {
    const id = focus.motionItem;
    const seg = id ? segOf(id) : undefined;
    const cue = seg && s.state.cues.find((c) => c.itemId === seg.item.id);
    if (!seg || !cue || cue.animation.type !== 'kenBurns' || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const m = mediaSize(seg);
    const box = playBox(seg);
    const start = kenBurnsCrop(cue.animation[which], cue.animation[which], 0, m, box);
    const whole = wholeRect(seg);
    // client px → photo px
    const k = (m.w / whole.w) * (out().w / canvas.clientWidth);
    const corner = (e.target as HTMLElement).dataset.corner;
    const x0 = e.clientX, y0 = e.clientY;
    const anim = { from: cue.animation.from, to: cue.animation.to };
    let crop = start;
    dragging = true;
    el.setPointerCapture(e.pointerId);
    const norm = (r: Rect): NormRect => ({ x: r.x / m.w, y: r.y / m.h, w: r.w / m.w, h: r.h / m.h });
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) * k, dy = (ev.clientY - y0) * k;
      if (!corner) {
        crop = { ...start, x: Math.max(0, Math.min(m.w - start.w, start.x + dx)), y: Math.max(0, Math.min(m.h - start.h, start.y + dy)) };
      } else {
        // Zoom about the top-left corner, keeping the box's shape and staying inside the photo.
        const aspect = box.w / box.h;
        let w = Math.max(m.w * 0.08, start.w + Math.max(dx, dy * aspect));
        w = Math.min(w, m.w - start.x, (m.h - start.y) * aspect);
        crop = { x: start.x, y: start.y, w, h: w / aspect };
      }
      place_(el, toClient(seg, crop));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      dragging = false;
      const moved = Math.abs(crop.x - start.x) + Math.abs(crop.y - start.y) + Math.abs(crop.w - start.w) > 0.5;
      if (moved) s.edit(which === 'from' ? 'Motion start' : 'Motion end', (p) => setMotion(p, [seg.item.id], { ...anim, [which]: norm(crop) }));
      refresh();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  function dragText(e: PointerEvent, annId: Id, el: HTMLElement) {
    const a = s.state.annotations.find((x) => x.id === annId);
    if (!a || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (focus.annotation !== annId) {
      focus.annotation = annId;
      onPick();
    }
    const corner = (e.target as HTMLElement).dataset.corner;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const start = a.position;
    const x0 = e.clientX, y0 = e.clientY;
    let pos = start;
    let raf = 0;
    dragging = true;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / cw, dy = (ev.clientY - y0) / ch;
      pos = corner
        ? { ...start, w: Math.max(0.05, Math.min(1 - start.x, start.w + dx)), h: Math.max(0.03, Math.min(1 - start.y, start.h + dy)) }
        : { ...start, x: Math.max(0, Math.min(1 - start.w, start.x + dx)), y: Math.max(0, Math.min(1 - start.h, start.y + dy)) };
      place_(el, { x: pos.x * cw, y: pos.y * ch, w: pos.w * cw, h: pos.h * ch });
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; player.setProject(present(updateAnnotation(s.state, annId, { position: pos }))); });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      cancelAnimationFrame(raf);
      dragging = false;
      const changed = Math.abs(pos.x - start.x) + Math.abs(pos.y - start.y) + Math.abs(pos.w - start.w) + Math.abs(pos.h - start.h) > 0.002;
      if (changed) s.edit(corner ? 'Resize text' : 'Move text', (p) => updateAnnotation(p, annId, { position: pos }));
      else player.setProject(present(s.state));
      refresh();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  return {
    present,
    setSelection(next) {
      ids = next;
      refresh();
    },
    setActive(on) {
      active = on;
      player.setProject(present(s.state));
      refresh();
    },
    focusChanged() {
      player.setProject(present(s.state));
      refresh();
    },
    refresh,
  };
}
