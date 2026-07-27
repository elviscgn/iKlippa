import { describe, expect, it } from 'vitest';
import { calculateCutScore } from '../../src/ai/cutScore';

describe('timeline cut score', () => {
  it('rewards continuous, consistently paced cuts aligned to beats', () => {
    const clips = [
      { timeline_start_us: 0, timeline_end_us: 2_000_000 },
      { timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 },
      { timeline_start_us: 4_000_000, timeline_end_us: 6_000_000 },
    ];

    const metrics = calculateCutScore(clips, [2, 4]);

    expect(metrics.score).toBeGreaterThanOrEqual(90);
    expect(metrics.gapSec).toBe(0);
    expect(metrics.averageClipSec).toBe(2);
    expect(metrics.beatAlignmentMs).toBe(0);
  });

  it('penalizes gaps, overlaps, extreme clip lengths, and missed beats', () => {
    const rough = calculateCutScore([
      { timeline_start_us: 500_000, timeline_end_us: 800_000 },
      { timeline_start_us: 700_000, timeline_end_us: 10_000_000 },
      { timeline_start_us: 12_000_000, timeline_end_us: 14_000_000 },
    ], [1.5, 6, 11]);
    const clean = calculateCutScore([
      { timeline_start_us: 0, timeline_end_us: 2_000_000 },
      { timeline_start_us: 2_000_000, timeline_end_us: 4_000_000 },
      { timeline_start_us: 4_000_000, timeline_end_us: 6_000_000 },
    ], [2, 4]);

    expect(rough.score).toBeLessThan(clean.score);
    expect(rough.gapSec).toBe(2.5);
    expect(rough.overlapCount).toBe(1);
    expect(rough.shortClipCount).toBe(1);
    expect(rough.longClipCount).toBe(1);
    expect(rough.summary).toContain('timeline gaps');
  });

  it('reports an empty edit without inventing a score', () => {
    expect(calculateCutScore([])).toMatchObject({
      score: 0,
      clipCount: 0,
      summary: 'Add footage to calculate pacing.',
    });
  });
});

