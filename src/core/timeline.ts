/**
 * Builds the playable timeline from a project: chapters in itinerary order,
 * each opened by its title card, followed by its included visual cues in cue
 * order. Unassigned and excluded items do not play. Audio items play when
 * placed on a lane (AU-1): each clip is timed from its anchor, a visual item's
 * start or a time in a chapter, and stops at the end of its chapter, unless it is set to play on into the next
 * chapters (then it stops at its own end, the next clip on its lane, or the end of the travelogue).
 */
import { defaultCue } from './project.js';
import type { Chapter, Cue, MediaItem, TitleLayout, Transition, Travelogue } from './schema.js';

/**
 * A chapter's opening: its title card (IT-5, PE-15), preceded in full-frame map mode (MV-6) by mapSec of the map
 * filling the frame. With the card turned off, the opening is the map alone (card = false), or absent.
 */
export interface TitleSegment {
  kind: 'title';
  chapterId: string;
  chapterIndex: number;
  start: number;
  duration: number;
  title: string;
  subtitle: string;
  /** The chapter's "What happened here" text (or the card's own); empty when there is none. */
  description: string;
  layout: TitleLayout;
  /** A picture behind the card's text. */
  background?: MediaItem;
  /** Seconds of full-frame map before the card (0 = none). */
  mapSec: number;
  /** Whether the card itself shows (after the map). */
  card: boolean;
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
  /** PE-16: seconds this segment overlaps the one before it (a crossfade entrance); 0 otherwise. */
  overlapSec: number;
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
  /** Seconds cut off the clip's end, and what cut them: its chapter's end, the next clip on its lane, or the travelogue's end. */
  cutSec: number;
  cutBy?: 'chapter' | 'next' | 'end';
  /** Plays on past its chapter (AudioCue.spanChapters). */
  spans: boolean;
  /** AU-8: repeats its trimmed part (outPointSec - inPointSec long) until it stops. */
  loopSec?: number;
  /** AU-7: seconds of crossfade at its end into the next clip on its lane (it fades out over them). */
  crossfadeOutSec?: number;
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

/** MV-6 default: chapter transitions in the inset, over 3 s. */
export const DEFAULT_MAP_TRANSITION = { mode: 'inset' as const, durationSec: 3 };

/** PE-16: the longest a crossfade may be, as a share of either item's length. */
const MAX_OVERLAP_SHARE = 0.5;

export function buildTimeline(p: Travelogue): Timeline {
  const cueByItem = new Map(p.cues.map((c) => [c.itemId, c]));
  const segments: Segment[] = [];
  const chapters: ChapterSpan[] = [];
  const skipped: Timeline['skipped'] = [];
  let t = 0;

  const byId = new Map(p.media.map((m) => [m.id, m]));
  const transition = p.mapView.transition ?? DEFAULT_MAP_TRANSITION;
  const mapOn = (ch: Chapter) => p.mapView.enabled && ch.mapInset !== 'off' && !!ch.coordinates;
  p.chapters.forEach((ch, chapterIndex) => {
    const chStart = t;
    const tc = ch.titleCard;
    const cardSec = tc.enabled ? tc.durationSec ?? p.cueProfile.titleCardSec : 0;
    const mapSec = transition.mode === 'fullFrame' && mapOn(ch) ? transition.durationSec : 0;
    if (cardSec > 0 || mapSec > 0) {
      const bg = tc.backgroundItemId ? byId.get(tc.backgroundItemId) : undefined;
      const duration = cardSec + mapSec;
      segments.push({
        kind: 'title', chapterId: ch.id, chapterIndex, start: t, duration,
        title: tc.title?.trim() || ch.title,
        subtitle: tc.subtitle !== undefined ? tc.subtitle.trim() : [ch.locationName, formatDateRange(ch)].filter(Boolean).join(' · '),
        description: (tc.description !== undefined ? tc.description : ch.description).trim(),
        layout: tc.layout ?? 'center',
        background: bg && (bg.kind === 'image' || bg.kind === 'video') && (bg.status === undefined || bg.status === 'ready') ? bg : undefined,
        mapSec, card: cardSec > 0,
        entrance: { type: 'fade', durationSec: p.cueProfile.fadeInSec },
        exit: { type: 'fade', durationSec: p.cueProfile.fadeOutSec },
      });
      t += duration;
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
      // PE-16: a crossfade entrance starts over the end of the segment before it.
      const prev = segments[segments.length - 1];
      const overlapSec = cue.entrance.type === 'crossfade' && prev
        ? Math.max(0, Math.min(cue.entrance.durationSec, prev.duration * MAX_OVERLAP_SHARE, duration * MAX_OVERLAP_SHARE))
        : 0;
      t -= overlapSec;
      segments.push({
        kind: item.kind as 'image' | 'video', chapterId: ch.id, chapterIndex, start: t, duration,
        item, cue, inPointSec: cue.inPointSec ?? 0, speed: cue.speed || 1, overlapSec,
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
  const placed: (AudioClip & { chapterEnd: number })[] = [];
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
    if (!(span.end - start > MIN_AUDIO_SEC)) {
      skipped.push({ itemId: item.id, reason: 'starts after its chapter ends' });
      continue;
    }
    const loopSec = a.loop && outPt - inPt > MIN_AUDIO_SEC ? outPt - inPt : undefined;
    // A looping clip is as long as it is allowed to be: its chapter, or with spanChapters the lane or travelogue.
    const full = loopSec ? Number.POSITIVE_INFINITY : Math.max(0, outPt - inPt);
    placed.push({
      item, cue, laneId: a.laneId, chapterId: span.chapterId, chapterIndex: span.index, start, duration: full, inPointSec: inPt,
      anchorItemId: a.anchor.type === 'item' ? a.anchor.itemId : undefined,
      fadeInSec: a.fadeInSec, fadeOutSec: a.fadeOutSec, duck: a.duck, cutSec: 0, spans: !!a.spanChapters, chapterEnd: span.end,
      ...(loopSec ? { loopSec } : {}),
    });
  }
  // Where each clip stops: its chapter's end; or, spanning chapters, the next clip on its lane or the travelogue's end.
  const end = chapters.length ? chapters[chapters.length - 1].end : 0;
  placed.sort((x, y) => x.start - y.start);
  for (const c of placed) {
    const full = c.duration;
    let limit = c.chapterEnd;
    let by: AudioClip['cutBy'] = 'chapter';
    let crossfadeOutSec: number | undefined;
    if (c.spans) {
      const next = placed.find((o) => o !== c && o.laneId === c.laneId && o.start > c.start + MIN_AUDIO_SEC);
      limit = next ? Math.min(next.start, end) : end;
      by = next && next.start < end ? 'next' : 'end';
      // AU-7: a next clip that crossfades lets this one run on under its fade-in, fading out as it comes in.
      if (next && next.start < end && next.cue.audio?.crossfade && next.fadeInSec > 0) {
        crossfadeOutSec = Math.min(next.fadeInSec, end - next.start);
        limit = next.start + crossfadeOutSec;
      }
    }
    const duration = Math.min(full, limit - c.start);
    if (!(duration > MIN_AUDIO_SEC)) {
      skipped.push({ itemId: c.item.id, reason: 'starts after its chapter ends' });
      continue;
    }
    const { chapterEnd: _end, ...clip } = c;
    void _end;
    const cut = Number.isFinite(full) ? full - duration : 0;
    const reachedLimit = duration < full - 1e-6;
    out.push({
      ...clip, duration, cutSec: cut,
      cutBy: reachedLimit && (cut > 1e-6 || clip.loopSec) ? (crossfadeOutSec ? 'next' : by) : undefined,
      ...(crossfadeOutSec && reachedLimit ? { crossfadeOutSec, fadeOutSec: Math.max(clip.fadeOutSec, crossfadeOutSec) } : {}),
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
