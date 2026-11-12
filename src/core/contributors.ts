/**
 * Contributors (MM-16, MM-17) and item locations (MM-9).
 *
 * A contributor is the traveler behind a source (source.contributorId). The
 * metadata check looks, per contributor, for items that will sort or map
 * badly: no capture time from the camera, no location, and signs that a file
 * is a copy made by a messaging app or a "small size" export rather than the
 * original (stills at or under 2,048 px on the long edge, video at 720p or
 * less, messaging-app file names). Untouched originals from a phone or camera
 * with location on produce no reports.
 */
import type { Id, LatLng, MediaItem, Travelogue } from './schema.js';

export const STRIPPED_STILL_PX = 2048;
export const STRIPPED_VIDEO_PX = 1280;

// File names messaging and social apps give the copies they make.
const MESSAGING_NAMES: [RegExp, string][] = [
  [/^(IMG|VID|AUD|PTT)-\d{8}-WA\d+/i, 'WhatsApp'],
  [/^WhatsApp (Image|Video|Audio) \d{4}-\d{2}-\d{2}/i, 'WhatsApp'],
  [/^signal-\d{4}-\d{2}-\d{2}/i, 'Signal'],
  [/^(photo|video)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/i, 'Telegram'],
  [/^(received_\d{6,}|FB_IMG_\d{6,})/i, 'Facebook'],
  [/^Messenger_creation_/i, 'Messenger'],
];

/** The app whose naming a file follows, if it looks like a messaging-app copy. */
export function messagingApp(uri: string): string | undefined {
  const name = uri.split(/[\\/]/).pop() ?? uri;
  return MESSAGING_NAMES.find(([re]) => re.test(name))?.[1];
}

export type StrippedSign = 'small' | 'lowVideo' | 'messaging';

/** Why an item looks like a reduced copy rather than the original (empty when it looks original). */
export function strippedSigns(m: MediaItem): StrippedSign[] {
  const out: StrippedSign[] = [];
  const long = Math.max(m.width ?? 0, m.height ?? 0);
  if (m.kind === 'image' && long > 0 && long <= STRIPPED_STILL_PX) out.push('small');
  if (m.kind === 'video' && long > 0 && long <= STRIPPED_VIDEO_PX) out.push('lowVideo');
  if (messagingApp(m.uri)) out.push('messaging');
  return out;
}

/** No capture time from the camera: none at all, or only the file date (low confidence). */
export const lacksTime = (m: MediaItem) => !m.capturedAt || m.timestampConfidence === 'low';
/** No location (audio has none to give, so it is not reported). */
export const lacksPlace = (m: MediaItem) => m.kind !== 'audio' && !m.location;

export interface ContributorReport {
  /** Member id, or null for media whose source names no traveler. */
  contributorId: Id | null;
  total: number;
  noTime: Id[];
  noPlace: Id[];
  stripped: Id[];
  /** Messaging apps seen in file names. */
  apps: string[];
}

export function contributorOf(p: Travelogue, m: MediaItem): Id | null {
  return p.sources.find((s) => s.id === m.sourceId)?.contributorId ?? null;
}

/** MM-17: the metadata check, one report per contributor (in order of first appearance). */
export function contributorReports(p: Travelogue): ContributorReport[] {
  const by = new Map<Id | null, ContributorReport>();
  for (const m of p.media) {
    if (m.status && m.status !== 'ready') continue; // not processed yet: size and metadata unknown
    const c = contributorOf(p, m);
    let r = by.get(c);
    if (!r) by.set(c, (r = { contributorId: c, total: 0, noTime: [], noPlace: [], stripped: [], apps: [] }));
    r.total += 1;
    if (lacksTime(m)) r.noTime.push(m.id);
    if (lacksPlace(m)) r.noPlace.push(m.id);
    if (strippedSigns(m).length) r.stripped.push(m.id);
    const app = messagingApp(m.uri);
    if (app && !r.apps.includes(app)) r.apps.push(app);
  }
  return [...by.values()];
}

/** A ready-to-send note asking a contributor to re-share originals (MM-17). */
export function originalsRequest(r: ContributorReport, o: { name: string; trip: string; from: string }): string {
  const bits: string[] = [];
  if (r.stripped.length) bits.push(`${r.stripped.length} look like smaller copies${r.apps.length ? ` (saved from ${r.apps.join(' and ')})` : ''} rather than the originals`);
  if (r.noTime.length) bits.push(`${r.noTime.length} have no capture time`);
  if (r.noPlace.length) bits.push(`${r.noPlace.length} have no location`);
  const what = bits.length ? `Of the ${r.total} photos and videos you shared, ${joinList(bits)}.` : `Thanks for the ${r.total} photos and videos you shared.`;
  return [
    `Hi ${o.name},`,
    '',
    `Thanks for adding your photos and videos to "${o.trip}". ${what} Without the originals they can't be placed in the right part of the trip or on the map.`,
    '',
    'Could you upload the originals again? A few tips:',
    '- Upload from your phone’s photo library or your computer, not from a chat app: messaging apps shrink files and remove the time and place.',
    '- On iPhone, when sharing, tap Options and turn on Location and All Photos Data. On Android, check that your share or export keeps location.',
    '- Use the same upload link as before; files you already sent are recognised and skipped.',
    '',
    'Thank you!',
    o.from,
  ].join('\n');
}

const joinList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// ---------------------------------------------------------------- sources and locations

/** MM-16: name the traveler behind a source (null clears it). */
export function setSourceContributor(p: Travelogue, sourceId: Id, contributorId: Id | null): Travelogue {
  return { ...p, sources: p.sources.map((s) => (s.id === sourceId ? { ...s, contributorId: contributorId ?? undefined } : s)) };
}

export function renameSource(p: Travelogue, sourceId: Id, displayName: string): Travelogue {
  const name = displayName.trim();
  if (!name) return p;
  return { ...p, sources: p.sources.map((s) => (s.id === sourceId ? { ...s, displayName: name } : s)) };
}

/** MM-9: set, copy (set from another) or clear (null) the location of one or many items. */
export function setItemLocation(p: Travelogue, ids: Id[], location: LatLng | null): Travelogue {
  const want = new Set(ids);
  return {
    ...p,
    media: p.media.map((m) => (want.has(m.id) ? { ...m, location: location ? { lat: round6(location.lat), lng: round6(location.lng) } : undefined } : m)),
  };
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Great-circle distance in km. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const FAR_KM = 50;

/**
 * MV-2: items taken far from their chapter's place, likely misassigned: more than FAR_KM from the chapter's pin,
 * and from every other located item in the chapter (so a day trip with several photos is not flagged).
 */
export function farFromChapter(p: Travelogue): Map<Id, number> {
  const out = new Map<Id, number>();
  for (const ch of p.chapters) {
    if (!ch.coordinates) continue;
    const items = p.media.filter((m) => m.chapterId === ch.id && m.location);
    for (const m of items) {
      const d = distanceKm(ch.coordinates, m.location!);
      if (d <= FAR_KM) continue;
      const company = items.some((o) => o.id !== m.id && distanceKm(o.location!, m.location!) <= FAR_KM / 5 && distanceKm(ch.coordinates!, o.location!) > FAR_KM);
      if (!company) out.set(m.id, Math.round(d));
    }
  }
  return out;
}
