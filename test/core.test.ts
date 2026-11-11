import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  Autosaver, buildTimeline, createProject, defaultCue, fadeOpacity, frameAt, History, memorySink, migrate,
  MIN_HISTORY_DEPTH, moveItem, parseProject, place, sanitize, segmentIndexAt, serializeProject, setIncluded,
  setTitle, Telemetry, UnsupportedVersionError, updateCue, validate, type Timers, type Travelogue,
} from '../src/core/index.js';

const SAMPLE = new URL('../samples/hand-written-20/trip.travelogue.json', import.meta.url);
const sample = (): Travelogue => parseProject(readFileSync(SAMPLE, 'utf8')).project;
const errors = (v: unknown) => validate(v).filter((i) => i.level === 'error');

describe('project file (F-1)', () => {
  it('a new project is valid and round-trips through text', () => {
    const p = createProject({ title: 'Test', now: new Date('2026-01-01T00:00:00Z') });
    assert.deepEqual(errors(p), []);
    assert.deepEqual(parseProject(serializeProject(p)).project, p);
    assert.equal(p.output.width, 1920);
    assert.equal(createProject({ title: 'x', aspect: '9:16' }).output.height, 1920);
  });

  it('the hand-written sample parses with only the intended warning', () => {
    const { warnings } = parseProject(readFileSync(SAMPLE, 'utf8'));
    assert.deepEqual(warnings.map((w) => w.message), ['media item "m08" has no cue; defaults will be used']);
  });

  it('rejects broken JSON and broken references with a readable message', () => {
    assert.throws(() => parseProject('{nope'), /not valid JSON/);
    const p = sample();
    p.cues[0] = { ...p.cues[0], itemId: 'ghost' };
    assert.throws(() => parseProject(JSON.stringify(p)), /\$\.cues\[0\]\.itemId: must reference an existing media item/);
  });

  it('catches duplicate ids, inverted dates, missing custom rects and stored credentials', () => {
    const p = sample() as unknown as Record<string, any>;
    p.chapters[1].id = p.chapters[0].id;
    p.chapters[2].start = '2026-06-01T00:00';
    p.cues[3].placement = { mode: 'custom' };
    p.sources[0].accessToken = 'abc';
    const msgs = errors(p).map((e) => `${e.path}: ${e.message}`).join('\n');
    assert.match(msgs, /duplicate chapter id/);
    assert.match(msgs, /chapters\[2\]: start is after end/);
    assert.match(msgs, /placement\.rect: must be a rect/);
    assert.match(msgs, /accessToken: credentials must not be stored/);
  });

  it('rejects media paths that climb out of the source root', () => {
    const p = sample();
    p.media[0] = { ...p.media[0], uri: '../../etc/passwd' };
    assert.match(errors(p).map((e) => e.message).join(), /must not contain "\.\."/);
  });

  it('defaultCue follows the cue profile', () => {
    const p = createProject({ title: 't' });
    const img = defaultCue({ id: 'a', sourceId: 's', uri: 'a.jpg', kind: 'image', chapterId: null }, p.cueProfile, "i");
    assert.equal(img.durationSec, 4);
    assert.deepEqual(img.entrance, { type: 'fade', durationSec: 0.5 });
    const vid = defaultCue({ id: 'b', sourceId: 's', uri: 'b.mp4', kind: 'video', durationSec: 40, chapterId: null }, p.cueProfile, "i");
    assert.equal(vid.outPointSec, 15);
  });
});

describe('migrations', () => {
  it('upgrades the v0 draft format to v1 without losing data', () => {
    const v0 = { ...createProject({ title: 'Old' }), items: [] } as Record<string, unknown>;
    delete v0.schemaVersion;
    delete v0.media;
    delete v0.audioLanes;
    delete v0.mapView;
    const { value, fromVersion } = migrate(v0);
    assert.equal(fromVersion, 0);
    assert.deepEqual(errors(value), []);
    assert.equal((value as Travelogue).audioLanes.length, 3);
    assert.equal(parseProject(JSON.stringify(v0)).migratedFrom, 0);
  });

  it('refuses files from a newer version instead of guessing', () => {
    assert.throws(() => migrate({ schemaVersion: 99 }), UnsupportedVersionError);
  });
});

describe('undo and redo (F-2)', () => {
  it('undoes and redoes edits in order', () => {
    const h = new History(sample());
    const original = h.state;
    h.edit('Rename', (p) => setTitle(p, 'Renamed'));
    h.edit('Exclude', (p) => setIncluded(p, 'm01', false));
    assert.equal(h.undoLabel, 'Exclude');
    h.undo();
    assert.equal(h.state.title, 'Renamed');
    assert.equal(h.state.cues.find((c) => c.itemId === 'm01')!.included, true);
    h.undo();
    assert.equal(h.state, original);
    h.redo();
    h.redo();
    assert.equal(h.state.cues.find((c) => c.itemId === 'm01')!.included, false);
    assert.equal(h.canRedo, false);
  });

  it('keeps at least 100 steps and drops the oldest beyond the limit', () => {
    const h = new History(sample(), { limit: 10 });
    assert.equal(h.limit, MIN_HISTORY_DEPTH);
    for (let i = 0; i < 150; i++) h.edit(`step ${i}`, (p) => setTitle(p, `t${i}`));
    assert.equal(h.depth.undo, 100);
    let n = 0;
    while (h.undo()) n++;
    assert.equal(n, 100);
    assert.equal(h.state.title, 't49');
  });

  it('a new edit clears redo; a no-op edit records nothing', () => {
    const h = new History(sample());
    h.edit('a', (p) => setTitle(p, 'A'));
    h.undo();
    assert.equal(h.edit('same', (p) => p), false);
    assert.equal(h.canRedo, true);
    h.edit('b', (p) => setTitle(p, 'B'));
    assert.equal(h.canRedo, false);
  });

  it('coalesces rapid edits with the same key into one step', () => {
    let now = 0;
    const h = new History(sample(), { now: () => now, coalesceMs: 500 });
    for (const d of [5, 6, 7]) {
      h.edit('Duration', (p) => updateCue(p, 'm01', { durationSec: d }), { coalesceKey: 'dur:m01' });
      now += 100;
    }
    now += 1000;
    h.edit('Duration', (p) => updateCue(p, 'm01', { durationSec: 8 }), { coalesceKey: 'dur:m01' });
    assert.equal(h.depth.undo, 2);
    h.undo();
    assert.equal(h.state.cues[0].durationSec, 7);
    h.undo();
    assert.equal(h.state.cues[0].durationSec, 4);
  });

  it('edits share unchanged branches, so history is cheap', () => {
    const p = sample();
    const q = updateCue(p, 'm01', { durationSec: 9 });
    assert.equal(q.media, p.media);
    assert.equal(q.chapters, p.chapters);
    assert.notEqual(q.cues, p.cues);
    assert.equal(q.cues[1], p.cues[1]);
  });

  it('moveItem reorders within a chapter only', () => {
    const p = moveItem(sample(), 'm05', 0);
    const tl = buildTimeline(p);
    const lisbon = tl.segments.filter((s) => s.chapterId === 'ch-lisbon' && s.kind !== 'title');
    assert.deepEqual(lisbon.map((s) => (s.kind !== 'title' ? s.item.id : '')), ['m05', 'm01', 'm02', 'm03', 'm04']);
  });
});

describe('autosave policy', () => {
  function fakeTimers() {
    let now = 0;
    let nextId = 1;
    const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
    const t: Timers = {
      setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
      clearTimeout: (id) => void timers.delete(id as number),
      setInterval: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn, every: ms }); return id; },
      clearInterval: (id) => void timers.delete(id as number),
    };
    const advance = async (ms: number) => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, v] = due;
        now = v.at;
        if (v.every) v.at += v.every; else timers.delete(id);
        v.fn();
        await new Promise((r) => setImmediate(r));
      }
      now = end;
    };
    return { t, advance };
  }

  it('saves every 30 s while dirty and soon after structural edits', async () => {
    const { t, advance } = fakeTimers();
    const saved: string[] = [];
    let state = 'a';
    const a = new Autosaver({ getState: () => state, save: async (s) => void saved.push(s), timers: t });
    await advance(31_000);
    assert.deepEqual(saved, [], 'nothing to save while clean');
    state = 'b';
    a.markDirty(false);
    await advance(29_000);
    assert.deepEqual(saved, ['b']);
    state = 'c';
    a.markDirty(true);
    await advance(1_000);
    assert.deepEqual(saved, ['b', 'c'], 'structural edit saved within a second');
    await a.dispose();
  });

  it('a failed save keeps the changes marked unsaved', async () => {
    const { t, advance } = fakeTimers();
    let fail = true;
    const errs: unknown[] = [];
    const a = new Autosaver({ getState: () => 1, save: async () => { if (fail) throw new Error('disk full'); }, timers: t, onError: (e) => errs.push(e) });
    a.markDirty(true);
    await advance(1_000);
    assert.equal(errs.length, 1);
    assert.equal(a.hasUnsavedChanges, true);
    fail = false;
    await advance(30_000);
    assert.equal(a.hasUnsavedChanges, false);
    await a.dispose();
  });
});

describe('timeline and render model (F-3)', () => {
  it('builds the sample timeline: 4 title cards + 19 playable items, 111 s', () => {
    const tl = buildTimeline(sample());
    assert.equal(tl.segments.length, 23);
    assert.equal(tl.segments.filter((s) => s.kind === 'title').length, 4);
    assert.equal(tl.duration, 111);
    assert.ok(!tl.segments.some((s) => s.kind !== 'title' && s.item.id === 'm14'), 'excluded item never plays');
    assert.deepEqual(tl.chapters.map((c) => [c.start, c.end]), [[0, 27], [27, 52], [52, 84], [84, 111]]);
  });

  it('applies out-points, in-points, speed and title-card overrides', () => {
    const tl = buildTimeline(sample());
    const seg = (id: string) => tl.segments.find((s) => s.kind !== 'title' && s.item.id === id)!;
    assert.equal(seg('m15').duration, 15, '20 s clip cut to 15 s');
    assert.equal(seg('m20').duration, 5, '10 s of media at 2x');
    assert.equal(tl.segments.find((s) => s.kind === 'title' && s.chapterId === 'ch-porto')!.duration, 4);
    const sintra = tl.segments.filter((s) => s.chapterId === 'ch-sintra' && s.kind !== 'title').map((s) => (s.kind !== 'title' ? s.item.id : ''));
    assert.deepEqual(sintra, ['m06', 'm07', 'm10', 'm09', 'm08'], 'cue order wins; the cue-less item goes last');
  });

  it('finds the segment at any time, including both ends', () => {
    const tl = buildTimeline(sample());
    assert.equal(segmentIndexAt(tl, 0), 0);
    assert.equal(segmentIndexAt(tl, 2.999), 0);
    assert.equal(segmentIndexAt(tl, 3), 1);
    assert.equal(segmentIndexAt(tl, tl.duration), tl.segments.length - 1);
    for (let t = 0; t < tl.duration; t += 0.37) {
      const s = tl.segments[segmentIndexAt(tl, t)];
      assert.ok(s.start <= t && t < s.start + s.duration + 1e-9, `t=${t}`);
    }
  });

  it('places media by fit, fill and custom rectangles', () => {
    const frame = { w: 1920, h: 1080 };
    const fit = place({ mode: 'fit' }, { w: 1080, h: 1440 }, frame);
    assert.deepEqual(fit.dst, { x: 555, y: 0, w: 810, h: 1080 });
    const fill = place({ mode: 'fill' }, { w: 1600, h: 1200 }, frame);
    assert.deepEqual(fill.dst, { x: 0, y: 0, w: 1920, h: 1080 });
    assert.equal(fill.src.w, 1600);
    assert.equal(fill.src.h, 900);
    assert.equal(fill.src.y, 150);
    const custom = place({ mode: 'custom', rect: { x: 0.05, y: 0.1, w: 0.5, h: 0.8 } }, { w: 1600, h: 1200 }, frame);
    assert.deepEqual(custom.dst, { x: 96, y: 108, w: 960, h: 864 });
    assert.ok(Math.abs(custom.src.w / custom.src.h - 960 / 864) < 1e-9, 'crop keeps the box shape');
  });

  it('fades in and out, and shortens fades that would overlap', () => {
    const fade = { type: 'fade' as const, durationSec: 0.5 };
    assert.equal(fadeOpacity(0, 4, fade, fade), 0);
    assert.equal(fadeOpacity(0.25, 4, fade, fade), 0.5);
    assert.equal(fadeOpacity(2, 4, fade, fade), 1);
    assert.equal(fadeOpacity(3.75, 4, fade, fade), 0.5);
    assert.equal(fadeOpacity(0.25, 0.5, fade, fade), 1, 'two 0.5 s fades in 0.5 s become 0.25 s each');
    const cut = { type: 'cut' as const, durationSec: 0 };
    assert.equal(fadeOpacity(0, 4, cut, cut), 1);
  });

  it('frameAt maps timeline time to media time for trimmed, sped-up video', () => {
    const tl = buildTimeline(sample());
    const s = tl.segments.find((x) => x.kind !== 'title' && x.item.id === 'm20')!;
    const f = frameAt(tl, s.start + 2, { w: 1920, h: 1080 });
    const layer = f.layers[0];
    assert.equal(layer.kind, 'video');
    if (layer.kind === 'video') assert.equal(layer.mediaTimeSec, 2 + 2 * 2);
    assert.equal(f.chapterIndex, 3);
  });
});

describe('telemetry hooks (F-5)', () => {
  it('is off by default and records nothing', () => {
    const t = new Telemetry();
    const m = memorySink();
    t.addSink(m.sink);
    t.track('player_play', { t: 1 });
    t.taskStart('G1.enter-trip');
    assert.equal(m.events.length, 0);
  });

  it('once opted in, records task timing and strips anything that could carry content', () => {
    let now = 1000;
    const t = new Telemetry(() => now);
    const m = memorySink();
    t.addSink(m.sink);
    t.setEnabled(true);
    t.taskStart('G1.enter-trip');
    now += 4200;
    t.taskEnd('G1.enter-trip');
    t.track('media_error', { itemId: 'm03', uri: 'ch1/secret.jpg', filePath: '/home/x', title: 'My trip', lat: 1, note: 'free text with spaces', count: 3 });
    assert.deepEqual(m.events[1].props, { task: 'G1.enter-trip', outcome: 'success', durationMs: 4200 });
    assert.deepEqual(m.events[2].props, { itemId: 'm03', count: 3 });
  });

  it('sanitize keeps only safe scalars', () => {
    assert.deepEqual(sanitize({ a: 1.23456, b: true, c: 'ok-id', d: { x: 1 }, e: NaN, f: 'has space' }), { a: 1.235, b: true, c: 'ok-id' });
  });
});
