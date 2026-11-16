/**
 * PE-6: move and resize the selected picture on the stage. A frame over the player canvas shows where the
 * picture sits; dragging it moves it, dragging a corner resizes it (keeping its shape), and both snap to the
 * centre and the thirds of the frame, with guide lines while snapped. The player previews the change live;
 * letting go saves it as a custom placement (one undoable edit).
 */
import { place, setPlacements, type Id, type MediaSegment, type NormRect, type Travelogue } from '../core/index.js';
import { h } from './dom.js';
import type { ProjectSession } from './session.js';
import type { Player } from '../player/player.js';

export interface StageEditor {
  setSelection(ids: Id[]): void;
  setActive(on: boolean): void;
  /** Call on every drawn frame and after edits. */
  refresh(): void;
}

/** Snap lines, as fractions of the frame. */
export const SNAP_LINES = [0, 1 / 3, 1 / 2, 2 / 3, 1];
const SNAP_PX = 8;

/**
 * Snap a rectangle (fractions of the frame) so its left, centre or right edge lands on a snap line when within
 * `tol` (a fraction), and the same vertically. Returns the snapped rectangle and the lines it snapped to.
 */
export function snapRect(r: NormRect, tolX: number, tolY: number, mode: 'move' | 'resize' = 'move'): { rect: NormRect; xs: number[]; ys: number[] } {
  const best = (vals: number[], tol: number) => {
    let hit: { d: number; line: number } | null = null;
    for (const v of vals) for (const line of SNAP_LINES) {
      const d = line - v;
      if (Math.abs(d) <= tol && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, line };
    }
    return hit;
  };
  const out = { ...r };
  const xs: number[] = [];
  const ys: number[] = [];
  if (mode === 'move') {
    const hx = best([r.x, r.x + r.w / 2, r.x + r.w], tolX);
    if (hx) { out.x += hx.d; xs.push(hx.line); }
    const hy = best([r.y, r.y + r.h / 2, r.y + r.h], tolY);
    if (hy) { out.y += hy.d; ys.push(hy.line); }
  } else {
    // Resizing from the bottom-right corner: snap the moving edges, keeping the shape.
    const hx = best([r.x + r.w], tolX);
    if (hx) {
      const k = (r.w + hx.d) / r.w;
      out.w = r.w * k;
      out.h = r.h * k;
      xs.push(hx.line);
    }
  }
  return { rect: out, xs, ys };
}

export function mountStageEditor(s: ProjectSession, player: Player, wrap: HTMLElement, canvas: HTMLCanvasElement): StageEditor {
  let ids: Id[] = [];
  let active = false;
  let dragging = false;
  const box = h('div', { class: 'stage-box', id: 'stage-box', hidden: true, title: 'Drag to move · drag a corner to resize' },
    h('span', { class: 'handle nw', 'data-corner': 'nw' }), h('span', { class: 'handle ne', 'data-corner': 'ne' }),
    h('span', { class: 'handle sw', 'data-corner': 'sw' }), h('span', { class: 'handle se', 'data-corner': 'se' }));
  const guides = h('div', { class: 'stage-guides', hidden: true });
  wrap.append(guides, box);

  /** The selected item's segment, when it is on screen now. */
  const current = (): MediaSegment | undefined => {
    if (ids.length !== 1) return undefined;
    const tl = player.timeline;
    const seg = tl.segments.find((x) => x.kind !== 'title' && x.item.id === ids[0]) as MediaSegment | undefined;
    if (!seg || player.time < seg.start || player.time > seg.start + seg.duration) return undefined;
    return seg;
  };

  /** Where the picture is, as fractions of the frame. */
  function rectOf(seg: MediaSegment): NormRect {
    const W = canvas.width, H = canvas.height;
    const media = seg.item.width && seg.item.height ? { w: seg.item.width, h: seg.item.height } : { w: W, h: H };
    const { dst } = place(seg.cue.placement, media, { w: W, h: H });
    return { x: dst.x / W, y: dst.y / H, w: dst.w / W, h: dst.h / H };
  }

  function show(r: NormRect) {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    box.style.left = `${r.x * cw}px`;
    box.style.top = `${r.y * ch}px`;
    box.style.width = `${r.w * cw}px`;
    box.style.height = `${r.h * ch}px`;
  }

  function refresh() {
    if (dragging) return;
    const seg = active && s.canEdit ? current() : undefined;
    box.hidden = !seg || player.state === 'playing';
    if (!seg || box.hidden) return;
    box.classList.toggle('custom', seg.cue.placement.mode === 'custom');
    show(rectOf(seg));
  }

  function drawGuides(xs: number[], ys: number[]) {
    guides.hidden = !xs.length && !ys.length;
    guides.replaceChildren(
      ...xs.map((v) => { const g = h('div', { class: 'guide v' }); g.style.left = `${v * canvas.clientWidth}px`; return g; }),
      ...ys.map((v) => { const g = h('div', { class: 'guide h' }); g.style.top = `${v * canvas.clientHeight}px`; return g; }));
  }

  box.addEventListener('pointerdown', (e) => {
    const seg = current();
    if (!seg || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const corner = (e.target as HTMLElement).dataset.corner;
    const start = rectOf(seg);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const x0 = e.clientX, y0 = e.clientY;
    const itemId = seg.item.id;
    let rect = start;
    let raf = 0;
    dragging = true;
    box.setPointerCapture(e.pointerId);
    const preview = () => {
      raf = 0;
      // Live preview: the player draws the edited project without saving it yet.
      player.setProject(setPlacements(s.state, [itemId], { mode: 'custom', rect }) as Travelogue);
    };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / cw, dy = (ev.clientY - y0) / ch;
      let r: NormRect;
      let mode: 'move' | 'resize' = 'move';
      if (!corner) r = { ...start, x: start.x + dx, y: start.y + dy };
      else {
        mode = 'resize';
        // Resize about the opposite corner, keeping the picture's shape.
        const sx = corner.includes('e') ? 1 : -1;
        const sy = corner.includes('s') ? 1 : -1;
        const grow = Math.max(sx * dx / start.w, sy * dy / start.h);
        const k = Math.max(0.1 / Math.min(start.w, start.h), 1 + grow);
        const w = start.w * k, hh = start.h * k;
        r = { x: sx > 0 ? start.x : start.x + start.w - w, y: sy > 0 ? start.y : start.y + start.h - hh, w, h: hh };
      }
      const snapped = ev.altKey ? { rect: r, xs: [], ys: [] } : snapRect(r, SNAP_PX / cw, SNAP_PX / ch, corner === 'se' || !corner ? mode : 'move');
      rect = corner && corner !== 'se' ? r : snapped.rect;
      drawGuides(corner && corner !== 'se' ? [] : snapped.xs, corner && corner !== 'se' ? [] : snapped.ys);
      show(rect);
      if (!raf) raf = requestAnimationFrame(preview);
    };
    const up = () => {
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', up);
      cancelAnimationFrame(raf);
      dragging = false;
      guides.hidden = true;
      const changed = Math.abs(rect.x - start.x) + Math.abs(rect.y - start.y) + Math.abs(rect.w - start.w) > 0.002;
      if (changed) s.edit(corner ? 'Resize on stage' : 'Move on stage', (p) => setPlacements(p, [itemId], { mode: 'custom', rect }));
      else player.setProject(s.state);
      refresh();
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
  });

  return {
    setSelection(next) {
      ids = next;
      refresh();
    },
    setActive(on) {
      active = on;
      refresh();
    },
    refresh,
  };
}
