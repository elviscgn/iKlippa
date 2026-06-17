// worker.js (Phase 3: Multi-Track Decoder Pool & Compositing)
import init, { IklippaEngine } from './pkg/iklippa_engine.js';

let wasmModule = null;
let wasmMemory = null;
let baseFrameView = null;

const fileRegistry = new Map();
const decoderPool = new Map();

let pendingSeekMs = null;
let currentPlayheadMs = 0;
let isWorkerPlaying = false;
let pendingDecodesForPlayhead = new Set();

self.onmessage = async (e) => {
    const { type, ...data } = e.data;

    if (type === 'init') {
        const wasmExports = await init();
        wasmMemory = wasmExports.memory;
        self.postMessage({ type: 'status', msg: 'WASM engine running in background worker ✓' });
    }
    else if (type === 'register_file') {
        const { fileId, file, codecConfig, samples, width, height, durationMs } = data;
        fileRegistry.set(fileId, { file, codecConfig, samples });

        // Initialize or resize WASM engine based on actual video dimensions
        if (!wasmModule) {
            wasmModule = new IklippaEngine(width, height);
        } else {
            wasmModule.resize(width, height);
        }

        // Create the JS view of the WASM memory buffer
        baseFrameView = new Uint8ClampedArray(wasmMemory.buffer, wasmModule.frame_ptr(), wasmModule.frame_len());

        // Tell the main thread we have a valid video loaded so it can set sourceVideoWidth
        self.postMessage({ type: 'ready', durationMs, width, height });
    }
    else if (type === 'add_clip') {
        const { fileId, track, startMs, endMs, sourceOffsetMs } = data;
        if (!wasmModule) {
            wasmModule = new IklippaEngine(1920, 1080);
            baseFrameView = new Uint8ClampedArray(wasmMemory.buffer, wasmModule.frame_ptr(), wasmModule.frame_len());
        }
        wasmModule.add_clip(fileId, track, startMs, endMs, sourceOffsetMs);
    }
    else if (type === 'seek') {
        pendingSeekMs = data.ms;
    }
    else if (type === 'sync') {
        currentPlayheadMs = data.playheadMs;
        isWorkerPlaying = data.isPlaying;

        if (pendingSeekMs !== null) {
            currentPlayheadMs = pendingSeekMs;
            pendingSeekMs = null;
            decoderPool.forEach(state => {
                state.videoDecoder.reset();
                state.lastDecodedSampleIdx = -1;
                state.lastDecodedMs = -1;
            });
        }

        // Fetch active clips from Rust via JSON bridge
        const activeClipsJson = wasmModule.get_active_clips_json(currentPlayheadMs);
        const activeClips = JSON.parse(activeClipsJson);

        pendingDecodesForPlayhead.clear();

        for (const clip of activeClips) {
            if (!fileRegistry.has(clip.file_id)) continue;
            const key = `${clip.file_id}_t${clip.track}`;
            pendingDecodesForPlayhead.add(key);
            triggerDecodeForFile(clip.file_id, clip.source_ms, clip.track);
        }

        // If no clips are active, send a black frame
        if (pendingDecodesForPlayhead.size === 0) {
            compositeAndSendFrame();
        }
    }
    else if (type === 'set_grade') {
        if (!wasmModule) return;
        const p = data.params;
        if (p.exposure !== undefined) wasmModule.set_exposure(p.exposure);
        if (p.contrast !== undefined) wasmModule.set_contrast(p.contrast);
        if (p.saturation !== undefined) wasmModule.set_saturation(p.saturation);
        if (p.temperature !== undefined) wasmModule.set_temperature(p.temperature);
        if (p.highlights !== undefined) wasmModule.set_highlights(p.highlights);
        if (p.shadows !== undefined) wasmModule.set_shadows(p.shadows);
        if (p.vignette !== undefined) wasmModule.set_vignette(p.vignette);
        if (p.grain !== undefined) wasmModule.set_grain(p.grain);
        if (p.lut !== undefined) wasmModule.set_lut(p.lut);

        // Force render if paused
        if (data.forceRenderMs !== undefined) {
            compositeAndSendFrame();
        }
    }
};

function getOrCreateDecoder(fileId, track) {
    const key = `${fileId}_t${track}`;
    if (decoderPool.has(key)) return decoderPool.get(key);

    const fileData = fileRegistry.get(fileId);
    const vDecoder = new VideoDecoder({
        output: async (videoFrame) => {
            // Write directly to the shared WASM memory buffer
            await videoFrame.copyTo(baseFrameView, { format: 'RGBA' });
            videoFrame.close();

            pendingDecodesForPlayhead.delete(key);
            if (pendingDecodesForPlayhead.size === 0) {
                compositeAndSendFrame();
            }
        },
        error: (e) => console.error(`[Worker Decoder ${key}]`, e)
    });

    vDecoder.configure(fileData.codecConfig);

    const state = {
        videoDecoder: vDecoder,
        lastDecodedSampleIdx: -1,
        lastDecodedMs: -1,
        track: track
    };
    decoderPool.set(key, state);
    return state;
}

async function triggerDecodeForFile(fileId, targetMs, track) {
    const fileData = fileRegistry.get(fileId);
    let decState = getOrCreateDecoder(fileId, track);

    let startIdx = 0;
    for (let i = 0; i < fileData.samples.length; i++) {
        const sMs = Math.round((fileData.samples[i].cts * 1000) / fileData.samples[i].timescale);
        if (sMs <= targetMs && fileData.samples[i].is_sync) startIdx = i;
        if (sMs > targetMs) break;
    }

    // If seeking backwards, reset decoder
    if (targetMs < (decState.lastDecodedMs || 0) - 500) {
        decState.videoDecoder.reset();
        decState.videoDecoder.configure(fileData.codecConfig);
        decState.lastDecodedSampleIdx = -1;
        decState.lastDecodedMs = -1;
        startIdx = 0;
        for (let i = 0; i < fileData.samples.length; i++) {
            const sMs = Math.round((fileData.samples[i].cts * 1000) / fileData.samples[i].timescale);
            if (sMs <= targetMs && fileData.samples[i].is_sync) startIdx = i;
            if (sMs > targetMs) break;
        }
    }

    const targetEndMs = targetMs + 500;
    for (let i = Math.max(decState.lastDecodedSampleIdx + 1, startIdx); i < fileData.samples.length; i++) {
        const s = fileData.samples[i];
        const sMs = Math.round((s.cts * 1000) / s.timescale);
        if (sMs > targetEndMs) break;

        const data = await readSampleData(fileData.file, s);
        decState.videoDecoder.decode(new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: s.cts * 1_000_000 / s.timescale,
            duration: s.duration * 1_000_000 / s.timescale,
            data,
        }));

        decState.lastDecodedSampleIdx = i;
        decState.lastDecodedMs = sMs;
    }
}

function compositeAndSendFrame() {
    if (!wasmModule) return;

    // Apply color grade to base frame in WASM
    wasmModule.process_frame();

    const len = wasmModule.frame_len();
    const ownedPixels = new Uint8ClampedArray(len);
    // Copy from WASM memory to JS owned buffer
    ownedPixels.set(new Uint8ClampedArray(wasmMemory.buffer, wasmModule.frame_ptr(), len));

    self.postMessage({
        type: 'frame',
        ms: currentPlayheadMs,
        gradeMs: 0,
        buffer: ownedPixels.buffer
    }, [ownedPixels.buffer]);
}

function readSampleData(file, sample) {
    return file.slice(sample.offset, sample.offset + sample.size).arrayBuffer();
}