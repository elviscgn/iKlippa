// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showSnapGuide, hideSnapGuide } from '../../src/ui/timelineUtils';

describe('showSnapGuide', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="snap-guide" style="left: 100px;"></div>';
    // Stub the global S object
    vi.stubGlobal('S', { dur: 10, zoom: 1 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('positions the snap guide based on time and timeline width', () => {
    const snapGuide = document.getElementById('snap-guide') as HTMLElement;
    expect(snapGuide).not.toBeNull();

    showSnapGuide(5000000, 1000); // 5 seconds, 1000px total width

    expect(snapGuide.classList.contains('active')).toBe(true);
    // 5s / 10s * 1000px = 500px, then + 100px base = 600px
    expect(snapGuide.style.left).toBe('600px');
  });

  it('does nothing if snap-guide element is missing', () => {
    document.body.innerHTML = '';
    expect(() => showSnapGuide(0, 1000)).not.toThrow();
  });
});

describe('hideSnapGuide', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="snap-guide" class="active" style="left: 100px;"></div>';
  });

  it('removes the active class from snap-guide', () => {
    const snapGuide = document.getElementById('snap-guide') as HTMLElement;
    expect(snapGuide.classList.contains('active')).toBe(true);

    hideSnapGuide();

    expect(snapGuide.classList.contains('active')).toBe(false);
  });

  it('does nothing if snap-guide is missing', () => {
    document.body.innerHTML = '';
    expect(() => hideSnapGuide()).not.toThrow();
  });
});
