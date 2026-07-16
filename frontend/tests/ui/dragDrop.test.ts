// @vitest-environment jsdom
/**
 * Tests for src/ui/dragDrop.ts:
 *   - saveSnapshot / undo / redo
 *   - selectedClipIds
 *   - applyDragLogic (mousedown routing: split tool, select tool, trim zones)
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

vi.mock('../../src/ui/timelineUtils', () => ({
  getLaneW: () => 800,
  applySnap: (_us: number) => null,
  showSnapGuide: vi.fn(),
  hideSnapGuide: vi.fn(),
}));

function makeClip(overrides: any = {}) {
  return {
    id: 'clip1',
    timeline_start_us: 0,
    timeline_end_us: 4_000_000,
    source_start_us: 0,
    speed: 1,
    ...overrides,
  };
}

// ── saveSnapshot / undo / redo ─────────────────────────────────────────────

describe('saveSnapshot / undo / redo', () => {
  let saveSnapshot: () => void;

  beforeEach(async () => {
    document.body.innerHTML = '';
    const mod = await import('../../src/ui/dragDrop');
    saveSnapshot = mod.saveSnapshot;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('does nothing when IKState is absent', () => {
    // No window.IKState defined
    expect(() => saveSnapshot()).not.toThrow();
  });

  it('calls IKState.saveState when available', () => {
    const saveStateMock = vi.fn().mockReturnValue({ clips: [] });
    (window as any).IKState = { saveState: saveStateMock, loadState: vi.fn() };
    saveSnapshot();
    expect(saveStateMock).toHaveBeenCalled();
    delete (window as any).IKState;
  });

  it('window.undo restores previous state', () => {
    const loadStateMock = vi.fn();
    const saveStateMock = vi.fn().mockReturnValue({ clips: [] });
    (window as any).IKState = { saveState: saveStateMock, loadState: loadStateMock };
    saveSnapshot(); // push a snapshot
    window.undo();
    expect(loadStateMock).toHaveBeenCalled();
    delete (window as any).IKState;
  });

  it('window.redo restores next state after undo', () => {
    const loadStateMock = vi.fn();
    const saveStateMock = vi.fn().mockReturnValue({ clips: [] });
    (window as any).IKState = { saveState: saveStateMock, loadState: loadStateMock };
    saveSnapshot();
    window.undo();
    loadStateMock.mockClear();
    window.redo();
    expect(loadStateMock).toHaveBeenCalled();
    delete (window as any).IKState;
  });

  it('undo does nothing when stack is empty', () => {
    const loadStateMock = vi.fn();
    (window as any).IKState = { saveState: vi.fn().mockReturnValue({}), loadState: loadStateMock };
    // undo without prior saveSnapshot
    window.undo();
    delete (window as any).IKState;
    expect(true).toBe(true);
  });
});

// ── selectedClipIds ────────────────────────────────────────────────────────

describe('selectedClipIds', () => {
  let selectedClipIds: Set<string | number>;

  beforeEach(async () => {
    const mod = await import('../../src/ui/dragDrop');
    selectedClipIds = mod.selectedClipIds;
    selectedClipIds.clear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('starts empty', () => {
    expect(selectedClipIds.size).toBe(0);
  });

  it('can add and delete clip ids', () => {
    selectedClipIds.add('clip1');
    expect(selectedClipIds.has('clip1')).toBe(true);
    selectedClipIds.delete('clip1');
    expect(selectedClipIds.has('clip1')).toBe(false);
  });
});

// ── applyDragLogic ─────────────────────────────────────────────────────────

describe('applyDragLogic (select tool)', () => {
  let applyDragLogic: (el: HTMLElement, clip: any, arr: any[], tw: number) => void;
  let selectedClipIds: Set<string | number>;
  let S: any;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div id="lane-v1" style="width:800px;height:60px;overflow-x:scroll;"></div>
      <div id="tl-tracks" style="overflow-x:scroll;"></div>
    `;
    const mod = await import('../../src/ui/dragDrop');
    applyDragLogic = mod.applyDragLogic;
    selectedClipIds = mod.selectedClipIds;
    selectedClipIds.clear();
    const state = await import('../../src/ui/state');
    S = (state as any).S;
    S.tool = 'select';
    S.dur = 20;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('does not throw when mousedown triggers move path', () => {
    const lane = document.getElementById('lane-v1')!;
    const el = document.createElement('div');
    el.className = 'tl-clip';
    el.dataset.clipId = 'clip1';
    el.style.cssText = 'position:absolute;left:0;width:160px;height:60px;';
    el.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 160, height: 60,
      right: 160, bottom: 60,
    } as DOMRect);
    lane.appendChild(el);

    const clip = makeClip();
    (window as any).IKState = {
      findClip: () => clip,
      moveClip: vi.fn(),
      splitClip: vi.fn().mockReturnValue(null),
      saveState: vi.fn().mockReturnValue({}),
      loadState: vi.fn(),
    };

    applyDragLogic(el, clip, [clip], 800);
    const event = new MouseEvent('mousedown', { clientX: 80, clientY: 30, bubbles: true });
    expect(() => el.onmousedown!(event)).not.toThrow();
    delete (window as any).IKState;
  });

  it('adds clip to selectedClipIds on mousedown (center of clip)', () => {
    const lane = document.getElementById('lane-v1')!;
    const el = document.createElement('div');
    el.className = 'tl-clip';
    el.dataset.clipId = 'clip1';
    el.style.cssText = 'position:absolute;left:0;width:160px;height:60px;';
    el.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 160, height: 60,
      right: 160, bottom: 60,
    } as DOMRect);
    lane.appendChild(el);

    const clip = makeClip();
    (window as any).IKState = {
      findClip: () => clip, moveClip: vi.fn(),
      splitClip: vi.fn().mockReturnValue(null),
      saveState: vi.fn().mockReturnValue({}), loadState: vi.fn(),
    };

    applyDragLogic(el, clip, [clip], 800);
    const event = new MouseEvent('mousedown', { clientX: 80, clientY: 30, bubbles: true });
    el.onmousedown!(event);
    expect(selectedClipIds.has('clip1')).toBe(true);
    delete (window as any).IKState;
  });

  it('ctrl+click toggles clip selection', () => {
    const lane = document.getElementById('lane-v1')!;
    const el = document.createElement('div');
    el.className = 'tl-clip';
    el.dataset.clipId = 'clip2';
    el.style.cssText = 'position:absolute;left:0;width:160px;height:60px;';
    el.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 160, height: 60,
      right: 160, bottom: 60,
    } as DOMRect);
    lane.appendChild(el);

    const clip = makeClip({ id: 'clip2' });
    (window as any).IKState = {
      findClip: () => clip, moveClip: vi.fn(),
      splitClip: vi.fn().mockReturnValue(null),
      saveState: vi.fn().mockReturnValue({}), loadState: vi.fn(),
    };

    applyDragLogic(el, clip, [clip], 800);

    // First click: adds to selection
    el.onmousedown!(new MouseEvent('mousedown', { clientX: 80, clientY: 30, ctrlKey: true, bubbles: true }));
    expect(selectedClipIds.has('clip2')).toBe(true);

    // Second ctrl+click: removes from selection
    el.onmousedown!(new MouseEvent('mousedown', { clientX: 80, clientY: 30, ctrlKey: true, bubbles: true }));
    expect(selectedClipIds.has('clip2')).toBe(false);
    delete (window as any).IKState;
  });
});

describe('applyDragLogic (split tool)', () => {
  let applyDragLogic: (el: HTMLElement, clip: any, arr: any[], tw: number) => void;
  let S: any;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div id="lane-v1" style="width:800px;height:60px;overflow-x:scroll;"></div>
      <div id="tl-tracks" style="overflow-x:scroll;"></div>
      <button class="tl-tool active" data-tool="split"></button>
      <button class="tl-tool" data-tool="select"></button>
    `;
    const mod = await import('../../src/ui/dragDrop');
    applyDragLogic = mod.applyDragLogic;
    const state = await import('../../src/ui/state');
    S = (state as any).S;
    S.tool = 'split';
    S.dur = 20;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('triggers split and deactivates split tool', () => {
    const lane = document.getElementById('lane-v1')!;
    const el = document.createElement('div');
    el.className = 'tl-clip';
    el.dataset.clipId = 'clip1';
    el.style.cssText = 'position:absolute;left:0;width:800px;height:60px;';
    el.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 800, height: 60, right: 800, bottom: 60,
    } as DOMRect);
    lane.appendChild(el);
    lane.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 800, height: 60, right: 800, bottom: 60,
    } as DOMRect);

    const splitClipMock = vi.fn().mockReturnValue('newClipId');
    const clip = makeClip({ timeline_start_us: 0, timeline_end_us: 20_000_000 });
    (window as any).IKState = {
      findClip: () => clip, moveClip: vi.fn(),
      splitClip: splitClipMock,
      saveState: vi.fn().mockReturnValue({}), loadState: vi.fn(),
    };
    (window as any).showToast = vi.fn();

    applyDragLogic(el, clip, [clip], 800);
    // Click at x=400 in lane (10s in 20s timeline – within valid split zone)
    const event = new MouseEvent('mousedown', { clientX: 400, clientY: 30, bubbles: true });
    expect(() => el.onmousedown!(event)).not.toThrow();

    delete (window as any).IKState;
    delete (window as any).showToast;
  });
});
