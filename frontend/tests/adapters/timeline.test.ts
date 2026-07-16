import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IKState } from '../../src/state/state';
import { S } from '../../src/ui/state';
import { setPorts, resetPorts } from '../../src/adapters';
import { fakeEnginePorts, resetLeakRegistry, expectNoLeaks } from '../fakes';

beforeEach(() => {
  resetLeakRegistry();
  setPorts(fakeEnginePorts);
  S.dur = 10;
  S.time = 0;
  S.zoom = 1;
});

afterEach(() => {
  expectNoLeaks();
  resetPorts();
  vi.unstubAllGlobals();
});

describe('saveSnapshot / undo / redo', () => {
  let _saveSnapshot: Function;
  let _undo: Function;
  let _redo: Function;

  beforeEach(async () => {
    vi.stubGlobal('window', {
      IKState,
      dispatchEvent: vi.fn(),
      lucide: { createIcons: vi.fn() },
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn().mockReturnValue(null),
      querySelectorAll: vi.fn().mockReturnValue([]),
      createElement: vi.fn().mockReturnValue({ style: {} }),
      addEventListener: vi.fn(),
      body: {
        contains: vi.fn().mockReturnValue(true),
        style: {},
        addEventListener: vi.fn(),
      },
      head: { appendChild: vi.fn() },
    });
    IKState.init(1920, 1080);

    if (!_saveSnapshot) {
      await import('../../src/ui/dragDrop');
      _saveSnapshot = (window as any).saveSnapshot;
      _undo = (window as any).undo;
      _redo = (window as any).redo;
    }
    (window as any).saveSnapshot = _saveSnapshot;
    (window as any).undo = _undo;
    (window as any).redo = _redo;
  });

  it('saves snapshot and undo restores previous state', () => {
    const clip = IKState.addVideoClip('test', 0, 5_000_000);
    (window as any).saveSnapshot();
    IKState.moveClip(clip!.id, 1_000_000);
    expect(IKState.findClip(clip!.id)!.timeline_start_us).toBe(1_000_000);
    (window as any).undo();
    const restored = IKState.findClip(clip!.id);
    expect(restored).not.toBeNull();
    expect(restored!.timeline_start_us).toBe(0);
  });

  it('redo restores state after undo', () => {
    const clip = IKState.addVideoClip('test', 0, 5_000_000);
    (window as any).saveSnapshot();
    IKState.moveClip(clip!.id, 1_000_000);
    (window as any).undo();
    (window as any).redo();
    expect(IKState.findClip(clip!.id)!.timeline_start_us).toBe(1_000_000);
  });

  it('dispatches reRender event on undo', () => {
    IKState.addVideoClip('test', 0, 5_000_000);
    (window as any).saveSnapshot();
    IKState.moveClip(1, 1_000_000);
    const dispatchEvent = vi.mocked(window.dispatchEvent);
    (window as any).undo();
    expect(dispatchEvent).toHaveBeenCalled();
  });
});

describe('applySnap / getLaneW', () => {
  let applySnap: Function;
  let getLaneW: Function;

  beforeEach(async () => {
    const fakeLane = {
      getBoundingClientRect: vi.fn().mockReturnValue({ width: 500 }),
    };
    vi.stubGlobal('window', {
      IKState,
      dispatchEvent: vi.fn(),
      lucide: { createIcons: vi.fn() },
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn().mockImplementation((sel: string) => {
        if (sel === '#lane-v1') return fakeLane;
        return null;
      }),
      querySelectorAll: vi.fn().mockReturnValue([]),
      createElement: vi.fn().mockReturnValue({ style: {} }),
      addEventListener: vi.fn(),
      body: {
        contains: vi.fn().mockReturnValue(true),
        style: {},
        addEventListener: vi.fn(),
      },
      head: { appendChild: vi.fn() },
    });
    IKState.init(1920, 1080);
    const mod = await import('../../src/ui/timelineUtils');
    applySnap = mod.applySnap;
    getLaneW = mod.getLaneW;
  });

  it('getLaneW returns lane width multiplied by zoom', () => {
    expect(getLaneW()).toBe(500);
  });

  it('applySnap snaps to 0 for values within threshold when no clips exist', () => {
    const tw = 500;
    expect(applySnap(300_000, null, tw)).toBe(0);
  });

  it('applySnap returns null when value is beyond threshold from any snap point', () => {
    const tw = 500;
    expect(applySnap(400_000, null, tw)).toBeNull();
  });

  it('applySnap snaps to clip start and end edges', () => {
    IKState.addVideoClip('test', 5_000_000, 10_000_000);
    const tw = 500;
    expect(applySnap(5_010_000, null, tw)).toBe(5_000_000);
    expect(applySnap(9_990_000, null, tw)).toBe(10_000_000);
  });

  it('applySnap returns null when value is far from all snap points', () => {
    IKState.addVideoClip('test', 5_000_000, 10_000_000);
    const tw = 500;
    expect(applySnap(5_350_000, null, tw)).toBeNull();
  });

  it('applySnap excludes clip edges when excludeClipId matches', () => {
    const clip = IKState.addVideoClip('test', 5_000_000, 10_000_000);
    IKState.addVideoClip('other', 12_000_000, 15_000_000);
    const tw = 500;
    expect(applySnap(5_010_000, clip!.id, tw)).toBeNull();
    expect(applySnap(12_010_000, clip!.id, tw)).toBe(12_000_000);
  });
});

describe('calculateTimelineDuration', () => {
  let calculateTimelineDuration: Function;

  beforeEach(async () => {
    vi.stubGlobal('window', {
      IKState,
      dispatchEvent: vi.fn(),
      lucide: { createIcons: vi.fn() },
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      querySelector: vi.fn().mockReturnValue(null),
      querySelectorAll: vi.fn().mockReturnValue([]),
      createElement: vi.fn().mockReturnValue({ style: {} }),
      addEventListener: vi.fn(),
      body: {
        contains: vi.fn().mockReturnValue(true),
        style: {},
        addEventListener: vi.fn(),
      },
      head: { appendChild: vi.fn() },
    });
    IKState.init(1920, 1080);
    const mod = await import('../../src/ui/timeline');
    calculateTimelineDuration = mod.calculateTimelineDuration;
  });

  it('returns minimum buffer of 10 when no clips exist', () => {
    expect(calculateTimelineDuration()).toBe(10);
  });

  it('returns max clip end time + 10 buffer', () => {
    IKState.addVideoClip('test', 0, 5_000_000);
    expect(calculateTimelineDuration()).toBe(15);
  });

  it('includes audio clips in duration calculation', () => {
    IKState.addVideoClip('v', 0, 3_000_000);
    IKState.addAudioClip('a', 0, 8_000_000);
    expect(calculateTimelineDuration()).toBe(18);
  });

  it('uses the maximum end time across multiple clips', () => {
    IKState.addVideoClip('a', 0, 5_000_000);
    IKState.addVideoClip('b', 10_000_000, 20_000_000);
    expect(calculateTimelineDuration()).toBe(30);
  });
});
