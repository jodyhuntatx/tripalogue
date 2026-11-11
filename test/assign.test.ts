import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  chapterCounts, dropIntoChapter, duplicateGroups, effectiveInstant, itemInstant, keepAssigned, overlapItems, parseProject, placementFor, previewClockOffset,
  reassign, setClockOffset, setUserTime, shiftUserTime, spreadKeys, updateChapter,
  type Chapter, type MediaItem, type Travelogue,
} from '../src/core/index.js';
import { cameraName, metaFromTags, metaFromTiff, parseIso6709, photoMeta } from '../src/server/metadata.js';
import { exifTiff, writeHeic } from './helpers/heic.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = () => parseProject(readFileSync(path.resolve(here, '../samples/hand-written-20/trip.travelogue.json'), 'utf8')).project;

const ch = (id: string, start: string, end: string, timeZone = 'Europe/Lisbon'): Chapter =>
  ({ id, title: id, locationName: '', start, end, timeZone, description: '', titleCard: { enabled: true } });
const item = (id: string, capturedAt?: string, extra: Partial<MediaItem> = {}): MediaItem =>
  ({ id, sourceId: 'src', uri: `${id}.jpg`, kind: 'image', chapterId: null, ...(capturedAt ? { capturedAt } : {}), ...extra });

function trip(chapters: Chapter[], media: MediaItem[], offsetSec = 0): Travelogue {
  const p = sample();
  return {
    ...p, chapters,
    sources: [{ id: 'src', type: 'upload', displayName: 'Camera', clockOffsetSec: offsetSec }],
    media,
    cues: ((keys) => media.map((m, i) => ({ ...p.cues[0], itemId: m.id, order: keys[i] })))(spreadKeys(media.length)),
  };
}

describe('assignment rule (MM-3)', () => {
  const lisbon = ch('lisbon', '2026-05-01T00:00', '2026-05-03T23:59');
  const sintra = ch('sintra', '2026-05-04T00:00', '2026-05-04T23:59');
  const porto = ch('porto', '2026-05-06T00:00', '2026-05-07T23:59');

  it('agrees with every hand-made assignment in the sample project', () => {
    const p = sample();
    assert.equal(reassign(p), p, 'nothing moves');
    assert.equal(overlapItems(p).size, 0);
  });

  it('puts items in the chapter that contains them, read in that chapter’s time zone; gaps go to Unassigned', () => {
    const p = reassign(trip([lisbon, sintra, porto], [
      item('a', '2026-05-02T10:00:00'), // local (no offset)
      item('b', '2026-05-04T22:30:00+01:00'), // absolute, Lisbon summer time
      item('c', '2026-05-05T12:00:00'), // the gap between Sintra and Porto
      item('d', '2026-05-03T23:59:30'), // inside the last minute of Lisbon
      item('e'), // no time: never moved
    ]));
    const at = (id: string) => p.media.find((m) => m.id === id)!.chapterId;
    assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(at), ['lisbon', 'sintra', null, 'lisbon', null]);
    assert.deepEqual([...chapterCounts(p)], [[null, 2], ['lisbon', 2], ['sintra', 1], ['porto', 0]]);
  });

  it('reads absolute times across zones: 06:00 UTC is lunchtime in Kathmandu (UTC+5:45)', () => {
    const ktm = ch('ktm', '2026-10-01T00:00', '2026-10-02T23:59', 'Asia/Kathmandu');
    const lukla = ch('lukla', '2026-10-03T00:00', '2026-10-03T23:59', 'Asia/Kathmandu');
    const p = reassign(trip([ktm, lukla], [item('x', '2026-10-02T20:00:00Z'), item('y', '2026-10-02T17:00:00Z')]));
    // 20:00Z = 01:45 on 3 Oct in Kathmandu; 17:00Z = 22:45 on 2 Oct.
    assert.deepEqual(p.media.map((m) => m.chapterId), ['lukla', 'ktm']);
  });

  it('back-to-back chapters share no instant; overlaps go to the earlier chapter and are flagged', () => {
    const a = ch('a', '2026-05-01T00:00', '2026-05-02T08:00');
    const b = ch('b', '2026-05-02T08:00', '2026-05-02T23:59');
    const p = reassign(trip([a, b], [item('at8', '2026-05-02T08:00:30'), item('before8', '2026-05-02T07:59:59')]));
    assert.deepEqual(p.media.map((m) => m.chapterId), ['b', 'a']);
    assert.equal(overlapItems(p).size, 0);
    const o1 = ch('o1', '2026-05-01T00:00', '2026-05-02T12:00');
    const o2 = ch('o2', '2026-05-02T09:00', '2026-05-03T23:59');
    const q = reassign(trip([o2, o1], [item('both', '2026-05-02T10:00:00')]));
    assert.equal(q.media[0].chapterId, 'o1', 'the chapter that starts earlier wins, whatever the list order');
    assert.deepEqual([...overlapItems(q)], ['both']);
  });

  it('applies the source clock offset to capture times but not to timestamps the user set', () => {
    const p = trip([lisbon, sintra], [item('cam', '2026-05-03T23:30:00'), item('fixed', '2026-05-03T23:30:00', { userTimestamp: '2026-05-03T12:00:00' })], 3600);
    assert.equal(effectiveInstant(p.media[0], p.sources[0], 'Europe/Lisbon') - effectiveInstant({ ...p.media[0] }, undefined, 'Europe/Lisbon'), 3_600_000);
    const q = reassign(p);
    assert.deepEqual(q.media.map((m) => m.chapterId), ['sintra', 'lisbon']);
  });

  it('slots a newly placed item into its chapter in time order', () => {
    const p = trip([lisbon], [
      item('early', '2026-05-01T09:00:00', { chapterId: 'lisbon' }),
      item('late', '2026-05-02T09:00:00', { chapterId: 'lisbon' }),
      item('new', '2026-05-01T15:00:00'),
    ]);
    const q = reassign(p);
    const order = q.cues.slice().sort((x, y) => (x.order < y.order ? -1 : 1)).map((c) => c.itemId);
    assert.deepEqual(order, ['early', 'new', 'late']);
  });

  it('keepAssigned: moving a chapter’s dates moves its items; a title change or a cue edit moves nothing', () => {
    const p = reassign(trip([lisbon, sintra], [item('a', '2026-05-04T10:00:00')]));
    assert.equal(p.media[0].chapterId, 'sintra');
    const renamed = keepAssigned(p, updateChapter(p, 'sintra', { title: 'Sintra!' }));
    assert.equal(renamed.media, p.media, 'no reassignment work for a rename');
    const longer = keepAssigned(p, updateChapter(p, 'lisbon', { end: '2026-05-04T12:00' }));
    assert.equal(longer.media[0].chapterId, 'lisbon', 'earlier chapter now covers it (overlap)');
    const offset = keepAssigned(p, { ...p, sources: p.sources.map((s) => ({ ...s, clockOffsetSec: -86_400 })) });
    assert.equal(offset.media[0].chapterId, 'lisbon', 'a camera a day fast: its items move back a chapter');
    const userTime = keepAssigned(p, { ...p, media: p.media.map((m) => ({ ...m, userTimestamp: '2026-05-01T08:00:00' })) });
    assert.equal(userTime.media[0].chapterId, 'lisbon');
  });

  it('reassigns 500 items across 50 chapters well within the 1-second target', () => {
    const chapters = Array.from({ length: 50 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 4, 1 + i)).toISOString().slice(0, 10);
      return ch(`c${i}`, `${d}T00:00`, `${d}T23:59`, i % 2 ? 'Europe/Lisbon' : 'Asia/Kathmandu');
    });
    const media = Array.from({ length: 500 }, (_, i) => item(`m${i}`, `${new Date(Date.UTC(2026, 4, 1 + (i % 50), 12)).toISOString().slice(0, 19)}${i % 3 ? '' : 'Z'}`));
    const p = trip(chapters, media);
    const t0 = performance.now();
    const q = reassign(p);
    const ms = performance.now() - t0;
    assert.ok(q.media.every((m) => m.chapterId), 'all placed');
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
    const t1 = performance.now();
    keepAssigned(q, { ...q, sources: q.sources.map((s) => ({ ...s, clockOffsetSec: 3600 })) });
    assert.ok(performance.now() - t1 < 1000, 'a clock offset change reassigns in under a second');
  });

  it('placementFor reports where one item goes without changing anything', () => {
    const p = trip([lisbon, sintra], [item('a', '2026-05-04T10:00:00')]);
    assert.deepEqual(placementFor(p, p.media[0]), { chapterId: 'sintra', overlap: false });
    assert.equal(placementFor(p, item('none')), undefined);
  });
});

describe('capture metadata (MM-2, MM-9)', () => {
  it('reads EXIF capture time, with or without the camera’s UTC offset, and GPS', () => {
    assert.deepEqual(metaFromTiff(exifTiff('2026:05:03 14:22:10', 1)), { capturedAt: '2026-05-03T14:22:10' });
    const full = metaFromTiff(exifTiff('2026:05:03 14:22:10', 1, { offset: '+01:00', gps: { lat: 38.7139, lng: -9.1394 } }));
    assert.equal(full.capturedAt, '2026-05-03T14:22:10+01:00');
    assert.ok(Math.abs(full.location!.lat - 38.7139) < 1e-4 && Math.abs(full.location!.lng + 9.1394) < 1e-4, JSON.stringify(full.location));
    assert.deepEqual(metaFromTiff(exifTiff('0000:00:00 00:00:00', 1)), {}, 'blank camera dates are ignored');
  });

  it('reads QuickTime/MP4 tags: Apple local time with offset first, then UTC creation_time, and ISO 6709 location', () => {
    assert.deepEqual(metaFromTags({ creation_time: '2026-05-03T13:22:10.000000Z', 'com.apple.quicktime.creationdate': '2026-05-03T14:22:10+0100', 'com.apple.quicktime.location.ISO6709': '+38.7139-009.1394+012.345/' }),
      { capturedAt: '2026-05-03T14:22:10+01:00', location: { lat: 38.7139, lng: -9.1394 } });
    assert.deepEqual(metaFromTags({ creation_time: '2026-05-03T13:22:10.000000Z' }), { capturedAt: '2026-05-03T13:22:10Z' });
    assert.deepEqual(metaFromTags({ creation_time: '1970-01-01T00:00:00.000000Z' }), {}, 'encoder epochs are not capture times');
    assert.equal(parseIso6709('+00.0000+000.0000/'), undefined, 'null island is "no location"');
  });

  it('reads the Exif item of a HEIC directly', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tl-meta-'));
    try {
      const f = path.join(dir, 'x.heic');
      await writeHeic(f, { capturedAt: '2026:05:04 09:00:00' });
      assert.deepEqual(await photoMeta(f, true), { capturedAt: '2026-05-04T09:00:00' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('fixing times (MM-4, MM-5, MM-8)', () => {
  const lisbon = ch('lisbon', '2026-05-01T00:00', '2026-05-03T23:59');
  const sintra = ch('sintra', '2026-05-04T08:00', '2026-05-04T23:59');
  const base = () => reassign(trip([lisbon, sintra], [
    item('a', '2026-05-02T10:00:00'), item('b', '2026-05-02T10:05:00'), item('c', '2026-05-04T12:00:00'), item('u'),
  ]));

  it('sets one time for several items and keeps their spacing; clearing goes back to the camera time', () => {
    const p = base();
    const at = Date.parse('2026-05-04T09:00:00Z');
    const q = keepAssigned(p, setUserTime(p, ['a', 'b'], at));
    assert.deepEqual(q.media.filter((m) => m.id === 'a' || m.id === 'b').map((m) => m.userTimestamp), ['2026-05-04T09:00:00Z', '2026-05-04T09:05:00Z']);
    assert.deepEqual(q.media.filter((m) => m.id === 'a' || m.id === 'b').map((m) => m.chapterId), ['sintra', 'sintra']);
    const back = keepAssigned(q, setUserTime(q, ['a', 'b'], null));
    assert.deepEqual(back.media.slice(0, 2).map((m) => [m.userTimestamp, m.chapterId]), [[undefined, 'lisbon'], [undefined, 'lisbon']]);
  });

  it('shifts times by a fixed amount, leaving untimed items alone', () => {
    const p = base();
    const q = keepAssigned(p, shiftUserTime(p, ['c', 'u'], -2 * 86_400_000));
    assert.equal(q.media.find((m) => m.id === 'c')!.chapterId, 'lisbon');
    assert.equal(q.media.find((m) => m.id === 'u')!.userTimestamp, undefined);
  });

  it('previews a clock offset without changing anything, then applies it', () => {
    const p = base();
    const pv = previewClockOffset(p, 'src', 2 * 86_400);
    assert.deepEqual(pv.moves.map((m) => [m.id, m.from, m.to]), [['a', 'lisbon', 'sintra'], ['b', 'lisbon', 'sintra'], ['c', 'sintra', null]]);
    assert.equal(p.sources[0].clockOffsetSec, 0, 'preview leaves the project alone');
    const q = keepAssigned(p, setClockOffset(p, 'src', 2 * 86_400));
    assert.deepEqual(q.media.map((m) => m.chapterId), ['sintra', 'sintra', null, null]);
  });

  it('dropping onto a chapter keeps the time of day on its first day; dropping onto an item lands just before it', () => {
    const p = base();
    const onChapter = dropIntoChapter(p, ['a'], 'sintra');
    const a = onChapter.media.find((m) => m.id === 'a')!;
    assert.equal(a.chapterId, 'sintra');
    assert.equal(a.userTimestamp, '2026-05-04T09:00:00Z', '10:00 Lisbon time on Sintra’s first day');
    const untimed = dropIntoChapter(p, ['u'], 'lisbon', 'b');
    const u = untimed.media.find((m) => m.id === 'u')!;
    assert.equal(u.chapterId, 'lisbon');
    const tu = itemInstant(untimed, u), ta = itemInstant(untimed, untimed.media[0]), tb = itemInstant(untimed, untimed.media[1]);
    assert.ok(ta < tu && tu < tb, 'between a and b');
    const order = untimed.cues.filter((c) => ['a', 'b', 'u'].includes(c.itemId)).sort((x, y) => (x.order < y.order ? -1 : 1)).map((c) => c.itemId);
    assert.deepEqual(order, ['a', 'u', 'b']);
    const early = dropIntoChapter(p, ['u'], 'sintra');
    assert.equal(early.media.find((m) => m.id === 'u')!.userTimestamp, '2026-05-04T11:00:00Z', 'noon when it had no time');
  });

  it('flags duplicates by content, and by time and size across sources only', () => {
    const p = base();
    const media: MediaItem[] = [
      item('x1', '2026-05-02T10:00:00', { contentHash: 'h1', sourceId: 's1' }), item('x2', '2026-05-03T10:00:00', { contentHash: 'h1', sourceId: 's1' }),
      item('y1', '2026-05-02T11:00:00', { width: 4000, height: 3000, sourceId: 's1' }), item('y2', '2026-05-02T11:00:00', { width: 4000, height: 3000, sourceId: 's2' }),
      item('burst1', '2026-05-02T12:00:00', { width: 4000, height: 3000, sourceId: 's1' }), item('burst2', '2026-05-02T12:00:00', { width: 4000, height: 3000, sourceId: 's1' }),
    ];
    const g = duplicateGroups({ ...p, media });
    assert.deepEqual([...g.keys()].sort(), ['x1', 'x2', 'y1', 'y2']);
    assert.notEqual(g.get('x1'), g.get('y1'));
  });

  it('names cameras without repeating the make', () => {
    assert.equal(cameraName('Canon', 'Canon EOS R6'), 'Canon EOS R6');
    assert.equal(cameraName('Apple', 'iPhone 15 Pro'), 'Apple iPhone 15 Pro');
    assert.equal(cameraName('  ', undefined), undefined);
    assert.equal(cameraName('NIKON CORPORATION', 'NIKON Z 6_2'), 'NIKON Z 6_2');
  });
});
