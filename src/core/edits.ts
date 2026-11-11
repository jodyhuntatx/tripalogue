/**
 * Immutable edit helpers. Each returns a new Travelogue that shares every
 * untouched branch with the input, which is what keeps History cheap.
 * Phase 0 ships the handful the player shell and tests need; editors in later
 * phases add theirs here.
 */
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

/** Move an item to a new position (0-based) among its chapter's cues. */
export function moveItem(p: Travelogue, itemId: Id, toIndex: number): Travelogue {
  const item = p.media.find((m) => m.id === itemId);
  if (!item) throw new Error(`No media item ${itemId}`);
  const inChapter = new Set(p.media.filter((m) => m.chapterId === item.chapterId).map((m) => m.id));
  const ordered = p.cues.filter((c) => inChapter.has(c.itemId)).sort((a, b) => a.order - b.order);
  const from = ordered.findIndex((c) => c.itemId === itemId);
  if (from < 0) throw new Error(`No cue for item ${itemId}`);
  const to = Math.max(0, Math.min(ordered.length - 1, toIndex));
  if (from === to) return p;
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  const newOrder = new Map(ordered.map((c, i) => [c.itemId, i]));
  return { ...p, cues: p.cues.map((c) => (newOrder.has(c.itemId) && newOrder.get(c.itemId) !== c.order ? { ...c, order: newOrder.get(c.itemId)! } : c)) };
}

export function addChapter(p: Travelogue, chapter: Chapter, index = p.chapters.length): Travelogue {
  if (p.chapters.some((c) => c.id === chapter.id)) throw new Error(`Duplicate chapter id ${chapter.id}`);
  const chapters = p.chapters.slice();
  chapters.splice(index, 0, chapter);
  return { ...p, chapters };
}
