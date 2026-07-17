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
});
