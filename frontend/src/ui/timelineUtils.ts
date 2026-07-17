import { $, S, us2s } from './state';

export function getLaneW() {
  const lane = $('#lane-v1');
  if (!lane) return 100;
  return lane.getBoundingClientRect().width * S.zoom;
}

function getSnapPoints(excludeClipId: string | number | null) {
  const IKState = (window as any).IKState;
  const points = new Set<number>();
  points.add(0);
  points.add(Math.round(S.time * 1_000_000));
  if (IKState) {
    const allClips = [...IKState.getVideoClips(), ...IKState.getAudioClips()];
    for (const c of allClips) {
      if (c.id === excludeClipId) continue;
      points.add(c.timeline_start_us);
      points.add(c.timeline_end_us);
    }
  }
  return Array.from(points);
}

const SNAP_THRESHOLD_PX = 16;

export function applySnap(rawUs: number, excludeClipId: string | number | null, tw: number) {
  const thresholdUs = Math.round((SNAP_THRESHOLD_PX / tw) * S.dur * 1_000_000);
  const points = getSnapPoints(excludeClipId);
  let best: number | null = null;
  for (const p of points) {
    if (Math.abs(rawUs - p) <= thresholdUs) {
      if (best === null || Math.abs(rawUs - p) < Math.abs(rawUs - best)) {
        best = p;
      }
    }
  }
  return best;
}

export function showSnapGuide(timeUs: number, tw: number) {
  const snapGuide = $('#snap-guide');
  if (!snapGuide) return;
  const px = (us2s(timeUs) / S.dur) * tw;
  snapGuide.style.left = 100 + px + 'px';
  snapGuide.classList.add('active');
}

export function hideSnapGuide() {
  $('#snap-guide')?.classList.remove('active');
}
