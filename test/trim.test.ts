import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cueDuration, defaultCue, setVideoTrim, DEFAULT_CUE_PROFILE, type MediaItem, type Travelogue } from '../src/core/index.js';

const video = (durationSec?: number): MediaItem => ({ id: 'v1', kind: 'video', uri: 'clip.mp4', sourceId: 's1', chapterId: 'c1', durationSec } as MediaItem);

test('a new video cue plays the whole clip, however long', () => {
  const v = video(95);
  const cue = defaultCue(v, DEFAULT_CUE_PROFILE, 'a0');
  assert.equal(cue.inPointSec, 0);
  assert.equal(cue.outPointSec, undefined);
  assert.equal(cueDuration(v, cue), 95);
  // A cue made before the length was known follows it once processing finds it.
  const early = defaultCue(video(undefined), DEFAULT_CUE_PROFILE, 'a0');
  assert.equal(cueDuration(v, early), 95);
});

test('trimming from the beginning, the end, or both', () => {
  const v = video(40);
  const p = { media: [v], cues: [defaultCue(v, DEFAULT_CUE_PROFILE, 'a0')] } as unknown as Travelogue;
  const start = setVideoTrim(p, 'v1', 5, null);
  assert.equal(cueDuration(v, start.cues[0]), 35);
  assert.equal('outPointSec' in start.cues[0], false);
  const both = setVideoTrim(start, 'v1', 5, 30);
  assert.equal(cueDuration(v, both.cues[0]), 25);
  const halfSpeed = { ...both, cues: [{ ...both.cues[0], speed: 2 }] };
  assert.equal(cueDuration(v, halfSpeed.cues[0]), 12.5);
  // An end at (or past) the clip's end means "to the end" again.
  const reset = setVideoTrim(both, 'v1', 0, 40);
  assert.equal(reset.cues[0].outPointSec, undefined);
  assert.equal(cueDuration(v, reset.cues[0]), 40);
});

test('trims are clamped to the clip and a minimum length', () => {
  const v = video(10);
  const p = { media: [v], cues: [defaultCue(v, DEFAULT_CUE_PROFILE, 'a0')] } as unknown as Travelogue;
  assert.equal(setVideoTrim(p, 'v1', 20, null).cues[0].inPointSec, 9.5);
  const tiny = setVideoTrim(p, 'v1', 4, 4.1).cues[0];
  assert.deepEqual([tiny.inPointSec, tiny.outPointSec], [4, 4.5]);
  assert.equal(setVideoTrim(p, 'v1', -3, null).cues[0].inPointSec, 0);
  assert.equal(setVideoTrim(p, 'missing', 1, 2), p);
});

