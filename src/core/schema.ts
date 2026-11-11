/**
 * TripAlogue project schema (PRD Section 3).
 *
 * One Travelogue = one project file. Media stays where it lives; the project
 * holds references plus cues, never copies of originals. Entities that later
 * phases fill in (map view, audio lanes, annotations) are present from v1 so
 * the file format does not churn phase to phase.
 */

export const SCHEMA_VERSION = 1;
export const FILE_EXTENSION = '.travelogue.json';

export type Id = string;

/** ISO 8601 local date-time without offset, e.g. "2026-05-03T09:00". Read in the chapter's time zone. */
export type LocalDateTime = string;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Normalised rectangle: 0..1 of the output frame. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AspectRatio = '16:9' | '9:16' | '1:1';

export interface OutputSettings {
  width: number;
  height: number;
  fps: number;
  aspect: AspectRatio;
}

export interface CueProfile {
  imageDurationSec: number;
  videoMaxSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  titleCardSec: number;
  defaultPlacement: PlacementMode;
}

export interface TitleCard {
  enabled: boolean;
  /** Overrides the cue profile's titleCardSec when set. */
  durationSec?: number;
}

export interface Chapter {
  id: Id;
  title: string;
  locationName: string;
  coordinates?: LatLng;
  start: LocalDateTime;
  end: LocalDateTime;
  /** IANA time zone, e.g. "Europe/Lisbon". */
  timeZone: string;
  description: string;
  titleCard: TitleCard;
}

export type SourceType = 'localFolder' | 'googlePhotos';

export interface MediaSource {
  id: Id;
  type: SourceType;
  displayName: string;
  /** Local folders: path relative to the project file's folder, or absolute. */
  rootPath?: string;
  /** Opaque key into the OS keychain; never a credential. */
  authRef?: string;
  /** Added to captured-at to correct a wrong camera clock (MM-4). */
  clockOffsetSec: number;
}

export type MediaKind = 'image' | 'video' | 'audio';
export type TimestampConfidence = 'high' | 'low';

export interface MediaItem {
  id: Id;
  sourceId: Id;
  /** Path relative to the source root (local) or an opaque source URI. */
  uri: string;
  kind: MediaKind;
  capturedAt?: string;
  userTimestamp?: string;
  timestampConfidence?: TimestampConfidence;
  location?: LatLng;
  width?: number;
  height?: number;
  durationSec?: number;
  /** null = Unassigned bin. */
  chapterId: Id | null;
}

export type PlacementMode = 'fit' | 'fill' | 'custom';

export interface Placement {
  mode: PlacementMode;
  /** Required when mode = custom. */
  rect?: NormRect;
}

export type TransitionType = 'cut' | 'fade';

export interface Transition {
  type: TransitionType;
  durationSec: number;
}

export type Animation = { type: 'none' } | { type: 'kenBurns'; from: NormRect; to: NormRect };

export type AudioAnchor =
  | { type: 'item'; itemId: Id; offsetSec: number }
  | { type: 'chapterTime'; chapterId: Id; offsetSec: number };

export interface AudioCue {
  laneId: Id;
  anchor: AudioAnchor;
  fadeInSec: number;
  fadeOutSec: number;
  duck: boolean;
}

export interface Cue {
  itemId: Id;
  included: boolean;
  /** Sort key within the item's chapter. */
  order: number;
  /** Images: time on screen. Videos: derived from in/out and speed when absent. */
  durationSec?: number;
  inPointSec?: number;
  outPointSec?: number;
  placement: Placement;
  entrance: Transition;
  animation: Animation;
  exit: Transition;
  speed: number;
  volume: number;
  audio?: AudioCue;
}

export interface Annotation {
  id: Id;
  target: { type: 'item'; itemId: Id } | { type: 'chapter'; chapterId: Id };
  text: string;
  style: string;
  position: NormRect;
  startSec: number;
  durationSec: number;
}

export type AudioLaneKind = 'narration' | 'music' | 'clipSound';

export interface AudioLane {
  id: Id;
  kind: AudioLaneKind;
  volume: number;
  mute: boolean;
  /** Lanes this lane lowers while it plays, and by how many dB. */
  ducks: { laneId: Id; db: number }[];
}

export type InsetCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export interface MapViewSettings {
  enabled: boolean;
  corner: InsetCorner;
  /** Fraction of frame width, 0.1..0.3 (MV-3). */
  size: number;
  shape: 'rect' | 'circle';
  style: 'light' | 'dark' | 'terrain';
  tripOverview: boolean;
  transitionAnimation: boolean;
  hidePreciseLocations: boolean;
}

export interface Travelogue {
  schemaVersion: number;
  id: Id;
  title: string;
  createdAt: string;
  updatedAt: string;
  output: OutputSettings;
  cueProfile: CueProfile;
  chapters: Chapter[];
  sources: MediaSource[];
  media: MediaItem[];
  cues: Cue[];
  annotations: Annotation[];
  audioLanes: AudioLane[];
  mapView: MapViewSettings;
}

export const DEFAULT_CUE_PROFILE: CueProfile = {
  imageDurationSec: 4,
  videoMaxSec: 15,
  fadeInSec: 0.5,
  fadeOutSec: 0.5,
  titleCardSec: 3,
  defaultPlacement: 'fit',
};

export const OUTPUT_PRESETS: Record<AspectRatio, OutputSettings> = {
  '16:9': { width: 1920, height: 1080, fps: 30, aspect: '16:9' },
  '9:16': { width: 1080, height: 1920, fps: 30, aspect: '9:16' },
  '1:1': { width: 1080, height: 1080, fps: 30, aspect: '1:1' },
};

export const DEFAULT_MAP_VIEW: MapViewSettings = {
  enabled: false,
  corner: 'bottomRight',
  size: 0.2,
  shape: 'rect',
  style: 'light',
  tripOverview: true,
  transitionAnimation: true,
  hidePreciseLocations: false,
};

export const DEFAULT_AUDIO_LANES: AudioLane[] = [
  { id: 'lane-narration', kind: 'narration', volume: 1, mute: false, ducks: [{ laneId: 'lane-music', db: -12 }, { laneId: 'lane-clip', db: -12 }] },
  { id: 'lane-music', kind: 'music', volume: 0.7, mute: false, ducks: [] },
  { id: 'lane-clip', kind: 'clipSound', volume: 1, mute: false, ducks: [] },
];
