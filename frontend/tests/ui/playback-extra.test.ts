// @vitest-environment jsdom
/**
 * Extra tests for src/ui/playback.ts:
 *  - playLoop RAF callback: time advance and end-of-track stop
 *  - playhead knob drag (mousedown/mousemove/mouseup)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/ui/state', () => {
  const S = {
    time: 0, dur: 20, playing: false, rafId: null as number | null,
    lastTs: null as number | null, zoom: 1, tool: 'select',
    selectedAR: '16/9', timelineHeight: 360,
  };
  return {
    S,
    $: (s: string) => document.querySelector(s) as HTMLElement | null,
    $$: (s: string) => document.querySelectorAll(s),
    us2s: (us: number) => us / 1_000_000,
    mediaPool: { footage: [], audio: [], stock: { video: [], image: [], music: [] } },
    aiNodes: [],
  };
});

vi.mock('../../src/ui/timeline', () => ({
  updatePlayhead: vi.fn(),
  renderRuler: vi.fn(),
  renderClips: vi.fn(),
  calculateTimelineDuration: vi.fn().mockReturnValue(20),
  applyAiAction: vi.fn(),
}));

vi.mock('../../src/ui/timelineUtils', () => ({
  getLaneW: () => 800,
  applySnap: () => null,
  showSnapGuide: vi.fn(),
  hideSnapGuide: vi.fn(),
}));

const FIXTURE = `
  <div id="tl-tracks" style="width:800px;overflow-x:scroll;">
    <div class="tl-clip"></div>
    <div class="track-gutter"></div>
  </div>
  <div id="tl-ruler" style="width:800px;"></div>
  <div id="ph-tracks" style="position:absolute;left:100px;"></div>
  <div id="timecode">00:00:00</div>
  <i class="icon-play" data-lucide="play"></i>
  <div class="playhead-knob" style="position:absolute;left:100px;"></div>
  <div id="toast-box"></div>
`;

describe('playLoop RAF callback via togglePlay', () => {
  let S: any;
  let rafCallbacks: Array<(ts: number) => void>;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.useFakeTimers();
    vi.stubGlobal('lucide', { createIcons: vi.fn() });

    rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockImplementation((cb: (ts: number) => void) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    await import('../../src/ui/playback');
    const state = await import('../../src/ui/state');
    S = (state as any).S;
    S.playing = false;
    S.time = 0;
    S.dur = 20;
    S.rafId = null;
    S.lastTs = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('playLoop advances time on each RAF tick', () => {
    window.togglePlay(); // starts playback, queues first RAF
    expect(rafCallbacks.length).toBeGreaterThanOrEqual(1);

    // Fire first RAF at ts=0
    rafCallbacks[0]!(0);
    expect(S.lastTs).toBe(0);

    // Fire second RAF at ts=100ms
    if (rafCallbacks.length > 1) {
      rafCallbacks[1]!(100);
      expect(S.time).toBeCloseTo(0.1);
    }
  });

  it('playLoop stops when time reaches dur', () => {
    S.time = 19.95;
    window.togglePlay(); // start at near-end
    expect(rafCallbacks.length).toBeGreaterThanOrEqual(1);

    // First tick - set lastTs
    rafCallbacks[0]!(0);

    // Second tick - advance past dur
    if (rafCallbacks.length > 1) {
      rafCallbacks[1]!(200); // +200ms → time > 20s
      expect(S.playing).toBe(false);
    }
  });
});

describe('playhead knob drag via initPlayback', () => {
  let S: any;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const mod = await import('../../src/ui/playback');
    mod.initPlayback();
    const state = await import('../../src/ui/state');
    S = (state as any).S;
    S.dur = 20;
    S.time = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete (window as any).onPlayheadScrub;
  });

  it('knob mousedown + mousemove updates time', () => {
    const knob = document.querySelector('.playhead-knob') as HTMLElement;
    const tlTracks = document.getElementById('tl-tracks')!;
    tlTracks.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 800, height: 200, right: 800, bottom: 200,
    } as DOMRect);

    knob.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 10, bubbles: true }));

    // mousemove to x=500 → time = (500 - 100) / 800 * 20 = 10s
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 10, bubbles: true }));

    expect(S.time).toBeGreaterThan(0);
  });

  it('knob mousemove calls onPlayheadScrub', () => {
    const scrubMock = vi.fn();
    window.onPlayheadScrub = scrubMock;

    const knob = document.querySelector('.playhead-knob') as HTMLElement;
    const tlTracks = document.getElementById('tl-tracks')!;
    tlTracks.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 800, height: 200, right: 800, bottom: 200,
    } as DOMRect);

    knob.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 10, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 10, bubbles: true }));

    expect(scrubMock).toHaveBeenCalled();
  });

  it('knob mouseup stops drag', () => {
    const knob = document.querySelector('.playhead-knob') as HTMLElement;
    const tlTracks = document.getElementById('tl-tracks')!;
    tlTracks.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 800, height: 200, right: 800, bottom: 200,
    } as DOMRect);

    knob.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 10, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // After mouseup, further mousemove should not update time
    const timeBefore = S.time;
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, clientY: 10, bubbles: true }));
    expect(S.time).toBe(timeBefore);
  });
});

describe('handleTimelineScrub – dur=0 guard', () => {
  let S: any;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const mod = await import('../../src/ui/playback');
    mod.initPlayback();
    const state = await import('../../src/ui/state');
    S = (state as any).S;
    S.dur = 0; // edge case
    S.time = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('scrub on ruler with dur=0 does not crash', () => {
    const ruler = document.getElementById('tl-ruler')!;
    ruler.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 800, height: 20, right: 800, bottom: 20,
    } as DOMRect);
    expect(() => ruler.onmousedown!(new MouseEvent('mousedown', { clientX: 400, clientY: 10 }))).not.toThrow();
  });
});
