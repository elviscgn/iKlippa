export interface CutScoreMetrics {
  score: number;
  clipCount: number;
  durationSec: number;
  averageClipSec: number;
  gapSec: number;
  overlapCount: number;
  shortClipCount: number;
  longClipCount: number;
  pacingVariation: number;
  beatAlignmentMs: number | null;
  summary: string;
}

declare global {
  interface Window {
    iklippaCutScore?: CutScoreMetrics;
    iklippaBeatMarkers?: number[];
  }
}

function nearestDistance(value: number, candidates: number[]): number {
  if (candidates.length === 0) return Number.POSITIVE_INFINITY;
  let nearest = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) nearest = Math.min(nearest, Math.abs(candidate - value));
  return nearest;
}

export function calculateCutScore(
  clips: Array<{ timeline_start_us: number; timeline_end_us: number }>,
  beatMarkersSec: number[] = [],
): CutScoreMetrics {
  const sorted = clips
    .filter((clip) => clip.timeline_end_us > clip.timeline_start_us)
    .slice()
    .sort((a, b) => a.timeline_start_us - b.timeline_start_us);
  if (sorted.length === 0) {
    return {
      score: 0,
      clipCount: 0,
      durationSec: 0,
      averageClipSec: 0,
      gapSec: 0,
      overlapCount: 0,
      shortClipCount: 0,
      longClipCount: 0,
      pacingVariation: 0,
      beatAlignmentMs: null,
      summary: 'Add footage to calculate pacing.',
    };
  }

  const durations = sorted.map((clip) => (clip.timeline_end_us - clip.timeline_start_us) / 1_000_000);
  const durationSec = Math.max(...sorted.map((clip) => clip.timeline_end_us)) / 1_000_000;
  const averageClipSec = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  const variance = durations.reduce((sum, duration) => {
    return sum + (duration - averageClipSec) ** 2;
  }, 0) / durations.length;
  const pacingVariation = averageClipSec > 0 ? Math.sqrt(variance) / averageClipSec : 0;
  const shortClipCount = durations.filter((duration) => duration < 0.45).length;
  const longClipCount = durations.filter((duration) => duration > 8).length;

  let gapSec = Math.max(0, sorted[0]!.timeline_start_us / 1_000_000);
  let overlapCount = 0;
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    const deltaSec = (current.timeline_start_us - previous.timeline_end_us) / 1_000_000;
    if (deltaSec > 0) gapSec += deltaSec;
    if (deltaSec < -0.03) overlapCount++;
  }

  const cutsSec = sorted.slice(1).map((clip) => clip.timeline_start_us / 1_000_000);
  const beatDistances = cutsSec
    .map((cut) => nearestDistance(cut, beatMarkersSec))
    .filter(Number.isFinite);
  const beatAlignmentMs = beatDistances.length > 0
    ? Math.round((beatDistances.reduce((sum, distance) => sum + distance, 0) / beatDistances.length) * 1000)
    : null;

  const gapPenalty = Math.min(30, durationSec > 0 ? (gapSec / durationSec) * 100 : 0);
  const variationPenalty = Math.min(16, Math.max(0, pacingVariation - 0.35) * 14);
  const beatPenalty = beatAlignmentMs === null ? 0 : Math.min(12, Math.max(0, beatAlignmentMs - 90) / 35);
  const rawScore = 100
    - gapPenalty
    - variationPenalty
    - overlapCount * 9
    - shortClipCount * 3
    - longClipCount * 4
    - beatPenalty;
  const score = Math.round(Math.max(1, Math.min(99, rawScore)));

  const notes: string[] = [];
  if (gapSec > 0.25) notes.push(`${gapSec.toFixed(1)}s of timeline gaps`);
  if (longClipCount > 0) notes.push(`${longClipCount} long hold${longClipCount === 1 ? '' : 's'}`);
  if (shortClipCount > 0) notes.push(`${shortClipCount} very short cut${shortClipCount === 1 ? '' : 's'}`);
  if (beatAlignmentMs !== null) notes.push(`${beatAlignmentMs}ms average beat offset`);
  if (notes.length === 0) notes.push('clean continuity and balanced clip lengths');

  return {
    score,
    clipCount: sorted.length,
    durationSec,
    averageClipSec,
    gapSec,
    overlapCount,
    shortClipCount,
    longClipCount,
    pacingVariation,
    beatAlignmentMs,
    summary: notes.join(', '),
  };
}

export function refreshCutScore(): CutScoreMetrics {
  const state = (window as any).IKState;
  const clips = state?.isReady?.() ? state.getVideoClips?.() ?? [] : [];
  const metrics = calculateCutScore(clips, window.iklippaBeatMarkers ?? []);
  window.iklippaCutScore = metrics;

  const score = document.querySelector<HTMLElement>('#insight-score');
  const bar = document.querySelector<HTMLElement>('#insight-bar');
  const box = document.querySelector<HTMLElement>('#insight-box');
  if (score) score.textContent = metrics.clipCount > 0 ? String(metrics.score) : '--';
  if (bar) bar.style.width = `${metrics.clipCount > 0 ? metrics.score : 0}%`;
  box?.classList.toggle('optimized', metrics.score >= 85);
  return metrics;
}

export function initCutScore(): void {
  window.addEventListener('ikl:reRender', refreshCutScore);
  window.addEventListener('ikl:projectSetupChanged', refreshCutScore);
  refreshCutScore();
}
