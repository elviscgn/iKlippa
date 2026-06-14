/**
 * iKlippa — engine.js
 * The JavaScript video pipeline. Coordinates:
 *   1. File import → MP4Box.js demux
 *   2. WebCodecs VideoDecoder (hardware-accelerated)
 *   3. Zero-copy WASM memory bridge → Rust pixel processing
 *   4. requestAnimationFrame canvas render loop
 *   5. WebCodecs VideoEncoder → mux → download
 *
 * MEMORY STRATEGY (read this before touching frame handling):
 * ──────────────────────────────────────────────────────────
 * The WASM module exposes a stable pointer (engine.frame_ptr()) into its
 * linear memory heap. We create ONE Uint8ClampedArray view over that pointer
 * and reuse it every frame. WebCodecs' VideoFrame.copyTo() writes directly
 * into that view — so decoded pixels land inside the WASM heap without any
 * JS-side copy. Rust then processes in-place. We wrap the same memory region
 * in an ImageData for putImageData(). Net allocations per frame: 0.
 *
 * FRAME LIFECYCLE (critical — leaks will OOM the tab):
 * ────────────────────────────────────────────────────
 * VideoDecoder emits VideoFrame objects that hold GPU memory. You MUST call
 * frame.close() after you're done with each frame. We do this inside the
 * output callback immediately after copyTo(). DO NOT store VideoFrame
 * references beyond the decode callback.
 */

// ── Config ────────────────────────────────────────────────────────────────────

const WASM_PATH = './pkg/iklippa_engine.js';
const PREVIEW_TARGET_FPS = 60;

// ── Module State ──────────────────────────────────────────────────────────────

let wasmModule = null;   // The IklippaEngine WASM instance
let wasmMemory = null;   // The WASM linear memory buffer (for zero-copy view)
let frameView = null;    // Uint8ClampedArray view into WASM heap — reused every frame

let decoder = null;      // WebCodecs VideoDecoder
let mp4box = null;       // MP4Box.js demuxer instance

let canvas = null;
let ctx = null;
let offscreenCanvas = null; // OffscreenCanvas for worker-safe 2D ops
let offscreenCtx = null;

// Playback state
let isPlaying = false;
let playheadMs = 0;
let lastRafTs = null;
let rafHandle = null;

// Clip registry — mirrors what's in Rust so JS can drive decode seeks
let clips = []; // { id, startMs, endMs, sourceOffsetMs, track, file, codecConfig }

// Decode pipeline state
let pendingFrames = new Map(); // timestamp_ms → ImageData (processed, ready to paint)
let currentVideoFile = null;
let sourceVideoWidth = 0;
let sourceVideoHeight = 0;

// Export state
let isExporting = false;
let exportEncoder = null;
let exportFrames = []; // { ms, imageData } — collected during export pass
let muxedChunks = [];  // ArrayBuffers from the encoder

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Call this once from index.html after the page loads.
 * Loads the WASM engine and wires up the canvas and file drop target.
 */
export async function initEngine(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  // Load the WASM module compiled by wasm-pack
  const { default: init, IklippaEngine } = await import(WASM_PATH);
  const wasmExports = await init(); // returns the WebAssembly.Instance

  // We'll initialise the engine instance after we know the video resolution.
  // Store constructor for later.
  window.__IklippaEngine = IklippaEngine;

  // Expose wasmMemory so we can create the zero-copy view
  wasmMemory = wasmExports.memory;

  logStatus('WASM engine loaded ✓');
  return true;
}

// ── File Import ───────────────────────────────────────────────────────────────

/**
 * Accepts a File object (from drag-drop or <input type="file">).
 * Demuxes it with MP4Box, creates a VideoDecoder, and registers the clip
 * in the Rust timeline.
 */
export async function importFile(file) {
  currentVideoFile = file;
  logStatus(`Importing: ${file.name}`);

  // Dynamically load MP4Box if not already present
  if (!window.MP4Box) {
    await loadScript('https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js');
  }

  const { codecConfig, width, height, durationMs, samples } = await demuxFile(file);

  sourceVideoWidth = width;
  sourceVideoHeight = height;

  // Now we know the resolution — initialise (or resize) the WASM engine
  if (!wasmModule) {
    wasmModule = new window.__IklippaEngine(width, height);
    // Create the zero-copy view into WASM heap — this pointer is stable
    // as long as we don't call resize() or allocate more WASM memory.
    refreshFrameView();
  } else {
    wasmModule.resize(width, height);
    refreshFrameView();
  }

  // Resize the canvas to match
  canvas.width = width;
  canvas.height = height;

  // Register the clip in Rust timeline (full clip at t=0 on track 0)
  const clipId = wasmModule.add_clip(0, 0, durationMs, 0);
  clips.push({
    id: clipId, startMs: 0, endMs: durationMs, sourceOffsetMs: 0,
    track: 0, file, codecConfig, samples
  });

  // Initialise the WebCodecs decoder for this codec
  setupDecoder(codecConfig, width, height);

  logStatus(`Ready: ${width}×${height} · ${(durationMs / 1000).toFixed(2)}s · ${codecConfig.codec}`);

  // Decode the first frame so the preview canvas isn't black
  await seekAndDecodeFrame(0);

  // Fire UI update hook
  if (window.onClipImported) window.onClipImported({ clipId, width, height, durationMs });
}

// ── Demux ─────────────────────────────────────────────────────────────────────

/**
 * Uses MP4Box.js to parse the container and extract:
 *  - codec string (for VideoDecoder config)
 *  - video track dimensions + duration
 *  - sample array (for seek-by-timestamp decode)
 *
 * Returns a promise that resolves when the moov box is fully parsed.
 */
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
      mp4.onSamples = (trackId, user, s) => {
        samples.push(...s);
      };

      // We need to read the full file for samples — use a FileReader stream
      const chunkSize = 2 * 1024 * 1024; // 2MB chunks
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

    // Start reading
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

/**
 * Extracts the codec-specific description (avcC/hvcC box) needed by VideoDecoder.
 * Without this, the decoder can't initialise for H.264/H.265.
 */
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
  // Close the previous decoder if it exists
  if (decoder && decoder.state !== 'closed') {
    decoder.close();
  }

  decoder = new VideoDecoder({
    /**
     * output callback — THIS IS THE HOT PATH.
     * Called by the browser's decode thread. Must be fast and must close the frame.
     * We synchronously copy pixels into WASM, process, then close.
     */
    output: async (videoFrame) => {
      const tsMs = Math.round(videoFrame.timestamp / 1000);

      // ── ZERO-COPY WRITE INTO WASM HEAP ──
      // copyTo() writes RGBA bytes directly into our pre-allocated WASM buffer.
      // No intermediate JS ArrayBuffer is created.
      await videoFrame.copyTo(frameView, { format: 'RGBA' });

      // Frame GPU memory is released immediately — critical to prevent OOM
      videoFrame.close();

      // ── RUST PROCESSES IN PLACE ──
      // apply_color_grade() reads and writes the same buffer region.
      wasmModule.process_frame();

      // ── SNAPSHOT FOR RENDER ──
      // ImageData wraps the WASM memory view — still no copy of pixel data.
      // putImageData() will DMA this to the GPU compositor.
      const imageData = new ImageData(
        new Uint8ClampedArray(wasmMemory.buffer, wasmModule.frame_ptr(), wasmModule.frame_len()),
        width,
        height
      );

      // Store by timestamp so the render loop can pull the right frame
      pendingFrames.set(tsMs, imageData);

      // If this is during export, collect the frame
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
    hardwareAcceleration: 'prefer-hardware', // Route to GPU decode on integrated graphics
    optimizeForLatency: true,               // Minimise buffering for preview
  });
}

// ── Seek & Decode ─────────────────────────────────────────────────────────────

/**
 * Finds the nearest keyframe at or before `targetMs` in the sample array,
 * then decodes samples forward until we have the frame at `targetMs`.
 *
 * This is the "dirty seek" strategy: always start from a keyframe (IDR)
 * because P/B frames depend on their reference frames.
 */
async function seekAndDecodeFrame(targetMs) {
  if (!clips.length || !decoder) return;
  const clip = clips[0];
  const { samples, file } = clip;

  // Find the keyframe sample at or before targetMs
  let keyframeIdx = 0;
  for (let i = 0; i < samples.length; i++) {
    const sMs = Math.round((samples[i].cts / samples[i].timescale) * 1000);
    if (sMs <= targetMs && samples[i].is_sync) keyframeIdx = i;
    if (sMs > targetMs) break;
  }

  // Reset decoder to accept a fresh keyframe stream
  if (decoder.state === 'configured') {
    decoder.reset();
    decoder.configure({
      codec: clip.codecConfig.codec,
      codedWidth: sourceVideoWidth,
      codedHeight: sourceVideoHeight,
      description: clip.codecConfig.description,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    });
  }

  // Feed samples from keyframe up to and slightly past targetMs
  for (let i = keyframeIdx; i < samples.length; i++) {
    const s = samples[i];
    // Skip non-keyframes at the start — decoder needs a clean IDR first
    if (i === keyframeIdx && !s.is_sync) continue;

    const sMs = Math.round((s.cts / s.timescale) * 1000);

    // Read sample bytes from the file
    const data = await readSampleData(file, s);

    const chunk = new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: s.cts * (1_000_000 / s.timescale), // microseconds
      duration: s.duration * (1_000_000 / s.timescale),
      data,
    });

    decoder.decode(chunk);

    if (sMs >= targetMs) break;
  }

  await decoder.flush();
}

/**
 * Reads raw sample bytes from the source File at the byte offset
 * recorded by MP4Box in the sample object.
 */
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

/**
 * rAF-driven render loop. Advances the playhead in real time,
 * picks the nearest decoded frame, and paints it to the canvas.
 *
 * Frame decode is async and may lag behind the playhead.
 * We always paint the last available frame — this is the same
 * strategy used by browser <video> elements. No frame is "waited for".
 */
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

  // Paint the closest available frame
  paintFrameAtTime(playheadMs);

  // Pre-decode the next 3 frames so they're ready before we need them
  const nextMs = playheadMs + (1000 / PREVIEW_TARGET_FPS) * 3;
  if (!pendingFrames.has(Math.round(nextMs))) {
    seekAndDecodeFrame(nextMs).catch(console.error);
  }

  // Notify UI to update playhead position
  if (window.onPlayheadUpdate) window.onPlayheadUpdate(playheadMs);

  rafHandle = requestAnimationFrame(renderLoop);
}

function paintFrameAtTime(ms) {
  if (!ctx) return;

  // Find the closest decoded frame at or before ms
  let bestMs = -1;
  for (const [frameMs] of pendingFrames) {
    if (frameMs <= ms && frameMs > bestMs) bestMs = frameMs;
  }

  if (bestMs >= 0) {
    const imageData = pendingFrames.get(bestMs);
    ctx.putImageData(imageData, 0, 0);
  }

  // Prune old frames to prevent unbounded memory growth.
  // Keep a 2-second window behind the playhead.
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
  pendingFrames.clear(); // discard all buffered frames — they're for a different position
  await seekAndDecodeFrame(ms);
  paintFrameAtTime(ms);
  if (window.onPlayheadUpdate) window.onPlayheadUpdate(ms);
}

// ── Colour Grade Bridge ───────────────────────────────────────────────────────

/**
 * Update the Rust colour grade. Any subsequent process_frame() calls will
 * use the new parameters. Call this from your colour panel UI controls.
 *
 * @param {object} params - Any subset of: exposure, contrast, saturation,
 *   temperature, highlights, shadows, vignette, grain, lut (0-3)
 */
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

  // Re-render the current frame with new grade immediately
  if (!isPlaying) {
    seekAndDecodeFrame(playheadMs).catch(console.error);
  }
}

// ── Export Pipeline ───────────────────────────────────────────────────────────

/**
 * Encode + mux the full timeline and trigger a download.
 *
 * Strategy:
 *  1. Pause preview playback.
 *  2. Seek through every frame in the timeline, decode + Rust-process each one.
 *  3. Feed processed ImageData pixels into a WebCodecs VideoEncoder.
 *  4. Collect encoded chunks. Use a minimal MP4 muxer to wrap them.
 *  5. Trigger a Blob download.
 *
 * NOTE: For Phase 1 we do a synchronous offline pass (not real-time) so
 * the encode quality is maximised. On a dual-core machine with hardware
 * encoder this should run at 2-4x real-time for 1080p H.264.
 */
export async function exportVideo(onProgress) {
  if (!wasmModule || !clips.length) { logStatus('Nothing to export'); return; }
  if (isExporting) return;

  pausePlayback();
  isExporting = true;
  exportFrames = [];
  muxedChunks = [];

  const durationMs = wasmModule.duration_ms();
  const frameMs = 1000 / 30; // Export at 30fps
  const totalFrames = Math.ceil(durationMs / frameMs);

  logStatus('Export: collecting frames…');

  // Phase A: decode every frame with Rust processing applied
  for (let i = 0; i < totalFrames; i++) {
    const ms = Math.round(i * frameMs);
    pendingFrames.clear();
    await seekAndDecodeFrame(ms);
    await sleep(4); // yield to allow the decode callback to fire
    if (onProgress) onProgress(i / totalFrames * 0.5);
  }

  logStatus('Export: encoding…');

  // Phase B: encode collected frames with WebCodecs VideoEncoder
  const encodedChunks = [];

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const buf = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(buf);
      encodedChunks.push({
        buf, timestamp: chunk.timestamp, type: chunk.type,
        sps: metadata?.decoderConfig?.description
      });
    },
    error: (e) => console.error('[iKlippa Encoder]', e),
  });

  encoder.configure({
    codec: 'avc1.42001f',           // H.264 Baseline — broadest hardware encoder support
    width: sourceVideoWidth,
    height: sourceVideoHeight,
    bitrate: 8_000_000,             // 8 Mbps — good quality on 1080p
    framerate: 30,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
  });

  // Sort collected frames by timestamp
  const sortedFrames = exportFrames.slice().sort((a, b) => a.ms - b.ms);

  for (let i = 0; i < sortedFrames.length; i++) {
    const { ms, imageData } = sortedFrames[i];
    const tsUs = ms * 1000; // microseconds

    // Wrap the ImageData pixels in a VideoFrame
    const frame = new VideoFrame(imageData, {
      timestamp: tsUs,
      duration: frameMs * 1000,
    });

    // Force a keyframe every 2 seconds
    encoder.encode(frame, { keyFrame: i % 60 === 0 });
    frame.close(); // release GPU memory immediately

    if (onProgress) onProgress(0.5 + (i / sortedFrames.length) * 0.5);
  }

  await encoder.flush();
  encoder.close();

  logStatus('Export: muxing…');

  // Phase C: Minimal MP4 mux
  // In Phase 1 we use a simple MP4 muxer library approach.
  // We dynamically load mp4-muxer (lightweight, no server required).
  if (!window.Mp4Muxer) {
    await loadScript('https://cdn.jsdelivr.net/npm/mp4-muxer@4.4.2/build/mp4-muxer.js');
  }

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width: sourceVideoWidth,
      height: sourceVideoHeight,
    },
    fastStart: 'in-memory',
  });

  for (const { buf, timestamp, type } of encodedChunks) {
    muxer.addVideoChunkRaw(buf, type, timestamp, frameMs * 1000);
  }

  const { buffer } = muxer.finalize();

  // Trigger download
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

/**
 * Refreshes the Uint8ClampedArray view into WASM heap.
 * Must be called after any WASM memory growth (e.g. resize()).
 * The WASM linear memory can grow but never shrinks, so after init()
 * in normal operation the view pointer is stable.
 */
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

// ── Drag-and-Drop Wiring ─────────────────────────────────────────────────────

/**
 * Wire up a drop target element. Accepts video files dropped onto it.
 * @param {HTMLElement} dropEl - The element to make a drop target.
 */
export function wireDropTarget(dropEl) {
  dropEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropEl.classList.add('drag-over');
  });

  dropEl.addEventListener('dragleave', () => {
    dropEl.classList.remove('drag-over');
  });

  dropEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropEl.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) {
      await importFile(file);
    } else {
      logStatus('Drop a video file (MP4, MOV, WebM)');
    }
  });
}

/**
 * Wire up a file input element.
 * @param {HTMLInputElement} inputEl
 */
export function wireFileInput(inputEl) {
  inputEl.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await importFile(file);
  });
}