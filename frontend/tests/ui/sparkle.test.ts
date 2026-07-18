// @vitest-environment jsdom
/**
 * Tests for triggerSparkle (ui/utils.ts lines 32-60).
 * The function is only attached to window, so we call window.triggerSparkle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('triggerSparkle (window global)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();

    // Provide DOM elements needed by showToast (called inside triggerSparkle)
    document.body.innerHTML = '<div id="toast-box"></div>';

    // Mock lucide (showToast calls window.lucide.createIcons)
    vi.stubGlobal('lucide', { createIcons: vi.fn() });

    // Mock state dependency so the module loads without errors
    vi.mock('../../src/ui/state', () => ({
      S: { selectedAR: '16/9', dur: 10, zoom: 1, time: 0, tool: 'select', playing: false, rafId: null, lastTs: null, timelineHeight: 360 },
      $: (s: string) => document.querySelector(s) as HTMLElement | null,
      $$: (s: string) => document.querySelectorAll(s),
      us2s: (us: number) => us / 1_000_000,
      mediaPool: { footage: [], audio: [], stock: { video: [], image: [], music: [] } },
      aiNodes: [],
    }));

    // Import after mocks are set up
    await import('../../src/ui/utils');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('attaches triggerSparkle to window', () => {
    expect(typeof window.triggerSparkle).toBe('function');
  });

  it('appends 8 sparkle particles to document.body', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () =>
      ({ left: 100, top: 100, width: 40, height: 40 }) as DOMRect;
    document.body.appendChild(el);

    const before = document.body.querySelectorAll('div').length;
    window.triggerSparkle(el);
    const after = document.body.querySelectorAll('div').length;

    // 8 particle divs created (plus the toast-box div and el itself)
    expect(after - before).toBe(8 + 1 /* 1 toast element */);
  });

  it('calls showToast with Granite AI listening message', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 10, height: 10 }) as DOMRect;
    document.body.appendChild(el);

    window.triggerSparkle(el);

    const toasts = document.querySelectorAll('.toast');
    expect(toasts.length).toBeGreaterThanOrEqual(1);
    expect(toasts[0]!.innerHTML).toContain('Granite AI is listening');
  });

  it('removes particles after 800ms', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 10, height: 10 }) as DOMRect;
    document.body.appendChild(el);

    window.triggerSparkle(el);

    // After 800 ms the particle setTimeout fires and removes each particle
    vi.advanceTimersByTime(800);

    // None of the particle divs should still be in the body
    // (toast may still be present; sparkle SVG divs have no class)
    const remainingFixed = Array.from(document.body.children).filter(
      (c) => (c as HTMLElement).style.position === 'fixed'
    );
    expect(remainingFixed.length).toBe(0);
  });
});
