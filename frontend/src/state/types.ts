// ── Project data model types ────────────────────────────────────────────
// Mirrors the Rust `Project` JSON shape from timeline_state.rs.
// All timestamps are microseconds (i64 in Rust, number in JS — safe up to ~2.5h).

export type TrackType = 'video' | 'audio' | 'caption';

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'soft_light'
  | 'hard_light';

export type ColourSpace = 'rec709' | 'rec2020' | 'srgb';

export interface Rational {
  num: number;
  den: number;
}

export interface ClipTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  anchor_x: number;
  anchor_y: number;
  blend_mode: BlendMode;
}

export interface ColourSettings {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  highlights: number;
  shadows: number;
  tint: number;
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
}

export interface CaptionStyle {
  font: string;
  size: number;
  colour: string;
  bg_opacity: number;
  position: 'lower-third' | 'center' | 'top';
  start_us: number;
  end_us: number;
  text: string;
}

export interface Effect {
  id: number;
  effect_type: string;
  params: Record<string, unknown>;
  enabled: boolean;
}

export interface Clip {
  id: number;
  source_id: string;
  group_id: string | null;
  timeline_start_us: number;
  timeline_end_us: number;
  source_start_us: number;
  source_end_us: number;
  speed: number;
  transform: ClipTransform;
  colour_settings: ColourSettings;
  effects: Effect[];
  caption_text: string | null;
  caption_style: CaptionStyle | null;
}

/** Display-only metadata per clip id. NOT sent to Rust. */
export interface ClipMeta {
  name?: string;
  isReal?: boolean;
  thumbnails?: ThumbnailEntry[];
  picId?: number;
}

export interface ThumbnailEntry {
  ms: number;
  dataUrl: string;
}

/** A clip with display metadata merged in (for UI consumption). */
export interface ClipWithMeta extends Clip {
  name?: string;
  isReal?: boolean;
  thumbnails?: ThumbnailEntry[];
  picId?: number;
  track_type?: TrackType;
}

export interface Track {
  id: number;
  order: number;
  track_type: TrackType;
  name: string;
  muted: boolean;
  locked: boolean;
  visible: boolean;
  volume: number;
  pan: number;
  clips: Clip[];
}

export interface Project {
  id: string;
  name: string;
  width: number;
  height: number;
  frame_rate: Rational;
  colour_space: ColourSpace;
  tracks: Track[];
  duration_us: number;
  next_clip_id: number;
  next_track_id: number;
  next_effect_id: number;
}

export interface SavedState {
  project: Project;
  clipMeta: Record<number, ClipMeta>;
}
