// @vitest-environment jsdom
/**
 * Tests for src/ui/mediaPool.ts:
 *   - renderMedia (footage, audio, stock/video, stock/music, delete button, click selection)
 *   - initMediaPoolTabs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// State mock is hoisted — define mediaPool data here
const mockMediaPool = {
  footage: [
    { id: 'f1', name: 'clip.mp4', isReal: true, dur: 5.0, thumbDataUrl: 'data:image/jpeg;base64,abc' },
    { id: 'f2', name: 'plain.mp4', isReal: true, dur: 3.0, thumbDataUrl: null },
  ],
  audio: [
    { id: 'a1', name: 'track.mp3', dur: '2:10' },
  ],
  stock: {
    video: [{ id: 'sv1', name: 'Neon.mp4', picId: 83 }],
    image: [{ id: 'si1', name: 'Texture.jpg', picId: 122 }],
    music: [{ id: 'sm1', name: 'Epic.mp3', dur: '2:10' }],
  },
};

vi.mock('../../src/ui/state', () => ({
  S: { time: 0, dur: 10, zoom: 1, tool: 'select', selectedAR: '16/9', playing: false, rafId: null, lastTs: null, timelineHeight: 360 },
  $: (s: string) => document.querySelector(s) as HTMLElement | null,
  $$: (s: string) => document.querySelectorAll(s),
  us2s: (us: number) => us / 1_000_000,
  mediaPool: mockMediaPool,
  aiNodes: [],
}));

vi.mock('../../src/ui/utils', () => ({
  picUrl: (id: any, w: number, h: number) => `https://picsum.photos/id/${id}/${w}/${h}`,
  showToast: vi.fn(),
  resizeCanvas: vi.fn(),
}));

const FIXTURE = `
  <div id="media-grid" style="display:grid;"></div>
  <div id="media-list" style="display:none;"></div>
  <div id="stock-subtabs" style="display:none;"></div>
  <div id="toast-box"></div>
  <button class="media-tab active" data-tab="footage">Footage</button>
  <button class="media-tab" data-tab="audio">Audio</button>
  <button class="media-tab" data-tab="stock">Stock</button>
  <button class="stock-subtab active" data-sub="video">Video</button>
  <button class="stock-subtab" data-sub="image">Image</button>
  <button class="stock-subtab" data-sub="music">Music</button>
`;

describe('renderMedia – footage', () => {
  let renderMedia: (...args: any[]) => Promise<void>;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    // Reset mediaPool.footage to full data before each test
    mockMediaPool.footage = [
      { id: 'f1', name: 'clip.mp4', isReal: true, dur: 5.0, thumbDataUrl: 'data:image/jpeg;base64,abc' },
      { id: 'f2', name: 'plain.mp4', isReal: true, dur: 3.0, thumbDataUrl: null },
    ];
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/mediaPool');
    renderMedia = mod.renderMedia;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('renders footage items with thumbnail', async () => {
    await renderMedia('footage');
    const items = document.querySelectorAll('.media-item');
    expect(items.length).toBeGreaterThan(0);
    const hasImg = Array.from(items).some(el => el.querySelector('img'));
    expect(hasImg).toBe(true);
  });

  it('renders footage item without thumbnail (film icon fallback)', async () => {
    await renderMedia('footage');
    const items = document.querySelectorAll('.media-item');
    // Second item has no thumbDataUrl → should contain data-lucide="film"
    const hasFilmIcon = Array.from(items).some(el => el.innerHTML.includes('data-lucide="film"'));
    expect(hasFilmIcon).toBe(true);
  });

  it('hides stock-subtabs when rendering footage', async () => {
    await renderMedia('footage');
    const subtabs = document.getElementById('stock-subtabs')!;
    expect(subtabs.style.display).toBe('none');
  });

  it('delete button removes item and re-renders', async () => {
    await renderMedia('footage');
    const delBtn = document.querySelector('.media-del-btn') as HTMLElement;
    expect(delBtn).not.toBeNull();
    expect(() => delBtn!.click()).not.toThrow();
  });

  it('clicking media item marks it selected', async () => {
    await renderMedia('footage');
    const item = document.querySelector('.media-item') as HTMLElement;
    expect(item).not.toBeNull();
    item.click();
    expect(item.classList.contains('selected')).toBe(true);
  });
});

describe('renderMedia – audio list', () => {
  let renderMedia: (...args: any[]) => Promise<void>;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    mockMediaPool.audio = [{ id: 'a1', name: 'track.mp3', dur: '2:10' }];
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/mediaPool');
    renderMedia = mod.renderMedia;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('renders audio items in list view', async () => {
    await renderMedia('audio');
    const list = document.getElementById('media-list')!;
    expect(list.style.display).toBe('flex');
    expect(list.querySelectorAll('.audio-item').length).toBe(1);
  });
});

describe('renderMedia – stock', () => {
  let renderMedia: (...args: any[]) => Promise<void>;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    mockMediaPool.stock.video = [{ id: 'sv1', name: 'Neon.mp4', picId: 83 }];
    mockMediaPool.stock.image = [{ id: 'si1', name: 'Texture.jpg', picId: 122 }];
    mockMediaPool.stock.music = [{ id: 'sm1', name: 'Epic.mp3', dur: '2:10' }];
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/mediaPool');
    renderMedia = mod.renderMedia;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('shows subtabs when rendering stock', async () => {
    await renderMedia('stock', 'video');
    const subtabs = document.getElementById('stock-subtabs')!;
    expect(subtabs.style.display).toBe('flex');
  });

  it('renders stock video items with picsum URLs', async () => {
    await renderMedia('stock', 'video');
    const items = document.querySelectorAll('.media-item');
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it('renders stock music items in list view', async () => {
    await renderMedia('stock', 'music');
    const list = document.getElementById('media-list')!;
    expect(list.style.display).toBe('flex');
  });

  it('renders stock image items', async () => {
    await renderMedia('stock', 'image');
    const items = document.querySelectorAll('.media-item');
    expect(items.length).toBeGreaterThanOrEqual(1);
  });
});

describe('renderMedia – empty footage shows hint', () => {
  let renderMedia: (...args: any[]) => Promise<void>;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    mockMediaPool.footage = []; // empty
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/mediaPool');
    renderMedia = mod.renderMedia;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    // Restore footage
    mockMediaPool.footage = [
      { id: 'f1', name: 'clip.mp4', isReal: true, dur: 5.0, thumbDataUrl: 'data:image/jpeg;base64,abc' },
      { id: 'f2', name: 'plain.mp4', isReal: true, dur: 3.0, thumbDataUrl: null },
    ];
  });

  it('shows empty hint when footage is empty', async () => {
    await renderMedia('footage');
    const grid = document.getElementById('media-grid')!;
    expect(grid.innerHTML).toContain('Drop a video file');
  });
});

describe('initMediaPoolTabs', () => {
  let initMediaPoolTabs: () => void;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    mockMediaPool.footage = [
      { id: 'f1', name: 'clip.mp4', isReal: true, dur: 5.0, thumbDataUrl: 'data:image/jpeg;base64,abc' },
    ];
    mockMediaPool.stock.video = [{ id: 'sv1', name: 'Neon.mp4', picId: 83 }];
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/mediaPool');
    initMediaPoolTabs = mod.initMediaPoolTabs;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('clicking a media tab activates it', () => {
    initMediaPoolTabs();
    const audioTab = document.querySelector('.media-tab[data-tab="audio"]') as HTMLElement;
    audioTab.click();
    expect(audioTab.classList.contains('active')).toBe(true);
    const footageTab = document.querySelector('.media-tab[data-tab="footage"]') as HTMLElement;
    expect(footageTab.classList.contains('active')).toBe(false);
  });

  it('clicking stock tab renders stock/video and activates first subtab', () => {
    initMediaPoolTabs();
    const stockTab = document.querySelector('.media-tab[data-tab="stock"]') as HTMLElement;
    stockTab.click();
    const firstSub = document.querySelector('.stock-subtab') as HTMLElement;
    expect(firstSub.classList.contains('active')).toBe(true);
  });

  it('clicking stock-subtab activates it', () => {
    initMediaPoolTabs();
    const musicSub = document.querySelector('.stock-subtab[data-sub="music"]') as HTMLElement;
    musicSub.click();
    expect(musicSub.classList.contains('active')).toBe(true);
    const videoSub = document.querySelector('.stock-subtab[data-sub="video"]') as HTMLElement;
    expect(videoSub.classList.contains('active')).toBe(false);
  });
});

describe('renderMedia – dragstart handlers', () => {
  let renderMedia: (...args: any[]) => Promise<void>;

  beforeEach(async () => {
    document.body.innerHTML = FIXTURE;
    mockMediaPool.footage = [
      { id: 'f1', name: 'clip.mp4', isReal: true, dur: 5.0, thumbDataUrl: 'data:image/jpeg;base64,abc' },
    ];
    mockMediaPool.stock.video = [{ id: 'sv1', name: 'Neon.mp4', picId: 83 }];
    vi.stubGlobal('lucide', { createIcons: vi.fn() });
    const mod = await import('../../src/ui/mediaPool');
    renderMedia = mod.renderMedia;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('real footage item sets drag data with sourceId', async () => {
    await renderMedia('footage');
    const item = document.querySelector('.media-item') as HTMLElement;
    expect(item).not.toBeNull();
    const mockDataTransfer = { setData: vi.fn() };
    const fakeEvent = { dataTransfer: mockDataTransfer } as any;
    item.ondragstart!(fakeEvent);
    expect(mockDataTransfer.setData).toHaveBeenCalledWith(
      'text/plain',
      expect.stringContaining('sourceId')
    );
  });

  it('stock item sets drag data with picId', async () => {
    await renderMedia('stock', 'video');
    const item = document.querySelector('.media-item') as HTMLElement;
    expect(item).not.toBeNull();
    const mockDataTransfer = { setData: vi.fn() };
    const fakeEvent = { dataTransfer: mockDataTransfer } as any;
    item.ondragstart!(fakeEvent);
    expect(mockDataTransfer.setData).toHaveBeenCalledWith(
      'text/plain',
      expect.stringContaining('picId')
    );
  });
});
