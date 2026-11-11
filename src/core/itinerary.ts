/**
 * Itinerary logic for the Phase 1 editor (IT-1 to IT-7).
 *
 * Chapter start and end are local date-times read in the chapter's own time
 * zone, so a trip that crosses time zones keeps the times people actually saw
 * on their watches. Comparisons (overlaps, gaps, order) convert to instants.
 *
 * Everything here is a pure function on a Travelogue, returning a new one
 * that shares unchanged branches, so it works with History, undo and the
 * operation log like every other edit.
 */
import { keyBetween } from './fractional.js';
import type { Chapter, Id, LatLng, MediaItem, Travelogue } from './schema.js';

// ---------------------------------------------------------------- time zones

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The device's time zone, or UTC when unknown (IT-2). */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Every IANA zone the runtime knows, for pickers. */
export function timeZones(): string[] {
  const i = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    return i.supportedValuesOf ? i.supportedValuesOf('timeZone') : ['UTC'];
  } catch {
    return ['UTC'];
  }
}

/** Wall-clock milliseconds (as if UTC) for an instant in a zone. */
function wallClock(ms: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * A local date-time in a zone, as epoch milliseconds. A date with no time is
 * the start of that day, or its last second when endOfDay is set. Invalid
 * input gives NaN. Like calendar apps: a wall time that happens twice (when
 * clocks go back) means the first one; a wall time that never happens (when
 * clocks go forward) moves forward by the size of the jump.
 */
export function localToUtc(local: string, tz: string, endOfDay = false): number {
  const m = LOCAL.exec(local);
  if (!m) return NaN;
  const hasTime = m[4] !== undefined;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], hasTime ? +m[4] : endOfDay ? 23 : 0, hasTime ? +m[5] : endOfDay ? 59 : 0, hasTime ? +(m[6] ?? 0) : endOfDay ? 59 : 0);
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const half = 12 * 3_600_000;
  const before = wallClock(naive - half, zone) - (naive - half);
  const after = wallClock(naive + half, zone) - (naive + half);
  const fits = [naive - before, naive - after].filter((t) => wallClock(t, zone) === naive);
  return fits.length ? Math.min(...fits) : naive - before;
}

/** Format an instant as a local date-time (YYYY-MM-DDTHH:MM) in a zone. */
export function utcToLocal(ms: number, tz: string): string {
  const w = new Date(wallClock(ms, isValidTimeZone(tz) ? tz : 'UTC'));
  return w.toISOString().slice(0, 16);
}

export interface Span {
  start: number;
  end: number;
}

export function chapterSpan(c: Chapter): Span {
  return { start: localToUtc(c.start, c.timeZone), end: localToUtc(c.end, c.timeZone, true) };
}

/** A media item's instant: explicit offsets are honoured, plain local times are read in the chapter's zone. */
export function mediaInstant(m: MediaItem, tz: string): number {
  const t = m.userTimestamp ?? m.capturedAt;
  if (!t) return NaN;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) return Date.parse(t);
  return localToUtc(t.slice(0, 19), tz);
}

// ---------------------------------------------------------------- checks (IT-3)

export type ItineraryIssue =
  | { kind: 'overlap'; chapterIds: [Id, Id]; minutes: number }
  | { kind: 'gap'; chapterIds: [Id, Id]; hours: number }
  | { kind: 'outOfOrder'; chapterIds: [Id]; }
  | { kind: 'invalid'; chapterIds: [Id]; message: string };

const MIN = 60_000;

/**
 * Overlaps, gaps and out-of-order chapters. Back-to-back chapters (one ends at
 * 23:59, the next starts at 00:00, or one ends exactly when the next starts)
 * are neither a gap nor an overlap.
 */
export function analyzeItinerary(p: Travelogue): ItineraryIssue[] {
  const issues: ItineraryIssue[] = [];
  const spans = p.chapters.map((c) => ({ c, ...chapterSpan(c) }));
  for (const s of spans) {
    if (!isValidTimeZone(s.c.timeZone)) issues.push({ kind: 'invalid', chapterIds: [s.c.id], message: `Unknown time zone "${s.c.timeZone}"` });
    else if (Number.isNaN(s.start) || Number.isNaN(s.end)) issues.push({ kind: 'invalid', chapterIds: [s.c.id], message: 'Start or end date is missing or invalid' });
    else if (s.end < s.start) issues.push({ kind: 'invalid', chapterIds: [s.c.id], message: 'Ends before it starts' });
  }
  const ok = spans.filter((s) => !Number.isNaN(s.start) && !Number.isNaN(s.end) && s.end >= s.start);
  for (let i = 1; i < ok.length; i++) {
    if (ok[i].start < ok[i - 1].start) issues.push({ kind: 'outOfOrder', chapterIds: [ok[i].c.id] });
  }
  const sorted = [...ok].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].end; j++) {
      const minutes = Math.round((Math.min(sorted[i].end, sorted[j].end) - sorted[j].start) / MIN);
      if (minutes >= 1) issues.push({ kind: 'overlap', chapterIds: [sorted[i].c.id, sorted[j].c.id], minutes });
    }
  }
  let reach = -Infinity;
  let reachId: Id | undefined;
  for (const s of sorted) {
    if (reachId !== undefined && s.start - reach > MIN) issues.push({ kind: 'gap', chapterIds: [reachId, s.c.id], hours: Math.round(((s.start - reach) / 3_600_000) * 10) / 10 });
    if (s.end > reach) {
      reach = s.end;
      reachId = s.c.id;
    }
  }
  return issues;
}

export function describeIssue(i: ItineraryIssue, p: Travelogue): string {
  const name = (id: Id) => {
    const idx = p.chapters.findIndex((c) => c.id === id);
    return idx < 0 ? id : `${idx + 1}. ${p.chapters[idx].title || 'Untitled'}`;
  };
  switch (i.kind) {
    case 'overlap': {
      const d = i.minutes >= 1440 ? `${Math.round(i.minutes / 144) / 10} days` : i.minutes >= 60 ? `${Math.round(i.minutes / 6) / 10} hours` : `${i.minutes} min`;
      return `${name(i.chapterIds[0])} and ${name(i.chapterIds[1])} overlap by ${d}`;
    }
    case 'gap': {
      const d = i.hours >= 24 ? `${Math.round(i.hours / 2.4) / 10} days` : `${i.hours} hours`;
      return `Gap of ${d} between ${name(i.chapterIds[0])} and ${name(i.chapterIds[1])}`;
    }
    case 'outOfOrder':
      return `${name(i.chapterIds[0])} starts before the chapter above it`;
    case 'invalid':
      return `${name(i.chapterIds[0])}: ${i.message}`;
  }
}

// ---------------------------------------------------------------- chapter edits (IT-1, IT-7)

function randomId(prefix: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return `${prefix}_${(c?.randomUUID ? c.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 12)}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
function addDays(date: string, days: number): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** A new chapter for the day after the last one (or today), in the last chapter's zone (or the device's). */
export function newChapter(p: Travelogue, fields: Partial<Chapter> = {}): Chapter {
  const last = p.chapters[p.chapters.length - 1];
  const tz = fields.timeZone ?? last?.timeZone ?? deviceTimeZone();
  const day = last ? addDays(last.end.slice(0, 10), 1) : new Date().toISOString().slice(0, 10);
  return {
    id: randomId('ch'),
    title: '',
    locationName: '',
    start: `${day}T00:00`,
    end: `${day}T23:59`,
    timeZone: tz,
    description: '',
    titleCard: { enabled: true },
    ...fields,
  };
}

export function insertChapter(p: Travelogue, chapter: Chapter, index = p.chapters.length): Travelogue {
  if (p.chapters.some((c) => c.id === chapter.id)) throw new Error(`Duplicate chapter id ${chapter.id}`);
  const chapters = p.chapters.slice();
  chapters.splice(Math.max(0, Math.min(index, chapters.length)), 0, chapter);
  return { ...p, chapters };
}

export function updateChapter(p: Travelogue, id: Id, patch: Partial<Omit<Chapter, 'id'>>): Travelogue {
  const i = p.chapters.findIndex((c) => c.id === id);
  if (i < 0) throw new Error(`No chapter ${id}`);
  const cur = p.chapters[i] as unknown as Record<string, unknown>;
  const changed = Object.entries(patch).some(([k, v]) => JSON.stringify(cur[k]) !== JSON.stringify(v));
  if (!changed) return p;
  const next = { ...p.chapters[i], ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as Record<string, unknown>)[k];
  const chapters = p.chapters.slice();
  chapters[i] = next;
  return { ...p, chapters };
}

export function moveChapter(p: Travelogue, id: Id, toIndex: number): Travelogue {
  const from = p.chapters.findIndex((c) => c.id === id);
  if (from < 0) throw new Error(`No chapter ${id}`);
  const to = Math.max(0, Math.min(p.chapters.length - 1, toIndex));
  if (from === to) return p;
  const chapters = p.chapters.slice();
  const [c] = chapters.splice(from, 1);
  chapters.splice(to, 0, c);
  return { ...p, chapters };
}

/** Sort chapters by start time (stable for equal starts). */
export function sortChapters(p: Travelogue): Travelogue {
  const keyed = p.chapters.map((c, i) => ({ c, i, s: chapterSpan(c).start }));
  keyed.sort((a, b) => (Number.isNaN(a.s) ? 1 : Number.isNaN(b.s) ? -1 : a.s - b.s) || a.i - b.i);
  if (keyed.every((k, i) => k.i === i)) return p;
  return { ...p, chapters: keyed.map((k) => k.c) };
}

/** Delete a chapter; its media moves to the Unassigned bin (nothing is lost). */
export function removeChapter(p: Travelogue, id: Id): Travelogue {
  if (!p.chapters.some((c) => c.id === id)) throw new Error(`No chapter ${id}`);
  return {
    ...p,
    chapters: p.chapters.filter((c) => c.id !== id),
    media: p.media.map((m) => (m.chapterId === id ? { ...m, chapterId: null } : m)),
  };
}

/**
 * Split a chapter at a local date-time: the first part ends there and the
 * second starts there. Media from the split point on moves to the second part,
 * keeping its order.
 */
export function splitChapter(p: Travelogue, id: Id, at: string, fields: Partial<Chapter> = {}): { project: Travelogue; newId: Id } {
  const i = p.chapters.findIndex((c) => c.id === id);
  if (i < 0) throw new Error(`No chapter ${id}`);
  const c = p.chapters[i];
  const span = chapterSpan(c);
  const atMs = localToUtc(at, c.timeZone);
  if (Number.isNaN(atMs) || atMs <= span.start || atMs > span.end) throw new Error('Choose a split time inside the chapter');
  const second: Chapter = {
    ...c,
    id: randomId('ch'),
    title: fields.title ?? (c.title ? `${c.title} (2)` : ''),
    description: fields.description ?? '',
    start: at,
    titleCard: { ...c.titleCard },
    updatedBy: undefined,
    updatedAt: undefined,
    ...fields,
  };
  delete second.updatedBy;
  delete second.updatedAt;
  const first: Chapter = { ...c, end: at };
  const chapters = p.chapters.slice();
  chapters.splice(i, 1, first, second);
  const media = p.media.map((m) => (m.chapterId === id && mediaInstant(m, c.timeZone) >= atMs ? { ...m, chapterId: second.id } : m));
  return { project: { ...p, chapters, media }, newId: second.id };
}

/** Merge chapter `b` into chapter `a`: a's title and place, the combined time span, and both chapters' media. */
export function mergeChapters(p: Travelogue, aId: Id, bId: Id): Travelogue {
  const a = p.chapters.find((c) => c.id === aId);
  const b = p.chapters.find((c) => c.id === bId);
  if (!a || !b || a === b) throw new Error('Choose two different chapters to merge');
  const sa = chapterSpan(a);
  const sb = chapterSpan(b);
  const start = sb.start < sa.start ? utcToLocal(sb.start, a.timeZone) : a.start;
  const end = sb.end > sa.end ? utcToLocal(sb.end, a.timeZone) : a.end;
  const description = [a.description, b.description].filter(Boolean).join('\n\n');
  const merged: Chapter = { ...a, start, end, description };
  // Keep b's media after a's: re-key b's cues to follow a's last cue.
  const inA = new Set(p.media.filter((m) => m.chapterId === aId).map((m) => m.id));
  const inB = p.media.filter((m) => m.chapterId === bId).map((m) => m.id);
  const lastA = p.cues.filter((c) => inA.has(c.itemId)).map((c) => c.order).sort().pop() ?? null;
  const bCues = p.cues.filter((c) => inB.includes(c.itemId)).sort((x, y) => (x.order < y.order ? -1 : 1));
  const newOrder = new Map<string, string>();
  let prev = lastA;
  for (const cue of bCues) {
    prev = keyBetween(prev, null);
    newOrder.set(cue.itemId, prev);
  }
  return {
    ...p,
    chapters: p.chapters.filter((c) => c.id !== bId).map((c) => (c.id === aId ? merged : c)),
    media: p.media.map((m) => (m.chapterId === bId ? { ...m, chapterId: aId } : m)),
    cues: p.cues.map((c) => (newOrder.has(c.itemId) ? { ...c, order: newOrder.get(c.itemId)! } : c)),
  };
}

export function setChapterLocation(p: Travelogue, id: Id, locationName: string, coordinates?: LatLng): Travelogue {
  return updateChapter(p, id, { locationName, coordinates });
}

// ---------------------------------------------------------------- text and CSV import (IT-6)

export interface ChapterDraft {
  title: string;
  locationName: string;
  start: string;
  end: string;
  timeZone: string;
  description: string;
  /** Source line numbers (1-based) this draft came from. */
  lines: number[];
}

export interface ImportResult {
  chapters: ChapterDraft[];
  errors: { line: number; message: string }[];
  /** Rows folded into the row above (same place, next day). */
  merged: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

interface DateTime {
  date: string;
  time?: string;
}

/** Parse one date (with optional time). US order for numeric dates (month/day/year). */
export function parseDateTime(raw: string, defaultYear?: number): DateTime | undefined {
  let s = raw.trim().replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, '').replace(/\s+/g, ' ');
  let time: string | undefined;
  const t = /(?:[T ]|,\s*|\s+at\s+)(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i.exec(s);
  if (t) {
    let h = +t[1];
    if (t[3]) h = (h % 12) + (/^p/i.test(t[3]) ? 12 : 0);
    if (h > 23 || +t[2] > 59) return undefined;
    time = `${pad(h)}:${t[2]}`;
    s = s.slice(0, t.index).trim();
  }
  let y: number | undefined, m: number | undefined, d: number | undefined;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s))) [m, d, y] = [+r[1], +r[2], r[3] ? (r[3].length === 2 ? 2000 + +r[3] : +r[3]) : defaultYear];
  else if ((r = /^([a-z]{3,})\.? (\d{1,2})(?:st|nd|rd|th)?,? ?(\d{4})?$/i.exec(s))) [m, d, y] = [MONTHS.indexOf(r[1].slice(0, 3).toLowerCase()) + 1, +r[2], r[3] ? +r[3] : defaultYear];
  else if ((r = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,})\.?,? ?(\d{4})?$/i.exec(s))) [d, m, y] = [+r[1], MONTHS.indexOf(r[2].slice(0, 3).toLowerCase()) + 1, r[3] ? +r[3] : defaultYear];
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const date = `${y}-${pad(m)}-${pad(d)}`;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1) return undefined;
  return { date, time };
}

/** "May 1 to May 3, 2026", "2026-05-01 – 2026-05-03", "5/1-5/3/2026", or one date. */
function parseRange(raw: string, defaultYear?: number): { start: DateTime; end: DateTime } | undefined {
  const s = raw.trim();
  const parts = s.split(/\s+(?:to|until|through|thru)\s+|\s*[–—]\s*|\s+-\s+/i);
  if (parts.length === 1) {
    const iso = /^(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$/.exec(s);
    if (iso) return parseRange(`${iso[1]} to ${iso[2]}`, defaultYear);
    // "May 5-7, 2026" or "5/1-5/3/2026": a hyphen with no spaces between two date parts.
    const tight = /^(.*?\d)-(\d.*)$/.exec(s);
    if (tight && !/^\d{4}-\d/.test(s)) {
      const r = parseRange(`${tight[1]} to ${tight[2]}`, defaultYear);
      if (r) return r;
    }
    const one = parseDateTime(s, defaultYear);
    return one ? { start: one, end: one } : undefined;
  }
  if (parts.length !== 2) return undefined;
  // Let the end supply a year the start lacks ("May 30 – June 2, 2026").
  const endFirst = parseDateTime(parts[1], defaultYear);
  const start = parseDateTime(parts[0], endFirst ? +endFirst.date.slice(0, 4) : defaultYear);
  // "May 1-3, 2026": the end may be a bare day number.
  const end = endFirst ?? (start && /^\d{1,2}(,? ?\d{4})?$/.test(parts[1].trim()) ? parseDateTime(`${start.date.slice(0, 8)}${pad(+parts[1].trim().split(/[ ,]/)[0])}`) : undefined);
  if (!start || !end) return undefined;
  if (start.date > end.date) {
    // "Dec 30 – Jan 2, 2027": start belongs to the previous year.
    const fixed = parseDateTime(parts[0], +end.date.slice(0, 4) - 1);
    if (fixed && fixed.date <= end.date) return { start: fixed, end };
  }
  return { start, end };
}

/** Minimal RFC 4180 CSV parsing (quotes, escaped quotes, embedded delimiters). */
export function parseDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"' && cur.trim() === '') { q = true; cur = ''; }
    else if (ch === delim) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const HEADER: Record<string, keyof ChapterDraft | 'date' | 'skip'> = {
  date: 'date', day: 'date', dates: 'date', start: 'start', from: 'start', 'start date': 'start', begin: 'start',
  end: 'end', to: 'end', until: 'end', 'end date': 'end',
  location: 'locationName', place: 'locationName', city: 'locationName', where: 'locationName', destination: 'locationName',
  title: 'title', name: 'title', chapter: 'title',
  description: 'description', notes: 'description', note: 'description', details: 'description', activities: 'description',
  timezone: 'timeZone', 'time zone': 'timeZone', tz: 'timeZone',
};

function titleFrom(location: string): string {
  return location.split(',')[0].trim();
}

/**
 * Parse a pasted itinerary or a CSV file into chapter drafts, for a preview
 * before anything changes. Understands a header row (date/start/end,
 * location, title, description, time zone in any order) or plain lines like
 * "May 1, 2026, Lisbon, arrive and explore Alfama" and
 * "2026-05-05 to 2026-05-07  Porto — bookshops and port lodges".
 * Consecutive days in the same place become one chapter.
 */
export function parseItinerary(text: string, defaultTz = deviceTimeZone()): ImportResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const errors: ImportResult['errors'] = [];
  const rows: ChapterDraft[] = [];
  const first = lines.findIndex((l) => l.trim() && !l.trim().startsWith('#'));
  if (first < 0) return { chapters: [], errors: [], merged: 0 };
  const delim = (['\t', ',', ';'] as const).map((d) => [d, lines[first].split(d).length] as const).sort((a, b) => b[1] - a[1])[0];
  const head = parseDelimited(lines[first], delim[0]).map((h) => HEADER[h.toLowerCase().replace(/[_-]/g, ' ').trim()]);
  const hasHeader = head.filter(Boolean).length >= 2 && head.includes('locationName');
  let year: number | undefined;

  for (let n = hasHeader ? first + 1 : first; n < lines.length; n++) {
    const raw = lines[n];
    const line = raw.trim();
    const lineNo = n + 1;
    if (!line || line.startsWith('#')) continue;
    let when: { start: DateTime; end: DateTime } | undefined;
    let location = '';
    let title = '';
    let description = '';
    let tz = defaultTz;
    if (hasHeader) {
      const cells = parseDelimited(raw, delim[0]);
      const get = (k: string) => head.map((h, i) => (h === k ? cells[i] ?? '' : '')).filter(Boolean).join(' ').trim();
      const dateCell = get('date');
      const startCell = get('start');
      const endCell = get('end');
      if (dateCell) when = parseRange(dateCell, year);
      else if (startCell) {
        const s = parseDateTime(startCell, year);
        const e = endCell ? parseDateTime(endCell, s ? +s.date.slice(0, 4) : year) : s;
        if (s && e) when = { start: s, end: e };
      }
      location = get('locationName');
      title = get('title');
      description = get('description');
      const tzCell = get('timeZone');
      if (tzCell) {
        if (isValidTimeZone(tzCell)) tz = tzCell;
        else errors.push({ line: lineNo, message: `Unknown time zone "${tzCell}"; using ${defaultTz}` });
      }
    } else {
      // Plain line: DATE-OR-RANGE <sep> LOCATION [<sep> DESCRIPTION]
      const cells = delim[1] > 1 ? parseDelimited(raw, delim[0]) : [];
      // Date cells may themselves contain a comma ("May 1, 2026"); grow the date cell until it parses.
      let used = 0;
      for (let k = 1; k <= Math.min(3, cells.length - 1); k++) {
        const r = parseRange(cells.slice(0, k).join(', '), year);
        if (r) { when = r; used = k; }
      }
      if (when) {
        let rest = cells.slice(used);
        // "May 8-10, 2026 Pinhão": the year sits at the front of the next cell.
        const yr = /^(\d{4})\s+(.+)$/.exec(rest[0] ?? '');
        if (yr) {
          const withYear = parseRange(`${cells.slice(0, used).join(', ')}, ${yr[1]}`, year);
          if (withYear) {
            when = withYear;
            rest = [yr[2], ...rest.slice(1)];
          }
        }
        const head = (rest[0] ?? '').split(/\s+[—–-]\s+|:\s+/);
        location = head[0].trim();
        description = [...head.slice(1), ...rest.slice(1)].join(', ').trim();
      } else {
        const m = /^(.+?\d)\s{2,}(.+)$/.exec(line) ?? /^([^A-Za-z]*?\d(?:\s+(?:to|-|–|—)\s+[^A-Za-z]*?\d)?)\s+(.+)$/.exec(line)
          ?? /^((?:[a-z]{3,}\.? \d{1,2}(?:,? \d{4})?)(?:\s*(?:to|-|–|—)\s*(?:[a-z]{3,}\.? )?\d{1,2}(?:,? \d{4})?)?)\s+(.+)$/i.exec(line);
        if (m) {
          when = parseRange(m[1], year);
          const rest = m[2].split(/\s+[—–-]\s+|:\s+/);
          location = rest[0].trim();
          description = rest.slice(1).join(' — ').trim();
        }
      }
    }
    if (!when) {
      errors.push({ line: lineNo, message: `Could not read a date in "${line.slice(0, 60)}"` });
      continue;
    }
    if (!location) {
      errors.push({ line: lineNo, message: 'No place given' });
      continue;
    }
    year = +when.end.date.slice(0, 4);
    rows.push({
      title: title || titleFrom(location),
      locationName: location,
      start: `${when.start.date}T${when.start.time ?? '00:00'}`,
      end: `${when.end.date}T${when.end.time ?? '23:59'}`,
      timeZone: tz,
      description,
      lines: [lineNo],
    });
  }

  // Fold "next day, same place" rows into one chapter.
  const chapters: ChapterDraft[] = [];
  let merged = 0;
  for (const r of rows) {
    const prev = chapters[chapters.length - 1];
    const allDay = (d: ChapterDraft) => d.start.endsWith('T00:00') && d.end.endsWith('T23:59');
    if (prev && allDay(prev) && allDay(r) && prev.locationName.toLowerCase() === r.locationName.toLowerCase()
      && prev.timeZone === r.timeZone && addDays(prev.end.slice(0, 10), 1) === r.start.slice(0, 10)) {
      prev.end = r.end;
      prev.description = [prev.description, r.description].filter(Boolean).join('; ');
      prev.lines.push(...r.lines);
      merged++;
    } else chapters.push({ ...r, lines: [...r.lines] });
  }
  return { chapters, errors, merged };
}

/** Add imported drafts as new chapters after the existing ones. */
export function appendDrafts(p: Travelogue, drafts: ChapterDraft[]): Travelogue {
  const added: Chapter[] = drafts.map((d) => ({
    id: randomId('ch'), title: d.title, locationName: d.locationName, start: d.start, end: d.end,
    timeZone: d.timeZone, description: d.description, titleCard: { enabled: true },
  }));
  return { ...p, chapters: [...p.chapters, ...added] };
}
