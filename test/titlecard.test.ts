import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTimeline, parseProject } from '../src/core/index.js';
import { wrapText } from '../src/player/player.js';

// 10 px per character.
const ctx = { measureText: (s: string) => ({ width: s.length * 10 }) as TextMetrics };

test('title cards carry the chapter description', () => {
  const { project } = parseProject(readFileSync('samples/hand-written-20/trip.travelogue.json', 'utf8'));
  const titles = buildTimeline(project).segments.filter((s) => s.kind === 'title');
  assert.equal(titles[0].kind === 'title' && titles[0].description, 'Three days of hills, trams and custard tarts.');
  project.chapters[1].description = '   ';
  const t2 = buildTimeline(project).segments.filter((s) => s.kind === 'title')[1];
  assert.equal(t2.kind === 'title' && t2.description, '');
});

test('descriptions wrap by word, keep line breaks, and end with an ellipsis past the last line', () => {
  assert.deepEqual(wrapText(ctx, 'one two three four', 90, 4), ['one two', 'three', 'four']);
  assert.deepEqual(wrapText(ctx, 'first line\nsecond', 200, 4), ['first line', 'second']);
  const cut = wrapText(ctx, 'aa bb cc dd ee ff gg', 50, 2);
  assert.equal(cut.length, 2);
  assert.equal(cut[0], 'aa bb');
  assert.ok(cut[1].endsWith('…') && cut[1].length * 10 <= 50, cut[1]);
  assert.deepEqual(wrapText(ctx, '', 100, 4), []);
});
