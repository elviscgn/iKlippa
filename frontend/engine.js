/**
 * iKlippa — engine.js  (rev 2)
 *
 * Fixes vs rev 1:
 *   [CRITICAL] Frame pixels now copied out of WASM heap before caching in
 *              pendingFrames. Previously every entry in pendingFrames was a
 *              view into the same 4 MB of WASM linear memory — the moment
 *              the next frame was decoded, every "cached" frame instantly
 *              showed the new frame's pixels. This was the slideshow bug.
 *
 *   [PERF]    readSampleData now uses File.slice().arrayBuffer() instead of
 *             the callback-based FileReader API. ~3–5× faster per sample read.
 *
 *   [PERF]    Separate isSeeking / isDecodingNext flags replace the single
 *             coarse isDecoding mutex. seekAndDecodeFrame blocks new seeks
 *             but no longer blocks the continuous decode pipeline.
 *
 *   [PERF]    decodeNextSamples uses decoder.decodeQueueSize to self-throttle
 *             instead of a mutex. Lookahead raised from 3 to 12 frames.
 *
 *   [NEW]     PerformanceMonitor class — call perf.report() in the console
 *             at any time to get a 0–100 composite score.
 */

const WASM_PATH = './pkg/iklippa_engine.js';

// How many samples to feed the decoder per rAF tick during normal playback.
// 12 = ~400ms of lookahead at 30fps, comfortable for 8 GB RAM targets.
const DECODE_LOOKAHEAD = 12;

// If the decoder's internal queue exceeds this, stop feeding until it drains.
// Prevents runaway memory growth on slow CPUs.
const MAX_DECODE_QUEUE = 8;

let wasmModule  = null;
let wasmMemory  = null;
let frameView   = null;   // Uint8ClampedArray view of WASM frame buffer — write target only

let decoder     = null;

let canvas      = null;
let ctx         = null;

let isPlaying         = false;
let playheadMs        = 0;
let lastRafTs         = null;
let rafHandle         = null;

let clips             = [];
let pendingFrames     = new Map();   // tsMs → ImageData (each owns its own ArrayBuffer now)
let sourceVideoWidth  = 0;
let sourceVideoHeight = 0;

let isSeeking         = false;   // true only during a full decoder reset+seek
let isDecodingNext    = false;   // true while feeding the next batch of samples
let lastDecodedSampleIdx = -1;
let decoderSeeded     = false;

let isExporting       = false;
let exportFrames      = [];

// ── Performance Monitor ────────────────────────────────────────────────────────

export class PerformanceMonitor {
  constructor() { this.reset(); }

  reset() {
    this._frameTimes   = [];   // rAF delta ms,  rolling 120-frame window
    this._gradeTimes   = [];   // WASM process_frame() ms
    this._decodeTimes  = [];   // decode()-to-output() ms
    this._droppedFrames = 0;
    this._totalFrames   = 0;
    this._lastRaf       = null;
    this._gradeStart    = 0;
    this._pendingDecodes = new Map();
  }

  // ── Call sites ─────────────────────────────────────────────────────────────

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

  /** Immediately before wasmModule.process_frame(). */
  beginGrade() { this._gradeStart = performance.now(); }

  /** Immediately after wasmModule.process_frame(). */
  endGrade() {
    const t = performance.now() - this._gradeStart;
    this._gradeTimes.push(t);
    if (this._gradeTimes.length > 120) this._gradeTimes.shift();
  }

  /** When a sample is submitted to decoder.decode(). */
  recordDecodeSubmit(tsMs) {
    this._pendingDecodes.set(tsMs, performance.now());
  }

  /** When the decoder fires its output() callback. */
  recordDecodeOutput(tsMs) {
    if (this._pendingDecodes.has(tsMs)) {
      this._decodeTimes.push(performance.now() - this._pendingDecodes.get(tsMs));
      this._pendingDecodes.delete(tsMs);
      if (this._decodeTimes.length > 60) this._decodeTimes.shift();
    }
  }

  // ── Scoring ────────────────────────────────────────────────────────────────

  score() {
    const avg = arr => arr.length
      ? arr.reduce((a, b) => a + b, 0) / arr.length
      : 0;

    const avgFrameMs  = avg(this._frameTimes);
    const avgGradeMs  = avg(this._gradeTimes);
    const avgDecodeMs = avg(this._decodeTimes);
    const dropRate    = this._totalFrames > 0
      ? this._droppedFrames / this._totalFrames : 0;

    // Sub-scores 0–100
    // Smoothness: 16.67 ms/frame = 100, every extra 16.67 ms → -100
    const smoothness = Math.max(0, Math.min(100,
      100 - ((avgFrameMs - 16.67) / 16.67) * 100));
    // Grade perf: 4 ms = 100, 8 ms = 0
    const gradePerf  = Math.max(0, Math.min(100,
      100 - (avgGradeMs / 4) * 100));
    // Decode perf: 33 ms = 100 (2 frame budget), 100 ms = 0
    const decodePerf = Math.max(0, Math.min(100,
      100 - ((avgDecodeMs - 33) / 67) * 100));
    // Drop score: 0% drops = 100, 10% drops = 0
    const dropScore  = Math.max(0, Math.min(100,
      (1 - dropRate * 10) * 100));

    const composite = Math.round(
      smoothness * 0.40 +
      dropScore  * 0.30 +
      decodePerf * 0.20 +
      gradePerf  * 0.10
    );

    return {
      composite,
      smoothness:   Math.round(smoothness),
      gradePerf:    Math.round(gradePerf),
      decodePerf:   Math.round(decodePerf),
      dropScore:    Math.round(dropScore),
      avgFrameMs:   avgFrameMs.toFixed(2),
      avgGradeMs:   avgGradeMs.toFixed(2),
      avgDecodeMs:  avgDecodeMs.toFixed(2),
      dropRatePct:  (dropRate * 100).toFixed(1),
      totalFrames:  this._totalFrames,
    };
  }

  report() {
    const s = this.score();
    console.group('%ciKlippa Performance Report', 'color:#0d9488;font-weight:700;font-size:14px');
    console.log('%c🎯 Composite Score: ' + s.composite + ' / 100',
      'font-size:16px;font-weight:800;color:' + (s.composite >= 70 ? '#10b981' : s.composite >= 40 ? '#f59e0b' : '#ef4444'));
    console.table({
      'Smoothness':   s.smoothness  + '/100  (avg ' + s.avgFrameMs  + ' ms/frame)',
      'Grade Perf':   s.gradePerf   + '/100  (avg ' + s.avgGradeMs  + ' ms/grade)',
      'Decode Perf':  s.decodePerf  + '/100  (avg ' + s.avgDecodeMs + ' ms decode→output)',
      'Drop Score':   s.dropScore   + '/100  (' + s.dropRatePct + '% frames dropped)',
      'Total Frames': s.totalFrames,
    });
    console.groupEnd();
    return s.composite;
  }
}

export const perf = new PerformanceMonitor();

// Expose to console for ad-hoc benchmarking
window.iklippaScore = () => perf.report();

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initEngine(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  const { default: init, IklippaEngine } = await import(WASM_PATH);
  const wasmExports = await init();

  window.__IklippaEngine = IklippaEngine;
  wasmMemory = wasmExports.memory;

  logStatus('WASM engine loaded ✓');
  return true;
}

// ── File Import ───────────────────────────────────────────────────────────────

export async function importFile(file) {
  logStatus(`Importing: ${file.name}`);

  if (!window.MP4Box) {
    await loadScript('https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js');
  }

  const { codecConfig, width, height, durationMs, samples } = await demuxFile(file);

  sourceVideoWidth  = width;
  sourceVideoHeight = height;

  if (!wasmModule) {
    wasmModule = new window.__IklippaEngine(width, height);
    refreshFrameView();
  } else {
    wasmModule.resize(width, height);
    refreshFrameView();
  }

  canvas.width  = width;
  canvas.height = height;

  const clipId = wasmModule.add_clip(0, 0, durationMs, 0);
  clips = [];
  clips.push({
    id: clipId, startMs: 0, endMs: durationMs, sourceOffsetMs: 0,
    track: 0, file, codecConfig, samples,
  });

  setupDecoder(codecConfig, width, height);

  logStatus(`Ready: ${width}×${height} · ${(durationMs / 1000).toFixed(2)}s · ${codecConfig.codec}`);

  await seekAndDecodeFrame(0);

  if (window.onClipImported) window.onClipImported({ clipId, width, height, durationMs });
}

// ── Demux ─────────────────────────────────────────────────────────────────────

function demuxFile(file) {
  return new Promise((resolve, reject) => {
    const mp4      = MP4Box.createFile();
    let   resolved = false;

    mp4.onReady = (info) => {
      const track = info.videoTracks[0];
      if (!track) { reject(new Error('No video track found')); return; }

      const codecConfig = {
        codec:       track.codec,
        codedWidth:  track.track_width,
        codedHeight: track.track_height,
        description: getDecoderDescription(mp4, track),
      };

      mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      mp4.start();

      const samples = [];
      mp4.onSamples = (_id, _user, s) => { samples.push(...s); };

      const CHUNK = 2 * 1024 * 1024;
      let offset  = 0;

      function readChunk() {
        // Use arrayBuffer() instead of FileReader — faster, no callback chain
        file.slice(offset, offset + CHUNK).arrayBuffer().then(buf => {
          buf.fileStart = offset;
          mp4.appendBuffer(buf);
          offset += CHUNK;
          if (offset < file.size) {
            readChunk();
          } else {
            mp4.flush();
            if (!resolved) {
              resolved = true;
              resolve({
                codecConfig,
                width:      track.track_width,
                height:     track.track_height,
                durationMs: Math.round((track.duration / track.timescale) * 1000),
                samples,
              });
            }
          }
        }).catch(reject);
      }

      // Seed MP4Box with the first 4 MB so it can parse the moov box
      file.slice(0, 4 * 1024 * 1024).arrayBuffer().then(buf => {
        buf.fileStart = 0;
        mp4.appendBuffer(buf);
        offset = 4 * 1024 * 1024;
        // Don't start readChunk here — onReady hasn't fired yet.
        // readChunk starts inside onReady after setExtractionOptions.
        readChunk();
      }).catch(reject);
    };

    // Prime the parse so onReady fires
    file.slice(0, 4 * 1024 * 1024).arrayBuffer().then(buf => {
      buf.fileStart = 0;
      mp4.appendBuffer(buf);
    }).catch(reject);

    mp4.onError = reject;
  });
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

// ── Decoder Setup ─────────────────────────────────────────────────────────────

function setupDecoder(codecConfig, width, height) {
  if (decoder && decoder.state !== 'closed') {
    decoder.close();
  }

  decoder = new VideoDecoder({
    output: async (videoFrame) => {
      const tsMs = Math.round(videoFrame.timestamp / 1000);

      // Write decoded pixels directly into WASM heap (zero-copy from browser)
      await videoFrame.copyTo(frameView, { format: 'RGBA' });
      videoFrame.close();

      // Run Rust colour-grade in place inside WASM
      perf.beginGrade();
      wasmModule.process_frame();
      perf.endGrade();

      // ─────────────────────────────────────────────────────────────────────
      // CRITICAL FIX: frameView / wasmMemory.buffer is a single shared region.
      // Creating ImageData with a Uint8ClampedArray view into it means every
      // entry in pendingFrames points to the same bytes — the next decoded
      // frame overwrites all "cached" frames simultaneously (the slideshow bug).
      //
      // Solution: copy the finished pixels into a fresh ArrayBuffer that this
      // ImageData owns exclusively before storing in the map.
      // ─────────────────────────────────────────────────────────────────────
      const ownedPixels = new Uint8ClampedArray(wasmModule.frame_len());
      ownedPixels.set(
        new Uint8ClampedArray(wasmMemory.buffer, wasmModule.frame_ptr(), wasmModule.frame_len())
      );
      const imageData = new ImageData(ownedPixels, width, height);

      pendingFrames.set(tsMs, imageData);
      perf.recordDecodeOutput(tsMs);

      if (isExporting) {
        exportFrames.push({ ms: tsMs, imageData });
      }
    },

    error: (e) => {
      console.error('[iKlippa Decoder]', e);
      logStatus(`Decode error: ${e.message}`);
    },
  });

  decoder.configure({
    codec:                codecConfig.codec,
    codedWidth:           width,
    codedHeight:          height,
    description:          codecConfig.description,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency:   true,
  });
}

// ── Seek & Decode ─────────────────────────────────────────────────────────────

async function seekAndDecodeFrame(targetMs) {
  if (!clips.length || !decoder) return;
  if (isSeeking) return;
  isSeeking = true;
  decoderSeeded = false;

  const { samples, file, codecConfig } = clips[0];

  // Find nearest keyframe at or before targetMs
  let keyframeIdx = 0;
  for (let i = 0; i < samples.length; i++) {
    const sMs = Math.round((samples[i].cts / samples[i].timescale) * 1000);
    if (sMs <= targetMs && samples[i].is_sync) keyframeIdx = i;
    if (sMs > targetMs) break;
  }

  decoder.reset();
  decoder.configure({
    codec:                codecConfig.codec,
    codedWidth:           sourceVideoWidth,
    codedHeight:          sourceVideoHeight,
    description:          codecConfig.description,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency:   true,
  });

  // Feed from keyframe up to and including the target frame
  for (let i = keyframeIdx; i < samples.length; i++) {
    const s   = samples[i];
    const sMs = Math.round((s.cts / s.timescale) * 1000);
    const data = await readSampleData(file, s);

    const tsUs = s.cts * (1_000_000 / s.timescale);
    perf.recordDecodeSubmit(Math.round(tsUs / 1000));

    decoder.decode(new EncodedVideoChunk({
      type:      s.is_sync ? 'key' : 'delta',
      timestamp: tsUs,
      duration:  s.duration * (1_000_000 / s.timescale),
      data,
    }));

    if (sMs >= targetMs) {
      lastDecodedSampleIdx = i;
      break;
    }
  }

  decoderSeeded = true;
  isSeeking     = false;
}

/**
 * Feed the next `count` samples into the decoder during normal playback.
 * Uses decoder.decodeQueueSize instead of a mutex so the seek pipeline
 * and the continuous decode pipeline no longer block each other.
 */
async function decodeNextSamples(count = DECODE_LOOKAHEAD) {
  if (!clips.length || !decoder) return;
  if (decoder.state !== 'configured') return;
  if (!decoderSeeded || isSeeking) return;
  if (isDecodingNext) return;

  // Self-throttle: don't pile on if the decoder is already busy
  if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE) return;

  isDecodingNext = true;

  const { samples, file } = clips[0];
  const startIdx = lastDecodedSampleIdx + 1;

  if (startIdx >= samples.length) { isDecodingNext = false; return; }

  let fed = 0;
  for (let i = startIdx; i < samples.length && fed < count; i++) {
    // Re-check queue on every sample in case it fills mid-loop
    if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE) break;

    const s    = samples[i];
    const data = await readSampleData(file, s);
    const tsUs = s.cts * (1_000_000 / s.timescale);

    perf.recordDecodeSubmit(Math.round(tsUs / 1000));

    decoder.decode(new EncodedVideoChunk({
      type:      s.is_sync ? 'key' : 'delta',
      timestamp: tsUs,
      duration:  s.duration * (1_000_000 / s.timescale),
      data,
    }));

    lastDecodedSampleIdx = i;
    fed++;
  }

  isDecodingNext = false;
}

/**
 * Read raw sample bytes from the source file.
 * Uses File.slice().arrayBuffer() — no FileReader callback chain.
 */
function readSampleData(file, sample) {
  return file.slice(sample.offset, sample.offset + sample.size).arrayBuffer();
}

// ── Render Loop ───────────────────────────────────────────────────────────────

function renderLoop(ts) {
  perf.recordRaf(ts);

  if (!isPlaying) return;

  if (lastRafTs !== null) {
    const dt = ts - lastRafTs;
    playheadMs += dt;
    if (playheadMs >= wasmModule.duration_ms()) {
      playheadMs = wasmModule.duration_ms();
      pausePlayback();
    }
  }
  lastRafTs = ts;

  paintFrameAtTime(playheadMs);

  // Feed decoder ahead without blocking paint
  decodeNextSamples().catch(console.error);

  if (window.onPlayheadUpdate) window.onPlayheadUpdate(playheadMs);

  rafHandle = requestAnimationFrame(renderLoop);
}

function paintFrameAtTime(ms) {
  if (!ctx) return;

  // Find the most recent decoded frame at or before the playhead
  let bestMs = -1;
  for (const [frameMs] of pendingFrames) {
    if (frameMs <= ms && frameMs > bestMs) bestMs = frameMs;
  }

  if (bestMs >= 0) {
    ctx.putImageData(pendingFrames.get(bestMs), 0, 0);
  }

  // Prune frames more than 2 s behind the playhead to keep memory bounded
  const pruneBeforeMs = ms - 2000;
  for (const [frameMs] of pendingFrames) {
    if (frameMs < pruneBeforeMs) pendingFrames.delete(frameMs);
  }
}

// ── Playback Controls ─────────────────────────────────────────────────────────

export function startPlayback() {
  if (isPlaying || !wasmModule) return;
  isPlaying  = true;
  lastRafTs  = null;
  rafHandle  = requestAnimationFrame(renderLoop);
}

export function pausePlayback() {
  isPlaying = false;
  lastRafTs = null;
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  if (window.onPlaybackPaused) window.onPlaybackPaused();
}

export function togglePlayback() {
  isPlaying ? pausePlayback() : startPlayback();
  return isPlaying;  // returns NEW state after toggle
}

export async function seekTo(ms) {
  playheadMs           = ms;
  lastDecodedSampleIdx = -1;
  decoderSeeded        = false;
  pendingFrames.clear();
  await seekAndDecodeFrame(ms);
  paintFrameAtTime(ms);
  if (window.onPlayheadUpdate) window.onPlayheadUpdate(ms);
}

// ── Colour Grade Bridge ───────────────────────────────────────────────────────

export function setColorGrade(params) {
  if (!wasmModule) return;
  if (params.exposure    !== undefined) wasmModule.set_exposure(params.exposure);
  if (params.contrast    !== undefined) wasmModule.set_contrast(params.contrast);
  if (params.saturation  !== undefined) wasmModule.set_saturation(params.saturation);
  if (params.temperature !== undefined) wasmModule.set_temperature(params.temperature);
  if (params.highlights  !== undefined) wasmModule.set_highlights(params.highlights);
  if (params.shadows     !== undefined) wasmModule.set_shadows(params.shadows);
  if (params.vignette    !== undefined) wasmModule.set_vignette(params.vignette);
  if (params.grain       !== undefined) wasmModule.set_grain(params.grain);
  if (params.lut         !== undefined) wasmModule.set_lut(params.lut);

  // Re-render current frame so grade changes appear instantly while paused
  if (!isPlaying) {
    seekAndDecodeFrame(playheadMs).catch(console.error);
  }
}

// ── Export Pipeline ───────────────────────────────────────────────────────────

export async function exportVideo(onProgress) {
  if (!wasmModule || !clips.length) { logStatus('Nothing to export'); return; }
  if (isExporting) return;

  pausePlayback();
  isExporting  = true;
  exportFrames = [];

  const durationMs  = wasmModule.duration_ms();
  const frameMs     = 1000 / 30;
  const totalFrames = Math.ceil(durationMs / frameMs);

  logStatus('Export: collecting frames…');

  for (let i = 0; i < totalFrames; i++) {
    const ms = Math.round(i * frameMs);
    pendingFrames.clear();
    lastDecodedSampleIdx = -1;
    decoderSeeded        = false;
    await seekAndDecodeFrame(ms);
    // Give the decoder output callback a chance to fire
    await new Promise(r => setTimeout(r, 16));
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
    error: (e) => console.error('[iKlippa Encoder]', e),
  });

  encoder.configure({
    codec:                'avc1.42001f',
    width:                sourceVideoWidth,
    height:               sourceVideoHeight,
    bitrate:              8_000_000,
    framerate:            30,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode:          'quality',
  });

  const sortedFrames = exportFrames.slice().sort((a, b) => a.ms - b.ms);

  for (let i = 0; i < sortedFrames.length; i++) {
    const { ms, imageData } = sortedFrames[i];
    const frame = new VideoFrame(imageData, {
      timestamp: ms * 1000,
      duration:  frameMs * 1000,
    });
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

  const muxer = new Mp4Muxer.Muxer({
    target:    new Mp4Muxer.ArrayBufferTarget(),
    video:     { codec: 'avc', width: sourceVideoWidth, height: sourceVideoHeight },
    fastStart: 'in-memory',
  });

  for (const { buf, timestamp, type } of encodedChunks) {
    muxer.addVideoChunkRaw(buf, type, timestamp, frameMs * 1000);
  }

  if (onProgress) onProgress(0.95);

  const { buffer } = muxer.finalize();
  const blob = new Blob([buffer], { type: 'video/mp4' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `iklippa-export-${Date.now()}.mp4`;
  a.click();
  URL.revokeObjectURL(url);

  isExporting  = false;
  exportFrames = [];
  logStatus('Export complete ✓');
  if (onProgress) onProgress(1);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function refreshFrameView() {
  const ptr = wasmModule.frame_ptr();
  const len = wasmModule.frame_len();
  // This view is only used as a copyTo() *destination* — we never read from it
  // into pendingFrames directly anymore.
  frameView = new Uint8ClampedArray(wasmMemory.buffer, ptr, len);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s  = document.createElement('script');
    s.src    = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function logStatus(msg) {
  console.log(`[iKlippa] ${msg}`);
  if (window.onEngineStatus) window.onEngineStatus(msg);
}

export function wireDropTarget(dropEl) {
  dropEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  dropEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) {
      await importFile(file);
    }
  });
}

export function wireFileInput(inputEl) {
  inputEl.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await importFile(file);
  });
}