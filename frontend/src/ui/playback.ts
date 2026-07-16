import { $, S, us2s } from './state';
import { updatePlayhead } from './timeline';
import { getLaneW } from './timelineUtils';

declare global {
  interface Window {
    togglePlay: () => void;
    skipTime: (delta: number) => void;
    onPlayheadScrub?: (timeSec: number) => void;
  }
}

// UI-Fallback Play Control (overridden by main.ts when engine loads)
function togglePlay() {
  if (S.playing) {
    S.playing = false;
    if (S.rafId !== null) cancelAnimationFrame(S.rafId);
    S.lastTs = null;
    document.querySelectorAll('.icon-play').forEach((i) => i.setAttribute('data-lucide', 'play'));
    window.lucide.createIcons();
  } else {
    if (S.time >= S.dur) S.time = 0;
    S.playing = true;
    S.lastTs = null;
    document.querySelectorAll('.icon-play').forEach((i) => i.setAttribute('data-lucide', 'pause'));
    window.lucide.createIcons();
    S.rafId = requestAnimationFrame(function playLoop(ts) {
      if (!S.playing) return;
      if (S.lastTs !== null) {
        S.time += (ts - S.lastTs) / 1000;
      }
      if (S.time >= S.dur) {
        S.time = S.dur;
        window.togglePlay();
        return;
      }
      S.lastTs = ts;
      updatePlayhead();
      S.rafId = requestAnimationFrame(playLoop);
    });
  }
}
window.togglePlay = togglePlay;

function skipTime(delta: number) {
  S.time = Math.max(0, Math.min(S.dur, S.time + delta));
  updatePlayhead();
  if (window.onPlayheadScrub) window.onPlayheadScrub(S.time);
}
window.skipTime = skipTime;

// fallow-ignore-next-line complexity
function handleTimelineScrub(e: MouseEvent, el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const isRuler = el.id === 'tl-ruler';
  const headOffset = isRuler ? 0 : 100;
  let x = e.clientX - rect.left;
  if (el.id === 'tl-tracks') {
    x += el.scrollLeft;
  }
  x = Math.max(0, x - headOffset);
  const tw = getLaneW();
  const dur = S.dur;
  if (dur <= 0 || tw <= 0) return;
  S.time = Math.max(0, Math.min((x / tw) * dur, dur));
  updatePlayhead();
  if (window.onPlayheadScrub) window.onPlayheadScrub(S.time);
}

export function initPlayback() {
  document.addEventListener('keydown', (e) => {
    if (
      e.code === 'Space' &&
      (e.target as HTMLElement).tagName !== 'INPUT' &&
      (e.target as HTMLElement).tagName !== 'TEXTAREA'
    ) {
      e.preventDefault();
      window.togglePlay();
    }
  });

  const tlTracks = $('#tl-tracks');
  if (tlTracks) {
    tlTracks.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.tl-clip') || (e.target as HTMLElement).closest('.track-gutter')) return;
      handleTimelineScrub(e, tlTracks);
    });
  }

  const tlRuler = $('#tl-ruler');
  if (tlRuler) {
    tlRuler.onmousedown = (e) => handleTimelineScrub(e, tlRuler);
  }

  const knob = document.querySelector('.playhead-knob') as HTMLElement;
  if (knob) {
    knob.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      const tracks = $('#tl-tracks');
      const tw = getLaneW();
      const dur = S.dur;
      if (dur <= 0 || tw <= 0 || !tracks) return;
      const onMove = (e2: MouseEvent) => {
        const rect = tracks.getBoundingClientRect();
        const x = Math.max(0, e2.clientX - rect.left + tracks.scrollLeft - 100);
        const t = Math.max(0, Math.min((x / tw) * dur, dur));
        S.time = t;
        $('#ph-tracks')!.style.left = 100 + (t / dur) * tw + 'px';
        if (window.onPlayheadScrub) window.onPlayheadScrub(t);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
}
