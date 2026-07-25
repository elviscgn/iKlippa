import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadStockFile,
  searchStockMusic,
  searchStockVideos,
} from '../../src/api/stock';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('stock API client', () => {
  it('searches Pexels through the same-origin API proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      items: [{ id: '1', name: 'Night City', video_url: 'https://video.test/1.mp4' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchStockVideos('night city');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/stock/videos?q=night%20city',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(results[0]).toMatchObject({ id: '1', name: 'Night City' });
  });

  it('surfaces a provider configuration error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      detail: 'JAMENDO_CLIENT_ID was rejected by Jamendo.',
    }, 503)));

    await expect(searchStockMusic('chill')).rejects.toThrow(
      'JAMENDO_CLIENT_ID was rejected by Jamendo.',
    );
  });

  it('turns a downloaded provider response into a browser File', async () => {
    const blob = new Blob(['video'], { type: 'video/mp4' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: vi.fn().mockResolvedValue(blob),
    }));

    const file = await downloadStockFile(
      'https://video.test/1.mp4',
      'stock.mp4',
      'video/mp4',
    );

    expect(file.name).toBe('stock.mp4');
    expect(file.type).toBe('video/mp4');
    expect(file.size).toBe(blob.size);
  });
});
