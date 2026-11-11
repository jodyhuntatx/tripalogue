/**
 * Builds the playable timeline from a project: chapters in itinerary order,
 * each opened by its title card, followed by its included visual cues in cue
 * order. Unassigned and excluded items do not play. Audio items are placed on
 * lanes in Phase 3 and are skipped here.
 */
import { defaultCue } from './project.js';
import type { Chapter, Cue, MediaItem, Transition, Travelogue } from './schema.js';

export interface TitleSegment {
  kind: 'title';
  chapterId: string;
  chapterIndex: number;
  start: number;
  duration: number;
  title: string;
  subtitle: string;
  entrance: Transition;
  exit: Transition;
}

export interface MediaSegment {
  kind: 'image' | 'video';
  chapterId: string;
  chapterIndex: number;
  start: number;
  duration: number;
  item: MediaItem;
  cue: Cue;
  /** Video only: media time at segment start, and media seconds per timeline second. */
  inPointSec: number;
  speed: number;
}

export type Segment = TitleSegment | MediaSegment;

export interface ChapterSpan {
  chapterId: string;
  index: number;
  title: string;
  start: number;
  end: number;
}

export interface Timeline {
  segments: Segment[];
  chapters: ChapterSpan[];
  duration: number;
  /** Items that cannot play yet, with the reason (e.g. unknown video length). */
  skipped: { itemId: string; reason: string }[];
}

function formatDateRange(c: Chapter): string {
  const d = (s: string) => s.slice(0, 10);
  return d(c.start) === d(c.end) ? d(c.start) : `${d(c.start)} to ${d(c.end)}`;
}

/** Seconds of timeline a cue occupies. */
export function cueDuration(item: MediaItem, cue: Cue, videoMaxSec: number): number | undefined {
  if (item.kind === 'image') return cue.durationSec;
  if (item.kind !== 'video') return undefined;
  const inPt = cue.inPointSec ?? 0;
  const outPt = cue.outPointSec ?? (item.durationSec !== undefined ? Math.min(item.durationSec, inPt + videoMaxSec) : undefined);
  if (outPt === undefined) return cue.durationSec;
  return (outPt - inPt) / (cue.speed || 1);
}

export function buildTimeline(p: Travelogue): Timeline {
  const cueByItem = new Map(p.cues.map((c) => [c.itemId, c]));
  const segments: Segment[] = [];
  const chapters: ChapterSpan[] = [];
  const skipped: Timeline['skipped'] = [];
  let t = 0;

  p.chapters.forEach((ch, chapterIndex) => {
    const chStart = t;
    if (ch.titleCard.enabled) {
      const duration = ch.titleCard.durationSec ?? p.cueProfile.titleCardSec;
      if (duration > 0) {
        segments.push({
          kind: 'title', chapterId: ch.id, chapterIndex, start: t, duration,
          title: ch.title,
          subtitle: [ch.locationName, formatDateRange(ch)].filter(Boolean).join(' · '),
          entrance: { type: 'fade', durationSec: p.cueProfile.fadeInSec },
          exit: { type: 'fade', durationSec: p.cueProfile.fadeOutSec },
        });
        t += duration;
      }
    }
    const items = p.media.filter((m) => m.chapterId === ch.id && (m.kind === 'image' || m.kind === 'video'));
    // Items without a cue play last in their chapter, in file order ('~' sorts after every order key).
    const withCues = items.map((item, i) => ({ item, cue: cueByItem.get(item.id) ?? defaultCue(item, p.cueProfile, `~${String(i).padStart(6, '0')}`) }));
    withCues.sort((a, b) => (a.cue.order < b.cue.order ? -1 : a.cue.order > b.cue.order ? 1 : 0));
    for (const { item, cue } of withCues) {
      if (!cue.included) continue;
      if (item.status !== undefined && item.status !== 'ready') {
        skipped.push({ itemId: item.id, reason: item.status === 'failed' ? `processing failed${item.error ? `: ${item.error}` : ''}` : `not ready yet (${item.status})` });
        continue;
      }
      const duration = cueDuration(item, cue, p.cueProfile.videoMaxSec);
      if (duration === undefined || !(duration > 0)) {
        skipped.push({ itemId: item.id, reason: item.kind === 'video' ? 'video length unknown and no out-point set' : 'no duration' });
        continue;
      }
      segments.push({
        kind: item.kind as 'image' | 'video', chapterId: ch.id, chapterIndex, start: t, duration,
        item, cue, inPointSec: cue.inPointSec ?? 0, speed: cue.speed || 1,
      });
      t += duration;
    }
    chapters.push({ chapterId: ch.id, index: chapterIndex, title: ch.title, start: chStart, end: t });
  });

  return { segments, chapters, duration: t, skipped };
}

/** Binary search for the segment playing at time t (end-exclusive; the last segment owns t = duration). */
export function segmentIndexAt(tl: Timeline, t: number): number {
  const s = tl.segments;
  if (!s.length) return -1;
  if (t >= tl.duration) return s.length - 1;
  if (t <= 0) return 0;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
