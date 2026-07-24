import {
  applySnap,
  showSnapGuide,
  hideSnapGuide,
  getLaneW,
  getTimelineLaneOffset,
} from './timelineUtils';
import { addCaptionAtPlayhead } from './captions';

function getTrackLane(trackId: number): HTMLElement | null {
  return document.querySelector(`[data-track-id="${trackId}"] .track-lane`);
}

function setClipDimensions(el: HTMLElement, clip: any, dur: number, tw: number) {
  const clipStartSec = us2s(clip.timeline_start_us);
  const clipDurSec = us2s(clip.timeline_end_us) - clipStartSec;
  const left = (clipStartSec / dur) * tw;
  const w = (clipDurSec / dur) * tw;
  el.style.left = left + 'px';
  el.style.width = w + 'px';
  return w;
}
import { $, $$, S, us2s, aiNodes } from './state';
import { escapeHtml, picUrl, showToast } from './utils';
import { applyDragLogic, selectedClipIds, saveSnapshot } from './dragDrop';

declare global {
  interface Window {
    calculateTimelineDuration: () => number;
    autoFitZoom: () => void;
    renderRuler: () => void;
    renderClips: () => void;
    updatePlayhead: () => void;
    applyAiAction: (type: 'silence' | 'captions' | 'sync') => void;
    resetAiActions: () => void;
  }
}

export function calculateTimelineDuration() {
  const IKState = (window as any).IKState;
  let maxEndSec = 0;
  if (typeof IKState !== 'undefined' && IKState.isReady()) {
    const allClips = [...IKState.getVideoClips(), ...IKState.getAudioClips()];
    for (const clip of allClips) {
      const endSec = us2s(clip.timeline_end_us);
      if (endSec > maxEndSec) maxEndSec = endSec;
    }
  }
  const buffered = Math.max(10, maxEndSec + 10);
  S.dur = buffered;
  return buffered;
}
window.calculateTimelineDuration = calculateTimelineDuration;

function autoFitZoom() {
  if (S.dur <= 0) return;
  const laneRefW = getLaneW() / Math.max(S.zoom, 0.01);
  const minPxPerSec = 20;
  S.zoom = Math.max(1, (minPxPerSec * S.dur) / laneRefW);
  const zt = $('#zoom-text');
  if (zt) zt.textContent = Math.round(S.zoom * 100) + '%';
}
window.autoFitZoom = autoFitZoom;



// fallow-ignore-next-line complexity
export function renderRuler() {
  const r = $('#tl-ruler');
  if (!r) return;
  r.querySelectorAll('.ruler-tick').forEach((t) => t.remove());
  const tw = getLaneW();
  r.style.width = tw + 'px';
  const dur = S.dur;
  if (dur <= 0) return;

  let interval;
  if (dur <= 10) interval = S.zoom > 1.5 ? 0.5 : 1;
  else if (dur <= 30) interval = S.zoom > 1.5 ? 1 : 2;
  else if (dur <= 120) interval = S.zoom > 1.5 ? 2 : 5;
  else interval = S.zoom > 1.5 ? 5 : 10;

  const subdivisions = 4;
  const minorInterval = interval / subdivisions;
  const tickCount = Math.floor(dur / minorInterval);

  for (let index = 0; index <= tickCount; index++) {
    const s = index * minorInterval;
    const isMajor = index % subdivisions === 0;
    const tick = document.createElement('div');
    tick.className = `ruler-tick ${isMajor ? 'major' : 'minor'}`;
    tick.style.left = (s / dur) * tw + 'px';
    if (isMajor) {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      const label = m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}s`;
      tick.innerHTML = `<div class="tick-line"></div><span class="tick-label">${label}</span>`;
    } else {
      tick.innerHTML = '<div class="tick-line"></div>';
    }
    r.appendChild(tick);
  }
}
window.renderRuler = renderRuler;

// ── Snap Logic ─────────────────────────────────────────────────────────
const SNAP_THRESHOLD_PX = 16;

function reRender(activeClipId?: number | string) {
  const IKState = (window as any).IKState;
  if (!IKState) return;
  IKState.computeDuration();
  calculateTimelineDuration();
  renderRuler();
  renderClips();
  updatePlayhead();
  if (activeClipId !== undefined) {
    selectedClipIds.clear();
    selectedClipIds.add(activeClipId);
    const el = document.querySelector(`[data-clip-id="${activeClipId}"]`);
    if (el) el.classList.add('active');
  } else if (selectedClipIds.size > 0) {
    const sel = [...selectedClipIds];
    selectedClipIds.clear();
    for (const id of sel) {
      selectedClipIds.add(id);
      const el = document.querySelector(`[data-clip-id="${id}"]`);
      if (el) el.classList.add('active');
    }
  }
}

window.addEventListener('ikl:reRender', ((e: CustomEvent) => {
  reRender(e.detail?.activeClipId);
}) as EventListener);


function seededBarHeight(i: number) {
  let x = ((i * 2654435761) >>> 0) & 0xff;
  return 10 + (x % 28);
}

function formatDuration(sec: number) {
  const safeSec = Math.max(0, Math.floor(sec));
  const h = Math.floor(safeSec / 3600);
  const m = Math.floor((safeSec % 3600) / 60);
  const s = safeSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateTimelineSummary(tracks: any[]) {
  const summary = $('#tl-summary');
  if (!summary) return;

  const clips = tracks.flatMap((track) => track.clips ?? []);
  const projectEndSec = clips.reduce(
    (latest, clip) => Math.max(latest, us2s(clip.timeline_end_us)),
    0,
  );
  const clipLabel = clips.length === 1 ? '1 clip' : `${clips.length} clips`;
  summary.textContent = clips.length
    ? `${clipLabel} · ${formatDuration(projectEndSec)}`
    : 'No clips · 00:00';
}

function appendClipDuration(el: HTMLElement, clip: any) {
  const width = parseFloat(el.style.width || '0');
  if (width < 96) return;

  const duration = document.createElement('span');
  duration.className = 'tl-clip-duration';
  duration.textContent = formatDuration(us2s(clip.timeline_end_us - clip.timeline_start_us));
  el.appendChild(duration);
}

export function renderClips() {
  const IKState = (window as any).IKState;
  if (!IKState) return;
  const tracks = IKState.getTracks ? IKState.getTracks() : null;

  // Backward compat: fall through to old rendering if getTracks isn't available
  if (!tracks || tracks.length === 0) {
    renderClipsLegacy(IKState);
    return;
  }

  const tlTracks = $('#tl-tracks');
  if (!tlTracks) return;
  const tw = getLaneW();
  const dur = S.dur;
  if (dur <= 0) return;
  updateTimelineSummary(tracks);

  // Keep the visual stack predictable regardless of when tracks were created.
  const trackTypeOrder: Record<string, number> = { video: 0, audio: 1, caption: 2 };
  const sortedTracks = [...tracks].sort((a, b) => {
    if (a.track_type !== b.track_type) {
      return (trackTypeOrder[a.track_type] ?? 99) - (trackTypeOrder[b.track_type] ?? 99);
    }
    return a.order - b.order;
  });

  // Clear existing track DOM (keep AI track)
  tlTracks.querySelectorAll('.track.video-track, .track.audio-track, .track.caption-track').forEach((t) => t.remove());

  for (const track of sortedTracks) {
    const trackEl = document.createElement('div');
    trackEl.className = `track ${track.track_type}-track`;
    trackEl.setAttribute('data-track-id', String(track.id));

    const gutter = document.createElement('div');
    gutter.className = 'track-gutter';
    const isCaption = track.track_type === 'caption';
    const trackIcon =
      track.track_type === 'video'
        ? 'film'
        : track.track_type === 'audio'
          ? 'audio-waveform'
          : 'captions';
    const safeTrackName = escapeHtml(track.name);
    gutter.innerHTML = `
      <div class="track-meta">
        <span class="track-type-icon"><i data-lucide="${trackIcon}"></i></span>
        <span class="track-name">${safeTrackName}</span>
      </div>
      <div class="track-icons">
        <button class="track-action${isCaption ? '' : track.locked ? ' active' : ''}" data-track-action="${isCaption ? 'caption-add' : 'lock'}" title="${isCaption ? 'Add caption' : track.locked ? 'Unlock track' : 'Lock track'}" aria-label="${isCaption ? 'Add caption' : track.locked ? 'Unlock track' : 'Lock track'}" ${isCaption ? '' : `aria-pressed="${track.locked}"`}>
          <i data-lucide="${isCaption ? 'plus' : track.locked ? 'lock' : 'unlock'}"></i>
        </button>
        <button class="track-action${!track.visible ? ' active' : ''}" data-track-action="visibility" title="${track.visible ? 'Hide track' : 'Show track'}" aria-label="${track.visible ? 'Hide track' : 'Show track'}" aria-pressed="${!track.visible}">
          <i data-lucide="${track.visible ? 'eye' : 'eye-off'}"></i>
        </button>
        ${!isCaption ? `<button class="track-action${track.muted ? ' active' : ''}" data-track-action="mute" title="${track.muted ? 'Unmute track' : 'Mute track'}" aria-label="${track.muted ? 'Unmute track' : 'Mute track'}" aria-pressed="${track.muted}"><i data-lucide="${track.muted ? 'volume-x' : 'volume-2'}"></i></button>` : ''}
      </div>
    `;

    const lane = document.createElement('div');
    lane.className = 'track-lane';
    lane.style.width = `${tw}px`;
    lane.style.flex = `0 0 ${tw}px`;

    // Render clips in this track
    for (const clip of track.clips) {
      const meta = IKState.getClipMeta ? IKState.getClipMeta(clip.id) : null;
      const displayName = meta?.name || clip.source_id || `Clip ${clip.id}`;
      const safeDisplayName = escapeHtml(displayName);
      const el = document.createElement('div');
      const clipClass = track.track_type === 'audio' ? ' tl-clip-audio' : track.track_type === 'caption' ? ' tl-clip-caption' : ' tl-clip-video';
      el.className = `tl-clip${clipClass}`;
      el.dataset.clipId = String(clip.id);
      setClipDimensions(el, clip, dur, tw);

      if (track.track_type === 'caption') {
        const txt = (clip.caption_text || '').slice(0, 60);
        el.innerHTML = `<span class="tl-clip-label" style="display:flex;align-items:center;gap:4px;overflow:hidden;"><i data-lucide="type" style="width:10px;height:10px;flex-shrink:0;"></i> ${txt ? escapeHtml(txt) : '&lt;empty&gt;'}</span>`;
      } else if (track.track_type === 'video') {
        if (meta?.isReal && meta?.thumbnails && meta.thumbnails.length > 0) {
          const w = parseFloat(el.style.left || '0') + ((clip.timeline_end_us - clip.timeline_start_us) / 1_000_000 / dur) * tw;
          const count = Math.max(1, Math.floor(Math.max(1, parseFloat(el.style.width) || tw) / 60));
          let thumbs = '<div class="tl-clip-thumbs">';
          for (let j = 0; j < count; j++) {
            const idx = Math.min(Math.floor((j / count) * meta.thumbnails.length), meta.thumbnails.length - 1);
            thumbs += `<img src="${meta.thumbnails[idx].dataUrl}" draggable="false">`;
          }
          thumbs += '</div>';
          el.innerHTML = `${thumbs}<span class="tl-clip-label">${safeDisplayName}</span>`;
        } else if (meta?.picId) {
          const count = Math.max(1, Math.floor(Math.max(1, parseFloat(el.style.width) || tw) / 60));
          let thumbs = '<div class="tl-clip-thumbs">';
          for (let j = 0; j < count; j++)
            thumbs += `<img src="${picUrl(meta.picId, 100, 60)}" crossorigin="anonymous" draggable="false">`;
          thumbs += '</div>';
          el.innerHTML = `${thumbs}<span class="tl-clip-label">${safeDisplayName}</span>`;
        } else {
          el.innerHTML = `<span class="tl-clip-label" style="display:flex;align-items:center;gap:6px;"><i data-lucide="film" style="width:12px;height:12px;"></i> ${safeDisplayName}</span>`;
        }
      } else {
        const bars = Array.from({ length: Math.max(1, Math.floor(Math.max(1, parseFloat(el.style.width) || 100) / 4)) }, (_, i) => {
          const h = seededBarHeight(i);
          return `<rect x="${i * 4}" y="${20 - h / 2}" width="2.5" height="${Math.min(h, 38)}" fill="currentColor" opacity="0.8" rx="1"/>`;
        }).join('');
        el.innerHTML = `<div class="waveform"><svg viewBox="0 0 ${Math.max(1, parseFloat(el.style.width) || 100)} 40" preserveAspectRatio="none" style="width:100%;height:100%;display:block;">${bars}</svg></div><span class="tl-clip-label" style="position:absolute;bottom:6px;left:8px;">${safeDisplayName}</span>`;
      }
      appendClipDuration(el, clip);
      applyDragLogic(el, clip, track.clips, tw);
      lane.appendChild(el);
    }

      if (track.clips.length === 0 && track.track_type === 'video') {
        lane.innerHTML = '<div class="empty-hint" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:11px;opacity:0.6;pointer-events:none;">Drop video here</div>';
      }
      if (track.clips.length === 0 && track.track_type === 'caption') {
        lane.innerHTML = '<div class="empty-hint" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:11px;opacity:0.6;pointer-events:none;">Click + to add a caption</div>';
      }

    trackEl.appendChild(gutter);
    trackEl.appendChild(lane);
    tlTracks.appendChild(trackEl);
  }

  // Ensure the ai-track is visible but at the top
  const aiTrack = tlTracks.querySelector('.track.ai-track');
  if (aiTrack && tlTracks.firstChild !== aiTrack) {
    tlTracks.insertBefore(aiTrack, tlTracks.firstChild);
  }
  const aiLane = $('#lane-ai');
  if (aiLane) {
    aiLane.style.width = `${tw}px`;
    aiLane.style.flex = `0 0 ${tw}px`;
  }

  window.lucide.createIcons({ nodes: [tlTracks] });

  // Spacer for scroll width
  const existingSpacer = tlTracks.querySelector('.tl-spacer');
  if (existingSpacer) existingSpacer.remove();
  const spacer = document.createElement('div');
  spacer.className = 'tl-spacer';
  spacer.style.cssText = `width:${tw}px;height:0;pointer-events:none;`;
  tlTracks.appendChild(spacer);
}
window.renderClips = renderClips;

function fmtTime(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * 30);
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

export function updatePlayhead() {
  const tw = getLaneW();
  const dur = S.dur;
  if (dur <= 0) return;
  const px = (S.time / dur) * tw;
  const scrollLeft = $('#tl-tracks')?.scrollLeft ?? 0;
  const timelineLeft = getTimelineLaneOffset();
  const phTracks = $('#ph-tracks');
  if (phTracks) phTracks.style.left = timelineLeft + px - scrollLeft + 'px';
  const timecode = $('#timecode');
  if (timecode) timecode.textContent = fmtTime(S.time);
  const playheadTime = $('#playhead-time');
  if (playheadTime) playheadTime.textContent = fmtTime(S.time);
}
window.updatePlayhead = updatePlayhead;

function refreshTimelineScale() {
  const zoomText = $('#zoom-text');
  if (zoomText) zoomText.textContent = Math.round(S.zoom * 100) + '%';
  renderRuler();
  renderClips();
  updatePlayhead();
}

export function initTimelineUI() {
  const tlBody = $('#tl-body');
  if (tlBody) {
    tlBody.addEventListener('wheel', (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault();
        S.zoom = Math.max(0.5, Math.min(50, S.zoom + (e.deltaY > 0 ? -0.1 : 0.1)));
        refreshTimelineScale();
      }
    }, { passive: false });
  }

  $('#zoom-in')?.addEventListener('click', () => {
    S.zoom = Math.min(50, S.zoom + 0.25);
    refreshTimelineScale();
  });

  $('#zoom-out')?.addEventListener('click', () => {
    S.zoom = Math.max(0.5, S.zoom - 0.25);
    refreshTimelineScale();
  });

  $('#zoom-fit')?.addEventListener('click', () => {
    S.zoom = 1;
    refreshTimelineScale();
  });

  const tlTracks = $('#tl-tracks');
  if (tlTracks) {
    tlTracks.addEventListener('scroll', () => {
      const rw = document.querySelector('.tl-ruler-wrapper');
      if (rw) rw.scrollLeft = tlTracks.scrollLeft;
      updatePlayhead();
    });
  }

  let resizeFrame: number | null = null;
  window.addEventListener('resize', () => {
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      refreshTimelineScale();
    });
  });

  const handle = $('#tl-resize-handle');
  if (handle) {
    const panel = document.querySelector('.panel-timeline') as HTMLElement;
    if (panel) {
      let isResizing = false;
      let startY = 0;
      let startHeight = 0;
      handle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = panel.offsetHeight;
        document.body.style.cursor = 'ns-resize';
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const dy = e.clientY - startY;
        const newHeight = Math.max(120, Math.min(window.innerHeight * 0.5, startHeight - dy));
        panel.style.height = newHeight + 'px';
        S.timelineHeight = newHeight;
      });
      document.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          document.body.style.cursor = '';
        }
      });
    }
  }

  $$('.tl-tool').forEach((btn) => {
    (btn as HTMLElement).onclick = () => {
      $$('.tl-tool').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      S.tool = (btn as HTMLElement).dataset.tool!;
    };
  });

  // Track controls use delegation because tracks are rebuilt after every edit.
  document.addEventListener('click', (e) => {
    const control = (e.target as Element).closest('.track-action') as HTMLButtonElement | null;
    if (!control) return;
    const trackEl = control.closest('[data-track-id]') as HTMLElement;
    if (!trackEl) return;
    const trackId = parseInt(trackEl.dataset.trackId!);
    if (isNaN(trackId)) return;
    const IKState = (window as any).IKState;
    const icon = control.querySelector('svg');
    const action = control.dataset.trackAction;

    if (action === 'lock' && icon) {
      control.classList.toggle('active');
      const isLocked = control.classList.contains('active');
      control.setAttribute('aria-pressed', String(isLocked));
      control.title = isLocked ? 'Unlock track' : 'Lock track';
      control.setAttribute('aria-label', control.title);
      icon.setAttribute('data-lucide', isLocked ? 'lock' : 'unlock');
      window.lucide.createIcons({ nodes: [icon] });
      IKState.setTrackProp(trackId, 'locked', isLocked);
      showToast(isLocked ? 'Track locked' : 'Track unlocked', isLocked ? 'lock' : 'unlock');
    } else if (action === 'visibility' && icon) {
      control.classList.toggle('active');
      const isVisible = !control.classList.contains('active');
      control.setAttribute('aria-pressed', String(!isVisible));
      control.title = isVisible ? 'Hide track' : 'Show track';
      control.setAttribute('aria-label', control.title);
      icon.setAttribute('data-lucide', isVisible ? 'eye' : 'eye-off');
      window.lucide.createIcons({ nodes: [icon] });
      IKState.setTrackProp(trackId, 'visible', isVisible);
      showToast(isVisible ? 'Track visible' : 'Track hidden', isVisible ? 'eye' : 'eye-off');
    } else if (action === 'mute' && icon) {
      control.classList.toggle('active');
      const isMuted = control.classList.contains('active');
      control.setAttribute('aria-pressed', String(isMuted));
      control.title = isMuted ? 'Unmute track' : 'Mute track';
      control.setAttribute('aria-label', control.title);
      icon.setAttribute('data-lucide', isMuted ? 'volume-x' : 'volume-2');
      window.lucide.createIcons({ nodes: [icon] });
      IKState.setTrackProp(trackId, 'muted', isMuted);
      showToast(isMuted ? 'Track muted' : 'Track unmuted', isMuted ? 'volume-x' : 'volume-2');
    } else if (action === 'caption-add') {
      addCaptionAtPlayhead();
    }
  });

  // Add track buttons
  $('#add-video-track')?.addEventListener('click', () => {
    const IKState = (window as any).IKState;
    if (!IKState || !IKState.isReady()) return;
    saveSnapshot();
    IKState.addTrack('video');
    window.dispatchEvent(new CustomEvent('ikl:reRender'));
    showToast('Video track added', 'plus');
  });
  $('#add-audio-track')?.addEventListener('click', () => {
    const IKState = (window as any).IKState;
    if (!IKState || !IKState.isReady()) return;
    saveSnapshot();
    IKState.addTrack('audio');
    window.dispatchEvent(new CustomEvent('ikl:reRender'));
    showToast('Audio track added', 'plus');
  });
  $('#add-caption-track')?.addEventListener('click', () => {
    const IKState = (window as any).IKState;
    if (!IKState || !IKState.isReady()) return;
    saveSnapshot();
    IKState.addTrack('caption');
    window.dispatchEvent(new CustomEvent('ikl:reRender'));
    showToast('Caption track added', 'plus');
  });

  initTimelineDrop();
}

function initTimelineDrop() {
  const tlTracks = $('#tl-tracks');
  if (!tlTracks) return;

  tlTracks.addEventListener('dragover', (e: Event) => {
    const ev = e as DragEvent;
    ev.preventDefault();
    const lane = (ev.target as HTMLElement).closest('.track-lane');
    if (!lane) return;
    const tw = getLaneW();
    const rect = lane.getBoundingClientRect();
    const cursorPx = ev.clientX - rect.left + tlTracks.scrollLeft;
    const rawUs = Math.round((cursorPx / tw) * S.dur * 1_000_000);
    const snapped = cursorPx <= 24 ? 0 : applySnap(rawUs, null, tw);
    if (snapped !== null) showSnapGuide(snapped, tw);
    else hideSnapGuide();
  });

  tlTracks.addEventListener('dragleave', () => hideSnapGuide());

  tlTracks.addEventListener('drop', (e: Event) => {
    const ev = e as DragEvent;
    ev.preventDefault();
    hideSnapGuide();
    const IKState = (window as any).IKState;
    if (!IKState) return;
    const lane = (ev.target as HTMLElement).closest('.track-lane');
    if (!lane) return;
    const trackEl = lane.closest('[data-track-id]') as HTMLElement;
    if (!trackEl) return;
    const trackId = parseInt(trackEl.dataset.trackId!);
    if (isNaN(trackId)) return;
    const tw = getLaneW();
    const rect = lane.getBoundingClientRect();
    const cursorPx = ev.clientX - rect.left + tlTracks.scrollLeft;
    const rawUs = Math.round((cursorPx / tw) * S.dur * 1_000_000);
    const snapped = cursorPx <= 24 ? 0 : applySnap(rawUs, null, tw);
    const startUs = Math.max(0, snapped !== null ? snapped : rawUs);
    const data = JSON.parse(ev.dataTransfer!.getData('text/plain'));
    saveSnapshot();
    if (data.isReal && data.sourceId) {
      const durSec = parseFloat(data.dur) || 4.0;
      const endUs = Math.round(startUs + durSec * 1_000_000);
      IKState.addClip(trackId, data.sourceId, startUs, endUs, { name: data.name, isReal: true }, `group_${Date.now()}`);
      showToast('Clip added to timeline', 'film');
    } else {
      const endUs = startUs + 4_000_000;
      IKState.addClip(trackId, 'stock_' + data.id, startUs, endUs, { name: data.name, isReal: false, picId: data.picId || 0 });
      showToast('Stock Inserted', 'film');
    }
    reRender();
  });
}

// ── AI Actions ──────────────────────────────────────────────────────────
let acts = { trim: false, cap: false, sync: false };
function resetAiActions() {
  acts = { trim: false, cap: false, sync: false };
}
window.resetAiActions = resetAiActions;

// fallow-ignore-next-line complexity
export function applyAiAction(type: 'silence' | 'captions' | 'sync') {
  const IKState = (window as any).IKState;
  const videoClips = IKState?.getVideoClips() || [];
  if (type === 'silence' && !acts.trim) {
    saveSnapshot();
    if (videoClips.length === 1 && videoClips[0].isReal) {
      const clip = videoClips[0];
      const startUs = clip.timeline_start_us;
      const origDurUs = clip.timeline_end_us - clip.timeline_start_us;
      const trimmedDurUs = Math.round(origDurUs * 0.92);
      IKState.trimClip(clip.id, startUs, startUs + trimmedDurUs, clip.source_start_us);
      const trimmedDurSec = us2s(trimmedDurUs);
      aiNodes.push({ time: trimmedDurSec, label: 'Silence Trimmed', icon: 'scissors' });
      $('#insight-score')!.textContent = '93';
      $('#insight-bar')!.style.width = '93%';
      $('#insight-box')!.classList.add('optimized');
      showToast('AI Smart Trim Applied', 'scissors');
      acts.trim = true;
    } else if (videoClips.length >= 2) {
      const firstStartSec = us2s(videoClips[0].timeline_start_us);
      let cursorUs = videoClips[0].timeline_end_us;
      for (let i = 1; i < videoClips.length; i++) {
        const clip = videoClips[i];
        if (clip.timeline_start_us > cursorUs) IKState.moveClip(clip.id, cursorUs);
        cursorUs = clip.timeline_end_us;
      }
      IKState.computeDuration();
      aiNodes.push({ time: firstStartSec, label: 'Gaps Trimmed', icon: 'scissors' });
      $('#insight-score')!.textContent = '96';
      $('#insight-bar')!.style.width = '96%';
      $('#insight-box')!.classList.add('optimized');
      showToast('AI Smart Trim Applied', 'scissors');
      acts.trim = true;
    } else {
      showToast('Import a video first', 'info');
      return;
    }
  } else if (type === 'captions' && !acts.cap) {
    if (videoClips.length === 0) { showToast('Import a video first', 'info'); return; }
    aiNodes.push({ time: Math.min(2.0, S.dur * 0.1), label: 'Captions Generated', icon: 'captions' });
    aiNodes.push({ time: Math.min(10.0, S.dur * 0.5), label: 'Captions Synced', icon: 'captions' });
    showToast('AI Captions Added', 'captions');
    const capOverlay = $('#caption-overlay');
    if (capOverlay) capOverlay.style.display = 'block';
    acts.cap = true;
  } else if (type === 'sync' && !acts.sync) {
    if (videoClips.length === 0) { showToast('Import a video first', 'info'); return; }
    const dur = S.dur;
    aiNodes.push({ time: dur * 0.25, label: 'Beat Match', icon: 'zap' });
    aiNodes.push({ time: dur * 0.6, label: 'Bass Drop', icon: 'zap' });
    showToast('Rhythm Sync Complete', 'zap');
    acts.sync = true;
  } else {
    showToast('Action already applied!', 'check');
    return;
  }
  calculateTimelineDuration();
  reRender();
}
window.applyAiAction = applyAiAction;

// ── Legacy renderClips (backward compat for tests using old API) ──────
function renderClipsLegacy(IKState: any) {
  const laneV1 = $('#lane-v1');
  const laneA1 = $('#lane-a1');
  if (!laneV1 || !laneA1) return;

  laneV1.innerHTML = '';
  laneA1.innerHTML = '';
  const tw = getLaneW();
  const dur = S.dur;
  if (dur <= 0) return;

  const videoClips = IKState.getVideoClips();
  const audioClips = IKState.getAudioClips();

  if (videoClips.length === 0) {
    laneV1.innerHTML =
      '<div class="empty-hint" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:11px;opacity:0.6;pointer-events:none;">Drop video here</div>';
  }

  const clipGroups = new Map<string, { video: any; audio: any }>();
  videoClips.forEach((clip: any) => {
    clipGroups.set(clip.group_id || `group_${clip.id}`, { video: clip, audio: null });
  });
  audioClips.forEach((clip: any) => {
    const gid = clip.group_id || `group_${clip.id}`;
    if (!clipGroups.has(gid)) clipGroups.set(gid, { video: null, audio: null });
    clipGroups.get(gid)!.audio = clip;
  });

  clipGroups.forEach((group) => {
    const clip = group.video || group.audio;
    if (!clip) return;
    const el = document.createElement('div');
    el.className = 'tl-clip';
    el.dataset.clipId = clip.id;
    const w = setClipDimensions(el, clip, dur, tw);
    let content = '';
    if (group.video) {
      if (group.video.isReal && group.video.thumbnails?.length > 0) {
        const count = Math.max(1, Math.floor(w / 60));
        let thumbs = '<div class="tl-clip-thumbs">';
        for (let j = 0; j < count; j++) {
          const idx = Math.min(Math.floor((j / count) * group.video.thumbnails.length), group.video.thumbnails.length - 1);
          thumbs += `<img src="${group.video.thumbnails[idx].dataUrl}" draggable="false">`;
        }
        thumbs += '</div>';
        content += `${thumbs}<span class="tl-clip-label">${escapeHtml(group.video.name)}</span>`;
      } else if (group.video.isReal) {
        content += `<span class="tl-clip-label" style="display:flex;align-items:center;gap:6px;"><i data-lucide="film" style="width:12px;height:12px;"></i> ${escapeHtml(group.video.name)}</span>`;
      } else if (group.video.picId) {
        const count = Math.max(1, Math.floor(w / 60));
        let thumbs = '<div class="tl-clip-thumbs">';
        for (let j = 0; j < count; j++)
          thumbs += `<img src="${picUrl(group.video.picId, 100, 60)}" crossorigin="anonymous" draggable="false">`;
        thumbs += '</div>';
        content += `${thumbs}<span class="tl-clip-label">${escapeHtml(group.video.name)}</span>`;
      } else {
        content += `<span class="tl-clip-label">${escapeHtml(group.video.name)}</span>`;
      }
    }
    el.innerHTML = content;
    applyDragLogic(el, clip, [clip], tw);
    laneV1.appendChild(el);
  });

  const standaloneAudio = audioClips.filter((clip: any) => !clip.group_id || !clipGroups.get(clip.group_id)?.video);
  if (standaloneAudio.length === 0) {
    laneA1.innerHTML = '<div class="empty-hint" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:11px;opacity:0.6;pointer-events:none;">Audio track (MP3 only)</div>';
  }
  standaloneAudio.forEach((clip: any) => {
    const el = document.createElement('div');
    el.className = 'tl-clip tl-clip-audio';
    el.dataset.clipId = clip.id;
    const w = setClipDimensions(el, clip, dur, tw);
    const bars = Array.from({ length: Math.max(1, Math.floor(w / 4)) }, (_, i) => ({
      h: (() => { let x = ((i * 2654435761) >>> 0) & 0xff; return 10 + (x % 28); })(),
    }));
    const svgContent = bars.map((b, i) => `<rect x="${i * 4}" y="${20 - b.h / 2}" width="2.5" height="${Math.min(b.h, 38)}" fill="currentColor" opacity="0.8" rx="1"/>`).join('');
    el.innerHTML = `<div class="waveform"><svg viewBox="0 0 ${Math.max(1, w)} 40" preserveAspectRatio="none" style="width:100%;height:100%;display:block;">${svgContent}</svg></div><span class="tl-clip-label" style="position:absolute;bottom:6px;left:8px;">${escapeHtml(clip.name)}</span>`;
    applyDragLogic(el, clip, standaloneAudio, tw);
    laneA1.appendChild(el);
  });

  const laneAi = $('#lane-ai');
  if (laneAi) {
    laneAi.innerHTML = '';
    aiNodes.forEach((node: any) => {
      const el = document.createElement('div');
      el.className = 'ai-node';
      el.style.left = (node.time / dur) * tw + 'px';
      const safeIcon = /^[a-z0-9-]+$/i.test(node.icon) ? node.icon : 'sparkles';
      el.innerHTML = `<i data-lucide="${safeIcon}"></i> ${escapeHtml(node.label)}`;
      laneAi.appendChild(el);
    });
  }

  laneV1.appendChild((() => { const s = document.createElement('div'); s.style.cssText = `width:${tw}px;height:0;pointer-events:none;`; return s; })());
  laneA1.appendChild((() => { const s = document.createElement('div'); s.style.cssText = `width:${tw}px;height:0;pointer-events:none;`; return s; })());
  if (laneAi) laneAi.appendChild((() => { const s = document.createElement('div'); s.style.cssText = `width:${tw}px;height:0;pointer-events:none;`; return s; })());
}
