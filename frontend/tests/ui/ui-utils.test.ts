// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { picUrl, showToast, resizeCanvas } from '../../src/ui/utils';

describe('picUrl', () => {
  it('generates a picsum URL with given id and dimensions', () => {
    expect(picUrl(42, 200, 100)).toBe('https://picsum.photos/id/42/200/100');
  });

  it('works with string id', () => {
    expect(picUrl('10', 400, 300)).toBe('https://picsum.photos/id/10/400/300');
  });
});

describe('showToast', () => {
  let toastBox: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="toast-box"></div>';
    toastBox = document.getElementById('toast-box')!;
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does nothing if toast-box is missing', () => {
    document.body.innerHTML = '';
    showToast('test', 'check');
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('creates a toast element with the given message and icon', () => {
    showToast('File imported', 'upload');

    const toast = document.querySelector('.toast');
    expect(toast).not.toBeNull();
    expect(toast!.innerHTML).toContain('File imported');
    expect(toast!.innerHTML).toContain('data-lucide="upload"');

    // lucide.createIcons should be called with the toast node
    expect(window.lucide.createIcons).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: [toast] }),
    );
  });

  it('removes toast after 3000ms + 300ms transition', () => {
    showToast('Hello', 'info');

    expect(document.querySelectorAll('.toast').length).toBe(1);

    // Advance past the 3000ms trigger
    vi.advanceTimersByTime(3000);
    const toast = document.querySelector('.toast');
    expect(toast!.classList.contains('hide')).toBe(true);

    // Advance past the 300ms removal
    vi.advanceTimersByTime(300);
    expect(document.querySelectorAll('.toast').length).toBe(0);
  });
});

describe('resizeCanvas', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="canvas-wrapper" style="width: 800px; height: 450px;">
        <canvas id="canvas-frame"></canvas>
      </div>
    `;

    // Stub the global S object
    vi.stubGlobal('S', { selectedAR: '16/9' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing if wrapper or frame is missing', () => {
    document.body.innerHTML = '';
    const frame = document.createElement('canvas');
    frame.id = 'canvas-frame';
    document.body.appendChild(frame);

    // No wrapper -> should return early
    expect(() => resizeCanvas()).not.toThrow();
  });

  it('sets frame height to 100% when wrapper is wider than target ratio (16:9)', () => {
    const frame = document.getElementById('canvas-frame') as HTMLElement;
    resizeCanvas();

    // 800 / 450 = 1.78, 16/9 = 1.78 => they're equal, so width = 100%, height = auto
    expect(frame.style.width).toBe('100%');
    expect(frame.style.height).toBe('auto');
  });

  it('adjusts for 4:3 aspect ratio', () => {
    vi.stubGlobal('S', { selectedAR: '4/3' });
    const frame = document.getElementById('canvas-frame') as HTMLElement;
    resizeCanvas();

    // 800 / 450 = 1.78 > 4/3 = 1.33 => wrapper is wider => height = 100%, width = auto
    expect(frame.style.height).toBe('100%');
    expect(frame.style.width).toBe('auto');
  });

  it('adjusts for 21:9 ultrawide aspect ratio', () => {
    vi.stubGlobal('S', { selectedAR: '21/9' });
    const frame = document.getElementById('canvas-frame') as HTMLElement;
    resizeCanvas();

    // 800 / 450 = 1.78 < 21/9 = 2.33 => wrapper is narrower => width = 100%, height = auto
    expect(frame.style.width).toBe('100%');
    expect(frame.style.height).toBe('auto');
  });
});
