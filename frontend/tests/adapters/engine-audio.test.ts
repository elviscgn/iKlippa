/**
 * Tests for the pause→play audio recovery:
 *   - startPlayback asks the worker to rewind its audio decode front
 *   - stale pendingAudio leftovers are dropped, never double-scheduled
 *   - finished audio nodes are removed from scheduledAudioNodes
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setPorts, resetPorts, getPorts } from '../../src/adapters';
import { fakeEnginePorts, expectNoLeaks, resetLeakRegistry } from '../fakes';
import { togglePlayback, handleWorkerMessage, __TEST_HOOKS__ } from '../../src/engine/engine';

beforeEach(() => {
  resetLeakRegistry();
  setPorts(fakeEnginePorts);
  vi.stubGlobal('window', {});
});

afterEach(() => {
  expectNoLeaks();
  resetPorts();
  vi.unstubAllGlobals();
});

function setupStoppedPlayback() {
  const postMessage = vi.fn();
  __TEST_HOOKS__.worker = { postMessage } as any;
  __TEST_HOOKS__.isPlaying = false;
  __TEST_HOOKS__.scheduledAudioNodes = [];
  __TEST_HOOKS__.audioCtx = null;
  return postMessage;
}

describe('pause→play audio recovery (Tier 2 - adapter ports)', () => {
  it('posts resync_audio with the playhead source ms when playback starts', async () => {
    const postMessage = setupStoppedPlayback();
    __TEST_HOOKS__.playheadMs = 1234;
    __TEST_HOOKS__.pendingAudio = new Map();

    togglePlayback();
    await new Promise((r) => setTimeout(r, 0));

    expect(postMessage).toHaveBeenCalledWith({ type: 'resync_audio', ms: 1234 });
    __TEST_HOOKS__.isPlaying = false;
  });

  it('clears stale pendingAudio on play instead of scheduling it', async () => {
    setupStoppedPlayback();
    __TEST_HOOKS__.playheadMs = 0;
    const stale = new Map<number, AudioBuffer>();
    stale.set(100, {} as AudioBuffer);
    __TEST_HOOKS__.pendingAudio = stale;

    togglePlayback();
    await new Promise((r) => setTimeout(r, 0));

    // Leftovers must be dropped, not scheduled — the worker re-sends those
    // chunks via resync_audio, so scheduling both would double-stack audio.
    expect(stale.size).toBe(0);
    expect(__TEST_HOOKS__.scheduledAudioNodes.length).toBe(0);
    __TEST_HOOKS__.isPlaying = false;
  });

  it('removes audio nodes from scheduledAudioNodes when they end', () => {
    __TEST_HOOKS__.isPlaying = true;
    __TEST_HOOKS__.scheduledAudioNodes = [];
    __TEST_HOOKS__.pendingAudio = new Map();
    __TEST_HOOKS__.audioConfigVersion = 0;
    __TEST_HOOKS__.audioPlayStartMs = 0;
    __TEST_HOOKS__.audioPlayStartCtxTime = 0;
    __TEST_HOOKS__.nextAudioStartTime = 0;
    const ctx = getPorts().audioContextFactory.create() as any;
    __TEST_HOOKS__.audioCtx = ctx;
    const sourceSpy = vi.spyOn(ctx, 'createBufferSource');

    handleWorkerMessage({
      data: {
        type: 'audio_chunk',
        ms: 100,
        channels: 1,
        sampleRate: 48000,
        length: 100,
        buffers: [new ArrayBuffer(400)],
        configVersion: 0,
      },
    } as MessageEvent);

    expect(__TEST_HOOKS__.scheduledAudioNodes.length).toBe(1);
    const node = sourceSpy.mock.results[0]!.value;
    node.onended();
    expect(__TEST_HOOKS__.scheduledAudioNodes.length).toBe(0);

    // cleanup tracked fakes so the leak registry stays happy
    node.close();
    for (const buf of __TEST_HOOKS__.pendingAudio.values()) (buf as any).close?.();
    __TEST_HOOKS__.pendingAudio = new Map();
    __TEST_HOOKS__.isPlaying = false;
  });
});
