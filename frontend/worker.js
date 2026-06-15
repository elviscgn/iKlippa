// worker.js
import init, { IklippaEngine } from './pkg/iklippa_engine.js';

let wasmModule = null;
let wasmMemory = null;
let frameView = null;
let decoder = null;

let clips = [];
let isSeeking = false;
let pendingSeekMs = null;
let isDecodingNext = false;
let lastDecodedSampleIdx = -1;
let decoderSeeded = false;

let decodeSessionId = 0;

// Sync State from Main Thread
let currentPlayheadMs = 0;
let isWorkerPlaying = false;

let offscreenCanvas = null;
let offscreenCtx = null;

const MAX_DECODE_QUEUE = 8;

self.onmessage = async (e) => {
    const { type, ...data } = e.data;

    if (type === 'init') {
        const wasmExports = await init();
        wasmMemory = wasmExports.memory;
        self.postMessage({ type: 'status', msg: 'WASM engine running in background worker ✓' });
    }

    else if (type === 'load') {
        const { file, codecConfig, width, height, samples, durationMs } = data;
        if (!wasmModule) { wasmModule = new IklippaEngine(width, height); }
        else { wasmModule.resize(width, height); }

        frameView = new Uint8ClampedArray(wasmMemory.buffer, wasmModule.frame_ptr(), wasmModule.frame_len());
        clips = [{ file, codecConfig, samples }];

        setupOffscreenCanvas(width, height);
        setupDecoder(codecConfig, width, height);
        await seekAndDecodeFrame(0);
        self.postMessage({ type: 'ready', durationMs, width, height });
    }

    else if (type === 'seek') {
        await seekAndDecodeFrame(data.ms);
    }

    else if (type === 'sync') {
        currentPlayheadMs = data.playheadMs;
        isWorkerPlaying = data.isPlaying;

        if (isWorkerPlaying && data.framesAhead < 15) {
            await decodeNextSamples();
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

        if (data.forceRenderMs !== undefined) {
            await seekAndDecodeFrame(data.forceRenderMs);
        }
    }
};

function setupOffscreenCanvas(width, height) {
    offscreenCanvas = new OffscreenCanvas(width, height);
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
}

function setupDecoder(codecConfig, width, height) {
    if (decoder && decoder.state !== 'closed') decoder.close();

    decoder = new VideoDecoder({
        output: async (videoFrame) => {
            const tsMs = Math.round(videoFrame.timestamp / 1000);

            // 1. MONITOR THE STUTTER: Track if the worker has to drop frames
            if (isWorkerPlaying && tsMs < currentPlayheadMs - 66) {
                // Send a message to the console so you can SEE it happening
                console.warn(`[Worker] Dropped late frame at ${tsMs}ms to maintain sync`);
                videoFrame.close();
                return;
            }

            if (videoFrame.format === null) {
                offscreenCtx.drawImage(videoFrame, 0, 0);
                videoFrame.close();
                const imgData = offscreenCtx.getImageData(0, 0, width, height);
                frameView.set(imgData.data);
            } else {
                await videoFrame.copyTo(frameView, { format: 'RGBA' });
                videoFrame.close();
            }

            // 2. DRAFT MODE: Only run the heavy 66ms color grade if we are PAUSED or seeking.
            // If we are actively playing, skip it so we can hit 60 FPS!
            let gradeMs = 0;
            if (!isWorkerPlaying) {
                const gradeStart = performance.now();
                wasmModule.process_frame();
                gradeMs = performance.now() - gradeStart;
            }

            const len = wasmModule.frame_len();
            const ownedPixels = new Uint8ClampedArray(len);
            ownedPixels.set(new Uint8ClampedArray(wasmMemory.buffer, wasmModule.frame_ptr(), len));

            self.postMessage({
                type: 'frame', ms: tsMs, gradeMs, buffer: ownedPixels.buffer
            }, [ownedPixels.buffer]);
        },
        error: (e) => console.error('[Worker Decoder]', e),
    });

    decoder.configure({
        codec: codecConfig.codec, codedWidth: width, codedHeight: height,
        description: codecConfig.description, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true,
    });
}

async function seekAndDecodeFrame(targetMs) {
    if (isSeeking) {
        pendingSeekMs = targetMs;
        return;
    }

    isSeeking = true;
    decodeSessionId++; // INVALIDATE ANY ONGOING BACKGROUND DECODES
    decoderSeeded = false;

    const { samples, file, codecConfig } = clips[0];
    let keyframeIdx = 0;
    for (let i = 0; i < samples.length; i++) {
        const sMs = Math.round((samples[i].cts / samples[i].timescale) * 1000);
        if (sMs <= targetMs && samples[i].is_sync) keyframeIdx = i;
        if (sMs > targetMs) break;
    }

    decoder.reset();
    decoder.configure({
        codec: codecConfig.codec, codedWidth: codecConfig.codedWidth, codedHeight: codecConfig.codedHeight,
        description: codecConfig.description, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true,
    });

    for (let i = keyframeIdx; i < samples.length; i++) {
        // BLAZING FAST SCRUB: If user scrubs again while we are decoding this seek, abort instantly!
        if (pendingSeekMs !== null) break;

        const s = samples[i];
        const sMs = Math.round((s.cts / s.timescale) * 1000);
        const data = await readSampleData(file, s);
        const tsUs = s.cts * (1_000_000 / s.timescale);

        self.postMessage({ type: 'decode_submit', ms: Math.round(tsUs / 1000) });
        decoder.decode(new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta', timestamp: tsUs, duration: s.duration * (1_000_000 / s.timescale), data,
        }));

        if (sMs >= targetMs) {
            lastDecodedSampleIdx = i;
            break;
        }
    }

    decoderSeeded = true;
    isSeeking = false;

    if (pendingSeekMs !== null) {
        const nextMs = pendingSeekMs;
        pendingSeekMs = null;
        seekAndDecodeFrame(nextMs); // Execute the newest scrub position
    }
}

async function decodeNextSamples() {
    if (!clips.length || !decoder || decoder.state !== 'configured') return;
    if (!decoderSeeded || isSeeking || isDecodingNext) return;

    isDecodingNext = true;
    const session = decodeSessionId; // Snapshot the current session token
    const { samples, file } = clips[0];

    while (decoder.decodeQueueSize < MAX_DECODE_QUEUE) {
        const startIdx = lastDecodedSampleIdx + 1;
        if (startIdx >= samples.length) break;

        const s = samples[startIdx];

        // This 'await' releases the JS event loop. A 'seek' message can sneak in right here!
        const data = await readSampleData(file, s);

        // THE RACE CONDITION FIX: If a seek wiped the decoder while we were reading the file, ABORT!
        if (session !== decodeSessionId) {
            isDecodingNext = false;
            return;
        }

        const tsUs = s.cts * (1_000_000 / s.timescale);

        self.postMessage({ type: 'decode_submit', ms: Math.round(tsUs / 1000) });

        decoder.decode(new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta', timestamp: tsUs, duration: s.duration * (1_000_000 / s.timescale), data,
        }));

        lastDecodedSampleIdx = startIdx;
    }
    isDecodingNext = false;
}

function readSampleData(file, sample) {
    return file.slice(sample.offset, sample.offset + sample.size).arrayBuffer();
}