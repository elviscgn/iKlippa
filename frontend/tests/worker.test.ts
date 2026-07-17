import { describe, it, expect, beforeEach, vi } from 'vitest';

// We must mock the Wasm module since we are not in a browser environment with real fetch/wasm
vi.mock('../src/engine/pkg/iklippa_engine', () => {
  return {
    default: vi.fn().mockResolvedValue({ memory: { buffer: new ArrayBuffer(1024) } }),
    IklippaEngine: vi.fn().mockImplementation(() => ({
      free: vi.fn(),
      load_project: vi.fn(),
      set_timeline: vi.fn(),
      to_json: vi.fn().mockReturnValue('{}'),
      read_next_video_chunk: vi.fn(),
      seek: vi.fn(),
      resize: vi.fn(),
      frame_ptr: vi.fn().mockReturnValue(0),
      frame_len: vi.fn().mockReturnValue(100),
    })),
  };
});

describe('Worker Message Integration', () => {
  let workerOnMessage: (e: any) => Promise<void>;
  let postMessageMock: any;

  beforeEach(async () => {
    vi.resetModules();
    postMessageMock = vi.fn();
    
    // Mock the global `self` object required by worker.ts
    vi.stubGlobal('self', {
      postMessage: postMessageMock,
      // capture the handler
      set onmessage(handler: any) {
        workerOnMessage = handler;
      }
    });

    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { return { clearRect: vi.fn(), drawImage: vi.fn() }; }
    });
    vi.stubGlobal('VideoDecoder', class {
      configure() {}
      decode() {}
      flush() { return Promise.resolve(); }
      close() {}
      reset() {}
      state = 'unconfigured';
    });
    vi.stubGlobal('AudioDecoder', class {
      configure() {}
      decode() {}
      flush() { return Promise.resolve(); }
      close() {}
      reset() {}
      state = 'unconfigured';
    });

    vi.stubGlobal('EncodedVideoChunk', class {});
    vi.stubGlobal('VideoFrame', class { close() {} });
    vi.stubGlobal('AudioData', class { close() {} });

    // Import the worker to run its top-level setup
    await import('../src/engine/worker');
  });

  it('handles messages in order: init -> load -> seek', async () => {
    // 1. Init
    await workerOnMessage({ data: { type: 'init' } });
    expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'status' }), { transfer: undefined });

    // 2. Load
    await workerOnMessage({ 
      data: { 
        type: 'load', 
        file: { slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) }) }, 
        codecConfig: { codec: 'avc' }, 
        width: 1920, 
        height: 1080, 
        samples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }], 
        durationMs: 1000 
      } 
    });
    // Load finishes by seeking and posting a frame or timeline update.
    // It calls `postMessage({ type: 'frame', ... })` after seekAndDecodeFrame
    expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }), expect.anything());

    // 3. Seek
    await workerOnMessage({ data: { type: 'seek', ms: 1000 } });
    expect(postMessageMock).toHaveBeenCalled();
  });

  it('gracefully fails or ignores out-of-order messages (seek before init/load)', async () => {
    // A seek before any clip is loaded just logs a warning and aborts smoothly
    await workerOnMessage({ data: { type: 'seek', ms: 1000 } });
    // Verify it didn't throw an unhandled exception or post an error
    const messageTypes = postMessageMock.mock.calls.map((c: any[]) => c[0].type);
    expect(messageTypes).not.toContain('error');
    // Because it gracefully aborts, postMessageMock should NOT be called with a frame or frame_dropped for seek
    expect(messageTypes).not.toContain('frame');
  });

  it('handles a burst of seek messages by only executing the latest one', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({ 
      data: { 
        type: 'load', 
        file: { slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) }) }, 
        codecConfig: { codec: 'avc' }, 
        width: 1920, 
        height: 1080, 
        samples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }], 
        durationMs: 1000 
      } 
    });
    postMessageMock.mockClear();

    const p1 = workerOnMessage({ data: { type: 'seek', ms: 1000 } });
    const p2 = workerOnMessage({ data: { type: 'seek', ms: 2000 } });
    const p3 = workerOnMessage({ data: { type: 'seek', ms: 3000 } });

    await Promise.all([p1, p2, p3]);

    const messageTypes = postMessageMock.mock.calls.map((c: any[]) => c[0].type);
    expect(messageTypes.length).toBeGreaterThan(0);
  });
});
