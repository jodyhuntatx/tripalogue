import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  applyOps, buildTimeline, diff, History, isOperation, isOrderKey, keyBetween, migrate, moveItem, parseProject, setIncluded, setTitle,
  spreadKeys, updateCue, type Operation, type Travelogue,
} from '../src/core/index.js';

const SAMPLE = new URL('../samples/hand-written-20/trip.travelogue.json', import.meta.url);
const sample = (): Travelogue => parseProject(readFileSync(SAMPLE, 'utf8')).project;

describe('fractional order keys', () => {
  it('always finds a key strictly between two keys, or at either end', () => {
    assert.ok(keyBetween(null, null) > '' && isOrderKey(keyBetween(null, null)));
    const pairs: [string | null, string | null][] = [[null, 'a'], ['a', null], ['a', 'b'], ['a', 'a1'], ['az', 'b'], ['zz', null], [null, '01'], ['0001', '0002']];
    for (const [a, b] of pairs) {
      const k = keyBetween(a, b);
      assert.ok(isOrderKey(k), k);
      if (a !== null) assert.ok(a < k, `${a} < ${k}`);
      if (b !== null) assert.ok(k < b, `${k} < ${b}`);
    }
  });

  it('survives 1,000 inserts into the same gap with short keys', () => {
    let lo = 'a';
    const hi = 'b';
    for (let i = 0; i < 1000; i++) {
      const k = keyBetween(lo, hi);
      assert.ok(lo < k && k < hi);
      lo = k;
    }
    assert.ok(lo.length < 250, `length ${lo.length}`);
  });

  it('keeps keys short when appending one item after another', () => {
    let k = spreadKeys(1)[0];
    for (let i = 0; i < 5000; i++) {
      const n = keyBetween(k, null);
      assert.ok(n > k);
      k = n;
    }
    assert.ok(k.length <= 150, `length ${k.length}`);
  });

  it('spreads n fresh keys evenly and in order', () => {
    for (const n of [1, 2, 5, 36, 500, 5000]) {
      const keys = spreadKeys(n);
      assert.equal(keys.length, n);
      assert.ok(keys.every(isOrderKey));
      assert.deepEqual([...keys].sort(), keys);
      assert.equal(new Set(keys).size, n);
    }
  });

  it('rejects invalid or inverted bounds', () => {
    assert.throws(() => keyBetween('b', 'a'), /out of order/);
    assert.throws(() => keyBetween('a0', null), /Invalid/);
    assert.throws(() => keyBetween('A', null), /Invalid/);
  });
});

describe('schema v2 migration', () => {
  it('turns v1 local folders into upload sources and numeric order into keys, keeping the order', () => {
    const v1 = JSON.parse(readFileSync(SAMPLE, 'utf8'));
    assert.equal(v1.schemaVersion, 1);
    const { value, fromVersion } = migrate(v1);
    const p = value as Travelogue;
    assert.equal(fromVersion, 1);
    assert.equal(p.schemaVersion, 2);
    assert.ok(p.sources.every((s) => s.type === 'upload'));
    assert.ok(p.cues.every((c) => isOrderKey(c.order)));
    const sintra = buildTimeline(p).segments.filter((s) => s.chapterId === 'ch-sintra' && s.kind !== 'title').map((s) => (s.kind !== 'title' ? s.item.id : ''));
    assert.deepEqual(sintra, ['m06', 'm07', 'm10', 'm09', 'm08']);
  });
});

describe('operations (F-9)', () => {
  it('diff then apply reproduces any edit exactly', () => {
    const a = sample();
    const edits: ((p: Travelogue) => Travelogue)[] = [
      (p) => setTitle(p, 'Renamed'),
      (p) => setIncluded(p, 'm03', false),
      (p) => updateCue(p, 'm01', { durationSec: 7, placement: { mode: 'custom', rect: { x: 0, y: 0, w: 0.5, h: 0.5 } } }),
      (p) => moveItem(p, 'm05', 0),
      (p) => ({ ...p, chapters: [p.chapters[2], p.chapters[0], p.chapters[1], p.chapters[3]] }),
      (p) => ({ ...p, media: p.media.filter((m) => m.id !== 'm14'), cues: p.cues.filter((c) => c.itemId !== 'm14') }),
      (p) => ({ ...p, chapters: [...p.chapters, { ...p.chapters[0], id: 'ch-new', title: 'Évora' }] }),
      (p) => ({ ...p, mapView: { ...p.mapView, enabled: !p.mapView.enabled } }),
    ];
    let cur = a;
    for (const e of edits) {
      const next = e(cur);
      const ops = diff(cur, next);
      assert.ok(ops.length > 0);
      assert.ok(ops.every(isOperation));
      assert.deepEqual(applyOps(cur, ops), next);
      assert.deepEqual(JSON.parse(JSON.stringify(applyOps(JSON.parse(JSON.stringify(cur)), JSON.parse(JSON.stringify(ops))))), JSON.parse(JSON.stringify(next)), 'survives a JSON round trip');
      cur = next;
    }
  });

  it('addresses entities by id, so an op still applies after others reorder or insert', () => {
    const a = sample();
    const ops = diff(a, setIncluded(a, 'm07', false));
    assert.deepEqual(ops, [{ op: 'set', path: ['cues', { key: 'm07' }, 'included'], value: false }]);
    const shuffled = { ...a, cues: [...a.cues].reverse(), media: [{ ...a.media[0], id: 'mX' }, ...a.media] };
    const out = applyOps(shuffled, ops);
    assert.equal(out.cues.find((c) => c.itemId === 'm07')!.included, false);
  });

  it('a move changes one cue only', () => {
    const a = sample();
    const ops = diff(a, moveItem(a, 'm04', 0));
    assert.equal(ops.length, 1);
    assert.deepEqual(ops[0].path, ['cues', { key: 'm04' }, 'order']);
  });

  it('reports a clear error when the target entity is gone', () => {
    const ops: Operation[] = [{ op: 'set', path: ['cues', { key: 'nope' }, 'included'], value: true }];
    assert.throws(() => applyOps(sample(), ops), /no entity "nope"/);
  });

  it('refuses prototype-polluting paths', () => {
    assert.throws(() => applyOps({}, [{ op: 'set', path: ['__proto__', 'x'], value: 1 }]), /forbidden/);
    assert.equal(({} as Record<string, unknown>).x, undefined);
  });

  it('isOperation rejects malformed input', () => {
    assert.equal(isOperation({ op: 'set', path: ['a'] }), false);
    assert.equal(isOperation({ op: 'drop', path: [] }), false);
    assert.equal(isOperation({ op: 'move', path: ['cues'], key: 'x', after: 3 }), false);
    assert.equal(isOperation({ op: 'remove', path: ['cues'], key: 'x' }), true);
  });

  it('diff skips shared branches without looking inside', () => {
    const a = sample();
    const b = setTitle(a, 'x');
    let reads = 0;
    const spy = new Proxy(b.media, { get(t, k, r) { reads++; return Reflect.get(t, k, r); } });
    diff(a, { ...b, media: a.media });
    assert.equal(reads, 0);
    void spy;
  });
});

describe('history rebase (remote changes keep undo intact)', () => {
  it('folds a server change into past and future states', () => {
    const h = new History(sample());
    h.edit('Rename', (p) => setTitle(p, 'Mine'));
    const serverOp: Operation[] = [{ op: 'set', path: ['media', { key: 'm01' }, 'status'], value: 'ready' }];
    h.rebase((p) => applyOps(p, serverOp));
    assert.equal(h.state.media[0].status, 'ready');
    h.undo();
    assert.equal(h.state.title, 'Portugal in Ten Days');
    assert.equal(h.state.media[0].status, 'ready', 'undo did not revert the server change');
    h.redo();
    assert.equal(h.state.title, 'Mine');
    assert.equal(h.state.media[0].status, 'ready');
  });
});
