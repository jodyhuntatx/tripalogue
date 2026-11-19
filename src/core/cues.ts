/**
 * Phase 5 cue edits (PE-10 to PE-18, MV-3, AU-6 to AU-9). Each is a pure function from a project to a new one, applied
 * through the session like every other edit (undoable, autosaved, in the operation log).
 */
import { autoKenBurns, defaultAnnotationBox } from './render-model.js';
import { MIN_IMAGE_SEC, patchCues } from './presentation.js';
import { setVideoTrim } from './media-edits.js';
import type {
  Annotation, AnnotationKind, AnnotationStyle, Chapter, Cue, CuePreset, CueStyle, Id, NormRect, TitleCard, Transition, Travelogue,
} from './schema.js';
import { buildTimeline, type Timeline } from './timeline.js';

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

const round2 = (x: number) => Math.round(x * 100) / 100;

/** PE-10, PE-12, PE-16: the entrance or exit of the items. Exits cannot zoom or crossfade. */
export function setTransition(p: Travelogue, ids: Id[], which: 'entrance' | 'exit', tr: Transition): Travelogue {
  if (which === 'exit' && (tr.type === 'zoom' || tr.type === 'crossfade')) return p;
  const t: Transition = { type: tr.type, durationSec: round2(Math.max(0, Math.min(5, tr.durationSec))) };
  if (tr.type === 'slide') t.direction = tr.direction ?? (which === 'entrance' ? 'right' : 'left');
  return patchCues(p, ids, (c) => ({ ...c, [which]: t }));
}

/** PE-11: no motion, a gentle automatic pan and zoom, or a motion between two picked views (stills only). */
export function setMotion(p: Travelogue, ids: Id[], motion: 'none' | 'auto' | { from: NormRect; to: NormRect }): Travelogue {
  return patchCues(p, ids, (c, m) => {
    if (m.kind !== 'image') return c;
    if (motion === 'none') return c.animation.type === 'none' ? c : { ...c, animation: { type: 'none' } };
    if (motion === 'auto') return { ...c, animation: { type: 'kenBurns', ...autoKenBurns(m.id), auto: true } };
    return { ...c, animation: { type: 'kenBurns', from: clampRect(motion.from), to: clampRect(motion.to) } };
  });
}

/** Keep a picture-relative rectangle inside the picture. */
export function clampRect(r: NormRect): NormRect {
  const w = Math.max(0.05, Math.min(1, r.w)), h = Math.max(0.05, Math.min(1, r.h));
  return { x: round4(Math.max(0, Math.min(1 - w, r.x))), y: round4(Math.max(0, Math.min(1 - h, r.y))), w: round4(w), h: round4(h) };
}
const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** PE-13: video playback speed, 0.25x to 4x (the clip's length on the timeline follows). */
export function setSpeed(p: Travelogue, ids: Id[], speed: number): Travelogue {
  const v = round2(Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed)));
  return patchCues(p, ids, (c, m) => (m.kind !== 'video' || c.speed === v ? c : { ...c, speed: v }));
}

/** PE-13: silence a video's own sound (or bring it back). */
export function setMute(p: Travelogue, ids: Id[], mute: boolean): Travelogue {
  return patchCues(p, ids, (c, m) => {
    if (m.kind !== 'video') return c;
    if (mute) return c.mute ? c : { ...c, mute: true };
    if (!c.mute) return c;
    const { mute: _m, ...rest } = c;
    void _m;
    return rest;
  });
}

/** MV-3: the map inset while these items show: on, off, or as their chapter (null). */
export function setItemMapInset(p: Travelogue, ids: Id[], v: 'on' | 'off' | null): Travelogue {
  return patchCues(p, ids, (c) => {
    if (v) return c.mapInset === v ? c : { ...c, mapInset: v };
    if (!c.mapInset) return c;
    const { mapInset: _x, ...rest } = c;
    void _x;
    return rest;
  });
}

// ---------------------------------------------------------------- annotations (PE-14)

const DEFAULT_STYLE: Record<AnnotationKind, AnnotationStyle> = { caption: 'subtitle', place: 'lowerThird', date: 'stamp' };

/** A new caption, place label or date stamp on an item, showing for its whole length. */
export function addAnnotation(p: Travelogue, itemId: Id, kind: AnnotationKind, id: Id, text = ''): Travelogue {
  if (!p.media.some((m) => m.id === itemId) || p.annotations.some((a) => a.id === id)) return p;
  const style = DEFAULT_STYLE[kind];
  // A second annotation of the same style on an item goes a little higher, so they do not sit on each other.
  const same = p.annotations.filter((a) => a.target.type === 'item' && a.target.itemId === itemId && a.style === style).length;
  const box = defaultAnnotationBox(style);
  const a: Annotation = {
    id, target: { type: 'item', itemId }, kind, text, style,
    position: { ...box, y: Math.max(0, box.y - same * (box.h + 0.01) * (box.y > 0.5 ? 1 : -1)) },
    startSec: 0, durationSec: 0,
  };
  return { ...p, annotations: [...p.annotations, a] };
}

export function updateAnnotation(p: Travelogue, id: Id, patch: Partial<Pick<Annotation, 'text' | 'style' | 'position' | 'startSec' | 'durationSec' | 'kind'>>): Travelogue {
  let changed = false;
  const annotations = p.annotations.map((a) => {
    if (a.id !== id) return a;
    changed = true;
    const next = { ...a, ...patch };
    if (patch.position) next.position = clampBox(patch.position);
    if (patch.startSec !== undefined) next.startSec = round2(Math.max(0, patch.startSec));
    if (patch.durationSec !== undefined) next.durationSec = round2(Math.max(0, patch.durationSec));
    return next;
  });
  return changed ? { ...p, annotations } : p;
}

/** Keep a box on the stage (a little may hang off, never all of it). */
function clampBox(r: NormRect): NormRect {
  const w = Math.max(0.05, Math.min(1, r.w)), h = Math.max(0.03, Math.min(1, r.h));
  return { x: round4(Math.max(0, Math.min(1 - w, r.x))), y: round4(Math.max(0, Math.min(1 - h, r.y))), w: round4(w), h: round4(h) };
}

export function removeAnnotation(p: Travelogue, id: Id): Travelogue {
  return p.annotations.some((a) => a.id === id) ? { ...p, annotations: p.annotations.filter((a) => a.id !== id) } : p;
}

export function annotationsOf(p: Travelogue, itemId: Id): Annotation[] {
  return p.annotations.filter((a) => a.target.type === 'item' && a.target.itemId === itemId);
}

// ---------------------------------------------------------------- chapters (PE-15, MV-3, PE-18)

/** PE-15: edit a chapter's title card. An empty title or subtitle goes back to the chapter's own (key removed). */
export function setTitleCard(p: Travelogue, chapterId: Id, patch: Partial<TitleCard>): Travelogue {
  return {
    ...p,
    chapters: p.chapters.map((c) => {
      if (c.id !== chapterId) return c;
      const tc: TitleCard = { ...c.titleCard, ...patch };
      for (const k of ['title', 'subtitle', 'backgroundItemId'] as const) if (patch[k] !== undefined && patch[k] === '') delete tc[k];
      if (patch.description === null as unknown) delete tc.description;
      if (patch.layout === 'center') delete tc.layout;
      return { ...c, titleCard: tc };
    }),
  };
}

/** MV-3, PE-18: a chapter's own map inset and photo credits setting (null = as the travelogue). */
export function setChapterOverride(p: Travelogue, chapterId: Id, key: 'mapInset' | 'credits', v: 'on' | 'off' | null): Travelogue {
  return {
    ...p,
    chapters: p.chapters.map((c): Chapter => {
      if (c.id !== chapterId) return c;
      const next = { ...c };
      if (v) next[key] = v;
      else delete next[key];
      return next;
    }),
  };
}

// ---------------------------------------------------------------- copy, paste, presets (PE-17)

/** The parts of a cue that carry over to other items. */
export function cueStyleOf(c: Cue): CueStyle {
  const s: CueStyle = { placement: c.placement, entrance: c.entrance, exit: c.exit, animation: c.animation, speed: c.speed, volume: c.volume };
  if (c.durationSec !== undefined) s.durationSec = c.durationSec;
  if (c.mute) s.mute = true;
  return s;
}

/**
 * Apply a copied cue style to items. What fits the kind carries: an image takes the duration and motion (an auto
 * motion is chosen afresh for each photo), a video takes the speed, volume and mute; both take placement,
 * entrance and exit.
 */
export function pasteCueStyle(p: Travelogue, ids: Id[], style: CueStyle): Travelogue {
  return patchCues(p, ids, (c, m) => {
    if (m.kind !== 'image' && m.kind !== 'video') return c;
    const next: Cue = { ...c };
    if (style.placement) next.placement = style.placement;
    if (style.entrance) next.entrance = style.entrance;
    if (style.exit) next.exit = style.exit;
    if (m.kind === 'image') {
      if (style.durationSec !== undefined) next.durationSec = Math.max(MIN_IMAGE_SEC, style.durationSec);
      if (style.animation) {
        next.animation = style.animation.type === 'kenBurns' && style.animation.auto
          ? { type: 'kenBurns', ...autoKenBurns(m.id), auto: true }
          : style.animation;
      }
    } else {
      if (style.speed !== undefined) next.speed = style.speed;
      if (style.volume !== undefined) next.volume = style.volume;
      if (style.mute) next.mute = true;
      else delete next.mute;
    }
    return next;
  });
}

export function savePreset(p: Travelogue, id: Id, name: string, style: CueStyle): Travelogue {
  const preset: CuePreset = { id, name: name.trim() || 'Preset', cue: style };
  return { ...p, cuePresets: [...(p.cuePresets ?? []).filter((x) => x.id !== id), preset] };
}

export function deletePreset(p: Travelogue, id: Id): Travelogue {
  return { ...p, cuePresets: (p.cuePresets ?? []).filter((x) => x.id !== id) };
}

export function applyPreset(p: Travelogue, ids: Id[], presetId: Id): Travelogue {
  const preset = p.cuePresets?.find((x) => x.id === presetId);
  return preset ? pasteCueStyle(p, ids, preset.cue) : p;
}

// ---------------------------------------------------------------- audio (AU-6 to AU-9)

/** AU-6: how many dB a lane lowers another while it plays (0 = not at all). */
export function setLaneDuck(p: Travelogue, laneId: Id, targetLaneId: Id, db: number): Travelogue {
  const v = Math.round(Math.max(-40, Math.min(0, db)));
  return {
    ...p,
    audioLanes: p.audioLanes.map((l) => {
      if (l.id !== laneId) return l;
      const others = l.ducks.filter((d) => d.laneId !== targetLaneId);
      return { ...l, ducks: v === 0 ? others : [...others, { laneId: targetLaneId, db: v }] };
    }),
  };
}

/**
 * AU-8: make an audio clip fill the rest of its chapter: a clip longer than that is trimmed to end with the chapter
 * (fading out over the last 2 s); a shorter one loops. It no longer plays on into the next chapters.
 */
export function fitAudioToChapter(p: Travelogue, itemId: Id, tl: Timeline = buildTimeline(p)): Travelogue {
  const clip = tl.audio.find((c) => c.item.id === itemId);
  const ch = clip && tl.chapters.find((c) => c.chapterId === clip.chapterId);
  const m = p.media.find((x) => x.id === itemId);
  const cue = p.cues.find((c) => c.itemId === itemId);
  if (!clip || !ch || !m || !cue?.audio || m.durationSec === undefined) return p;
  const room = ch.end - clip.start;
  const inPt = cue.inPointSec ?? 0;
  const own = (cue.outPointSec ?? m.durationSec) - inPt;
  let next = p;
  if (own >= room) next = setVideoTrim(next, itemId, inPt, Math.round((inPt + room) * 1000) / 1000);
  return patchCues(next, [itemId], (c) => {
    if (!c.audio) return c;
    const audio = { ...c.audio, fadeOutSec: Math.max(c.audio.fadeOutSec, Math.min(2, room / 4)) };
    delete audio.spanChapters;
    if (own < room) audio.loop = true;
    else delete audio.loop;
    return { ...c, audio };
  });
}

/**
 * AU-9: stretch the pictures a narration plays over (from the one it is anchored to, to the last one that starts
 * before it ends) so together they last as long as the narration. Photos change length; videos keep theirs.
 */
export function fitVisualsToNarration(p: Travelogue, itemId: Id, tl: Timeline = buildTimeline(p)): Travelogue {
  const clip = tl.audio.find((c) => c.item.id === itemId);
  if (!clip?.anchorItemId) return p;
  const segs = tl.segments.filter((s) => s.kind !== 'title' && s.chapterIndex === clip.chapterIndex);
  const first = segs.findIndex((s) => s.kind !== 'title' && s.item.id === clip.anchorItemId);
  if (first < 0) return p;
  const end = clip.start + clip.duration;
  const covered = segs.slice(first).filter((s, k) => k === 0 || s.start < end);
  const startAt = covered[0].start;
  const fixed = covered.filter((s) => s.kind === 'video').reduce((n, s) => n + s.duration, 0);
  const images = covered.filter((s) => s.kind === 'image');
  if (!images.length) return p;
  const want = Math.max(images.length * MIN_IMAGE_SEC, end - startAt - fixed);
  const each = Math.round((want / images.length) * 10) / 10;
  return patchCues(p, images.map((s) => (s.kind === 'title' ? '' : s.item.id)), (c) => ({ ...c, durationSec: Math.max(MIN_IMAGE_SEC, each) }));
}
