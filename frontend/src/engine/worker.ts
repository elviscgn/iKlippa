import init, { IklippaEngine } from './pkg/iklippa_engine';
import { getPorts } from '../adapters';
import type {
  WorkerIncomingMessage,
  MP4Sample,
  WorkerLoadCmd,
  WorkerSetGradeCmd,
  WorkerSyncCmd,
  WorkerSetTimelineCmd,
  WorkerSetAudioVersionCmd,
  WorkerSeekCmd,
} from './types';

// ── Worker-side diagnostic logger ─────────────────────────────────────────────
function wlog(tag: string, msg: string, data?: unknown) {
  const line = `[iKlippa:${tag}] ${msg}`;
  if (data !== undefined) console.log(line, data);
  else console.log(line);
}
function wwarn(tag: string, msg: string, data?: unknown) {
  const line = `[iKlippa:${tag}] ⚠ ${msg}`;
  if (data !== undefined) console.warn(line, data);
  else console.warn(line);
}
function werr(tag: string, msg: string, data?: unknown) {
  const line = `[iKlippa:${tag}] ✖ ${msg}`;
  if (data !== undefined) console.error(line, data);
  else console.error(line);
}

let wasmModule: IklippaEngine | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let frameView: Uint8ClampedArray | null = null;
import type { VideoDecoderPort, AudioDecoderPort } from '../adapters';

let decoder: VideoDecoderPort | null = null;
let audioDecoder: AudioDecoderPort | null = null;

let clips: { file: File; codecConfig: VideoDecoderConfig; samples: MP4Sample[] }[] = [];
let audioConfig: AudioDecoderConfig | null = null;
let audioSamples: MP4Sample[] = [];

let isSeeking = false;
let pendingSeekMs: number | null = null;
let isDecodingNext = false;

let lastDecodedSampleIdx = -1;
let lastDecodedAudioIdx = -1;
let decoderSeeded = false;
let decodeSessionId = 0;
let audioConfigVersion = 0;

// --- THE DISCOVERY FIX ---
let globalStartOffsetUs = -1;

// Sync State from Main Thread
let currentPlayheadMs = 0;
let isWorkerPlaying = false;

let offscreenCanvas: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;

const MAX_DECODE_QUEUE = 8;

async function handleInit() {
  const wasmExports = await init();
  wasmMemory = wasmExports.memory;
  wlog('worker', 'WASM initialised ✓');
  postMessage({ type: 'status', msg: 'WASM engine running in background worker ✓' });
}

async function handleLoad(msg: WorkerLoadCmd & { audioConfig?: AudioDecoderConfig, audioSamples?: MP4Sample[], audioConfigVersion?: number }) {
  globalStartOffsetUs = -1;
  const { file, codecConfig, width, height, samples, durationMs } = msg;
  wlog(
    'worker',
    `load: ${width}×${height} · ${(durationMs / 1000).toFixed(2)}s · ${samples.length} video samples · ${(msg.audioSamples || []).length} audio samples · codec: ${codecConfig.codec}`
  );
  if (!wasmModule) {
    wasmModule = new IklippaEngine(width, height);
  } else {
    wasmModule.resize(width, height);
  }

  frameView = new Uint8ClampedArray(
    wasmMemory!.buffer,
    wasmModule.frame_ptr(),
    wasmModule.frame_len()
  );
  clips = [{ file, codecConfig, samples }];

  audioConfig = msg.audioConfig || null;
  audioSamples = msg.audioSamples || [];
  audioConfigVersion = msg.audioConfigVersion || 0;

  if (!audioConfig) wwarn('worker', 'no audio track found in this file');

  setupOffscreenCanvas(width, height);
  setupDecoder(codecConfig, width, height);
  if (audioConfig) setupAudioDecoder(audioConfig);

  await seekAndDecodeFrame(0);
  await primeAudioDecode();
  wlog('worker', `ready posted — pendingFrames now sending to main thread`);
  postMessage({ type: 'ready', durationMs, width, height });
}

async function handleSeek(msg: WorkerSeekCmd) {
  if (clips.length === 0) {
    wwarn('worker', 'seek received but no clips loaded yet');
    return;
  }
  wlog('worker', `seek → ${msg.ms}ms`);
  await seekAndDecodeFrame(msg.ms);
  await primeAudioDecode();
}

async function handleSync(msg: WorkerSyncCmd) {
  currentPlayheadMs = msg.playheadMs;
  isWorkerPlaying = msg.isPlaying;

  if (isWorkerPlaying && msg.framesAhead < 15) {
    await decodeNextSamples();
  }
}

function handleSetAudioVersion(msg: WorkerSetAudioVersionCmd) {
  audioConfigVersion = msg.version;
}

// fallow-ignore-next-line complexity
async function handleSetGrade(msg: WorkerSetGradeCmd) {
  if (!wasmModule) return;
  const p = msg.params;
  if (p.exposure !== undefined) wasmModule.set_exposure(p.exposure);
  if (p.contrast !== undefined) wasmModule.set_contrast(p.contrast);
  if (p.saturation !== undefined) wasmModule.set_saturation(p.saturation);
  if (p.temperature !== undefined) wasmModule.set_temperature(p.temperature);
  if (p.highlights !== undefined) wasmModule.set_highlights(p.highlights);
  if (p.shadows !== undefined) wasmModule.set_shadows(p.shadows);
  if (p.vignette !== undefined) wasmModule.set_vignette(p.vignette);
  if (p.grain !== undefined) wasmModule.set_grain(p.grain);
  if (p.lut !== undefined) wasmModule.set_lut(p.lut);

  if (msg.forceRenderMs !== undefined) {
    await seekAndDecodeFrame(msg.forceRenderMs);
  }
}

function handleSetTimeline(msg: WorkerSetTimelineCmd) {
  if (!wasmModule) {
    wwarn('worker', 'set_timeline received but WASM not ready');
    return;
  }
  try {
    wasmModule.set_timeline(msg.json);
    wlog('worker', 'set_timeline OK');
    postMessage({ type: 'timeline_set', ok: true });
  } catch (e) {
    werr('worker', 'set_timeline failed', String(e));
    postMessage({ type: 'timeline_set', ok: false, error: String(e) });
  }
}

function handleGetProjectJson() {
  if (!wasmModule) return;
  const json = wasmModule.to_json();
  postMessage({ type: 'project_json', json });
}

let messageQueue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<any>) => {
  messageQueue = messageQueue.then(async () => {
    const msg = e.data;
    if (msg.type === 'init') await handleInit();
    else if (msg.type === 'load') await handleLoad(msg);
    else if (msg.type === 'seek') await handleSeek(msg);
    else if (msg.type === 'sync') await handleSync(msg);
    else if (msg.type === 'set_audio_version') handleSetAudioVersion(msg);
    else if (msg.type === 'set_grade') await handleSetGrade(msg);
    else if (msg.type === 'set_timeline') handleSetTimeline(msg);
    else if (msg.type === 'get_project_json') handleGetProjectJson();
  }).catch((err) => {
    wwarn('worker', 'error processing message', err);
  });
  return messageQueue;
};

function postMessage(msg: WorkerIncomingMessage, transfer?: Transferable[]) {
  self.postMessage(msg, { transfer });
}

function setupOffscreenCanvas(width: number, height: number) {
  offscreenCanvas = getPorts().offscreenCanvasFactory.create(width, height) as unknown as OffscreenCanvas;
  offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
}

export function setupAudioDecoder(config: AudioDecoderConfig) {
  if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close();

  audioDecoder = getPorts().audioDecoderFactory.create(
    // fallow-ignore-next-line complexity
    (audioData: AudioData) => {
      if (globalStartOffsetUs === -1) {
        globalStartOffsetUs = audioData.timestamp;
      }

      const normalizedTsUs = audioData.timestamp - globalStartOffsetUs;
      const tsMs = Math.round(normalizedTsUs / 1000);

      if (isWorkerPlaying && tsMs < currentPlayheadMs - 200) {
        audioData.close();
        return;
      }

      const channels = audioData.numberOfChannels;
      const sampleRate = audioData.sampleRate;
      const length = audioData.numberOfFrames;
      const format = audioData.format;

      const isPlanar = format && format.endsWith('-planar');
      const buffers: ArrayBuffer[] = [];

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
            chanArr[i] = interleaved[i * channels + c] || 0;
          }
          buffers.push(chanBuf);
        }
      }

      audioData.close();

      postMessage(
        {
          type: 'audio_chunk',
          ms: tsMs,
          channels,
          sampleRate,
          length,
          buffers,
          configVersion: audioConfigVersion,
        },
        buffers
      );
    },
    (e) => console.error('[AudioDecoder]', e),
  );

  audioDecoder.configure(config);
}

export function setupDecoder(codecConfig: VideoDecoderConfig, width: number, height: number) {
  if (decoder && decoder.state !== 'closed') decoder.close();

  decoder = getPorts().videoDecoderFactory.create(
    async (videoFrame: VideoFrame) => {
      if (globalStartOffsetUs === -1) {
        globalStartOffsetUs = videoFrame.timestamp;
      }

      const normalizedTsUs = videoFrame.timestamp - globalStartOffsetUs;
      const tsMs = Math.round(normalizedTsUs / 1000);

      if (isWorkerPlaying && tsMs < currentPlayheadMs - 66) {
        videoFrame.close();
        return;
      }

      if (videoFrame.format === null) {
        offscreenCtx!.drawImage(videoFrame, 0, 0);
        videoFrame.close();
        const imgData = offscreenCtx!.getImageData(0, 0, width, height);
        frameView!.set(imgData.data);
      } else {
        await videoFrame.copyTo(frameView!, { format: 'RGBA' });
        videoFrame.close();
      }

      let gradeMs = 0;
      if (!isWorkerPlaying) {
        const gradeStart = performance.now();
        wasmModule!.process_frame();
        gradeMs = performance.now() - gradeStart;
      }

      const len = wasmModule!.frame_len();
      const ownedPixels = new Uint8ClampedArray(len);
      ownedPixels.set(new Uint8ClampedArray(wasmMemory!.buffer, wasmModule!.frame_ptr(), len));

      postMessage(
        {
          type: 'frame',
          ms: tsMs,
          gradeMs,
          buffer: ownedPixels.buffer,
        },
        [ownedPixels.buffer]
      );
    },
    (e) => console.error('[Worker Decoder]', e),
  );

  decoder.configure({
    codec: codecConfig.codec,
    codedWidth: width,
    codedHeight: height,
    description: codecConfig.description,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: true,
  } as VideoDecoderConfig);
}

// fallow-ignore-next-line complexity
export async function seekAndDecodeFrame(targetMs: number) {
  if (isSeeking) {
    wlog('seek', `seek to ${targetMs}ms queued (already seeking)`);
    pendingSeekMs = targetMs;
    return;
  }

  isSeeking = true;
  decodeSessionId++;
  decoderSeeded = false;

  const { samples, file } = clips[0]!;

  let vKeyIdx = -1;
  for (let i = 0; i < samples.length; i++) {
    const sMs = Math.round((samples[i]!.cts * 1000) / samples[i]!.timescale);
    if (sMs <= targetMs && samples[i]!.is_sync) vKeyIdx = i;
    if (sMs > targetMs) break;
  }
  if (vKeyIdx === -1) {
    for (let i = 0; i < samples.length; i++) {
      if (samples[i]!.is_sync) {
        vKeyIdx = i;
        break;
      }
    }
  }
  if (vKeyIdx === -1) {
    wwarn('seek', `no keyframe found for target ${targetMs}ms`);
    isSeeking = false;
    return;
  }

  const keyframeMs = Math.round((samples[vKeyIdx]!.cts * 1000) / samples[vKeyIdx]!.timescale);
  wlog('seek', `seekAndDecodeFrame ${targetMs}ms — keyframe at sample[${vKeyIdx}] = ${keyframeMs}ms`);
  decoder!.reset();
  decoder!.configure(clips[0]!.codecConfig);

  for (let i = vKeyIdx; i < samples.length; i++) {
    if (pendingSeekMs !== null) break;

    const s = samples[i]!;
    const sMs = Math.round((s.cts * 1000) / s.timescale);
    const data = await readSampleData(file, s);

    postMessage({ type: 'decode_submit', ms: sMs });
    decoder!.decode(
      new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: (s.cts * 1_000_000) / s.timescale,
        duration: (s.duration * 1_000_000) / s.timescale,
        data,
      })
    );

    if (sMs >= targetMs) {
      lastDecodedSampleIdx = i;
      break;
    }
  }

  if (audioDecoder && audioSamples.length > 0) {
    audioDecoder.reset();
    audioDecoder.configure(audioConfig!);

    let targetIdx = 0;
    for (let i = 0; i < audioSamples.length; i++) {
      const sMs = Math.round((audioSamples[i]!.cts * 1000) / audioSamples[i]!.timescale);
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

export async function primeAudioDecode() {
  if (!audioDecoder || audioDecoder.state !== 'configured') return;
  if (!audioSamples.length || !clips.length) return;
  const { file } = clips[0]!;
  const startIdx = lastDecodedAudioIdx + 1;
  if (startIdx >= audioSamples.length) return;

  const startMs = Math.round((audioSamples[startIdx]!.cts * 1000) / audioSamples[startIdx]!.timescale);
  const targetMs = startMs + 600; // pre-buffer 600ms

  for (let i = startIdx; i < audioSamples.length; i++) {
    const s = audioSamples[i]!;
    const sMs = Math.round((s.cts * 1000) / s.timescale);
    if (sMs > targetMs) break;

    const data = await readSampleData(file, s);
    audioDecoder.decode(
      new EncodedAudioChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: (s.cts * 1_000_000) / s.timescale,
        duration: (s.duration * 1_000_000) / s.timescale,
        data,
      })
    );
    lastDecodedAudioIdx = i;
  }
}

// fallow-ignore-next-line complexity
export async function decodeNextSamples() {
  if (!clips.length || !decoder || decoder.state !== 'configured') return;
  if (!decoderSeeded || isSeeking || isDecodingNext) return;

  isDecodingNext = true;
  const session = decodeSessionId;
  const { samples, file } = clips[0]!;

  // ── Audio first (cheaper, more urgent for A/V sync) ──────────────
  if (audioDecoder && audioDecoder.state === 'configured' && audioSamples.length > 0) {
    while (audioDecoder.decodeQueueSize < MAX_DECODE_QUEUE) {
      const startIdx = lastDecodedAudioIdx + 1;
      if (startIdx >= audioSamples.length) break;
      const s = audioSamples[startIdx]!;
      const data = await readSampleData(file, s);
      if (session !== decodeSessionId) {
        isDecodingNext = false;
        return;
      }

      audioDecoder.decode(
        new EncodedAudioChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: (s.cts * 1_000_000) / s.timescale,
          duration: (s.duration * 1_000_000) / s.timescale,
          data,
        })
      );
      lastDecodedAudioIdx = startIdx;
    }
  }

  // ── Video second ──────────────────────────────────────────────────
  while (decoder.decodeQueueSize < MAX_DECODE_QUEUE) {
    const startIdx = lastDecodedSampleIdx + 1;
    if (startIdx >= samples.length) break;
    const s = samples[startIdx]!;
    const data = await readSampleData(file, s);
    if (session !== decodeSessionId) {
      isDecodingNext = false;
      return;
    }
    postMessage({ type: 'decode_submit', ms: Math.round((s.cts * 1000) / s.timescale) });
    decoder.decode(
      new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: (s.cts * 1_000_000) / s.timescale,
        duration: (s.duration * 1_000_000) / s.timescale,
        data,
      })
    );
    lastDecodedSampleIdx = startIdx;
  }

  isDecodingNext = false;
}

function readSampleData(file: File, sample: MP4Sample): Promise<ArrayBuffer> {
  return getPorts().sampleReader.readSampleData(file, sample);
}