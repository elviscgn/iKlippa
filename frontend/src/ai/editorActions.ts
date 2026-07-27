import { analyzeSourceAudio } from './audioAnalysis';
import type { AudioRegion, BeatProfile } from './audioMath';
import type { EditorActionResult } from '../commands/editorCommands';
import { selectedClipIds, saveSnapshot } from '../ui/dragDrop';
import { resolveSourceForAnalysis } from '../media/sourceRegistry';

interface ContentRange {
  startUs: number;
  endUs: number;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function selectedOrAllVideoIds(): number[] {
  const state = (window as any).IKState;
  if (!state?.isReady?.()) return [];
  const selected = new Set([...selectedClipIds].map(Number));
  const video = state.getVideoClips?.() ?? [];
  const selectedVideo = video.filter((clip: any) => selected.has(Number(clip.id)));
  const playheadUs = Math.round(((window as any).S?.time ?? 0) * 1_000_000);
  const atPlayhead = video.filter((clip: any) => {
    return playheadUs >= clip.timeline_start_us && playheadUs < clip.timeline_end_us;
  });
  return (selectedVideo.length ? selectedVideo : atPlayhead.length ? atPlayhead : video)
    .map((clip: any) => Number(clip.id));
}

function removableSilenceRanges(
  silence: AudioRegion[],
  sourceStartUs: number,
  sourceEndUs: number,
): ContentRange[] {
  const handleUs = 85_000;
  return silence
    .map((region) => ({
      startUs: Math.max(sourceStartUs, Math.round(region.startSec * 1_000_000) + handleUs),
      endUs: Math.min(sourceEndUs, Math.round(region.endSec * 1_000_000) - handleUs),
    }))
    .filter((region) => region.endUs - region.startUs >= 180_000)
    .sort((a, b) => a.startUs - b.startUs);
}

function contentRangesAroundSilence(
  sourceStartUs: number,
  sourceEndUs: number,
  silence: ContentRange[],
): ContentRange[] {
  const content: ContentRange[] = [];
  let cursor = sourceStartUs;
  for (const region of silence) {
    if (region.startUs > cursor) content.push({ startUs: cursor, endUs: region.startUs });
    cursor = Math.max(cursor, region.endUs);
  }
  if (cursor < sourceEndUs) content.push({ startUs: cursor, endUs: sourceEndUs });
  return content.filter((range) => range.endUs - range.startUs >= 120_000);
}

function copyClipProperties(source: any, target: any): void {
  target.speed = source.speed || 1;
  target.transform = deepClone(source.transform);
  target.colour_settings = deepClone(source.colour_settings);
  target.effects = deepClone(source.effects ?? []);
  target.caption_text = source.caption_text ?? null;
  target.caption_style = source.caption_style ? deepClone(source.caption_style) : null;
}

function rippleAfter(
  tracks: any[],
  originalEndUs: number,
  removedUs: number,
  excludedIds: Set<number>,
): void {
  if (removedUs <= 0) return;
  for (const track of tracks) {
    for (const clip of track.clips ?? []) {
      if (excludedIds.has(Number(clip.id))) continue;
      if (clip.timeline_start_us >= originalEndUs - 1000) {
        clip.timeline_start_us = Math.max(0, clip.timeline_start_us - removedUs);
        clip.timeline_end_us = Math.max(clip.timeline_start_us, clip.timeline_end_us - removedUs);
      }
    }
    track.clips?.sort((a: any, b: any) => a.timeline_start_us - b.timeline_start_us);
  }
}

function hasCloseableTimelineGap(tracks: any[], targetTrackIds: Set<number>): boolean {
  return tracks.some((track) => {
    if (!targetTrackIds.has(Number(track.id))) return false;
    const clips = [...(track.clips ?? [])]
      .sort((a: any, b: any) => a.timeline_start_us - b.timeline_start_us);
    let coveredUntilUs = 0;
    for (const clip of clips) {
      if (clip.timeline_start_us - coveredUntilUs > 1000) return true;
      coveredUntilUs = Math.max(coveredUntilUs, clip.timeline_end_us);
    }
    return false;
  });
}

function closeTimelineGaps(
  tracks: any[],
  targetTrackIds: Set<number>,
): { count: number; removedUs: number } {
  let count = 0;
  let removedUs = 0;
  for (const track of tracks) {
    if (!targetTrackIds.has(Number(track.id))) continue;
    const clips = [...(track.clips ?? [])]
      .sort((a: any, b: any) => a.timeline_start_us - b.timeline_start_us);
    let coveredUntilUs = 0;
    for (const clip of clips) {
      const gapUs = clip.timeline_start_us - coveredUntilUs;
      if (gapUs > 1000) {
        rippleAfter(tracks, clip.timeline_start_us, gapUs, new Set());
        count += 1;
        removedUs += gapUs;
      }
      coveredUntilUs = Math.max(coveredUntilUs, clip.timeline_end_us);
    }
  }
  return { count, removedUs };
}

async function smartTrim(targetIds: number[]): Promise<EditorActionResult> {
  const state = (window as any).IKState;
  if (!state?.isReady?.()) throw new Error('Import a video before using Smart Trim.');
  const ids = targetIds.length ? targetIds : selectedOrAllVideoIds();
  const candidates = ids
    .map((id) => state.findClip?.(id))
    .filter((clip: any) => clip && state.findClipTrack?.(clip.id)?.track_type === 'video')
    .sort((a: any, b: any) => a.timeline_start_us - b.timeline_start_us);
  if (candidates.length === 0) throw new Error('Select a video clip with an audio track first.');
  const targetTrackIds = new Set<number>(candidates.map((clip: any) => {
    return Number(state.findClipTrack?.(clip.id)?.id);
  }));

  const plans: Array<{
    id: number;
    sourceId: string;
    silence: ContentRange[];
  }> = [];
  for (const clip of candidates) {
    const sourceId = await resolveSourceForAnalysis(clip.source_id, 'video');
    if (!sourceId) {
      throw new Error('This restored clip is not linked to loaded media. Re-import its video once, then Smart Trim will work normally.');
    }
    const analysis = await analyzeSourceAudio(sourceId, 'default');
    const silence = removableSilenceRanges(
      analysis.silenceRegions,
      clip.source_start_us,
      clip.source_end_us,
    );
    if (silence.length > 0) plans.push({ id: Number(clip.id), sourceId, silence });
  }
  const tracks = state.getTracks?.() ?? [];
  if (plans.length === 0 && !hasCloseableTimelineGap(tracks, targetTrackIds)) {
    return { message: 'Smart Trim found no removable silence in the selected clip.' };
  }

  saveSnapshot();
  let removedUsTotal = 0;
  let regionCount = 0;
  const affectedClipIds: number[] = [];
  for (const plan of plans) {
    const clip = state.findClip?.(plan.id);
    const track = clip ? state.findClipTrack?.(clip.id) : null;
    if (!clip || !track) continue;
    const meta = deepClone(state.getClipMeta?.(clip.id) ?? {});
    const original = deepClone(clip);
    const originalStartUs = clip.timeline_start_us;
    const originalEndUs = clip.timeline_end_us;
    const originalTimelineDurationUs = originalEndUs - originalStartUs;
    const ranges = contentRangesAroundSilence(
      clip.source_start_us,
      clip.source_end_us,
      plan.silence,
    );
    if (ranges.length === 0) continue;

    state.removeClip(clip.id);
    let cursorUs = originalStartUs;
    const createdIds = new Set<number>();
    for (const range of ranges) {
      const timelineDurationUs = Math.round((range.endUs - range.startUs) / (original.speed || 1));
      const created = state.addClip(
        track.id,
        plan.sourceId,
        cursorUs,
        cursorUs + timelineDurationUs,
        meta,
      );
      if (!created) continue;
      copyClipProperties(original, created);
      created.source_start_us = range.startUs;
      created.source_end_us = range.endUs;
      createdIds.add(Number(created.id));
      affectedClipIds.push(Number(created.id));
      cursorUs += timelineDurationUs;
    }
    const removedUs = Math.max(0, originalTimelineDurationUs - (cursorUs - originalStartUs));
    removedUsTotal += removedUs;
    regionCount += plan.silence.length;
    rippleAfter(state.getTracks?.() ?? [], originalEndUs, removedUs, createdIds);
  }
  const gaps = closeTimelineGaps(state.getTracks?.() ?? [], targetTrackIds);

  state.computeDuration?.();
  const markerTime = Math.max(0, ((window as any).S?.time ?? 0));
  const markerParts: string[] = [];
  if (regionCount > 0) {
    markerParts.push(`${regionCount} silence region${regionCount === 1 ? '' : 's'} trimmed`);
  }
  if (gaps.count > 0) {
    markerParts.push(`${gaps.count} timeline gap${gaps.count === 1 ? '' : 's'} closed`);
  }
  window.aiNodes?.push({
    time: markerTime,
    label: markerParts.join(', '),
    icon: 'scissors',
  });
  window.dispatchEvent(new CustomEvent('ikl:reRender', {
    detail: { activeClipId: affectedClipIds[0] },
  }));
  const summaryParts: string[] = [];
  if (regionCount > 0) {
    summaryParts.push(
      `Removed ${regionCount} silent region${regionCount === 1 ? '' : 's'} (${(removedUsTotal / 1_000_000).toFixed(1)}s)`,
    );
  }
  if (gaps.count > 0) {
    summaryParts.push(
      `${regionCount > 0 ? 'closed' : 'Closed'} ${gaps.count} timeline gap${gaps.count === 1 ? '' : 's'} (${(gaps.removedUs / 1_000_000).toFixed(1)}s)`,
    );
  }
  return {
    message: `${summaryParts.join(' and ')} locally.`,
    affectedClipIds,
  };
}

function beatProfile(): BeatProfile {
  const context = `${window.iklippaProjectSetup?.script ?? ''} ${window.iklippaProjectSetup?.guidelines ?? ''}`.toLowerCase();
  if (context.includes('amapiano')) return 'amapiano';
  if (context.includes('afrobeat') || context.includes('afro-beat')) return 'afrobeat';
  return 'default';
}

function selectedAudioClip(state: any): any | null {
  const selected = new Set([...selectedClipIds].map(Number));
  const audio = state.getAudioClips?.() ?? [];
  return audio.find((clip: any) => selected.has(Number(clip.id))) ?? audio[0] ?? null;
}

function timelineBeatMarkers(audioClip: any, sourceMarkersSec: number[]): number[] {
  const sourceStartSec = audioClip.source_start_us / 1_000_000;
  const sourceEndSec = audioClip.source_end_us / 1_000_000;
  const timelineStartSec = audioClip.timeline_start_us / 1_000_000;
  const speed = audioClip.speed || 1;
  return sourceMarkersSec
    .filter((marker) => marker >= sourceStartSec && marker <= sourceEndSec)
    .map((marker) => timelineStartSec + (marker - sourceStartSec) / speed);
}

function nearestBeat(boundarySec: number, beats: number[]): number | null {
  let best: number | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const beat of beats) {
    const nextDistance = Math.abs(beat - boundarySec);
    if (nextDistance < distance) {
      best = beat;
      distance = nextDistance;
    }
  }
  return distance <= 0.46 ? best : null;
}

function canAdjustBoundary(left: any, right: any, deltaUs: number): boolean {
  const minimumTimelineUs = 420_000;
  const leftTimelineDuration = left.timeline_end_us + deltaUs - left.timeline_start_us;
  const rightTimelineDuration = right.timeline_end_us - (right.timeline_start_us + deltaUs);
  if (leftTimelineDuration < minimumTimelineUs || rightTimelineDuration < minimumTimelineUs) return false;
  const leftSourceEnd = left.source_end_us + Math.round(deltaUs * (left.speed || 1));
  const rightSourceStart = right.source_start_us + Math.round(deltaUs * (right.speed || 1));
  if (leftSourceEnd <= left.source_start_us || rightSourceStart < 0 || rightSourceStart >= right.source_end_us) {
    return false;
  }
  if (deltaUs > 0 && left.source_id !== right.source_id) return false;
  if (left.source_id === right.source_id && leftSourceEnd > right.source_end_us) return false;
  return true;
}

async function beatSync(targetIds: number[]): Promise<EditorActionResult> {
  const state = (window as any).IKState;
  if (!state?.isReady?.()) throw new Error('Import footage before using Beat Sync.');
  const music = selectedAudioClip(state);
  if (!music) throw new Error('Add a music track before using Beat Sync.');
  const profile = beatProfile();
  const sourceId = await resolveSourceForAnalysis(music.source_id, 'any');
  if (!sourceId) {
    throw new Error('This music clip is not linked to loaded media. Re-import it once, then Beat Sync will work normally.');
  }
  if (sourceId !== music.source_id) music.source_id = sourceId;
  const analysis = await analyzeSourceAudio(sourceId, profile);
  const markers = timelineBeatMarkers(music, analysis.beatMarkersSec);
  const drops = timelineBeatMarkers(music, analysis.dropMarkersSec);
  if (markers.length === 0) throw new Error('No clear beats were detected in the selected music.');
  window.iklippaBeatMarkers = markers;

  const targets = new Set((targetIds.length ? targetIds : selectedOrAllVideoIds()).map(Number));
  const adjustments: Array<{ left: any; right: any; beat: number; deltaUs: number }> = [];
  for (const track of state.getTracks?.() ?? []) {
    if (track.track_type !== 'video') continue;
    const clips = (track.clips ?? []).slice().sort((a: any, b: any) => {
      return a.timeline_start_us - b.timeline_start_us;
    });
    for (let index = 1; index < clips.length; index++) {
      const left = clips[index - 1]!;
      const right = clips[index]!;
      if (!targets.has(Number(left.id)) && !targets.has(Number(right.id))) continue;
      if (Math.abs(right.timeline_start_us - left.timeline_end_us) > 80_000) continue;
      const currentBoundarySec = right.timeline_start_us / 1_000_000;
      const beat = nearestBeat(currentBoundarySec, markers);
      if (beat === null) continue;
      const deltaUs = Math.round((beat - currentBoundarySec) * 1_000_000);
      if (Math.abs(deltaUs) < 35_000 || !canAdjustBoundary(left, right, deltaUs)) continue;
      adjustments.push({ left, right, beat, deltaUs });
    }
  }
  if (adjustments.length === 0) {
    return {
      message: `Detected ${markers.length} ${profile} beats, but the current cuts are already aligned or outside the safe snap range.`,
    };
  }

  saveSnapshot();
  const affected = new Set<number>();
  for (const adjustment of adjustments) {
    adjustment.left.timeline_end_us += adjustment.deltaUs;
    adjustment.left.source_end_us += Math.round(adjustment.deltaUs * (adjustment.left.speed || 1));
    adjustment.right.timeline_start_us += adjustment.deltaUs;
    adjustment.right.source_start_us += Math.round(adjustment.deltaUs * (adjustment.right.speed || 1));
    affected.add(Number(adjustment.left.id));
    affected.add(Number(adjustment.right.id));
  }
  state.computeDuration?.();
  for (const marker of markers.slice(0, 16)) {
    window.aiNodes?.push({ time: marker, label: 'Beat', icon: 'zap' });
  }
  for (const marker of drops) {
    window.aiNodes?.push({ time: marker, label: 'Bass drop', icon: 'music' });
  }
  window.dispatchEvent(new CustomEvent('ikl:reRender', {
    detail: { activeClipId: [...affected][0] },
  }));
  return {
    message: `Snapped ${adjustments.length} cut${adjustments.length === 1 ? '' : 's'} to ${profile === 'default' ? '' : `${profile} `}beats detected locally.`,
    affectedClipIds: [...affected],
  };
}

export function initEditorActions(): void {
  window.runSmartTrim = smartTrim;
  window.runBeatSync = beatSync;
}
