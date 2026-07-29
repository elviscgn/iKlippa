/**
 * iKlippa — main.ts
 * Entry point. Ported from app.js to TypeScript.
 * Hooks up UI events ↔ engine, initialises IKState.
 */

// Import state first (attaches to window.IKState, sets up videoClips/audioClips)
import './state/state';
import './ui/index';
import {
  MEDIA_DRAG_MIME,
  materializeMediaPayload,
  parseMediaDuration,
} from './ui/mediaPool';

import {
  initEngine,
  importFile,
  togglePlayback,
  seekTo,
  setColorGrade,
  setPerClipGrade,
  syncAllTrackAudio,
  exportVideo,
  perf,
  syncTimelineToRust,
  registerExternalAudio,
} from './engine/engine';
import { loadStoredSourceFiles, requestDurableStorage } from './media/mediaStore';
import { getRegisteredSourceFile } from './media/sourceRegistry';
import {
  generateVideoThumbnails,
  pickPosterThumbnail,
} from './media/videoThumbnails';
import { registerAppShell } from './offline/appShell';

import type { EngineError, GradeParams } from './engine/types';
import { USER_ERROR_MESSAGES, emitLocal } from './engine/errors';
import { initCaptionOverlay, renderCaptionOverlay } from './ui/captions';
import { reflectClipEffects } from './ui/lut';

// Import CSS so Vite bundles it
import '../styles.css';

const canvasEl = document.getElementById('canvas-img') as HTMLCanvasElement;
const dropOverlay = document.getElementById('drop-overlay') as HTMLDivElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const statusBadge = document.querySelector('.status-badge') as HTMLElement;
const scoreValue = document.getElementById('score-value') as HTMLElement;

let hasRealVideo = false;
void registerAppShell();

function setStatusBadge(icon: string, message: string): void {
  if (!statusBadge) return;
  const safeIcon = /^[a-z0-9-]+$/i.test(icon) ? icon : 'zap';
  const iconEl = document.createElement('i');
  iconEl.dataset.lucide = safeIcon;
  statusBadge.replaceChildren(iconEl, document.createTextNode(' ' + message));
  window.lucide?.createIcons({ nodes: [statusBadge] });
}

// ── Engine Status to UI ─────────────────────────────────────────────────
window.onEngineStatus = (msg: string): void => {
  setStatusBadge('zap', msg);
  window.showToast(msg, 'zap');
};

// ── Engine Errors to UI ─────────────────────────────────────────────────
// The visible end of the error boundary: every failure in either thread
// lands here as a toast. Full technical detail stays in the console.
window.onEngineError = (e: EngineError): void => {
  console.error(`[iKlippa:error] ${e.code}${e.fatal ? ' (fatal)' : ''}`, e.detail ?? e.message);
  const friendly = USER_ERROR_MESSAGES[e.code] ?? 'Something went wrong';
  window.showToast(
    e.fatal ? `${friendly} — please re-import the file` : friendly,
    'alert-triangle',
  );
  if (e.fatal) {
    setStatusBadge('alert-triangle', friendly);
  }
};

// ── Playhead updates: Engine → UI ───────────────────────────────────────
window.onPlayheadUpdate = (ms: number): void => {
  window.S.time = ms / 1000;
  window.updatePlayhead();
  renderCaptionOverlay(ms);
};

// ── Thumbnail updates: debounced re-render ──────────────────────────────
let thumbnailRenderDebounce: ReturnType<typeof setTimeout> | null = null;
// fallow-ignore-next-line complexity
window.onThumbnailsUpdated = (sourceId, thumbnails): void => {
  if (!hasRealVideo) return;
  const mediaItem = window.mediaPool.footage.find((item) => item.id === sourceId);
  if (mediaItem) mediaItem.thumbnails = thumbnails;
  // Don't re-render DOM during playback — it causes flicker
  const allClips = window.IKState.getAllVideoClips ? window.IKState.getAllVideoClips() : window.IKState.getVideoClips();
  for (const clip of allClips) {
    if (clip.isReal && clip.source_id === sourceId) {
      window.IKState.setClipMeta(clip.id, { thumbnails });
    }
  }
  if (window.S && window.S.playing) return;
  if (thumbnailRenderDebounce) clearTimeout(thumbnailRenderDebounce);
  thumbnailRenderDebounce = setTimeout(() => {
    window.renderClips();
  }, 600);
};

// ── Import complete: build project model + sync to Rust ─────────────────
let _restoredFromStorage = false;
const _restoringCachedSourceIds = new Set<string>();

function remapStaleSources(newSourceId: string): void {
  const IKState = window.IKState;
  if (!IKState || !IKState.isReady()) return;
  const project = IKState.getProject();
  if (!project) return;
  let remapped = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.source_id && clip.source_id.startsWith('imported_') && clip.source_id !== newSourceId) {
        clip.source_id = newSourceId;
        remapped++;
      }
    }
  }
  if (remapped > 0) {
    console.log(`[iKlippa:app] Remapped ${remapped} clips to new source "${newSourceId}"`);
    window.showToast(`Project restored — ${remapped} clip(s) linked to imported media`, 'link');
    window.calculateTimelineDuration();
    window.renderRuler();
    window.renderClips();
  }
}

window.onClipImported = async ({ width, height, durationMs, fileName, sourceId }): Promise<void> => {
  hasRealVideo = true;
  const durationSec = durationMs / 1000;
  const displayName = fileName || 'Imported Video';
  console.log(
    `[iKlippa:app] onClipImported: "${displayName}" ${width}×${height} ${durationSec.toFixed(2)}s [${sourceId}]`,
  );

  if (!window.IKState.isReady()) {
    window.IKState.init(width, height);
    console.log('[iKlippa:app] IKState initialised');
  }

  const existingMedia = window.mediaPool.footage.find((item) => item.id === sourceId);
  if (existingMedia) {
    Object.assign(existingMedia, {
      name: displayName,
      isReal: true,
      dur: durationSec.toFixed(1) + 's',
      width,
      height,
    });
  } else {
    window.mediaPool.footage.push({
      id: sourceId,
      name: displayName,
      isReal: true,
      dur: durationSec.toFixed(1) + 's',
      thumbDataUrl: null,
      width,
      height,
    });
  }
  const activeMediaTab = document.querySelector('.media-tab.active') as HTMLElement | null;
  if (!activeMediaTab || activeMediaTab.dataset.tab === 'footage') {
    window.renderMedia('footage');
  }
  window.calculateTimelineDuration();
  window.renderRuler();
  window.renderClips();
  window.showToast(`Clip loaded (${width}×${height})`, 'film');

  // If the project was restored (clips have stale source_ids from a previous
  // session), remap them to the newly imported source.
  if (_restoringCachedSourceIds.delete(sourceId)) {
    if (_restoringCachedSourceIds.size === 0) _restoredFromStorage = false;
  } else if (_restoredFromStorage) {
    remapStaleSources(sourceId);
    _restoredFromStorage = false;
  }

  const sourceFile = getRegisteredSourceFile(sourceId);
  if (sourceFile) {
    void generateVideoThumbnails(sourceFile, durationMs)
      .then((thumbnails) => {
        if (thumbnails.length === 0) return;
        const entry = window.mediaPool.footage.find((item) => item.id === sourceId);
        const poster = pickPosterThumbnail(thumbnails, durationMs);
        if (entry) {
          entry.thumbnails = thumbnails;
          entry.thumbDataUrl = poster?.dataUrl ?? null;
        }
        window.onThumbnailsUpdated?.(sourceId, thumbnails);
        autoSave();
        const activeTab = document.querySelector('.media-tab.active') as HTMLElement | null;
        if (!activeTab || activeTab.dataset.tab === 'footage') {
          window.renderMedia('footage');
        }
        console.log(
          `[iKlippa:app] captured ${thumbnails.length} timeline thumbnails [${sourceId}]`,
        );
      })
      .catch((error) => {
        console.warn('[iKlippa:app] Could not build the thumbnail strip:', error);
      });
  }

  syncTimelineToRust();
};

// ── Sync Rust project on any state mutation ──────────────────────────────
window.addEventListener('ikl:reRender', () => {
  syncTimelineToRust();
  syncAllTrackAudio();
  autoSave();
  renderCaptionOverlay(window.S?.time ? window.S.time * 1000 : 0);
});

// ── Trim applied: update duration ───────────────────────────────────────
window.onTrimApplied = ({ durationMs }): void => {
  window.calculateTimelineDuration();
  window.renderRuler();
  window.renderClips();
  window.updatePlayhead();
};

// ── Split result: update UI clips ───────────────────────────────────────
window.onSplitResult = ({ newClipId, originalClipId, splitAtMs, durationMs }): void => {
  window.calculateTimelineDuration();
  window.renderRuler();
  window.renderClips();
  window.updatePlayhead();
};

// ── Connect Playback Control to Engine ──────────────────────────────────
window.togglePlay = function (): void {
  const nowPlaying = togglePlayback();
  document
    .querySelectorAll('.icon-play')
    .forEach((i) => i.setAttribute('data-lucide', nowPlaying ? 'pause' : 'play'));
  window.lucide.createIcons();
  window.S.playing = nowPlaying;
};

// ── Pause Callback ──────────────────────────────────────────────────────
window.onPlaybackPaused = (): void => {
  window.S.playing = false;
  document
    .querySelectorAll('.icon-play')
    .forEach((i) => i.setAttribute('data-lucide', 'play'));
  window.lucide.createIcons();
};

// ── Buffering Spinner ──────────────────────────────────────────────────
window.onBuffering = (buffering: boolean): void => {
  const el = document.getElementById('buffering-spinner');
  if (el) el.style.display = buffering ? 'flex' : 'none';
};

// ── Timeline Scrub: Throttled ───────────────────────────────────────────
let lastSeekMs = -1;
window.onPlayheadScrub = (timeSec: number, force?: boolean): void => {
  const ms = Math.round(timeSec * 1000);
  if (!force && Math.abs(ms - lastSeekMs) < 50) return;
  lastSeekMs = ms;
  seekTo(ms).catch((e) => emitLocal('UNHANDLED_REJECTION', e, { fatal: false }));
};

// ── Video Export Trigger ────────────────────────────────────────────────
window.handleExport = async function (): Promise<void> {
  const modal = document.getElementById('export-modal') as HTMLElement;
  const barFill = document.getElementById('export-bar-fill') as HTMLElement;
  const pctEl = document.getElementById('export-pct') as HTMLElement;
  const stageEl = document.getElementById('export-stage') as HTMLElement;
  const etaEl = document.getElementById('export-eta') as HTMLElement;
  if (modal) modal.style.display = 'flex';

  const t0 = performance.now();
  await exportVideo((progress: number) => {
    const pct = Math.round(progress * 100);
    const elapsed = (performance.now() - t0) / 1000;
    const eta = progress > 0.01 ? (elapsed / progress - elapsed) : 0;

    if (barFill) barFill.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    if (stageEl) {
      if (pct < 40) stageEl.textContent = 'Collecting frames';
      else if (pct < 70) stageEl.textContent = 'Encoding video';
      else if (pct < 95) stageEl.textContent = 'Encoding audio';
      else stageEl.textContent = 'Muxing';
    }
    if (etaEl) {
      if (eta > 0) {
        const m = Math.floor(eta / 60);
        const s = Math.round(eta % 60);
        etaEl.textContent = m > 0 ? `~${m}m ${s}s remaining` : `~${s}s remaining`;
      } else {
        etaEl.textContent = 'Estimating…';
      }
    }
  });

  if (modal) modal.style.display = 'none';
  setStatusBadge('check-circle', 'Export complete');
};

// ── Per-clip color grading ─────────────────────────────────────────────
let _gradingClipId: number | null = null;

document.addEventListener('input', (e: Event) => {
  const slider = (e.target as HTMLElement).closest('[data-grade]') as HTMLInputElement | null;
  if (!slider) return;

  const valSpan = slider.parentElement?.querySelector('.grade-val');
  const v = parseFloat(slider.value) / 100;
  if (valSpan) {
    valSpan.textContent = v === 0 ? '0' : v.toFixed(2);
  }

  if (_gradingClipId !== null) {
    const key = slider.dataset.grade!;
    // Update IKState so the JS compositing path picks up the grade
    const clip = window.IKState.findClip(_gradingClipId);
    if (clip && clip.colour_settings) {
      (clip.colour_settings as any)[key] = v;
    }
    setPerClipGrade(_gradingClipId, { [key]: v });
  } else {
    // Fallback: global grade (legacy)
    setColorGrade({ [slider.dataset.grade!]: parseFloat(slider.value) / 100 } as Partial<GradeParams>);
  }
});

// ── Reset grade (per-clip aware) ────────────────────────────────────────
window.resetGrade = function (): void {
  document.querySelectorAll('[data-grade]').forEach((el) => {
    const htmlEl = el as HTMLInputElement;
    htmlEl.value = '0';
    const valSpan = htmlEl.parentElement?.querySelector('.grade-val');
    if (valSpan) valSpan.textContent = '0';
  });
  if (_gradingClipId !== null) {
    // Reset IKState so JS compositing picks up the reset
    const clip = window.IKState.findClip(_gradingClipId);
    if (clip && clip.colour_settings) {
      const cs = clip.colour_settings;
      cs.exposure = 0; cs.contrast = 0; cs.saturation = 0;
      cs.temperature = 0; cs.tint = 0; cs.highlights = 0; cs.shadows = 0;
    }
    setPerClipGrade(_gradingClipId, {
      exposure: 0, contrast: 0, saturation: 0, temperature: 0,
      tint: 0, highlights: 0, shadows: 0,
    });
  }
  window.showToast('Grade reset', 'sliders-horizontal');
};

// ── Reflect selected clip's grade in panel ──────────────────────────────
function reflectClipGrade(clipId: number) {
  const clip = window.IKState.findClip(clipId);
  if (!clip || !clip.colour_settings) {
    _gradingClipId = null;
    const label = document.getElementById('grade-clip-label');
    if (label) label.textContent = 'Select a clip to grade';
    return;
  }
  _gradingClipId = clipId;
  const cs = clip.colour_settings;
  const map: Record<string, number> = {
    exposure: cs.exposure, contrast: cs.contrast, saturation: cs.saturation,
    temperature: cs.temperature, tint: cs.tint, highlights: cs.highlights,
    shadows: cs.shadows,
  };
  document.querySelectorAll('[data-grade]').forEach((el) => {
    const htmlEl = el as HTMLInputElement;
    const key = htmlEl.dataset.grade!;
    const val = map[key] ?? 0;
    htmlEl.value = String(Math.round(val * 100));
    const valSpan = htmlEl.parentElement?.querySelector('.grade-val');
    if (valSpan) valSpan.textContent = val === 0 ? '0' : val.toFixed(2);
  });
  const label = document.getElementById('grade-clip-label');
  if (label) label.textContent = `${clip.name || 'Clip ' + clipId} — Grade`;
  reflectClipEffects(clip);
}

window.reflectClipGrade = reflectClipGrade;

// ── Score Badge Performance Loop ────────────────────────────────────────
// fallow-ignore-next-line complexity
setInterval(() => {
  if (!window.S.playing) return;
  const { composite } = perf.score();
  if (composite === 0) return;
  scoreValue.textContent = String(composite);
  scoreValue.className =
    'score-value ' + (composite >= 70 ? 'good' : composite >= 40 ? 'ok' : 'bad');
}, 2000);

// ── Drag & Drop ─────────────────────────────────────────────────────────
const canvasWrapper = document.getElementById('canvas-wrapper') as HTMLDivElement;
canvasWrapper.addEventListener('dragenter', () => {
  dropOverlay.style.display = 'flex';
});
canvasWrapper.addEventListener('dragleave', (e: DragEvent) => {
  if (!canvasWrapper.contains(e.relatedTarget as Node)) {
    dropOverlay.style.display = 'none';
  }
});
canvasWrapper.addEventListener('dragover', (e: DragEvent) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
// fallow-ignore-next-line complexity
canvasWrapper.addEventListener('drop', async (e: DragEvent) => {
  e.preventDefault();
  dropOverlay.style.display = 'none';
  const file = e.dataTransfer?.files[0];
  if (file && file.type.startsWith('video/')) {
    await importFile(file);
    return;
  }
  const textData =
    e.dataTransfer?.getData(MEDIA_DRAG_MIME) ||
    e.dataTransfer?.getData('text/plain');
  if (!textData) return;
  try {
    const data = JSON.parse(textData);
    if (data.kind === 'audio') {
      window.showToast('Drop music onto an audio track', 'music');
      return;
    }
    const sourceId =
      typeof data.sourceId === 'string'
        ? data.sourceId
        : typeof data.id === 'string'
          ? `stock_${data.id}`
          : '';
    if (sourceId && data.name) {
      const durationSec = parseMediaDuration(data.durationSec ?? data.dur, 4);
      const thumbnails = Array.isArray(data.thumbnails)
        ? data.thumbnails
            .filter((entry: unknown) =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as { ms?: unknown }).ms === 'number' &&
              typeof (entry as { dataUrl?: unknown }).dataUrl === 'string',
            )
            .map((entry: { ms: number; dataUrl: string }) => ({
              ms: entry.ms,
              dataUrl: entry.dataUrl,
            }))
        : [];
      const materialized = await materializeMediaPayload({
        app: 'iklippa',
        kind: 'video',
        sourceId,
        name: data.name,
        durationSec,
        isReal: Boolean(data.isReal),
        ...(data.picId ? { picId: Number(data.picId) } : {}),
        ...(typeof data.thumbDataUrl === 'string' ? { thumbDataUrl: data.thumbDataUrl } : {}),
        ...(thumbnails.length > 0 ? { thumbnails } : {}),
        ...(typeof data.remoteUrl === 'string' ? { remoteUrl: data.remoteUrl } : {}),
        ...(typeof data.thumbnailUrl === 'string' ? { thumbnailUrl: data.thumbnailUrl } : {}),
        ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
        ...(typeof data.creator === 'string' ? { creator: data.creator } : {}),
        ...(typeof data.mimeType === 'string' ? { mimeType: data.mimeType } : {}),
      });
      window.saveSnapshot();
      const clipThumbnails = materialized.thumbnails?.length
        ? materialized.thumbnails
        : materialized.thumbDataUrl
          ? [{
              ms: Math.round(materialized.durationSec * 500),
              dataUrl: materialized.thumbDataUrl,
            }]
          : undefined;
      window.IKState.addVideoClip(
        materialized.sourceId,
        0,
        Math.round(materialized.durationSec * 1_000_000),
        {
          name: materialized.name,
          isReal: materialized.isReal,
          picId: materialized.picId || 0,
          ...(clipThumbnails ? { thumbnails: clipThumbnails } : {}),
        },
      );
      window.IKState.computeDuration();
      window.calculateTimelineDuration();
      window.renderRuler();
      window.renderClips();
      window.updatePlayhead();
      window.showToast('Stock added via canvas', 'film');
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      window.showToast((error as Error).message || 'Could not add stock media', 'alert-triangle');
    }
  }
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (file) await importFile(file);
});

// ── Project persistence (save/load .iklippa) ────────────────────────────
const LS_KEY_PREFIX = 'iklippa:draft:';

window.saveProject = function (): void {
  if (!window.IKState || !window.IKState.isReady()) {
    window.showToast('Nothing to save', 'alert-triangle');
    return;
  }
  const state = window.IKState.saveState();
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'project.iklippa';
  a.click();
  URL.revokeObjectURL(url);
  window.showToast('Project saved', 'save');
  setStatusBadge('check-circle', 'Saved to disk');
};

window.openProject = function (): void {
  const input = document.getElementById('project-file-input') as HTMLInputElement;
  if (!input) return;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const state = JSON.parse(text);
      if (!state.project || !state.project.tracks) throw new Error('Invalid project file');
      window.IKState.loadState(state);
      window.IKState.computeDuration();
      syncTimelineToRust();
      window.calculateTimelineDuration();
      window.renderRuler();
      window.renderClips();
      window.updatePlayhead();
      window.showToast('Project loaded', 'folder-open');
      setStatusBadge('check-circle', 'Project loaded');
      autoSave();
    } catch (e) {
      console.error('[iKlippa] Failed to load project:', e);
      window.showToast('Invalid project file', 'alert-triangle');
    }
    input.value = '';
  };
  input.click();
};

let _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
function autoSave(): void {
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    if (!window.IKState || !window.IKState.isReady()) return;
    const state = window.IKState.saveState();
    const projectId = state.project?.id || 'default';
    localStorage.setItem(LS_KEY_PREFIX + projectId, JSON.stringify(state));
  }, 2000);
}

// Auto-save on every mutation
window.addEventListener('ikl:reRender', () => {
  autoSave();
});

// Auto-restore: check localStorage for drafts on page load
(function checkAutoRestore() {
  const drafts: Array<{ key: string; state: any; ts: number }> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(LS_KEY_PREFIX)) {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const state = JSON.parse(raw);
          drafts.push({ key, state, ts: state.project?.duration_us || 0 });
        }
      } catch { /* ignore */ }
    }
  }
  if (drafts.length === 0) return;
  drafts.sort((a, b) => b.ts - a.ts);
  const latest = drafts[0]!;
  try {
    // Force-init IKState if not ready (no import has happened yet).
    if (!window.IKState || !window.IKState.isReady()) {
      const w = latest.state.project?.width || 1920;
      const h = latest.state.project?.height || 1080;
      window.IKState.init(w, h);
    }
    window.IKState.loadState(latest.state);
    window.IKState.computeDuration();
    _restoredFromStorage = true;
    console.log('[iKlippa] Auto-restored project from localStorage');
  } catch (e) {
    console.warn('[iKlippa] Auto-restore failed:', e);
  }
})();

async function restoreCachedProjectMedia(): Promise<number> {
  if (!_restoredFromStorage || !window.IKState?.isReady()) return 0;
  const sourceIds = new Set<string>();
  for (const track of window.IKState.getTracks?.() ?? []) {
    for (const clip of track.clips ?? []) {
      if (clip.source_id) sourceIds.add(clip.source_id);
    }
  }
  if (sourceIds.size === 0) return 0;

  const stored = await loadStoredSourceFiles(sourceIds);
  for (const source of stored) _restoringCachedSourceIds.add(source.sourceId);

  for (const source of stored) {
    if (source.file.type.startsWith('audio/')) {
      await registerExternalAudio(source.file, source.sourceId);
      _restoringCachedSourceIds.delete(source.sourceId);
    } else {
      await importFile(source.file, source.sourceId);
    }
  }

  const missingCount = sourceIds.size - stored.length;
  if (stored.length > 0) _restoredFromStorage = false;
  if (missingCount > 0) {
    window.showToast(
      `${missingCount} project source${missingCount === 1 ? '' : 's'} not cached`,
      'alert-triangle',
    );
  }
  return stored.length;
}

// ── Engine Initialization ───────────────────────────────────────────────
initEngine(canvasEl)
  .then(async () => {
    console.log('[iKlippa] Engine ready. Drop a video file to begin.');
    setStatusBadge('cloud-lightning', 'Engine ready');
    void requestDurableStorage();

    let restoredMediaCount = 0;
    if (_restoredFromStorage) {
      window.calculateTimelineDuration();
      window.renderRuler();
      window.renderClips();
      window.updatePlayhead();
      try {
        restoredMediaCount = await restoreCachedProjectMedia();
        if (restoredMediaCount > 0) {
          window.showToast(
            `Project restored with ${restoredMediaCount} cached source${restoredMediaCount === 1 ? '' : 's'}`,
            'folder-open',
          );
          syncTimelineToRust();
        } else {
          window.showToast('Project restored — its media is not cached yet', 'folder-open');
        }
      } catch (error) {
        console.warn('[iKlippa] Cached media restore failed:', error);
        window.showToast('Project restored, but cached media could not open', 'alert-triangle');
      }
    }

    // Dev auto-load helper
    if (import.meta.env.DEV && restoredMediaCount === 0) {
      try {
        const res = await fetch('/test.mp4');
        if (res.ok) {
          const blob = await res.blob();
          const file = new File([blob], 'test.mp4', { type: 'video/mp4' });
          console.log('[Dev Auto-Load] test.mp4 found, importing...');
          await importFile(file);
        }
      } catch (err) {
        console.warn('[Dev Auto-Load] No test.mp4 auto-load:', err);
      }
    }
  })
  .catch((error: Error) => {
    console.error('[iKlippa] WASM load failed:', error);
    setStatusBadge('alert-triangle', 'WASM load failed');
  });
