import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildTimeline, chapterCues, DUCK_RAMP_SEC, keepAssigned, mixAt, moveAudio, moveClips, parseProject, placeAudio, reassign, resetChapter,
  resetCues, setAudioAnchorKind, setDurations, setIncludedMany, setLane, setPlacements, setTarget, setUserTime, setVideoTrim, setVolumes,
  unplaceAudio, validate, type MediaItem, type Travelogue,
} from '../src/core/index.js';

const sample = (): Travelogue => parseProject(readFileSync('samples/hand-written-20/trip.travelogue.json', 'utf8')).project;
const order = (p: Travelogue, ch: string) => chapterCues(p, ch).map((c) => c.itemId);
const seg = (p: Travelogue, id: string) => buildTimeline(p).segments.find((s) => s.kind !== 'title' && s.item.id === id)!;

/** The sample plus two audio items: a 6 s voice memo and a 60 s song. */
function withAudio(): Travelogue {
  const p = sample();
  const memo: MediaItem = { id: 'a1', sourceId: 'src-camera', uri: 'memo.m4a', kind: 'audio', durationSec: 6, chapterId: 'ch-lisbon', capturedAt: '2026-05-01T12:00:00' };
  const song: MediaItem = { id: 'a2', sourceId: 'src-camera', uri: 'song.mp3', kind: 'audio', durationSec: 60, chapterId: null };
  return { ...p, media: [...p.media, memo, song] };
}

describe('sequence edits (PE-3 to PE-9)', () => {
  it('reorders within a chapter, keeping the moved items together and in order', () => {
    const p = sample();
    const next = moveClips(p, ['m03', 'm01'], 'ch-lisbon', 'm05');
    assert.deepEqual(order(next, 'ch-lisbon'), ['m02', 'm04', 'm01', 'm03', 'm05']);
    assert.deepEqual(order(moveClips(p, ['m02'], 'ch-lisbon', null), 'ch-lisbon'), ['m01', 'm03', 'm04', 'm05', 'm02']);
    assert.equal(validate(next).filter((i) => i.level === 'error').length, 0);
  });

  it('moves across chapters either keeping the item\'s time (held by hand) or giving it a time in the new chapter', () => {
    const p = sample();
    const kept = moveClips(p, ['m02'], 'ch-porto', 'm12', { setTime: false });
    const m = kept.media.find((x) => x.id === 'm02')!;
    assert.equal(m.chapterId, 'ch-porto');
    assert.equal(m.chapterLocked, true);
    assert.equal(m.userTimestamp, undefined);
    assert.deepEqual(order(kept, 'ch-porto').slice(0, 2), ['m11', 'm02']);
    // The rule leaves a held item alone, even when the chapters are re-run...
    assert.equal(reassign(kept).media.find((x) => x.id === 'm02')!.chapterId, 'ch-porto');
    // ...until its time is changed: then the rule places it again.
    const retimed = keepAssigned(kept, setUserTime(kept, ['m02'], Date.parse('2026-05-04T10:00:00Z')));
    const r = retimed.media.find((x) => x.id === 'm02')!;
    assert.equal(r.chapterLocked, undefined);
    assert.equal(r.chapterId, 'ch-sintra');

    const timed = moveClips(p, ['m02'], 'ch-porto', 'm12', { setTime: true });
    const t = timed.media.find((x) => x.id === 'm02')!;
    assert.equal(t.chapterId, 'ch-porto');
    assert.ok(t.userTimestamp && !t.chapterLocked);
    assert.deepEqual(order(timed, 'ch-porto').slice(0, 2), ['m11', 'm02'], 'dropped where the user put it');
  });

  it('excludes and restores, and the timeline follows (PE-4)', () => {
    const p = sample();
    const before = buildTimeline(p).duration;
    const out = setIncludedMany(p, ['m01', 'm02'], false);
    assert.equal(buildTimeline(out).duration, before - 8);
    assert.equal(buildTimeline(setIncludedMany(out, ['m01', 'm02'], true)).duration, before);
  });

  it('sets durations in bulk: images get the length, videos are trimmed to it (PE-5, PE-8)', () => {
    const p = sample();
    const out = setDurations(p, ['m01', 'm03', 'm15'], 2.5);
    assert.equal(seg(out, 'm01').duration, 2.5);
    assert.equal(seg(out, 'm03').duration, 2.5);
    assert.equal(seg(out, 'm15').duration, 2.5);
    assert.equal(setDurations(p, ['m01'], 0.1).cues.find((c) => c.itemId === 'm01')!.durationSec, 0.5);
  });

  it('places items, and resets an item or a whole chapter to the cue profile (PE-6, PE-7)', () => {
    const p = sample();
    const custom = setPlacements(p, ['m02', 'm07'], { mode: 'custom', rect: { x: 0.1, y: 0.2, w: 0.333333, h: 0.6 } });
    assert.deepEqual(custom.cues.find((c) => c.itemId === 'm02')!.placement, { mode: 'custom', rect: { x: 0.1, y: 0.2, w: 0.333, h: 0.6 } });
    const back = resetCues(custom, ['m02']);
    assert.deepEqual(back.cues.find((c) => c.itemId === 'm02')!.placement, { mode: 'fit' });
    assert.equal(back.cues.find((c) => c.itemId === 'm07')!.placement.mode, 'custom');
    // m20 is trimmed and doubled in speed; m19 has cuts: the chapter reset puts all of Douro back to defaults.
    const douro = resetChapter(p, 'ch-douro');
    const m20 = douro.cues.find((c) => c.itemId === 'm20')!;
    assert.deepEqual([m20.inPointSec, m20.outPointSec, m20.speed], [0, undefined, 1]);
    assert.equal(douro.cues.find((c) => c.itemId === 'm19')!.entrance.type, 'fade');
    assert.deepEqual(order(douro, 'ch-douro'), order(p, 'ch-douro'), 'order kept');
  });

  it('keeps a target length (PE-9)', () => {
    const p = setTarget(sample(), 300);
    assert.equal(p.targetSec, 300);
    assert.equal(setTarget(p, null).targetSec, undefined);
    assert.equal(validate(p).filter((i) => i.level === 'error').length, 0);
  });
});

describe('audio lanes (AU-1 to AU-4)', () => {
  it('places narration on the item playing at that moment, and it moves with the item (AU-2)', () => {
    let p = withAudio();
    const at = seg(p, 'm03').start + 1;
    p = placeAudio(p, 'a1', 'lane-narration', at);
    const cue = p.cues.find((c) => c.itemId === 'a1')!;
    assert.deepEqual(cue.audio!.anchor, { type: 'item', itemId: 'm03', offsetSec: 1 });
    assert.equal(validate(p).filter((i) => i.level === 'error').length, 0);
    const clip = () => buildTimeline(p).audio.find((c) => c.item.id === 'a1')!;
    assert.equal(clip().start, at);
    // Reorder and trim: the clip stays exactly on its item.
    p = moveClips(p, ['m03'], 'ch-lisbon', 'm01');
    assert.equal(clip().start, seg(p, 'm03').start + 1);
    p = setDurations(p, ['m01'], 1);
    assert.equal(clip().start, seg(p, 'm03').start + 1);
    // Excluding the anchor item silences the clip (it is listed as skipped).
    const ex = setIncludedMany(p, ['m03'], false);
    assert.equal(buildTimeline(ex).audio.length, 0);
    assert.match(buildTimeline(ex).skipped.find((s) => s.itemId === 'a1')!.reason, /not playing/);
  });

  it('places music at a chapter time, cut at the chapter end, and switches anchor kind in place', () => {
    let p = withAudio();
    const sintra = buildTimeline(p).chapters[1];
    p = placeAudio(p, 'a2', 'lane-music', sintra.start + 2);
    let c = buildTimeline(p).audio.find((x) => x.item.id === 'a2')!;
    assert.deepEqual(p.cues.find((x) => x.itemId === 'a2')!.audio!.anchor, { type: 'chapterTime', chapterId: 'ch-sintra', offsetSec: 2 });
    assert.equal(c.start, sintra.start + 2);
    assert.equal(c.start + c.duration, sintra.end, 'stops at the end of the chapter');
    assert.ok(c.cutSec > 0);
    assert.deepEqual([c.fadeInSec, c.fadeOutSec, c.duck], [1, 1, false]);
    p = setAudioAnchorKind(p, 'a2', 'item');
    c = buildTimeline(p).audio.find((x) => x.item.id === 'a2')!;
    assert.equal(p.cues.find((x) => x.itemId === 'a2')!.audio!.anchor.type, 'item');
    assert.ok(Math.abs(c.start - (sintra.start + 2)) < 1e-6, 'same place after switching');
    p = moveAudio(p, 'a2', sintra.start + 10);
    assert.ok(Math.abs(buildTimeline(p).audio[0].start - (sintra.start + 10)) < 1e-6);
    // Trim the song's in-point; take it off the lane.
    p = setVideoTrim(p, 'a2', 5, 20);
    c = buildTimeline(p).audio[0];
    assert.deepEqual([c.inPointSec, c.duration], [5, 15]);
    assert.equal(buildTimeline(unplaceAudio(p, 'a2')).audio.length, 0);
  });

  it('mixes clip sound, narration and music with lane volumes, mute, solo and ducking', () => {
    let p = withAudio();
    const tl0 = buildTimeline(p);
    const porto = tl0.chapters[2];
    // Music under the whole of Porto, narration over the boat clip (m15, a video).
    p = placeAudio(p, 'a2', 'lane-music', porto.start);
    const boat = seg(p, 'm15');
    p = placeAudio(p, 'a1', 'lane-narration', boat.start + 2);
    const tl = buildTimeline(p);
    const at = (t: number) => Object.fromEntries(mixAt(tl, p.audioLanes, t).map((v) => [v.itemId, v.gain]));
    const before = at(boat.start + 1);
    assert.ok(Math.abs(before.a2 - 0.7) < 1e-9, 'music at its lane volume (70%)');
    assert.ok(Math.abs(before.m15 - 1) < 1e-9, 'clip sound at full volume');
    const during = at(boat.start + 4);
    const duck = 10 ** (-12 / 20);
    assert.ok(Math.abs(during.a2 - 0.7 * duck) < 1e-9, 'music ducked 12 dB under narration');
    assert.ok(Math.abs(during.m15 - duck) < 1e-9, 'clip sound ducked too');
    assert.ok(Math.abs(during.a1 - 1) < 1e-9);
    const ramp = at(boat.start + 2 + DUCK_RAMP_SEC / 2);
    assert.ok(ramp.a2 < 0.7 && ramp.a2 > 0.7 * duck, 'ducking ramps in');
    const v = mixAt(tl, p.audioLanes, boat.start + 4).find((x) => x.itemId === 'a1')!;
    assert.ok(Math.abs(v.mediaTimeSec - 2) < 1e-9, 'narration is 2 s into its file');
    // Mute the narration lane: no ducking, narration silent.
    const muted = setLane(p, 'lane-narration', { mute: true });
    const m = Object.fromEntries(mixAt(buildTimeline(muted), muted.audioLanes, boat.start + 4).map((x) => [x.itemId, x.gain]));
    assert.deepEqual([m.a1, Math.round(m.a2 * 1000) / 1000], [0, 0.7]);
    // Solo music: only music is heard.
    const solo = setLane(p, 'lane-music', { solo: true });
    const s = Object.fromEntries(mixAt(buildTimeline(solo), solo.audioLanes, boat.start + 1).map((x) => [x.itemId, x.gain]));
    assert.deepEqual([s.m15, Math.round(s.a2 * 1000) / 1000], [0, 0.7]);
    // A clip's own volume.
    const quiet = setVolumes(p, ['m15'], 0.5);
    assert.ok(Math.abs(Object.fromEntries(mixAt(buildTimeline(quiet), quiet.audioLanes, boat.start + 1).map((x) => [x.itemId, x.gain])).m15 - 0.5) < 1e-9);
    assert.equal(validate(solo).filter((i) => i.level === 'error').length, 0);
  });

  it('rejects audio cues on visual items and on unknown lanes', () => {
    const p = withAudio();
    const bad = { ...p, cues: p.cues.map((c) => (c.itemId === 'm01' ? { ...c, audio: { laneId: 'nope', anchor: { type: 'chapterTime' as const, chapterId: 'ch-lisbon', offsetSec: 0 }, fadeInSec: 0, fadeOutSec: 0, duck: false } } : c)) };
    const errs = validate(bad).filter((i) => i.level === 'error').map((i) => i.path);
    assert.ok(errs.some((e) => e.endsWith('.audio')) && errs.some((e) => e.endsWith('.audio.laneId')), errs.join(', '));
  });
});
