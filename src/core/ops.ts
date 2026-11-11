/**
 * Operations: the unit of the operation log (F-9).
 *
 * Every edit is turned into a short list of operations addressed by entity id
 * (never by array index), so an operation still means the same thing after
 * other people insert, remove or reorder entities. The server applies them,
 * records them with author and time, and (from Phase 7) merges concurrent ones.
 *
 * diff() works on the structurally shared states that History produces: any
 * branch that is the same object in both states is skipped without looking
 * inside, so diffing a 5,000-item project after one edit is cheap.
 */

/** A path step: an object field, or an element of an id-keyed array. */
export type Seg = string | { key: string };
export type Path = Seg[];

export type Operation =
  | { op: 'set'; path: Path; value: unknown }
  | { op: 'unset'; path: Path }
  /** Insert into the keyed array at path; after: undefined = end, null = start, string = after that key. */
  | { op: 'insert'; path: Path; value: unknown; after?: string | null }
  | { op: 'remove'; path: Path; key: string }
  | { op: 'move'; path: Path; key: string; after: string | null };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Entities are keyed by `id`, cues by `itemId`. */
export function keyOf(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  if (typeof v.id === 'string') return v.id;
  if (typeof v.itemId === 'string') return v.itemId;
  return undefined;
}

const isKeyedArray = (a: unknown[]): boolean => a.length > 0 && a.every((x) => keyOf(x) !== undefined);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

export function diff(a: unknown, b: unknown, path: Path = []): Operation[] {
  if (a === b) return [];
  if (isObj(a) && isObj(b)) {
    const ops: Operation[] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (b[k] === undefined) {
        if (a[k] !== undefined) ops.push({ op: 'unset', path: [...path, k] });
      } else if (a[k] === undefined) ops.push({ op: 'set', path: [...path, k], value: b[k] });
      else ops.push(...diff(a[k], b[k], [...path, k]));
    }
    return ops;
  }
  if (Array.isArray(a) && Array.isArray(b) && (isKeyedArray(a) || isKeyedArray(b)) && [...a, ...b].every((x) => keyOf(x) !== undefined)) {
    return diffKeyed(a, b, path);
  }
  return deepEqual(a, b) ? [] : [{ op: 'set', path, value: b }];
}

function diffKeyed(a: unknown[], b: unknown[], path: Path): Operation[] {
  const ops: Operation[] = [];
  const am = new Map(a.map((x) => [keyOf(x)!, x]));
  const bm = new Map(b.map((x) => [keyOf(x)!, x]));
  const work = a.map((x) => keyOf(x)!).filter((k) => {
    if (bm.has(k)) return true;
    ops.push({ op: 'remove', path, key: k });
    return false;
  });
  // Walk b in order, placing each key after its predecessor in b.
  let prev: string | null = null;
  for (const x of b) {
    const k = keyOf(x)!;
    const at = work.indexOf(k);
    const expected = prev === null ? 0 : work.indexOf(prev) + 1;
    if (at < 0) {
      ops.push({ op: 'insert', path, value: x, after: prev });
      work.splice(expected, 0, k);
    } else {
      if (at !== expected) {
        ops.push({ op: 'move', path, key: k, after: prev });
        work.splice(at, 1);
        work.splice(prev === null ? 0 : work.indexOf(prev) + 1, 0, k);
      }
      ops.push(...diff(am.get(k), x, [...path, { key: k }]));
    }
    prev = k;
  }
  return ops;
}

export class OperationError extends Error {
  constructor(message: string, readonly operation: Operation) {
    super(message);
    this.name = 'OperationError';
  }
}

const segText = (s: Seg) => (typeof s === 'string' ? s : `[${s.key}]`);

/** Apply operations immutably: only the containers along each path are copied. */
export function applyOps<T>(doc: T, ops: Operation[]): T {
  let out: unknown = doc;
  for (const o of ops) out = applyOne(out, o);
  return out as T;
}

function applyOne(root: unknown, o: Operation): unknown {
  const fail = (msg: string): never => {
    throw new OperationError(`${o.op} ${o.path.map(segText).join('.')}: ${msg}`, o);
  };
  const update = (node: unknown, path: Path, fn: (target: unknown) => unknown): unknown => {
    if (path.length === 0) return fn(node);
    const [s, ...rest] = path;
    if (typeof s === 'string') {
      if (!isObj(node)) return fail(`"${s}" is not inside an object`);
      if (s === '__proto__' || s === 'constructor' || s === 'prototype') return fail('forbidden key');
      return { ...node, [s]: update(node[s], rest, fn) };
    }
    if (!Array.isArray(node)) return fail(`[${s.key}] is not inside a list`);
    const i = node.findIndex((x) => keyOf(x) === s.key);
    if (i < 0) return fail(`no entity "${s.key}"`);
    const copy = node.slice();
    copy[i] = update(node[i], rest, fn);
    return copy;
  };

  switch (o.op) {
    case 'set':
    case 'unset': {
      if (o.path.length === 0) return o.op === 'set' ? o.value : fail('cannot unset the document');
      const parentPath = o.path.slice(0, -1);
      const last = o.path[o.path.length - 1];
      return update(root, parentPath, (parent) => {
        if (typeof last === 'string') {
          if (!isObj(parent)) return fail('parent is not an object');
          if (last === '__proto__' || last === 'constructor' || last === 'prototype') return fail('forbidden key');
          if (o.op === 'unset') {
            const { [last]: _gone, ...rest } = parent;
            return rest;
          }
          return { ...parent, [last]: o.value };
        }
        if (!Array.isArray(parent)) return fail('parent is not a list');
        const i = parent.findIndex((x) => keyOf(x) === last.key);
        if (i < 0) return fail(`no entity "${last.key}"`);
        if (o.op === 'unset') return fail('use remove for list entities');
        const copy = parent.slice();
        copy[i] = o.value;
        return copy;
      });
    }
    case 'insert':
      return update(root, o.path, (list) => {
        if (!Array.isArray(list)) return fail('target is not a list');
        const k = keyOf(o.value);
        if (k === undefined) return fail('inserted value has no id');
        if (list.some((x) => keyOf(x) === k)) return fail(`"${k}" already exists`);
        const copy = list.slice();
        copy.splice(position(list, o.after, fail), 0, o.value);
        return copy;
      });
    case 'remove':
      return update(root, o.path, (list) => {
        if (!Array.isArray(list)) return fail('target is not a list');
        const i = list.findIndex((x) => keyOf(x) === o.key);
        if (i < 0) return fail(`no entity "${o.key}"`);
        return [...list.slice(0, i), ...list.slice(i + 1)];
      });
    case 'move':
      return update(root, o.path, (list) => {
        if (!Array.isArray(list)) return fail('target is not a list');
        const i = list.findIndex((x) => keyOf(x) === o.key);
        if (i < 0) return fail(`no entity "${o.key}"`);
        const copy = list.slice();
        const [item] = copy.splice(i, 1);
        copy.splice(position(copy, o.after, fail), 0, item);
        return copy;
      });
    default:
      return fail('unknown operation');
  }
}

function position(list: unknown[], after: string | null | undefined, fail: (m: string) => never): number {
  if (after === undefined) return list.length;
  if (after === null) return 0;
  const i = list.findIndex((x) => keyOf(x) === after);
  if (i < 0) fail(`no entity "${after}" to insert after`);
  return i + 1;
}

/** Light shape check for operations arriving over the network. */
export function isOperation(v: unknown): v is Operation {
  if (!isObj(v) || !Array.isArray(v.path)) return false;
  const pathOk = v.path.length <= 16 && v.path.every((s) => typeof s === 'string' || (isObj(s) && typeof s.key === 'string'));
  if (!pathOk) return false;
  switch (v.op) {
    case 'set': return 'value' in v;
    case 'unset': return true;
    case 'insert': return 'value' in v && (v.after === undefined || v.after === null || typeof v.after === 'string');
    case 'remove': return typeof v.key === 'string';
    case 'move': return typeof v.key === 'string' && (v.after === null || typeof v.after === 'string');
    default: return false;
  }
}
