/**
 * Builds the playable timeline from a project: chapters in itinerary order,
 * each opened by its title card, followed by its included visual cues in cue
 * order. Unassigned and excluded items do not play. Audio items play when
 * placed on a lane (AU-1): each clip is timed from its anchor, a visual item's
 * start or a time in a chapter, and stops at the end of its chapter.
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
  /** The chapter's "What happened here" text; empty when there is none. */
  description: string;
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

/** A narration or music clip on an audio lane, timed on the travelogue's clock. */
export interface AudioClip {
  item: MediaItem;
  cue: Cue;
  laneId: string;
  chapterId: string;
  chapterIndex: number;
  start: number;
  duration: number;
  /** Media time at the clip's start (its in-point). */
  inPointSec: number;
  /** The visual item it moves with (AU-2), when anchored to one. */
  anchorItemId?: string;
  fadeInSec: number;
  fadeOutSec: number;
  duck: boolean;
  /** Seconds cut off the end because the chapter ends first. */
  cutSec: number;
}

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
  /** Narration and music placed on lanes, in start order. */
  audio: AudioClip[];
  /** Items that cannot play yet, with the reason (e.g. unknown video length). */
  skipped: { itemId: string; reason: string }[];
}

function formatDateRange(c: Chapter): string {
  const d = (s: string) => s.slice(0, 10);
  return d(c.start) === d(c.end) ? d(c.start) : `${d(c.start)} to ${d(c.end)}`;
}

/** Seconds of timeline a cue occupies. */
export function cueDuration(item: MediaItem, cue: Cue): number | undefined {
  if (item.kind === 'image') return cue.durationSec;
  if (item.kind !== 'video') return undefined;
  const inPt = cue.inPointSec ?? 0;
  // No out-point means "to the end of the clip".
  const outPt = cue.outPointSec ?? item.durationSec;
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
          description: ch.description.trim(),
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
      const duration = cueDuration(item, cue);
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

  const audio = buildAudio(p, segments, chapters, skipped);
  return { segments, chapters, duration: t, audio, skipped };
}

/** Clips shorter than this (after cutting at the chapter end) are not played. */
const MIN_AUDIO_SEC = 0.05;

function buildAudio(p: Travelogue, segments: Segment[], chapters: ChapterSpan[], skipped: Timeline['skipped']): AudioClip[] {
  const media = new Map(p.media.map((m) => [m.id, m]));
  const segOf = new Map(segments.flatMap((s) => (s.kind === 'title' ? [] : [[s.item.id, s] as const])));
  const spanOf = new Map(chapters.map((c) => [c.chapterId, c]));
  const out: AudioClip[] = [];
  for (const cue of p.cues) {
    const a = cue.audio;
    const item = media.get(cue.itemId);
    if (!a || !item || item.kind !== 'audio' || !cue.included) continue;
    if (item.status !== undefined && item.status !== 'ready') {
      skipped.push({ itemId: item.id, reason: `not ready yet (${item.status})` });
      continue;
    }
    let anchorStart: number;
    let span: ChapterSpan | undefined;
    if (a.anchor.type === 'item') {
      const seg = segOf.get(a.anchor.itemId);
      if (!seg) {
        skipped.push({ itemId: item.id, reason: 'anchored to an item that is not playing' });
        continue;
      }
      anchorStart = seg.start;
      span = spanOf.get(seg.chapterId);
    } else {
      span = spanOf.get(a.anchor.chapterId);
      if (!span) {
        skipped.push({ itemId: item.id, reason: 'its chapter no longer exists' });
        continue;
      }
      anchorStart = span.start;
    }
    if (!span) continue;
    const inPt = cue.inPointSec ?? 0;
    const outPt = cue.outPointSec ?? item.durationSec;
    if (outPt === undefined) {
      skipped.push({ itemId: item.id, reason: 'audio length unknown' });
      continue;
    }
    // An item anchor may lead in before its item (negative offset), but never before the chapter starts.
    const start = Math.max(span.start, anchorStart + (a.anchor.type === 'item' ? a.anchor.offsetSec : Math.max(0, a.anchor.offsetSec)));
    const full = Math.max(0, outPt - inPt);
    const duration = Math.min(full, span.end - start);
    if (!(duration > MIN_AUDIO_SEC)) {
      skipped.push({ itemId: item.id, reason: 'starts after its chapter ends' });
      continue;
    }
    out.push({
      item, cue, laneId: a.laneId, chapterId: span.chapterId, chapterIndex: span.index, start, duration, inPointSec: inPt,
      anchorItemId: a.anchor.type === 'item' ? a.anchor.itemId : undefined,
      fadeInSec: a.fadeInSec, fadeOutSec: a.fadeOutSec, duck: a.duck, cutSec: full - duration,
    });
  }
  return out.sort((x, y) => x.start - y.start);
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
