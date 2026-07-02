// worker.js
import init, { IklippaEngine } from './pkg/iklippa_engine.js';

let wasmModule = null;
let wasmMemory = null;
let frameView = null;
let decoder = null;

let clips = [];
let isSeeking = false;
let isDecodingNext = false;
let lastDecodedSampleIdx = -1;
let decoderSeeded = false;

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

        if (!wasmModule) {
            wasmModule = new IklippaEngine(width, height);
        } else {
            wasmModule.resize(width, height);
        }

        frameView = new Uint8ClampedArray(wasmMemory.buffer, wasmModule.frame_ptr(), wasmModule.frame_len());
        clips = [{ file, codecConfig, samples }];

        setupDecoder(codecConfig, width, height);
        await seekAndDecodeFrame(0);
        self.postMessage({ type: 'ready', durationMs, width, height });
    }

    else if (type === 'seek') {
        await seekAndDecodeFrame(data.ms);
    }

    else if (type === 'decode_next') {
        await decodeNextSamples(data.count);
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

function setupDecoder(codecConfig, width, height) {
    if (decoder && decoder.state !== 'closed') decoder.close();

    decoder = new VideoDecoder({
        output: async (videoFrame) => {
            const tsMs = Math.round(videoFrame.timestamp / 1000);

            // The slow NV12 to RGBA conversion happens here, safely off the main thread!
            await videoFrame.copyTo(frameView, { format: 'RGBA' });
            videoFrame.close();

            const gradeStart = performance.now();
            wasmModule.process_frame();
            const gradeMs = performance.now() - gradeStart;

            // Extract the finished pixels
            const len = wasmModule.frame_len();
            const ownedPixels = new Uint8ClampedArray(len);
            ownedPixels.set(new Uint8ClampedArray(wasmMemory.buffer, wasmModule.frame_ptr(), len));

            // ZERO-COPY TRANSFER: Hand the memory back to the UI thread
            self.postMessage({
                type: 'frame',
                ms: tsMs,
                gradeMs,
                buffer: ownedPixels.buffer
            }, [ownedPixels.buffer]);
        },
        error: (e) => console.error('[Worker Decoder]', e),
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

async function seekAndDecodeFrame(targetMs) {
    if (!clips.length || !decoder) return;
    if (isSeeking) return;
    isSeeking = true;
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
        codec: codecConfig.codec,
        codedWidth: codecConfig.codedWidth,
        codedHeight: codecConfig.codedHeight,
        description: codecConfig.description,
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true,
    });

    for (let i = keyframeIdx; i < samples.length; i++) {
        const s = samples[i];
        const sMs = Math.round((s.cts / s.timescale) * 1000);
        const data = await readSampleData(file, s);
        const tsUs = s.cts * (1_000_000 / s.timescale);

        self.postMessage({ type: 'decode_submit', ms: Math.round(tsUs / 1000) });

        decoder.decode(new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: tsUs,
            duration: s.duration * (1_000_000 / s.timescale),
            data,
        }));

        if (sMs >= targetMs) {
            lastDecodedSampleIdx = i;
            break;
        }
    }
    decoderSeeded = true;
    isSeeking = false;
}

async function decodeNextSamples(count) {
    if (!clips.length || !decoder || decoder.state !== 'configured') return;
    if (!decoderSeeded || isSeeking || isDecodingNext) return;
    if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE) return;

    isDecodingNext = true;
    const { samples, file } = clips[0];
    const startIdx = lastDecodedSampleIdx + 1;

    if (startIdx >= samples.length) { isDecodingNext = false; return; }

    let fed = 0;
    for (let i = startIdx; i < samples.length && fed < count; i++) {
        if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE) break;

        const s = samples[i];
        const data = await readSampleData(file, s);
        const tsUs = s.cts * (1_000_000 / s.timescale);

        self.postMessage({ type: 'decode_submit', ms: Math.round(tsUs / 1000) });

        decoder.decode(new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: tsUs,
            duration: s.duration * (1_000_000 / s.timescale),
            data,
        }));

        lastDecodedSampleIdx = i;
        fed++;
    }
    isDecodingNext = false;
}

function readSampleData(file, sample) {
    return file.slice(sample.offset, sample.offset + sample.size).arrayBuffer();
}