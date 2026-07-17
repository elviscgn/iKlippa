import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadScript } from '../../src/utils/dom';

describe('loadScript (Tier 2)', () => {
  let headAppendChild: ReturnType<typeof vi.fn>;
  let createElement: ReturnType<typeof vi.fn>;
  let querySelector: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    headAppendChild = vi.fn();
    createElement = vi.fn();
    querySelector = vi.fn().mockReturnValue(null);

    vi.stubGlobal('document', {
      createElement,
      head: { appendChild: headAppendChild },
      querySelector,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves immediately if script already exists', async () => {
    querySelector.mockReturnValue({});
    await expect(loadScript('https://example.com/lib.js')).resolves.toBeUndefined();
    expect(createElement).not.toHaveBeenCalled();
  });

  it('creates and appends a script element when not present', async () => {
    const el: Record<string, any> = {};
    createElement.mockReturnValue(el);
    const promise = loadScript('https://example.com/lib.js');
    el.onload();
    await expect(promise).resolves.toBeUndefined();
    expect(headAppendChild).toHaveBeenCalled();
  });

  it('rejects on script error', async () => {
    const el: Record<string, any> = {};
    createElement.mockReturnValue(el);
    const promise = loadScript('https://example.com/broken.js');
    el.onerror();
    await expect(promise).rejects.toThrow('Failed to load script');
  });
});
