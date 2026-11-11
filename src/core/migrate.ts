import { SCHEMA_VERSION } from './schema.js';

/**
 * Schema migrations. Each step upgrades a raw object from `from` to `from + 1`.
 * Steps must be pure and must never drop user data they do not understand.
 *
 * Version 0 is the pre-release draft format (no schemaVersion, `items` instead
 * of `media`, no audio lanes or map view); it is kept as the worked example of
 * how a later step should look.
 */
export interface Migration {
  from: number;
  describe: string;
  up(raw: Record<string, unknown>): Record<string, unknown>;
}

export const MIGRATIONS: Migration[] = [
  {
    from: 0,
    describe: 'Draft format to v1: rename items to media; add audio lanes, map view, annotations',
    up(raw) {
      const { items, ...rest } = raw;
      return {
        ...rest,
        media: rest.media ?? items ?? [],
        annotations: rest.annotations ?? [],
        audioLanes: rest.audioLanes ?? [
          { id: 'lane-narration', kind: 'narration', volume: 1, mute: false, ducks: [{ laneId: 'lane-music', db: -12 }, { laneId: 'lane-clip', db: -12 }] },
          { id: 'lane-music', kind: 'music', volume: 0.7, mute: false, ducks: [] },
          { id: 'lane-clip', kind: 'clipSound', volume: 1, mute: false, ducks: [] },
        ],
        mapView: rest.mapView ?? {
          enabled: false, corner: 'bottomRight', size: 0.2, shape: 'rect', style: 'light',
          tripOverview: true, transitionAnimation: true, hidePreciseLocations: false,
        },
        schemaVersion: 1,
      };
    },
  },
];

export class UnsupportedVersionError extends Error {
  constructor(readonly version: number) {
    super(`This project was saved by a newer TripAlogue (schema v${version}); this build reads up to v${SCHEMA_VERSION}.`);
    this.name = 'UnsupportedVersionError';
  }
}

export function migrate(raw: unknown, migrations: Migration[] = MIGRATIONS, target = SCHEMA_VERSION): { value: unknown; fromVersion: number } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, fromVersion: NaN };
  let obj = raw as Record<string, unknown>;
  const fromVersion = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 0;
  if (fromVersion > target) throw new UnsupportedVersionError(fromVersion);
  let v = fromVersion;
  while (v < target) {
    const step = migrations.find((m) => m.from === v);
    if (!step) throw new Error(`No migration from schema v${v}`);
    obj = step.up(obj);
    v += 1;
    obj = { ...obj, schemaVersion: v };
  }
  return { value: obj, fromVersion };
}
