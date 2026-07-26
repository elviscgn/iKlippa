import { searchStockVideos } from '../api/stock';
import {
  materializeMediaPayload,
  type MediaDragPayload,
} from '../ui/mediaPool';
import { selectedClipIds, saveSnapshot } from '../ui/dragDrop';
import { isOfflineMode } from '../ui/utils';
import {
  resolveMentionTargets,
  type ParsedEditorCommand,
} from './parser';

export interface EditorActionResult {
  message: string;
  affectedClipIds?: number[];
}

declare global {
  interface Window {
    runSmartTrim?: (targetIds: number[]) => Promise<EditorActionResult>;
    runBeatSync?: (targetIds: number[]) => Promise<EditorActionResult>;
  }
}

function projectClips(): Array<{ clip: any; track: any }> {
  const state = (window as any).IKState;
  if (!state?.isReady?.()) return [];
  const entries: Array<{ clip: any; track: any }> = [];
  for (const track of state.getTracks?.() ?? []) {
    for (const clip of track.clips ?? []) entries.push({ clip, track });
  }
  return entries;
}

function clipIdsAtPlayhead(trackType = 'video'): number[] {
  const playheadUs = Math.round(((window as any).S?.time ?? 0) * 1_000_000);
  return projectClips()
    .filter(({ clip, track }) => {
      return track.track_type === trackType &&
        playheadUs >= clip.timeline_start_us &&
        playheadUs < clip.timeline_end_us;
    })
    .map(({ clip }) => Number(clip.id));
}

function selectedIdsForTrack(trackType = 'video'): number[] {
  const selected = new Set([...selectedClipIds].map(Number));
  return projectClips()
    .filter(({ clip, track }) => track.track_type === trackType && selected.has(Number(clip.id)))
    .map(({ clip }) => Number(clip.id));
}

function allIdsForTrack(trackType = 'video'): number[] {
  return projectClips()
    .filter(({ track }) => track.track_type === trackType)
    .map(({ clip }) => Number(clip.id));
}

export function resolveCommandTargetIds(
  parsed: ParsedEditorCommand,
  trackType = 'video',
): number[] {
  const explicit = resolveMentionTargets(parsed)
    .filter((target) => target.trackType === trackType)
    .map((target) => target.id);
  if (explicit.length > 0) return explicit;
  const selected = selectedIdsForTrack(trackType);
  if (selected.length > 0) return selected;
  const atPlayhead = clipIdsAtPlayhead(trackType);
  if (atPlayhead.length > 0) return atPlayhead;
  return allIdsForTrack(trackType);
}

export function selectMentionedClips(parsed: Pick<ParsedEditorCommand, 'mentions'>): number[] {
  const targets = resolveMentionTargets(parsed);
  if (targets.length === 0) return [];
  selectedClipIds.clear();
  for (const target of targets) selectedClipIds.add(target.id);
  window.dispatchEvent(new CustomEvent('ikl:reRender', {
    detail: { activeClipId: targets[0]?.id, selectedClipIds: targets.map((target) => target.id) },
  }));
  return targets.map((target) => target.id);
}

function getOrCreateBrollTrack(): any | null {
  const state = (window as any).IKState;
  if (!state?.isReady?.()) return null;
  const videoTracks = (state.getTracks?.() ?? []).filter((track: any) => track.track_type === 'video');
  if (videoTracks[1]) return videoTracks[1];
  return state.addTrack?.('video') ?? null;
}

async function runAutoBroll(query: string): Promise<EditorActionResult> {
  if (isOfflineMode()) {
    throw new Error('Auto b-roll needs an internet connection for Pexels search.');
  }
  const setup = window.iklippaProjectSetup;
  const resolvedQuery = query.trim() || setup?.keywords?.slice(0, 2).join(' ') || 'cinematic';
  const results = await searchStockVideos(resolvedQuery);
  const result = results[0];
  if (!result) throw new Error(`No Pexels footage found for "${resolvedQuery}".`);

  const payload: MediaDragPayload = {
    app: 'iklippa',
    kind: 'video',
    sourceId: `stock_${result.id}`,
    name: result.name,
    durationSec: result.duration || 4,
    isReal: false,
    remoteUrl: result.video_url,
    thumbnailUrl: result.thumbnail_url || undefined,
    provider: result.provider,
    creator: result.creator || undefined,
    mimeType: 'video/mp4',
  };
  const materialized = await materializeMediaPayload(payload);
  const track = getOrCreateBrollTrack();
  if (!track) throw new Error('Create or import a project before adding b-roll.');

  const state = (window as any).IKState;
  const playheadUs = Math.round(((window as any).S?.time ?? 0) * 1_000_000);
  const durationUs = Math.round(Math.min(5, Math.max(2.5, materialized.durationSec)) * 1_000_000);
  saveSnapshot();
  const clip = state.addClip(
    track.id,
    materialized.sourceId,
    playheadUs,
    playheadUs + durationUs,
    {
      name: materialized.name,
      isReal: true,
      picId: materialized.picId || 0,
      provider: result.provider,
      creator: result.creator || '',
      query: resolvedQuery,
    },
  );
  if (!clip) throw new Error('Could not add the downloaded b-roll to the timeline.');
  window.dispatchEvent(new CustomEvent('ikl:reRender', { detail: { activeClipId: clip.id } }));
  return {
    message: `Added "${materialized.name}" from Pexels to Video 2.`,
    affectedClipIds: [Number(clip.id)],
  };
}

export async function executeEditorCommand(
  parsed: ParsedEditorCommand,
): Promise<EditorActionResult> {
  selectMentionedClips(parsed);
  if (parsed.name === 'auto-broll') return runAutoBroll(parsed.query);
  if (parsed.name === 'add-captions') {
    (window as any).applyAiAction?.('captions');
    return { message: 'Generated captions on the timeline.' };
  }
  if (parsed.name === 'trim-silence') {
    const targetIds = resolveCommandTargetIds(parsed);
    if (targetIds.length === 0) throw new Error('Import or select a video clip first.');
    if (!window.runSmartTrim) throw new Error('Local audio analysis is not ready yet.');
    return window.runSmartTrim(targetIds);
  }
  if (parsed.name === 'sync-audio') {
    const targetIds = resolveCommandTargetIds(parsed);
    if (targetIds.length === 0) throw new Error('Add at least one video clip before beat sync.');
    if (!window.runBeatSync) throw new Error('Local beat analysis is not ready yet.');
    return window.runBeatSync(targetIds);
  }
  throw new Error('Unknown command. Try /trim-silence, /sync-audio, /auto-broll, or /add-captions.');
}
