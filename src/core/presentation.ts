/**
 * Presentation editor edits (Phase 3): turning the auto-sorted draft into a cut. Pure functions on the project,
 * run through the browser session (undoable, saved, followed by keepAssigned) like every other edit.
 */
import { keyBetween } from './fractional.js';
import { dropIntoChapter, setVideoTrim } from './media-edits.js';
import { defaultCue } from './project.js';
import type { AudioAnchor, AudioCue, Cue, Id, MediaItem, Placement, Travelogue } from './schema.js';
import { buildTimeline, type Timeline } from './timeline.js';

/** Image durations are kept between these, in seconds (PE-5). */
export const MIN_IMAGE_SEC = 0.5;
export const MAX_IMAGE_SEC = 600;

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const cmp = (a: Cue, b: Cue) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);

export function patchCues(p: Travelogue, ids: Iterable<Id>, fn: (c: Cue, m: MediaItem) => Cue): Travelogue {
  const want = new Set(ids);
  const media = new Map(p.media.map((m) => [m.id, m]));
  let changed = false;
  // An item with no cue yet (a hand-written project may leave some out) gets the default one, last in its chapter.
  const missing = [...want].filter((id) => media.has(id) && !p.cues.some((c) => c.itemId === id));
  let base = p.cues;
  for (const id of missing) {
    const m = media.get(id)!;
    const siblings = new Set(p.media.filter((x) => x.chapterId === m.chapterId).map((x) => x.id));
    const last = base.filter((c) => siblings.has(c.itemId)).map((c) => c.order).sort().pop() ?? null;
    base = [...base, defaultCue(m, p.cueProfile, keyBetween(last, null))];
    changed = true;
  }
  const cues = base.map((c) => {
    const m = media.get(c.itemId);
    if (!want.has(c.itemId) || !m) return c;
    const next = fn(c, m);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...p, cues } : p;
}

/** The visual cues of a chapter in play order (excluded ones included). */
export function chapterCues(p: Travelogue, chapterId: Id): Cue[] {
  const inChapter = new Set(p.media.filter((m) => m.chapterId === chapterId && m.kind !== 'audio').map((m) => m.id));
  return p.cues.filter((c) => inChapter.has(c.itemId)).sort(cmp);
}

/**
 * PE-3: move one or more items to a place in a chapter, just before `beforeId` (or at the end). Within a chapter
 * only the order changes. Across chapters, `setTime` gives each item a time inside its new chapter (as dragging in
 * the Media view does); otherwise the items keep their own times and stay in the chapter by hand (chapterLocked)
 * until their time is changed.
 */
export function moveClips(p: Travelogue, ids: Id[], chapterId: Id, beforeId: Id | null, opts: { setTime: boolean } = { setTime: false }): Travelogue {
  const moving = ids.filter((id) => p.media.some((m) => m.id === id && m.kind !== 'audio'));
  if (!moving.length || !p.chapters.some((c) => c.id === chapterId)) return p;
  const set = new Set(moving);
  const leaving = moving.filter((id) => p.media.find((m) => m.id === id)!.chapterId !== chapterId);
  let out = p;
  if (leaving.length) {
    if (opts.setTime) out = dropIntoChapter(out, leaving, chapterId, beforeId && !set.has(beforeId) ? beforeId : undefined);
    const left = new Set(leaving);
    out = {
      ...out,
      media: out.media.map((m) => (left.has(m.id) ? (opts.setTime ? m : { ...m, chapterId, chapterLocked: true }) : m)),
    };
  }
  // Keep the moving items' relative order; give them keys between the drop neighbours.
  const prevOrder = new Map(p.cues.map((c) => [c.itemId, c.order]));
  const movingSorted = moving.slice().sort((a, b) => {
    const ca = p.media.find((m) => m.id === a)!.chapterId, cb = p.media.find((m) => m.id === b)!.chapterId;
    const ia = p.chapters.findIndex((c) => c.id === ca), ib = p.chapters.findIndex((c) => c.id === cb);
    return ia !== ib ? ia - ib : (prevOrder.get(a) ?? '') < (prevOrder.get(b) ?? '') ? -1 : 1;
  });
  const rest = chapterCues(out, chapterId).filter((c) => !set.has(c.itemId));
  const at = beforeId ? rest.findIndex((c) => c.itemId === beforeId) : -1;
  let lo: string | null = at < 0 ? rest[rest.length - 1]?.order ?? null : rest[at - 1]?.order ?? null;
  const hi: string | null = at < 0 ? null : rest[at].order;
  const keys = new Map<Id, string>();
  for (const id of movingSorted) {
    const k = keyBetween(lo, hi);
    keys.set(id, k);
    lo = k;
  }
  return { ...out, cues: out.cues.map((c) => (keys.has(c.itemId) ? { ...c, order: keys.get(c.itemId)! } : c)) };
}

/** PE-4 / PE-8: include or exclude items (excluded items stay in the project, in the Excluded tray). */
export function setIncludedMany(p: Travelogue, ids: Id[], included: boolean): Travelogue {
  return patchCues(p, ids, (c) => (c.included === included ? c : { ...c, included }));
}

/**
 * PE-5 / PE-8: how long items play. Images get the duration; videos are trimmed to it from their in-point (never
 * past their end); audio is left alone.
 */
export function setDurations(p: Travelogue, ids: Id[], sec: number): Travelogue {
  if (!Number.isFinite(sec)) return p;
  let out = patchCues(p, ids, (c, m) => {
    if (m.kind !== 'image') return c;
    const d = r1(Math.max(MIN_IMAGE_SEC, Math.min(MAX_IMAGE_SEC, sec)));
    return c.durationSec === d ? c : { ...c, durationSec: d };
  });
  for (const id of ids) {
    const m = out.media.find((x) => x.id === id);
    const c = out.cues.find((x) => x.itemId === id);
    if (m?.kind !== 'video' || !c) continue;
    const inPt = c.inPointSec ?? 0;
    out = setVideoTrim(out, id, inPt, inPt + sec * (c.speed || 1));
  }
  return out;
}

/** PE-6 / PE-8: placement for one or many items. */
export function setPlacements(p: Travelogue, ids: Id[], placement: Placement): Travelogue {
  const norm: Placement = placement.mode === 'custom' && placement.rect
    ? { mode: 'custom', rect: { x: r3(placement.rect.x), y: r3(placement.rect.y), w: r3(placement.rect.w), h: r3(placement.rect.h) } }
    : { mode: placement.mode === 'custom' ? 'fit' : placement.mode };
  return patchCues(p, ids, (c, m) => (m.kind === 'audio' ? c : { ...c, placement: norm }));
}

/**
 * PE-7: back to the cue profile's defaults (duration, trim, placement, fades, animation, speed, volume). Order,
 * inclusion and an audio clip's place on its lane are kept.
 */
export function resetCues(p: Travelogue, ids: Id[]): Travelogue {
  return patchCues(p, ids, (c, m) => {
    const d = defaultCue(m, p.cueProfile, c.order);
    const next: Cue = { ...d, included: c.included, ...(c.audio ? { audio: c.audio } : {}) };
    if (m.kind === 'audio') {
      delete next.durationSec;
    }
    return JSON.stringify(next) === JSON.stringify(c) ? c : next;
  });
}

/** PE-7: reset every visual item of a chapter. */
export function resetChapter(p: Travelogue, chapterId: Id): Travelogue {
  return resetCues(p, chapterCues(p, chapterId).map((c) => c.itemId));
}

/** PE-9: the length to aim for, or null to clear it. */
export function setTarget(p: Travelogue, sec: number | null): Travelogue {
  if (sec === null || !(sec > 0)) {
    if (p.targetSec === undefined) return p;
    const { targetSec: _t, ...rest } = p;
    return rest;
  }
  const v = Math.round(sec);
  return p.targetSec === v ? p : { ...p, targetSec: v };
}

// ---------------------------------------------------------------- audio lanes (AU-1 to AU-3)

/** Default fades and ducking for a clip on a lane: music fades 1 s in and out; narration ducks the others. */
/** Defaults for a clip put on a lane: music fades, plays on across chapters and is not ducking; narration ducks. */
export function audioDefaults(p: Travelogue, laneId: Id): Pick<AudioCue, 'fadeInSec' | 'fadeOutSec' | 'duck' | 'spanChapters'> {
  const kind = p.audioLanes.find((l) => l.id === laneId)?.kind;
  return kind === 'music' ? { fadeInSec: 1, fadeOutSec: 1, duck: false, spanChapters: true } : { fadeInSec: 0.2, fadeOutSec: 0.2, duck: true };
}

/**
 * AU-1: put an audio item on a lane, starting at `atSec` on the travelogue clock. Narration anchors to the
 * visual item playing at that moment (it moves with it); music anchors to the chapter's time. `anchor` overrides.
 */
export function placeAudio(p: Travelogue, itemId: Id, laneId: Id, atSec: number, anchor?: 'item' | 'chapterTime', tl: Timeline = buildTimeline(p)): Travelogue {
  const m = p.media.find((x) => x.id === itemId);
  const lane = p.audioLanes.find((l) => l.id === laneId);
  if (!m || m.kind !== 'audio' || !lane || lane.kind === 'clipSound') return p;
  const kind = anchor ?? (lane.kind === 'narration' ? 'item' : 'chapterTime');
  const a = anchorAt(tl, atSec, kind);
  if (!a) return p;
  const prev = p.cues.find((c) => c.itemId === itemId);
  const keep = prev?.audio && prev.audio.laneId === laneId ? prev.audio : undefined;
  const audio: AudioCue = { laneId, anchor: a, ...(keep ? { fadeInSec: keep.fadeInSec, fadeOutSec: keep.fadeOutSec, duck: keep.duck, ...(keep.spanChapters ? { spanChapters: true } : {}) } : audioDefaults(p, laneId)) };
  if (!prev) {
    const cue = { ...defaultCue(m, p.cueProfile, keyBetween(null, null)), audio };
    delete cue.durationSec;
    return { ...p, cues: [...p.cues, cue] };
  }
  return patchCues(p, [itemId], (c) => ({ ...c, included: true, audio }));
}

/** The anchor for a moment on the travelogue clock: the visual item playing then, or the chapter's own time. */
export function anchorAt(tl: Timeline, atSec: number, kind: 'item' | 'chapterTime'): AudioAnchor | undefined {
  const ch = tl.chapters.find((c) => atSec >= c.start && atSec < c.end) ?? (atSec >= tl.duration ? tl.chapters[tl.chapters.length - 1] : tl.chapters[0]);
  if (!ch) return undefined;
  const t = Math.max(ch.start, Math.min(atSec, ch.end - 0.1));
  if (kind === 'item') {
    const segs = tl.segments.filter((s) => s.kind !== 'title' && s.chapterId === ch.chapterId);
    // The item playing then; on the title card, the chapter's first item with a negative offset (a lead-in).
    const seg = segs.find((s) => t >= s.start && t < s.start + s.duration) ?? segs.find((s) => s.start >= t) ?? segs[segs.length - 1];
    if (seg && seg.kind !== 'title') return { type: 'item', itemId: seg.item.id, offsetSec: r3(t - seg.start) };
  }
  return { type: 'chapterTime', chapterId: ch.chapterId, offsetSec: r3(Math.max(0, t - ch.start)) };
}

/** AU-2: switch a clip between moving with an item and staying at a chapter time, keeping where it plays now. */
export function setAudioAnchorKind(p: Travelogue, itemId: Id, kind: 'item' | 'chapterTime', tl: Timeline = buildTimeline(p)): Travelogue {
  const clip = tl.audio.find((c) => c.item.id === itemId);
  const cue = p.cues.find((c) => c.itemId === itemId);
  if (!clip || !cue?.audio || cue.audio.anchor.type === kind) return p;
  const a = anchorAt(tl, clip.start, kind);
  return a ? patchCues(p, [itemId], (c) => ({ ...c, audio: { ...c.audio!, anchor: a } })) : p;
}

/** AU-1: move a clip on the clock (dragging it along its lane or onto the other lane), keeping its anchor kind. */
export function moveAudio(p: Travelogue, itemId: Id, atSec: number, laneId?: Id, tl: Timeline = buildTimeline(p)): Travelogue {
  const cue = p.cues.find((c) => c.itemId === itemId);
  if (!cue?.audio) return p;
  const lane = laneId ?? cue.audio.laneId;
  const a = anchorAt(tl, atSec, cue.audio.anchor.type);
  if (!a) return p;
  return patchCues(p, [itemId], (c) => ({ ...c, audio: { ...c.audio!, laneId: lane, anchor: a } }));
}

/** Take a clip off its lane (the audio item stays in the project, ready to be placed again). */
export function unplaceAudio(p: Travelogue, itemId: Id): Travelogue {
  return patchCues(p, [itemId], (c) => {
    if (!c.audio) return c;
    const { audio: _a, ...rest } = c;
    return rest;
  });
}

/** AU-3: an audio clip's fades and ducking. */
export function setAudioCue(p: Travelogue, itemId: Id, patch: Partial<Pick<AudioCue, 'fadeInSec' | 'fadeOutSec' | 'duck' | 'spanChapters' | 'loop' | 'crossfade'>>): Travelogue {
  return patchCues(p, [itemId], (c) => {
    if (!c.audio) return c;
    const audio = { ...c.audio, ...patch };
    // Off is the default: leave the key out.
    for (const k of ['spanChapters', 'loop', 'crossfade'] as const) if (patch[k] === false) delete audio[k];
    return { ...c, audio };
  });
}

/**
 * Trim an audio clip from either end, as when dragging its edges. Trimming the start keeps the rest of the sound
 * where it was on the timeline (the clip starts later by as much); trimming the end shortens it.
 */
export function trimAudio(p: Travelogue, itemId: Id, edge: 'start' | 'end', mediaSec: number, tl: Timeline = buildTimeline(p)): Travelogue {
  const m = p.media.find((x) => x.id === itemId);
  const cue = p.cues.find((c) => c.itemId === itemId);
  const clip = tl.audio.find((c) => c.item.id === itemId);
  if (!m || !cue?.audio || m.durationSec === undefined) return p;
  const inPt = cue.inPointSec ?? 0;
  const outPt = cue.outPointSec ?? m.durationSec;
  if (edge === 'end') {
    const out = Math.max(inPt + MIN_AUDIO_TRIM_SEC, Math.min(m.durationSec, mediaSec));
    return patchCues(p, [itemId], (c) => ({ ...c, outPointSec: Math.round(out * 1000) / 1000 }));
  }
  const next = Math.round(Math.max(0, Math.min(outPt - MIN_AUDIO_TRIM_SEC, mediaSec)) * 1000) / 1000;
  const trimmed = patchCues(p, [itemId], (c) => ({ ...c, inPointSec: next }));
  return clip ? moveAudio(trimmed, itemId, Math.max(0, clip.start + (next - inPt)), cue.audio.laneId, tl) : trimmed;
}

/** The shortest an audio clip can be trimmed to. */
export const MIN_AUDIO_TRIM_SEC = 0.5;

/** AU-3: a clip's own volume (a video's sound, or an audio clip), 0..2. */
export function setVolumes(p: Travelogue, ids: Id[], volume: number): Travelogue {
  const v = Math.round(Math.max(0, Math.min(2, volume)) * 100) / 100;
  return patchCues(p, ids, (c) => (c.volume === v ? c : { ...c, volume: v }));
}

/** AU-3: a lane's volume, mute and solo. */
export function setLane(p: Travelogue, laneId: Id, patch: { volume?: number; mute?: boolean; solo?: boolean }): Travelogue {
  const lanes = p.audioLanes.map((l) => {
    if (l.id !== laneId) return l;
    const next = { ...l, ...patch };
    if (patch.volume !== undefined) next.volume = Math.round(Math.max(0, Math.min(2, patch.volume)) * 100) / 100;
    if (next.solo === false) delete next.solo;
    return next;
  });
  return { ...p, audioLanes: lanes };
}

/** PE-9: seconds per chapter (title card included) and in total. */
export function runtimes(tl: Timeline): { chapters: Map<Id, number>; total: number } {
  return { chapters: new Map(tl.chapters.map((c) => [c.chapterId, c.end - c.start])), total: tl.duration };
}
