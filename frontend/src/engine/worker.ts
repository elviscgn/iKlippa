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

// ── Worker-side diagnostic logger ─────────────────────────────────────────────
// Every log line is also kept in a ring buffer that is attached to error
// reports, so a crash can be diagnosed without reproducing it.
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
// THE rule: every failure in this worker leaves through reportError() and
// becomes a visible toast on the main thread. Never console-error-and-
// continue — that is how silent bugs are born.
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

// Last-resort nets: anything we forgot to catch still reaches the UI.
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

let currentSeekId = 0;
let latestSeekId = 0;

let currentWidth = 0;
let currentHeight = 0;

const MAX_DECODE_QUEUE = 8;
// Max file reads per decodeNextSamples() call. Each read is an awaited slice
// of the file; an unbounded pump can hold the serial queue for 100ms+ and
// starve every message behind it.
const MAX_READS_PER_PUMP = 8;
// Never decode audio further than this past the playhead. Without a cap the
// audio front runs arbitrarily far ahead (decoding the whole file during
// playback), which both explodes the main thread's scheduled-node list and
// means a pause discards audio the worker will never re-send.
const AUDIO_LOOKAHEAD_MS = 1000;

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
  globalStartOffsetUs = -1;
  const { file, codecConfig, width, height, samples, durationMs } = msg;
  currentWidth = width;
  currentHeight = height;
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
  await setupDecoder(codecConfig, width, height);
  if (audioConfig) await setupAudioDecoder(audioConfig);

  await seekAndDecodeFrame(0);
  wlog('worker', `ready posted — pendingFrames now sending to main thread`);
  postMessage({ type: 'ready', durationMs, width, height });
}

async function handleSeek(msg: WorkerSeekCmd) {
  if (msg.seekId !== undefined) {
    currentSeekId = msg.seekId;
  }
  if (clips.length === 0) {
    wwarn('worker', 'seek received but no clips loaded yet');
    return;
  }
  wlog('worker', `seek → ${msg.ms}ms`);
  await seekAndDecodeFrame(msg.ms);
}

async function handleResyncAudio(msg: WorkerResyncAudioCmd) {
  if (!audioConfig) return;
  if (!audioSamples.length || !clips.length) return;
  if (!audioDecoder || audioDecoder.state === 'closed') {
    await setupAudioDecoder(audioConfig);
  } else {
    audioDecoder.reset();
    await audioDecoder.configure(audioConfig);
  }

  // The main thread dropped all scheduled/cached audio on pause. Rewind the
  // decode front to the playhead so those chunks are re-sent exactly once.
  wlog('audio', `resync_audio → rewinding decode front to ${msg.ms}ms`);

  let targetIdx = audioSamples.length;
  for (let i = 0; i < audioSamples.length; i++) {
    const sMs = Math.round((audioSamples[i]!.cts * 1000) / audioSamples[i]!.timescale);
    if (sMs >= msg.ms) {
      targetIdx = i;
      break;
    }
  }
  lastDecodedAudioIdx = Math.max(-1, targetIdx - 1);
  await primeAudioDecode();
}

async function handleSync(msg: WorkerSyncCmd) {
  currentPlayheadMs = msg.playheadMs;
  isWorkerPlaying = msg.isPlaying;

  if (isWorkerPlaying) {
    // Skip decodeNextSamples if a newer seek has been queued — this sync
    // is for an aborted seek and the decoded frames would be at the wrong
    // position, wasting time before the next seek can start.
    if (latestSeekId !== currentSeekId) return;
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
// The queue is strictly serial (preserves init → load ordering), but 'sync'
// messages coalesce latest-wins: a sync only carries "where is the playhead
// now", so a stale one is worthless. The main thread fires syncs up to 60×/s
// and each sync handler awaits file reads — without coalescing the queue went
// seconds into debt during playback, and decoded audio/frames arrived so late
// the main thread dropped them as stale (the "audio dies after a few seconds"
// bug). Each message still runs in its own try/catch so one failure can never
// corrupt or block the next.
const pendingMsgs: any[] = [];
let drainRunning = false;
let drainPromise: Promise<void> = Promise.resolve();

function enqueueMessage(msg: any): Promise<void> {
  if (msg.type === 'sync') {
    const i = pendingMsgs.findIndex((q) => q.type === 'sync');
    if (i >= 0) {
      pendingMsgs[i] = msg; // latest-wins, keeps queue position
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

export async function setupAudioDecoder(config: AudioDecoderConfig) {
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
          seekId: currentSeekId,
        },
        buffers
      );
    },
    (e) => reportError('DECODER_AUDIO_FATAL', e),
  );

  await audioDecoder.configure(config);
}

export async function setupDecoder(codecConfig: VideoDecoderConfig, width: number, height: number) {
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

      // Refresh the WASM pool view — any previous operation (set_timeline,
      // stage_frame_broadcast, process_frame) may have grown the heap and
      // detached the buffer.
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

      // Stage the raw frame for each matching timeline clip so compose_at
      // can find it by clip_id later.
      try {
        wasmModule!.stage_frame_broadcast(BigInt(Math.round(normalizedTsUs)), width, height);
        refreshFrameView();
      } catch (e) {
        // Non-fatal: the compositor will just skip this frame.
        wwarn('worker', `stage_frame_broadcast failed @ ${normalizedTsUs}us`, String(e));
      }

      let gradeMs = 0;
      if (!isWorkerPlaying) {
        const gradeStart = performance.now();
        try {
          wasmModule!.process_frame();
        } catch (e) {
          // A Rust panic poisons the WASM module (panic=abort): every later
          // call throws. Report fatal and kill the decoder — the main thread
          // surfaces a toast and resets instead of starving silently.
          reportError('WASM_PANIC', e, { fatal: true });
          try {
            decoder?.close();
          } catch {
            // already closed
          }
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
          seekId: currentSeekId,
        },
        [ownedPixels.buffer]
      );
    },
    (e) => reportError('DECODER_VIDEO_FATAL', e),
  );

  await decoder.configure({
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
    return;
  }
  isSeeking = true;
  decodeSessionId++;
  decoderSeeded = false;

  if (wasmModule) {
    try { wasmModule.reset_frame_cache(); } catch { /* ignore */ }
  }

  try {
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
      return;
    }

    const keyframeMs = Math.round((samples[vKeyIdx]!.cts * 1000) / samples[vKeyIdx]!.timescale);
    wlog('seek', `seekAndDecodeFrame ${targetMs}ms — keyframe at sample[${vKeyIdx}] = ${keyframeMs}ms`);

    if (decoder && decoder.state === 'closed') {
      await setupDecoder(clips[0]!.codecConfig, currentWidth, currentHeight);
    } else {
      decoder!.reset();
      await decoder!.configure(clips[0]!.codecConfig);
    }

    // Set up audio decoder BEFORE the video loop so audio chunks start
    // arriving during video decode instead of after it.
    if (audioDecoder && audioSamples.length > 0) {
      if (audioDecoder.state === 'closed') {
        await setupAudioDecoder(audioConfig!);
      } else {
        audioDecoder.reset();
        await audioDecoder.configure(audioConfig!);
      }

      let targetIdx = 0;
      for (let i = 0; i < audioSamples.length; i++) {
        const sMs = Math.round((audioSamples[i]!.cts * 1000) / audioSamples[i]!.timescale);
        if (sMs >= targetMs) {
          targetIdx = i;
          break;
        }
      }
      lastDecodedAudioIdx = Math.max(-1, targetIdx - 1);

      // Fire-and-forget: audio chunks start arriving during the video
      // decode loop (each await readSampleData yields to microtasks).
      primeAudioDecode().catch((e: unknown) =>
        reportError('DECODER_AUDIO_FATAL', e)
      );
    }

    // Batch file reads: pre-fetch up to MAX_READS_PER_PUMP samples in parallel,
    // then decode them sequentially.  This avoids waiting for one file read
    // before starting the next — the I/O is the bottleneck, not the decode.
    let i = vKeyIdx;
    while (i < samples.length) {
      if (latestSeekId !== currentSeekId) {
        wwarn('seek', `aborting in-flight decode for seek ${currentSeekId} because ${latestSeekId} arrived`);
        lastDecodedSampleIdx = vKeyIdx - 1;
        break;
      }

      const batchEnd = Math.min(i + MAX_READS_PER_PUMP, samples.length);
      const batch = samples.slice(i, batchEnd);

      const dataPromises = batch.map((s) => readSampleData(file, s));
      const dataArray = await Promise.all(dataPromises);

      let hitTarget = false;
      for (let j = 0; j < batch.length; j++) {
        if (latestSeekId !== currentSeekId) {
          wwarn('seek', `aborting in-flight decode for seek ${currentSeekId} because ${latestSeekId} arrived`);
          lastDecodedSampleIdx = vKeyIdx - 1;
          hitTarget = true;
          break;
        }

        const s = batch[j]!;
        const sMs = Math.round((s.cts * 1000) / s.timescale);

        postMessage({ type: 'decode_submit', ms: sMs });
        decoder!.decode(
          new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: (s.cts * 1_000_000) / s.timescale,
            duration: (s.duration * 1_000_000) / s.timescale,
            data: dataArray[j]!,
          })
        );

        if (sMs >= targetMs) {
          lastDecodedSampleIdx = i + j;
          hitTarget = true;
          break;
        }
      }
      if (hitTarget) break;
      i = batchEnd;
    }

    decoderSeeded = true;
  } finally {
    isSeeking = false;
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
  if (!clips.length || !decoder) return;
  if (decoder.state === 'closed') {
    await setupDecoder(clips[0]!.codecConfig, currentWidth, currentHeight);
  }
  if (decoder.state !== 'configured') return;
  if (!decoderSeeded || isSeeking || isDecodingNext) return;

  isDecodingNext = true;
  const session = decodeSessionId;
  const { samples, file } = clips[0]!;

  // ── Audio first (cheaper, more urgent for A/V sync) ──────────────
  if (audioDecoder && audioDecoder.state === 'closed' && audioConfig) {
    await setupAudioDecoder(audioConfig);
  }
  if (audioDecoder && audioDecoder.state === 'configured' && audioSamples.length > 0) {
    let audioReads = 0;
    while (audioDecoder.decodeQueueSize < MAX_DECODE_QUEUE && audioReads < MAX_READS_PER_PUMP) {
      const startIdx = lastDecodedAudioIdx + 1;
      if (startIdx >= audioSamples.length) break;
      const s = audioSamples[startIdx]!;
      const sMs = Math.round((s.cts * 1000) / s.timescale);
      if (sMs > currentPlayheadMs + AUDIO_LOOKAHEAD_MS) break; // stay near the playhead
      const data = await readSampleData(file, s);
      audioReads++;
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
  let videoReads = 0;
  while (decoder.decodeQueueSize < MAX_DECODE_QUEUE && videoReads < MAX_READS_PER_PUMP) {
    const startIdx = lastDecodedSampleIdx + 1;
    if (startIdx >= samples.length) break;
    const s = samples[startIdx]!;
    const data = await readSampleData(file, s);
    videoReads++;
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