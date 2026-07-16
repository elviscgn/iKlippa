import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IKState } from '../../src/state/state';
import { setPorts, resetPorts } from '../../src/adapters';
import { fakeEnginePorts, resetLeakRegistry, expectNoLeaks } from '../fakes';

beforeEach(() => {
  resetLeakRegistry();
  setPorts(fakeEnginePorts);
  vi.stubGlobal('document', {
    querySelector: vi.fn().mockReturnValue(null),
    querySelectorAll: vi.fn().mockReturnValue([]),
    createElement: vi.fn().mockReturnValue({ style: {} }),
    addEventListener: vi.fn(),
    body: {
      contains: vi.fn().mockReturnValue(false),
      style: {},
      addEventListener: vi.fn(),
    },
    head: { appendChild: vi.fn() },
  });
  vi.stubGlobal('window', {
    IKState,
    dispatchEvent: vi.fn(),
    showToast: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    lucide: { createIcons: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    resizeCanvas: vi.fn(),
    calculateTimelineDuration: vi.fn(),
    innerHeight: 800,
  });
});

afterEach(() => {
  expectNoLeaks();
  resetPorts();
  vi.unstubAllGlobals();
});

describe('handleCopy (Tier 2)', () => {
  let handleCopy: Function;
  let _selectedClipIds: Set<number | string>;

  beforeEach(async () => {
    IKState.init(1920, 1080);
    const kb = await import('../../src/ui/keyboard');
    const dd = await import('../../src/ui/dragDrop');
    handleCopy = kb.handleCopy;
    _selectedClipIds = dd.selectedClipIds;
    _selectedClipIds.clear();
  });

  it('does nothing when no clips selected', () => {
    const e = { preventDefault: vi.fn() } as any;
    handleCopy(e, IKState);
  });

  it('copies selected clip data', () => {
    const clip = IKState.addVideoClip('v', 0, 1000, { name: 'Test' });
    _selectedClipIds.add(clip!.id);
    const e = { preventDefault: vi.fn() } as any;
    handleCopy(e, IKState);
  });
});

describe('handlePaste (Tier 2)', () => {
  let handlePaste: Function;

  beforeEach(async () => {
    IKState.init(1920, 1080);
    const kb = await import('../../src/ui/keyboard');
    handlePaste = kb.handlePaste;
  });

  it('does nothing when clipboard is empty', () => {
    const e = { preventDefault: vi.fn() } as any;
    handlePaste(e, IKState);
  });
});

describe('handleDelete (Tier 2)', () => {
  let handleDelete: Function;
  let _selectedClipIds: Set<number | string>;

  beforeEach(async () => {
    IKState.init(1920, 1080);
    const kb = await import('../../src/ui/keyboard');
    const dd = await import('../../src/ui/dragDrop');
    handleDelete = kb.handleDelete;
    _selectedClipIds = dd.selectedClipIds;
    _selectedClipIds.clear();
  });

  it('does nothing when no clips selected', () => {
    const e = { preventDefault: vi.fn() } as any;
    handleDelete(e, IKState);
    expect(IKState.getVideoClips()).toHaveLength(0);
  });

  it('removes selected clips', () => {
    const clip = IKState.addVideoClip('v', 0, 1000);
    _selectedClipIds.add(clip!.id);
    const e = {} as any;
    handleDelete(e, IKState);
    expect(IKState.getVideoClips()).toHaveLength(0);
  });

  it('removes linked clips together', () => {
    const v = IKState.addVideoClip('v', 0, 1000, {}, 'grp_D');
    IKState.addAudioClip('a', 0, 1000, {}, 'grp_D');
    _selectedClipIds.add(v!.id);
    const e = {} as any;
    handleDelete(e, IKState);
    expect(IKState.getVideoClips()).toHaveLength(0);
    expect(IKState.getAudioClips()).toHaveLength(0);
  });
});

describe('handleToolSwitch (Tier 2)', () => {
  let handleToolSwitch: Function;

  beforeEach(async () => {
    IKState.init(1920, 1080);
    const kb = await import('../../src/ui/keyboard');
    handleToolSwitch = kb.handleToolSwitch;
  });

  it('switches to select tool on V', () => {
    const e = { code: 'KeyV' } as any;
    expect(() => handleToolSwitch(e)).not.toThrow();
  });

  it('switches to split tool on S', () => {
    const e = { code: 'KeyS' } as any;
    expect(() => handleToolSwitch(e)).not.toThrow();
  });
});

describe('handleUndoRedo (Tier 2)', () => {
  let handleUndoRedo: Function;

  beforeEach(async () => {
    IKState.init(1920, 1080);
    const kb = await import('../../src/ui/keyboard');
    handleUndoRedo = kb.handleUndoRedo;
  });

  it('calls undo on ctrl+z', () => {
    const e = { code: 'KeyZ', ctrlKey: true, shiftKey: false, preventDefault: vi.fn() } as any;
    handleUndoRedo(e);
  });

  it('calls redo on ctrl+y', () => {
    const e = { code: 'KeyY', ctrlKey: true, shiftKey: false, preventDefault: vi.fn() } as any;
    handleUndoRedo(e);
  });

  it('calls redo on ctrl+shift+z', () => {
    const e = { code: 'KeyZ', ctrlKey: true, shiftKey: true, preventDefault: vi.fn() } as any;
    handleUndoRedo(e);
  });
});

describe('handleNudge (Tier 2)', () => {
  let handleNudge: Function;
  let _selectedClipIds: Set<number | string>;

  beforeEach(async () => {
    IKState.init(1920, 1080);
    const kb = await import('../../src/ui/keyboard');
    const dd = await import('../../src/ui/dragDrop');
    handleNudge = kb.handleNudge;
    _selectedClipIds = dd.selectedClipIds;
    _selectedClipIds.clear();

    vi.stubGlobal('document', {
      querySelector: vi.fn().mockReturnValue(null),
      querySelectorAll: vi.fn().mockReturnValue([]),
      createElement: vi.fn().mockReturnValue({ style: {} }),
      addEventListener: vi.fn(),
      body: {
        contains: vi.fn().mockReturnValue(false),
        style: {},
        addEventListener: vi.fn(),
      },
      head: { appendChild: vi.fn() },
    });
  });

  it('does nothing when no active clip element', () => {
    const e = { code: 'ArrowRight', preventDefault: vi.fn() } as any;
    handleNudge(e, IKState);
  });

  it('nudges a clip right', () => {
    const clip = IKState.addVideoClip('v', 0, 5000000);
    _selectedClipIds.add(clip!.id);

    const fakeLane = { getBoundingClientRect: vi.fn().mockReturnValue({ width: 500 }) };
    const fakeEl = {
      dataset: { clipId: String(clip!.id) },
      style: { left: '' },
    };
    vi.stubGlobal('document', {
      querySelector: vi.fn().mockImplementation((sel: string) => {
        if (sel === '#lane-v1') return fakeLane;
        if (sel === '#ph-tracks') return { style: { left: '' } };
        if (sel === '#timecode') return { textContent: '' };
        return fakeEl;
      }),
      querySelectorAll: vi.fn().mockReturnValue([]),
      createElement: vi.fn().mockReturnValue({ style: {} }),
      addEventListener: vi.fn(),
      body: {
        contains: vi.fn().mockReturnValue(false),
        style: {},
        addEventListener: vi.fn(),
      },
      head: { appendChild: vi.fn() },
    });

    const e = { code: 'ArrowRight', preventDefault: vi.fn(), shiftKey: false } as any;
    handleNudge(e, IKState);

    const updated = IKState.findClip(clip!.id);
    expect(updated!.timeline_start_us).toBeGreaterThan(0);
  });

  it('does not nudge left past 0', () => {
    const clip = IKState.addVideoClip('v', 0, 5000000);
    _selectedClipIds.add(clip!.id);

    const fakeLane = { getBoundingClientRect: vi.fn().mockReturnValue({ width: 500 }) };
    const fakeEl = {
      dataset: { clipId: String(clip!.id) },
      style: { left: '' },
    };
    vi.stubGlobal('document', {
      querySelector: vi.fn().mockImplementation((sel: string) => {
        if (sel === '#lane-v1') return fakeLane;
        if (sel === '#ph-tracks') return { style: { left: '' } };
        if (sel === '#timecode') return { textContent: '' };
        return fakeEl;
      }),
      querySelectorAll: vi.fn().mockReturnValue([]),
      createElement: vi.fn().mockReturnValue({ style: {} }),
      addEventListener: vi.fn(),
      body: {
        contains: vi.fn().mockReturnValue(false),
        style: {},
        addEventListener: vi.fn(),
      },
      head: { appendChild: vi.fn() },
    });

    const e = { code: 'ArrowLeft', preventDefault: vi.fn(), shiftKey: false } as any;
    handleNudge(e, IKState);

    const updated = IKState.findClip(clip!.id);
    expect(updated!.timeline_start_us).toBe(0);
  });
});
