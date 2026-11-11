import { SCHEMA_VERSION } from './schema.js';

export interface ValidationIssue {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const LOCAL_DT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

/**
 * Structural and referential validation of a (migrated) project object.
 * Hand-written so the core has no runtime dependencies.
 */
export function validate(raw: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (path: string, message: string) => issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ level: 'warning', path, message });

  if (!isObj(raw)) {
    err('$', 'project must be a JSON object');
    return issues;
  }
  const p = raw;

  const str = (o: Obj, k: string, path: string, opt = false) => {
    if (o[k] === undefined && opt) return;
    if (typeof o[k] !== 'string') err(`${path}.${k}`, 'must be a string');
  };
  const num = (o: Obj, k: string, path: string, min?: number, max?: number, opt = false) => {
    const v = o[k];
    if (v === undefined && opt) return;
    if (!isNum(v)) return err(`${path}.${k}`, 'must be a finite number');
    if (min !== undefined && v < min) err(`${path}.${k}`, `must be >= ${min}`);
    if (max !== undefined && v > max) err(`${path}.${k}`, `must be <= ${max}`);
  };
  const oneOf = (o: Obj, k: string, path: string, allowed: readonly string[], opt = false) => {
    if (o[k] === undefined && opt) return;
    if (!allowed.includes(o[k] as string)) err(`${path}.${k}`, `must be one of ${allowed.join(', ')}`);
  };
  const arr = (k: string): Obj[] => {
    if (!Array.isArray(p[k])) {
      err(`$.${k}`, 'must be an array');
      return [];
    }
    const out: Obj[] = [];
    (p[k] as unknown[]).forEach((e, i) => (isObj(e) ? out.push(e) : err(`$.${k}[${i}]`, 'must be an object')));
    return out;
  };
  const rect = (o: unknown, path: string) => {
    if (!isObj(o)) return err(path, 'must be a rect {x,y,w,h}');
    for (const k of ['x', 'y', 'w', 'h']) num(o, k, path);
    if (isNum(o.w) && o.w <= 0) err(`${path}.w`, 'must be > 0');
    if (isNum(o.h) && o.h <= 0) err(`${path}.h`, 'must be > 0');
  };
  const transition = (o: unknown, path: string) => {
    if (!isObj(o)) return err(path, 'must be a transition object');
    oneOf(o, 'type', path, ['cut', 'fade']);
    num(o, 'durationSec', path, 0, 10);
  };

  if (p.schemaVersion !== SCHEMA_VERSION) err('$.schemaVersion', `must be ${SCHEMA_VERSION}`);
  str(p, 'id', '$');
  str(p, 'title', '$');
  str(p, 'createdAt', '$');
  str(p, 'updatedAt', '$');

  if (!isObj(p.output)) err('$.output', 'must be an object');
  else {
    num(p.output, 'width', '$.output', 16, 7680);
    num(p.output, 'height', '$.output', 16, 4320);
    num(p.output, 'fps', '$.output', 1, 120);
    oneOf(p.output, 'aspect', '$.output', ['16:9', '9:16', '1:1']);
  }
  if (!isObj(p.cueProfile)) err('$.cueProfile', 'must be an object');
  else {
    const cp = p.cueProfile;
    num(cp, 'imageDurationSec', '$.cueProfile', 0.1, 600);
    num(cp, 'videoMaxSec', '$.cueProfile', 0.1, 3600);
    num(cp, 'fadeInSec', '$.cueProfile', 0, 10);
    num(cp, 'fadeOutSec', '$.cueProfile', 0, 10);
    num(cp, 'titleCardSec', '$.cueProfile', 0, 60);
    oneOf(cp, 'defaultPlacement', '$.cueProfile', ['fit', 'fill', 'custom']);
  }

  // Chapters
  const chapterIds = new Set<string>();
  arr('chapters').forEach((c, i) => {
    const path = `$.chapters[${i}]`;
    str(c, 'id', path);
    if (typeof c.id === 'string') {
      if (chapterIds.has(c.id)) err(`${path}.id`, `duplicate chapter id "${c.id}"`);
      chapterIds.add(c.id);
    }
    str(c, 'title', path);
    str(c, 'locationName', path);
    str(c, 'description', path);
    str(c, 'timeZone', path);
    for (const k of ['start', 'end']) {
      if (typeof c[k] !== 'string' || !LOCAL_DT.test(c[k] as string)) err(`${path}.${k}`, 'must be a local date-time like 2026-05-03T09:00');
    }
    if (typeof c.start === 'string' && typeof c.end === 'string' && c.start > c.end) err(path, 'start is after end');
    if (c.coordinates !== undefined) {
      if (!isObj(c.coordinates)) err(`${path}.coordinates`, 'must be {lat, lng}');
      else {
        num(c.coordinates, 'lat', `${path}.coordinates`, -90, 90);
        num(c.coordinates, 'lng', `${path}.coordinates`, -180, 180);
      }
    }
    if (!isObj(c.titleCard) || typeof c.titleCard.enabled !== 'boolean') err(`${path}.titleCard`, 'must be {enabled: boolean, durationSec?}');
    else num(c.titleCard, 'durationSec', `${path}.titleCard`, 0, 60, true);
  });

  // Sources
  const sourceIds = new Set<string>();
  arr('sources').forEach((s, i) => {
    const path = `$.sources[${i}]`;
    str(s, 'id', path);
    if (typeof s.id === 'string') {
      if (sourceIds.has(s.id)) err(`${path}.id`, `duplicate source id "${s.id}"`);
      sourceIds.add(s.id);
    }
    oneOf(s, 'type', path, ['localFolder', 'googlePhotos']);
    str(s, 'displayName', path);
    str(s, 'rootPath', path, true);
    str(s, 'authRef', path, true);
    num(s, 'clockOffsetSec', path);
    for (const k of Object.keys(s)) {
      if (/token|password|secret/i.test(k)) err(`${path}.${k}`, 'credentials must not be stored in the project file');
    }
  });

  // Media
  const mediaIds = new Map<string, Obj>();
  arr('media').forEach((m, i) => {
    const path = `$.media[${i}]`;
    str(m, 'id', path);
    if (typeof m.id === 'string') {
      if (mediaIds.has(m.id)) err(`${path}.id`, `duplicate media id "${m.id}"`);
      mediaIds.set(m.id, m);
    }
    str(m, 'uri', path);
    oneOf(m, 'kind', path, ['image', 'video', 'audio']);
    if (typeof m.sourceId !== 'string' || !sourceIds.has(m.sourceId)) err(`${path}.sourceId`, 'must reference an existing source');
    if (m.chapterId !== null && (typeof m.chapterId !== 'string' || !chapterIds.has(m.chapterId))) {
      err(`${path}.chapterId`, 'must reference an existing chapter, or be null (Unassigned)');
    }
    str(m, 'capturedAt', path, true);
    str(m, 'userTimestamp', path, true);
    oneOf(m, 'timestampConfidence', path, ['high', 'low'], true);
    num(m, 'width', path, 1, 100000, true);
    num(m, 'height', path, 1, 100000, true);
    num(m, 'durationSec', path, 0, 86400, true);
    if ((m.kind === 'video' || m.kind === 'audio') && m.durationSec === undefined) warn(`${path}.durationSec`, 'unknown duration; run the cache step to probe it');
    if (typeof m.uri === 'string' && m.uri.split(/[\\/]/).includes('..')) {
      err(`${path}.uri`, 'must not contain ".."; paths are relative to the source root');
    }
  });

  // Cues
  const cueItems = new Set<string>();
  arr('cues').forEach((c, i) => {
    const path = `$.cues[${i}]`;
    if (typeof c.itemId !== 'string' || !mediaIds.has(c.itemId)) err(`${path}.itemId`, 'must reference an existing media item');
    else {
      if (cueItems.has(c.itemId)) err(`${path}.itemId`, `media item "${c.itemId}" has more than one cue`);
      cueItems.add(c.itemId);
    }
    if (typeof c.included !== 'boolean') err(`${path}.included`, 'must be a boolean');
    num(c, 'order', path);
    num(c, 'durationSec', path, 0.04, 3600, true);
    num(c, 'inPointSec', path, 0, 86400, true);
    num(c, 'outPointSec', path, 0, 86400, true);
    if (isNum(c.inPointSec) && isNum(c.outPointSec) && c.outPointSec <= c.inPointSec) err(path, 'outPointSec must be after inPointSec');
    num(c, 'speed', path, 0.25, 4);
    num(c, 'volume', path, 0, 2);
    if (!isObj(c.placement)) err(`${path}.placement`, 'must be an object');
    else {
      oneOf(c.placement, 'mode', `${path}.placement`, ['fit', 'fill', 'custom']);
      if (c.placement.mode === 'custom') rect(c.placement.rect, `${path}.placement.rect`);
    }
    transition(c.entrance, `${path}.entrance`);
    transition(c.exit, `${path}.exit`);
    if (!isObj(c.animation)) err(`${path}.animation`, 'must be an object');
    else if (c.animation.type === 'kenBurns') {
      rect(c.animation.from, `${path}.animation.from`);
      rect(c.animation.to, `${path}.animation.to`);
    } else if (c.animation.type !== 'none') err(`${path}.animation.type`, 'must be none or kenBurns');
    const item = typeof c.itemId === 'string' ? mediaIds.get(c.itemId) : undefined;
    if (item?.kind === 'image' && c.durationSec === undefined) err(`${path}.durationSec`, 'image cues need a duration');
    if (item?.kind === 'video' && isNum(item.durationSec) && isNum(c.outPointSec) && c.outPointSec > item.durationSec + 0.05) {
      err(`${path}.outPointSec`, `is past the end of the clip (${item.durationSec}s)`);
    }
  });
  for (const id of mediaIds.keys()) if (!cueItems.has(id)) warn('$.cues', `media item "${id}" has no cue; defaults will be used`);

  arr('annotations');
  const laneIds = new Set<string>();
  arr('audioLanes').forEach((l, i) => {
    const path = `$.audioLanes[${i}]`;
    str(l, 'id', path);
    if (typeof l.id === 'string') laneIds.add(l.id);
    oneOf(l, 'kind', path, ['narration', 'music', 'clipSound']);
    num(l, 'volume', path, 0, 2);
  });
  if (!isObj(p.mapView)) err('$.mapView', 'must be an object');
  else num(p.mapView, 'size', '$.mapView', 0.1, 0.3);

  return issues;
}
