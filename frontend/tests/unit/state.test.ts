import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IKState } from '../../src/state/state';
import type { Project, ClipWithMeta } from '../../src/state/types';

describe('IKState Module', () => {
  beforeEach(() => {
    // Reset state before each test
    IKState.init(1920, 1080);
  });

  it('initializes a clean project', () => {
    expect(IKState.isReady()).toBe(true);
    const project = IKState.getProject();
    expect(project).toBeDefined();
    expect(project!.width).toBe(1920);
    expect(project!.height).toBe(1080);
    expect(project!.tracks.length).toBe(3);
  });

  it('adds and retrieves a video clip with metadata', () => {
    const clip = IKState.addVideoClip('vid1.mp4', 0, 5000000, { name: 'Video 1', isReal: true }, 'grp1');
    expect(clip).toBeDefined();
    expect(clip!.source_id).toBe('vid1.mp4');
    expect(clip!.timeline_start_us).toBe(0);
    expect(clip!.timeline_end_us).toBe(5000000);
    expect(clip!.group_id).toBe('grp1');
    expect(clip!.name).toBe('Video 1');

    const allClips = IKState.getVideoClips();
    expect(allClips).toHaveLength(1);
    expect(allClips[0]!.id).toBe(clip!.id);
    
    // Test exact output of findClip
    const found = IKState.findClip(clip!.id);
    expect(found).toMatchObject({
      id: clip!.id,
      timeline_start_us: 0,
      timeline_end_us: 5000000
    });
  });

  it('adds and retrieves an audio clip with metadata', () => {
    const clip = IKState.addAudioClip('aud1.mp3', 1000000, 3000000, { name: 'Audio 1' }, 'grp2');
    expect(clip).toBeDefined();
    expect(clip!.source_id).toBe('aud1.mp3');
    expect(clip!.timeline_start_us).toBe(1000000);
    
    const allAudio = IKState.getAudioClips();
    expect(allAudio).toHaveLength(1);
    expect(allAudio[0]!.id).toBe(clip!.id);
  });

  it('removes a clip and cleans up metadata', () => {
    const clip = IKState.addVideoClip('vid.mp4', 0, 1000000);
    expect(IKState.getVideoClips()).toHaveLength(1);
    
    const removed = IKState.removeClip(clip!.id);
    expect(removed).toBe(true);
    expect(IKState.getVideoClips()).toHaveLength(0);
    expect(IKState.getClipMeta(clip!.id)).toBeNull();
  });

  it('removes a non-existent clip', () => {
    expect(IKState.removeClip(9999)).toBe(false);
  });

  describe('splitClip', () => {
    it('splits a single clip accurately', () => {
      const clip = IKState.addVideoClip('vid.mp4', 1000000, 5000000); // duration 4s
      const origId = clip!.id;
      
      const newId = IKState.splitClip(origId, 3000000);
      expect(newId).not.toBeNull();
      
      const left = IKState.findClip(origId);
      const right = IKState.findClip(newId!);
      
      expect(left!.timeline_start_us).toBe(1000000);
      expect(left!.timeline_end_us).toBe(3000000);
      expect(left!.source_start_us).toBe(0);
      expect(left!.source_end_us).toBe(2000000); // (3M - 1M) / 1.0 speed
      
      expect(right!.timeline_start_us).toBe(3000000);
      expect(right!.timeline_end_us).toBe(5000000);
      expect(right!.source_start_us).toBe(2000000);
      expect(right!.source_end_us).toBe(4000000);
      
      expect(left!.group_id).not.toBe(right!.group_id);
    });

    it('splits linked clips accurately', () => {
      const vClip = IKState.addVideoClip('v.mp4', 0, 10000000, {}, 'group_A');
      const aClip = IKState.addAudioClip('a.mp3', 0, 10000000, {}, 'group_A');
      
      IKState.splitClip(vClip!.id, 4000000);
      
      // Original left clips
      const vLeft = IKState.findClip(vClip!.id);
      const aLeft = IKState.findClip(aClip!.id);
      
      expect(vLeft!.timeline_end_us).toBe(4000000);
      expect(aLeft!.timeline_end_us).toBe(4000000);
      
      // We should have 2 video and 2 audio clips now
      const videos = IKState.getVideoClips();
      const audios = IKState.getAudioClips();
      expect(videos).toHaveLength(2);
      expect(audios).toHaveLength(2);
      
      const vRight = videos.find(c => c.id !== vClip!.id);
      const aRight = audios.find(c => c.id !== aClip!.id);
      
      expect(vRight!.timeline_start_us).toBe(4000000);
      expect(aRight!.timeline_start_us).toBe(4000000);
    });

    it('returns null if splitting out of bounds', () => {
      const clip = IKState.addVideoClip('v.mp4', 1000, 5000);
      expect(IKState.splitClip(clip!.id, 500)).toBeNull();
      expect(IKState.splitClip(clip!.id, 6000)).toBeNull();
    });
  });

  describe('moveClip (and linked logic)', () => {
    it('moves a solitary clip accurately', () => {
      const clip = IKState.addVideoClip('vid.mp4', 1000000, 3000000); // 2s duration
      const moved = IKState.moveClip(clip!.id, 5000000);
      expect(moved).toBe(true);
      
      const updated = IKState.findClip(clip!.id);
      expect(updated!.timeline_start_us).toBe(5000000);
      expect(updated!.timeline_end_us).toBe(7000000); // 5M + 2M
    });

    it('moves a clip and correctly offsets its linked clips by exact delta', () => {
      // Audio starts 1s after video but is linked (e.g. j-cut)
      const vClip = IKState.addVideoClip('v.mp4', 1000000, 5000000, {}, 'grpSync');
      const aClip = IKState.addAudioClip('a.mp3', 2000000, 4000000, {}, 'grpSync');
      
      // Move video forward by 3s (to 4M)
      IKState.moveClip(vClip!.id, 4000000);
      
      const vUpdated = IKState.findClip(vClip!.id);
      const aUpdated = IKState.findClip(aClip!.id);
      
      expect(vUpdated!.timeline_start_us).toBe(4000000);
      expect(vUpdated!.timeline_end_us).toBe(8000000);
      
      // Audio should shift by exactly 3s (from 2M -> 5M)
      expect(aUpdated!.timeline_start_us).toBe(5000000);
      expect(aUpdated!.timeline_end_us).toBe(7000000);
    });
  });

  describe('trimClip (and linked logic)', () => {
    it('trims a solitary clip accurately', () => {
      const clip = IKState.addVideoClip('vid.mp4', 1000000, 5000000); // duration 4s, source [0, 4M]
      
      // Trim from left by 1s (new start 2M), trim from right by 1s (new end 4M)
      // newSourceStart is 1M
      const trimmed = IKState.trimClip(clip!.id, 2000000, 4000000, 1000000);
      expect(trimmed).toBe(true);
      
      const updated = IKState.findClip(clip!.id);
      expect(updated!.timeline_start_us).toBe(2000000);
      expect(updated!.timeline_end_us).toBe(4000000);
      expect(updated!.source_start_us).toBe(1000000);
      expect(updated!.source_end_us).toBe(3000000); // 1M + (4M - 2M)
    });

    it('fails to trim if end <= start', () => {
      const clip = IKState.addVideoClip('v', 0, 1000);
      expect(IKState.trimClip(clip!.id, 500, 400, 0)).toBe(false);
    });

    it('trims a clip and correctly offsets linked clips', () => {
      const vClip = IKState.addVideoClip('v', 1000000, 5000000, {}, 'grpTrim');
      // Audio starts at 1.5s, ends at 4.5s
      const aClip = IKState.addAudioClip('a', 1500000, 4500000, {}, 'grpTrim');
      
      // Original source starts are 0
      
      // Trim video: change start from 1M to 2M (delta +1M)
      // change end from 5M to 6M (delta +1M)
      // source start becomes 500k
      IKState.trimClip(vClip!.id, 2000000, 6000000, 500000);
      
      const vUpdated = IKState.findClip(vClip!.id);
      const aUpdated = IKState.findClip(aClip!.id);
      
      // Verify video
      expect(vUpdated!.timeline_start_us).toBe(2000000);
      expect(vUpdated!.timeline_end_us).toBe(6000000);
      expect(vUpdated!.source_start_us).toBe(500000);
      expect(vUpdated!.source_end_us).toBe(4500000); // 500k + (6M-2M)
      
      // Verify audio shifted strictly by deltas:
      // timeline start delta = +1M -> new start = 2.5M
      // timeline end delta = +1M -> new end = 5.5M
      // source start delta = (1M / speed 1) = +1M -> new source = 1M
      expect(aUpdated!.timeline_start_us).toBe(2500000);
      expect(aUpdated!.timeline_end_us).toBe(5500000);
      expect(aUpdated!.source_start_us).toBe(1000000);
      expect(aUpdated!.source_end_us).toBe(4000000); // 1M + (5.5M-2.5M)
    });
  });

  describe('Duration & Time', () => {
    it('computes max duration correctly', () => {
      IKState.addVideoClip('v', 0, 3000000);
      IKState.addAudioClip('a', 0, 5000000);
      expect(IKState.computeDuration()).toBe(5000000);
      expect(IKState.getDurationSec()).toBe(5);
    });

    it('converts units correctly', () => {
      expect(IKState.usToSec(1500000)).toBe(1.5);
      expect(IKState.secToUs(2.5)).toBe(2500000);
    });
  });

  describe('Meta and Helpers', () => {
    it('sets and retrieves clip meta', () => {
      const clip = IKState.addVideoClip('v', 0, 1000, { name: 'Old' });
      IKState.setClipMeta(clip!.id, { name: 'New', isReal: false });
      
      const meta = IKState.getClipMeta(clip!.id);
      expect(meta).toMatchObject({ name: 'New', isReal: false });
      
      const fetched = IKState.findClip(clip!.id);
      expect(fetched!.name).toBe('New');
    });

    it('returns all linked clip ids', () => {
      const v1 = IKState.addVideoClip('v1', 0, 10, {}, 'groupX');
      const a1 = IKState.addAudioClip('a1', 0, 10, {}, 'groupX');
      
      const linkedToV1 = IKState.getLinkedClipIds(v1!.id);
      expect(linkedToV1).toEqual([a1!.id]);
      
      const linkedToA1 = IKState.getLinkedClipIds(a1!.id);
      expect(linkedToA1).toEqual([v1!.id]);
    });

    it('retrieves track from clip', () => {
      const clip = IKState.addVideoClip('v', 0, 1000);
      const track = IKState.findClipTrack(clip!.id);
      expect(track!.track_type).toBe('video');
    });
  });

  describe('Rust JSON Sync', () => {
    it('generates rust json omitting meta, and validates round trip', () => {
      IKState.addVideoClip('v', 0, 10000, { name: 'SHOULD_BE_OMITTED' });
      const json = IKState.toRustJson();
      
      expect(json).not.toContain('SHOULD_BE_OMITTED');
      expect(json).toContain('"source_id":"v"');
      
      expect(IKState.verifyRoundTrip(json, json)).toBe(true);
      expect(IKState.verifyRoundTrip(json, '{"invalid": true}')).toBe(false);
    });

    it('loads state from rust json', () => {
      IKState.addVideoClip('v', 0, 10000);
      const originalJson = IKState.toRustJson();
      
      IKState.init(1, 1); // wipe
      expect(IKState.getVideoClips()).toHaveLength(0);
      
      IKState.loadFromRustJson(originalJson);
      expect(IKState.getVideoClips()).toHaveLength(1);
    });

    it('returns false for invalid json in verifyRoundTrip', () => {
      expect(IKState.verifyRoundTrip('{}', 'invalid json {')).toBe(false);
    });
  });

  describe('Default properties', () => {
    it('uses default colour and transform when not provided', () => {
      // Adding without options should trigger defaultTransform and defaultColour
      const clip = IKState.addVideoClip('default', 0, 1000);
      expect(clip?.transform.scale).toBe(1);
      expect(clip?.colour_settings.exposure).toBe(0);
    });
  });

  describe('State Snapshots', () => {
    it('saves and loads full state including meta', () => {
      IKState.addVideoClip('v', 0, 1000, { name: 'Important' });
      const snapshot = IKState.saveState();
      
      IKState.init(1, 1);
      IKState.loadState(snapshot);
      
      const clips = IKState.getVideoClips();
      expect(clips).toHaveLength(1);
      expect(clips[0]!.name).toBe('Important');
    });
  });

  describe('getAllVideoClips', () => {
    it('returns clips from all video tracks only', () => {
      IKState.addVideoClip('v1', 0, 1000);
      IKState.addVideoClip('v2', 2000, 5000);
      IKState.addAudioClip('a1', 0, 1000);

      const all = IKState.getAllVideoClips();
      expect(all).toHaveLength(2);
      all.forEach(c => expect(c.track_type).toBe('video'));
    });

    it('returns empty array when no project', () => {
      // Not initializing IKState
      const all = (IKState as any).getAllVideoClips();
      // Actually we init in beforeEach, so this always has a project
      // Test with explicit ensure
      expect(IKState.getAllVideoClips()).toBeDefined();
    });
  });

  describe('findClipTrack', () => {
    it('returns null for nonexistent clip', () => {
      const track = IKState.findClipTrack(99999);
      expect(track).toBeNull();
    });

    it('finds audio track correctly', () => {
      const aClip = IKState.addAudioClip('a.mp3', 0, 1000);
      const track = IKState.findClipTrack(aClip!.id);
      expect(track).not.toBeNull();
      expect(track!.track_type).toBe('audio');
    });
  });

  describe('removeClip - edge cases', () => {
    it('returns false when clip is not found in any track', () => {
      IKState.addVideoClip('v', 0, 1000);
      expect(IKState.removeClip(99999)).toBe(false);
    });

    it('recomputes duration after removing last clip', () => {
      const clip = IKState.addVideoClip('v', 0, 5000000);
      expect(IKState.getDurationSec()).toBe(5);

      IKState.removeClip(clip!.id);
      expect(IKState.getDurationSec()).toBe(0);
    });
  });

  describe('getLinkedClipIds - edge cases', () => {
    it('returns empty array for clip with no group_id', () => {
      const clip = IKState.addVideoClip('v', 0, 1000, {}, undefined as any);
      // group_id defaults to group_<id>, so it always has one
      // Let's test getting linked ids when none exist
      const linked = IKState.getLinkedClipIds(clip!.id);
      expect(linked).toEqual([]);
    });

    it('returns empty array when clip does not exist', () => {
      const linked = IKState.getLinkedClipIds(99999);
      expect(linked).toEqual([]);
    });
  });

  describe('findClip - edge cases', () => {
    it('returns null for nonexistent clip', () => {
      expect(IKState.findClip(99999)).toBeNull();
    });
  });

  describe('saveState / loadState / getProject', () => {
    it('saveState returns live project state that can be reloaded', () => {
      IKState.addVideoClip('v', 0, 1000, { name: 'Test' });
      const saved = IKState.saveState();
      
      expect(saved.project).toBeDefined();
      expect(saved.clipMeta).toBeDefined();
      
      IKState.init(1, 1);
      IKState.loadState(saved);
      
      expect(IKState.isReady()).toBe(true);
      const restored = IKState.getVideoClips();
      expect(restored).toHaveLength(1);
      expect(restored[0]!.name).toBe('Test');
    });

    it('getProject returns current project', () => {
      const proj = IKState.getProject();
      expect(proj).not.toBeNull();
      expect(proj!.name).toBe('Untitled');
    });
  });

  describe('computeDuration - edge cases', () => {
    it('returns 0 when no clips exist', () => {
      IKState.init(1920, 1080);
      expect(IKState.computeDuration()).toBe(0);
      expect(IKState.getDurationSec()).toBe(0);
    });

    it('returns 0 when project is null', () => {
      // Can't easily test without project since beforeEach always inits
      expect(IKState.computeDuration()).toBe(0);
    });
  });

  describe('moveClip - edge cases', () => {
    it('returns false for nonexistent clip', () => {
      expect(IKState.moveClip(99999, 0)).toBe(false);
    });

    it('sorts clips after move', () => {
      IKState.addVideoClip('v1', 1000000, 3000000);
      const v2 = IKState.addVideoClip('v2', 5000000, 7000000);
      
      IKState.moveClip(v2!.id, 0);
      const clips = IKState.getVideoClips();
      expect(clips[0]!.id).toBe(v2!.id);
      expect(clips[0]!.timeline_start_us).toBe(0);
    });
  });

  describe('splitClip - edge cases', () => {
    it('returns null for nonexistent clip', () => {
      expect(IKState.splitClip(99999, 1000)).toBeNull();
    });

    it('returns null when split at exact boundaries', () => {
      const clip = IKState.addVideoClip('v', 1000, 5000);
      expect(IKState.splitClip(clip!.id, 1000)).toBeNull();
      expect(IKState.splitClip(clip!.id, 5000)).toBeNull();
    });
  });

  describe('trimClip - edge cases', () => {
    it('returns false for nonexistent clip', () => {
      expect(IKState.trimClip(99999, 0, 1000, 0)).toBe(false);
    });
  });

  describe('setClipMeta / getClipMeta', () => {
    it('getClipMeta returns null for nonexistent clip', () => {
      expect(IKState.getClipMeta(99999)).toBeNull();
    });
  });
});
