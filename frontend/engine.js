/**
 * iKlippa — engine.js
 * The JavaScript video pipeline. Coordinates:
 *   1. File import → MP4Box.js demux
 *   2. WebCodecs VideoDecoder (hardware-accelerated)
 *   3. Zero-copy WASM memory bridge → Rust pixel processing
 *   4. requestAnimationFrame canvas render loop
 *   5. WebCodecs VideoEncoder → mux → download
 */

const WASM_PATH = './pkg/iklippa_engine.js';
const PREVIEW_TARGET_FPS = 60;

let wasmModule = null;
let wasmMemory = null;
let frameView = null;

let decoder = null;

let canvas = null;
let ctx = null;

let isPlaying = false;
let playheadMs = 0;
let lastRafTs = null;
let rafHandle = null;

let clips = [];
let pendingFrames = new Map();
let sourceVideoWidth = 0;
let sourceVideoHeight = 0;

let isDecoding = false;
let lastDecodedSampleIdx = -1;
let decoderSeeded = false;

let isExporting = false;
let exportFrames = [];

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

  sourceVideoWidth = width;
  sourceVideoHeight = height;

  if (!wasmModule) {
    wasmModule = new window.__IklippaEngine(width, height);
    refreshFrameView();
  } else {
    wasmModule.resize(width, height);
    refreshFrameView();
  }

  canvas.width = width;
  canvas.height = height;

  const clipId = wasmModule.add_clip(0, 0, durationMs, 0);
  clips = [];
  clips.push({
    id: clipId, startMs: 0, endMs: durationMs, sourceOffsetMs: 0,
    track: 0, file, codecConfig, samples
  });

  setupDecoder(codecConfig, width, height);

  logStatus(`Ready: ${width}×${height} · ${(durationMs / 1000).toFixed(2)}s · ${codecConfig.codec}`);

  await seekAndDecodeFrame(0);

  if (window.onClipImported) window.onClipImported({ clipId, width, height, durationMs });
}

// ── Demux ─────────────────────────────────────────────────────────────────────

function demuxFile(file) {
  return new Promise((resolve, reject) => {
    const mp4 = MP4Box.createFile();
    let resolved = false;

    mp4.onReady = (info) => {
      const track = info.videoTracks[0];
      if (!track) { reject(new Error('No video track found')); return; }

      const codecConfig = {
        codec: track.codec,
        codedWidth: track.track_width,
        codedHeight: track.track_height,
        description: getDecoderDescription(mp4, track),
      };

      mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      mp4.start();

      const samples = [];
      mp4.onSamples = (trackId, user, s) => { samples.push(...s); };

      const chunkSize = 2 * 1024 * 1024;
      let offset = 0;

      function readChunk() {
        const slice = file.slice(offset, offset + chunkSize);
        const reader = new FileReader();
        reader.onload = (e) => {
          const buf = e.target.result;
          buf.fileStart = offset;
          mp4.appendBuffer(buf);
          offset += chunkSize;
          if (offset < file.size) {
            readChunk();
          } else {
            mp4.flush();
            if (!resolved) {
              resolved = true;
              resolve({
                codecConfig,
                width: track.track_width,
                height: track.track_height,
                durationMs: Math.round((track.duration / track.timescale) * 1000),
                samples,
              });
            }
          }
        };
        reader.readAsArrayBuffer(slice);
      }
      readChunk();
    };

    mp4.onError = reject;

    const initialSlice = file.slice(0, 4 * 1024 * 1024);
    const reader = new FileReader();
    reader.onload = (e) => {
      const buf = e.target.result;
      buf.fileStart = 0;
      mp4.appendBuffer(buf);
    };
    reader.readAsArrayBuffer(initialSlice);
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

      await videoFrame.copyTo(frameView, { format: 'RGBA' });
      videoFrame.close();

      wasmModule.process_frame();

      const imageData = new ImageData(
        new Uint8ClampedArray(wasmMemory.buffer, wasmModule.frame_ptr(), wasmModule.frame_len()),
        width,
        height
      );

      pendingFrames.set(tsMs, imageData);

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
    codec: codecConfig.codec,
    codedWidth: width,
    codedHeight: height,
    description: codecConfig.description,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: true,
  });
}

// ── Seek & Decode ─────────────────────────────────────────────────────────────

async function seekAndDecodeFrame(targetMs) {
  if (!clips.length || !decoder) return;
  if (isDecoding) return;
  isDecoding = true;
  decoderSeeded = false;

  const clip = clips[0];
  const { samples, file } = clip;

  // Find nearest keyframe at or before targetMs
  let keyframeIdx = 0;
  for (let i = 0; i < samples.length; i++) {
    const sMs = Math.round((samples[i].cts / samples[i].timescale) * 1000);
    if (sMs <= targetMs && samples[i].is_sync) keyframeIdx = i;
    if (sMs > targetMs) break;
  }

  // Full reset then reconfigure — required before feeding a new keyframe
  decoder.reset();
  decoder.configure({
    codec: clip.codecConfig.codec,
    codedWidth: sourceVideoWidth,
    codedHeight: sourceVideoHeight,
    description: clip.codecConfig.description,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: true,
  });

  // Feed from keyframe up to targetMs
  for (let i = keyframeIdx; i < samples.length; i++) {
    const s = samples[i];
    const sMs = Math.round((s.cts / s.timescale) * 1000);
    const data = await readSampleData(file, s);

    decoder.decode(new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: s.cts * (1_000_000 / s.timescale),
      duration: s.duration * (1_000_000 / s.timescale),
      data,
    }));

    if (sMs >= targetMs) {
      lastDecodedSampleIdx = i;
      break;
    }
  }

  // No flush() — leave decoder open so decodeNextSamples can continue
  decoderSeeded = true;
  isDecoding = false;
}

async function decodeNextSamples(fromMs, count = 5) {
  if (!clips.length || !decoder || isDecoding) return;
  if (decoder.state !== 'configured') return;
  if (!decoderSeeded) return;
  isDecoding = true;

  const clip = clips[0];
  const { samples, file } = clip;

  const startIdx = lastDecodedSampleIdx + 1;
  if (startIdx >= samples.length) { isDecoding = false; return; }

  let fed = 0;
  for (let i = startIdx; i < samples.length && fed < count; i++) {
    const s = samples[i];
    const data = await readSampleData(file, s);

    decoder.decode(new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: s.cts * (1_000_000 / s.timescale),
      duration: s.duration * (1_000_000 / s.timescale),
      data,
    }));

    lastDecodedSampleIdx = i;
    fed++;
  }

  isDecoding = false;
}

function readSampleData(file, sample) {
  return new Promise((resolve, reject) => {
    const slice = file.slice(sample.offset, sample.offset + sample.size);
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(slice);
  });
}

// ── Render Loop ───────────────────────────────────────────────────────────────

function renderLoop(ts) {
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

  decodeNextSamples(playheadMs, 3).catch(console.error);

  if (window.onPlayheadUpdate) window.onPlayheadUpdate(playheadMs);

  rafHandle = requestAnimationFrame(renderLoop);
}

function paintFrameAtTime(ms) {
  if (!ctx) return;

  let bestMs = -1;
  for (const [frameMs] of pendingFrames) {
    if (frameMs <= ms && frameMs > bestMs) bestMs = frameMs;
  }

  if (bestMs >= 0) {
    const imageData = pendingFrames.get(bestMs);
    ctx.putImageData(imageData, 0, 0);
  }

  const pruneBeforeMs = ms - 2000;
  for (const [frameMs] of pendingFrames) {
    if (frameMs < pruneBeforeMs) pendingFrames.delete(frameMs);
  }
}

// ── Playback Controls ─────────────────────────────────────────────────────────

export function startPlayback() {
  if (isPlaying || !wasmModule) return;
  isPlaying = true;
  lastRafTs = null;
  rafHandle = requestAnimationFrame(renderLoop);
}

export function pausePlayback() {
  isPlaying = false;
  lastRafTs = null;
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
}

export function togglePlayback() {
  isPlaying ? pausePlayback() : startPlayback();
}

export async function seekTo(ms) {
  playheadMs = ms;
  lastDecodedSampleIdx = -1;
  decoderSeeded = false;
  pendingFrames.clear();
  await seekAndDecodeFrame(ms);
  paintFrameAtTime(ms);
  if (window.onPlayheadUpdate) window.onPlayheadUpdate(ms);
}

// ── Colour Grade Bridge ───────────────────────────────────────────────────────

export function setColorGrade(params) {
  if (!wasmModule) return;
  if (params.exposure !== undefined) wasmModule.set_exposure(params.exposure);
  if (params.contrast !== undefined) wasmModule.set_contrast(params.contrast);
  if (params.saturation !== undefined) wasmModule.set_saturation(params.saturation);
  if (params.temperature !== undefined) wasmModule.set_temperature(params.temperature);
  if (params.highlights !== undefined) wasmModule.set_highlights(params.highlights);
  if (params.shadows !== undefined) wasmModule.set_shadows(params.shadows);
  if (params.vignette !== undefined) wasmModule.set_vignette(params.vignette);
  if (params.grain !== undefined) wasmModule.set_grain(params.grain);
  if (params.lut !== undefined) wasmModule.set_lut(params.lut);

  if (!isPlaying) {
    seekAndDecodeFrame(playheadMs).catch(console.error);
  }
}

// ── Export Pipeline ───────────────────────────────────────────────────────────

export async function exportVideo(onProgress) {
  if (!wasmModule || !clips.length) { logStatus('Nothing to export'); return; }
  if (isExporting) return;

  pausePlayback();
  isExporting = true;
  exportFrames = [];

  const durationMs = wasmModule.duration_ms();
  const frameMs = 1000 / 30;
  const totalFrames = Math.ceil(durationMs / frameMs);

  logStatus('Export: collecting frames…');

  for (let i = 0; i < totalFrames; i++) {
    const ms = Math.round(i * frameMs);
    pendingFrames.clear();
    lastDecodedSampleIdx = -1;
    decoderSeeded = false;
    await seekAndDecodeFrame(ms);
    await sleep(16);
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
    codec: 'avc1.42001f',
    width: sourceVideoWidth,
    height: sourceVideoHeight,
    bitrate: 8_000_000,
    framerate: 30,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
  });

  const sortedFrames = exportFrames.slice().sort((a, b) => a.ms - b.ms);

  for (let i = 0; i < sortedFrames.length; i++) {
    const { ms, imageData } = sortedFrames[i];
    const frame = new VideoFrame(imageData, {
      timestamp: ms * 1000,
      duration: frameMs * 1000,
    });
    encoder.encode(frame, { keyFrame: i % 60 === 0 });
    frame.close();
    if (onProgress) onProgress(0.5 + (i / sortedFrames.length) * 0.5);
  }

  await encoder.flush();
  encoder.close();

  logStatus('Export: muxing…');

  if (!window.Mp4Muxer) {
    await loadScript('https://cdn.jsdelivr.net/npm/mp4-muxer@4.4.2/build/mp4-muxer.js');
  }

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: sourceVideoWidth, height: sourceVideoHeight },
    fastStart: 'in-memory',
  });

  for (const { buf, timestamp, type } of encodedChunks) {
    muxer.addVideoChunkRaw(buf, type, timestamp, frameMs * 1000);
  }

  const { buffer } = muxer.finalize();
  const blob = new Blob([buffer], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `iklippa-export-${Date.now()}.mp4`;
  a.click();
  URL.revokeObjectURL(url);

  isExporting = false;
  exportFrames = [];
  logStatus('Export complete ✓');
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function refreshFrameView() {
  const ptr = wasmModule.frame_ptr();
  const len = wasmModule.frame_len();
  frameView = new Uint8ClampedArray(wasmMemory.buffer, ptr, len);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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