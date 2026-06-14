/**
 * iKlippa — engine.js (Web Worker Architecture)
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

// ── Performance Monitor (Restored with Worker Support) ───────────────────────
export class PerformanceMonitor {
  constructor() { this.reset(); }

  reset() {
    this._frameTimes = [];   // rAF delta ms, rolling 120-frame window
    this._gradeTimes = [];   // Worker process_frame() ms
    this._decodeTimes = [];   // decode()-to-output() ms
    this._droppedFrames = 0;
    this._totalFrames = 0;
    this._lastRaf = null;
    this._pendingDecodes = new Map();
  }

  /** Top of each rAF iteration. */
  recordRaf(ts) {
    if (this._lastRaf !== null) {
      const dt = ts - this._lastRaf;
      this._frameTimes.push(dt);
      if (dt > 20) this._droppedFrames++;  // below 50 fps = a dropped frame
      this._totalFrames++;
      if (this._frameTimes.length > 120) this._frameTimes.shift();
    }
    this._lastRaf = ts;
  }

  /** When a sample is submitted. */
  recordDecodeSubmit(tsMs) {
    this._pendingDecodes.set(tsMs, performance.now());
  }

  /** When a processed frame arrives from the background worker. */
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
    const avg = arr => arr.length
      ? arr.reduce((a, b) => a + b, 0) / arr.length
      : 0;

    const avgFrameMs = avg(this._frameTimes);
    const avgGradeMs = avg(this._gradeTimes);
    const avgDecodeMs = avg(this._decodeTimes);
    const dropRate = this._totalFrames > 0
      ? this._droppedFrames / this._totalFrames : 0;

    // Sub-scores 0–100
    const smoothness = Math.max(0, Math.min(100,
      100 - ((avgFrameMs - 16.67) / 16.67) * 100));
    const gradePerf = Math.max(0, Math.min(100,
      100 - (avgGradeMs / 4) * 100));
    const decodePerf = Math.max(0, Math.min(100,
      100 - ((avgDecodeMs - 33) / 67) * 100));
    const dropScore = Math.max(0, Math.min(100,
      (1 - dropRate * 10) * 100));

    const composite = Math.round(
      smoothness * 0.40 +
      dropScore * 0.30 +
      decodePerf * 0.20 +
      gradePerf * 0.10
    );

    return {
      composite,
      smoothness: Math.round(smoothness),
      gradePerf: Math.round(gradePerf),
      decodePerf: Math.round(decodePerf),
      dropScore: Math.round(dropScore),
      avgFrameMs: avgFrameMs.toFixed(2),
      avgGradeMs: avgGradeMs.toFixed(2),
      avgDecodeMs: avgDecodeMs.toFixed(2),
      dropRatePct: (dropRate * 100).toFixed(1),
      totalFrames: this._totalFrames,
    };
  }

  report() {
    const s = this.score();
    console.group('%ciKlippa Performance Report', 'color:#0d9488;font-weight:700;font-size:14px');
    console.log('%c🎯 Composite Score: ' + s.composite + ' / 100',
      'font-size:16px;font-weight:800;color:' + (s.composite >= 70 ? '#10b981' : s.composite >= 40 ? '#f59e0b' : '#ef4444'));
    console.table({
      'Smoothness': s.smoothness + '/100  (avg ' + s.avgFrameMs + ' ms/frame)',
      'Grade Perf': s.gradePerf + '/100  (avg ' + s.avgGradeMs + ' ms/grade)',
      'Decode Perf': s.decodePerf + '/100  (avg ' + s.avgDecodeMs + ' ms decode→output)',
      'Drop Score': s.dropScore + '/100  (' + s.dropRatePct + '% frames dropped)',
      'Total Frames': s.totalFrames,
    });
    console.groupEnd();
    return s.composite;
  }
}

export const perf = new PerformanceMonitor();
window.iklippaScore = () => perf.report();


// ── Updated Worker Message Handler (Routes data back into the monitor) ─────────
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
    if (window.onClipImported) window.onClipImported({ width: sourceVideoWidth, height: sourceVideoHeight, durationMs: videoDurationMs });
  }

  if (type === 'decode_submit') {
    perf.recordDecodeSubmit(data.ms);
  }

  if (type === 'frame') {
    // We send the worker's native grade time directly into our metric monitor
    perf.recordFrameArrival(data.ms, data.gradeMs);

    // Convert the ArrayBuffer back into an ImageData object
    const arr = new Uint8ClampedArray(data.buffer);
    const imgData = new ImageData(arr, sourceVideoWidth, sourceVideoHeight);

    pendingFrames.set(data.ms, imgData);

    if (isExporting) exportFrames.push({ ms: data.ms, imageData: imgData });
    if (!isPlaying) paintFrameAtTime(playheadMs); // Auto-update UI when scrubbed
  }
}

// ── Init & Worker Bridge ─────────────────────────────────────────────────────
export async function initEngine(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  worker = new Worker('./worker.js', { type: 'module' });
  worker.onmessage = handleWorkerMessage;
  worker.postMessage({ type: 'init' });

  logStatus('Booting background worker...');
  return true;
}


// ── Demux (Main Thread) ──────────────────────────────────────────────────────
export async function importFile(file) {
  logStatus(`Importing: ${file.name}`);
  if (!window.MP4Box) await loadScript('https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js');

  const { codecConfig, width, height, durationMs, samples } = await new Promise((resolve, reject) => {
    const mp4 = MP4Box.createFile();
    let resolved = false;
    mp4.onReady = (info) => {
      const track = info.videoTracks[0];
      const codecConfig = { codec: track.codec, codedWidth: track.track_width, codedHeight: track.track_height, description: getDecoderDescription(mp4, track) };
      mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      mp4.start();
      const samples = [];
      mp4.onSamples = (_id, _user, s) => { samples.push(...s); };
      const CHUNK = 2 * 1024 * 1024;
      let offset = 0;
      function readChunk() {
        file.slice(offset, offset + CHUNK).arrayBuffer().then(buf => {
          buf.fileStart = offset;
          mp4.appendBuffer(buf);
          offset += CHUNK;
          if (offset < file.size) readChunk();
          else {
            mp4.flush();
            if (!resolved) { resolved = true; resolve({ codecConfig, width: track.track_width, height: track.track_height, durationMs: Math.round((track.duration / track.timescale) * 1000), samples }); }
          }
        }).catch(reject);
      }
      file.slice(0, 4 * 1024 * 1024).arrayBuffer().then(buf => { buf.fileStart = 0; mp4.appendBuffer(buf); offset = 4 * 1024 * 1024; readChunk(); }).catch(reject);
    };
    file.slice(0, 4 * 1024 * 1024).arrayBuffer().then(buf => { buf.fileStart = 0; mp4.appendBuffer(buf); }).catch(reject);
  });

  worker.postMessage({ type: 'load', file, codecConfig, width, height, durationMs, samples });
}

function getDecoderDescription(mp4, track) {
  const trak = mp4.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(ds);
      return new Uint8Array(ds.buffer, 8);
    }
  }
  return undefined;
}

// ── Render Loop & Controls ───────────────────────────────────────────────────
function renderLoop(ts) {
  perf.recordRaf(ts);
  if (!isPlaying) return;

  if (lastRafTs !== null) {
    playheadMs += ts - lastRafTs;
    if (playheadMs >= videoDurationMs) { playheadMs = videoDurationMs; pausePlayback(); }
  }
  lastRafTs = ts;

  paintFrameAtTime(playheadMs);
  worker.postMessage({ type: 'decode_next', count: DECODE_LOOKAHEAD });

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

  const pruneBeforeMs = ms - 2000;
  for (const [frameMs] of pendingFrames) {
    if (frameMs < pruneBeforeMs) pendingFrames.delete(frameMs);
  }
}

export function startPlayback() {
  if (isPlaying) return;
  isPlaying = true;
  lastRafTs = null;
  rafHandle = requestAnimationFrame(renderLoop);
}
export function pausePlayback() {
  isPlaying = false;
  lastRafTs = null;
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  if (window.onPlaybackPaused) window.onPlaybackPaused();
}
export function togglePlayback() {
  isPlaying ? pausePlayback() : startPlayback();
  return isPlaying;
}
export async function seekTo(ms) {
  playheadMs = ms;
  pendingFrames.clear();
  worker.postMessage({ type: 'seek', ms });
  if (window.onPlayheadUpdate) window.onPlayheadUpdate(ms);
}
export function setColorGrade(params) {
  worker.postMessage({ type: 'set_grade', params, forceRenderMs: isPlaying ? undefined : playheadMs });
}

// ── Export ───────────────────────────────────────────────────────────────────
export async function exportVideo(onProgress) {
  if (isExporting) return;
  pausePlayback();
  isExporting = true;
  exportFrames = [];

  const frameMs = 1000 / 30;
  const totalFrames = Math.ceil(videoDurationMs / frameMs);
  logStatus('Export: collecting frames…');

  for (let i = 0; i < totalFrames; i++) {
    const ms = Math.round(i * frameMs);
    worker.postMessage({ type: 'seek', ms });

    // Poll until the worker hands the frame back
    while (!pendingFrames.has(ms)) { await new Promise(r => setTimeout(r, 10)); }
    if (onProgress) onProgress(i / totalFrames * 0.5);
  }

  logStatus('Export: encoding…');
  const encodedChunks = [];
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const buf = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(buf);
      encodedChunks.push({ buf, timestamp: chunk.timestamp, type: chunk.type });
    },
    error: (e) => console.error(e),
  });
  encoder.configure({ codec: 'avc1.42001f', width: sourceVideoWidth, height: sourceVideoHeight, bitrate: 8_000_000, framerate: 30, hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality' });

  const sortedFrames = exportFrames.slice().sort((a, b) => a.ms - b.ms);
  for (let i = 0; i < sortedFrames.length; i++) {
    const { ms, imageData } = sortedFrames[i];
    const frame = new VideoFrame(imageData, { timestamp: ms * 1000, duration: frameMs * 1000 });
    encoder.encode(frame, { keyFrame: i % 60 === 0 });
    frame.close();
    if (onProgress) onProgress(0.5 + (i / sortedFrames.length) * 0.4);
  }
  await encoder.flush();
  encoder.close();

  logStatus('Export: muxing…');
  if (!window.Mp4Muxer) await loadScript('https://cdn.jsdelivr.net/npm/mp4-muxer@4.4.2/build/mp4-muxer.js');

  const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: 'avc', width: sourceVideoWidth, height: sourceVideoHeight }, fastStart: 'in-memory' });
  for (const { buf, timestamp, type } of encodedChunks) { muxer.addVideoChunkRaw(buf, type, timestamp, frameMs * 1000); }

  if (onProgress) onProgress(0.95);
  const { buffer } = muxer.finalize();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }));
  a.download = `iklippa-export-${Date.now()}.mp4`;
  a.click();

  isExporting = false;
  exportFrames = [];
  logStatus('Export complete ✓');
  if (onProgress) onProgress(1);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
function logStatus(msg) { console.log(`[iKlippa] ${msg}`); if (window.onEngineStatus) window.onEngineStatus(msg); }