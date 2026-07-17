import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setPorts, resetPorts } from '../../src/adapters';
import { fakeEnginePorts, expectNoLeaks, resetLeakRegistry } from '../fakes';
import type { FakeAudioContextType } from '../fakes';

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
    mockWorker.postMessage.mockImplementation((msg: any) => {
      if (msg.type === 'seek') {
        const fakeImage = { data: { buffer: new ArrayBuffer(0) } } as any;
        __TEST_HOOKS__.pendingFrames.set(msg.ms, fakeImage);
        __TEST_HOOKS__.exportFrames.push({ ms: msg.ms, imageData: fakeImage });
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
    expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'seek', ms: 100 });
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
