import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setPorts, resetPorts } from '../../src/adapters';
import { fakeEnginePorts, resetLeakRegistry, expectNoLeaks } from '../fakes';

beforeEach(() => {
  resetLeakRegistry();
  setPorts(fakeEnginePorts);
});

afterEach(() => {
  expectNoLeaks();
  resetPorts();
});

vi.mock('../../src/engine/pkg/iklippa_engine', () => {
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
      set_exposure: vi.fn(),
      set_contrast: vi.fn(),
      set_saturation: vi.fn(),
      set_temperature: vi.fn(),
      set_highlights: vi.fn(),
      set_shadows: vi.fn(),
      set_vignette: vi.fn(),
      set_grain: vi.fn(),
      set_lut: vi.fn(),
      process_frame: vi.fn(),
    })),
  };
});

describe('Worker Message Integration (Tier 2 - adapter ports)', () => {
  let workerOnMessage: (e: any) => Promise<void>;
  let postMessageMock: any;

  beforeEach(async () => {
    vi.resetModules();
    postMessageMock = vi.fn();

    vi.stubGlobal('self', {
      postMessage: postMessageMock,
      set onmessage(handler: any) {
        workerOnMessage = handler;
      },
    });

    vi.stubGlobal('VideoDecoder', class {
      configure() {}
      decode() {}
      flush() { return Promise.resolve(); }
      close() {}
      reset() {}
      state = 'unconfigured';
      get decodeQueueSize() { return 0; }
    });
    vi.stubGlobal('AudioDecoder', class {
      configure() {}
      decode() {}
      flush() { return Promise.resolve(); }
      close() {}
      reset() {}
      state = 'unconfigured';
      get decodeQueueSize() { return 0; }
    });
    vi.stubGlobal('OffscreenCanvas', class {
      width: number = 0;
      height: number = 0;
      constructor(w: number, h: number) { this.width = w; this.height = h; }
      getContext() { return { clearRect: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(100) })) }; }
    });
    vi.stubGlobal('EncodedVideoChunk', class {});
    vi.stubGlobal('EncodedAudioChunk', class {});
    vi.stubGlobal('VideoFrame', class { close() {} timestamp: number = 0; format: string | null = null; copyTo() {} });
    vi.stubGlobal('AudioData', class { close() {} timestamp: number = 0; numberOfChannels: number = 0; sampleRate: number = 0; numberOfFrames: number = 0; format: string = 'f32'; allocationSize() { return 0; }; copyTo() {} });

    await import('../../src/engine/worker');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handles messages in order: init -> load -> seek', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    const statusCalls = postMessageMock.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'status'
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);

    await workerOnMessage({
      data: {
        type: 'load',
        file: { slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) }) },
        codecConfig: { codec: 'avc' },
        width: 1920,
        height: 1080,
        samples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }],
        durationMs: 1000,
      },
    });

    const readyCalls = postMessageMock.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'ready'
    );
    expect(readyCalls.length).toBeGreaterThanOrEqual(1);

    await workerOnMessage({ data: { type: 'seek', ms: 1000 } });
    expect(postMessageMock).toHaveBeenCalled();
  });

  it('gracefully handles seek before init/load', async () => {
    await workerOnMessage({ data: { type: 'seek', ms: 1000 } });
    const messageTypes = postMessageMock.mock.calls.map((c: any[]) => c[0]?.type);
    expect(messageTypes).not.toContain('frame');
  });

  it('handleSetGrade: calls postMessage with forceRenderMs after load', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({
      data: {
        type: 'load',
        file: { slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) }) },
        codecConfig: { codec: 'avc' },
        width: 1920,
        height: 1080,
        samples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }],
        durationMs: 1000,
      },
    });
    postMessageMock.mockClear();

    await workerOnMessage({
      data: { type: 'set_grade', params: { exposure: 0.5 }, forceRenderMs: 100 },
    });

    const decodeCalls = postMessageMock.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'decode_submit'
    );
    expect(decodeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('handleSetGrade: does not crash without forceRenderMs', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({
      data: {
        type: 'load',
        file: { slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) }) },
        codecConfig: { codec: 'avc' },
        width: 1920,
        height: 1080,
        samples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }],
        durationMs: 1000,
      },
    });
    postMessageMock.mockClear();

    await workerOnMessage({
      data: { type: 'set_grade', params: { exposure: 0.5 } },
    });

    const decodeCalls = postMessageMock.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'decode_submit'
    );
    expect(decodeCalls.length).toBe(0);
  });

  it('handleSetTimeline: responds with ok:true for valid JSON', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({
      data: {
        type: 'load',
        file: { slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) }) },
        codecConfig: { codec: 'avc' },
        width: 1920,
        height: 1080,
        samples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }],
        durationMs: 1000,
      },
    });
    postMessageMock.mockClear();

    await workerOnMessage({
      data: { type: 'set_timeline', json: '{"tracks":[]}' },
    });

    const timelineSetCalls = postMessageMock.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'timeline_set'
    );
    expect(timelineSetCalls.length).toBe(1);
    expect(timelineSetCalls[0][0]).toEqual({ type: 'timeline_set', ok: true });
  });

  it('handleSetTimeline: responds with ok:false on error', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({
      data: {
        type: 'load',
        file: { slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) }) },
        codecConfig: { codec: 'avc' },
        width: 1920,
        height: 1080,
        samples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }],
        durationMs: 1000,
      },
    });

    const engine = await import('../../src/engine/pkg/iklippa_engine');
    const instance = (engine.IklippaEngine as any).mock.results.at(-1).value;
    instance.set_timeline.mockImplementationOnce(() => { throw new Error('bad json'); });
    postMessageMock.mockClear();

    await workerOnMessage({
      data: { type: 'set_timeline', json: 'invalid' },
    });

    const timelineSetCalls = postMessageMock.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'timeline_set'
    );
    expect(timelineSetCalls.length).toBe(1);
    expect(timelineSetCalls[0][0].ok).toBe(false);
    expect(timelineSetCalls[0][0].error).toBeDefined();
  });

  it('handleGetProjectJson: responds with project_json after load', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({
      data: {
        type: 'load',
        file: { slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) }) },
        codecConfig: { codec: 'avc' },
        width: 1920,
        height: 1080,
        samples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }],
        durationMs: 1000,
      },
    });
    postMessageMock.mockClear();

    await workerOnMessage({ data: { type: 'get_project_json' } });

    const projectJsonCalls = postMessageMock.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'project_json'
    );
    expect(projectJsonCalls.length).toBe(1);
    expect(projectJsonCalls[0][0].json).toBe('{}');
  });

  it('handleSetAudioVersion: sets version without crashing', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    postMessageMock.mockClear();

    await workerOnMessage({ data: { type: 'set_audio_version', version: 5 } });

    expect(true).toBe(true);
  });

  it('handleSync: processes sync message without crashing', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({
      data: {
        type: 'load',
        file: { slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) }) },
        codecConfig: { codec: 'avc' },
        width: 1920,
        height: 1080,
        samples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }],
        durationMs: 1000,
      },
    });
    postMessageMock.mockClear();

    await workerOnMessage({
      data: { type: 'sync', playheadMs: 500, isPlaying: true, framesAhead: 5 },
    });

    expect(true).toBe(true);
  });

  it('handleSync: does not decode when not playing', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({
      data: {
        type: 'load',
        file: { slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) }) },
        codecConfig: { codec: 'avc' },
        width: 1920,
        height: 1080,
        samples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }],
        durationMs: 1000,
      },
    });
    postMessageMock.mockClear();

    await workerOnMessage({
      data: { type: 'sync', playheadMs: 500, isPlaying: false, framesAhead: 5 },
    });

    // Should not trigger decode, no new frames posted
    const decodeSubmits = postMessageMock.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'decode_submit'
    );
    expect(decodeSubmits.length).toBe(0);
  });

  it('handleSetTimeline: warns when WASM not ready', async () => {
    // No init/load — WASM not ready
    postMessageMock.mockClear();

    await workerOnMessage({
      data: { type: 'set_timeline', json: '{}' },
    });

    // Should not have posted timeline_set response
    const timelineCalls = postMessageMock.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'timeline_set'
    );
    expect(timelineCalls.length).toBe(0);
  });

  it('handleGetProjectJson: does nothing when WASM not ready', async () => {
    // No init/load — WASM not ready
    postMessageMock.mockClear();

    await workerOnMessage({ data: { type: 'get_project_json' } });

    const projectCalls = postMessageMock.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'project_json'
    );
    expect(projectCalls.length).toBe(0);
  });

  it('handles unknown message type without crashing', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({ data: { type: 'unknown_type' } });

    expect(true).toBe(true);
  });

  it('seek when no clips loaded warns and returns', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    postMessageMock.mockClear();

    await workerOnMessage({ data: { type: 'seek', ms: 1000 } });
    // Should warn but not post any frames
    const frameCalls = postMessageMock.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'frame'
    );
    expect(frameCalls.length).toBe(0);
  });

  // ── Error boundary: no failure may stay silent ──────────────────────

  const loadMsg = {
    type: 'load',
    file: { slice: () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)) }) },
    codecConfig: { codec: 'avc' },
    width: 1920,
    height: 1080,
    samples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }],
    durationMs: 1000,
  };

  function stubVideoDecoderCapturing() {
    const captured: { output?: (f: any) => void; error?: (e: Error) => void } = {};
    vi.stubGlobal('VideoDecoder', class {
      constructor(init: any) {
        captured.output = init.output;
        captured.error = init.error;
      }
      configure() {}
      decode() {}
      flush() { return Promise.resolve(); }
      close() {}
      reset() {}
      state = 'configured';
      get decodeQueueSize() { return 0; }
    });
    return captured;
  }

  it('posts WASM_INIT_FAILED when WASM init rejects', async () => {
    const engine = await import('../../src/engine/pkg/iklippa_engine');
    (engine.default as any).mockRejectedValueOnce(new Error('compile boom'));

    await workerOnMessage({ data: { type: 'init' } });

    const errCalls = postMessageMock.mock.calls.filter((c: any[]) => c[0]?.type === 'error');
    expect(errCalls.length).toBe(1);
    expect(errCalls[0][0].error.code).toBe('WASM_INIT_FAILED');
    expect(errCalls[0][0].error.fatal).toBe(true);
    expect(errCalls[0][0].error.message).toContain('compile boom');
  });

  it('posts LOAD_FAILED (and no ready) when sample reads fail during load', async () => {
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({
      data: {
        ...loadMsg,
        file: { slice: () => ({ arrayBuffer: () => Promise.reject(new Error('read boom')) }) },
      },
    });

    const types = postMessageMock.mock.calls.map((c: any[]) => c[0]?.type);
    const errCalls = postMessageMock.mock.calls.filter((c: any[]) => c[0]?.type === 'error');
    expect(types).not.toContain('ready');
    expect(errCalls.length).toBe(1);
    expect(errCalls[0][0].error.code).toBe('LOAD_FAILED');
  });

  it('posts DECODER_VIDEO_FATAL when the video decoder error callback fires', async () => {
    const captured = stubVideoDecoderCapturing();
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({ data: loadMsg });
    postMessageMock.mockClear();

    captured.error!(new Error('decode boom'));

    const errCalls = postMessageMock.mock.calls.filter((c: any[]) => c[0]?.type === 'error');
    expect(errCalls.length).toBe(1);
    expect(errCalls[0][0].error.code).toBe('DECODER_VIDEO_FATAL');
    expect(errCalls[0][0].error.fatal).toBe(true);
  });

  it('posts DECODER_AUDIO_FATAL when the audio decoder error callback fires', async () => {
    let audioErrorCb: ((e: Error) => void) | null = null;
    vi.stubGlobal('AudioDecoder', class {
      constructor(init: any) { audioErrorCb = init.error; }
      configure() {}
      decode() {}
      flush() { return Promise.resolve(); }
      close() {}
      reset() {}
      state = 'configured';
      get decodeQueueSize() { return 0; }
    });
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({
      data: {
        ...loadMsg,
        audioConfig: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
        audioSamples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }],
        audioConfigVersion: 1,
      },
    });
    postMessageMock.mockClear();

    audioErrorCb!(new Error('audio boom'));

    const errCalls = postMessageMock.mock.calls.filter((c: any[]) => c[0]?.type === 'error');
    expect(errCalls.length).toBe(1);
    expect(errCalls[0][0].error.code).toBe('DECODER_AUDIO_FATAL');
  });

  // ── Pause→play audio recovery ───────────────────────────────────────

  function stubAudioDecoderWithSpy() {
    const decodeSpy = vi.fn();
    vi.stubGlobal('AudioDecoder', class {
      constructor(_init: any) {}
      configure() {}
      decode(...args: any[]) { decodeSpy(...args); }
      flush() { return Promise.resolve(); }
      close() {}
      reset() {}
      state = 'configured';
      get decodeQueueSize() { return 0; }
    });
    return decodeSpy;
  }

  const audioCfg = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 };

  it('resync_audio rewinds the audio decode front and re-primes', async () => {
    const decodeSpy = stubAudioDecoderWithSpy();
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({
      data: {
        ...loadMsg,
        audioConfig: audioCfg,
        audioSamples: [{ offset: 0, size: 100, timescale: 1000, duration: 1000, cts: 0, dts: 0, is_sync: true }],
        audioConfigVersion: 1,
      },
    });
    decodeSpy.mockClear();

    await workerOnMessage({ data: { type: 'resync_audio', ms: 0 } });

    expect(decodeSpy).toHaveBeenCalled(); // re-primed from the resync target
  });

  it('never decodes audio further than 1s past the playhead', async () => {
    const decodeSpy = stubAudioDecoderWithSpy();
    vi.stubGlobal('VideoDecoder', class {
      constructor(_init: any) {}
      configure() {}
      decode() {}
      flush() { return Promise.resolve(); }
      close() {}
      reset() {}
      state = 'configured';
      get decodeQueueSize() { return 0; }
    });

    const audioSamples = [0, 1000, 2000, 3000, 4000, 5000].map((ms) => ({
      offset: 0, size: 100, timescale: 1000, duration: 1000, cts: ms, dts: ms, is_sync: true,
    }));
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({
      data: { ...loadMsg, audioConfig: audioCfg, audioSamples, audioConfigVersion: 1 },
    });
    // load primes 600ms from 0 → only the 0ms sample
    expect(decodeSpy.mock.calls.length).toBe(1);
    decodeSpy.mockClear();

    // playhead 0 → only the 1000ms sample is within lookahead
    await workerOnMessage({ data: { type: 'sync', playheadMs: 0, isPlaying: true, framesAhead: 0 } });
    expect(decodeSpy.mock.calls.length).toBe(1);

    // playhead 3000 → 2000, 3000, 4000ms samples decode; 5000ms stays gated
    // (spy is cumulative: 1 from the first sync + 3 here)
    await workerOnMessage({ data: { type: 'sync', playheadMs: 3000, isPlaying: true, framesAhead: 0 } });
    expect(decodeSpy.mock.calls.length).toBe(4);
  });

  it('posts WASM_PANIC when process_frame throws inside the decoder callback', async () => {
    const captured = stubVideoDecoderCapturing();
    await workerOnMessage({ data: { type: 'init' } });
    await workerOnMessage({ data: loadMsg });

    const engine = await import('../../src/engine/pkg/iklippa_engine');
    const instance = (engine.IklippaEngine as any).mock.results.at(-1).value;
    instance.process_frame.mockImplementationOnce(() => {
      throw new Error('rust panic: unreachable');
    });
    postMessageMock.mockClear();

    captured.output!({
      timestamp: 0,
      format: 'RGBA',
      copyTo: async () => {},
      close: vi.fn(),
    });
    await new Promise((r) => setTimeout(r, 0));

    const errCalls = postMessageMock.mock.calls.filter((c: any[]) => c[0]?.type === 'error');
    expect(errCalls.length).toBe(1);
    expect(errCalls[0][0].error.code).toBe('WASM_PANIC');
    expect(errCalls[0][0].error.fatal).toBe(true);
    // Panic must not produce a (poisoned) frame message
    const frameCalls = postMessageMock.mock.calls.filter((c: any[]) => c[0]?.type === 'frame');
    expect(frameCalls.length).toBe(0);
  });

  it('reports unhandled promise rejections via the global net', async () => {
    const selfStub = (globalThis as any).self;
    expect(typeof selfStub.onunhandledrejection).toBe('function');

    selfStub.onunhandledrejection({
      reason: new Error('promise boom'),
      preventDefault: vi.fn(),
    });

    const errCalls = postMessageMock.mock.calls.filter((c: any[]) => c[0]?.type === 'error');
    expect(errCalls.length).toBe(1);
    expect(errCalls[0][0].error.code).toBe('WORKER_UNHANDLED_REJECTION');
  });

  it('attaches recent worker log lines to error reports', async () => {
    const engine = await import('../../src/engine/pkg/iklippa_engine');
    (engine.default as any).mockRejectedValueOnce(new Error('compile boom'));

    await workerOnMessage({ data: { type: 'init' } });

    const errCalls = postMessageMock.mock.calls.filter((c: any[]) => c[0]?.type === 'error');
    expect(errCalls[0][0].error.detail).toContain('compile boom');
    expect(errCalls[0][0].error.detail).toContain('recent worker log');
  });
});
