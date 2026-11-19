/**
 * Items without a location borrow the place of the most recent earlier item that has one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTimeline, mapAt, mediaPlace, mediaPlaces, parseProject, type MapLayer, type MediaItem, type Travelogue } from '../src/core/index.js';

const sample = (): Travelogue => parseProject(readFileSync('samples/hand-written-20/trip.travelogue.json', 'utf8')).project;
const edit = (p: Travelogue, id: string, patch: (m: MediaItem) => MediaItem): Travelogue => ({ ...p, media: p.media.map((m) => (m.id === id ? patch(m) : m)) });
const unlocate = (p: Travelogue, id: string) => edit(p, id, ({ location: _l, ...m }) => m);
const loc = (p: Travelogue, id: string) => p.media.find((m) => m.id === id)!.location!;

describe('borrowed places', () => {
  it('an item without a location is placed where the last earlier located item was taken', () => {
    const p = unlocate(sample(), 'm04');
    const at = mediaPlace(p, 'm04')!;
    assert.deepEqual({ lat: at.lat, lng: at.lng }, loc(p, 'm03'));
    assert.equal(at.from, 'm03');
  });

  it('uses the most recent earlier one, skipping other items without a location, not a later one', () => {
    let p = unlocate(sample(), 'm03');
    p = unlocate(p, 'm04');
    assert.equal(mediaPlace(p, 'm03')!.from, 'm02');
    assert.equal(mediaPlace(p, 'm04')!.from, 'm02', 'm03 has none of its own to lend');
  });

  it('goes by capture time, including a time set by hand, not by order in the project', () => {
    // m02 is moved to after m03 by hand: m04 now borrows from m02.
    let p = edit(sample(), 'm02', (m) => ({ ...m, userTimestamp: '2026-05-02T12:00:00' }));
    p = unlocate(p, 'm04');
    assert.equal(mediaPlace(p, 'm04')!.from, 'm02');
  });

  it('crosses chapters: the first photo of a chapter can borrow from the end of the one before', () => {
    const p = unlocate(sample(), 'm06');
    assert.equal(mediaPlace(p, 'm06')!.from, 'm05');
  });

  it('an item taken before any located item, or with no capture time, gets no place', () => {
    let p = unlocate(sample(), 'm01');
    assert.equal(mediaPlace(p, 'm01'), undefined);
    p = edit(unlocate(sample(), 'm04'), 'm04', ({ capturedAt: _c, ...m }) => m);
    assert.equal(mediaPlace(p, 'm04'), undefined);
  });

  it('an item\'s own location always wins and is not marked as borrowed', () => {
    const p = sample();
    const at = mediaPlace(p, 'm04')!;
    assert.equal(at.from, undefined);
    assert.deepEqual({ lat: at.lat, lng: at.lng }, loc(p, 'm04'));
  });

  it('does not change the project', () => {
    const p = unlocate(sample(), 'm04');
    mediaPlaces(p);
    assert.equal(p.media.find((m) => m.id === 'm04')!.location, undefined);
  });

  it('the map shows a dot for the item where it borrowed its place, and the marker moves there', () => {
    const p = unlocate(sample(), 'm04');
    const tl = buildTimeline(p);
    const s = tl.segments.find((x) => x.kind !== 'title' && x.item.id === 'm04')!;
    const m = mapAt(p, tl, s.start + s.duration / 2, { w: 1920, h: 1080 })!;
    const layer = { state: m.state } as Pick<MapLayer, 'state'>;
    const cur = layer.state.dots.filter((d) => d.state === 'current');
    assert.equal(cur.length, 1);
    assert.equal(cur[0].lat, loc(p, 'm03').lat);
    assert.equal(layer.state.marker?.lat, loc(p, 'm03').lat);
  });
});
