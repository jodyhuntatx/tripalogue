/**
 * Phase 5 model: entrances and exits, Ken Burns, crossfades, speed and mute, annotations, title cards, credits,
 * copy/paste and presets, the map model, and the audio additions (ducking, loop, crossfade, fit).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addAnnotation, applyPreset, autoKenBurns, buildTimeline, cueStyleOf, fitAudioToChapter, fitVisualsToNarration, frameAt, insetRect,
  kenBurnsCrop, mapAt, mixAt, moveBox, parseProject, pasteCueStyle, placeAudio, removeAnnotation, savePreset, setAudioCue, setChapterOverride,
  setItemMapInset, setLaneDuck, setMotion, setMute, setSpeed, setTitleCard, setTransition, tilesFor, updateAnnotation, validate, ZOOM_FROM,
  type MediaItem, type PictureLayer, type TextLayer, type TitleLayer, type MapLayer, type Travelogue, setVideoTrim,
} from '../src/core/index.js';

const sample = (): Travelogue => parseProject(readFileSync('samples/hand-written-20/trip.travelogue.json', 'utf8')).project;
const FRAME = { w: 1920, h: 1080 };
const seg = (p: Travelogue, id: string) => buildTimeline(p).segments.find((s) => s.kind !== 'title' && s.item.id === id)!;
const pics = (p: Travelogue, t: number) => frameAt(buildTimeline(p), t, FRAME, undefined, p).layers.filter((l): l is PictureLayer => l.kind === 'image' || l.kind === 'video');
const ok = (p: Travelogue) => assert.deepEqual(validate(p).filter((i) => i.level === 'error'), []);

describe('entrances and exits (PE-10, PE-12)', () => {
  it('slides in from a side and out to another, keeping full opacity', () => {
    let p = setTransition(sample(), ['m02'], 'entrance', { type: 'slide', durationSec: 1, direction: 'left' });
    p = setTransition(p, ['m02'], 'exit', { type: 'slide', durationSec: 1, direction: 'up' });
    ok(p);
    const s = seg(p, 'm02');
    const rest = pics(p, s.start + 2)[0];
    const early = pics(p, s.start + 0.1)[0];
    assert.equal(early.opacity, 1);
    assert.ok(early.dst.x < rest.dst.x - 500, 'starts off to the left');
    const late = pics(p, s.start + s.duration - 0.2)[0];
    assert.ok(late.dst.y < rest.dst.y - 100 && late.dst.x === rest.dst.x, 'leaves upwards');
    assert.equal(setTransition(p, ['m02'], 'exit', { type: 'zoom', durationSec: 1 }), p, 'exits cannot zoom');
  });

  it('zooms in, growing from 60% about its centre while fading in', () => {
    const p = setTransition(sample(), ['m02'], 'entrance', { type: 'zoom', durationSec: 1 });
    const s = seg(p, 'm02');
    const a = pics(p, s.start)[0];
    const b = pics(p, s.start + 2)[0];
    assert.ok(Math.abs(a.dst.w / b.dst.w - ZOOM_FROM) < 1e-6);
    assert.ok(Math.abs(a.dst.x + a.dst.w / 2 - (b.dst.x + b.dst.w / 2)) < 1e-6);
    assert.equal(a.opacity, 0);
    assert.deepEqual(moveBox(b.dst, 0, 4, { type: 'cut', durationSec: 0 }, { type: 'cut', durationSec: 0 }, FRAME), b.dst);
  });
});

describe('Ken Burns (PE-11)', () => {
  it('moves the view from start to end, keeping the box\'s shape', () => {
    const r = kenBurnsCrop({ x: 0, y: 0, w: 1, h: 1 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 0.5, { w: 4000, h: 3000 }, { w: 1920, h: 1080 });
    assert.ok(Math.abs(r.w / r.h - 1920 / 1080) < 1e-9, 'shaped like the frame');
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 4000 && r.y + r.h <= 3000);
  });

  it('auto picks the same gentle motion for an item every time; custom keeps the rects; none clears it', () => {
    assert.deepEqual(autoKenBurns('m02'), autoKenBurns('m02'));
    let p = setMotion(sample(), ['m02', 'm05'], 'auto');
    ok(p);
    const c = p.cues.find((x) => x.itemId === 'm02')!;
    assert.equal(c.animation.type, 'kenBurns');
    const s = seg(p, 'm02');
    const a = pics(p, s.start + 0.01)[0], b = pics(p, s.start + s.duration - 0.01)[0];
    assert.notDeepEqual(a.src, b.src, 'the view moves');
    p = setMotion(p, ['m02'], { from: { x: -0.2, y: 0, w: 2, h: 1 }, to: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
    const anim = p.cues.find((x) => x.itemId === 'm02')!.animation;
    assert.ok(anim.type === 'kenBurns' && anim.from.x === 0 && anim.from.w === 1, 'kept inside the picture');
    assert.equal(setMotion(p, ['m02'], 'none').cues.find((x) => x.itemId === 'm02')!.animation.type, 'none');
    assert.equal(setMotion(sample(), ['m15'], 'auto').cues.find((x) => x.itemId === 'm15')!.animation.type, 'none', 'stills only');
  });
});

describe('crossfade (PE-16)', () => {
  it('overlaps the item before: the timeline shortens and both draw during the overlap', () => {
    const before = buildTimeline(sample());
    const p = setTransition(sample(), ['m03'], 'entrance', { type: 'crossfade', durationSec: 1 });
    const tl = buildTimeline(p);
    assert.ok(Math.abs(before.duration - tl.duration - 1) < 1e-9);
    const s = seg(p, 'm03');
    assert.equal(s.kind !== 'title' && s.overlapSec, 1);
    const mid = pics(p, s.start + 0.5);
    assert.deepEqual(mid.map((l) => l.itemId), ['m02', 'm03'], 'the one before underneath');
    assert.equal(mid[0].opacity, 1);
    assert.ok(Math.abs(mid[1].opacity - 0.5) < 1e-9);
    assert.deepEqual(pics(p, s.start + 1.5).map((l) => l.itemId), ['m03']);
  });
});

describe('speed and mute (PE-13)', () => {
  it('sets speed between 0.25x and 4x; the clip\'s length follows; mute silences its sound', () => {
    let p = setSpeed(sample(), ['m15'], 10);
    assert.equal(p.cues.find((c) => c.itemId === 'm15')!.speed, 4);
    p = setSpeed(p, ['m15'], 0.5);
    const full = seg(sample(), 'm15').duration;
    assert.ok(Math.abs(seg(p, 'm15').duration - full * 2) < 1e-9);
    const s = seg(p, 'm15');
    const tl = buildTimeline(p);
    const loud = mixAt(tl, p.audioLanes, s.start + 1).find((v) => v.itemId === 'm15')!.gain;
    assert.ok(loud > 0);
    p = setMute(p, ['m15'], true);
    assert.equal(mixAt(buildTimeline(p), p.audioLanes, s.start + 1).find((v) => v.itemId === 'm15')!.gain, 0);
    p = setMute(p, ['m15'], false);
    assert.equal(p.cues.find((c) => c.itemId === 'm15')!.mute, undefined);
    ok(p);
  });
});

describe('annotations (PE-14)', () => {
  it('adds a caption, a place and a date; they show in their window and fade', () => {
    let p = addAnnotation(sample(), 'm02', 'caption', 'an1', 'Tram 28');
    p = addAnnotation(p, 'm02', 'place', 'an2');
    p = addAnnotation(p, 'm02', 'date', 'an3');
    ok(p);
    const s = seg(p, 'm02');
    const texts = (t: number) => frameAt(buildTimeline(p), t, FRAME, undefined, p).layers.filter((l): l is TextLayer => l.kind === 'text');
    const mid = texts(s.start + 2);
    assert.deepEqual(mid.map((l) => l.text).slice(0, 2), ['Tram 28', p.chapters[0].locationName]);
    assert.match(mid[2].text, /2026/, 'a date');
    assert.ok(mid.every((l) => l.opacity > 0.99));
    p = updateAnnotation(p, 'an1', { startSec: 1, durationSec: 1, position: { x: 0.9, y: 0.95, w: 0.5, h: 0.1 } });
    const a = p.annotations.find((x) => x.id === 'an1')!;
    assert.ok(a.position.x + a.position.w <= 1 && a.position.y + a.position.h <= 1, 'kept on the stage');
    assert.equal(texts(s.start + 0.5).some((l) => l.text === 'Tram 28'), false);
    assert.equal(texts(s.start + 1.5).some((l) => l.text === 'Tram 28'), true);
    assert.equal(texts(s.start + 2.5).some((l) => l.text === 'Tram 28'), false);
    p = removeAnnotation(p, 'an1');
    assert.equal(p.annotations.length, 2);
  });
});

describe('title cards (PE-15) and credits (PE-18)', () => {
  it('edits a card\'s text and layout and puts a picture behind it; empty text goes back to the chapter\'s', () => {
    let p = setTitleCard(sample(), 'ch-lisbon', { title: 'Lisboa!', subtitle: 'Day one', layout: 'lower', backgroundItemId: 'm02' });
    ok(p);
    const t = frameAt(buildTimeline(p), 1.5, FRAME, undefined, p).layers.find((l): l is TitleLayer => l.kind === 'title')!;
    assert.deepEqual([t.title, t.subtitle, t.layout, t.background?.itemId], ['Lisboa!', 'Day one', 'lower', 'm02']);
    p = setTitleCard(p, 'ch-lisbon', { title: '', layout: 'center' });
    assert.equal(p.chapters[0].titleCard.title, undefined);
    assert.equal(p.chapters[0].titleCard.layout, undefined);
  });

  it('credits a traveler\'s photo when credits are on, per travelogue or chapter', () => {
    let p = sample();
    p = { ...p, travelers: [{ id: 't-ana', name: 'Ana' }], sources: p.sources.map((s) => ({ ...s, contributorId: 't-ana' })) };
    const credit = (q: Travelogue) => frameAt(buildTimeline(q), seg(q, 'm02').start + 2, FRAME, undefined, q).layers.find((l): l is TextLayer => l.kind === 'text' && l.style === 'credit');
    assert.equal(credit(p), undefined, 'off by default');
    assert.equal(credit({ ...p, credits: true })?.text, 'Photo: Ana');
    assert.equal(credit(setChapterOverride({ ...p, credits: true }, 'ch-lisbon', 'credits', 'off')), undefined);
    assert.equal(credit(setChapterOverride(p, 'ch-lisbon', 'credits', 'on'))?.text, 'Photo: Ana');
  });
});

describe('copy, paste and presets (PE-17)', () => {
  it('pastes what fits each kind; a preset applies the same way', () => {
    let p = setTransition(sample(), ['m02'], 'entrance', { type: 'slide', durationSec: 0.8 });
    p = setMotion(p, ['m02'], 'auto');
    const style = cueStyleOf(p.cues.find((c) => c.itemId === 'm02')!);
    p = pasteCueStyle(p, ['m03', 'm15'], style);
    const c5 = p.cues.find((c) => c.itemId === 'm03')!, c15 = p.cues.find((c) => c.itemId === 'm15')!;
    assert.equal(c5.entrance.type, 'slide');
    assert.ok(c5.animation.type === 'kenBurns' && c5.animation.auto);
    assert.deepEqual(c5.animation, { type: 'kenBurns', ...autoKenBurns('m03'), auto: true }, 'auto motion chosen afresh');
    assert.equal(c15.entrance.type, 'slide');
    assert.equal(c15.animation.type, 'none', 'videos do not take motion');
    p = savePreset(p, 'pr1', 'Slide in', style);
    p = applyPreset(p, ['m06'], 'pr1');
    assert.equal(p.cues.find((c) => c.itemId === 'm06')!.entrance.type, 'slide');
    ok(p);
  });
});

describe('the map (MV-3 to MV-7)', () => {
  it('shows the trip on a title card, travels and zooms in, then frames the chapter with a trail', () => {
    const p = sample();
    const tl = buildTimeline(p);
    const ch2 = tl.chapters[1];
    const at = (t: number) => mapAt(p, tl, t, FRAME)!;
    const opening = at(ch2.start + 0.2);
    assert.equal(opening.state.view, 'travel');
    assert.equal(opening.state.label, 'Chapter 2 of 4');
    assert.deepEqual(opening.state.pins.map((x) => x.state), ['visited', 'current', 'ahead', 'ahead']);
    assert.ok(opening.state.travel && opening.state.travel.f > 0 && opening.state.travel.f < 1);
    const zoomed = at(ch2.start + 2.95);
    const inChapter = at(tl.segments.find((s) => s.chapterIndex === 1 && s.kind !== 'title')!.start + 2);
    assert.equal(inChapter.state.view, 'chapter');
    assert.ok(inChapter.state.camera.zoom > opening.state.camera.zoom, 'zoomed in on the chapter');
    assert.ok(Math.abs(zoomed.state.camera.zoom - inChapter.state.camera.zoom) < 0.2, 'arrives by the end of the transition');
    assert.ok(inChapter.state.marker && inChapter.state.dots.some((d) => d.state === 'current'));
    const r = insetRect(p.mapView, FRAME);
    assert.deepEqual([r.w, r.h, r.x + r.w, r.y + r.h], [384, 288, 1920 - 32, 1080 - 32], 'a fifth of the width, 4:3, bottom right');
    assert.ok(tilesFor(inChapter.state.camera, r).length >= 2);
  });

  it('turns off per travelogue, chapter or item; a chapter without a place hides it; full-frame transitions add time', () => {
    const p = sample();
    const tl = buildTimeline(p);
    const t = tl.segments.find((s) => s.kind !== 'title' && s.chapterIndex === 0)!.start + 1;
    assert.ok(mapAt(p, tl, t, FRAME));
    assert.equal(mapAt({ ...p, mapView: { ...p.mapView, enabled: false } }, tl, t, FRAME), undefined);
    const on = setChapterOverride({ ...p, mapView: { ...p.mapView, enabled: false } }, 'ch-lisbon', 'mapInset', 'on');
    assert.ok(mapAt(on, buildTimeline(on), t, FRAME), 'a chapter can turn it on');
    const item = tl.segments.find((s) => s.kind !== 'title' && s.chapterIndex === 0)!;
    const off = setItemMapInset(p, [item.kind === 'title' ? '' : item.item.id], 'off');
    assert.equal(mapAt(off, buildTimeline(off), t, FRAME), undefined, 'an item can turn it off');
    const noPlace = { ...p, chapters: p.chapters.map((c, i) => (i === 0 ? { ...c, coordinates: undefined } : c)) };
    assert.equal(mapAt(noPlace, buildTimeline(noPlace), t, FRAME), undefined);
    const full = { ...p, mapView: { ...p.mapView, transition: { mode: 'fullFrame' as const, durationSec: 2 } } };
    const ftl = buildTimeline(full);
    assert.ok(Math.abs(ftl.duration - tl.duration - 8) < 1e-9, '2 s before each of 4 chapters');
    const m = frameAt(ftl, ftl.chapters[1].start + 1, FRAME, undefined, full).layers.find((l): l is MapLayer => l.kind === 'map')!;
    assert.equal(m.layout.full, true);
    assert.deepEqual(m.layout.rect, { x: 0, y: 0, w: 1920, h: 1080 });
    assert.equal(frameAt(ftl, ftl.chapters[1].start + 1, FRAME, undefined, full).layers.some((l) => l.kind === 'title'), false, 'map first, then the card');
    ok(full);
  });

  it('puts every dot at its chapter\'s place when precise locations are hidden (MV-7 too: no place uses the pin)', () => {
    const p = { ...sample(), mapView: { ...sample().mapView, hidePreciseLocations: true } };
    const tl = buildTimeline(p);
    const s = tl.segments.find((x) => x.kind !== 'title' && x.chapterIndex === 1)!;
    const st = mapAt(p, tl, s.start + 2, FRAME)!.state;
    const pin = p.chapters[1].coordinates!;
    assert.ok(st.dots.filter((d) => d.state !== 'past').every((d) => d.lat === pin.lat && d.lng === pin.lng));
  });
});

describe('audio (AU-6 to AU-9)', () => {
  const withAudio = (): Travelogue => {
    const p = sample();
    const memo: MediaItem = { id: 'a1', sourceId: 'src-camera', uri: 'memo.m4a', kind: 'audio', durationSec: 6, chapterId: null };
    const song: MediaItem = { id: 'a2', sourceId: 'src-camera', uri: 'song.mp3', kind: 'audio', durationSec: 8, chapterId: null };
    const song2: MediaItem = { id: 'a3', sourceId: 'src-camera', uri: 'song2.mp3', kind: 'audio', durationSec: 60, chapterId: null };
    return { ...p, media: [...p.media, memo, song, song2] };
  };

  it('sets how much narration lowers each lane (AU-6)', () => {
    let p = setLaneDuck(withAudio(), 'lane-narration', 'lane-music', -6);
    assert.deepEqual(p.audioLanes[0].ducks.find((d) => d.laneId === 'lane-music'), { laneId: 'lane-music', db: -6 });
    p = setLaneDuck(p, 'lane-narration', 'lane-clip', 0);
    assert.equal(p.audioLanes[0].ducks.some((d) => d.laneId === 'lane-clip'), false);
  });

  it('loops a short song to fill its chapter, or trims a long one, with a fade at the end (AU-8)', () => {
    let p = withAudio();
    const lisbon = buildTimeline(p).chapters[0];
    p = placeAudio(p, 'a2', 'lane-music', lisbon.start);
    p = fitAudioToChapter(p, 'a2');
    const c = buildTimeline(p).audio.find((x) => x.item.id === 'a2')!;
    assert.equal(c.loopSec, 8);
    assert.ok(Math.abs(c.start + c.duration - lisbon.end) < 1e-9);
    const tl = buildTimeline(p);
    const v = mixAt(tl, p.audioLanes, lisbon.start + 9).find((x) => x.itemId === 'a2')!;
    assert.ok(Math.abs(v.mediaTimeSec - 1) < 1e-9, 'round again after 8 s');
    let q = placeAudio(withAudio(), 'a3', 'lane-music', lisbon.start);
    q = fitAudioToChapter(q, 'a3');
    const c3 = buildTimeline(q).audio.find((x) => x.item.id === 'a3')!;
    assert.ok(Math.abs(c3.start + c3.duration - lisbon.end) < 1e-6 && c3.cutSec < 1e-6 && !c3.loopSec);
    assert.ok(c3.fadeOutSec >= 2);
    ok(q);
  });

  it('crossfades two music clips: the first runs on under the second\'s fade-in (AU-7)', () => {
    let p = withAudio();
    const lisbon = buildTimeline(p).chapters[0];
    p = placeAudio(p, 'a3', 'lane-music', lisbon.start);
    p = placeAudio(p, 'a2', 'lane-music', lisbon.start + 10);
    p = setAudioCue(p, 'a2', { crossfade: true, fadeInSec: 2 });
    const tl = buildTimeline(p);
    const first = tl.audio.find((x) => x.item.id === 'a3')!;
    assert.ok(Math.abs(first.start + first.duration - (lisbon.start + 12)) < 1e-9);
    assert.equal(first.crossfadeOutSec, 2);
    const gains = Object.fromEntries(mixAt(tl, p.audioLanes, lisbon.start + 11).map((v) => [v.itemId, v.gain]));
    assert.ok(gains.a3 > 0 && gains.a2 > 0, 'both heard in the overlap');
  });

  it('stretches the photos under a narration to cover it (AU-9)', () => {
    let p = withAudio();
    const s = seg(p, 'm02');
    p = placeAudio(p, 'a1', 'lane-narration', s.start);
    p = setVideoTrim(p, 'a1', 0, 6);
    p = fitVisualsToNarration(p, 'a1');
    const tl = buildTimeline(p);
    const clip = tl.audio.find((x) => x.item.id === 'a1')!;
    const covered = tl.segments.filter((x) => x.kind !== 'title' && x.start >= clip.start - 1e-9 && x.start < clip.start + clip.duration);
    const end = covered[covered.length - 1].start + covered[covered.length - 1].duration;
    assert.ok(Math.abs(end - (clip.start + clip.duration)) < 0.25, `pictures end at ${end.toFixed(2)}, narration at ${(clip.start + clip.duration).toFixed(2)}`);
  });
});
