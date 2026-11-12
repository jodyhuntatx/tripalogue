/**
 * Automatic assignment of media to chapters (MM-3, Section 3 "Assignment rule").
 *
 * An item belongs to the chapter whose date/time range contains its effective
 * timestamp, read in that chapter's time zone. Items in no range, or in a gap
 * between chapters, go to the Unassigned bin. Items in two overlapping chapters
 * go to the earlier one and are flagged. Within a chapter, new arrivals are
 * placed in time order.
 *
 * Effective timestamp: the user's timestamp (MM-5) when set; otherwise the
 * capture time plus the source's clock offset (MM-4). Times with a UTC offset
 * are absolute; plain local times (a camera clock with no zone) are read as
 * wall-clock time in each chapter's zone.
 *
 * Items with no timestamp at all keep whatever chapter they have, so hand-
 * placed items and older projects are never moved.
 */
import { keyBetween } from './fractional.js';
import { localToUtc } from './itinerary.js';
import type { Chapter, Id, MediaItem, MediaSource, Travelogue } from './schema.js';

const OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/** Whether a stored time carries its own UTC offset (absolute) or is a plain local wall-clock time. */
export const isAbsoluteTime = (t: string) => OFFSET.test(t);

/** The instant an item happened, read in a chapter's zone when the time is local; NaN when it has none. */
export function effectiveInstant(m: MediaItem, source: MediaSource | undefined, tz: string): number {
  if (m.userTimestamp) return parseTime(m.userTimestamp, tz);
  if (!m.capturedAt) return NaN;
  return parseTime(m.capturedAt, tz) + (source?.clockOffsetSec ?? 0) * 1000;
}

// Local times are converted with Intl, which is slow when done for every item × chapter pair: remember results.
const localCache = new Map<string, number>();

function parseTime(t: string, tz: string): number {
  if (isAbsoluteTime(t)) return Date.parse(t);
  const key = `${t}|${tz}`;
  const hit = localCache.get(key);
  if (hit !== undefined) return hit;
  const v = parseLocal(t, tz);
  if (localCache.size > 50_000) localCache.clear();
  localCache.set(key, v);
  return v;
}

function parseLocal(t: string, tz: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/.exec(t);
  if (!m) return NaN;
  const minute = localToUtc(`${m[1]}T${m[2]}:${m[3]}`, tz);
  return minute + Number(m[4] ?? 0) * 1000 + (m[5] ? Number(`0.${m[5]}`) * 1000 : 0);
}

export const hasTimestamp = (m: MediaItem) => !!(m.userTimestamp || m.capturedAt);

interface ChapterWindow { chapter: Chapter; start: number; end: number }

/**
 * Each chapter's window [start, end): the end is exclusive so back-to-back chapters (one ends 08:00, the next
 * starts 08:00) never share an instant; an end at a minute's :59 (or a date-only end) covers that whole minute.
 */
function windows(chapters: Chapter[]): ChapterWindow[] {
  return chapters.map((chapter) => {
    const start = localToUtc(chapter.start, chapter.timeZone);
    const dateOnly = !/T\d{2}:\d{2}/.test(chapter.end);
    const endMinute = localToUtc(chapter.end, chapter.timeZone, true);
    const wholeMinute = dateOnly || /:59$/.test(chapter.end);
    return { chapter, start, end: endMinute + (wholeMinute ? 60_000 : 0) };
  });
}

export interface ChapterPlacement {
  chapterId: Id | null;
  /** The item also falls inside a later, overlapping chapter. */
  overlap: boolean;
}

function place(m: MediaItem, source: MediaSource | undefined, wins: ChapterWindow[]): ChapterPlacement {
  const hits = wins.filter((w) => {
    const t = effectiveInstant(m, source, w.chapter.timeZone);
    return t >= w.start && t < w.end;
  });
  if (!hits.length) return { chapterId: null, overlap: false };
  hits.sort((a, b) => a.start - b.start);
  return { chapterId: hits[0].chapter.id, overlap: hits.length > 1 };
}

/** Where the rule puts one item (undefined when it has no timestamp, so the rule does not apply). */
export function placementFor(p: Travelogue, m: MediaItem): ChapterPlacement | undefined {
  if (!hasTimestamp(m)) return undefined;
  return place(m, p.sources.find((s) => s.id === m.sourceId), windows(p.chapters));
}

/** Items that the rule placed in the earlier of two overlapping chapters (flag them in the UI). */
export function overlapItems(p: Travelogue): Set<Id> {
  const wins = windows(p.chapters);
  const src = new Map(p.sources.map((s) => [s.id, s]));
  return new Set(p.media.filter((m) => hasTimestamp(m) && place(m, src.get(m.sourceId), wins).overlap).map((m) => m.id));
}

/** Sort key for an item's time inside a chapter (UTC ms; untimed items sort last). */
export function sortInstant(p: Travelogue, m: MediaItem): number {
  const ch = p.chapters.find((c) => c.id === m.chapterId) ?? p.chapters[0];
  const t = effectiveInstant(m, p.sources.find((s) => s.id === m.sourceId), ch?.timeZone ?? 'UTC');
  return Number.isNaN(t) ? Infinity : t;
}

/**
 * Apply the rule. Every timestamped item (or only those in `only`) gets the chapter the rule gives it; an item
 * whose chapter changes is slotted into its new chapter in time order. Returns the same object when nothing moves.
 */
export function reassign(p: Travelogue, only?: Set<Id>): Travelogue {
  const wins = windows(p.chapters);
  const src = new Map(p.sources.map((s) => [s.id, s]));
  const moves = new Map<Id, Id | null>();
  for (const m of p.media) {
    if (only && !only.has(m.id)) continue;
    if (!hasTimestamp(m)) continue;
    const { chapterId } = place(m, src.get(m.sourceId), wins);
    if (chapterId !== m.chapterId) moves.set(m.id, chapterId);
  }
  if (!moves.size) return p;
  let next: Travelogue = { ...p, media: p.media.map((m) => (moves.has(m.id) ? { ...m, chapterId: moves.get(m.id)! } : m)) };
  for (const id of moves.keys()) next = slotByTime(next, id);
  return next;
}

/** Give an item's cue an order key that puts it among its chapter's items in time order. */
export function slotByTime(p: Travelogue, itemId: Id): Travelogue {
  const item = p.media.find((m) => m.id === itemId);
  const cue = p.cues.find((c) => c.itemId === itemId);
  if (!item || !cue) return p;
  const t = sortInstant(p, item);
  const order = new Map(p.cues.map((c) => [c.itemId, c.order]));
  const siblings = p.media
    .filter((m) => m.id !== itemId && m.chapterId === item.chapterId && order.has(m.id))
    .sort((a, b) => (order.get(a.id)! < order.get(b.id)! ? -1 : 1));
  // Before the first sibling that happened later; after everything when none did.
  const i = siblings.findIndex((s) => sortInstant(p, s) > t);
  const before = i < 0 ? siblings[siblings.length - 1] : siblings[i - 1];
  const after = i < 0 ? undefined : siblings[i];
  const key = keyBetween(before ? order.get(before.id)! : null, after ? order.get(after.id)! : null);
  if (key === cue.order) return p;
  return { ...p, cues: p.cues.map((c) => (c.itemId === itemId ? { ...c, order: key } : c)) };
}

/** Per-chapter item counts, plus `null` for the Unassigned bin. */
export function chapterCounts(p: Travelogue): Map<Id | null, number> {
  const counts = new Map<Id | null, number>([[null, 0], ...p.chapters.map((c) => [c.id, 0] as [Id, number])]);
  for (const m of p.media) counts.set(m.chapterId, (counts.get(m.chapterId) ?? 0) + 1);
  return counts;
}

const timeSignature = (p: Travelogue) =>
  `${p.chapters.map((c) => `${c.id}|${c.start}|${c.end}|${c.timeZone}`).join(';')}#${p.sources.map((s) => `${s.id}|${s.clockOffsetSec}`).join(';')}`;

/**
 * Keep assignment current after an edit: when the chapters' times, the sources' clock offsets or items' timestamps
 * changed, re-run the rule (on every item, or just the items whose time changed). Cheap to call after every edit:
 * a title change or a cue edit leaves the project untouched.
 */
export function keepAssigned(prev: Travelogue, next: Travelogue): Travelogue {
  if (next === prev) return next;
  if ((next.chapters !== prev.chapters || next.sources !== prev.sources) && timeSignature(next) !== timeSignature(prev)) return reassign(next);
  if (next.media === prev.media) return next;
  const before = new Map(prev.media.map((m) => [m.id, m]));
  const changed = new Set(next.media.filter((m) => {
    const b = before.get(m.id);
    return !b || b.userTimestamp !== m.userTimestamp || b.capturedAt !== m.capturedAt;
  }).map((m) => m.id));
  if (!changed.size) return next;
  // Moved items are slotted by reassign; items whose time changed within their chapter are re-slotted here.
  let out = reassign(next, changed);
  for (const id of changed) {
    const was = before.get(id);
    const now = out.media.find((m) => m.id === id);
    if (was && now && was.chapterId === now.chapterId && now.chapterId !== null) out = slotByTime(out, id);
  }
  return out;
}
