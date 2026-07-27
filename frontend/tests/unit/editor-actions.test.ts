// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const actionMocks = vi.hoisted(() => ({
  analyzeSourceAudio: vi.fn(),
  resolveSourceForAnalysis: vi.fn(),
  saveSnapshot: vi.fn(),
  selectedClipIds: new Set<number | string>(),
}));

vi.mock('../../src/ai/audioAnalysis', () => ({
  analyzeSourceAudio: actionMocks.analyzeSourceAudio,
}));

vi.mock('../../src/ui/dragDrop', () => ({
  saveSnapshot: actionMocks.saveSnapshot,
  selectedClipIds: actionMocks.selectedClipIds,
}));

vi.mock('../../src/media/sourceRegistry', () => ({
  resolveSourceForAnalysis: actionMocks.resolveSourceForAnalysis,
}));

import { IKState } from '../../src/state/state';
import { initEditorActions } from '../../src/ai/editorActions';

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    durationSec: 8,
    silenceRegions: [],
    beatMarkersSec: [],
    dropMarkersSec: [],
    noiseFloorDb: -52,
    silenceThresholdDb: -40,
    ...overrides,
  };
}

describe('local editor actions', () => {
  beforeEach(() => {
    IKState.init(1920, 1080);
    window.IKState = IKState;
    window.S = { time: 0 } as any;
    window.aiNodes = [];
    window.iklippaBeatMarkers = [];
    window.iklippaProjectSetup = null;
    actionMocks.selectedClipIds.clear();
    actionMocks.saveSnapshot.mockReset();
    actionMocks.analyzeSourceAudio.mockReset();
    actionMocks.resolveSourceForAnalysis.mockReset();
    actionMocks.resolveSourceForAnalysis.mockImplementation(async (sourceId: string) => sourceId);
    initEditorActions();
  });

  it('turns detected silence into metadata-preserving ripple cuts', async () => {
    const primary = IKState.addVideoClip('interview.mp4', 0, 5_000_000, {
      name: 'Interview',
      isReal: true,
      thumbnails: ['frame-a'],
    })!;
    primary.effects = [{ id: 1, effect_type: 'blur', params: { amount: 0.2 }, enabled: true }];
    const later = IKState.addVideoClip('outro.mp4', 6_000_000, 8_000_000, {
      name: 'Outro',
      isReal: true,
    })!;
    actionMocks.analyzeSourceAudio.mockResolvedValue(analysis({
      silenceRegions: [{ startSec: 1, endSec: 2 }],
    }));

    const result = await window.runSmartTrim!([primary.id]);
    const clips = IKState.getVideoClips().slice().sort((a, b) => {
      return a.timeline_start_us - b.timeline_start_us;
    });

    expect(result.message).toContain('Removed 1 silent region');
    expect(IKState.findClip(primary.id)).toBeNull();
    expect(clips).toHaveLength(3);
    expect(clips[0]?.name).toBe('Interview');
    expect(clips[0]?.effects).toEqual(primary.effects);
    expect(clips[1]?.source_start_us).toBe(1_915_000);
    expect(IKState.findClip(later.id)?.timeline_start_us).toBe(4_170_000);
    expect(result.message).toContain('closed 1 timeline gap');
    expect(actionMocks.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('closes leading and between-clip gaps even when no audio silence is found', async () => {
    const first = IKState.addVideoClip('interview.mp4', 1_000_000, 3_000_000, {
      name: 'Interview',
      isReal: true,
    })!;
    const second = IKState.addVideoClip('outro.mp4', 4_500_000, 6_000_000, {
      name: 'Outro',
      isReal: true,
    })!;
    actionMocks.analyzeSourceAudio.mockResolvedValue(analysis());

    const result = await window.runSmartTrim!([]);

    expect(first.timeline_start_us).toBe(0);
    expect(first.timeline_end_us).toBe(2_000_000);
    expect(second.timeline_start_us).toBe(2_000_000);
    expect(second.timeline_end_us).toBe(3_500_000);
    expect(result.message).toContain('Closed 2 timeline gaps (2.5s)');
    expect(actionMocks.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('snaps a safe cut boundary to a locally detected Amapiano beat', async () => {
    const left = IKState.addVideoClip('dance.mp4', 0, 3_200_000, { name: 'Dance A' })!;
    const right = IKState.addVideoClip('dance.mp4', 3_200_000, 6_400_000, { name: 'Dance B' })!;
    right.source_start_us = 3_200_000;
    right.source_end_us = 6_400_000;
    IKState.addAudioClip('music.mp3', 0, 7_000_000, { name: 'Amapiano Mix' });
    window.iklippaProjectSetup = {
      version: 1,
      script: 'Amapiano dance sequence',
      brandName: 'Demo',
      guidelines: 'Hit the log drum drops.',
      paletteId: 'township-teal',
      primaryColor: '#0d9488',
      accentHover: '#14b8a6',
      accentGlow: 'rgba(13,148,136,.2)',
      captionFont: 'Archivo',
      keywords: ['amapiano', 'dance'],
      tone: 'Energetic',
      pacing: 'Fast',
      createdAt: 1,
    };
    actionMocks.analyzeSourceAudio.mockResolvedValue(analysis({
      beatMarkersSec: [3],
      dropMarkersSec: [3],
    }));

    const result = await window.runBeatSync!([left.id, right.id]);

    expect(result.message).toContain('amapiano beats');
    expect(left.timeline_end_us).toBe(3_000_000);
    expect(right.timeline_start_us).toBe(3_000_000);
    expect(right.source_start_us).toBe(3_000_000);
    expect(window.iklippaBeatMarkers).toEqual([3]);
    expect(actionMocks.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('relinks a restored clip to the only loaded source before trimming', async () => {
    const stale = IKState.addVideoClip('stale-stock-id', 0, 5_000_000, {
      name: 'Restored stock clip',
      isReal: true,
    })!;
    actionMocks.resolveSourceForAnalysis.mockResolvedValue('imported-current-video');
    actionMocks.analyzeSourceAudio.mockResolvedValue(analysis({
      silenceRegions: [{ startSec: 1, endSec: 2 }],
    }));

    await window.runSmartTrim!([stale.id]);

    expect(actionMocks.analyzeSourceAudio).toHaveBeenCalledWith(
      'imported-current-video',
      'default',
    );
    expect(IKState.getVideoClips().every((clip) => {
      return clip.source_id === 'imported-current-video';
    })).toBe(true);
  });
});
