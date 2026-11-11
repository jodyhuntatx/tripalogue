import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  contributorReports, distanceKm, farFromChapter, messagingApp, originalsRequest, parseProject, renameSource, setItemLocation, setSourceContributor, strippedSigns,
  type MediaItem, type Travelogue,
} from '../src/core/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = () => parseProject(readFileSync(path.resolve(here, '../samples/hand-written-20/trip.travelogue.json'), 'utf8')).project;

const original = (id: string, sourceId: string, extra: Partial<MediaItem> = {}): MediaItem => ({
  id, sourceId, uri: `IMG_${id}.HEIC`, kind: 'image', chapterId: 'ch-lisbon', status: 'ready', capturedAt: '2026-05-01T10:00:00+01:00',
  timestampConfidence: 'high', width: 4032, height: 3024, location: { lat: 38.71, lng: -9.14 }, ...extra,
});

function withTravelers(media: MediaItem[]): Travelogue {
  const p = sample();
  return {
    ...p,
    sources: [
      { id: 'ana', type: 'upload', displayName: 'Ana', contributorId: 'u_ana', clockOffsetSec: 0 },
      { id: 'ben', type: 'upload', displayName: 'Ben', contributorId: 'u_ben', clockOffsetSec: 0 },
      { id: 'cam', type: 'upload', displayName: 'Jody · Canon', contributorId: 'u_jody', camera: 'Canon EOS R6', clockOffsetSec: 0 },
    ],
    media,
  };
}

describe('contributor metadata check (MM-17)', () => {
  it('reports nothing for untouched originals', () => {
    const r = contributorReports(withTravelers([original('1', 'ana'), original('2', 'ana', { kind: 'video', width: 3840, height: 2160, uri: 'IMG_0002.MOV' })]));
    assert.deepEqual(r.map((x) => [x.contributorId, x.total, x.noTime.length, x.noPlace.length, x.stripped.length]), [['u_ana', 2, 0, 0, 0]]);
  });

  it('finds messaging-app copies, small stills, 720p video, and missing times and places, per contributor', () => {
    const r = contributorReports(withTravelers([
      original('1', 'ana'),
      original('w', 'ben', { uri: 'IMG-20260503-WA0007.jpg', width: 1600, height: 1200, location: undefined, capturedAt: '2026-11-11T10:00:00Z', timestampConfidence: 'low' }),
      original('v', 'ben', { kind: 'video', uri: 'VID-20260503-WA0002.mp4', width: 1280, height: 720, location: undefined }),
      original('c', 'cam', { location: undefined, uri: 'DSC_0101.JPG', width: 6000, height: 4000 }),
      original('p', 'ben', { status: 'processing', width: undefined, height: undefined }),
    ]));
    const ben = r.find((x) => x.contributorId === 'u_ben')!;
    assert.deepEqual([ben.total, ben.noTime, ben.noPlace, ben.stripped, ben.apps], [2, ['w'], ['w', 'v'], ['w', 'v'], ['WhatsApp']], 'items still processing are not judged');
    const cam = r.find((x) => x.contributorId === 'u_jody')!;
    assert.deepEqual([cam.noPlace, cam.stripped], [['c'], []], 'a camera with no GPS: no location, but not a copy');
    const note = originalsRequest(ben, { name: 'Ben', trip: 'Portugal', from: 'Jody' });
    assert.match(note, /^Hi Ben,/);
    assert.match(note, /2 look like smaller copies \(saved from WhatsApp\)/);
    assert.match(note, /1 have no capture time and 2 have no location/);
    assert.match(note, /Jody$/);
  });

  it('recognises the usual messaging-app file names', () => {
    for (const [name, app] of [['IMG-20260503-WA0007.jpg', 'WhatsApp'], ['WhatsApp Image 2026-05-03 at 14.22.10.jpeg', 'WhatsApp'], ['signal-2026-05-03-142210.jpg', 'Signal'],
      ['photo_2026-05-03_14-22-10.jpg', 'Telegram'], ['received_1234567890.jpeg', 'Facebook']]) assert.equal(messagingApp(name), app, name);
    for (const name of ['IMG_0420.HEIC', 'PXL_20260503_142210.jpg', 'DSC_0101.JPG', 'VID_20260503.mp4']) assert.equal(messagingApp(name), undefined, name);
    assert.deepEqual(strippedSigns(original('x', 'ana', { width: 2048, height: 1536 })), ['small']);
    assert.deepEqual(strippedSigns(original('x', 'ana', { width: 2049, height: 1536 })), []);
  });
});

describe('locations and sources (MM-9, MM-16, MV-2)', () => {
  it('sets, copies and clears locations on several items at once', () => {
    const p = withTravelers([original('1', 'ana'), original('2', 'ben', { location: undefined })]);
    const q = setItemLocation(p, ['1', '2'], { lat: 41.1579123456, lng: -8.629 });
    assert.deepEqual(q.media.map((m) => m.location), [{ lat: 41.157912, lng: -8.629 }, { lat: 41.157912, lng: -8.629 }]);
    assert.deepEqual(setItemLocation(q, ['2'], null).media.map((m) => !!m.location), [true, false]);
  });

  it('names the traveler behind a source and renames it', () => {
    const p = withTravelers([]);
    const q = renameSource(setSourceContributor(p, 'ben', null), 'ben', '  Ben’s phone ');
    assert.deepEqual(q.sources[1], { id: 'ben', type: 'upload', displayName: 'Ben’s phone', contributorId: undefined, clockOffsetSec: 0 });
    assert.equal(renameSource(q, 'ben', '   '), q, 'blank names are ignored');
  });

  it('flags a lone item taken far from its chapter, but not a day trip with company', () => {
    const p = sample(); // Lisbon chapter pin: Lisbon; Porto is about 275 km away
    assert.ok(Math.abs(distanceKm({ lat: 38.7223, lng: -9.1393 }, { lat: 41.1579, lng: -8.6291 }) - 274) < 5);
    const porto = { lat: 41.15, lng: -8.62 };
    const lone = farFromChapter({ ...p, media: [original('far', 'ana', { location: porto }), original('near', 'ana')] });
    assert.deepEqual([...lone.keys()], ['far']);
    const sintraDay = { lat: 38.80, lng: -9.38 }; // ~20 km: not far
    const trip = farFromChapter({ ...p, media: [original('a', 'ana', { location: sintraDay })] });
    assert.equal(trip.size, 0);
    const evora = { lat: 38.57, lng: -7.91 }; // ~110 km, two photos together: a day trip
    const day = farFromChapter({ ...p, media: [original('e1', 'ana', { location: evora }), original('e2', 'ana', { location: { lat: 38.572, lng: -7.909 } })] });
    assert.equal(day.size, 0);
  });
});
