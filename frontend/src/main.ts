/**
 * iKlippa — main.ts
 * Entry point. Ported from app.js to TypeScript.
 * Hooks up UI events ↔ engine, initialises IKState.
 */

// Import state first (attaches to window.IKState, sets up videoClips/audioClips)
import './state/state';
import './ui/index';

import {
  initEngine,
  importFile,
  togglePlayback,
  seekTo,
  setColorGrade,
  exportVideo,
  perf,
  captureThumbnailFromBuffer,
  setPendingThumbCapture,
  syncTimelineToRust,
} from './engine/engine';

import type { EngineError, GradeParams } from './engine/types';
import { USER_ERROR_MESSAGES, emitLocal } from './engine/errors';

// Import CSS so Vite bundles it
import '../styles.css';

const canvasEl = document.getElementById('canvas-img') as HTMLCanvasElement;
const dropOverlay = document.getElementById('drop-overlay') as HTMLDivElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const statusBadge = document.querySelector('.status-badge') as HTMLElement;
const scoreValue = document.getElementById('score-value') as HTMLElement;

let hasRealVideo = false;

// ── Engine Status to UI ─────────────────────────────────────────────────
window.onEngineStatus = (msg: string): void => {
  statusBadge.innerHTML = `<i data-lucide="zap"></i> ${msg}`;
  window.lucide.createIcons({ nodes: [statusBadge] });
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
    statusBadge.innerHTML = `<i data-lucide="alert-triangle"></i> ${friendly}`;
    window.lucide.createIcons({ nodes: [statusBadge] });
  }
};

// ── Playhead updates: Engine → UI ───────────────────────────────────────
window.onPlayheadUpdate = (ms: number): void => {
  window.S.time = ms / 1000;
  window.updatePlayhead();
};

// ── Thumbnail updates: debounced re-render ──────────────────────────────
let thumbnailRenderDebounce: ReturnType<typeof setTimeout> | null = null;
// fallow-ignore-next-line complexity
window.onThumbnailsUpdated = (thumbnails): void => {
  if (!hasRealVideo) return;
  const clips = window.IKState.getVideoClips();
  if (clips.length > 0 && clips[0]!.isReal) {
    window.IKState.setClipMeta(clips[0]!.id, { thumbnails });
  }
  if (thumbnailRenderDebounce) clearTimeout(thumbnailRenderDebounce);
  thumbnailRenderDebounce = setTimeout(() => {
    window.renderClips();
  }, 600);
};

// ── Import complete: build project model + sync to Rust ─────────────────
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

  window.mediaPool.footage.push({
    id: sourceId,
    name: displayName,
    isReal: true,
    dur: durationSec.toFixed(1) + 's',
    thumbDataUrl: null,
    width,
    height,
  });
  window.renderMedia('footage');
  window.showToast(`Clip loaded (${width}×${height})`, 'film');
  syncTimelineToRust();

  // fallow-ignore-next-line complexity
  setPendingThumbCapture((frameMs: number) => {
    try {
      const thumb = captureThumbnailFromBuffer(frameMs);
      if (thumb && thumb.length > 500) {
        const entry = window.mediaPool.footage.find((f) => f.id === sourceId);
        if (entry) {
          entry.thumbDataUrl = thumb;
          window.renderMedia('footage');
          console.log(`[iKlippa:app] thumbnail captured from frame ${frameMs}ms ✓`);
        } else {
          console.warn(
            '[iKlippa:app] ⚠ thumbnail ready but media pool entry not found for',
            sourceId,
          );
        }
      } else {
        console.warn(
          '[iKlippa:app] ⚠ captureThumbnailFromBuffer returned empty result at',
          frameMs,
          'ms',
        );
      }
    } catch (e) {
      console.error('[iKlippa:app] ✖ thumbnail capture threw', e);
    }
  });
};

// ── Sync Rust project on any state mutation ──────────────────────────────
window.addEventListener('ikl:reRender', () => {
  syncTimelineToRust();
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
  await exportVideo((progress: number) => {
    const pct = Math.round(progress * 100);
    statusBadge.innerHTML = `<i data-lucide="loader"></i> Exporting… ${pct}%`;
    window.lucide.createIcons({ nodes: [statusBadge] });
  });
};

// ── Color grading sliders ───────────────────────────────────────────────
document.addEventListener('input', (e: Event) => {
  const slider = (e.target as HTMLElement).closest('[data-grade]') as HTMLInputElement | null;
  if (!slider) return;

  const valSpan = slider.parentElement?.querySelector('.grade-val');
  if (valSpan) {
    const v = parseFloat(slider.value);
    valSpan.textContent = v === 0 ? '0' : v.toFixed(2);
  }

  setColorGrade({ [slider.dataset.grade!]: parseFloat(slider.value) } as Partial<GradeParams>);
});

// ── Reset grade ─────────────────────────────────────────────────────────
window.resetGrade = function (): void {
  document.querySelectorAll('[data-grade]').forEach((el) => {
    const htmlEl = el as HTMLInputElement | HTMLSelectElement;
    if (htmlEl.tagName === 'SELECT') {
      htmlEl.value = '0';
    } else {
      (htmlEl as HTMLInputElement).value = '0';
    }
    const valSpan = htmlEl.parentElement?.querySelector('.grade-val');
    if (valSpan) valSpan.textContent = '0';
    const grade = htmlEl.dataset.grade!;
    if (grade === 'lut') {
      setColorGrade({ lut: 0 });
    } else {
      setColorGrade({ [grade]: 0 } as Partial<GradeParams>);
    }
  });
  window.showToast('Grade reset', 'sliders-horizontal');
};

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
  const textData = e.dataTransfer?.getData('text/plain');
  if (!textData) return;
  try {
    const data = JSON.parse(textData);
    if (data.id && data.name) {
      window.saveSnapshot();
      window.IKState.addVideoClip('stock_' + data.id, 0, 4_000_000, {
        name: data.name,
        isReal: false,
        picId: data.picId || 0,
      });
      window.IKState.computeDuration();
      window.calculateTimelineDuration();
      window.renderRuler();
      window.renderClips();
      window.updatePlayhead();
      window.showToast('Stock added via canvas', 'film');
    }
  } catch {
    // ignore invalid JSON
  }
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (file) await importFile(file);
});

// ── Engine Initialization ───────────────────────────────────────────────
initEngine(canvasEl)
  .then(async () => {
    console.log('[iKlippa] Engine ready. Drop a video file to begin.');
    statusBadge.innerHTML = '<i data-lucide="cloud-lightning"></i> Engine ready';
    window.lucide.createIcons({ nodes: [statusBadge] });

    // Dev auto-load helper
    if (import.meta.env.DEV) {
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
    statusBadge.innerHTML = '<i data-lucide="alert-triangle"></i> WASM load failed';
    window.lucide.createIcons({ nodes: [statusBadge] });
  });
