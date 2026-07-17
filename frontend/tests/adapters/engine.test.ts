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

import { seekTo } from '../../src/engine/engine';

describe('seekTo (Tier 2 - adapter ports)', () => {
  let mockWorker: any;

  beforeEach(() => {
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    __TEST_HOOKS__.worker = mockWorker;
    __TEST_HOOKS__.pendingFrames = new Map();
  });

  it('seek controls update state via worker postMessage', () => {
    seekTo(100);
    expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'seek', ms: 100 });
  });
});
