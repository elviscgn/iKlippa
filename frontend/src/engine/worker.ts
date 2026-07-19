import init, { IklippaEngine } from './pkg/iklippa_engine';
import { getPorts } from '../adapters';
import type {
  WorkerIncomingMessage,
  EngineErrorCode,
  MP4Sample,
  WorkerLoadCmd,
  WorkerSetGradeCmd,
  WorkerSyncCmd,
  WorkerSetTimelineCmd,
  WorkerSetAudioVersionCmd,
  WorkerSeekCmd,
  WorkerResyncAudioCmd,
  WorkerCompositeCmd,
} from './types';
import type { VideoDecoderPort, AudioDecoderPort } from '../adapters';

// ── Worker-side diagnostic logger ─────────────────────────────────────────────
const DIAG_RING_SIZE = 200;
const diagRing: string[] = [];
function recordDiag(line: string) {
  diagRing.push(line);
  if (diagRing.length > DIAG_RING_SIZE) diagRing.shift();
}

function wlog(tag: string, msg: string, data?: unknown) {
  const line = `[iKlippa:${tag}] ${msg}`;
  recordDiag(line);
  if (data !== undefined) console.log(line, data);
  else console.log(line);
}
function wwarn(tag: string, msg: string, data?: unknown) {
  const line = `[iKlippa:${tag}] ⚠ ${msg}`;
  recordDiag(line);
  if (data !== undefined) console.warn(line, data);
  else console.warn(line);
}
function werr(tag: string, msg: string, data?: unknown) {
  const line = `[iKlippa:${tag}] ✖ ${msg}`;
  recordDiag(line);
  if (data !== undefined) console.error(line, data);
  else console.error(line);
}

// ── Error funnel ──────────────────────────────────────────────────────────────
function reportError(
  code: EngineErrorCode,
  err: unknown,
  opts: { fatal?: boolean; opId?: number } = {},
) {
  const e = err instanceof Error ? err : new Error(String(err));
  werr('error', code, e.message);
  const recent = diagRing.slice(-20).join('\n');
  postMessage({
    type: 'error',
    error: {
      code,
      message: e.message,
      detail: [e.stack, recent ? `--- recent worker log ---\n${recent}` : '']
        .filter(Boolean)
        .join('\n\n'),
      fatal: opts.fatal ?? true,
      opId: opts.opId,
      at: performance.now(),
    },
  });
}

self.onerror = (event, _source, _lineno, _colno, error) => {
  reportError('WORKER_UNCAUGHT', error ?? event);
  return true;
};
self.onunhandledrejection = (ev: PromiseRejectionEvent) => {
  reportError('WORKER_UNHANDLED_REJECTION', ev.reason);
  ev.preventDefault();
};

function codeForFailedMessage(type: string): EngineErrorCode {
  if (type === 'init') return 'WASM_INIT_FAILED';
  if (type === 'load') return 'LOAD_FAILED';
  if (type === 'seek' || type === 'sync') return 'DECODER_VIDEO_FATAL';
  if (type === 'resync_audio') return 'DECODER_AUDIO_FATAL';
  return 'PROTOCOL_ERROR';
}

// ── Multi-source state ────────────────────────────────────────────────────────

interface SourceState {
  file: File;
  codecConfig: VideoDecoderConfig;
  samples: MP4Sample[];
  width: number;
  height: number;
  durationMs: number;
  decoder: VideoDecoderPort | null;
  audioDecoder: AudioDecoderPort | null;
  audioConfig: AudioDecoderConfig | null;
  audioSamples: MP4Sample[];
  lastDecodedSampleIdx: number;
  lastDecodedAudioIdx: number;
  decoderSeeded: boolean;
  globalStartOffsetUs: number;
  isSeeking: boolean;
}

const sourceStates = new Map<string, SourceState>();

let wasmModule: IklippaEngine | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let frameView: Uint8ClampedArray | null = null;

let audioConfigVersion = 0;

// Sync State from Main Thread
let currentPlayheadMs = 0;
let isWorkerPlaying = false;

let offscreenCanvas: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;

let currentSeekId = 0;
let latestSeekId = 0;

let currentWidth = 0;
let currentHeight = 0;

const MAX_DECODE_QUEUE = 8;
const MAX_READS_PER_PUMP = 8;
const AUDIO_LOOKAHEAD_MS = 1000;

// The primary source being decoded. Updated on seek/load.
let primarySourceId: string | null = null;

let isDecodingNext = false;

function refreshFrameView() {
  if (!wasmModule || !wasmMemory) return;
  frameView = new Uint8ClampedArray(
    wasmMemory.buffer,
    wasmModule.frame_ptr(),
    wasmModule.frame_len(),
  );
}

async function handleInit() {
  const wasmExports = await init();
  wasmMemory = wasmExports.memory;
  wlog('worker', 'WASM initialised ✓');
  postMessage({ type: 'status', msg: 'WASM engine running in background worker ✓' });
}

async function handleLoad(msg: WorkerLoadCmd & { audioConfig?: AudioDecoderConfig, audioSamples?: MP4Sample[], audioConfigVersion?: number }) {
  const { file, codecConfig, width, height, samples, durationMs } = msg;
  const sourceId: string = msg.sourceId || 'default';
  currentWidth = width;
  currentHeight = height;
  primarySourceId = sourceId;
  audioConfigVersion = msg.audioConfigVersion || 0;

  wlog(
    'worker',
    `load [${sourceId}]: ${width}×${height} · ${(durationMs / 1000).toFixed(2)}s · ${samples.length} video samples · ${(msg.audioSamples || []).length} audio samples · codec: ${codecConfig.codec}`
  );

  if (!wasmModule) {
    wasmModule = new IklippaEngine(width, height);
  } else {
    wasmModule.resize(width, height);
  }

  refreshFrameView();
  setupOffscreenCanvas(width, height);

  const state: SourceState = {
    file,
    codecConfig,
    samples,
    width,
    height,
    durationMs,
    decoder: null,
    audioDecoder: null,
    audioConfig: msg.audioConfig || null,
    audioSamples: msg.audioSamples || [],
    lastDecodedSampleIdx: -1,
    lastDecodedAudioIdx: -1,
    decoderSeeded: false,
    globalStartOffsetUs: -1,
    isSeeking: false,
  };

  sourceStates.set(sourceId, state);

  await setupDecoder(sourceId, state);
  if (state.audioConfig) {
    await setupAudioDecoder(sourceId, state);
  }

  await seekAndDecodeFrame(sourceId, 0);
  wlog('worker', `ready [${sourceId}] posted`);
  postMessage({ type: 'ready', durationMs, width, height, fileName: msg.fileName, sourceId });
}

async function handleSeek(msg: WorkerSeekCmd) {
  if (msg.seekId !== undefined) {
    currentSeekId = msg.seekId;
  }
  const sid = msg.sourceId || primarySourceId;
  if (!sid || !sourceStates.has(sid)) {
    wwarn('worker', `seek received but no source "${sid}" loaded`);
    return;
  }
  wlog('worker', `seek → ${msg.ms}ms [${sid}]`);
  await seekAndDecodeFrame(sid, msg.ms);
}

async function handleResyncAudio(msg: WorkerResyncAudioCmd) {
  const sid = msg.sourceId || primarySourceId;
  if (!sid) return;
  const state = sourceStates.get(sid);
  if (!state || !state.audioConfig || !state.audioSamples.length) return;

  const ad = state.audioDecoder;
  if (!ad || ad.state === 'closed') {
    await setupAudioDecoder(sid, state);
  } else {
    ad.reset();
    await ad.configure(state.audioConfig);
  }

  wlog('audio', `resync_audio [${sid}] → rewinding decode front to ${msg.ms}ms`);

  let targetIdx = state.audioSamples.length;
  for (let i = 0; i < state.audioSamples.length; i++) {
    const sMs = Math.round((state.audioSamples[i]!.cts * 1000) / state.audioSamples[i]!.timescale);
    if (sMs >= msg.ms) { targetIdx = i; break; }
  }
  state.lastDecodedAudioIdx = Math.max(-1, targetIdx - 1);
  await primeAudioDecode(sid);
}

async function handleSync(msg: WorkerSyncCmd) {
  currentPlayheadMs = msg.playheadMs;
  isWorkerPlaying = msg.isPlaying;

  const sid = msg.sourceId || primarySourceId;
  if (!sid) return;

  if (isWorkerPlaying) {
    if (latestSeekId !== currentSeekId) return;
    await decodeNextSamples(sid);
  }
}

function handleSetAudioVersion(msg: WorkerSetAudioVersionCmd) {
  audioConfigVersion = msg.version;
}

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
    const sid = primarySourceId;
    if (sid) await seekAndDecodeFrame(sid, msg.forceRenderMs);
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

function handleComposite(msg: WorkerCompositeCmd) {
  if (!wasmModule || !wasmMemory) {
    wwarn('worker', 'composite requested but WASM not ready');
    return;
  }
  try {
    wasmModule.compose_at(BigInt(msg.ts_us));
    const len = wasmModule.composite_len();
    const outW = wasmModule.project_width();
    const outH = wasmModule.project_height();
    const ownedPixels = new Uint8ClampedArray(len);
    ownedPixels.set(new Uint8ClampedArray(wasmMemory.buffer, wasmModule.composite_ptr(), len));
    postMessage(
      {
        type: 'composite_result',
        buffer: ownedPixels.buffer,
        ts_us: msg.ts_us,
        width: outW,
        height: outH,
      },
      [ownedPixels.buffer],
    );
  } catch (e) {
    wwarn('worker', 'compose_at failed', String(e));
  }
}

// ── Message scheduler ─────────────────────────────────────────────────────────
const pendingMsgs: any[] = [];
let drainRunning = false;
let drainPromise: Promise<void> = Promise.resolve();

function enqueueMessage(msg: any): Promise<void> {
  if (msg.type === 'sync') {
    const i = pendingMsgs.findIndex((q) => q.type === 'sync');
    if (i >= 0) {
      pendingMsgs[i] = msg;
      return drainPromise;
    }
  }
  pendingMsgs.push(msg);
  if (!drainRunning) drainPromise = drainQueue();
  return drainPromise;
}

async function drainQueue(): Promise<void> {
  drainRunning = true;
  while (pendingMsgs.length > 0) {
    const msg = pendingMsgs.shift()!;
    try {
      await routeMessage(msg);
    } catch (err) {
      reportError(codeForFailedMessage(msg.type), err);
    }
  }
  drainRunning = false;
}

async function routeMessage(msg: any): Promise<void> {
  if (msg.type === 'seek' && msg.seekId !== undefined && msg.seekId !== latestSeekId) {
    wwarn('worker', `skipping obsolete seek ${msg.seekId} (latest is ${latestSeekId})`);
    return;
  }

  if (msg.type === 'init') await handleInit();
  else if (msg.type === 'load') await handleLoad(msg);
  else if (msg.type === 'seek') await handleSeek(msg);
  else if (msg.type === 'resync_audio') await handleResyncAudio(msg);
  else if (msg.type === 'sync') await handleSync(msg);
  else if (msg.type === 'set_audio_version') handleSetAudioVersion(msg);
  else if (msg.type === 'set_grade') await handleSetGrade(msg);
  else if (msg.type === 'set_timeline') handleSetTimeline(msg);
  else if (msg.type === 'get_project_json') handleGetProjectJson();
  else if (msg.type === 'composite') handleComposite(msg);
}

self.onmessage = (e: MessageEvent<any>) => {
  const msg = e.data;
  if (msg.type === 'seek' && msg.seekId !== undefined) {
    latestSeekId = msg.seekId;
  }
  return enqueueMessage(msg);
};

function postMessage(msg: WorkerIncomingMessage, transfer?: Transferable[]) {
  self.postMessage(msg, { transfer });
}

function setupOffscreenCanvas(width: number, height: number) {
  offscreenCanvas = getPorts().offscreenCanvasFactory.create(width, height) as unknown as OffscreenCanvas;
  offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
}

// ── Decoder setup (per-source) ────────────────────────────────────────────────

async function setupAudioDecoder(sourceId: string, state: SourceState) {
  if (state.audioDecoder && state.audioDecoder.state !== 'closed') state.audioDecoder.close();

  state.audioDecoder = getPorts().audioDecoderFactory.create(
    (audioData: AudioData) => {
      if (state.globalStartOffsetUs === -1) {
        state.globalStartOffsetUs = audioData.timestamp;
      }

      const normalizedTsUs = audioData.timestamp - state.globalStartOffsetUs;
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
          sourceId,
          seekId: currentSeekId,
        },
        buffers
      );
    },
    (e) => reportError('DECODER_AUDIO_FATAL', e),
  );

  await state.audioDecoder.configure(state.audioConfig!);
}

async function setupDecoder(sourceId: string, state: SourceState) {
  if (state.decoder && state.decoder.state !== 'closed') state.decoder.close();

  const { width, height } = state;

  state.decoder = getPorts().videoDecoderFactory.create(
    async (videoFrame: VideoFrame) => {
      if (state.globalStartOffsetUs === -1) {
        state.globalStartOffsetUs = videoFrame.timestamp;
      }

      const normalizedTsUs = videoFrame.timestamp - state.globalStartOffsetUs;
      const tsMs = Math.round(normalizedTsUs / 1000);

      if (isWorkerPlaying && tsMs < currentPlayheadMs - 66) {
        videoFrame.close();
        return;
      }

      refreshFrameView();

      if (videoFrame.format === null) {
        offscreenCtx!.drawImage(videoFrame, 0, 0);
        videoFrame.close();
        const imgData = offscreenCtx!.getImageData(0, 0, width, height);
        frameView!.set(imgData.data);
      } else {
        await videoFrame.copyTo(frameView!, { format: 'RGBA' });
        videoFrame.close();
      }

      try {
        wasmModule!.stage_frame_broadcast(BigInt(Math.round(normalizedTsUs)), width, height);
        refreshFrameView();
      } catch (e) {
        wwarn('worker', `stage_frame_broadcast failed @ ${normalizedTsUs}us`, String(e));
      }

      let gradeMs = 0;
      if (!isWorkerPlaying) {
        const gradeStart = performance.now();
        try {
          wasmModule!.process_frame();
        } catch (e) {
          reportError('WASM_PANIC', e, { fatal: true });
          try { state.decoder?.close(); } catch { /* already closed */ }
          return;
        }
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
          sourceId,
          seekId: currentSeekId,
        },
        [ownedPixels.buffer]
      );
    },
    (e) => reportError('DECODER_VIDEO_FATAL', e),
  );

  await state.decoder.configure({
    codec: state.codecConfig.codec,
    codedWidth: width,
    codedHeight: height,
    description: state.codecConfig.description,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: true,
  } as VideoDecoderConfig);
}

// ── Seek & Decode (per-source) ────────────────────────────────────────────────

async function seekAndDecodeFrame(sourceId: string, targetMs: number) {
  const state = sourceStates.get(sourceId);
  if (!state || !state.decoder) return;

  if (state.isSeeking) return;
  state.isSeeking = true;
  state.decoderSeeded = false;

  if (wasmModule) {
    try { wasmModule.reset_frame_cache(); } catch { /* ignore */ }
  }

  try {
    const { samples, file } = state;

    let vKeyIdx = -1;
    for (let i = 0; i < samples.length; i++) {
      const sMs = Math.round((samples[i]!.cts * 1000) / samples[i]!.timescale);
      if (sMs <= targetMs && samples[i]!.is_sync) vKeyIdx = i;
      if (sMs > targetMs) break;
    }
    if (vKeyIdx === -1) {
      for (let i = 0; i < samples.length; i++) {
        if (samples[i]!.is_sync) { vKeyIdx = i; break; }
      }
    }
    if (vKeyIdx === -1) {
      wwarn('seek', `no keyframe found for target ${targetMs}ms [${sourceId}]`);
      return;
    }

    const keyframeMs = Math.round((samples[vKeyIdx]!.cts * 1000) / samples[vKeyIdx]!.timescale);
    wlog('seek', `seekAndDecodeFrame ${targetMs}ms [${sourceId}] — keyframe at sample[${vKeyIdx}] = ${keyframeMs}ms`);

    if (state.decoder.state === 'closed') {
      await setupDecoder(sourceId, state);
    } else {
      state.decoder.reset();
      await state.decoder.configure(state.codecConfig);
    }

    if (state.audioDecoder && state.audioSamples.length > 0) {
      if (state.audioDecoder.state === 'closed') {
        await setupAudioDecoder(sourceId, state);
      } else {
        state.audioDecoder.reset();
        await state.audioDecoder.configure(state.audioConfig!);
      }

      let targetIdx = 0;
      for (let i = 0; i < state.audioSamples.length; i++) {
        const sMs = Math.round((state.audioSamples[i]!.cts * 1000) / state.audioSamples[i]!.timescale);
        if (sMs >= targetMs) { targetIdx = i; break; }
      }
      state.lastDecodedAudioIdx = Math.max(-1, targetIdx - 1);

      primeAudioDecode(sourceId).catch((e: unknown) =>
        reportError('DECODER_AUDIO_FATAL', e)
      );
    }

    let i = vKeyIdx;
    while (i < samples.length) {
      if (latestSeekId !== currentSeekId) {
        wwarn('seek', `aborting in-flight decode for seek ${currentSeekId} because ${latestSeekId} arrived`);
        state.lastDecodedSampleIdx = vKeyIdx - 1;
        break;
      }

      const batchEnd = Math.min(i + MAX_READS_PER_PUMP, samples.length);
      const batch = samples.slice(i, batchEnd);

      const dataPromises = batch.map((s) => readSampleData(file, s));
      const dataArray = await Promise.all(dataPromises);

      let hitTarget = false;
      for (let j = 0; j < batch.length; j++) {
        if (latestSeekId !== currentSeekId) {
          state.lastDecodedSampleIdx = vKeyIdx - 1;
          hitTarget = true;
          break;
        }

        const s = batch[j]!;
        const sMs = Math.round((s.cts * 1000) / s.timescale);

        postMessage({ type: 'decode_submit', ms: sMs });
        state.decoder!.decode(
          new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: (s.cts * 1_000_000) / s.timescale,
            duration: (s.duration * 1_000_000) / s.timescale,
            data: dataArray[j]!,
          })
        );

        if (sMs >= targetMs) {
          state.lastDecodedSampleIdx = i + j;
          hitTarget = true;
          break;
        }
      }
      if (hitTarget) break;
      i = batchEnd;
    }

    state.decoderSeeded = true;
  } finally {
    state.isSeeking = false;
  }
}

async function primeAudioDecode(sourceId: string) {
  const state = sourceStates.get(sourceId);
  if (!state) return;
  const { audioDecoder, audioSamples, file } = state;
  if (!audioDecoder || audioDecoder.state !== 'configured') return;
  if (!audioSamples.length) return;

  const startIdx = state.lastDecodedAudioIdx + 1;
  if (startIdx >= audioSamples.length) return;

  const startMs = Math.round((audioSamples[startIdx]!.cts * 1000) / audioSamples[startIdx]!.timescale);
  const targetMs = startMs + 600;

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
    state.lastDecodedAudioIdx = i;
  }
}

async function decodeNextSamples(sourceId: string) {
  const state = sourceStates.get(sourceId);
  if (!state || !state.decoder) return;

  if (state.decoder.state === 'closed') {
    await setupDecoder(sourceId, state);
  }
  if (state.decoder.state !== 'configured') return;
  if (!state.decoderSeeded || state.isSeeking || isDecodingNext) return;

  isDecodingNext = true;

  const { samples, file } = state;

  if (state.audioDecoder && state.audioDecoder.state === 'closed' && state.audioConfig) {
    await setupAudioDecoder(sourceId, state);
  }
  if (state.audioDecoder && state.audioDecoder.state === 'configured' && state.audioSamples.length > 0) {
    let audioReads = 0;
    while (state.audioDecoder.decodeQueueSize < MAX_DECODE_QUEUE && audioReads < MAX_READS_PER_PUMP) {
      const startIdx = state.lastDecodedAudioIdx + 1;
      if (startIdx >= state.audioSamples.length) break;
      const s = state.audioSamples[startIdx]!;
      const sMs = Math.round((s.cts * 1000) / s.timescale);
      if (sMs > currentPlayheadMs + AUDIO_LOOKAHEAD_MS) break;
      const data = await readSampleData(file, s);
      audioReads++;
      if (latestSeekId !== currentSeekId) { isDecodingNext = false; return; }
      state.audioDecoder.decode(
        new EncodedAudioChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: (s.cts * 1_000_000) / s.timescale,
          duration: (s.duration * 1_000_000) / s.timescale,
          data,
        })
      );
      state.lastDecodedAudioIdx = startIdx;
    }
  }

  let videoReads = 0;
  while (state.decoder.decodeQueueSize < MAX_DECODE_QUEUE && videoReads < MAX_READS_PER_PUMP) {
    const startIdx = state.lastDecodedSampleIdx + 1;
    if (startIdx >= samples.length) break;
    const s = samples[startIdx]!;
    const data = await readSampleData(file, s);
    videoReads++;
    if (latestSeekId !== currentSeekId) { isDecodingNext = false; return; }
    postMessage({ type: 'decode_submit', ms: Math.round((s.cts * 1000) / s.timescale) });
    state.decoder.decode(
      new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: (s.cts * 1_000_000) / s.timescale,
        duration: (s.duration * 1_000_000) / s.timescale,
        data,
      })
    );
    state.lastDecodedSampleIdx = startIdx;
  }

  isDecodingNext = false;
}

function readSampleData(file: File, sample: MP4Sample): Promise<ArrayBuffer> {
  return getPorts().sampleReader.readSampleData(file, sample);
}
