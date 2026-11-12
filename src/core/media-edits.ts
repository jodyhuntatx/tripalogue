/**
 * Media manager edits (Phase 2): fixing what the timestamps got wrong.
 *
 * All of these are pure functions on the project; the browser session runs
 * keepAssigned after each, so changed times move items between chapters and
 * re-sort them in the same undoable step.
 */
import { effectiveInstant, keepAssigned, reassign } from './assign.js';
import { localToUtc } from './itinerary.js';
import type { Id, MediaItem, Travelogue } from './schema.js';

/** The shortest a trimmed video can be, in seconds. */
export const MIN_CLIP_SEC = 0.5;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * PE-5: play a video from inSec to outSec (seconds into the clip). outSec null,
 * or at the clip's end, means "to the end", so the cue keeps following the clip's
 * real length. Values are clamped to the clip and to MIN_CLIP_SEC.
 */
export function setVideoTrim(p: Travelogue, itemId: Id, inSec: number, outSec: number | null): Travelogue {
  const m = p.media.find((x) => x.id === itemId);
  if (!m || m.kind !== 'video' || !Number.isFinite(inSec)) return p;
  const len = m.durationSec;
  let a = r3(Math.max(0, inSec));
  if (len !== undefined) a = Math.min(a, r3(Math.max(0, len - MIN_CLIP_SEC)));
  let b: number | undefined = outSec === null || !Number.isFinite(outSec) ? undefined : r3(outSec);
  if (b !== undefined && len !== undefined && b >= len - 0.05) b = undefined;
  if (b !== undefined) b = r3(Math.max(b, a + MIN_CLIP_SEC));
  return {
    ...p,
    cues: p.cues.map((c) => {
      if (c.itemId !== itemId) return c;
      const { outPointSec: _old, ...rest } = c;
      return b === undefined ? { ...rest, inPointSec: a } : { ...rest, inPointSec: a, outPointSec: b };
    }),
  };
}

const zoneOf = (p: Travelogue, m: MediaItem) => (p.chapters.find((c) => c.id === m.chapterId) ?? p.chapters[0])?.timeZone ?? 'UTC';

/** An item's effective instant (ms), read in its chapter's zone; NaN when it has no time. */
export function itemInstant(p: Travelogue, m: MediaItem): number {
  return effectiveInstant(m, p.sources.find((s) => s.id === m.sourceId), zoneOf(p, m));
}

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/**
 * MM-5: set the user timestamp of one or many items. With several items the first (in time order) gets `instant`
 * and the others keep their spacing from it, so a burst of photos stays in order. `null` clears the user time, so
 * the capture time (plus the source offset) applies again.
 */
export function setUserTime(p: Travelogue, ids: Id[], instant: number | null): Travelogue {
  const want = new Set(ids);
  const picked = p.media.filter((m) => want.has(m.id));
  if (!picked.length) return p;
  if (instant === null) return { ...p, media: p.media.map((m) => (want.has(m.id) && m.userTimestamp ? { ...m, userTimestamp: undefined } : m)) };
  const times = new Map(picked.map((m) => [m.id, itemInstant(p, m)]));
  const known = [...times.values()].filter((t) => !Number.isNaN(t));
  const first = known.length ? Math.min(...known) : NaN;
  return {
    ...p,
    media: p.media.map((m) => {
      if (!want.has(m.id)) return m;
      const t = times.get(m.id)!;
      const at = Number.isNaN(t) || Number.isNaN(first) ? instant : instant + (t - first);
      return { ...m, userTimestamp: iso(at) };
    }),
  };
}

/** MM-5: move items' times by a fixed amount (for example, everything from one afternoon 2 hours later). */
export function shiftUserTime(p: Travelogue, ids: Id[], deltaMs: number): Travelogue {
  const want = new Set(ids);
  return {
    ...p,
    media: p.media.map((m) => {
      if (!want.has(m.id)) return m;
      const t = itemInstant(p, m);
      return Number.isNaN(t) ? m : { ...m, userTimestamp: iso(t + deltaMs) };
    }),
  };
}

/** MM-4: set a source's clock offset (seconds added to its capture times). */
export function setClockOffset(p: Travelogue, sourceId: Id, seconds: number): Travelogue {
  return { ...p, sources: p.sources.map((s) => (s.id === sourceId ? { ...s, clockOffsetSec: Math.round(seconds) } : s)) };
}

export interface MovePreview {
  /** Items that would change chapter, with where they go. */
  moves: { id: Id; from: Id | null; to: Id | null }[];
}

/** MM-4 live preview: which items a clock offset would move, without changing anything. */
export function previewClockOffset(p: Travelogue, sourceId: Id, seconds: number): MovePreview {
  const next = reassign(setClockOffset(p, sourceId, seconds));
  const was = new Map(p.media.map((m) => [m.id, m.chapterId]));
  return { moves: next.media.filter((m) => was.get(m.id) !== m.chapterId).map((m) => ({ id: m.id, from: was.get(m.id)!, to: m.chapterId })) };
}

/**
 * MM-5: drop items into a chapter. Each item gets a user time inside that chapter: just before `beforeId` when
 * dropped on an item (between it and the item before it), otherwise on the chapter's first day at the item's own
 * time of day (noon when it has none), kept inside the chapter's window. Several items keep their spacing.
 */
export function dropIntoChapter(p: Travelogue, ids: Id[], chapterId: Id, beforeId?: Id): Travelogue {
  const ch = p.chapters.find((c) => c.id === chapterId);
  if (!ch || !ids.length) return p;
  const start = localToUtc(ch.start, ch.timeZone);
  const end = localToUtc(ch.end, ch.timeZone, true) + 59_000;
  const clamp = (t: number) => Math.max(start, Math.min(end, t));
  const moving = new Set(ids);
  let target: number;
  if (beforeId && !moving.has(beforeId)) {
    const ordered = p.media.filter((m) => m.chapterId === chapterId && !moving.has(m.id))
      .map((m) => ({ m, t: itemInstant(p, m) })).filter((x) => !Number.isNaN(x.t)).sort((a, b) => a.t - b.t);
    const i = ordered.findIndex((x) => x.m.id === beforeId);
    const after = ordered[i]?.t ?? end;
    const before = i > 0 ? ordered[i - 1].t : Math.min(start, after - 60_000);
    target = clamp(Math.round((before + after) / 2));
  } else {
    const first = p.media.find((m) => m.id === ids[0]);
    const t = first ? itemInstant(p, first) : NaN;
    const day = ch.start.slice(0, 10);
    const local = Number.isNaN(t) ? '12:00' : new Intl.DateTimeFormat('en-GB', { timeZone: ch.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
    target = clamp(localToUtc(`${day}T${local}`, ch.timeZone));
  }
  // Keep the spacing of a multi-item drop but never spill out of the chapter.
  let out = setUserTime(p, ids, target);
  out = { ...out, media: out.media.map((m) => (moving.has(m.id) && m.userTimestamp ? { ...m, userTimestamp: iso(clamp(Date.parse(m.userTimestamp))) } : m)) };
  return keepAssigned(p, out);
}

/**
 * MM-8: likely duplicates. Same file content (hash), or the same capture time and size from different sources
 * (two travelers sharing the same photo). Returns item id → group number, for items in a group of two or more.
 */
export function duplicateGroups(p: Travelogue): Map<Id, number> {
  const groups = new Map<string, MediaItem[]>();
  const add = (k: string, m: MediaItem) => groups.set(k, [...(groups.get(k) ?? []), m]);
  for (const m of p.media) {
    if (m.contentHash) add(`h:${m.contentHash}`, m);
    if (m.capturedAt && m.width && m.height && m.timestampConfidence !== 'low') add(`t:${m.capturedAt}|${m.width}x${m.height}|${m.kind}`, m);
  }
  const out = new Map<Id, number>();
  let n = 0;
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    if (k.startsWith('t:') && new Set(list.map((m) => m.sourceId)).size < 2) continue; // a burst on one camera is not a duplicate
    const existing = list.map((m) => out.get(m.id)).find((g) => g !== undefined);
    const g = existing ?? ++n;
    for (const m of list) out.set(m.id, g);
  }
  return out;
}
