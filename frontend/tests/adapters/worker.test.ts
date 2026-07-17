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

    vi.stubGlobal('EncodedVideoChunk', class {});
    vi.stubGlobal('EncodedAudioChunk', class {});
    vi.stubGlobal('VideoFrame', class { close() {} });
    vi.stubGlobal('AudioData', class { close() {} });

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
});
