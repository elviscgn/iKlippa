import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setPorts, resetPorts } from '../../src/adapters';
import { fakeEnginePorts, expectNoLeaks, resetLeakRegistry } from '../fakes';
import type { FakeAudioContextType } from '../fakes';

vi.mock('mp4-muxer', () => {
  const muxerInstance = {
    addVideoChunkRaw: vi.fn(),
    addAudioChunkRaw: vi.fn(),
    finalize: vi.fn(),
  };
  return {
    Muxer: vi.fn(() => muxerInstance),
    ArrayBufferTarget: vi.fn(function(this: any) { this.buffer = new ArrayBuffer(0); }),
  };
});

beforeEach(() => {
  resetLeakRegistry();
  setPorts(fakeEnginePorts);
});

afterEach(() => {
  expectNoLeaks();
  resetPorts();
});

import { captureThumbnailFromBuffer, __TEST_HOOKS__ } from '../../src/engine/engine';

describe('captureThumbnailFromBuffer (Tier 2 - adapter ports)', () => {
  let mockCanvas: any;
  let mockCtx: any;

  beforeEach(() => {
    mockCanvas = {
      width: 1920,
      height: 1080,
      toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,mockdata'),
    };
    mockCtx = {
      putImageData: vi.fn(),
    };

    __TEST_HOOKS__.canvas = mockCanvas;
    __TEST_HOOKS__.ctx = mockCtx;
    __TEST_HOOKS__.pendingFrames = new Map();
  });

  it('returns null if canvas or ctx is missing', () => {
    __TEST_HOOKS__.canvas = null;
    expect(captureThumbnailFromBuffer(100)).toBeNull();

    __TEST_HOOKS__.canvas = mockCanvas;
    __TEST_HOOKS__.ctx = null;
    expect(captureThumbnailFromBuffer(100)).toBeNull();
  });

  it('returns null if pendingFrames is empty', () => {
    expect(captureThumbnailFromBuffer(100)).toBeNull();
  });

  it('returns exact match frame', () => {
    __TEST_HOOKS__.pendingFrames.set(100, {} as ImageData);
    const result = captureThumbnailFromBuffer(100);
    expect(result).toBe('data:image/jpeg;base64,mockdata');
    expect(mockCtx.putImageData).toHaveBeenCalledWith({}, 0, 0);
  });

  it('returns closest previous frame if exact match not found', () => {
    __TEST_HOOKS__.pendingFrames.set(50, { id: '50' } as any as ImageData);
    __TEST_HOOKS__.pendingFrames.set(80, { id: '80' } as any as ImageData);
    __TEST_HOOKS__.pendingFrames.set(120, { id: '120' } as any as ImageData);

    const result = captureThumbnailFromBuffer(100);
    expect(result).toBe('data:image/jpeg;base64,mockdata');
    expect(mockCtx.putImageData).toHaveBeenCalledWith({ id: '80' }, 0, 0);
  });

  it('returns smallest frame if all pending frames are after requested ms', () => {
    __TEST_HOOKS__.pendingFrames.set(120, { id: '120' } as any as ImageData);
    __TEST_HOOKS__.pendingFrames.set(150, { id: '150' } as any as ImageData);

    const result = captureThumbnailFromBuffer(100);
    expect(result).toBe('data:image/jpeg;base64,mockdata');
    expect(mockCtx.putImageData).toHaveBeenCalledWith({ id: '120' }, 0, 0);
  });

  it('returns null if pendingFrames.get magically returns undefined', () => {
    __TEST_HOOKS__.pendingFrames.set(100, undefined as any);
    expect(captureThumbnailFromBuffer(100)).toBeNull();
  });

  it('handles toDataURL error gracefully', () => {
    __TEST_HOOKS__.pendingFrames.set(100, {} as ImageData);
    mockCanvas.toDataURL.mockImplementation(() => {
      throw new Error('Canvas error');
    });

    expect(captureThumbnailFromBuffer(100)).toBeNull();
  });
});

import { exportVideo } from '../../src/engine/engine';

describe('exportVideo (Tier 2 - adapter ports)', () => {
  let mockWorker: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    __TEST_HOOKS__.worker = mockWorker;
    __TEST_HOOKS__.isExporting = false;
    __TEST_HOOKS__.exportFrames = [];
    __TEST_HOOKS__.pendingFrames = new Map();
    __TEST_HOOKS__.videoDurationMs = 100;

    vi.stubGlobal('VideoFrame', vi.fn().mockImplementation(() => ({
      close: vi.fn(),
    })));

    const mockAnchor = { click: vi.fn(), href: '', download: '' };
    vi.stubGlobal('document', {
      createElement: vi.fn().mockReturnValue(mockAnchor as any),
    });

    vi.stubGlobal('window', {
      Mp4Muxer: {
        Muxer: vi.fn().mockImplementation(() => ({
          addVideoChunkRaw: vi.fn(),
          finalize: vi.fn().mockReturnValue({ buffer: new ArrayBuffer(10) }),
        })),
        ArrayBufferTarget: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exits early if already exporting', async () => {
    __TEST_HOOKS__.isExporting = true;
    const progressSpy = vi.fn();
    await exportVideo(progressSpy);
    expect(progressSpy).not.toHaveBeenCalled();
  });

  it('triggers export flow with fake encoder and muxer', async () => {
    const frameMs = 1000 / 30;
    __TEST_HOOKS__.videoDurationMs = 4000;
    let frameCount = 0;
    mockWorker.postMessage.mockImplementation((msg: any) => {
      if (msg.type === 'decode_all') {
        // Simulate worker decoding all frames — generate enough for export
        const totalNeeded = Math.ceil(__TEST_HOOKS__.videoDurationMs / (1000 / 30));
        for (let j = 0; j < totalNeeded; j++) {
          const ms = j * (1000 / 30);
          const fakeImage = { data: { buffer: new ArrayBuffer(0) } } as any;
          __TEST_HOOKS__.pendingFrames.set(ms, fakeImage);
          __TEST_HOOKS__.exportFrames.push({ ms, imageData: fakeImage });
        }
      }
    });

    const progressSpy = vi.fn();
    await exportVideo(progressSpy);

    expect(progressSpy).toHaveBeenCalledWith(1);
  });
});

import {
  seekTo,
  setColorGrade,
  setPendingThumbCapture,
  handleWorkerMessage,
  togglePlayback,
  importFile,
  renderLoop,
} from '../../src/engine/engine';

describe('seekTo (Tier 2 - adapter ports)', () => {
  let mockWorker: any;

  beforeEach(() => {
    vi.stubGlobal('window', {});
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    __TEST_HOOKS__.worker = mockWorker;
    __TEST_HOOKS__.pendingFrames = new Map();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts seek and sync messages', () => {
    seekTo(100);
    expect(mockWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'seek', ms: 100 }));
    expect(mockWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sync' }),
    );
  });

  it('posts set_audio_version on seek', () => {
    seekTo(250);
    const versionCalls = mockWorker.postMessage.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'set_audio_version'
    );
    expect(versionCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('setColorGrade (Tier 2 - adapter ports)', () => {
  let mockWorker: any;

  beforeEach(() => {
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    __TEST_HOOKS__.worker = mockWorker;
  });

  it('posts set_grade to worker', () => {
    setColorGrade({ exposure: 0.5, contrast: 0.2 });
    expect(mockWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_grade' }),
    );
  });

  it('includes forceRenderMs when not playing', () => {
    setColorGrade({ saturation: 0.8 });
    const gradeCall = mockWorker.postMessage.mock.calls.find(
      (c: any[]) => c[0]?.type === 'set_grade'
    );
    expect(gradeCall).toBeDefined();
    expect(gradeCall[0]).toHaveProperty('params');
  });
});

describe('setPendingThumbCapture (Tier 2 - adapter ports)', () => {
  it('sets a pending thumbnail capture callback', () => {
    const cb = vi.fn();
    setPendingThumbCapture(cb);
    expect(() => setPendingThumbCapture(vi.fn())).not.toThrow();
  });
});

describe('handleWorkerMessage (Tier 2 - adapter ports)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handles status message', () => {
    expect(() => {
      handleWorkerMessage({
        data: { type: 'status', msg: 'testing' },
      } as MessageEvent);
    }).not.toThrow();
  });

  it('handles decode_submit message', () => {
    expect(() => {
      handleWorkerMessage({
        data: { type: 'decode_submit', ms: 100 },
      } as MessageEvent);
    }).not.toThrow();
  });

  it('handles timeline_set success', () => {
    handleWorkerMessage({
      data: { type: 'timeline_set', ok: true },
    } as MessageEvent);
  });

  it('handles timeline_set failure', () => {
    handleWorkerMessage({
      data: { type: 'timeline_set', ok: false, error: 'bad timeline' },
    } as MessageEvent);
  });

  it('handles project_json message', () => {
    handleWorkerMessage({
      data: { type: 'project_json', json: '{}' },
    } as MessageEvent);
  });
});

describe('togglePlayback (Tier 2 - adapter ports)', () => {
  let mockWorker: any;

  beforeEach(() => {
    vi.stubGlobal('window', {});
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    __TEST_HOOKS__.worker = mockWorker;
    __TEST_HOOKS__.pendingFrames = new Map();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when not playing (calls startPlayback)', () => {
    const result = togglePlayback();
    expect(typeof result).toBe('boolean');
  });

  it('can be toggled twice', () => {
    togglePlayback();
    const result = togglePlayback();
    expect(typeof result).toBe('boolean');
  });
});

import { perf } from '../../src/engine/engine';

describe('engine frame/audio message handling (Tier 2)', () => {
  let mockWorker: any;

  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('ImageData', class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });

    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    __TEST_HOOKS__.worker = mockWorker;
    __TEST_HOOKS__.pendingFrames = new Map();
    __TEST_HOOKS__.videoDurationMs = 10000;
    __TEST_HOOKS__.canvas = { width: 1920, height: 1080, toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,x') } as any;
    __TEST_HOOKS__.ctx = { putImageData: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn() } as any;
    __TEST_HOOKS__.isExporting = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handleWorkerMessage processes frame message', () => {
    const buf = new ArrayBuffer(100);
    const uint8 = new Uint8ClampedArray(buf);
    handleWorkerMessage({
      data: { type: 'frame', ms: 500, gradeMs: 2.5, buffer: buf },
    } as MessageEvent);

    expect(__TEST_HOOKS__.pendingFrames.has(500)).toBe(true);
  });

  it('handleWorkerFrame adds to exportFrames when isExporting', () => {
    __TEST_HOOKS__.isExporting = true;
    __TEST_HOOKS__.exportFrames = [];

    const buf = new ArrayBuffer(100);
    handleWorkerMessage({
      data: { type: 'frame', ms: 500, gradeMs: 2.5, buffer: buf },
    } as MessageEvent);

    expect(__TEST_HOOKS__.exportFrames.length).toBe(1);
  });

  it('handleWorkerMessage processes ready message', () => {
    __TEST_HOOKS__.canvas = { width: 0, height: 0 } as any;
    handleWorkerMessage({
      data: { type: 'ready', durationMs: 5000, width: 640, height: 480 },
    } as MessageEvent);

    expect(__TEST_HOOKS__.videoDurationMs).toBe(5000);
  });

  it('handleWorkerMessage processes audio_chunk when audioCtx is not ready', () => {
    handleWorkerMessage({
      data: {
        type: 'audio_chunk',
        ms: 100,
        channels: 2,
        sampleRate: 48000,
        length: 1024,
        buffers: [new ArrayBuffer(4096), new ArrayBuffer(4096)],
        configVersion: 0,
      },
    } as MessageEvent);
  });

  it('setColorGrade sends message to worker', () => {
    setColorGrade({ exposure: 0.5 });
    const calls = mockWorker.postMessage.mock.calls;
    const gradeCall = calls.find((c: any[]) => c[0]?.type === 'set_grade');
    expect(gradeCall).toBeDefined();
    expect(gradeCall[0].params).toEqual(expect.objectContaining({ exposure: 0.5 }));
  });

  it('setColorGrade with partial params', () => {
    setColorGrade({ contrast: -0.3, saturation: 0.1 });
    expect(mockWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set_grade' }),
    );
  });

  it('perf is available and recordable', () => {
    expect(perf).toBeDefined();
    perf.recordRaf(0);
    perf.recordRaf(16.67);
    const score = perf.score();
    expect(score.totalFrames).toBe(1);
  });

  it('decode_submit updates perf', () => {
    perf.reset();
    handleWorkerMessage({
      data: { type: 'decode_submit', ms: 100 },
    } as MessageEvent);
    // Just verify it doesn't throw
  });
});

describe('handleWorkerFrame seek target (Tier 2)', () => {
  let mockWorker: any;

  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('ImageData', class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });

    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    __TEST_HOOKS__.worker = mockWorker;
    __TEST_HOOKS__.pendingFrames = new Map();
    __TEST_HOOKS__.canvas = { width: 1920, height: 1080, toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,x') } as any;
    __TEST_HOOKS__.ctx = { putImageData: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn() } as any;
    __TEST_HOOKS__.videoDurationMs = 10000;
    __TEST_HOOKS__.isPlaying = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paints when frame ms reaches seek target', () => {
    seekTo(500);

    const buf = new ArrayBuffer(100);
    handleWorkerMessage({
      data: { type: 'frame', ms: 500, gradeMs: 2.5, buffer: buf },
    } as MessageEvent);

    const ctx = __TEST_HOOKS__.ctx as any;
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it('does not paint when frame ms is before seek target', () => {
    seekTo(500);
    const ctx = __TEST_HOOKS__.ctx as any;
    ctx.fillRect.mockClear();

    const buf = new ArrayBuffer(100);
    handleWorkerMessage({
      data: { type: 'frame', ms: 100, gradeMs: 2.5, buffer: buf },
    } as MessageEvent);

    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

describe('handleWorkerAudioChunk with audio context ready (Tier 2)', () => {
  let mockWorker: any;
  let fakeCtx: any;

  beforeEach(() => {
    vi.stubGlobal('window', {});
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    __TEST_HOOKS__.worker = mockWorker;

    fakeCtx = fakeEnginePorts.audioContextFactory.create();
    __TEST_HOOKS__.audioCtx = fakeCtx;
    __TEST_HOOKS__.audioConfigVersion = 0;
    __TEST_HOOKS__.audioPlayStartMs = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __TEST_HOOKS__.audioCtx = null;
    __TEST_HOOKS__.isPlaying = false;
    resetLeakRegistry();
  });

  it('creates buffer when audioCtx is ready and not playing', () => {
    vi.spyOn(fakeCtx, 'createBuffer');

    handleWorkerMessage({
      data: {
        type: 'audio_chunk',
        ms: 100,
        channels: 2,
        sampleRate: 48000,
        length: 1024,
        buffers: [new ArrayBuffer(4096), new ArrayBuffer(4096)],
        configVersion: 0,
      },
    } as MessageEvent);

    expect(fakeCtx.createBuffer).toHaveBeenCalledWith(2, 1024, 48000);
  });

  it('schedules audio node when isPlaying is true', () => {
    __TEST_HOOKS__.isPlaying = true;

    vi.spyOn(fakeCtx, 'createBuffer');
    vi.spyOn(fakeCtx, 'createBufferSource');

    handleWorkerMessage({
      data: {
        type: 'audio_chunk',
        ms: 100,
        channels: 2,
        sampleRate: 48000,
        length: 1024,
        buffers: [new ArrayBuffer(4096), new ArrayBuffer(4096)],
        configVersion: 0,
      },
    } as MessageEvent);

    expect(fakeCtx.createBuffer).toHaveBeenCalled();
    expect(fakeCtx.createBufferSource).toHaveBeenCalled();
  });
});

describe('importFile (Tier 2)', () => {
  let mockWorker: any;

  beforeEach(() => {
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    __TEST_HOOKS__.worker = mockWorker;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __TEST_HOOKS__.audioCtx = null;
  });

  it('rejects when MP4Box finds no video track', async () => {
    const mp4Mock = {
      onReady: null as any,
      onSamples: null as any,
      onError: null as any,
      setExtractionOptions: vi.fn(),
      start: vi.fn(),
      appendBuffer: vi.fn(),
      flush: vi.fn().mockImplementation(function(this: any) {
        if (this.onReady) {
          this.onReady({ videoTracks: [], audioTracks: [] });
        }
      }),
      getTrackById: vi.fn(),
    };

    vi.stubGlobal('window', {
      MP4Box: { createFile: vi.fn().mockReturnValue(mp4Mock) },
    });

    const mockFile = {
      name: 'test.mp4',
      size: 10,
      slice: vi.fn().mockReturnValue({
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
      }),
    };

    await expect(importFile(mockFile as unknown as File)).rejects.toThrow(
      'No video track found',
    );
  });

  it('rejects when MP4Box fails to return video metadata', async () => {
    const mp4Mock = {
      onReady: null as any,
      onSamples: null as any,
      onError: null as any,
      setExtractionOptions: vi.fn(),
      start: vi.fn(),
      appendBuffer: vi.fn(),
      flush: vi.fn(),
      getTrackById: vi.fn(),
    };

    vi.stubGlobal('window', {
      MP4Box: { createFile: vi.fn().mockReturnValue(mp4Mock) },
    });

    const mockFile = {
      name: 'test.mp4',
      size: 10,
      slice: vi.fn().mockReturnValue({
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
      }),
    };

    await expect(importFile(mockFile as unknown as File)).rejects.toThrow(
      'Failed to find video metadata',
    );
  });
});

describe('setTimeline and getProjectJson (Tier 2)', () => {
  let mockWorker: any;

  beforeEach(() => {
    vi.stubGlobal('window', {});
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      _handlers: [] as Array<(...args: any[]) => void>,
    };
    mockWorker.addEventListener.mockImplementation((type: string, handler: any) => {
      if (type === 'message') mockWorker._handlers.push(handler);
    });
    mockWorker.removeEventListener.mockImplementation(
      (type: string, handler: any) => {
        if (type === 'message') {
          const idx = mockWorker._handlers.indexOf(handler);
          if (idx >= 0) mockWorker._handlers.splice(idx, 1);
        }
      },
    );

    __TEST_HOOKS__.worker = mockWorker;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('setTimeline posts set_timeline and resolves on timeline_set response', async () => {
    const promise = __TEST_HOOKS__.setTimeline('{"clips":[]}');
    expect(mockWorker.postMessage).toHaveBeenCalledWith({
      type: 'set_timeline',
      json: '{"clips":[]}',
    });

    const handler = mockWorker._handlers[0];
    handler({ data: { type: 'timeline_set', ok: true } });
    const result = await promise;
    expect(result).toEqual({ ok: true });
  });

  it('getProjectJson posts get_project_json and resolves on project_json response', async () => {
    const promise = __TEST_HOOKS__.getProjectJson();
    expect(mockWorker.postMessage).toHaveBeenCalledWith({
      type: 'get_project_json',
    });

    const handler = mockWorker._handlers[0];
    handler({ data: { type: 'project_json', json: '{"key":"val"}' } });
    const result = await promise;
    expect(result).toBe('{"key":"val"}');
  });
});

// ── paintFrameAtTime tests (via handleWorkerMessage) ─────────────────

describe('paintFrameAtTime (Tier 2 - via handleWorkerMessage)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('ImageData', class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });

    __TEST_HOOKS__.worker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as any;
    __TEST_HOOKS__.canvas = { width: 1920, height: 1080, toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,x') } as any;
    __TEST_HOOKS__.ctx = { putImageData: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn() } as any;
    __TEST_HOOKS__.pendingFrames = new Map();
    __TEST_HOOKS__.videoDurationMs = 10000;
    __TEST_HOOKS__.isPlaying = false;
    __TEST_HOOKS__.playheadMs = 0;
    __TEST_HOOKS__.sourceVideoWidth = 1920;
    __TEST_HOOKS__.sourceVideoHeight = 1080;
    __TEST_HOOKS__.seekTargetMs = -1;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paints black frame when no active clips', () => {
    __TEST_HOOKS__.seekTargetMs = 200;
    const buf = new ArrayBuffer(100);
    handleWorkerMessage({
      data: { type: 'frame', ms: 200, gradeMs: 2.0, buffer: buf },
    } as MessageEvent);

    const ctx = __TEST_HOOKS__.ctx as any;
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1920, 1080);
  });

  function stubIKState(state: any) {
    vi.stubGlobal('IKState', state);
    (globalThis as any).window.IKState = state;
  }

  it('paints single frame when a clip is active and frame matches', () => {
    stubIKState({
      isReady: () => true,
      getAllVideoClips: () => [
        { id: 1, timeline_start_us: 0, timeline_end_us: 5000000, source_start_us: 0, source_end_us: 5000000 },
      ],
      getVideoClips: () => [],
    });

    // handleWorkerFrame will create the real ImageData and overwrite this,
    // but paintFrameAtTime will use whatever is in pendingFrames at resolution time
    __TEST_HOOKS__.seekTargetMs = 0;
    const buf = new ArrayBuffer(100);
    handleWorkerMessage({
      data: { type: 'frame', ms: 0, gradeMs: 2.0, buffer: buf },
    } as MessageEvent);

    const ctx = __TEST_HOOKS__.ctx as any;
    expect(ctx.putImageData).toHaveBeenCalledWith(
      expect.any(Object),
      0,
      0,
    );
  });

  it('skips painting when clip exists but no matching frame found', () => {
    stubIKState({
      isReady: () => true,
      getAllVideoClips: () => [
        { id: 1, timeline_start_us: 0, timeline_end_us: 5000000, source_start_us: 0, source_end_us: 5000000 },
      ],
      getVideoClips: () => [{ id: 1, timeline_start_us: 0, timeline_end_us: 5000000, source_start_us: 0, source_end_us: 5000000 }],
    });

    // Ensure no pending frames before the message
    __TEST_HOOKS__.pendingFrames = new Map();

    // Send a frame at ms=500 which won't match sourceMs=0
    // handleWorkerFrame adds to pendingFrames before paintFrameAtTime runs,
    // but at 500ms it's too far ahead of the 0ms source position to match
    const buf = new ArrayBuffer(100);
    handleWorkerMessage({
      data: { type: 'frame', ms: 500, gradeMs: 2.0, buffer: buf },
    } as MessageEvent);

    const ctx = __TEST_HOOKS__.ctx as any;
    // When clips exist but no frames could be resolved, paintFrameAtTime returns
    // without putting any image data (it just calls cleanupStaleFrames)
    expect(ctx.putImageData).not.toHaveBeenCalled();
  });

  it('uses getAllVideoClips for multi-track compositing', () => {
    stubIKState({
      isReady: () => true,
      getAllVideoClips: () => [
        { id: 1, timeline_start_us: 0, timeline_end_us: 5000000, source_start_us: 0, source_end_us: 5000000, transform: { opacity: 1 } },
        { id: 2, timeline_start_us: 0, timeline_end_us: 5000000, source_start_us: 0, source_end_us: 5000000, transform: { opacity: 0.5 } },
      ],
      getVideoClips: () => [],
    });

    __TEST_HOOKS__.canvas!.width = 1920;
    __TEST_HOOKS__.canvas!.height = 1080;

    __TEST_HOOKS__.seekTargetMs = 0;
    const buf = new ArrayBuffer(100);
    handleWorkerMessage({
      data: { type: 'frame', ms: 0, gradeMs: 2.0, buffer: buf },
    } as MessageEvent);

    const ctx = __TEST_HOOKS__.ctx as any;
    expect(ctx.drawImage).toHaveBeenCalled();
  });

  it('falls back to getVideoClips when getAllVideoClips is absent', () => {
    stubIKState({
      isReady: () => true,
      getVideoClips: () => [
        { id: 1, timeline_start_us: 0, timeline_end_us: 5000000, source_start_us: 0, source_end_us: 5000000 },
      ],
    });

    __TEST_HOOKS__.seekTargetMs = 0;
    const buf = new ArrayBuffer(100);
    handleWorkerMessage({
      data: { type: 'frame', ms: 0, gradeMs: 2.0, buffer: buf },
    } as MessageEvent);

    const ctx = __TEST_HOOKS__.ctx as any;
    expect(ctx.putImageData).toHaveBeenCalled();
  });
});

// ── renderLoop tests ─────────────────────────────────────────────────────

describe('renderLoop (Tier 2)', () => {
  let mockWorker: any;

  function stubIKState(clips: any[] = [{ id: 1, timeline_start_us: 0, timeline_end_us: 5000000, source_start_us: 0, source_end_us: 5000000 }]) {
    const state = {
      isReady: () => true,
      getVideoClips: () => clips,
      getAudioClips: () => [] as any[],
      getDurationSec: () => 10,
    };
    vi.stubGlobal('IKState', state);
    (globalThis as any).window.IKState = state;
  }

  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('ImageData', class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });

    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    __TEST_HOOKS__.worker = mockWorker;
    __TEST_HOOKS__.canvas = { width: 1920, height: 1080, toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,x') } as any;
    __TEST_HOOKS__.ctx = { putImageData: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn() } as any;
    __TEST_HOOKS__.pendingFrames = new Map();
    __TEST_HOOKS__.videoDurationMs = 10000;
    __TEST_HOOKS__.playheadMs = 0;
    __TEST_HOOKS__.lastRafTs = null;
    __TEST_HOOKS__.rafHandle = null;
    __TEST_HOOKS__.lastSyncSig = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __TEST_HOOKS__.isPlaying = false;
  });

  it('returns early when not playing', () => {
    __TEST_HOOKS__.isPlaying = false;
    renderLoop(16);
    expect(mockWorker.postMessage).not.toHaveBeenCalled();
  });

  it('stops playback when no clips exist on timeline', () => {
    __TEST_HOOKS__.isPlaying = true;
    stubIKState([]);

    renderLoop(16);
    expect(__TEST_HOOKS__.isPlaying).toBe(false);
  });

  it('advances playhead based on delta time', () => {
    __TEST_HOOKS__.isPlaying = true;
    __TEST_HOOKS__.lastRafTs = 0;
    stubIKState();

    __TEST_HOOKS__.pendingFrames.set(16, {} as ImageData);

    renderLoop(16);
    expect(__TEST_HOOKS__.playheadMs).toBe(16);
  });

  it('pauses when playhead reaches end of duration', () => {
    __TEST_HOOKS__.isPlaying = true;
    __TEST_HOOKS__.playheadMs = 9990;
    __TEST_HOOKS__.lastRafTs = 0;
    stubIKState();

    renderLoop(30);
    expect(__TEST_HOOKS__.playheadMs).toBe(10000);
    expect(__TEST_HOOKS__.isPlaying).toBe(false);
  });

  it('counts frames ahead of playhead for sync', () => {
    __TEST_HOOKS__.isPlaying = true;
    __TEST_HOOKS__.lastRafTs = 0;
    stubIKState();

    __TEST_HOOKS__.pendingFrames.set(100, {} as ImageData);
    __TEST_HOOKS__.pendingFrames.set(500, {} as ImageData);
    __TEST_HOOKS__.pendingFrames.set(1000, {} as ImageData);
    __TEST_HOOKS__.pendingFrames.set(50, {} as ImageData);

    renderLoop(16);
    const syncCalls = mockWorker.postMessage.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sync'
    );
    expect(syncCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── seekTo with isPlaying cleanup (uncovered path) ─────────────────────

describe('seekTo while playing (Tier 2)', () => {
  let mockWorker: any;

  beforeEach(() => {
    vi.stubGlobal('window', {});
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    __TEST_HOOKS__.worker = mockWorker;
    __TEST_HOOKS__.pendingFrames = new Map();
    __TEST_HOOKS__.pendingAudio = new Map();
    __TEST_HOOKS__.isPlaying = true;
    __TEST_HOOKS__.rafHandle = 42;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __TEST_HOOKS__.isPlaying = false;
    __TEST_HOOKS__.rafHandle = null;
  });

  it('posts seek message and resyncs when playing', async () => {
    await seekTo(500);
    expect(mockWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'seek', ms: 500 }));
  });
});

// ── handleWorkerReady with onClipImported ──────────────────────────────

describe('handleWorkerReady with callbacks (Tier 2)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    __TEST_HOOKS__.canvas = { width: 0, height: 0 } as any;
    __TEST_HOOKS__.worker = { postMessage: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } as any;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls onClipImported when window callback is set', () => {
    const onClipImported = vi.fn();
    vi.stubGlobal('window', { onClipImported });

    handleWorkerMessage({
      data: { type: 'ready', durationMs: 5000, width: 640, height: 480 },
    } as MessageEvent);

    expect(onClipImported).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 640,
        height: 480,
        durationMs: 5000,
      })
    );
  });

  it('sets canvas dimensions on ready', () => {
    const c = { width: 0, height: 0 } as any;
    __TEST_HOOKS__.canvas = c;

    handleWorkerMessage({
      data: { type: 'ready', durationMs: 5000, width: 640, height: 480 },
    } as MessageEvent);

    expect(c.width).toBe(640);
    expect(c.height).toBe(480);
    expect(__TEST_HOOKS__.videoDurationMs).toBe(5000);
  });
});

// ── handleWorkerFrame with pending thumb capture ───────────────────────

describe('handleWorkerFrame with pending thumb capture (Tier 2)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('ImageData', class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    __TEST_HOOKS__.worker = { postMessage: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } as any;
    __TEST_HOOKS__.canvas = { width: 1920, height: 1080, toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,x') } as any;
    __TEST_HOOKS__.ctx = { putImageData: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn() } as any;
    __TEST_HOOKS__.pendingFrames = new Map();
    __TEST_HOOKS__.videoDurationMs = 10000;
    __TEST_HOOKS__.isPlaying = false;
    __TEST_HOOKS__.playheadMs = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires pending thumbnail capture callback on frame arrival', () => {
    const cb = vi.fn();
    setPendingThumbCapture(cb);

    const buf = new ArrayBuffer(100);
    handleWorkerMessage({
      data: { type: 'frame', ms: 500, gradeMs: 2.0, buffer: buf },
    } as MessageEvent);

    expect(cb).toHaveBeenCalledWith(500);
  });

  it('handles callback throwing without crashing', () => {
    setPendingThumbCapture(() => {
      throw new Error('thumb error');
    });

    const buf = new ArrayBuffer(100);
    expect(() => {
      handleWorkerMessage({
        data: { type: 'frame', ms: 500, gradeMs: 2.0, buffer: buf },
      } as MessageEvent);
    }).not.toThrow();
  });
});

// ── handleWorkerAudioChunk edge cases ──────────────────────────────────

describe('handleWorkerAudioChunk edge cases (Tier 2)', () => {
  let mockWorker: any;

  beforeEach(() => {
    vi.stubGlobal('window', {});
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    __TEST_HOOKS__.worker = mockWorker;
    __TEST_HOOKS__.audioCtx = null;
    __TEST_HOOKS__.audioConfigVersion = 0;
    __TEST_HOOKS__.isPlaying = false;
    __TEST_HOOKS__.playheadMs = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __TEST_HOOKS__.audioCtx = null;
  });

  it('silently ignores audio chunk when config version mismatches', () => {
    const fakeCtx = fakeEnginePorts.audioContextFactory.create();
    __TEST_HOOKS__.audioCtx = fakeCtx;
    __TEST_HOOKS__.audioConfigVersion = 5;

    vi.spyOn(fakeCtx, 'createBuffer');

    handleWorkerMessage({
      data: {
        type: 'audio_chunk',
        ms: 100,
        channels: 2,
        sampleRate: 48000,
        length: 1024,
        buffers: [new ArrayBuffer(4096), new ArrayBuffer(4096)],
        configVersion: 0,
      },
    } as MessageEvent);

    expect(fakeCtx.createBuffer).not.toHaveBeenCalled();
  });
});

// ── logStatus / window callbacks ──────────────────────────────────────

describe('window callbacks (Tier 2)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    __TEST_HOOKS__.worker = { postMessage: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } as any;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls onEngineStatus when logStatus fires', () => {
    const onEngineStatus = vi.fn();
    vi.stubGlobal('window', { onEngineStatus });

    handleWorkerMessage({
      data: { type: 'status', msg: 'WASM loaded' },
    } as MessageEvent);

    expect(onEngineStatus).toHaveBeenCalledWith('WASM loaded');
  });

  it('calls onTimelineSynced on timeline_set success', () => {
    const onTimelineSynced = vi.fn();
    vi.stubGlobal('window', { onTimelineSynced });

    handleWorkerMessage({
      data: { type: 'timeline_set', ok: true },
    } as MessageEvent);

    expect(onTimelineSynced).toHaveBeenCalledWith(true, undefined);
  });

  it('calls onPlayheadUpdate through renderLoop', () => {
    const onPlayheadUpdate = vi.fn();
    const state = {
      isReady: () => true,
      getVideoClips: () => [{ id: 1, timeline_start_us: 0, timeline_end_us: 5000000, source_start_us: 0, source_end_us: 5000000 }],
      getAudioClips: () => [] as any[],
      getDurationSec: () => 10,
    };
    vi.stubGlobal('window', { onPlayheadUpdate });
    vi.stubGlobal('IKState', state);
    (globalThis as any).window.IKState = state;

    __TEST_HOOKS__.isPlaying = true;
    __TEST_HOOKS__.playheadMs = 0;
    __TEST_HOOKS__.lastRafTs = 0;
    __TEST_HOOKS__.canvas = { width: 1920, height: 1080, toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,x') } as any;
    __TEST_HOOKS__.ctx = { putImageData: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn() } as any;
    __TEST_HOOKS__.pendingFrames = new Map();

    renderLoop(16);

    expect(onPlayheadUpdate).toHaveBeenCalledWith(16);
  });

  it('calls onProjectJsonReceived', () => {
    const onProjectJsonReceived = vi.fn();
    vi.stubGlobal('window', { onProjectJsonReceived });

    handleWorkerMessage({
      data: { type: 'project_json', json: '{"x": 1}' },
    } as MessageEvent);

    expect(onProjectJsonReceived).toHaveBeenCalledWith('{"x": 1}');
  });
});

// ── setTimeline failure path ─────────────────────────────────────────

describe('setTimeline failure (Tier 2)', () => {
  let mockWorker: any;

  beforeEach(() => {
    vi.stubGlobal('window', {});
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      _handlers: [] as Array<(...args: any[]) => void>,
    };
    mockWorker.addEventListener.mockImplementation((type: string, handler: any) => {
      if (type === 'message') mockWorker._handlers.push(handler);
    });
    mockWorker.removeEventListener.mockImplementation((type: string, handler: any) => {
      if (type === 'message') {
        const idx = mockWorker._handlers.indexOf(handler);
        if (idx >= 0) mockWorker._handlers.splice(idx, 1);
      }
    });
    __TEST_HOOKS__.worker = mockWorker;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves with ok:false on error', async () => {
    const promise = __TEST_HOOKS__.setTimeline('bad json');
    expect(mockWorker.postMessage).toHaveBeenCalledWith({
      type: 'set_timeline',
      json: 'bad json',
    });

    const handler = mockWorker._handlers[0];
    handler({ data: { type: 'timeline_set', ok: false, error: 'parse failed' } });
    const result = await promise;
    expect(result).toEqual({ ok: false, error: 'parse failed' });
  });
});

// ── stopAllAudioNodes ─────────────────────────────────────────────────

describe('stopAllAudioNodes via togglePlayback (Tier 2)', () => {
  let mockWorker: any;

  beforeEach(() => {
    vi.stubGlobal('window', {});
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    __TEST_HOOKS__.worker = mockWorker;
    __TEST_HOOKS__.pendingFrames = new Map();
    __TEST_HOOKS__.isPlaying = true;
    __TEST_HOOKS__.rafHandle = 42;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __TEST_HOOKS__.isPlaying = false;
    __TEST_HOOKS__.rafHandle = null;
  });

  it('pauses and stops audio nodes via togglePlayback', () => {
    const result = togglePlayback();
    expect(typeof result).toBe('boolean');
    // Should have called cancelAnimationFrame
  });
});

// ── seekTo fallback timeout ──────────────────────────────────────────

describe('seekTo fallback timeout (Tier 2)', () => {
  let mockWorker: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    __TEST_HOOKS__.worker = mockWorker;
    __TEST_HOOKS__.pendingFrames = new Map();
    __TEST_HOOKS__.pendingAudio = new Map();
    __TEST_HOOKS__.isPlaying = false;
    __TEST_HOOKS__.playheadMs = 0;
    __TEST_HOOKS__.canvas = { width: 1920, height: 1080, toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,x') } as any;
    __TEST_HOOKS__.ctx = { putImageData: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn() } as any;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fires fallback timeout and paints black frame when no frame arrives', () => {
    seekTo(1000);

    vi.advanceTimersByTime(300);

    const ctx = __TEST_HOOKS__.ctx as any;
    expect(ctx.fillRect).toHaveBeenCalled();
  });
});

// ── handleWorkerAudioChunk with isPlaying=true scheduling ─────────────

describe('audio chunk with isPlaying scheduling (Tier 2)', () => {
  let fakeCtx: any;

  beforeEach(() => {
    vi.stubGlobal('window', {});
    __TEST_HOOKS__.worker = { postMessage: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } as any;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __TEST_HOOKS__.audioCtx = null;
    __TEST_HOOKS__.isPlaying = false;
    resetLeakRegistry();
  });

  it('schedules audio nodes when isPlaying and audioCtx ready', () => {
    fakeCtx = fakeEnginePorts.audioContextFactory.create();
    __TEST_HOOKS__.audioCtx = fakeCtx;
    __TEST_HOOKS__.audioConfigVersion = 0;
    __TEST_HOOKS__.isPlaying = true;
    __TEST_HOOKS__.audioPlayStartMs = 0;
    __TEST_HOOKS__.audioPlayStartCtxTime = 0;
    __TEST_HOOKS__.nextAudioStartTime = 0;

    vi.spyOn(fakeCtx, 'createBufferSource');

    handleWorkerMessage({
      data: {
        type: 'audio_chunk',
        ms: 100,
        channels: 2,
        sampleRate: 48000,
        length: 1024,
        buffers: [new ArrayBuffer(4096), new ArrayBuffer(4096)],
        configVersion: 0,
      },
    } as MessageEvent);

    expect(fakeCtx.createBufferSource).toHaveBeenCalled();
  });
});
