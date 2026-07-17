// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { picUrl, showToast } from '../../src/ui/utils';

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

    expect(window.lucide.createIcons).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: [toast] }),
    );
  });

  it('removes toast after 3000ms + 300ms transition', () => {
    showToast('Hello', 'info');

    expect(document.querySelectorAll('.toast').length).toBe(1);

    vi.advanceTimersByTime(3000);
    const toast = document.querySelector('.toast');
    expect(toast!.classList.contains('hide')).toBe(true);

    vi.advanceTimersByTime(300);
    expect(document.querySelectorAll('.toast').length).toBe(0);
  });
});

describe('resizeCanvas', () => {
  let resizeCanvas: () => void;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div id="canvas-wrapper" style="width: 800px; height: 450px;">
        <canvas id="canvas-frame"></canvas>
      </div>
    `;

    // Mock the S module that resizeCanvas imports
    vi.mock('../../src/ui/state', () => ({
      S: { selectedAR: '16/9' },
      $: (s: string) => document.querySelector(s),
      $$: (s: string) => document.querySelectorAll(s),
      us2s: (us: number) => us / 1_000_000,
      mediaPool: { footage: [], audio: [], stock: { video: [], image: [], music: [] } },
      aiNodes: [],
    }));

    const mod = await import('../../src/ui/utils');
    resizeCanvas = mod.resizeCanvas;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does nothing if wrapper or frame is missing', () => {
    document.body.innerHTML = '';
    const frame = document.createElement('canvas');
    frame.id = 'canvas-frame';
    document.body.appendChild(frame);

    expect(() => resizeCanvas()).not.toThrow();
  });

  it('sets frame height to auto when wrapper ratio equals target ratio (16:9)', () => {
    const frame = document.getElementById('canvas-frame') as HTMLElement;
    resizeCanvas();

    // 800/450 = 1.78, 16/9 = 1.78 => wrapperRatio > targetRatio is false (1.78 > 1.78 = false)
    // so falls to else: width = 100%, height = auto
    expect(frame.style.width).toBe('100%');
    expect(frame.style.height).toBe('auto');
  });
});
