import {
  DEFAULT_AUDIO_LANES,
  DEFAULT_CUE_PROFILE,
  DEFAULT_MAP_VIEW,
  OUTPUT_PRESETS,
  SCHEMA_VERSION,
  type AspectRatio,
  type Cue,
  type CueProfile,
  type MediaItem,
  type Travelogue,
} from './schema.js';
import { migrate } from './migrate.js';
import { validate, type ValidationIssue } from './validate.js';

let counter = 0;
/** Short, sortable, collision-resistant id. Uses crypto.randomUUID where available. */
export function newId(prefix = 'id'): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const rand = c?.randomUUID ? c.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  counter = (counter + 1) % 1296;
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${rand}`;
}

export function createProject(opts: { title: string; aspect?: AspectRatio; now?: Date }): Travelogue {
  const now = (opts.now ?? new Date()).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('trv'),
    title: opts.title,
    createdAt: now,
    updatedAt: now,
    output: { ...OUTPUT_PRESETS[opts.aspect ?? '16:9'] },
    cueProfile: { ...DEFAULT_CUE_PROFILE },
    chapters: [],
    sources: [],
    media: [],
    cues: [],
    annotations: [],
    audioLanes: DEFAULT_AUDIO_LANES.map((l) => ({ ...l, ducks: l.ducks.map((d) => ({ ...d })) })),
    mapView: { ...DEFAULT_MAP_VIEW },
  };
}

/** The default cue for a media item, from the project's cue profile (PE-7 "reset to default"). */
export function defaultCue(item: MediaItem, profile: CueProfile, order: string): Cue {
  const isVideo = item.kind === 'video';
  return {
    itemId: item.id,
    included: true,
    order,
    durationSec: item.kind === 'image' ? profile.imageDurationSec : undefined,
    inPointSec: isVideo ? 0 : undefined,
    outPointSec: isVideo && item.durationSec !== undefined ? Math.min(item.durationSec, profile.videoMaxSec) : undefined,
    placement: { mode: profile.defaultPlacement },
    entrance: { type: 'fade', durationSec: profile.fadeInSec },
    animation: { type: 'none' },
    exit: { type: 'fade', durationSec: profile.fadeOutSec },
    speed: 1,
    volume: 1,
  };
}

export class ProjectFormatError extends Error {
  constructor(message: string, readonly issues: ValidationIssue[] = []) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

/** Parse, migrate and validate project text. Throws ProjectFormatError on any error-level issue. */
export function parseProject(text: string): { project: Travelogue; warnings: ValidationIssue[]; migratedFrom?: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ProjectFormatError(`Project file is not valid JSON: ${(e as Error).message}`);
  }
  const { value, fromVersion } = migrate(raw);
  const issues = validate(value);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) {
    throw new ProjectFormatError(
      `Project file has ${errors.length} error(s):\n` + errors.slice(0, 20).map((i) => `  ${i.path}: ${i.message}`).join('\n'),
      issues,
    );
  }
  return {
    project: value as Travelogue,
    warnings: issues.filter((i) => i.level === 'warning'),
    migratedFrom: fromVersion !== SCHEMA_VERSION ? fromVersion : undefined,
  };
}

/** Stable, human-diffable serialisation. */
export function serializeProject(p: Travelogue): string {
  return JSON.stringify(p, null, 2) + '\n';
}

export function touch(p: Travelogue, now = new Date()): Travelogue {
  return { ...p, updatedAt: now.toISOString() };
}
