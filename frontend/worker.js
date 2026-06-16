// worker.js (Final, Audited, Synchronized)
import init, { IklippaEngine } from './pkg/iklippa_engine.js';

let wasmModule = null;
let wasmMemory = null;
let frameView = null;
let decoder = null;
let audioDecoder = null;

let clips = [];
let audioConfig = null;
let audioSamples = [];

let isSeeking = false;
let pendingSeekMs = null;
let isDecodingNext = false;

let lastDecodedSampleIdx = -1;
let lastDecodedAudioIdx = -1;
let decoderSeeded = false;
let decodeSessionId = 0;
let audioConfigVersion = 0;

// --- THE DISCOVERY FIX ---
// The actual start time of the DECODED audio stream, discovered on the fly.
let discoveredAudioOffsetUs = -1;
let discoveredVideoOffsetUs = -1;

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

        audioConfig = data.audioConfig;
        audioSamples = data.audioSamples || [];
        audioConfigVersion = data.audioConfigVersion || 0;

        // Reset discovery on new file load
        discoveredAudioOffsetUs = -1;
        discoveredVideoOffsetUs = -1;

        setupOffscreenCanvas(width, height);
        setupDecoder(codecConfig, width, height);
        if (audioConfig) setupAudioDecoder(audioConfig);

        await seekAndDecodeFrame(0);
        await primeAudioDecode();
        self.postMessage({ type: 'ready', durationMs, width, height });
    }

    else if (type === 'seek') {
        await seekAndDecodeFrame(data.ms);
        await primeAudioDecode();
    }

    else if (type === 'sync') {
        currentPlayheadMs = data.playheadMs;
        isWorkerPlaying = data.isPlaying;

        if (isWorkerPlaying && data.framesAhead < 15) {
            await decodeNextSamples();
        }
    }

    else if (type === 'set_audio_version') {
        audioConfigVersion = data.version;
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

function setupAudioDecoder(config) {
    if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close();

    audioDecoder = new AudioDecoder({
        output: (audioData) => {
            // Discover the true start time of the audio stream on the first frame
            if (discoveredAudioOffsetUs === -1) {
                discoveredAudioOffsetUs = audioData.timestamp;
            }

            const normalizedTsUs = audioData.timestamp - discoveredAudioOffsetUs;
            const tsMs = Math.round(normalizedTsUs / 1000);

            if (isWorkerPlaying && tsMs < currentPlayheadMs - 200) {
                audioData.close();
                return;
            }

            const channels = audioData.numberOfChannels;
            const sampleRate = audioData.sampleRate;
            const length = audioData.numberOfFrames;
            const format = audioData.format;

            const isPlanar = format.endsWith('-planar');
            const buffers = [];

            if (isPlanar) {
                for (let c = 0; c < channels; c++) {
                    const size = audioData.allocationSize({ planeIndex: c, format: 'f32-planar' });
                    const buf = new ArrayBuffer(size);
                    audioData.copyTo(buf, { planeIndex: c, format: 'f32-planar' });
                    buffers.push(buf);
                }
            } else {
                const size = audioData.allocationSize({ planeIndex: 0, format: 'f32' });
                const buf = new ArrayBuffer(size);
                audioData.copyTo(buf, { planeIndex: 0, format: 'f32' });

                const interleaved = new Float32Array(buf);
                for (let c = 0; c < channels; c++) {
                    const chanBuf = new ArrayBuffer(length * 4);
                    const chanArr = new Float32Array(chanBuf);
                    for (let i = 0; i < length; i++) {
                        chanArr[i] = interleaved[i * channels + c];
                    }
                    buffers.push(chanBuf);
                }
            }

            audioData.close();

            self.postMessage({
                type: 'audio_chunk', ms: tsMs, channels, sampleRate, length, buffers, configVersion: audioConfigVersion
            }, buffers);
        },
        error: e => console.error('[AudioDecoder]', e)
    });

    audioDecoder.configure(config);
}

function setupDecoder(codecConfig, width, height) {
    if (decoder && decoder.state !== 'closed') decoder.close();

    decoder = new VideoDecoder({
        output: async (videoFrame) => {
            // Discover the true start time of the video stream on the first frame
            if (discoveredVideoOffsetUs === -1) {
                discoveredVideoOffsetUs = videoFrame.timestamp;
            }

            const normalizedTsUs = videoFrame.timestamp - discoveredVideoOffsetUs;
            const tsMs = Math.round(normalizedTsUs / 1000);

            if (isWorkerPlaying && tsMs < currentPlayheadMs - 66) {
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
    decodeSessionId++;
    decoderSeeded = false;

    const { samples, file } = clips[0];

    let vKeyIdx = 0;
    for (let i = 0; i < samples.length; i++) {
        // We seek on the RAW file timestamps here
        const sMs = Math.round((samples[i].cts * 1000) / samples[i].timescale);
        if (sMs <= targetMs && samples[i].is_sync) vKeyIdx = i;
        if (sMs > targetMs) break;
    }

    decoder.reset();
    decoder.configure(clips[0].codecConfig);

    for (let i = vKeyIdx; i < samples.length; i++) {
        if (pendingSeekMs !== null) break;

        const s = samples[i];
        const sMs = Math.round((s.cts * 1000) / s.timescale);
        const data = await readSampleData(file, s);

        self.postMessage({ type: 'decode_submit', ms: sMs });
        decoder.decode(new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta', timestamp: s.cts * 1_000_000 / s.timescale, duration: s.duration * 1_000_000 / s.timescale, data,
        }));

        if (sMs >= targetMs) {
            lastDecodedSampleIdx = i;
            break;
        }
    }

    if (audioDecoder && audioSamples.length > 0) {
        audioDecoder.reset();
        audioDecoder.configure(audioConfig);

        let targetIdx = 0;
        for (let i = 0; i < audioSamples.length; i++) {
            const sMs = Math.round((audioSamples[i].cts * 1000) / audioSamples[i].timescale);
            if (sMs >= targetMs) {
                targetIdx = i;
                break;
            }
        }
        lastDecodedAudioIdx = Math.max(-1, targetIdx - 1);
    }

    decoderSeeded = true;
    isSeeking = false;

    if (pendingSeekMs !== null) {
        const nextMs = pendingSeekMs;
        pendingSeekMs = null;
        seekAndDecodeFrame(nextMs);
    }
}

// Add this function
async function primeAudioDecode() {
    if (!audioDecoder || audioDecoder.state !== 'configured') return;
    if (!audioSamples.length || !clips.length) return;

    const { file } = clips[0];
    const startIdx = lastDecodedAudioIdx + 1;
    if (startIdx >= audioSamples.length) return;

    const startMs = Math.round((audioSamples[startIdx].cts * 1000) / audioSamples[startIdx].timescale);
    const targetMs = startMs + 600; // pre-buffer 600ms

    for (let i = startIdx; i < audioSamples.length; i++) {
        const s = audioSamples[i];
        const sMs = Math.round((s.cts * 1000) / s.timescale);
        if (sMs > targetMs) break;

        const data = await readSampleData(file, s);
        audioDecoder.decode(new EncodedAudioChunk({
            type: 'key',
            timestamp: s.cts * 1_000_000 / s.timescale,
            duration: s.duration * 1_000_000 / s.timescale,
            data,
        }));
        lastDecodedAudioIdx = i;
    }
}

async function decodeNextSamples() {
    if (!clips.length || !decoder || decoder.state !== 'configured') return;
    if (!decoderSeeded || isSeeking || isDecodingNext) return;

    isDecodingNext = true;
    const session = decodeSessionId;
    const { samples, file } = clips[0];

    // ── Audio first (cheaper, more urgent for A/V sync) ──────────────
    if (audioDecoder && audioDecoder.state === 'configured' && audioSamples.length > 0) {
        while (audioDecoder.decodeQueueSize < MAX_DECODE_QUEUE) {
            const startIdx = lastDecodedAudioIdx + 1;
            if (startIdx >= audioSamples.length) break;
            const s = audioSamples[startIdx];
            const data = await readSampleData(file, s);
            if (session !== decodeSessionId) { isDecodingNext = false; return; }
            audioDecoder.decode(new EncodedAudioChunk({
                type: 'key',
                timestamp: s.cts * 1_000_000 / s.timescale,
                duration: s.duration * 1_000_000 / s.timescale,
                data,
            }));
            lastDecodedAudioIdx = startIdx;
        }
    }

    // ── Video second ──────────────────────────────────────────────────
    while (decoder.decodeQueueSize < MAX_DECODE_QUEUE) {
        const startIdx = lastDecodedSampleIdx + 1;
        if (startIdx >= samples.length) break;
        const s = samples[startIdx];
        const data = await readSampleData(file, s);
        if (session !== decodeSessionId) { isDecodingNext = false; return; }
        self.postMessage({ type: 'decode_submit', ms: Math.round((s.cts * 1000) / s.timescale) });
        decoder.decode(new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: s.cts * 1_000_000 / s.timescale,
            duration: s.duration * 1_000_000 / s.timescale,
            data,
        }));
        lastDecodedSampleIdx = startIdx;
    }

    isDecodingNext = false;
}

function readSampleData(file, sample) {
    return file.slice(sample.offset, sample.offset + sample.size).arrayBuffer();
}