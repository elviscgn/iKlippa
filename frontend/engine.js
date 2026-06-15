/**
 * iKlippa — engine.js (Stable Audio & Catch-Up Fix)
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

// ── Web Audio State ───────────────────────────────────────────────────────────
let audioCtx = null;
let pendingAudio = new Map();
let scheduledAudioNodes = [];
let nextAudioScheduleTime = 0;
let lastScheduledChunkMs = -1;
let audioConfigVersion = 0;

// ── Performance Monitor ───────────────────────────────────────────────────────
export class PerformanceMonitor {
  constructor() { this.reset(); }

  reset() {
    this._frameTimes = [];
    this._gradeTimes = [];
    this._decodeTimes = [];
    this._droppedFrames = 0;
    this._totalFrames = 0;
    this._lastRaf = null;
    this._pendingDecodes = new Map();
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
      'Smoothness': `${s.smoothness}/100  (avg ${s.avgFrameMs} ms/frame)`,
      'Grade Perf': `${s.gradePerf}/100  (avg ${s.avgGradeMs} ms/grade)`,
      'Decode Perf': `${s.decodePerf}/100  (avg ${s.avgDecodeMs} ms decode→output)`,
      'Drop Score': `${s.dropScore}/100  (${s.dropRatePct}% frames dropped)`,
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

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
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

  if (type === 'decode_submit') {
    perf.recordDecodeSubmit(data.ms);
  }

  if (type === 'frame') {
    perf.recordFrameArrival(data.ms, data.gradeMs);
    const arr = new Uint8ClampedArray(data.buffer);
    pendingFrames.set(data.ms, new ImageData(arr, sourceVideoWidth, sourceVideoHeight));
    if (isExporting) exportFrames.push({ ms: data.ms, imageData: pendingFrames.get(data.ms) });
    if (!isPlaying) paintFrameAtTime(playheadMs);
  }

  if (type === 'audio_chunk') {
    if (!audioCtx || data.configVersion !== audioConfigVersion) return;

    const audioBuffer = audioCtx.createBuffer(data.channels, data.length, data.sampleRate);
    for (let c = 0; c < data.channels; c++) {
      audioBuffer.copyToChannel(new Float32Array(data.buffers[c]), c);
    }

    pendingAudio.set(data.ms, audioBuffer);
    if (isPlaying) scheduleAudioNode(data.ms, audioBuffer);
  }
}

function scheduleAudioNode(chunkMs, audioBuffer) {
  if (!audioCtx) return;

  const timeAheadMs = chunkMs - playheadMs;

  // THE FIX: Only drop if the audio chunk is more than 500ms in the past!
  // If it's just slightly behind due to seek latency, we let it play instantly to catch up!
  if (timeAheadMs < -500) return;

  const gap = Math.abs(chunkMs - lastScheduledChunkMs);

  if (nextAudioScheduleTime === 0 || nextAudioScheduleTime < audioCtx.currentTime || gap > 100) {
    // If it's slightly late (timeAheadMs is negative), clamp it to 0 so it plays right now
    const safeAheadSecs = Math.max(0, timeAheadMs / 1000);
    nextAudioScheduleTime = audioCtx.currentTime + safeAheadSecs;
  }

  // Final safety cap
  if (nextAudioScheduleTime < audioCtx.currentTime) {
    nextAudioScheduleTime = audioCtx.currentTime;
  }

  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioCtx.destination);

  source.start(nextAudioScheduleTime);
  scheduledAudioNodes.push(source);

  nextAudioScheduleTime += audioBuffer.duration;
  lastScheduledChunkMs = chunkMs + (audioBuffer.duration * 1000);
}

function stopAllAudioNodes() {
  scheduledAudioNodes.forEach(n => { try { n.stop(); } catch { } });
  scheduledAudioNodes = [];
}

// ── Demux (Main Thread) ───────────────────────────────────────────────────────
export async function importFile(file) {
  logStatus(`Importing: ${file.name}`);
  initAudio();

  pendingFrames.clear();
  pendingAudio.clear();
  stopAllAudioNodes();
  nextAudioScheduleTime = 0;
  lastScheduledChunkMs = -1;
  audioConfigVersion++;
  playheadMs = 0;
  isPlaying = false;
  lastRafTs = null;

  if (!window.MP4Box) {
    await loadScript('https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js');
  }

  const payload = await new Promise((resolve, reject) => {
    const mp4 = MP4Box.createFile();
    let trackInfo = null;
    let audioTrackInfo = null;
    let codecConfigResult = null;
    let audioConfigResult = null;
    const samplesArray = [];
    const audioSamplesArray = [];

    mp4.onReady = (info) => {
      const track = info.videoTracks[0];
      const aTrack = info.audioTracks[0];
      if (!track) { reject(new Error('No video track found')); return; }

      trackInfo = track;
      audioTrackInfo = aTrack;

      codecConfigResult = {
        codec: track.codec,
        codedWidth: track.track_width,
        codedHeight: track.track_height,
        description: getDecoderDescription(mp4, track),
      };
      mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });

      if (aTrack) {
        const audioDesc = getAudioDescription(mp4, aTrack);
        audioConfigResult = {
          codec: aTrack.codec,
          sampleRate: aTrack.audio.sample_rate,
          numberOfChannels: aTrack.audio.channel_count,
          ...(audioDesc ? { description: audioDesc } : {}),
        };
        mp4.setExtractionOptions(aTrack.id, null, { nbSamples: Infinity });
      }
      mp4.start();
    };

    mp4.onSamples = (id, user, s) => {
      if (trackInfo && id === trackInfo.id) {
        samplesArray.push(...s);
      } else if (audioTrackInfo && id === audioTrackInfo.id) {
        audioSamplesArray.push(...s);
      }
    };

    mp4.onError = (err) => reject(new Error('MP4Box error: ' + err));

    const CHUNK = 2 * 1024 * 1024;
    let offset = 0;
    function readNextChunk() {
      if (offset >= file.size) {
        mp4.flush();
        if (trackInfo && codecConfigResult) {
          resolve({
            codecConfig: codecConfigResult,
            width: trackInfo.track_width,
            height: trackInfo.track_height,
            durationMs: Math.round((trackInfo.duration / trackInfo.timescale) * 1000),
            samples: samplesArray,
            audioConfig: audioConfigResult,
            audioSamples: audioSamplesArray,
            audioConfigVersion,
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

  worker.postMessage({ type: 'load', file, ...payload });
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

function getAudioDescription(mp4, track) {
  try {
    const trak = mp4.getTrackById(track.id);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      if (entry.esds?.esd?.decoderConfig?.decoderSpecificInfo?.data) {
        const raw = entry.esds.esd.decoderConfig.decoderSpecificInfo.data;
        return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      }
      if (entry.decoderConfig?.decoderSpecificInfo?.data) {
        const raw = entry.decoderConfig.decoderSpecificInfo.data;
        return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      }
    }
  } catch (err) { }
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
  for (const [audioMs] of pendingAudio) {
    if (audioMs < pruneBeforeMs) pendingAudio.delete(audioMs);
  }
}

// ── Playback control ──────────────────────────────────────────────────
export function startPlayback() {
  if (isPlaying) return;
  initAudio();

  isPlaying = true;
  lastRafTs = null;

  nextAudioScheduleTime = 0;
  lastScheduledChunkMs = -1;

  const sortedAudio = Array.from(pendingAudio.entries()).sort((a, b) => a[0] - b[0]);
  for (const [ms, buffer] of sortedAudio) {
    if (ms >= playheadMs - 100) scheduleAudioNode(ms, buffer);
  }

  syncWorkerState();
  rafHandle = requestAnimationFrame(renderLoop);
}

export function pausePlayback() {
  if (!isPlaying && rafHandle === null) return;
  isPlaying = false;
  lastRafTs = null;
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }

  stopAllAudioNodes();
  // Intentionally DO NOT clear pendingAudio here so it resumes instantly
  nextAudioScheduleTime = 0;
  lastScheduledChunkMs = -1;

  syncWorkerState();
  if (window.onPlaybackPaused) window.onPlaybackPaused();
}

export function togglePlayback() {
  isPlaying ? pausePlayback() : startPlayback();
  return isPlaying;
}

export async function seekTo(ms) {
  const wasPlaying = isPlaying;
  if (isPlaying) {
    isPlaying = false;
    lastRafTs = null;
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    stopAllAudioNodes();
  }

  playheadMs = ms;
  pendingFrames.clear();
  pendingAudio.clear(); // Seek clears the cache
  nextAudioScheduleTime = 0;
  lastScheduledChunkMs = -1;

  audioConfigVersion++;
  worker.postMessage({ type: 'set_audio_version', version: audioConfigVersion });
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

// ── Export ────────────────────────────────────────────────────────────────────
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
  if (!window.Mp4Muxer) {
    await loadScript('https://cdn.jsdelivr.net/npm/mp4-muxer@4.4.2/build/mp4-muxer.js');
  }
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
    s.src = src; s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
  });
}
function logStatus(msg) { console.log(`[iKlippa] ${msg}`); if (window.onEngineStatus) window.onEngineStatus(msg); }
export function wireDropTarget(dropEl) { /* omitted for brevity */ }
export function wireFileInput(inputEl) { /* omitted for brevity */ }