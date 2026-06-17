/**
* iKlippa — engine.js (Phase 3: Multi-Track Support + Export)
*/
const DECODE_LOOKAHEAD = 12;
let worker = null;
let canvas = null;
let ctx = null;
let isPlaying = false;
let playheadMs = 0;
let lastRafTs = null;
let rafHandle = null;
let pendingFrames = new Map();
let sourceVideoWidth = 0;
let sourceVideoHeight = 0;
let videoDurationMs = 0;
let isExporting = false;
let exportFrames = [];
let fileRegistry = new Map();
let nextFileId = 1;

// ── Web Audio State ───────────────────────────────────────────────────────────
let audioCtx = null;
let pendingAudio = new Map();
let scheduledAudioNodes = [];
let nextAudioStartTime = 0;
let lastScheduledChunkMs = -1;
let audioConfigVersion = 0;
let audioPlayStartCtxTime = 0;
let audioPlayStartMs = 0;

// ── Performance Monitor ───────────────────────────────────────────────────────
export class PerformanceMonitor {
  constructor() { this.reset(); }
  reset() {
    this._frameTimes = []; this._gradeTimes = []; this._decodeTimes = [];
    this._droppedFrames = 0; this._totalFrames = 0; this._lastRaf = null; this._pendingDecodes = new Map();
  }
  recordRaf(ts) {
    if (this._lastRaf !== null) {
      const dt = ts - this._lastRaf;
      this._frameTimes.push(dt);
      const avgFrameMs = this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;
      const targetMs = (this._frameTimes.length > 10 && avgFrameMs > 25) ? 33.33 : 16.67;
      if (dt > targetMs * 1.25) this._droppedFrames++;
      this._totalFrames++;
      if (this._frameTimes.length > 120) this._frameTimes.shift();
    }
    this._lastRaf = ts;
  }
  recordDecodeSubmit(tsMs) { this._pendingDecodes.set(tsMs, performance.now()); }
  recordFrameArrival(tsMs, gradeMs) {
    if (this._pendingDecodes.has(tsMs)) {
      this._decodeTimes.push(performance.now() - this._pendingDecodes.get(tsMs));
      this._pendingDecodes.delete(tsMs);
      if (this._decodeTimes.length > 60) this._decodeTimes.shift();
    }
    this._gradeTimes.push(gradeMs);
    if (this._gradeTimes.length > 120) this._gradeTimes.shift();
  }
  score() {
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const avgFrameMs = avg(this._frameTimes);
    const avgGradeMs = avg(this._gradeTimes);
    const avgDecodeMs = avg(this._decodeTimes);
    const dropRate = this._totalFrames > 0 ? this._droppedFrames / this._totalFrames : 0;
    const targetMs = avgFrameMs > 25 ? 33.33 : 16.67;
    const smoothness = Math.max(0, Math.min(100, 100 - (Math.abs(avgFrameMs - targetMs) / targetMs) * 100));
    const gradePerf = Math.max(0, Math.min(100, 100 - (avgGradeMs / 4) * 100));
    const decodePerf = Math.max(0, Math.min(100, 100 - ((avgDecodeMs - 33) / 67) * 100));
    const dropScore = Math.max(0, Math.min(100, (1 - dropRate * 10) * 100));
    const composite = Math.round(smoothness * 0.40 + dropScore * 0.30 + decodePerf * 0.20 + gradePerf * 0.10);
    return {
      composite, smoothness: Math.round(smoothness), gradePerf: Math.round(gradePerf),
      decodePerf: Math.round(decodePerf), dropScore: Math.round(dropScore),
      avgFrameMs: avgFrameMs.toFixed(2), avgGradeMs: avgGradeMs.toFixed(2),
      avgDecodeMs: avgDecodeMs.toFixed(2), dropRatePct: (dropRate * 100).toFixed(1),
      totalFrames: this._totalFrames, targetFps: Math.round(1000 / targetMs),
    };
  }
  report() {
    const s = this.score();
    console.group('%ciKlippa Performance Report', 'color:#0d9488;font-weight:700;font-size:14px');
    console.log(`%c🎯 Composite Score: ${s.composite} / 100 (${s.targetFps} FPS Target)`,
      `font-size:16px;font-weight:800;color:${s.composite >= 70 ? '#10b981' : s.composite >= 40 ? '#f59e0b' : '#ef4444'}`);
    console.table({
      'Smoothness': `${s.smoothness}/100 (avg ${s.avgFrameMs} ms/frame)`,
      'Grade Perf': `${s.gradePerf}/100 (avg ${s.avgGradeMs} ms/grade)`,
      'Decode Perf': `${s.decodePerf}/100 (avg ${s.avgDecodeMs} ms decode→output)`,
      'Drop Score': `${s.dropScore}/100 (${s.dropRatePct}% frames dropped)`,
      'Total Frames': s.totalFrames,
    });
    console.groupEnd();
    return s.composite;
  }
}
export const perf = new PerformanceMonitor();
window.iklippaScore = () => perf.report();

// ── Init & Worker Bridge ──────────────────────────────────────────────────────
export async function initEngine(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  worker = new Worker('./worker.js', { type: 'module' });
  worker.onmessage = handleWorkerMessage;
  worker.postMessage({ type: 'init' });
  logStatus('Booting background worker…');
  return true;
}

async function initAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state !== 'running') await audioCtx.resume();
}

function handleWorkerMessage(e) {
  const { type, ...data } = e.data;
  if (type === 'status') logStatus(data.msg);
  if (type === 'ready') {
    videoDurationMs = data.durationMs;
    sourceVideoWidth = data.width;
    sourceVideoHeight = data.height;
    canvas.width = sourceVideoWidth;
    canvas.height = sourceVideoHeight;
    logStatus(`Ready: ${sourceVideoWidth}×${sourceVideoHeight} · ${(videoDurationMs / 1000).toFixed(2)}s`);
    if (window.onClipImported) {
      window.onClipImported({ width: sourceVideoWidth, height: sourceVideoHeight, durationMs: videoDurationMs });
    }
  }
  if (type === 'frame') {
    perf.recordFrameArrival(data.ms, data.gradeMs);
    const arr = new Uint8ClampedArray(data.buffer);
    pendingFrames.set(data.ms, new ImageData(arr, sourceVideoWidth, sourceVideoHeight));
    if (isExporting) exportFrames.push({ ms: data.ms, imageData: pendingFrames.get(data.ms) });
    if (!isPlaying) paintFrameAtTime(playheadMs);
  }
}

// ── Demux (Main Thread) ───────────────────────────────────────────────────────
export async function importFile(file) {
  logStatus(`Importing: ${file.name}`);
  initAudio();
  pendingFrames.clear();
  playheadMs = 0;
  isPlaying = false;
  lastRafTs = null;

  if (!window.MP4Box) {
    await loadScript('https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js');
  }

  const payload = await new Promise((resolve, reject) => {
    const mp4 = MP4Box.createFile();
    let trackInfo = null;
    let codecConfigResult = null;
    const samplesArray = [];

    mp4.onReady = (info) => {
      const track = info.videoTracks[0];
      if (!track) { reject(new Error('No video track found')); return; }
      trackInfo = track;
      codecConfigResult = {
        codec: track.codec,
        codedWidth: track.track_width,
        codedHeight: track.track_height,
        description: getDecoderDescription(mp4, track),
      };
      mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      mp4.start();
    };

    mp4.onSamples = (id, user, s) => {
      if (trackInfo && id === trackInfo.id) samplesArray.push(...s);
    };

    mp4.onError = (err) => reject(new Error('MP4Box error: ' + err));

    const CHUNK = 2 * 1024 * 1024;
    let offset = 0;
    function readNextChunk() {
      if (offset >= file.size) {
        mp4.flush();
        if (trackInfo && codecConfigResult) {
          let durationSec = trackInfo.duration / trackInfo.timescale;
          if (durationSec === 0 && samplesArray.length > 0) {
            const lastSample = samplesArray[samplesArray.length - 1];
            durationSec = (lastSample.cts + lastSample.duration) / lastSample.timescale;
          }
          resolve({
            codecConfig: codecConfigResult,
            width: trackInfo.track_width,
            height: trackInfo.track_height,
            durationMs: Math.round(durationSec * 1000),
            samples: samplesArray,
          });
        } else {
          reject(new Error('Failed to find video metadata'));
        }
        return;
      }
      file.slice(offset, offset + CHUNK).arrayBuffer().then(buf => {
        buf.fileStart = offset;
        mp4.appendBuffer(buf);
        offset += CHUNK;
        readNextChunk();
      }).catch(reject);
    }
    readNextChunk();
  });

  const fileId = nextFileId++;
  fileRegistry.set(fileId, {
    file,
    codecConfig: payload.codecConfig,
    samples: payload.samples,
    durationMs: payload.durationMs,
    width: payload.width,
    height: payload.height,
  });

  // Send dimensions to worker so it can initialize the WASM frame buffer correctly
  worker.postMessage({
    type: 'register_file',
    fileId,
    file,
    codecConfig: payload.codecConfig,
    samples: payload.samples,
    width: payload.width,
    height: payload.height,
    durationMs: payload.durationMs
  });

  return { fileId, durationMs: payload.durationMs, width: payload.width, height: payload.height };
}

export function addClip(fileId, track, startSec, endSec, sourceStartSec, sourceEndSec) {
  const startMs = Math.round(startSec * 1000);
  const endMs = Math.round(endSec * 1000);
  const sourceOffsetMs = Math.round(sourceStartSec * 1000);

  worker.postMessage({
    type: 'add_clip',
    fileId,
    track,
    startMs,
    endMs,
    sourceOffsetMs
  });

  if (endMs > videoDurationMs) {
    videoDurationMs = endMs;
  }
}

function getDecoderDescription(mp4, track) {
  const trak = mp4.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(ds);
      return ds.buffer.slice(8);
    }
  }
  return undefined;
}

// ── Render Loop ───────────────────────────────────────────────────────────────
function renderLoop(ts) {
  perf.recordRaf(ts);
  if (!isPlaying) return;

  if (lastRafTs !== null) {
    playheadMs += ts - lastRafTs;
    if (playheadMs >= videoDurationMs) {
      playheadMs = videoDurationMs;
      pausePlayback();
    }
  }
  lastRafTs = ts;

  paintFrameAtTime(playheadMs);

  let framesAhead = 0;
  for (const frameMs of pendingFrames.keys()) {
    if (frameMs >= playheadMs) framesAhead++;
  }
  worker.postMessage({ type: 'sync', playheadMs, isPlaying, framesAhead });

  if (window.onPlayheadUpdate) window.onPlayheadUpdate(playheadMs);
  rafHandle = requestAnimationFrame(renderLoop);
}

function paintFrameAtTime(ms) {
  if (!ctx) return;
  let bestMs = -1;
  for (const [frameMs] of pendingFrames) {
    if (frameMs <= ms && frameMs > bestMs) bestMs = frameMs;
  }
  if (bestMs >= 0) ctx.putImageData(pendingFrames.get(bestMs), 0, 0);

  const pruneBeforeMs = ms - 1500;
  for (const [frameMs] of pendingFrames) {
    if (frameMs < pruneBeforeMs) pendingFrames.delete(frameMs);
  }
}

// ── Playback control ──────────────────────────────────────────────────
export async function startPlayback() {
  if (isPlaying) return;
  isPlaying = true;
  lastRafTs = null;
  await initAudio();
  audioPlayStartCtxTime = audioCtx.currentTime;
  audioPlayStartMs = playheadMs;
  nextAudioStartTime = 0;
  syncWorkerState();
  rafHandle = requestAnimationFrame(renderLoop);
}

export function pausePlayback() {
  if (!isPlaying && rafHandle === null) return;
  isPlaying = false;
  lastRafTs = null;
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  nextAudioStartTime = 0;
  lastScheduledChunkMs = -1;
  syncWorkerState();
  if (window.onPlaybackPaused) window.onPlaybackPaused();
}

export function togglePlayback() {
  if (isPlaying) { pausePlayback(); }
  else { startPlayback().catch(console.error); }
  return isPlaying;
}

export async function seekTo(ms) {
  const wasPlaying = isPlaying;
  if (isPlaying) {
    isPlaying = false;
    lastRafTs = null;
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  }
  playheadMs = ms;
  audioPlayStartMs = ms;
  pendingFrames.clear();
  worker.postMessage({ type: 'seek', ms });
  syncWorkerState();
  if (window.onPlayheadUpdate) window.onPlayheadUpdate(ms);
  if (wasPlaying) startPlayback();
}

function syncWorkerState() {
  if (worker) worker.postMessage({ type: 'sync', playheadMs, isPlaying, framesAhead: 0 });
}

export function setColorGrade(params) {
  worker.postMessage({
    type: 'set_grade',
    params,
    forceRenderMs: isPlaying ? undefined : playheadMs,
  });
}

// ── EXPORT FUNCTIONALITY ──────────────────────────────────────────────
export async function exportVideo(onProgress) {
  if (isExporting) return;
  isExporting = true;
  exportFrames = [];

  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  return new Promise((resolve) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'iklippa_export.webm';
      a.click();
      URL.revokeObjectURL(url);

      isExporting = false;
      exportFrames = [];
      resolve();
    };

    recorder.start();

    let currentTime = 0;
    const step = 100;
    const interval = setInterval(() => {
      currentTime += step;
      if (onProgress) onProgress(Math.min(currentTime / videoDurationMs, 1));

      if (currentTime >= videoDurationMs) {
        clearInterval(interval);
        setTimeout(() => {
          recorder.stop();
          stream.getTracks().forEach(t => t.stop());
        }, 200);
      } else {
        seekTo(currentTime);
      }
    }, 50);
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
  });
}

function logStatus(msg) {
  console.log(`[iKlippa] ${msg}`);
  if (window.onEngineStatus) window.onEngineStatus(msg);
}