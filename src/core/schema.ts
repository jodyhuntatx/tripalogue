/**
 * TripAlogue project schema (PRD Section 3).
 *
 * One Travelogue = one project, stored on the server with its operation log
 * and version history, and exportable as one JSON file. Original media lives
 * in object storage, referenced by storage key; the project holds references
 * plus cues, never the media itself. Entities that later phases fill in (map
 * view, audio lanes, annotations) are present already so the format does not
 * churn phase to phase.
 *
 * v2 (web): upload-based sources, media storage fields, fractional order keys
 * for cues, and per-entity attribution for multi-author editing.
 */

export const SCHEMA_VERSION = 2;
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
  /** Legacy: no longer applied. Videos play in full unless their cue trims them. */
  videoMaxSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  titleCardSec: number;
  defaultPlacement: PlacementMode;
}

export type TitleLayout = 'center' | 'left' | 'lower';

/** A chapter's title card (IT-5; PE-15 edits it). Absent text fields fall back to the chapter's own. */
export interface TitleCard {
  enabled: boolean;
  /** Overrides the cue profile's titleCardSec when set. */
  durationSec?: number;
  /** Text on the card instead of the chapter title. */
  title?: string;
  /** Instead of "place · dates". */
  subtitle?: string;
  /** Instead of the chapter's "What happened here"; an empty string hides it. */
  description?: string;
  layout?: TitleLayout;
  /** A photo (or a video's first frame) behind the text, dimmed. */
  backgroundItemId?: Id;
}

/** Who last changed an entity, set by the server when it applies an operation. */
export interface Attribution {
  updatedBy?: Id;
  updatedAt?: string;
}

export interface Chapter extends Attribution {
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
  /** MV-3: the map inset in this chapter (absent = as the travelogue). */
  mapInset?: 'on' | 'off';
  /** PE-18: photo credits in this chapter (absent = as the travelogue). */
  credits?: 'on' | 'off';
}

/** upload = files uploaded through the browser (or the import tool). */
export type SourceType = 'upload' | 'googlePhotos' | 'cloudDrive' | 'uploadLink';

export interface MediaSource {
  id: Id;
  type: SourceType;
  displayName: string;
  /** Import only: folder (relative to the imported project file) where this source's files were found. */
  rootPath?: string;
  /** Opaque reference to a server-held, encrypted OAuth grant; never a credential. */
  authRef?: string;
  /** The traveler whose photos these are (MM-16): an id in Travelogue.travelers. */
  contributorId?: Id;
  /** Added to captured-at to correct a wrong camera clock (MM-4). */
  clockOffsetSec: number;
  /** Uploads are grouped per person and camera ("Canon EOS R6"), since clock errors belong to a camera, not a person. */
  camera?: string;
}

export type MediaKind = 'image' | 'video' | 'audio';
export type TimestampConfidence = 'high' | 'low';
/** Absent = ready (hand-written projects). pending = waiting for its upload. */
export type MediaStatus = 'pending' | 'uploading' | 'processing' | 'ready' | 'failed';

export interface MediaAssets {
  thumb?: string;
  proxy?: string;
  /** Full-resolution JPEG made from a HEIC/HEIF original (the original is kept as uploaded). */
  jpeg?: string;
}

export interface MediaItem extends Attribution {
  id: Id;
  sourceId: Id;
  /** Original file name or path as uploaded (display and import matching only). */
  uri: string;
  /** Object-storage key of the unaltered original. */
  storageKey?: string;
  /** sha256 of the original, hex. */
  contentHash?: string;
  /** Quick fingerprint (size + samples, see samplehash.ts) used to skip files already uploaded (MM-7). */
  sampleHash?: string;
  sizeBytes?: number;
  uploadedBy?: Id;
  status?: MediaStatus;
  /** Storage keys of derived files, always rebuildable from the original. */
  assets?: MediaAssets;
  error?: string;
  kind: MediaKind;
  capturedAt?: string;
  /** The file's last-modified time as the uploader's computer reported it: the fallback capture time (low confidence). */
  fileModifiedAt?: string;
  userTimestamp?: string;
  timestampConfidence?: TimestampConfidence;
  location?: LatLng;
  width?: number;
  height?: number;
  durationSec?: number;
  /** null = Unassigned bin. */
  chapterId: Id | null;
  /**
   * PE-3: moved to its chapter by hand without changing its time. The assignment rule leaves it there until its
   * time is changed.
   */
  chapterLocked?: boolean;
}

export type PlacementMode = 'fit' | 'fill' | 'custom';

export interface Placement {
  mode: PlacementMode;
  /** Required when mode = custom. */
  rect?: NormRect;
}

/**
 * PE-10, PE-12, PE-16. Entrances: cut, fade (from black), slide (in from a side), zoom (grows in), crossfade (over
 * the item before, which it overlaps by durationSec). Exits: cut, fade (to black), slide (out to a side).
 */
export type TransitionType = 'cut' | 'fade' | 'slide' | 'zoom' | 'crossfade';
export type Direction = 'left' | 'right' | 'up' | 'down';

export interface Transition {
  type: TransitionType;
  durationSec: number;
  /** Slide: the side it comes in from (entrance; default right) or leaves towards (exit; default left). */
  direction?: Direction;
}

/**
 * PE-11 Ken Burns: the part of the picture in view at the start and at the end (fractions of the picture), moving
 * smoothly between them. `auto` marks a motion TripAlogue chose.
 */
export type Animation = { type: 'none' } | { type: 'kenBurns'; from: NormRect; to: NormRect; auto?: boolean };

/** offsetSec: seconds after the anchor; an item anchor may be negative (the clip leads in before its item). */
export type AudioAnchor =
  | { type: 'item'; itemId: Id; offsetSec: number }
  | { type: 'chapterTime'; chapterId: Id; offsetSec: number };

/**
 * An audio item placed on a lane (AU-1). The clip starts at its anchor plus offsetSec: a visual item's start
 * (it moves with that item) or a time from the start of a chapter (AU-2). Its cue's inPointSec, outPointSec and
 * volume trim and level it (AU-3).
 */
export interface AudioCue {
  laneId: Id;
  anchor: AudioAnchor;
  fadeInSec: number;
  fadeOutSec: number;
  duck: boolean;
  /**
   * Keep playing past the end of its chapter, into the next ones, until the clip's own end (its out-point), the next
   * clip on the same lane, or the end of the travelogue. Absent or false: the clip stops when its chapter ends.
   */
  spanChapters?: boolean;
  /** AU-8: repeat the trimmed part until the clip stops (its chapter's end, the next clip, or the travelogue's end). */
  loop?: boolean;
  /** AU-7: overlap the clip before it on the lane by this clip's fade-in, so one fades out as this fades in. */
  crossfade?: boolean;
}

export interface Cue extends Attribution {
  itemId: Id;
  included: boolean;
  /** Fractional order key within the item's chapter (see fractional.ts). */
  order: string;
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
  /** PE-13: the video's own sound is silent. */
  mute?: boolean;
  /** MV-3: the map inset while this item is on screen (absent = as its chapter). */
  mapInset?: 'on' | 'off';
  audio?: AudioCue;
}

/** PE-14: what an annotation says. Place and date fill themselves in from the item unless text is typed. */
export type AnnotationKind = 'caption' | 'place' | 'date';
/** Style presets (see render-model ANNOTATION_STYLES). */
export type AnnotationStyle = 'subtitle' | 'lowerThird' | 'headline' | 'stamp' | 'tag';

export interface Annotation {
  id: Id;
  target: { type: 'item'; itemId: Id } | { type: 'chapter'; chapterId: Id };
  /** Absent = caption. */
  kind?: AnnotationKind;
  text: string;
  style: AnnotationStyle | string;
  /** Where the text sits on the stage (fractions of the frame). */
  position: NormRect;
  /** Seconds after the item starts. */
  startSec: number;
  /** How long it shows; 0 = until the item ends. */
  durationSec: number;
}

/** PE-17: a saved set of cues to apply to other items. */
export interface CuePreset {
  id: Id;
  name: string;
  cue: CueStyle;
}

/** The parts of a cue that copy, paste and presets carry (not order, inclusion, trims or the item itself). */
export type CueStyle = Partial<Pick<Cue, 'durationSec' | 'placement' | 'entrance' | 'exit' | 'animation' | 'speed' | 'volume' | 'mute'>>;

export type AudioLaneKind = 'narration' | 'music' | 'clipSound';

export interface AudioLane {
  id: Id;
  kind: AudioLaneKind;
  volume: number;
  mute: boolean;
  /** AU-3: when any lane is soloed, only soloed lanes are heard. */
  solo?: boolean;
  /** Lanes this lane lowers while it plays, and by how many dB. */
  ducks: { laneId: Id; db: number }[];
}

export type InsetCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export type MapStyle = 'light' | 'dark' | 'terrain';

export interface MapViewSettings {
  enabled: boolean;
  corner: InsetCorner;
  /** Fraction of frame width, 0.1..0.3 (MV-3). */
  size: number;
  shape: 'rect' | 'circle';
  style: MapStyle;
  tripOverview: boolean;
  transitionAnimation: boolean;
  /** Item dots are drawn at their chapter's place, not where they were taken. */
  hidePreciseLocations: boolean;
  /**
   * MV-6: chapter transitions. inset: the inset travels along the route and zooms in while the title card shows;
   * fullFrame: the map fills the frame for durationSec before each chapter. Absent = inset, 3 s.
   */
  transition?: { mode: 'inset' | 'fullFrame'; durationSec: number };
  /** MV-8: language for place labels, where the tile provider offers it (BCP-47, e.g. "en"); absent = local names. */
  labelLanguage?: string;
  /** MV-5: show "Chapter 3 of 8" on the map. Absent = on. */
  chapterLabel?: boolean;
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
  /** People whose photos and videos are in the travelogue (MM-16); sources name them. */
  travelers?: Traveler[];
  /** PE-9: the length the user is aiming for, in seconds; runtime is shown against it. */
  targetSec?: number;
  /** PE-17: saved cue presets. */
  cuePresets?: CuePreset[];
  /** PE-18: "Photo: Ana" on items a traveler sent (absent = off); chapters can override. */
  credits?: boolean;
  /**
   * The Removed bin: items taken out of the travelogue, with the cue they had, so they can be put back. They are
   * deleted for good (and their files erased) by hand or a set number of days after removal.
   */
  removed?: RemovedItem[];
}

/** Someone on the trip who sent photos or videos. Just a name: TripAlogue has one user, on this computer. */
export interface Traveler {
  id: Id;
  name: string;
  /** Optional, for "Open in email" when asking them for originals. */
  email?: string;
}

export interface RemovedItem {
  item: MediaItem;
  cue?: Cue;
  removedAt: string;
  removedBy?: Id;
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
  enabled: true,
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
