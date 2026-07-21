// @vitest-environment jsdom
/**
 * Tests for src/ui/timeline.ts functions:
 *  - calculateTimelineDuration
 *  - renderRuler
 *  - renderClips
 *  - updatePlayhead
 *  - applyAiAction
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks (hoisted) ────────────────────────────────────────────────────────

const mockS: any = {
  time: 0, dur: 20, playing: false, rafId: null, lastTs: null,
  zoom: 1, tool: 'select', selectedAR: '16/9', timelineHeight: 360,
};

const mockAiNodes: any[] = [];

vi.mock('../../src/ui/state', () => ({
  get S() { return mockS; },
  $: (s: string) => document.querySelector(s) as HTMLElement | null,
  $$: (s: string) => document.querySelectorAll(s),
  us2s: (us: number) => us / 1_000_000,
  mediaPool: { footage: [], audio: [], stock: { video: [], image: [], music: [] } },
  get aiNodes() { return mockAiNodes; },
}));

vi.mock('../../src/ui/utils', () => ({
  picUrl: (id: any, w: number, h: number) => `https://picsum.photos/id/${id}/${w}/${h}`,
  showToast: vi.fn(),
  resizeCanvas: vi.fn(),
}));

vi.mock('../../src/ui/dragDrop', () => ({
  applyDragLogic: vi.fn(),
  selectedClipIds: new Set(),
  saveSnapshot: vi.fn(),
}));

vi.mock('../../src/ui/timelineUtils', () => ({
  getLaneW: () => 800,
  applySnap: (_us: number) => null,
  showSnapGuide: vi.fn(),
  hideSnapGuide: vi.fn(),
}));

// ── DOM Fixture ─────────────────────────────────────────────────────────────
const FIXTURE = `
  <div id="tl-ruler" style="width:800px;"></div>
  <div id="tl-body" style="width:800px;height:200px;"></div>
  <div class="tl-ruler-wrapper" style="width:800px;overflow-x:scroll;"></div>
  <div id="tl-tracks" style="width:800px;overflow-x:scroll;">
    <div class="track-gutter"></div>
    <div id="lane-v1" style="width:800px;height:60px;"></div>
    <div id="lane-a1" style="width:800px;height:40px;"></div>
    <div id="lane-ai" style="width:800px;height:30px;"></div>
  </div>
  <div id="ph-tracks" style="position:absolute;left:100px;"></div>
  <div id="timecode">00:00:00</div>
  <div id="zoom-text">100%</div>
  <button id="zoom-in"></button>
  <button id="zoom-out"></button>
  <div id="tl-resize-handle"></div>
  <div class="panel-timeline" style="height:360px;"></div>
  <button class="tl-tool active" data-tool="select"></button>
  <button class="tl-tool" data-tool="split"></button>
  <div id="insight-score">0</div>
  <div id="insight-bar" style="width:0%"></div>
  <div id="insight-box"></div>
  <div id="toast-box"></div>
  <div id="caption-overlay"></div>
`;

// ── calculateTimelineDuration ───────────────────────────────────────────────
describe('calculateTimelineDuration', () => {
  let calcFn: () => number;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/timeline');
    calcFn = mod.calculateTimelineDuration;
    mockS.dur = 20;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns ≥10 when IKState is undefined', () => {
    delete (window as any).IKState;
    const result = calcFn();
    expect(result).toBeGreaterThanOrEqual(10);
  });

  it('returns ≥10 when IKState is not ready', () => {
    (window as any).IKState = { isReady: () => false };
    const result = calcFn();
    expect(result).toBeGreaterThanOrEqual(10);
    delete (window as any).IKState;
  });

  it('returns max clip end + 10 when IKState is ready', () => {
    (window as any).IKState = {
      isReady: () => true,
      getVideoClips: () => [{ timeline_start_us: 0, timeline_end_us: 5_000_000 }],
      getAudioClips: () => [],
    };
    const result = calcFn();
    expect(result).toBeGreaterThanOrEqual(15);
    delete (window as any).IKState;
  });
});

// ── renderRuler ────────────────────────────────────────────────────────────
describe('renderRuler', () => {
  let renderRuler: () => void;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/timeline');
    renderRuler = mod.renderRuler;
    mockS.dur = 20;
    mockS.zoom = 1;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does nothing if tl-ruler element is absent', () => {
    document.getElementById('tl-ruler')?.remove();
    expect(() => renderRuler()).not.toThrow();
  });

  it('populates ruler ticks', () => {
    renderRuler();
    const ticks = document.querySelectorAll('.ruler-tick');
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('generates second-only labels for short durations', () => {
    mockS.dur = 8;
    renderRuler();
    const labels = Array.from(document.querySelectorAll('.tick-label')).map(
      (el) => el.textContent ?? ''
    );
    expect(labels.some(l => l.endsWith('s'))).toBe(true);
  });

  it('generates minute:second labels for long durations', () => {
    mockS.dur = 90;
    renderRuler();
    const labels = Array.from(document.querySelectorAll('.tick-label')).map(
      (el) => el.textContent ?? ''
    );
    expect(labels.some(l => l.includes(':'))).toBe(true);
  });

  it('uses 0.5s interval when dur<=10 and zoom>1.5', () => {
    mockS.dur = 8;
    mockS.zoom = 2;
    renderRuler();
    const ticks = document.querySelectorAll('.ruler-tick');
    // 0.5s interval → more ticks than 1s interval
    expect(ticks.length).toBeGreaterThan(8);
    mockS.zoom = 1;
  });
});

// ── renderClips ────────────────────────────────────────────────────────────
describe('renderClips', () => {
  let renderClips: () => void;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/timeline');
    renderClips = mod.renderClips;
    mockS.dur = 20;
    delete (window as any).IKState;
    mockAiNodes.splice(0, mockAiNodes.length);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete (window as any).IKState;
    mockAiNodes.splice(0, mockAiNodes.length);
  });

  it('does nothing when IKState is absent', () => {
    expect(() => renderClips()).not.toThrow();
    expect(document.getElementById('lane-v1')!.innerHTML).toBe('');
  });

  it('shows empty hint when no video clips', () => {
    (window as any).IKState = {
      getVideoClips: () => [],
      getAudioClips: () => [],
    };
    window.lucide = { createIcons: vi.fn() };
    renderClips();
    expect(document.getElementById('lane-v1')!.innerHTML).toContain('Drop video here');
  });

  it('renders a video clip without thumbnails (name only, isReal)', () => {
    (window as any).IKState = {
      getVideoClips: () => [{
        id: 'vc1', group_id: 'g1', name: 'test.mp4',
        timeline_start_us: 0, timeline_end_us: 4_000_000,
        isReal: true, thumbnails: [],
      }],
      getAudioClips: () => [],
    };
    window.lucide = { createIcons: vi.fn() };
    renderClips();
    expect(document.getElementById('lane-v1')!.innerHTML).toContain('test.mp4');
  });

  it('renders a video clip with thumbnails', () => {
    (window as any).IKState = {
      getVideoClips: () => [{
        id: 'vc1', group_id: 'g1', name: 'film.mp4',
        timeline_start_us: 0, timeline_end_us: 4_000_000,
        isReal: true,
        thumbnails: [{ dataUrl: 'data:image/jpeg;base64,abc' }],
      }],
      getAudioClips: () => [],
    };
    window.lucide = { createIcons: vi.fn() };
    renderClips();
    const imgs = document.getElementById('lane-v1')!.querySelectorAll('img');
    expect(imgs.length).toBeGreaterThan(0);
  });

  it('renders a stock clip with picId', () => {
    (window as any).IKState = {
      getVideoClips: () => [{
        id: 'sv1', name: 'Stock.mp4',
        timeline_start_us: 0, timeline_end_us: 4_000_000,
        isReal: false, picId: 42,
      }],
      getAudioClips: () => [],
    };
    window.lucide = { createIcons: vi.fn() };
    renderClips();
    expect(document.getElementById('lane-v1')!.innerHTML).toContain('picsum');
  });

  it('renders a clip with no picId (name only fallback)', () => {
    (window as any).IKState = {
      getVideoClips: () => [{
        id: 'sv2', name: 'Minimal.mp4',
        timeline_start_us: 0, timeline_end_us: 4_000_000,
        isReal: false, picId: undefined,
      }],
      getAudioClips: () => [],
    };
    window.lucide = { createIcons: vi.fn() };
    renderClips();
    expect(document.getElementById('lane-v1')!.innerHTML).toContain('Minimal.mp4');
  });

  it('renders a standalone audio clip with waveform bars', () => {
    (window as any).IKState = {
      getVideoClips: () => [],
      getAudioClips: () => [{
        id: 'ac1', group_id: 'ga1', name: 'music.mp3',
        timeline_start_us: 0, timeline_end_us: 4_000_000,
      }],
    };
    window.lucide = { createIcons: vi.fn() };
    renderClips();
    expect(document.getElementById('lane-a1')!.innerHTML).toContain('waveform');
  });

  it('renders ai nodes in lane-ai', () => {
    mockAiNodes.push({ time: 2, label: 'Silence Trimmed', icon: 'scissors' });
    (window as any).IKState = {
      getVideoClips: () => [],
      getAudioClips: () => [],
    };
    window.lucide = { createIcons: vi.fn() };
    renderClips();
    expect(document.getElementById('lane-ai')!.innerHTML).toContain('Silence Trimmed');
  });
});

// ── updatePlayhead ─────────────────────────────────────────────────────────
describe('updatePlayhead', () => {
  let updatePlayhead: () => void;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/timeline');
    updatePlayhead = mod.updatePlayhead;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does nothing when dur <= 0', () => {
    mockS.dur = 0;
    expect(() => updatePlayhead()).not.toThrow();
    mockS.dur = 20;
  });

  it('sets ph-tracks left and timecode', () => {
    mockS.dur = 20;
    mockS.time = 10;
    updatePlayhead();
    const ph = document.getElementById('ph-tracks')!;
    expect(ph.style.left).not.toBe('');
    const tc = document.getElementById('timecode')!;
    expect(tc.textContent).not.toBe('');
    mockS.time = 0;
  });

  it('formats time with hours when > 3600s', () => {
    mockS.dur = 7200;
    mockS.time = 3700;
    updatePlayhead();
    const tc = document.getElementById('timecode')!;
    // Should contain at least 2 colons for HH:MM:SS:FF format
    expect((tc.textContent!.match(/:/g) || []).length).toBeGreaterThanOrEqual(2);
    mockS.dur = 20;
    mockS.time = 0;
  });
});

// ── applyAiAction ─────────────────────────────────────────────────────────
describe('applyAiAction', () => {
  let applyAiAction: (type: 'silence' | 'captions' | 'sync') => void;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/timeline');
    applyAiAction = mod.applyAiAction;
    mockS.dur = 10;
    mockAiNodes.splice(0, mockAiNodes.length);
    delete (window as any).IKState;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete (window as any).IKState;
    mockAiNodes.splice(0, mockAiNodes.length);
  });

  it('shows toast when no video clips and action is silence', async () => {
    const { showToast } = await import('../../src/ui/utils');
    (window as any).IKState = { getVideoClips: () => [], getAudioClips: () => [] };
    window.lucide = { createIcons: vi.fn() };
    applyAiAction('silence');
    expect(showToast).toHaveBeenCalledWith('Import a video first', 'info');
  });

  it('trims single real clip on silence action', async () => {
    const trimClipMock = vi.fn();
    (window as any).IKState = {
      getVideoClips: () => [{
        id: 'v1', isReal: true,
        timeline_start_us: 0, timeline_end_us: 10_000_000, source_start_us: 0,
      }],
      getAudioClips: () => [],
      trimClip: trimClipMock,
      computeDuration: vi.fn(),
      isReady: () => true,
    };
    window.lucide = { createIcons: vi.fn() };
    applyAiAction('silence');
    expect(trimClipMock).toHaveBeenCalled();
  });

  it('moves clips to trim gaps when multiple clips exist', async () => {
    const moveClipMock = vi.fn();
    (window as any).IKState = {
      getVideoClips: () => [
        { id: 'v1', isReal: true, timeline_start_us: 0, timeline_end_us: 4_000_000, source_start_us: 0 },
        { id: 'v2', isReal: true, timeline_start_us: 8_000_000, timeline_end_us: 12_000_000, source_start_us: 0 },
      ],
      getAudioClips: () => [],
      moveClip: moveClipMock,
      computeDuration: vi.fn(),
      isReady: () => true,
    };
    window.lucide = { createIcons: vi.fn() };
    applyAiAction('silence');
    expect(moveClipMock).toHaveBeenCalled();
  });

  it('applies captions action', async () => {
    const { showToast } = await import('../../src/ui/utils');
    (window as any).IKState = {
      getVideoClips: () => [{ id: 'v1', isReal: true, timeline_start_us: 0, timeline_end_us: 4_000_000 }],
      getAudioClips: () => [],
      computeDuration: vi.fn(),
      isReady: () => true,
    };
    window.lucide = { createIcons: vi.fn() };
    applyAiAction('captions');
    expect(showToast).toHaveBeenCalledWith('AI Captions Added', 'captions');
  });

  it('shows toast when no video clips for captions', async () => {
    const { showToast } = await import('../../src/ui/utils');
    (window as any).IKState = { getVideoClips: () => [], getAudioClips: () => [] };
    window.lucide = { createIcons: vi.fn() };
    applyAiAction('captions');
    expect(showToast).toHaveBeenCalledWith('Import a video first', 'info');
  });

  it('applies sync action', async () => {
    const { showToast } = await import('../../src/ui/utils');
    (window as any).IKState = {
      getVideoClips: () => [{ id: 'v1', isReal: true, timeline_start_us: 0, timeline_end_us: 4_000_000 }],
      getAudioClips: () => [],
      computeDuration: vi.fn(),
      isReady: () => true,
    };
    window.lucide = { createIcons: vi.fn() };
    applyAiAction('sync');
    expect(showToast).toHaveBeenCalledWith('Rhythm Sync Complete', 'zap');
  });

  it('shows already applied toast on repeated action', async () => {
    const { showToast } = await import('../../src/ui/utils');
    (window as any).IKState = {
      getVideoClips: () => [{ id: 'v1', isReal: true, timeline_start_us: 0, timeline_end_us: 4_000_000 }],
      getAudioClips: () => [],
      computeDuration: vi.fn(),
      isReady: () => true,
    };
    window.lucide = { createIcons: vi.fn() };
    applyAiAction('captions');
    (showToast as any).mockClear();
    applyAiAction('captions');
    expect(showToast).toHaveBeenCalledWith('Action already applied!', 'check');
  });
});
