import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  analyzeItinerary, appendDrafts, buildTimeline, chapterSpan, describeIssue, diff, applyOps, insertChapter, localToUtc, mergeChapters,
  moveChapter, newChapter, parseDateTime, parseItinerary, parseProject, removeChapter, sortChapters, splitChapter, updateChapter, utcToLocal,
  validate, type Travelogue,
} from '../src/core/index.js';

const SAMPLE = new URL('../samples/hand-written-20/trip.travelogue.json', import.meta.url);
const sample = (): Travelogue => parseProject(readFileSync(SAMPLE, 'utf8')).project;
const errors = (p: Travelogue) => validate(p).filter((i) => i.level === 'error');

describe('time zones', () => {
  it('reads local times in the chapter zone', () => {
    assert.equal(new Date(localToUtc('2026-05-01T09:00', 'Europe/Lisbon')).toISOString(), '2026-05-01T08:00:00.000Z');
    assert.equal(new Date(localToUtc('2026-05-01T09:00', 'Asia/Tokyo')).toISOString(), '2026-05-01T00:00:00.000Z');
    assert.equal(new Date(localToUtc('2026-05-01', 'UTC', true)).toISOString(), '2026-05-01T23:59:59.000Z');
    assert.ok(Number.isNaN(localToUtc('May 1', 'UTC')));
  });

  it('handles daylight-saving changes like a calendar', () => {
    assert.equal(new Date(localToUtc('2026-03-08T02:30', 'America/New_York')).toISOString(), '2026-03-08T07:30:00.000Z', 'skipped hour moves forward');
    assert.equal(new Date(localToUtc('2026-11-01T01:30', 'America/New_York')).toISOString(), '2026-11-01T05:30:00.000Z', 'repeated hour means the first one');
    assert.equal(utcToLocal(localToUtc('2026-07-04T18:45', 'America/Chicago'), 'America/Chicago'), '2026-07-04T18:45');
  });

  it('rejects unknown zones in validation', () => {
    const p = sample();
    assert.deepEqual(errors(p), []);
    assert.match(errors(updateChapter(p, 'ch-lisbon', { timeZone: 'Mars/Olympus' })).map((e) => e.message).join(), /unknown time zone/);
  });
});

describe('itinerary checks (IT-3)', () => {
  it('finds nothing wrong with back-to-back chapters', () => {
    assert.deepEqual(analyzeItinerary(sample()), [], 'end 23:59, next starts 00:00');
    const p = updateChapter(updateChapter(sample(), 'ch-lisbon', { end: '2026-05-04T10:00' }), 'ch-sintra', { start: '2026-05-04T10:00' });
    assert.deepEqual(analyzeItinerary(p), [], 'one ends exactly when the next starts');
  });

  it('flags overlaps, gaps and out-of-order chapters with readable text', () => {
    let p = updateChapter(sample(), 'ch-sintra', { start: '2026-05-03T18:00' });
    p = updateChapter(p, 'ch-douro', { start: '2026-05-09T00:00' });
    const issues = analyzeItinerary(p);
    assert.deepEqual(issues.map((i) => i.kind).sort(), ['gap', 'overlap']);
    const text = issues.map((i) => describeIssue(i, p)).join(' | ');
    assert.match(text, /1\. Lisbon and 2\. Sintra overlap by 6 hours/);
    assert.match(text, /Gap of 1 days between 3\. Porto and 4\. Douro Valley/);
    const swapped = moveChapter(sample(), 'ch-douro', 0);
    assert.ok(analyzeItinerary(swapped).some((i) => i.kind === 'outOfOrder'));
    assert.deepEqual(analyzeItinerary(sortChapters(swapped)), []);
  });

  it('compares across time zones', () => {
    // Lisbon ends 23:59 local = 22:59 UTC; a Madrid chapter starting 00:00 local (22:00 UTC) overlaps by 59 minutes.
    const p = updateChapter(sample(), 'ch-sintra', { timeZone: 'Europe/Madrid' });
    const o = analyzeItinerary(p).find((i) => i.kind === 'overlap');
    assert.ok(o && o.kind === 'overlap' && o.minutes === 59);
  });

  it('reports chapters that end before they start', () => {
    const p = updateChapter(sample(), 'ch-porto', { end: '2026-05-01T00:00' });
    assert.ok(analyzeItinerary(p).some((i) => i.kind === 'invalid'));
  });
});

describe('chapter edits (IT-1, IT-7)', () => {
  it('adds a chapter on the day after the last, in the same zone', () => {
    const p = sample();
    const c = newChapter(p, { title: 'Évora' });
    assert.equal(c.start, '2026-05-11T00:00');
    assert.equal(c.end, '2026-05-11T23:59');
    assert.equal(c.timeZone, 'Europe/Lisbon');
    const q = insertChapter(p, c);
    assert.equal(q.chapters.length, 5);
    assert.deepEqual(errors(q), []);
  });

  it('deleting a chapter moves its media to Unassigned, nothing lost', () => {
    const p = removeChapter(sample(), 'ch-sintra');
    assert.equal(p.chapters.length, 3);
    assert.equal(p.media.filter((m) => m.chapterId === null).length, 5);
    assert.deepEqual(errors(p), []);
  });

  it('splits a chapter at a time and moves later media to the new part', () => {
    const { project: p, newId } = splitChapter(sample(), 'ch-lisbon', '2026-05-02T12:00');
    assert.equal(p.chapters.length, 5);
    const [first, second] = p.chapters;
    assert.equal(first.end, '2026-05-02T12:00');
    assert.equal(second.id, newId);
    assert.equal(second.start, '2026-05-02T12:00');
    assert.equal(second.title, 'Lisbon (2)');
    assert.deepEqual(p.media.filter((m) => m.chapterId === newId).map((m) => m.id).sort(), ['m04', 'm05']);
    assert.deepEqual(analyzeItinerary(p), []);
    assert.deepEqual(errors(p), []);
    assert.throws(() => splitChapter(sample(), 'ch-lisbon', '2026-06-01T00:00'), /inside the chapter/);
  });

  it('merges two chapters, keeping the first chapter\'s media first', () => {
    const p = mergeChapters(sample(), 'ch-porto', 'ch-douro');
    assert.equal(p.chapters.length, 3);
    const porto = p.chapters[2];
    assert.equal(porto.start, '2026-05-05T00:00');
    assert.equal(porto.end, '2026-05-10T23:59');
    assert.match(porto.description, /bookshops[\s\S]*Terraced/);
    const ids = buildTimeline(p).segments.filter((s) => s.chapterId === 'ch-porto' && s.kind !== 'title').map((s) => (s.kind !== 'title' ? s.item.id : ''));
    assert.deepEqual(ids, ['m11', 'm12', 'm13', 'm15', 'm16', 'm20', 'm17', 'm18', 'm19']);
    assert.deepEqual(errors(p), []);
  });

  it('every chapter edit round-trips through operations', () => {
    const a = sample();
    const steps = [
      (p: Travelogue) => updateChapter(p, 'ch-lisbon', { title: 'Lisboa', coordinates: { lat: 38.7, lng: -9.1 } }),
      (p: Travelogue) => moveChapter(p, 'ch-douro', 1),
      (p: Travelogue) => splitChapter(p, 'ch-porto', '2026-05-06T00:00').project,
      (p: Travelogue) => removeChapter(p, 'ch-sintra'),
    ];
    let cur = a;
    for (const s of steps) {
      const next = s(cur);
      assert.deepEqual(applyOps(cur, diff(cur, next)), next);
      cur = next;
    }
  });
});

describe('text and CSV import (IT-6)', () => {
  it('reads a CSV with a header in any column order, and folds consecutive days', () => {
    const r = parseItinerary('Notes,Date,Location,Time zone\n"Arrive, explore Alfama",2026-05-01,"Lisbon, Portugal",Europe/Lisbon\nBelém,2026-05-02,"Lisbon, Portugal",Europe/Lisbon\nPalaces,2026-05-04,Sintra,Europe/Lisbon\n', 'UTC');
    assert.deepEqual(r.errors, []);
    assert.equal(r.merged, 1);
    assert.deepEqual(r.chapters.map((c) => [c.title, c.locationName, c.start, c.end, c.timeZone]), [
      ['Lisbon', 'Lisbon, Portugal', '2026-05-01T00:00', '2026-05-02T23:59', 'Europe/Lisbon'],
      ['Sintra', 'Sintra', '2026-05-04T00:00', '2026-05-04T23:59', 'Europe/Lisbon'],
    ]);
    assert.equal(r.chapters[0].description, 'Arrive, explore Alfama; Belém');
  });

  it('reads plain lines in the common shapes people paste', () => {
    const r = parseItinerary([
      'May 1, 2026, Lisbon, arrive and explore Alfama',
      'Sun, May 3, Sintra, palaces',
      '2026-05-05 to 2026-05-07  Porto — bookshops and port lodges',
      'May 8-10, 2026 Pinhão - Douro valley',
      '# a comment',
      '',
      '5/11/2026, Évora',
      'Dec 30 – Jan 2, 2027 Madeira',
    ].join('\n'), 'Europe/Lisbon');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.chapters.map((c) => `${c.start.slice(0, 10)}..${c.end.slice(0, 10)} ${c.locationName}`), [
      '2026-05-01..2026-05-01 Lisbon', '2026-05-03..2026-05-03 Sintra', '2026-05-05..2026-05-07 Porto',
      '2026-05-08..2026-05-10 Pinhão', '2026-05-11..2026-05-11 Évora', '2026-12-30..2027-01-02 Madeira',
    ]);
    assert.equal(r.chapters[2].description, 'bookshops and port lodges');
  });

  it('keeps times when given and explains lines it cannot read', () => {
    const r = parseItinerary('Start,End,City\n2026-05-01 14:30,2026-05-01 9:15 pm,Lisbon\nnot a date,,Porto\n2026-05-02,,\n', 'UTC');
    assert.equal(r.chapters[0].start, '2026-05-01T14:30');
    assert.equal(r.chapters[0].end, '2026-05-01T21:15');
    assert.deepEqual(r.errors.map((e) => e.line), [3, 4]);
    assert.match(r.errors[0].message, /Could not read a date/);
    assert.match(r.errors[1].message, /No place/);
  });

  it('parses dates strictly', () => {
    assert.equal(parseDateTime('2026-02-30'), undefined);
    assert.equal(parseDateTime('13/1/2026'), undefined);
    assert.deepEqual(parseDateTime('1st May 2026'), { date: '2026-05-01', time: undefined });
    assert.deepEqual(parseDateTime('May 2', 2026), { date: '2026-05-02', time: undefined });
  });

  it('appends drafts as valid chapters', () => {
    const p = appendDrafts(sample(), parseItinerary('2026-05-11, Évora\n2026-05-12, Lisbon airport', 'Europe/Lisbon').chapters);
    assert.equal(p.chapters.length, 6);
    assert.deepEqual(errors(p), []);
    assert.deepEqual(analyzeItinerary(p), []);
    assert.ok(chapterSpan(p.chapters[5]).end > chapterSpan(p.chapters[4]).end);
  });
});
