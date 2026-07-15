// state.ts — canonical project model (ported from state.js)
//
// Mirrors the Rust `Project` JSON shape from timeline_state.rs. All timestamps
// are microseconds (i64 in Rust, regular JS numbers here — safe up to ~2.5h).

import type {
  Project,
  Track,
  Clip,
  ClipTransform,
  ColourSettings,
  ClipMeta,
  ClipWithMeta,
  SavedState,
  BlendMode,
} from './types';
import { usToSec, deepEqual } from '../utils/helpers';

// ── Module state ────────────────────────────────────────────────────────
let project: Project | null = null;

// Display-only metadata per clip id. NOT sent to Rust — stripped by
// toRustJson(). Stores { name, isReal, thumbnails, picId }.
const clipMeta: Record<number, ClipMeta> = {};

// ── Default sub-objects (must match Rust struct field order) ─────────
function defaultTransform(): ClipTransform {
  return {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    anchor_x: 0.5,
    anchor_y: 0.5,
    blend_mode: 'normal' as BlendMode,
  };
}

function defaultColour(): ColourSettings {
  return {
    exposure: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    highlights: 0,
    shadows: 0,
    tint: 0,
    lift: [0, 0, 0],
    gamma: [0, 0, 0],
    gain: [0, 0, 0],
  };
}

function makeClip(
  id: number,
  sourceId: string,
  startUs: number,
  endUs: number,
): Clip {
  return {
    id,
    source_id: sourceId,
    group_id: null,
    timeline_start_us: startUs,
    timeline_end_us: endUs,
    source_start_us: 0,
    source_end_us: endUs - startUs,
    speed: 1.0,
    transform: defaultTransform(),
    colour_settings: defaultColour(),
    effects: [],
    caption_text: null,
    caption_style: null,
  };
}

// ── Project init ────────────────────────────────────────────────────────
function createEmptyProject(width: number, height: number): Project {
  return {
    id: 'proj_0',
    name: 'Untitled',
    width,
    height,
    frame_rate: { num: 30, den: 1 },
    colour_space: 'rec709',
    tracks: [
      {
        id: 0,
        order: 0,
        track_type: 'video',
        name: 'Video 1',
        muted: false,
        locked: false,
        visible: true,
        volume: 1.0,
        pan: 0.0,
        clips: [],
      },
      {
        id: 1,
        order: 1,
        track_type: 'audio',
        name: 'Audio 1',
        muted: false,
        locked: false,
        visible: true,
        volume: 1.0,
        pan: 0.0,
        clips: [],
      },
    ],
    duration_us: 0,
    next_clip_id: 1,
    next_track_id: 2,
    next_effect_id: 1,
  };
}

function init(width: number, height: number): void {
  project = createEmptyProject(width || 1920, height || 1080);
  for (const k of Object.keys(clipMeta)) delete clipMeta[k as unknown as number];
}

function isReady(): boolean {
  return project !== null;
}

// ── Track accessors ─────────────────────────────────────────────────────
function getVideoTrack(): Track | null {
  if (!project) return null;
  return project.tracks.find((t) => t.track_type === 'video') ?? null;
}

function getAudioTrack(): Track | null {
  if (!project) return null;
  return project.tracks.find((t) => t.track_type === 'audio') ?? null;
}

function getAllVideoClips(): ClipWithMeta[] {
  if (!project) return [];
  return project.tracks
    .filter((t) => t.track_type === 'video')
    .flatMap((t) =>
      t.clips.map((c) => ({ ...c, track_type: t.track_type } as ClipWithMeta)),
    );
}

// ── Clip accessors (return live refs from project.tracks) ───────────
function _mergeMeta(clip: Clip): ClipWithMeta {
  const meta = clipMeta[clip.id];
  const withMeta = clip as ClipWithMeta;
  if (meta) {
    withMeta.name = meta.name;
    withMeta.isReal = meta.isReal;
    withMeta.thumbnails = meta.thumbnails;
    withMeta.picId = meta.picId;
  }
  return withMeta;
}

function getVideoClips(): ClipWithMeta[] {
  const track = getVideoTrack();
  if (!track) return [];
  track.clips.forEach(_mergeMeta);
  return track.clips as ClipWithMeta[];
}

function getAudioClips(): ClipWithMeta[] {
  const track = getAudioTrack();
  if (!track) return [];
  track.clips.forEach(_mergeMeta);
  return track.clips as ClipWithMeta[];
}

// ── Clip CRUD ───────────────────────────────────────────────────────
function addVideoClip(
  sourceId: string,
  startUs: number,
  endUs: number,
  meta?: Record<string, unknown>,
  groupId?: string,
): ClipWithMeta | null {
  const track = getVideoTrack();
  if (!track || !project) return null;
  const id = project.next_clip_id++;
  const clip = makeClip(id, sourceId, startUs, endUs);
  clip.group_id = groupId ?? `group_${id}`;
  track.clips.push(clip);
  track.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
  clipMeta[id] = (meta as ClipMeta) ?? {};
  const merged = _mergeMeta(clip);
  computeDuration();
  return merged;
}

function addAudioClip(
  sourceId: string,
  startUs: number,
  endUs: number,
  meta?: Record<string, unknown>,
  groupId?: string,
): ClipWithMeta | null {
  const track = getAudioTrack();
  if (!track || !project) return null;
  const id = project.next_clip_id++;
  const clip = makeClip(id, sourceId, startUs, endUs);
  clip.group_id = groupId ?? `group_${id}`;
  track.clips.push(clip);
  track.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
  clipMeta[id] = (meta as ClipMeta) ?? {};
  const merged = _mergeMeta(clip);
  computeDuration();
  return merged;
}

function findClip(clipId: number): ClipWithMeta | null {
  if (!project) return null;
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip as ClipWithMeta;
  }
  return null;
}

function findClipTrack(clipId: number): Track | null {
  if (!project) return null;
  return project.tracks.find((t) => t.clips.some((c) => c.id === clipId)) ?? null;
}

function removeClip(clipId: number): boolean {
  const track = findClipTrack(clipId);
  if (!track) return false;
  const before = track.clips.length;
  track.clips = track.clips.filter((c) => c.id !== clipId);
  if (track.clips.length < before) {
    delete clipMeta[clipId];
    computeDuration();
    return true;
  }
  return false;
}

function splitClip(clipId: number, splitAtUs: number): number | null {
  const track = findClipTrack(clipId);
  if (!track || !project) return null;
  const idx = track.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return null;
  const clip = track.clips[idx]!;
  if (splitAtUs <= clip.timeline_start_us || splitAtUs >= clip.timeline_end_us)
    return null;

  const leftTimelineUs = splitAtUs - clip.timeline_start_us;
  const leftSourceUs = Math.round(leftTimelineUs / clip.speed);
  const rightSourceStart = clip.source_start_us + leftSourceUs;
  const origEndUs = clip.timeline_end_us;
  const origSourceEnd = clip.source_end_us;

  // Truncate left half
  clip.timeline_end_us = splitAtUs;
  clip.source_end_us = rightSourceStart;

  // Create right half with NEW group ID (independent from left)
  const newId = project.next_clip_id++;
  const right: Clip = {
    ...clip,
    id: newId,
    group_id: `group_${newId}`,
    timeline_start_us: splitAtUs,
    timeline_end_us: origEndUs,
    source_start_us: rightSourceStart,
    source_end_us: origSourceEnd,
  };
  track.clips.splice(idx + 1, 0, right);

  // Copy display meta to the new clip
  const meta = clipMeta[clipId];
  if (meta) {
    clipMeta[newId] = {
      ...meta,
      thumbnails: meta.thumbnails ? [...meta.thumbnails] : [],
    };
    _mergeMeta(right);
  }

  // Split linked clips too (same group_id)
  const linkedIds = getLinkedClipIds(clipId).filter((id) => id !== clipId);
  for (const linkedId of linkedIds) {
    splitClip(linkedId, splitAtUs);
  }

  computeDuration();
  return newId;
}

function moveClip(clipId: number, newStartUs: number): boolean {
  const clip = findClip(clipId);
  if (!clip) return false;
  const dur = clip.timeline_end_us - clip.timeline_start_us;
  const deltaUs = newStartUs - clip.timeline_start_us;

  clip.timeline_start_us = newStartUs;
  clip.timeline_end_us = newStartUs + dur;
  const track = findClipTrack(clipId);
  if (track) track.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);

  // Move linked clips too
  const linkedIds = getLinkedClipIds(clipId).filter((id) => id !== clipId);
  for (const linkedId of linkedIds) {
    const linkedClip = findClip(linkedId);
    if (linkedClip) {
      linkedClip.timeline_start_us += deltaUs;
      linkedClip.timeline_end_us += deltaUs;
      const linkedTrack = findClipTrack(linkedId);
      if (linkedTrack)
        linkedTrack.clips.sort(
          (a, b) => a.timeline_start_us - b.timeline_start_us,
        );
    }
  }

  computeDuration();
  return true;
}

function trimClip(
  clipId: number,
  newStartUs: number,
  newEndUs: number,
  newSourceStartUs: number,
): boolean {
  const clip = findClip(clipId);
  if (!clip) return false;
  if (newEndUs <= newStartUs) return false;

  const origStartUs = clip.timeline_start_us;
  const origEndUs = clip.timeline_end_us;
  const deltaStartUs = newStartUs - origStartUs;
  const deltaEndUs = newEndUs - origEndUs;

  clip.timeline_start_us = newStartUs;
  clip.timeline_end_us = newEndUs;
  clip.source_start_us = newSourceStartUs;
  const timelineUs = newEndUs - newStartUs;
  clip.source_end_us = newSourceStartUs + Math.round(timelineUs / clip.speed);
  const track = findClipTrack(clipId);
  if (track) track.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);

  // Trim linked clips too
  const linkedIds = getLinkedClipIds(clipId).filter((id) => id !== clipId);
  for (const linkedId of linkedIds) {
    const linkedClip = findClip(linkedId);
    if (linkedClip) {
      const linkedNewStart = linkedClip.timeline_start_us + deltaStartUs;
      const linkedNewEnd = linkedClip.timeline_end_us + deltaEndUs;
      const linkedNewSourceStart =
        linkedClip.source_start_us +
        Math.round(deltaStartUs / linkedClip.speed);
      trimClip(linkedId, linkedNewStart, linkedNewEnd, linkedNewSourceStart);
    }
  }

  computeDuration();
  return true;
}

function getLinkedClipIds(clipId: number): number[] {
  const clip = findClip(clipId);
  if (!clip || !clip.group_id || !project) return [];
  const groupId = clip.group_id;
  const linkedIds: number[] = [];

  for (const track of project.tracks) {
    for (const c of track.clips) {
      if (c.group_id === groupId && c.id !== clipId) {
        linkedIds.push(c.id);
      }
    }
  }

  return linkedIds;
}

function setClipMeta(
  clipId: number,
  metaPatch: Record<string, unknown>,
): void {
  const existing = clipMeta[clipId] ?? {};
  Object.assign(existing, metaPatch);
  clipMeta[clipId] = existing;
  const clip = findClip(clipId);
  if (clip) _mergeMeta(clip);
}

function getClipMeta(clipId: number): Record<string, unknown> | null {
  const meta = clipMeta[clipId];
  return meta ? JSON.parse(JSON.stringify(meta)) : null;
}

function computeDuration(): number {
  if (!project) return 0;
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.timeline_end_us > max) max = clip.timeline_end_us;
    }
  }
  project.duration_us = max;
  return max;
}

function getDurationSec(): number {
  return project ? usToSec(project.duration_us) : 0;
}

function getProject(): Project | null {
  return project;
}

// ── Undo/redo state snapshots ─────────────────────────────────────────
function saveState(): SavedState {
  return {
    project: JSON.parse(JSON.stringify(project)),
    clipMeta: JSON.parse(JSON.stringify(clipMeta)),
  };
}

function loadState(state: SavedState): void {
  project = state.project;
  for (const k of Object.keys(clipMeta)) delete clipMeta[k as unknown as number];
  Object.assign(clipMeta, state.clipMeta);
}

// ── Rust sync helpers ───────────────────────────────────────────────
function toRustJson(): string {
  if (!project) return '{}';
  const clean: Project = JSON.parse(JSON.stringify(project));
  for (const track of clean.tracks) {
    for (const clip of track.clips) {
      const c = clip as ClipWithMeta;
      delete c.name;
      delete c.isReal;
      delete c.thumbnails;
      delete c.picId;
    }
  }
  return JSON.stringify(clean);
}

function loadFromRustJson(json: string): void {
  project = JSON.parse(json);
  // clipMeta is NOT restored from Rust JSON — that's Task 5's job.
}

function verifyRoundTrip(rustJson: string, receivedJson: string): boolean {
  try {
    return deepEqual(JSON.parse(rustJson), JSON.parse(receivedJson));
  } catch {
    return false;
  }
}

// ── Public API ──────────────────────────────────────────────────────
export const IKState = {
  init,
  isReady,
  usToSec,
  secToUs: (s: number) => Math.round(s * 1_000_000),
  getVideoClips,
  getAudioClips,
  getAllVideoClips,
  addVideoClip,
  addAudioClip,
  findClip,
  findClipTrack,
  removeClip,
  splitClip,
  moveClip,
  trimClip,
  setClipMeta,
  getClipMeta,
  computeDuration,
  getDurationSec,
  toRustJson,
  loadFromRustJson,
  verifyRoundTrip,
  getProject,
  getLinkedClipIds,
  saveState,
  loadState,
};

// ── Attach to window for backward compat with ui.js ─────────────────
window.IKState = IKState;

// ── window.videoClips / window.audioClips as live getters ────────────
Object.defineProperty(window, 'videoClips', {
  get: () => window.IKState.getVideoClips(),
  configurable: true,
});
Object.defineProperty(window, 'audioClips', {
  get: () => window.IKState.getAudioClips(),
  configurable: true,
});
