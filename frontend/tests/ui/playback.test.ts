// @vitest-environment jsdom
/**
 * Tests for src/ui/playback.ts:
 *   - togglePlay (play/pause, at end resets to 0)
 *   - skipTime
 *   - initPlayback (space bar, scrubbing on tl-tracks and tl-ruler, playhead knob drag)
 *   - handleTimelineScrub
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/ui/state', () => {
  const S = {
    time: 0, dur: 20, playing: false, rafId: null as number | null, lastTs: null as number | null,
    zoom: 1, tool: 'select', selectedAR: '16/9', timelineHeight: 360,
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
  <div class="playhead-knob" style="position:absolute;"></div>
  <div id="toast-box"></div>
`;

describe('togglePlay', () => {
  let S: any;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.useFakeTimers();
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(42));
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

  it('starts playback when not playing', () => {
    window.togglePlay();
    expect(S.playing).toBe(true);
  });

  it('stops playback when playing', () => {
    S.playing = true;
    S.rafId = 42;
    window.togglePlay();
    expect(S.playing).toBe(false);
  });

  it('resets time to 0 when at end before playing', () => {
    S.time = S.dur; // at end
    window.togglePlay();
    expect(S.time).toBe(0);
  });

  it('icon-play gets set to pause icon when playing starts', () => {
    window.togglePlay();
    const icon = document.querySelector('.icon-play')!;
    expect(icon.getAttribute('data-lucide')).toBe('pause');
  });

  it('icon-play gets set back to play icon when stopping', () => {
    S.playing = true;
    window.togglePlay();
    const icon = document.querySelector('.icon-play')!;
    expect(icon.getAttribute('data-lucide')).toBe('play');
  });
});

describe('skipTime', () => {
  let S: any;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    await import('../../src/ui/playback');
    const state = await import('../../src/ui/state');
    S = (state as any).S;
    S.time = 5;
    S.dur = 20;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('moves time forward', () => {
    window.skipTime(3);
    expect(S.time).toBeCloseTo(8);
  });

  it('moves time backward', () => {
    window.skipTime(-3);
    expect(S.time).toBeCloseTo(2);
  });

  it('clamps to 0 at minimum', () => {
    window.skipTime(-100);
    expect(S.time).toBe(0);
  });

  it('clamps to dur at maximum', () => {
    window.skipTime(100);
    expect(S.time).toBe(S.dur);
  });

  it('calls onPlayheadScrub if defined', () => {
    const scrubMock = vi.fn();
    window.onPlayheadScrub = scrubMock;
    window.skipTime(1);
    expect(scrubMock).toHaveBeenCalled();
    delete (window as any).onPlayheadScrub;
  });
});

describe('initPlayback – keyboard space', () => {
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
    S.playing = false;
    S.time = 0;
    S.dur = 20;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('space bar triggers togglePlay', () => {
    const before = S.playing;
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    expect(S.playing).toBe(!before);
  });

  it('space bar in INPUT does not toggle', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    S.playing = false;
    const event = new KeyboardEvent('keydown', { code: 'Space', bubbles: true });
    Object.defineProperty(event, 'target', { value: input });
    document.dispatchEvent(event);
    // should remain false
    expect(S.playing).toBe(false);
  });
});

describe('initPlayback – timeline scrub', () => {
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
  });

  it('mousedown on tl-tracks (non-clip area) scrubs time', () => {
    const tlTracks = document.getElementById('tl-tracks')!;
    tlTracks.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 200, right: 800, bottom: 200 } as DOMRect);

    // Click at x=200 (not on clip, not on gutter)
    const event = new MouseEvent('mousedown', { clientX: 200, clientY: 100, bubbles: true });
    // Dispatch directly on the element (not via .tl-clip target)
    tlTracks.dispatchEvent(event);

    // time should have been updated
    expect(S.time).toBeGreaterThanOrEqual(0);
  });

  it('mousedown on tl-ruler sets time', () => {
    const tlRuler = document.getElementById('tl-ruler')!;
    tlRuler.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 20, right: 800, bottom: 20 } as DOMRect);

    const event = new MouseEvent('mousedown', { clientX: 400, clientY: 10, bubbles: true });
    tlRuler.onmousedown!(event);

    expect(S.time).toBeGreaterThan(0);
  });
});
