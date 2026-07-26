export type BeatProfile = 'default' | 'afrobeat' | 'amapiano';

export interface AudioAnalysisOptions {
  frameMs?: number;
  minSilenceMs?: number;
  profile?: BeatProfile;
}

export interface AudioRegion {
  startSec: number;
  endSec: number;
}

export interface AudioAnalysisResult {
  durationSec: number;
  silenceRegions: AudioRegion[];
  beatMarkersSec: number[];
  dropMarkersSec: number[];
  noiseFloorDb: number;
  silenceThresholdDb: number;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return -60;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * ratio)));
  return sorted[index] ?? -60;
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function frameEnergies(
  samples: Float32Array,
  sampleRate: number,
  frameSamples: number,
): { full: number[]; low: number[]; db: number[] } {
  const full: number[] = [];
  const low: number[] = [];
  const db: number[] = [];
  const lowPassAlpha = 1 - Math.exp((-2 * Math.PI * 190) / sampleRate);
  let lowPassed = 0;

  for (let start = 0; start < samples.length; start += frameSamples) {
    const end = Math.min(samples.length, start + frameSamples);
    let fullSum = 0;
    let lowSum = 0;
    for (let index = start; index < end; index++) {
      const sample = samples[index] ?? 0;
      lowPassed += lowPassAlpha * (sample - lowPassed);
      fullSum += sample * sample;
      lowSum += lowPassed * lowPassed;
    }
    const count = Math.max(1, end - start);
    const fullRms = Math.sqrt(fullSum / count);
    full.push(fullRms);
    low.push(Math.sqrt(lowSum / count));
    db.push(20 * Math.log10(Math.max(1e-7, fullRms)));
  }
  return { full, low, db };
}

function detectSilence(
  db: number[],
  frameSec: number,
  minSilenceMs: number,
): { regions: AudioRegion[]; noiseFloorDb: number; thresholdDb: number } {
  const finiteDb = db.filter(Number.isFinite);
  const noiseFloorDb = percentile(finiteDb, 0.18);
  const speechFloor = percentile(finiteDb, 0.72);
  const dynamicRange = Math.max(4, speechFloor - noiseFloorDb);
  const thresholdDb = clamp(noiseFloorDb + Math.min(12, dynamicRange * 0.42), -48, -28);
  const minimumFrames = Math.max(1, Math.ceil(minSilenceMs / (frameSec * 1000)));
  const regions: AudioRegion[] = [];
  let runStart = -1;

  for (let index = 0; index <= db.length; index++) {
    const isSilent = index < db.length && (db[index] ?? 0) <= thresholdDb;
    if (isSilent && runStart < 0) runStart = index;
    if (!isSilent && runStart >= 0) {
      if (index - runStart >= minimumFrames) {
        regions.push({
          startSec: runStart * frameSec,
          endSec: index * frameSec,
        });
      }
      runStart = -1;
    }
  }
  return { regions, noiseFloorDb, thresholdDb };
}

function onsetEnvelope(full: number[], low: number[], profile: BeatProfile): number[] {
  const lowWeight = profile === 'amapiano' ? 0.72 : profile === 'afrobeat' ? 0.56 : 0.38;
  const envelope: number[] = [];
  let previous = 0;
  let smoothed = 0;
  for (let index = 0; index < full.length; index++) {
    const energy = (full[index] ?? 0) * (1 - lowWeight) + (low[index] ?? 0) * lowWeight;
    const onset = Math.max(0, energy - previous);
    smoothed = smoothed * 0.22 + onset * 0.78;
    envelope.push(smoothed);
    previous = previous * 0.35 + energy * 0.65;
  }
  return envelope;
}

function detectBeats(
  envelope: number[],
  fullEnergy: number[],
  frameSec: number,
  profile: BeatProfile,
): { beats: number[]; drops: number[] } {
  if (envelope.length < 3) return { beats: [], drops: [] };
  const center = median(envelope);
  const deviations = envelope.map((value) => Math.abs(value - center));
  const threshold = center + Math.max(1e-5, median(deviations) * 3.2);
  const minimumGapSec = profile === 'amapiano' ? 0.34 : profile === 'afrobeat' ? 0.29 : 0.24;
  const minimumFrames = Math.max(1, Math.round(minimumGapSec / frameSec));
  const candidates: Array<{ index: number; strength: number }> = [];

  for (let index = 1; index < envelope.length - 1; index++) {
    const value = envelope[index] ?? 0;
    if (value < threshold || value < (envelope[index - 1] ?? 0) || value <= (envelope[index + 1] ?? 0)) {
      continue;
    }
    const previous = candidates[candidates.length - 1];
    if (previous && index - previous.index < minimumFrames) {
      if (value > previous.strength) candidates[candidates.length - 1] = { index, strength: value };
    } else {
      candidates.push({ index, strength: value });
    }
  }

  const beats = candidates.map((candidate) => Number((candidate.index * frameSec).toFixed(4)));
  const dropCandidates = candidates.filter((candidate) => {
    const lookback = Math.max(1, Math.round(0.8 / frameSec));
    const start = Math.max(0, candidate.index - lookback);
    const history = fullEnergy.slice(start, candidate.index);
    const average = history.length
      ? history.reduce((sum, value) => sum + value, 0) / history.length
      : 0;
    return (fullEnergy[candidate.index] ?? 0) > Math.max(average * 1.55, average + 0.012);
  });
  const drops = dropCandidates
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 4)
    .sort((a, b) => a.index - b.index)
    .map((candidate) => Number((candidate.index * frameSec).toFixed(4)));
  return { beats, drops };
}

export function analyzePcm(
  samples: Float32Array,
  sampleRate: number,
  options: AudioAnalysisOptions = {},
): AudioAnalysisResult {
  if (sampleRate <= 0 || samples.length === 0) {
    throw new Error('Audio analysis needs non-empty PCM and a valid sample rate.');
  }
  const frameMs = options.frameMs ?? 24;
  const minSilenceMs = options.minSilenceMs ?? 360;
  const profile = options.profile ?? 'default';
  const frameSamples = Math.max(32, Math.round((sampleRate * frameMs) / 1000));
  const frameSec = frameSamples / sampleRate;
  const energy = frameEnergies(samples, sampleRate, frameSamples);
  const silence = detectSilence(energy.db, frameSec, minSilenceMs);
  const onsets = onsetEnvelope(energy.full, energy.low, profile);
  const beats = detectBeats(onsets, energy.full, frameSec, profile);

  return {
    durationSec: samples.length / sampleRate,
    silenceRegions: silence.regions,
    beatMarkersSec: beats.beats,
    dropMarkersSec: beats.drops,
    noiseFloorDb: Number(silence.noiseFloorDb.toFixed(2)),
    silenceThresholdDb: Number(silence.thresholdDb.toFixed(2)),
  };
}
