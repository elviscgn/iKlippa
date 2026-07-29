import { describe, expect, it } from 'vitest';
import {
  buildThumbnailTimes,
  pickPosterThumbnail,
} from '../../src/media/videoThumbnails';

describe('video thumbnail sampling', () => {
  it('samples a short video across its full duration without using the edges', () => {
    const times = buildThumbnailTimes(36_000);

    expect(times).toHaveLength(12);
    expect(times[0]).toBeGreaterThan(0);
    expect(times.at(-1)).toBeLessThan(36_000);
    expect(new Set(times).size).toBe(times.length);
  });

  it('caps long videos at twenty samples', () => {
    const times = buildThumbnailTimes(10 * 60_000);

    expect(times).toHaveLength(20);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('returns no sample times for an invalid duration', () => {
    expect(buildThumbnailTimes(0)).toEqual([]);
    expect(buildThumbnailTimes(Number.NaN)).toEqual([]);
  });

  it('uses the thumbnail closest to the midpoint as the poster', () => {
    const thumbnails = [
      { ms: 1_000, dataUrl: 'first' },
      { ms: 17_000, dataUrl: 'middle' },
      { ms: 31_000, dataUrl: 'last' },
    ];

    expect(pickPosterThumbnail(thumbnails, 36_000)?.dataUrl).toBe('middle');
  });
});
