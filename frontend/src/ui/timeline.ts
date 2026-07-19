import { applySnap, showSnapGuide, hideSnapGuide, getLaneW } from './timelineUtils';

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
import { picUrl, showToast } from './utils';
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

let _laneRefW = 0;
function autoFitZoom() {
  if (S.dur <= 0) return;
  if (_laneRefW <= 1) {
    const lane = $('#lane-v1');
    if (!lane) return;
    const prevW = lane.style.width;
    lane.style.width = '';
    _laneRefW = lane.getBoundingClientRect().width;
    lane.style.width = prevW;
  }
  if (_laneRefW <= 0) return;
  const minPxPerSec = 20;
  S.zoom = Math.max(0.5, (minPxPerSec * S.dur) / _laneRefW);
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

  for (let s = 0; s <= dur; s += interval) {
    const tick = document.createElement('div');
    tick.className = 'ruler-tick';
    tick.style.left = (s / dur) * tw + 'px';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const label = m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}s`;
    tick.innerHTML = `<div class="tick-line major"></div><span class="tick-label">${label}</span>`;
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

export function renderClips() {
  const IKState = (window as any).IKState;
  if (!IKState) return;
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
    const groupId = clip.group_id || `group_${clip.id}`;
    clipGroups.set(groupId, { video: clip, audio: null });
  });

  audioClips.forEach((clip: any) => {
    const groupId = clip.group_id || `group_${clip.id}`;
    if (!clipGroups.has(groupId)) clipGroups.set(groupId, { video: null, audio: null });
    clipGroups.get(groupId)!.audio = clip;
  });

  // fallow-ignore-next-line complexity
  clipGroups.forEach((group) => {
    const clip = group.video || group.audio;
    if (!clip) return;

    const el = document.createElement('div');
    el.className = 'tl-clip';
    el.dataset.clipId = clip.id;
    const w = setClipDimensions(el, clip, dur, tw);

    let content = '';

    if (group.video) {
      const videoClip = group.video;
      if (videoClip.isReal && videoClip.thumbnails && videoClip.thumbnails.length > 0) {
        const count = Math.max(1, Math.floor(w / 60));
        let thumbs = '<div class="tl-clip-thumbs">';
        for (let j = 0; j < count; j++) {
          const idx = Math.min(
            Math.floor((j / count) * videoClip.thumbnails.length),
            videoClip.thumbnails.length - 1
          );
          thumbs += `<img src="${videoClip.thumbnails[idx].dataUrl}" draggable="false">`;
        }
        thumbs += '</div>';
        content += `${thumbs}<span class="tl-clip-label">${videoClip.name}</span>`;
      } else if (videoClip.isReal) {
        content += `<span class="tl-clip-label" style="display:flex;align-items:center;gap:6px;"><i data-lucide="film" style="width:12px;height:12px;"></i> ${videoClip.name}</span>`;
      } else if (videoClip.picId) {
        const count = Math.max(1, Math.floor(w / 60));
        let thumbs = '<div class="tl-clip-thumbs">';
        for (let j = 0; j < count; j++)
          thumbs += `<img src="${picUrl(videoClip.picId, 100, 60)}" crossorigin="anonymous" draggable="false">`;
        thumbs += '</div>';
        content += `${thumbs}<span class="tl-clip-label">${videoClip.name}</span>`;
      } else {
        content += `<span class="tl-clip-label">${videoClip.name}</span>`;
      }
    }

    el.innerHTML = content;
    applyDragLogic(el, clip, [clip], tw);
    laneV1.appendChild(el);
  });

  // Clips whose group_id is null (most audio clips) were never added to
  // clipGroups, so clipGroups.get(null) returns undefined — guard against that
  // and treat null-group audio clips as standalone (no linked video).
  const standaloneAudio = audioClips.filter((clip: any) => {
    if (!clip.group_id) return true;          // null / empty → standalone
    const group = clipGroups.get(clip.group_id);
    return group && !group.video;
  });

  if (standaloneAudio.length === 0) {
    laneA1.innerHTML =
      '<div class="empty-hint" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:11px;opacity:0.6;pointer-events:none;">Audio track (MP3 only)</div>';
  }

  standaloneAudio.forEach((clip: any) => {
    const el = document.createElement('div');
    el.className = 'tl-clip tl-clip-audio';
    el.dataset.clipId = clip.id;
    const w = setClipDimensions(el, clip, dur, tw);
    const bars = Array.from({ length: Math.max(1, Math.floor(w / 4)) }, (_, i) => {
      const h = seededBarHeight(i);
      return `<rect x="${i * 4}" y="${20 - h / 2}" width="2.5" height="${Math.min(h, 38)}" fill="currentColor" opacity="0.8" rx="1"/>`;
    }).join('');
    el.innerHTML = `<div class="waveform"><svg viewBox="0 0 ${Math.max(1, w)} 40" preserveAspectRatio="none" style="width:100%;height:100%;display:block;">${bars}</svg></div><span class="tl-clip-label" style="position:absolute;bottom:6px;left:8px;">${clip.name}</span>`;
    applyDragLogic(el, clip, standaloneAudio, tw);
    laneA1.appendChild(el);
  });

  const laneAi = $('#lane-ai');
  if (laneAi) {
    laneAi.innerHTML = '';
    aiNodes.forEach((node) => {
      const el = document.createElement('div');
      el.className = 'ai-node';
      el.style.left = (node.time / dur) * tw + 'px';
      el.innerHTML = `<i data-lucide="${node.icon}"></i> ${node.label}`;
      el.onclick = () => showToast('AI Insight: ' + node.label, node.icon);
      laneAi.appendChild(el);
    });
  }

  window.lucide.createIcons({ nodes: [$('#lane-ai'), laneV1, laneA1] });

  const spacer = (width: number) => {
    const s = document.createElement('div');
    s.style.cssText = `width:${width}px;height:0;pointer-events:none;`;
    return s;
  };
  laneV1.appendChild(spacer(tw));
  if (laneA1 !== laneV1) laneA1.appendChild(spacer(tw));
  if (laneAi) laneAi.appendChild(spacer(tw));
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
  const gutterWidth = 100;
  const phTracks = $('#ph-tracks');
  if (phTracks) phTracks.style.left = gutterWidth + px + 'px';
  const timecode = $('#timecode');
  if (timecode) timecode.textContent = fmtTime(S.time);
}
window.updatePlayhead = updatePlayhead;

export function initTimelineUI() {
  const tlBody = $('#tl-body');
  if (tlBody) {
    tlBody.addEventListener('wheel', (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault();
        S.zoom = Math.max(0.5, Math.min(50, S.zoom + (e.deltaY > 0 ? -0.1 : 0.1)));
        const zt = $('#zoom-text');
        if (zt) zt.textContent = Math.round(S.zoom * 100) + '%';
        renderRuler();
        renderClips();
        updatePlayhead();
      }
    }, { passive: false });
  }

  $('#zoom-in')?.addEventListener('click', () => {
    S.zoom = Math.min(50, S.zoom + 0.25);
    const zt = $('#zoom-text');
    if (zt) zt.textContent = Math.round(S.zoom * 100) + '%';
    renderRuler();
    renderClips();
    updatePlayhead();
  });

  $('#zoom-out')?.addEventListener('click', () => {
    S.zoom = Math.max(0.5, S.zoom - 0.25);
    const zt = $('#zoom-text');
    if (zt) zt.textContent = Math.round(S.zoom * 100) + '%';
    renderRuler();
    renderClips();
    updatePlayhead();
  });

  const tlTracks = $('#tl-tracks');
  if (tlTracks) {
    tlTracks.addEventListener('scroll', () => {
      const rw = document.querySelector('.tl-ruler-wrapper');
      if (rw) rw.scrollLeft = tlTracks.scrollLeft;
    });
  }

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

  // Track icons logic — toggles CSS AND writes to IKState so compositor/audio respect them.
  // fallow-ignore-next-line complexity
  document.addEventListener('click', (e) => {
    const icon = (e.target as Element).closest('.track-icons svg');
    if (!icon) return;
    const trackEl = icon.closest('.track') as HTMLElement;
    if (!trackEl) return;

    // Map HTML data-track-id to IKState numeric track id (0 = video, 1 = audio)
    const trackDataId = trackEl.dataset.trackId;
    const trackId = trackDataId === 'v1' ? 0 : trackDataId === 'a1' ? 1 : null;
    const IKState = (window as any).IKState;

    const iconType = icon.getAttribute('data-lucide');
    if (iconType === 'lock' || iconType === 'unlock') {
      icon.classList.toggle('active');
      const isLocked = icon.classList.contains('active');
      icon.setAttribute('data-lucide', isLocked ? 'lock' : 'unlock');
      window.lucide.createIcons({ nodes: [icon] });
      if (trackId !== null && IKState) IKState.setTrackProp(trackId, 'locked', isLocked);
      showToast(isLocked ? 'Track locked' : 'Track unlocked', isLocked ? 'lock' : 'unlock');
    } else if (iconType === 'eye' || iconType === 'eye-off') {
      icon.classList.toggle('active');
      const isVisible = !icon.classList.contains('active');
      icon.setAttribute('data-lucide', isVisible ? 'eye' : 'eye-off');
      window.lucide.createIcons({ nodes: [icon] });
      if (trackId !== null && IKState) IKState.setTrackProp(trackId, 'visible', isVisible);
      window.dispatchEvent(new CustomEvent('ikl:reRender'));
      showToast(isVisible ? 'Track visible' : 'Track hidden', isVisible ? 'eye' : 'eye-off');
    } else if (iconType === 'volume-2' || iconType === 'volume-x') {
      icon.classList.toggle('active');
      const isMuted = icon.classList.contains('active');
      icon.setAttribute('data-lucide', isMuted ? 'volume-x' : 'volume-2');
      window.lucide.createIcons({ nodes: [icon] });
      if (trackId !== null && IKState) IKState.setTrackProp(trackId, 'muted', isMuted);
      window.dispatchEvent(new CustomEvent('ikl:reRender'));
      showToast(isMuted ? 'Track muted' : 'Track unmuted', isMuted ? 'volume-x' : 'volume-2');
    }
  });

  initTimelineDrop();
}

function initTimelineDrop() {
  const laneV1 = $('#lane-v1');
  if (!laneV1) return;
  laneV1.ondragover = (e) => {
    e.preventDefault();
    const tw = getLaneW();
    const rect = laneV1.getBoundingClientRect();
    const cursorPx = e.clientX - rect.left + $('#tl-tracks')!.scrollLeft;
    const rawUs = Math.round((cursorPx / tw) * S.dur * 1_000_000);
    const snapped = cursorPx <= 24 ? 0 : applySnap(rawUs, null, tw);
    if (snapped !== null) showSnapGuide(snapped, tw);
    else hideSnapGuide();
  };
  laneV1.ondragleave = () => hideSnapGuide();
  laneV1.ondrop = (e) => {
    e.preventDefault();
    hideSnapGuide();
    const IKState = (window as any).IKState;
    if (!IKState) return;
    const data = JSON.parse(e.dataTransfer!.getData('text/plain'));
    const tw = getLaneW();
    const rect = laneV1.getBoundingClientRect();
    const cursorPx = e.clientX - rect.left + $('#tl-tracks')!.scrollLeft;
    const rawUs = Math.round((cursorPx / tw) * S.dur * 1_000_000);
    const snapped = cursorPx <= 24 ? 0 : applySnap(rawUs, null, tw);
    const startUs = Math.max(0, snapped !== null ? snapped : rawUs);
    saveSnapshot();
    if (data.isReal && data.sourceId) {
      const durSec = parseFloat(data.dur) || 4.0;
      const neededDurSec = startUs / 1_000_000 + durSec;
      if (neededDurSec > S.dur) S.dur = neededDurSec + 10;
      const endUs = Math.round(startUs + durSec * 1_000_000);
      IKState.addVideoClip(data.sourceId, startUs, endUs, {
        name: data.name,
        isReal: true,
      }, `group_${Date.now()}`);
      showToast('Clip added to timeline', 'film');
    } else {
      const endUs = startUs + 4_000_000;
      IKState.addVideoClip('stock_' + data.id, startUs, endUs, {
        name: data.name,
        isReal: false,
        picId: data.picId || 0,
      });
      showToast('Stock Inserted', 'film');
    }
    reRender();
  };
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
    $('#canvas-text')?.classList.add('active');
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
