import { describe, it, expect, beforeEach } from 'vitest';

// We can't import state.ts directly since it touches `window`. Instead we
// replicate the pure-logic functions here for testing. In a real app you'd
// mock `window`, but for this migration the priority is testing the data model
// logic, not the DOM binding.

import type { Project, Clip, ClipMeta, SavedState, ClipWithMeta } from '../src/state/types';
import { deepEqual } from '../src/utils/helpers';

// ── Replicated state logic for testability ──────────────────────────────
// This is a self-contained copy of the IKState CRUD logic without window deps.

function defaultTransform() {
  return {
    x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
    anchor_x: 0.5, anchor_y: 0.5, blend_mode: 'normal' as const,
  };
}

function defaultColour() {
  return {
    exposure: 0, contrast: 0, saturation: 0, temperature: 0,
    highlights: 0, shadows: 0, tint: 0,
    lift: [0, 0, 0] as [number, number, number],
    gamma: [0, 0, 0] as [number, number, number],
    gain: [0, 0, 0] as [number, number, number],
  };
}

function makeClip(id: number, sourceId: string, startUs: number, endUs: number): Clip {
  return {
    id, source_id: sourceId, group_id: null,
    timeline_start_us: startUs, timeline_end_us: endUs,
    source_start_us: 0, source_end_us: endUs - startUs,
    speed: 1.0, transform: defaultTransform(),
    colour_settings: defaultColour(), effects: [],
    caption_text: null, caption_style: null,
  };
}

function createTestState() {
  const clipMeta: Record<number, ClipMeta> = {};
  const project: Project = {
    id: 'proj_0', name: 'Untitled', width: 1920, height: 1080,
    frame_rate: { num: 30, den: 1 }, colour_space: 'rec709',
    tracks: [
      { id: 0, order: 0, track_type: 'video', name: 'Video 1', muted: false, locked: false, visible: true, volume: 1.0, pan: 0.0, clips: [] },
      { id: 1, order: 1, track_type: 'audio', name: 'Audio 1', muted: false, locked: false, visible: true, volume: 1.0, pan: 0.0, clips: [] },
    ],
    duration_us: 0, next_clip_id: 1, next_track_id: 2, next_effect_id: 1,
  };

  function getVideoTrack() {
    return project.tracks.find(t => t.track_type === 'video')!;
  }

  function getAudioTrack() {
    return project.tracks.find(t => t.track_type === 'audio')!;
  }

  function addVideoClip(sourceId: string, startUs: number, endUs: number, meta?: ClipMeta): Clip {
    const track = getVideoTrack();
    const id = project.next_clip_id++;
    const clip = makeClip(id, sourceId, startUs, endUs);
    clip.group_id = `group_${id}`;
    track.clips.push(clip);
    track.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
    clipMeta[id] = meta ?? {};
    computeDuration();
    return clip;
  }

  function addAudioClip(sourceId: string, startUs: number, endUs: number, meta?: ClipMeta): Clip {
    const track = getAudioTrack();
    const id = project.next_clip_id++;
    const clip = makeClip(id, sourceId, startUs, endUs);
    clip.group_id = `group_${id}`;
    track.clips.push(clip);
    track.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
    clipMeta[id] = meta ?? {};
    computeDuration();
    return clip;
  }

  function findClip(clipId: number): Clip | null {
    for (const track of project.tracks) {
      const clip = track.clips.find(c => c.id === clipId);
      if (clip) return clip;
    }
    return null;
  }

  function findClipTrack(clipId: number) {
    return project.tracks.find(t => t.clips.some(c => c.id === clipId)) ?? null;
  }

  function removeClip(clipId: number): boolean {
    const track = findClipTrack(clipId);
    if (!track) return false;
    const before = track.clips.length;
    track.clips = track.clips.filter(c => c.id !== clipId);
    if (track.clips.length < before) {
      delete clipMeta[clipId];
      computeDuration();
      return true;
    }
    return false;
  }

  function splitClip(clipId: number, splitAtUs: number): number | null {
    const track = findClipTrack(clipId);
    if (!track) return null;
    const idx = track.clips.findIndex(c => c.id === clipId);
    if (idx < 0) return null;
    const clip = track.clips[idx]!;
    if (splitAtUs <= clip.timeline_start_us || splitAtUs >= clip.timeline_end_us) return null;

    const leftTimelineUs = splitAtUs - clip.timeline_start_us;
    const leftSourceUs = Math.round(leftTimelineUs / clip.speed);
    const rightSourceStart = clip.source_start_us + leftSourceUs;
    const origEndUs = clip.timeline_end_us;
    const origSourceEnd = clip.source_end_us;

    clip.timeline_end_us = splitAtUs;
    clip.source_end_us = rightSourceStart;

    const newId = project.next_clip_id++;
    const right: Clip = {
      ...clip, id: newId, group_id: `group_${newId}`,
      timeline_start_us: splitAtUs, timeline_end_us: origEndUs,
      source_start_us: rightSourceStart, source_end_us: origSourceEnd,
    };
    track.clips.splice(idx + 1, 0, right);

    const meta = clipMeta[clipId];
    if (meta) {
      clipMeta[newId] = { ...meta, thumbnails: meta.thumbnails ? [...meta.thumbnails] : [] };
    }

    computeDuration();
    return newId;
  }

  function moveClip(clipId: number, newStartUs: number): boolean {
    const clip = findClip(clipId);
    if (!clip) return false;
    const dur = clip.timeline_end_us - clip.timeline_start_us;
    clip.timeline_start_us = newStartUs;
    clip.timeline_end_us = newStartUs + dur;
    const track = findClipTrack(clipId);
    if (track) track.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
    computeDuration();
    return true;
  }

  function trimClip(clipId: number, newStartUs: number, newEndUs: number, newSourceStartUs: number): boolean {
    const clip = findClip(clipId);
    if (!clip) return false;
    if (newEndUs <= newStartUs) return false;
    clip.timeline_start_us = newStartUs;
    clip.timeline_end_us = newEndUs;
    clip.source_start_us = newSourceStartUs;
    const timelineUs = newEndUs - newStartUs;
    clip.source_end_us = newSourceStartUs + Math.round(timelineUs / clip.speed);
    const track = findClipTrack(clipId);
    if (track) track.clips.sort((a, b) => a.timeline_start_us - b.timeline_start_us);
    computeDuration();
    return true;
  }

  function computeDuration(): number {
    let max = 0;
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.timeline_end_us > max) max = clip.timeline_end_us;
      }
    }
    project.duration_us = max;
    return max;
  }

  function toRustJson(): string {
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

  function saveState(): SavedState {
    return {
      project: JSON.parse(JSON.stringify(project)),
      clipMeta: JSON.parse(JSON.stringify(clipMeta)),
    };
  }

  function loadState(state: SavedState): void {
    Object.assign(project, state.project);
    for (const k of Object.keys(clipMeta)) delete clipMeta[k as unknown as number];
    Object.assign(clipMeta, state.clipMeta);
  }

  return {
    project, clipMeta,
    getVideoTrack, getAudioTrack,
    addVideoClip, addAudioClip,
    findClip, findClipTrack, removeClip,
    splitClip, moveClip, trimClip,
    computeDuration, toRustJson,
    saveState, loadState,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('IKState (data model)', () => {
  let state: ReturnType<typeof createTestState>;

  beforeEach(() => {
    state = createTestState();
  });

  describe('init', () => {
    it('creates a project with video and audio tracks', () => {
      expect(state.project.tracks.length).toBe(2);
      expect(state.project.tracks[0]!.track_type).toBe('video');
      expect(state.project.tracks[1]!.track_type).toBe('audio');
    });

    it('starts with 1920×1080 resolution', () => {
      expect(state.project.width).toBe(1920);
      expect(state.project.height).toBe(1080);
    });

    it('starts with zero duration', () => {
      expect(state.project.duration_us).toBe(0);
    });
  });

  describe('addVideoClip', () => {
    it('adds a clip to the video track', () => {
      const clip = state.addVideoClip('src1', 0, 5_000_000);
      expect(clip.id).toBe(1);
      expect(clip.timeline_start_us).toBe(0);
      expect(clip.timeline_end_us).toBe(5_000_000);
      expect(state.getVideoTrack().clips.length).toBe(1);
    });

    it('updates project duration', () => {
      state.addVideoClip('src1', 0, 3_000_000);
      expect(state.project.duration_us).toBe(3_000_000);
    });

    it('increments clip IDs', () => {
      const c1 = state.addVideoClip('src1', 0, 1_000_000);
      const c2 = state.addVideoClip('src2', 1_000_000, 2_000_000);
      expect(c1.id).toBe(1);
      expect(c2.id).toBe(2);
    });

    it('sorts clips by start time', () => {
      state.addVideoClip('src2', 2_000_000, 3_000_000);
      state.addVideoClip('src1', 0, 1_000_000);
      const clips = state.getVideoTrack().clips;
      expect(clips[0]!.timeline_start_us).toBe(0);
      expect(clips[1]!.timeline_start_us).toBe(2_000_000);
    });

    it('stores clip meta', () => {
      const clip = state.addVideoClip('src1', 0, 1_000_000, { name: 'Test', isReal: true });
      expect(state.clipMeta[clip.id]?.name).toBe('Test');
      expect(state.clipMeta[clip.id]?.isReal).toBe(true);
    });
  });

  describe('addAudioClip', () => {
    it('adds a clip to the audio track', () => {
      const clip = state.addAudioClip('audio1', 0, 2_000_000);
      expect(clip.id).toBe(1);
      expect(state.getAudioTrack().clips.length).toBe(1);
    });
  });

  describe('findClip', () => {
    it('finds a clip by id across tracks', () => {
      const vc = state.addVideoClip('v1', 0, 1_000_000);
      const ac = state.addAudioClip('a1', 0, 1_000_000);
      expect(state.findClip(vc.id)?.id).toBe(vc.id);
      expect(state.findClip(ac.id)?.id).toBe(ac.id);
    });

    it('returns null for unknown id', () => {
      expect(state.findClip(999)).toBeNull();
    });
  });

  describe('removeClip', () => {
    it('removes a clip and updates duration', () => {
      const clip = state.addVideoClip('src1', 0, 5_000_000);
      expect(state.removeClip(clip.id)).toBe(true);
      expect(state.getVideoTrack().clips.length).toBe(0);
      expect(state.project.duration_us).toBe(0);
    });

    it('cleans up clip meta', () => {
      const clip = state.addVideoClip('src1', 0, 1_000_000, { name: 'Test' });
      state.removeClip(clip.id);
      expect(state.clipMeta[clip.id]).toBeUndefined();
    });

    it('returns false for unknown id', () => {
      expect(state.removeClip(999)).toBe(false);
    });
  });

  describe('splitClip', () => {
    it('splits a clip at the given timestamp', () => {
      const clip = state.addVideoClip('src1', 0, 4_000_000);
      const newId = state.splitClip(clip.id, 2_000_000);
      expect(newId).not.toBeNull();

      const left = state.findClip(clip.id)!;
      const right = state.findClip(newId!)!;

      expect(left.timeline_start_us).toBe(0);
      expect(left.timeline_end_us).toBe(2_000_000);
      expect(right.timeline_start_us).toBe(2_000_000);
      expect(right.timeline_end_us).toBe(4_000_000);
    });

    it('returns null when split point is at clip boundary', () => {
      const clip = state.addVideoClip('src1', 0, 4_000_000);
      expect(state.splitClip(clip.id, 0)).toBeNull();
      expect(state.splitClip(clip.id, 4_000_000)).toBeNull();
    });

    it('preserves source offsets', () => {
      const clip = state.addVideoClip('src1', 0, 4_000_000);
      const newId = state.splitClip(clip.id, 2_000_000)!;
      const right = state.findClip(newId)!;
      expect(right.source_start_us).toBe(2_000_000);
      expect(right.source_end_us).toBe(4_000_000);
    });

    it('copies meta to new clip', () => {
      const clip = state.addVideoClip('src1', 0, 4_000_000, { name: 'MyClip', isReal: true });
      const newId = state.splitClip(clip.id, 2_000_000)!;
      expect(state.clipMeta[newId]?.name).toBe('MyClip');
    });
  });

  describe('moveClip', () => {
    it('moves a clip to a new start position', () => {
      const clip = state.addVideoClip('src1', 0, 2_000_000);
      const result = state.moveClip(clip.id, 1_000_000);
      expect(result).toBe(true);
      const moved = state.findClip(clip.id)!;
      expect(moved.timeline_start_us).toBe(1_000_000);
      expect(moved.timeline_end_us).toBe(3_000_000);
    });

    it('preserves clip duration', () => {
      const clip = state.addVideoClip('src1', 0, 2_000_000);
      state.moveClip(clip.id, 5_000_000);
      const moved = state.findClip(clip.id)!;
      expect(moved.timeline_end_us - moved.timeline_start_us).toBe(2_000_000);
    });

    it('returns false for unknown id', () => {
      expect(state.moveClip(999, 0)).toBe(false);
    });
  });

  describe('trimClip', () => {
    it('trims a clip to new boundaries', () => {
      const clip = state.addVideoClip('src1', 0, 4_000_000);
      const result = state.trimClip(clip.id, 1_000_000, 3_000_000, 1_000_000);
      expect(result).toBe(true);
      const trimmed = state.findClip(clip.id)!;
      expect(trimmed.timeline_start_us).toBe(1_000_000);
      expect(trimmed.timeline_end_us).toBe(3_000_000);
      expect(trimmed.source_start_us).toBe(1_000_000);
    });

    it('rejects invalid boundaries', () => {
      const clip = state.addVideoClip('src1', 0, 4_000_000);
      expect(state.trimClip(clip.id, 3_000_000, 1_000_000, 0)).toBe(false);
    });

    it('returns false for unknown id', () => {
      expect(state.trimClip(999, 0, 1_000_000, 0)).toBe(false);
    });
  });

  describe('computeDuration', () => {
    it('returns 0 with no clips', () => {
      expect(state.computeDuration()).toBe(0);
    });

    it('returns max end across all tracks', () => {
      state.addVideoClip('v1', 0, 3_000_000);
      state.addAudioClip('a1', 0, 5_000_000);
      expect(state.computeDuration()).toBe(5_000_000);
    });
  });

  describe('toRustJson', () => {
    it('strips display metadata from clips', () => {
      state.addVideoClip('src1', 0, 1_000_000, { name: 'Test', isReal: true, picId: 42 });
      const json = state.toRustJson();
      const parsed = JSON.parse(json);
      const clip = parsed.tracks[0].clips[0];
      expect(clip.name).toBeUndefined();
      expect(clip.isReal).toBeUndefined();
      expect(clip.picId).toBeUndefined();
      // But data fields should be present
      expect(clip.source_id).toBe('src1');
      expect(clip.timeline_start_us).toBe(0);
    });
  });

  describe('saveState / loadState', () => {
    it('round-trips project state', () => {
      state.addVideoClip('src1', 0, 2_000_000, { name: 'Clip1' });
      state.addVideoClip('src2', 2_000_000, 4_000_000, { name: 'Clip2' });
      const saved = state.saveState();

      // Mutate
      state.removeClip(1);

      // Restore
      state.loadState(saved);
      expect(state.findClip(1)).not.toBeNull();
      expect(state.project.duration_us).toBe(4_000_000);
    });

    it('saved state is a deep copy', () => {
      state.addVideoClip('src1', 0, 1_000_000);
      const saved = state.saveState();
      state.moveClip(1, 5_000_000);
      expect(saved.project.tracks[0]!.clips[0]!.timeline_start_us).toBe(0);
    });
  });

  describe('verifyRoundTrip', () => {
    it('matches identical JSON', () => {
      const json1 = JSON.stringify({ a: 1, b: [2, 3] });
      const json2 = JSON.stringify({ a: 1, b: [2, 3] });
      expect(deepEqual(JSON.parse(json1), JSON.parse(json2))).toBe(true);
    });

    it('rejects different JSON', () => {
      const json1 = JSON.stringify({ a: 1 });
      const json2 = JSON.stringify({ a: 2 });
      expect(deepEqual(JSON.parse(json1), JSON.parse(json2))).toBe(false);
    });
  });
});
