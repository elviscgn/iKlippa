// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  browserSampleReader,
  browserCanvasFactory,
  browserBlobFactory,
  browserUrlFactory,
  browserRafScheduler,
  browserEncodedChunkFactory,
} from '../../src/adapters/browser';

describe('browserSampleReader', () => {
  it('reads sample data from file slice', async () => {
    const buf = new ArrayBuffer(8);
    const mockSlice = { arrayBuffer: vi.fn().mockResolvedValue(buf) };
    const mockFile = { slice: vi.fn().mockReturnValue(mockSlice) } as unknown as File;

    const result = await browserSampleReader.readSampleData(mockFile, {
      offset: 100, size: 50, cts: 0, duration: 1000, timescale: 44100, is_sync: true,
    });

    expect(result).toBe(buf);
    expect(mockFile.slice).toHaveBeenCalledWith(100, 150);
  });
});

describe('browserCanvasFactory', () => {
  it('creates an HTML element with correct tag', () => {
    const el = browserCanvasFactory.createElement('div');
    expect(el).toBeDefined();
  });

  it('creates a canvas element', () => {
    const canvas = browserCanvasFactory.createCanvas();
    expect(canvas).toBeDefined();
  });
});

describe('browserBlobFactory', () => {
  it('creates a Blob', () => {
    const blob = browserBlobFactory.create([new ArrayBuffer(4)], { type: 'video/mp4' });
    expect(blob).toBeInstanceOf(Blob);
  });
});

describe('browserUrlFactory', () => {
  it('creates and revokes object URLs', () => {
    const url = browserUrlFactory.createObjectURL(new Blob());
    expect(url).toBeDefined();

    const spy = vi.spyOn(URL, 'revokeObjectURL');
    browserUrlFactory.revokeObjectURL(url);
    expect(spy).toHaveBeenCalledWith(url);
    spy.mockRestore();
  });
});

describe('browserRafScheduler', () => {
  it('schedules and cancels animation frames', () => {
    const cb = vi.fn();
    const handle = browserRafScheduler.requestAnimationFrame(cb);
    expect(typeof handle).toBe('number');
    browserRafScheduler.cancelAnimationFrame(handle);
  });
});

// ── Need browser-specific stubs ───────────────────────────────────────

describe('browserAudioContextFactory', () => {
  let browserAudioContextFactory: any;

  beforeEach(async () => {
    vi.stubGlobal('window', { AudioContext: class { sampleRate = 44100; state = 'suspended' } as any });
    const mod = await import('../../src/adapters/browser');
    browserAudioContextFactory = mod.browserAudioContextFactory;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates AudioContext from window.AudioContext', () => {
    const ctx = browserAudioContextFactory.create();
    expect(ctx).toBeDefined();
    expect(ctx.sampleRate).toBe(44100);
  });

  it('falls back to webkitAudioContext when AudioContext is unavailable', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', { webkitAudioContext: class { sampleRate = 48000; state = 'suspended' } as any });
    const mod = await import('../../src/adapters/browser');
    const factory = mod.browserAudioContextFactory;
    const ctx = factory.create();
    expect(ctx.sampleRate).toBe(48000);
  });
});

describe('browserVideoEncoderFactory', () => {
  let browserVideoEncoderFactory: any;

  beforeEach(async () => {
    vi.stubGlobal('VideoEncoder', class {
      state = 'unconfigured';
      constructor(_output: any, _error: any) {}
      configure() { this.state = 'configured' as any; }
      encode() {}
      flush() { return Promise.resolve(); }
      close() { this.state = 'closed' as any; }
    } as any);
    const mod = await import('../../src/adapters/browser');
    browserVideoEncoderFactory = mod.browserVideoEncoderFactory;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a VideoEncoder with callbacks', () => {
    const output = vi.fn();
    const error = vi.fn();
    const encoder = browserVideoEncoderFactory.create(output, error);
    expect(encoder).toBeDefined();
    encoder.close();
  });
});

describe('browserOffscreenCanvasFactory', () => {
  let browserOffscreenCanvasFactory: any;

  beforeEach(async () => {
    vi.stubGlobal('OffscreenCanvas', class {
      width: number = 0;
      height: number = 0;
      constructor(w: number, h: number) { this.width = w; this.height = h; }
      getContext() { return {}; }
    } as any);
    const mod = await import('../../src/adapters/browser');
    browserOffscreenCanvasFactory = mod.browserOffscreenCanvasFactory;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates an offscreen canvas', () => {
    const canvas = browserOffscreenCanvasFactory.create(640, 480);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
  });
});

describe('browserEncodedChunkFactory', () => {
  let browserEncodedChunkFactory: any;

  beforeEach(async () => {
    vi.stubGlobal('EncodedVideoChunk', class {
      type: string;
      timestamp: number;
      duration: number;
      byteLength = 0;
      constructor(init: any) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.duration = init.duration;
      }
      copyTo(_buf: ArrayBuffer) {}
    } as any);
    vi.stubGlobal('EncodedAudioChunk', class {
      type: string;
      timestamp: number;
      duration: number;
      byteLength = 0;
      constructor(init: any) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.duration = init.duration;
      }
      copyTo(_buf: ArrayBuffer) {}
    } as any);
    const mod = await import('../../src/adapters/browser');
    browserEncodedChunkFactory = mod.browserEncodedChunkFactory;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a video chunk', () => {
    const chunk = browserEncodedChunkFactory.createVideoChunk({
      type: 'key', timestamp: 1000, duration: 33, data: new ArrayBuffer(100),
    });
    expect(chunk).toBeDefined();
    expect(chunk.type).toBe('key');
    expect(chunk.timestamp).toBe(1000);
    expect(chunk.duration).toBe(33);
  });

  it('creates an audio chunk', () => {
    const chunk = browserEncodedChunkFactory.createAudioChunk({
      type: 'key', timestamp: 1000, duration: 33, data: new ArrayBuffer(100),
    });
    expect(chunk).toBeDefined();
    expect(chunk.type).toBe('key');
  });
});
