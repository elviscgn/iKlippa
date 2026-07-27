import { describe, expect, it } from 'vitest';
import { analyzePcm } from '../../src/ai/audioMath';

function syntheticTrack(): { samples: Float32Array; sampleRate: number } {
  const sampleRate = 8_000;
  const samples = new Float32Array(sampleRate * 4);
  for (let index = 0; index < samples.length; index++) {
    const time = index / sampleRate;
    if (time < 1 || time >= 2) {
      samples[index] = Math.sin(time * Math.PI * 2 * 110) * 0.07;
    }
  }

  for (const onsetSec of [0.5, 2.5, 3.2]) {
    const start = Math.round(onsetSec * sampleRate);
    for (let offset = 0; offset < sampleRate * 0.025; offset++) {
      const envelope = 1 - offset / (sampleRate * 0.025);
      samples[start + offset] = Math.sin(offset * 0.4) * envelope * 0.9;
    }
  }
  return { samples, sampleRate };
}

describe('local PCM analysis', () => {
  it('detects sustained silence and transient beats from decoded samples', () => {
    const { samples, sampleRate } = syntheticTrack();
    const analysis = analyzePcm(samples, sampleRate, {
      frameMs: 20,
      minSilenceMs: 300,
      profile: 'amapiano',
    });

    expect(analysis.durationSec).toBe(4);
    expect(analysis.silenceRegions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          startSec: expect.any(Number),
          endSec: expect.any(Number),
        }),
      ]),
    );
    expect(analysis.silenceRegions.some((region) => {
      return region.startSec <= 1.1 && region.endSec >= 1.9;
    })).toBe(true);
    expect(analysis.beatMarkersSec.length).toBeGreaterThanOrEqual(2);
    expect(analysis.beatMarkersSec.some((beat) => Math.abs(beat - 2.5) < 0.08)).toBe(true);
    expect(analysis.dropMarkersSec.length).toBeGreaterThan(0);
  });

  it('rejects empty or invalid PCM input', () => {
    expect(() => analyzePcm(new Float32Array(), 8_000)).toThrow('non-empty PCM');
    expect(() => analyzePcm(new Float32Array([0]), 0)).toThrow('valid sample rate');
  });
});

