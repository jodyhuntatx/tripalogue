/**
 * Removing media, putting it back, and deleting it for good.
 *
 * Removing moves items (with their cues) from the travelogue into the Removed
 * bin: everything that reads `media` ignores them, and Undo, "Put back" or
 * restoring a saved version brings them back. Deleting for good is a server
 * action that strips the items from the travelogue and from every saved
 * version before their files are erased, so nothing can bring them back.
 */
import { keyBetween } from './fractional.js';
import { defaultCue } from './project.js';
import type { Id, RemovedItem, Travelogue } from './schema.js';

/** Move items (and their cues) to the Removed bin. */
export function removeMedia(p: Travelogue, ids: Id[], at: string, by?: Id): Travelogue {
  const want = new Set(ids);
  const going = p.media.filter((m) => want.has(m.id));
  if (!going.length) return p;
  const cues = new Map(p.cues.filter((c) => want.has(c.itemId)).map((c) => [c.itemId, c]));
  const entries: RemovedItem[] = going.map((item) => ({ item, ...(cues.has(item.id) ? { cue: cues.get(item.id) } : {}), removedAt: at, ...(by ? { removedBy: by } : {}) }));
  return {
    ...p,
    media: p.media.filter((m) => !want.has(m.id)),
    cues: p.cues.filter((c) => !want.has(c.itemId)),
    removed: [...(p.removed ?? []), ...entries],
  };
}

/** Put items back from the Removed bin, with the cue they had (a fresh one at the end of their chapter if none). */
export function restoreMedia(p: Travelogue, ids: Id[]): Travelogue {
  const want = new Set(ids);
  const back = (p.removed ?? []).filter((r) => want.has(r.item.id));
  if (!back.length) return p;
  let cues = p.cues;
  for (const r of back) {
    if (r.cue) cues = [...cues, r.cue];
    else {
      const last = cues.filter((c) => p.media.some((m) => m.id === c.itemId && m.chapterId === r.item.chapterId)).map((c) => c.order).sort().pop() ?? null;
      cues = [...cues, defaultCue(r.item, p.cueProfile, keyBetween(last, null))];
    }
  }
  return { ...p, media: [...p.media, ...back.map((r) => r.item)], cues, removed: (p.removed ?? []).filter((r) => !want.has(r.item.id)) };
}

/** Take items out completely: from the travelogue and the Removed bin (used when deleting for good). */
export function stripMedia(p: Travelogue, ids: Iterable<Id>): Travelogue {
  const gone = new Set(ids);
  if (!p.media.some((m) => gone.has(m.id)) && !(p.removed ?? []).some((r) => gone.has(r.item.id))) return p;
  return {
    ...p,
    media: p.media.filter((m) => !gone.has(m.id)),
    cues: p.cues.filter((c) => !gone.has(c.itemId)),
    removed: (p.removed ?? []).filter((r) => !gone.has(r.item.id)),
  };
}

/** Removed items whose time in the bin is up (removed more than `days` ago). */
export function expiredRemovals(p: Travelogue, now: number, days: number): Id[] {
  const limit = now - days * 86_400_000;
  return (p.removed ?? []).filter((r) => Date.parse(r.removedAt) <= limit).map((r) => r.item.id);
}

/** Every media id the document mentions, live or in the bin. */
export const mediaIdsIn = (p: Travelogue): Set<Id> => new Set([...p.media.map((m) => m.id), ...(p.removed ?? []).map((r) => r.item.id)]);
