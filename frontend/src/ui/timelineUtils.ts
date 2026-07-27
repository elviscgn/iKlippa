import { $, S, us2s } from './state';

export function getLaneW() {
  const tracks = $('#tl-tracks');
  const lane =
    (typeof tracks?.querySelector === 'function'
      ? tracks.querySelector('.track-lane')
      : null) as HTMLElement | null ??
    ($('#lane-v1') as HTMLElement | null);
  const measuredLaneWidth = lane?.getBoundingClientRect?.().width ?? 0;
  if (measuredLaneWidth > 0) return measuredLaneWidth * S.zoom;
  if (!tracks || typeof tracks.querySelector !== 'function') return 100;

  const trackGutter = tracks.querySelector('.track-gutter') as HTMLElement | null;
  const styles = typeof window.getComputedStyle === 'function'
    ? window.getComputedStyle(tracks)
    : ({ paddingLeft: '0', paddingRight: '0' } as CSSStyleDeclaration);
  const horizontalPadding =
    parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0');
  const gutterWidth = trackGutter?.offsetWidth ?? 96;
  const availableWidth = Math.max(240, tracks.clientWidth - horizontalPadding - gutterWidth);

  return availableWidth * S.zoom;
}

export function getTimelineLaneOffset() {
  const body = $('#tl-body');
  const tracks = $('#tl-tracks');
  const lane =
    (typeof tracks?.querySelector === 'function'
      ? tracks.querySelector('.track:not(.ai-track) .track-lane')
      : null) as HTMLElement | null ??
    ($('#lane-ai') as HTMLElement | null);
  if (
    !body ||
    !tracks ||
    !lane ||
    typeof body.getBoundingClientRect !== 'function' ||
    typeof lane.getBoundingClientRect !== 'function'
  ) return 100;

  const bodyRect = body.getBoundingClientRect();
  const laneRect = lane.getBoundingClientRect();
  return laneRect.left - bodyRect.left + tracks.scrollLeft;
}

function getSnapPoints(excludeClipId: string | number | null, includePlayhead: boolean) {
  const IKState = (window as any).IKState;
  const points = new Set<number>();
  points.add(0);
  if (includePlayhead) {
    points.add(Math.round(S.time * 1_000_000));
  }
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

const SNAP_THRESHOLD_PX = 12;

export function applySnap(rawUs: number, excludeClipId: string | number | null, tw: number, includePlayhead = false) {
  const thresholdUs = Math.round((SNAP_THRESHOLD_PX / tw) * S.dur * 1_000_000);
  const points = getSnapPoints(excludeClipId, includePlayhead);
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
  const scrollLeft = $('#tl-tracks')?.scrollLeft ?? 0;
  snapGuide.style.left = getTimelineLaneOffset() + px - scrollLeft + 'px';
  snapGuide.classList.add('active');
}

export function hideSnapGuide() {
  $('#snap-guide')?.classList.remove('active');
}
