/**
 * Where each picture or video was taken, for the map.
 *
 * An item with no location of its own (no GPS in the file, none set by hand) is placed where the most recent
 * earlier item with a location was taken: the last photo or video, by capture time, that has one. Nothing is
 * written into the project; give the item a location and that one is used instead.
 *
 * An item with no capture time, or taken before any located item, gets no place this way.
 */
import { mediaInstant } from './itinerary.js';
import type { Id, LatLng, MediaItem, Travelogue } from './schema.js';

export interface MediaPlace extends LatLng {
  /** Set when the place is borrowed: the item whose location it is. */
  from?: Id;
}

const visual = (m: MediaItem) => m.kind === 'image' || m.kind === 'video';

const cache = new WeakMap<MediaItem[], { chapters: Travelogue['chapters']; places: Map<Id, MediaPlace> }>();

/** Every picture and video with a place: its own location, or the one it borrows. */
export function mediaPlaces(p: Travelogue): Map<Id, MediaPlace> {
  const hit = cache.get(p.media);
  if (hit && hit.chapters === p.chapters) return hit.places;
  const tzOf = new Map(p.chapters.map((c) => [c.id, c.timeZone]));
  const fallbackTz = p.chapters[0]?.timeZone ?? 'UTC';
  const timed = p.media
    .filter(visual)
    .map((m) => ({ m, t: mediaInstant(m, (m.chapterId && tzOf.get(m.chapterId)) || fallbackTz) }));
  const places = new Map<Id, MediaPlace>();
  for (const { m } of timed) if (m.location) places.set(m.id, { lat: m.location.lat, lng: m.location.lng });
  // In capture order; items taken at the same moment keep the project's order, with located ones first.
  const ordered = timed
    .map((x, i) => ({ ...x, i }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t || Number(!a.m.location) - Number(!b.m.location) || a.i - b.i);
  let last: MediaItem | undefined;
  for (const { m } of ordered) {
    if (m.location) last = m;
    else if (last) places.set(m.id, { lat: last.location!.lat, lng: last.location!.lng, from: last.id });
  }
  cache.set(p.media, { chapters: p.chapters, places });
  return places;
}

/** The place of one item (its own, or borrowed), if it has one. */
export function mediaPlace(p: Travelogue, itemId: Id): MediaPlace | undefined {
  return mediaPlaces(p).get(itemId);
}
