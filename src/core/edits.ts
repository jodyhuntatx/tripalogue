/**
 * Immutable edit helpers. Each returns a new Travelogue that shares every
 * untouched branch with the input, which is what keeps History cheap.
 * Phase 0 ships the handful the player shell and tests need; editors in later
 * phases add theirs here.
 */
import { keyBetween } from './fractional.js';
import type { Chapter, Cue, Id, Travelogue } from './schema.js';

export function setTitle(p: Travelogue, title: string): Travelogue {
  return title === p.title ? p : { ...p, title };
}

export function updateCue(p: Travelogue, itemId: Id, patch: Partial<Omit<Cue, 'itemId'>>): Travelogue {
  const i = p.cues.findIndex((c) => c.itemId === itemId);
  if (i < 0) throw new Error(`No cue for item ${itemId}`);
  const cues = p.cues.slice();
  cues[i] = { ...cues[i], ...patch };
  return { ...p, cues };
}

export function setIncluded(p: Travelogue, itemId: Id, included: boolean): Travelogue {
  return updateCue(p, itemId, { included });
}

/**
 * Move an item to a new position (0-based) among its chapter's cues. Only the
 * moved cue changes: it gets a fractional key between its new neighbours, so a
 * concurrent move by someone else never collides with this one.
 */
export function moveItem(p: Travelogue, itemId: Id, toIndex: number): Travelogue {
  const item = p.media.find((m) => m.id === itemId);
  if (!item) throw new Error(`No media item ${itemId}`);
  const inChapter = new Set(p.media.filter((m) => m.chapterId === item.chapterId).map((m) => m.id));
  const ordered = p.cues.filter((c) => inChapter.has(c.itemId)).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  const from = ordered.findIndex((c) => c.itemId === itemId);
  if (from < 0) throw new Error(`No cue for item ${itemId}`);
  const to = Math.max(0, Math.min(ordered.length - 1, toIndex));
  if (from === to) return p;
  const rest = ordered.filter((c) => c.itemId !== itemId);
  const before = rest[to - 1]?.order ?? null;
  const after = rest[to]?.order ?? null;
  return updateCue(p, itemId, { order: keyBetween(before, after) });
}

export function addChapter(p: Travelogue, chapter: Chapter, index = p.chapters.length): Travelogue {
  if (p.chapters.some((c) => c.id === chapter.id)) throw new Error(`Duplicate chapter id ${chapter.id}`);
  const chapters = p.chapters.slice();
  chapters.splice(index, 0, chapter);
  return { ...p, chapters };
}
