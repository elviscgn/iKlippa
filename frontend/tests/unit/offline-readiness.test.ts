// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const offlineMocks = vi.hoisted(() => ({
  warmGraniteModel: vi.fn(),
  listStoredSourceIds: vi.fn(),
  requestDurableStorage: vi.fn(),
  waitForSourcePersistence: vi.fn(),
  registerAppShell: vi.fn(),
  isAppShellCached: vi.fn(),
}));

vi.mock('../../src/ai/granite', () => ({
  warmGraniteModel: offlineMocks.warmGraniteModel,
}));
vi.mock('../../src/media/mediaStore', () => ({
  listStoredSourceIds: offlineMocks.listStoredSourceIds,
  requestDurableStorage: offlineMocks.requestDurableStorage,
}));
vi.mock('../../src/media/sourceRegistry', () => ({
  waitForSourcePersistence: offlineMocks.waitForSourcePersistence,
}));
vi.mock('../../src/offline/appShell', () => ({
  registerAppShell: offlineMocks.registerAppShell,
  isAppShellCached: offlineMocks.isAppShellCached,
}));

import { verifyOfflineReadiness } from '../../src/offline/readiness';

describe('offline readiness', () => {
  beforeEach(() => {
    offlineMocks.warmGraniteModel.mockResolvedValue(undefined);
    offlineMocks.listStoredSourceIds.mockResolvedValue(['interview.mp4', 'music.mp3']);
    offlineMocks.requestDurableStorage.mockResolvedValue(true);
    offlineMocks.waitForSourcePersistence.mockResolvedValue(true);
    offlineMocks.registerAppShell.mockResolvedValue({});
    offlineMocks.isAppShellCached.mockResolvedValue(true);
    (window as any).IKState = {
      isReady: () => true,
      getTracks: () => [
        { track_type: 'video', clips: [{ source_id: 'interview.mp4' }] },
        { track_type: 'audio', clips: [{ source_id: 'music.mp3' }] },
        { track_type: 'caption', clips: [{ source_id: '' }] },
      ],
    };
  });

  it('only reports ready when Nano, shell, and every project source are cached', async () => {
    await expect(verifyOfflineReadiness()).resolves.toMatchObject({
      ready: true,
      graniteReady: true,
      mediaReady: true,
      appShellReady: true,
      missingMedia: [],
    });
  });

  it('identifies the exact uncached project sources', async () => {
    offlineMocks.listStoredSourceIds.mockResolvedValue(['interview.mp4']);

    const readiness = await verifyOfflineReadiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.missingMedia).toEqual(['music.mp3']);
    expect(readiness.detail).toContain('1 media source');
  });

  it('fails closed when the model cache cannot warm offline', async () => {
    offlineMocks.warmGraniteModel.mockRejectedValue(new Error('not cached'));

    const readiness = await verifyOfflineReadiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.graniteReady).toBe(false);
    expect(readiness.detail).toContain('Granite Nano');
  });
});

