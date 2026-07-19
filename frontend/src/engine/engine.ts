/**
 * iKlippa — engine.ts
 * Ported from engine.js to TypeScript with strict types.
 */

import { PerformanceMonitor } from './perf';
import { errorBus, emitLocal, makeEngineError, wasReported } from './errors';
import { loadScript } from '../utils/dom';
import { getPorts } from '../adapters';
import type { EnginePorts, AudioContextPort } from '../adapters';
import type {
  WorkerIncomingMessage,
  EngineError,
  GradeParams,

  MP4Sample,
} from './types';
import type { ClipWithMeta } from '../state/types';

const DECODE_LOOKAHEAD = 12;

// ── Diagnostic logger ───────────────────────────────────────────────────
const _loggedOnce = new Set<string>();

function log(tag: string, msg: string, data?: unknown): void {
  const line = `[iKlippa:${tag}] ${msg}`;
  if (data !== undefined) console.log(line, data);
  else console.log(line);
}

function warn(tag: string, msg: string, data?: unknown): void {
  const line = `[iKlippa:${tag}] ⚠ ${msg}`;
  if (data !== undefined) console.warn(line, data);
  else console.warn(line);
}

function err(tag: string, msg: string, data?: unknown): void {
  const line = `[iKlippa:${tag}] ✖ ${msg}`;
  if (data !== undefined) console.error(line, data);
  else console.error(line);
}

function logOnce(key: string, tag: string, msg: string, data?: unknown): void {
  if (_loggedOnce.has(key)) return;
  _loggedOnce.add(key);
  log(tag, msg, data);
}

// ── Time Mapping Helpers ────────────────────────────────────────────────
function mapTimelineToSourceMs(timelineMs: number): number {
  if (typeof window.IKState === 'undefined' || !window.IKState.isReady()) return timelineMs;
  const clips = window.IKState.getAllVideoClips
    ? window.IKState.getAllVideoClips()
    : window.IKState.getVideoClips();
  for (const clip of clips) {
    const tStart = clip.timeline_start_us / 1000;
    const tEnd = clip.timeline_end_us / 1000;
    if (timelineMs >= tStart && timelineMs < tEnd) {
      return (clip.source_start_us / 1000) + (timelineMs - tStart) * clip.speed;
    }
  }
  return timelineMs;
}

function mapSourceToTimelineMs(sourceMs: number): number | null {
  if (typeof window.IKState === 'undefined' || !window.IKState.isReady()) return sourceMs;
  const clips = window.IKState.getAllVideoClips
    ? window.IKState.getAllVideoClips()
    : window.IKState.getVideoClips();

  // 1. Prioritize mapping through the currently active clip if it matches
  if (currentActiveClipId !== null) {
    const activeClip = clips.find((c) => c.id === currentActiveClipId);
    if (activeClip) {
      const sStart = activeClip.source_start_us / 1000;
      const sEnd = activeClip.source_end_us / 1000;
      if (sourceMs >= sStart && sourceMs <= sEnd) {
        return (activeClip.timeline_start_us / 1000) + (sourceMs - sStart) / activeClip.speed;
      }
    }
  }

  // 2. Fallback to searching all clips
  for (const clip of clips) {
    const sStart = clip.source_start_us / 1000;
    const sEnd = clip.source_end_us / 1000;
    if (sourceMs >= sStart && sourceMs <= sEnd) {
      return (clip.timeline_start_us / 1000) + (sourceMs - sStart) / clip.speed;
    }
  }
  return null;
}

// ── Module state ────────────────────────────────────────────────────────
let worker: Worker | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let currentActiveClipId: number | null = null;

let isPlaying = false;
let playheadMs = 0;
let lastRafTs: number | null = null;
let rafHandle: number | null = null;

let pendingFrames = new Map<number, ImageData>();
let sourceVideoWidth = 0;
let sourceVideoHeight = 0;
let videoDurationMs = 0;

let isExporting = false;
let exportFrames: Array<{ ms: number; imageData: ImageData }> = [];

// ── Web Audio State ─────────────────────────────────────────────────────
let audioCtx: AudioContextPort | null = null;
let pendingAudio = new Map<number, AudioBuffer>();
let scheduledAudioNodes: AudioBufferSourceNode[] = [];
let nextAudioStartTime = 0;
let lastScheduledChunkMs = -1;
let audioConfigVersion = 0;
let audioPlayStartCtxTime = 0;
let audioPlayStartMs = 0;

// ── Thumbnail Capture State ─────────────────────────────────────────────
let currentFileName = '';
let timelineThumbnails: Array<{ ms: number; dataUrl: string }> = [];
let lastThumbnailCaptureMs = -Infinity;
const THUMBNAIL_CAPTURE_INTERVAL = 800;
const MAX_TIMELINE_THUMBNAILS = 60;

// ── Seek target tracking ────────────────────────────────────────────────
let seekTargetMs = -1;
let seekPaintTimeout: ReturnType<typeof setTimeout> | null = null;
let seekGeneration = 0;

// ── Worker sync throttling ──────────────────────────────────────────────
// renderLoop runs at 60fps; posting an identical 'sync' every frame buries
// the worker's serial queue (each sync handler awaits file reads) and delays
// real decode work by seconds. Only post when something material changed.
let lastSyncSig = '';

// ── Pending thumbnail capture callback ──────────────────────────────────
let _pendingThumbCapture: ((frameMs: number) => void) | null = null;

// ── Reusable offscreen canvases for multi-track compositing ─────────────
let _compositeCanvas: HTMLCanvasElement | null = null;
let _compositeCtx: CanvasRenderingContext2D | null = null;
let _frameCanvas: HTMLCanvasElement | null = null;
let _frameCtx: CanvasRenderingContext2D | null = null;

// ── Rust composite output cache ─────────────────────────────────────────
let _rustCompositeBuffer: ArrayBuffer | null = null;
let _rustCompositeTsUs = -1;
let _rustCompositeW = 0;
let _rustCompositeH = 0;

// ── Performance Monitor ─────────────────────────────────────────────────
export const perf = new PerformanceMonitor();
if (typeof window !== 'undefined') {
  (window as any).iklippaScore = () => perf.report();
  // Last-resort net: any main-thread rejection we didn't funnel explicitly
  // still becomes a visible toast (deduped via wasReported).
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    if (wasReported(ev.reason)) return;
    errorBus.emit(makeEngineError('UNHANDLED_REJECTION', ev.reason, { fatal: false }));
  });
  // Bridge: every engine error reaches the UI layer.
  errorBus.on((e) => window.onEngineError?.(e));
}

// ── Thumbnail Capture ───────────────────────────────────────────────────
function maybeCaptureThumbnail(ms: number): void {
  if (!canvas || canvas.width === 0 || canvas.height === 0) return;
  if (videoDurationMs === 0) return;
  if (ms - lastThumbnailCaptureMs < THUMBNAIL_CAPTURE_INTERVAL) return;
  if (timelineThumbnails.length >= MAX_TIMELINE_THUMBNAILS) return;
  try {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.35);
    timelineThumbnails.push({ ms, dataUrl });
    lastThumbnailCaptureMs = ms;
    if (window.onThumbnailsUpdated) window.onThumbnailsUpdated(timelineThumbnails);
  } catch (e) {
    warn('thumb', 'canvas.toDataURL failed (tainted?)', (e as Error).message);
  }
}

function captureThumbnail(): string | null {
  if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
  try {
    return canvas.toDataURL('image/jpeg', 0.5);
  } catch {
    return null;
  }
}

// fallow-ignore-next-line complexity
export function captureThumbnailFromBuffer(ms: number): string | null {
  if (!canvas || !ctx) {
    warn('thumb', 'captureThumbnailFromBuffer: canvas/ctx not ready');
    return null;
  }
  if (pendingFrames.size === 0) return null;

  let bestMs = -1;
  for (const [frameMs] of pendingFrames) {
    if (frameMs <= ms && frameMs > bestMs) bestMs = frameMs;
  }
  if (bestMs < 0) {
    for (const [frameMs] of pendingFrames) {
      if (bestMs < 0 || frameMs < bestMs) bestMs = frameMs;
    }
  }
  if (bestMs < 0) return null;

  const imageData = pendingFrames.get(bestMs);
  if (!imageData) return null;

  ctx.putImageData(imageData, 0, 0);
  try {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
    log('thumb', `captured from pendingFrames[${bestMs}ms] → ${dataUrl.length} bytes`);
    return dataUrl;
  } catch (e) {
    err('thumb', 'toDataURL failed', (e as Error).message);
    return null;
  }
}

function getThumbnails(): Array<{ ms: number; dataUrl: string }> {
  return timelineThumbnails;
}

function getCurrentFileName(): string {
  return currentFileName;
}

export function setPendingThumbCapture(cb: (frameMs: number) => void): void {
  _pendingThumbCapture = cb;
}

// ── Init & Worker Bridge ────────────────────────────────────────────────
export async function initEngine(canvasEl: HTMLCanvasElement): Promise<boolean> {
  canvas = canvasEl;
  ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = (e) => {
    err('engine', 'Worker threw an uncaught error', e.message);
    errorBus.emit(makeEngineError('WORKER_DIED', e.message, { fatal: true }));
  };
  worker.onmessageerror = (e) => {
    // Fires when a worker message fails structured clone (e.g. a broken
    // Transferable). Was completely invisible before.
    err('engine', 'Worker posted an unserializable message', e);
    errorBus.emit(
      makeEngineError('PROTOCOL_ERROR', new Error('worker message could not be deserialized'), {
        fatal: true,
      }),
    );
  };
  worker.postMessage({ type: 'init' });
  log('engine', 'Worker created, waiting for WASM init…');
  logStatus('Booting background worker…');
  return true;
}

async function initAudio(): Promise<void> {
  if (!audioCtx) {
    audioCtx = getPorts().audioContextFactory.create();
    log('audio', `AudioContext created (sampleRate: ${audioCtx.sampleRate}Hz)`);
  }
  if (audioCtx.state !== 'running') {
    await audioCtx.resume();
    log('audio', `AudioContext resumed → state: ${audioCtx.state}`);
  }
}

function handleWorkerReady(msg: Extract<WorkerIncomingMessage, { type: 'ready' }>): void {
  videoDurationMs = msg.durationMs;
  sourceVideoWidth = msg.width;
  sourceVideoHeight = msg.height;
  if (canvas) {
    canvas.width = sourceVideoWidth;
    canvas.height = sourceVideoHeight;
  }
  log(
    'engine',
    `ready — ${sourceVideoWidth}×${sourceVideoHeight} · ${(videoDurationMs / 1000).toFixed(2)}s · pendingFrames: ${pendingFrames.size}`,
  );
  logStatus(
    `Ready: ${sourceVideoWidth}×${sourceVideoHeight} · ${(videoDurationMs / 1000).toFixed(2)}s`,
  );
  if (window.onClipImported) {
    window.onClipImported({
      width: sourceVideoWidth,
      height: sourceVideoHeight,
      durationMs: videoDurationMs,
      fileName: currentFileName,
    });
  }
}

function handleWorkerFrame(msg: Extract<WorkerIncomingMessage, { type: 'frame' }>): void {
  if (msg.seekId !== undefined && msg.seekId !== seekGeneration) {
    log('paint', `dropping stale frame from seek ${msg.seekId} (current: ${seekGeneration})`);
    return;
  }
  perf.recordFrameArrival(msg.ms, msg.gradeMs);
  const arr = new Uint8ClampedArray(msg.buffer);
  pendingFrames.set(
    msg.ms,
    new ImageData(arr, sourceVideoWidth, sourceVideoHeight),
  );
  if (isExporting)
    exportFrames.push({ ms: msg.ms, imageData: pendingFrames.get(msg.ms)! });

  // Fire pending thumbnail capture
  if (_pendingThumbCapture) {
    const cb = _pendingThumbCapture;
    _pendingThumbCapture = null;
    try {
      cb(msg.ms);
    } catch (e) {
      err('thumb', 'pendingThumbCapture callback threw', (e as Error).message);
    }
  }

  if (seekTargetMs >= 0 && msg.ms >= seekTargetMs - 33) {
    log('seek', `frame ${msg.ms}ms reached target ${seekTargetMs}ms → painting`);
    if (seekPaintTimeout) clearTimeout(seekPaintTimeout);
    seekTargetMs = -1;
    if (!isPlaying) {
      paintFrameAtTime(playheadMs);
    }
  }
}

function handleWorkerAudioChunk(msg: Extract<WorkerIncomingMessage, { type: 'audio_chunk' }>): void {
  if (msg.seekId !== undefined && msg.seekId !== seekGeneration) {
    log('audio', `dropping stale audio chunk from seek ${msg.seekId} (current: ${seekGeneration})`);
    return;
  }
  if (!audioCtx) {
    logOnce('audio-ctx-missing', 'audio', 'audio_chunk received but AudioContext not initialised yet');
    return;
  }
  if (msg.configVersion !== audioConfigVersion) return;
  // Anchor the audio clock to the moment the first chunk actually arrives,
  // not the moment seekTo/startPlayback fired.  The video decode loop
  // (seekAndDecodeFrame) can take 100-300ms; if we already set
  // audioPlayStartCtxTime back then, every chunk arrives "stale" and gets
  // dropped.  Setting it here means the first chunk always lands on time.
  if (nextAudioStartTime === 0) {
    audioPlayStartCtxTime = audioCtx.currentTime;
  }
  const audioBuffer = audioCtx.createBuffer(msg.channels, msg.length, msg.sampleRate);
  for (let c = 0; c < msg.channels; c++) {
    audioBuffer.copyToChannel(new Float32Array(msg.buffers[c]!), c);
  }
  pendingAudio.set(msg.ms, audioBuffer);
  if (isPlaying) {
    scheduleAudioNode(msg.ms, audioBuffer);
  }
}

export function handleWorkerMessage(e: MessageEvent<WorkerIncomingMessage>): void {
  const msg = e.data;

  switch (msg.type) {
    case 'status':
      logStatus(msg.msg);
      break;
    case 'ready':
      handleWorkerReady(msg);
      break;
    case 'decode_submit':
      perf.recordDecodeSubmit(msg.ms);
      break;
    case 'frame':
      handleWorkerFrame(msg);
      break;
    case 'audio_chunk':
      handleWorkerAudioChunk(msg);
      break;
    case 'timeline_set':
      if (msg.ok) log('rust', 'Timeline synced to Rust ✓');
      else err('rust', 'Timeline sync failed', msg.error);
      if (window.onTimelineSynced) window.onTimelineSynced(msg.ok, msg.error);
      break;
    case 'project_json':
      if (window.onProjectJsonReceived) window.onProjectJsonReceived(msg.json);
      break;
    case 'composite_result':
      _rustCompositeBuffer = msg.buffer;
      _rustCompositeTsUs = msg.ts_us;
      _rustCompositeW = msg.width;
      _rustCompositeH = msg.height;
      break;
    case 'error':
      handleEngineError(msg.error);
      break;
  }
}

/** Every worker-reported failure is logged in full, then emitted to the UI. */
function handleEngineError(e: EngineError): void {
  err('engine', `worker reported ${e.code}${e.fatal ? ' (fatal)' : ''}`, e.detail ?? e.message);
  errorBus.emit(e);
}

function scheduleAudioNode(chunkMs: number, audioBuffer: AudioBuffer): void {
  if (!audioCtx) return;
  const timelineMs = mapSourceToTimelineMs(chunkMs);
  if (timelineMs === null) return; // Drop audio outside active clip bounds

  const idealCtxTime = audioPlayStartCtxTime + (timelineMs - audioPlayStartMs) / 1000;
  if (nextAudioStartTime === 0 || nextAudioStartTime < audioCtx.currentTime) {
    nextAudioStartTime = Math.max(audioCtx.currentTime, idealCtxTime);
  }
  if (idealCtxTime < audioCtx.currentTime - 0.15) {
    logOnce(
      `audio-stale-${Math.round(chunkMs / 1000)}`,
      'audio',
      `dropping stale chunk at source ${chunkMs}ms (timeline ${timelineMs.toFixed(0)}ms)`,
    );
    return;
  }
  if (idealCtxTime > nextAudioStartTime + 0.05) nextAudioStartTime = idealCtxTime;
  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioCtx.destination);
  // Keep scheduledAudioNodes bounded: without removal, thousands of finished
  // nodes accumulate over a playback session (GC pressure + stop-all cost).
  source.onended = () => {
    const i = scheduledAudioNodes.indexOf(source);
    if (i >= 0) scheduledAudioNodes.splice(i, 1);
  };
  source.start(nextAudioStartTime);
  nextAudioStartTime += audioBuffer.duration;
  scheduledAudioNodes.push(source);
}

function stopAllAudioNodes(): void {
  scheduledAudioNodes.forEach((n) => {
    try {
      n.stop();
    } catch {
      // already stopped
    }
  });
  scheduledAudioNodes = [];
}

// ── Demux ─────────────────────────────────────────────────────────────
export async function importFile(file: File): Promise<void> {
  log('import', `importFile: "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
  logStatus(`Importing: ${file.name}`);
  currentFileName = file.name;
  timelineThumbnails = [];
  lastThumbnailCaptureMs = -Infinity;
  seekTargetMs = -1;
  if (seekPaintTimeout) clearTimeout(seekPaintTimeout);
  _pendingThumbCapture = null;
  _loggedOnce.clear();

  initAudio();
  pendingFrames.clear();
  pendingAudio.clear();
  stopAllAudioNodes();
  nextAudioStartTime = 0;
  lastScheduledChunkMs = -1;
  audioConfigVersion++;
  playheadMs = 0;
  isPlaying = false;
  lastRafTs = null;

  if (!window.MP4Box) {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js');
    } catch (e) {
      emitLocal('DEMUX_FAILED', e, { fatal: true });
      throw e;
    }
  }

  const payload = await new Promise<{
    codecConfig: VideoDecoderConfig & { description?: ArrayBuffer };
    width: number;
    height: number;
    durationMs: number;
    samples: MP4Sample[];
    audioConfig: AudioDecoderConfig | null;
    audioSamples: MP4Sample[];
    audioConfigVersion: number;
  }>((resolve, reject) => {
    const mp4 = (window as unknown as { MP4Box: { createFile: () => MP4BoxFile } }).MP4Box.createFile();
    let trackInfo: MP4BoxVideoTrack | null = null;
    let audioTrackInfo: MP4BoxAudioTrack | null = null;
    let codecConfigResult: (VideoDecoderConfig & { description?: ArrayBuffer }) | null = null;
    let audioConfigResult: AudioDecoderConfig | null = null;
    const samplesArray: MP4Sample[] = [];
    const audioSamplesArray: MP4Sample[] = [];

    mp4.onReady = (info: MP4BoxInfo) => {
      const track = info.videoTracks[0];
      const aTrack = info.audioTracks[0];
      if (!track) {
        reject(new Error('No video track found'));
        return;
      }
      trackInfo = track;
      audioTrackInfo = aTrack ?? null;
      codecConfigResult = {
        codec: track.codec,
        codedWidth: track.track_width,
        codedHeight: track.track_height,
        description: getDecoderDescription(mp4, track),
      };
      mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      if (aTrack) {
        const audioDesc = getAudioDescription(mp4, aTrack);
        audioConfigResult = {
          codec: aTrack.codec,
          sampleRate: aTrack.audio.sample_rate,
          numberOfChannels: aTrack.audio.channel_count,
          ...(audioDesc ? { description: audioDesc } : {}),
        };
        mp4.setExtractionOptions(aTrack.id, null, { nbSamples: Infinity });
      }
      mp4.start();
    };

    mp4.onSamples = (id: number, _user: unknown, s: MP4Sample[]) => {
      if (trackInfo && id === trackInfo.id) samplesArray.push(...s);
      else if (audioTrackInfo && id === audioTrackInfo.id) audioSamplesArray.push(...s);
    };

    mp4.onError = (e: string) => reject(new Error('MP4Box error: ' + e));

    const CHUNK = 2 * 1024 * 1024;
    let offset = 0;
    function readNextChunk(): void {
      if (offset >= file.size) {
        mp4.flush();
        if (trackInfo && codecConfigResult) {
          let durationSec = (trackInfo as MP4BoxVideoTrack & { duration: number; timescale: number }).duration /
            (trackInfo as MP4BoxVideoTrack & { duration: number; timescale: number }).timescale;
          if (durationSec === 0 && samplesArray.length > 0) {
            const last = samplesArray[samplesArray.length - 1]!;
            durationSec = (last.cts + last.duration) / last.timescale;
          }
          if (durationSec === 0 && audioSamplesArray.length > 0) {
            const last = audioSamplesArray[audioSamplesArray.length - 1]!;
            durationSec = (last.cts + last.duration) / last.timescale;
          }
          resolve({
            codecConfig: codecConfigResult!,
            width: trackInfo.track_width,
            height: trackInfo.track_height,
            durationMs: Math.round(durationSec * 1000),
            samples: samplesArray,
            audioConfig: audioConfigResult,
            audioSamples: audioSamplesArray,
            audioConfigVersion,
          });
        } else {
          reject(new Error('Failed to find video metadata'));
        }
        return;
      }
      file
        .slice(offset, offset + CHUNK)
        .arrayBuffer()
        .then((buf) => {
          (buf as ArrayBuffer & { fileStart: number }).fileStart = offset;
          mp4.appendBuffer(buf);
          offset += CHUNK;
          readNextChunk();
        })
        .catch(reject);
    }
    readNextChunk();
  }).catch((e) => {
    // Demux failures used to depend on the caller remembering to catch.
    // Report with a specific code, then rethrow — the window last-resort
    // net dedupes via wasReported so this toasts exactly once.
    emitLocal('DEMUX_FAILED', e, { fatal: true });
    throw e;
  });

  worker!.postMessage({ type: 'load', file, ...payload });
}

function getDecoderDescription(
  mp4: MP4BoxFile,
  track: MP4BoxVideoTrack,
): ArrayBuffer | undefined {
  const trak = mp4.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const ds = new (window as unknown as { DataStream: new (buffer?: ArrayBuffer, offset?: number, endian?: number) => { buffer: ArrayBuffer } }).DataStream(
        undefined,
        0,
        0, // BIG_ENDIAN
      );
      (box as { write: (ds: unknown) => void }).write(ds);
      return ds.buffer.slice(8);
    }
  }
  return undefined;
}

function getAudioDescription(
  mp4: MP4BoxFile,
  track: MP4BoxAudioTrack,
): ArrayBuffer | undefined {
  try {
    const trak = mp4.getTrackById(track.id);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      if (entry.esds?.esd?.decoderConfig?.decoderSpecificInfo?.data) {
        const raw = entry.esds.esd.decoderConfig.decoderSpecificInfo.data;
        return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      }
      if (entry.decoderConfig?.decoderSpecificInfo?.data) {
        const raw = entry.decoderConfig.decoderSpecificInfo.data;
        return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      }
    }
  } catch {
    // silently ignore
  }
  return undefined;
}

// ── Render Loop ─────────────────────────────────────────────────────────
export function renderLoop(ts: number): void {
  perf.recordRaf(ts);
  if (!isPlaying) return;

  const hasClips =
    typeof window.IKState !== 'undefined' &&
    window.IKState.isReady() &&
    (window.IKState.getVideoClips().length > 0 ||
      window.IKState.getAudioClips().length > 0);
  if (!hasClips) {
    warn('play', 'startPlayback called but no clips on timeline — stopping');
    pausePlayback();
    return;
  }

  const durationMs = window.IKState.getDurationSec() * 1000;

  if (lastRafTs !== null) {
    playheadMs += ts - lastRafTs;
    if (playheadMs >= durationMs) {
      playheadMs = durationMs;
      pausePlayback();
    }
  }
  lastRafTs = ts;

  // Track clip transitions and silence audio during gaps
  const activeNow = getActiveClipsAtTime(Math.round(playheadMs * 1_000));
  const newClipId = activeNow[0]?.id ?? null;

  if (newClipId !== currentActiveClipId) {
    log('play', `clip transition: ${currentActiveClipId} -> ${newClipId}`);
    currentActiveClipId = newClipId;
    if (newClipId !== null) {
      const sourceMs = mapTimelineToSourceMs(playheadMs);
      worker!.postMessage({ type: 'seek', ms: sourceMs });
      pendingFrames.clear();
      pendingAudio.clear();
      audioPlayStartMs = playheadMs;
      if (audioCtx) audioPlayStartCtxTime = audioCtx.currentTime;
      nextAudioStartTime = 0;
    }
  }

  if (activeNow.length === 0 && scheduledAudioNodes.length > 0) {
    stopAllAudioNodes();
    nextAudioStartTime = 0;
  }

  paintFrameAtTime(playheadMs);

  const sourcePlayheadMs = mapTimelineToSourceMs(playheadMs);
  let framesAhead = 0;
  for (const frameMs of pendingFrames.keys()) {
    if (frameMs >= sourcePlayheadMs) framesAhead++;
  }
  
  // If in a gap, tell worker to sleep by reporting fake frames ahead
  const inGap = activeNow.length === 0;
  if (inGap) framesAhead = 100;

  // Throttle syncs: only when the playhead moved ≥100ms, play state flipped,
  // or the buffer crossed the worker's pump threshold.
  const playingNow = isPlaying && !inGap;
  const syncSig = `${Math.round(sourcePlayheadMs / 100)}|${playingNow ? 1 : 0}|${framesAhead >= 15 ? 1 : 0}`;
  if (syncSig !== lastSyncSig) {
    lastSyncSig = syncSig;
    worker!.postMessage({
      type: 'sync',
      playheadMs: sourcePlayheadMs,
      isPlaying: playingNow,
      framesAhead
    });
  }
  if (window.onPlayheadUpdate) window.onPlayheadUpdate(playheadMs);
  rafHandle = getPorts().rafScheduler.requestAnimationFrame(renderLoop);
}

function _getCompositeCanvas(
  w: number,
  h: number,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  if (!_compositeCanvas) {
    _compositeCanvas = getPorts().canvasFactory.createCanvas() as unknown as HTMLCanvasElement;
    _compositeCtx = _compositeCanvas.getContext('2d')!;
  }
  if (_compositeCanvas.width !== w || _compositeCanvas.height !== h) {
    _compositeCanvas.width = w;
    _compositeCanvas.height = h;
  }
  return [_compositeCanvas, _compositeCtx!];
}

function _getFrameCanvas(
  w: number,
  h: number,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  if (!_frameCanvas) {
    _frameCanvas = getPorts().canvasFactory.createCanvas() as unknown as HTMLCanvasElement;
    _frameCtx = _frameCanvas.getContext('2d')!;
  }
  if (_frameCanvas.width !== w || _frameCanvas.height !== h) {
    _frameCanvas.width = w;
    _frameCanvas.height = h;
  }
  return [_frameCanvas, _frameCtx!];
}

function cleanupStaleFrames(ms: number) {
  maybeCaptureThumbnail(ms);
  const sourceMs = mapTimelineToSourceMs(ms);
  const pruneBeforeMs = sourceMs - 1500;
  for (const [frameMs] of pendingFrames) {
    if (frameMs < pruneBeforeMs) pendingFrames.delete(frameMs);
  }
  for (const [audioMs] of pendingAudio) {
    if (audioMs < pruneBeforeMs) pendingAudio.delete(audioMs);
  }
}

function getActiveClipsAtTime(msUs: number): ClipWithMeta[] {
  const activeClips: ClipWithMeta[] = [];
  if (typeof window.IKState !== 'undefined' && window.IKState.isReady()) {
    const clips = window.IKState.getAllVideoClips
      ? window.IKState.getAllVideoClips()
      : window.IKState.getVideoClips();
    for (const clip of clips) {
      if (msUs >= clip.timeline_start_us && msUs < clip.timeline_end_us) {
        activeClips.push(clip);
      }
    }
  }
  return activeClips;
}

function resolveFramesForClips(activeClips: ClipWithMeta[], ms: number) {
  const resolved: Array<{ clip: ClipWithMeta; imageData: ImageData }> = [];
  for (const clip of activeClips) {
    // ms is in milliseconds; clip timestamps are in microseconds — divide by 1000
    const clipStartMs = clip.timeline_start_us / 1000;
    const sourceStartMs = clip.source_start_us / 1000;
    const timelineOffsetMs = ms - clipStartMs;
    const sourceMs = sourceStartMs + timelineOffsetMs;
    let bestMs = -1;
    for (const [frameMs] of pendingFrames) {
      if (frameMs <= sourceMs && frameMs > bestMs) bestMs = frameMs;
    }
    if (bestMs >= 0) {
      resolved.push({ clip, imageData: pendingFrames.get(bestMs)! });
    } else {
      logOnce(
        `no-frame-for-clip-${clip.id}-${Math.round(ms / 1000)}`,
        'paint',
        `clip ${clip.id} active at ${ms.toFixed(0)}ms but no frame found`,
      );
    }
  }
  return resolved;
}

function drawResolvedFrames(resolved: Array<{ clip: ClipWithMeta; imageData: ImageData }>, width: number, height: number) {
  if (resolved.length === 1) {
    ctx!.putImageData(resolved[0]!.imageData, 0, 0);
  } else {
    const [cc, cctx] = _getCompositeCanvas(width, height);
    const [fc, fctx] = _getFrameCanvas(width, height);

    cctx.globalCompositeOperation = 'source-over';
    cctx.globalAlpha = 1;
    cctx.clearRect(0, 0, width, height);

    for (let i = 0; i < resolved.length; i++) {
      const { clip, imageData } = resolved[i]!;
      const opacity = clip.transform ? clip.transform.opacity : 1;
      fctx.putImageData(imageData, 0, 0);
      cctx.globalAlpha = Math.max(0, Math.min(1, opacity));
      cctx.drawImage(fc, 0, 0);
    }
    cctx.globalAlpha = 1;
    ctx!.drawImage(cc, 0, 0);
  }
}

// ── Test Hooks ──────────────────────────────────────────────────────────
export const __TEST_HOOKS__ = {
  get worker() { return worker; },
  set worker(val: Worker | null) { worker = val; },
  get pendingFrames() { return pendingFrames; },
  set pendingFrames(val: Map<number, ImageData>) { pendingFrames = val; },
  get canvas() { return canvas; },
  set canvas(val: HTMLCanvasElement | null) { canvas = val; },
  get ctx() { return ctx; },
  set ctx(val: CanvasRenderingContext2D | null) { ctx = val; },
  get isExporting() { return isExporting; },
  set isExporting(val: boolean) { isExporting = val; },
  get exportFrames() { return exportFrames; },
  set exportFrames(val: Array<{ ms: number; imageData: ImageData }>) { exportFrames = val; },
  get videoDurationMs() { return videoDurationMs; },
  set videoDurationMs(val: number) { videoDurationMs = val; },
  get audioCtx() { return audioCtx; },
  set audioCtx(val: AudioContextPort | null) { audioCtx = val; },
  get isPlaying() { return isPlaying; },
  set isPlaying(val: boolean) { isPlaying = val; },
  get audioConfigVersion() { return audioConfigVersion; },
  set audioConfigVersion(val: number) { audioConfigVersion = val; },
  get audioPlayStartMs() { return audioPlayStartMs; },
  set audioPlayStartMs(val: number) { audioPlayStartMs = val; },
  get playheadMs() { return playheadMs; },
  set playheadMs(val: number) { playheadMs = val; },
  get pendingAudio() { return pendingAudio; },
  set pendingAudio(val: Map<number, AudioBuffer>) { pendingAudio = val; },
  get sourceVideoWidth() { return sourceVideoWidth; },
  set sourceVideoWidth(val: number) { sourceVideoWidth = val; },
  get sourceVideoHeight() { return sourceVideoHeight; },
  set sourceVideoHeight(val: number) { sourceVideoHeight = val; },
  get scheduledAudioNodes() { return scheduledAudioNodes; },
  set scheduledAudioNodes(val: AudioBufferSourceNode[]) { scheduledAudioNodes = val; },
  get nextAudioStartTime() { return nextAudioStartTime; },
  set nextAudioStartTime(val: number) { nextAudioStartTime = val; },
  get audioPlayStartCtxTime() { return audioPlayStartCtxTime; },
  set audioPlayStartCtxTime(val: number) { audioPlayStartCtxTime = val; },
  get lastRafTs() { return lastRafTs; },
  set lastRafTs(val: number | null) { lastRafTs = val; },
  get rafHandle() { return rafHandle; },
  set rafHandle(val: number | null) { rafHandle = val; },
  get seekTargetMs() { return seekTargetMs; },
  set seekTargetMs(val: number) { seekTargetMs = val; },
  get lastSyncSig() { return lastSyncSig; },
  set lastSyncSig(val: string) { lastSyncSig = val; },
  setTimeline,
  getProjectJson,
};

function paintFrameAtTime(ms: number): void {
  if (!ctx || !canvas) return;

  const msUs = Math.round(ms * 1_000);
  const activeClips = getActiveClipsAtTime(msUs);

  if (activeClips.length === 0) {
    logOnce(
      `no-clip-at-${Math.round(ms / 500) * 500}`,
      'paint',
      `no active clip at ${ms.toFixed(0)}ms — black frame (pendingFrames: ${pendingFrames.size})`,
    );
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    cleanupStaleFrames(ms);
    return;
  }

  const resolved = resolveFramesForClips(activeClips, ms);

  if (resolved.length === 0) {
    logOnce(
      `no-resolved-${Math.round(ms / 1000)}s`,
      'paint',
      `clips exist at ${ms.toFixed(0)}ms but pendingFrames is empty`,
    );
    cleanupStaleFrames(ms);
    return;
  }

  drawResolvedFrames(resolved, canvas.width, canvas.height);
  cleanupStaleFrames(ms);
}

// ── Playback control ────────────────────────────────────────────────────
async function startPlayback(opts?: { fromSeek?: boolean }): Promise<void> {
  if (isPlaying) return;
  log(
    'play',
    `startPlayback @ ${playheadMs.toFixed(0)}ms — pendingFrames: ${pendingFrames.size}, pendingAudio: ${pendingAudio.size}`,
  );
  isPlaying = true;
  lastRafTs = null;
  await initAudio();
  audioPlayStartCtxTime = audioCtx!.currentTime;
  audioPlayStartMs = playheadMs;
  nextAudioStartTime = 0;
  // Never schedule leftover chunks from before a pause: the worker re-sends
  // everything from the playhead (resync_audio below), so scheduling the
  // leftovers as well would double-stack them — the "screech" class of bug.
  // Skip when called from seekTo: seekTo already cleared pendingAudio, and
  // the seek handler's audio chunks must survive to be scheduled.
  if (!opts?.fromSeek) {
    pendingAudio.clear();
  }
  // Rewind the worker's audio decode front to the playhead. Pause stops and
  // discards all scheduled audio; without this the worker resumes decoding
  // from wherever it had pre-decoded to (possibly EOF), and the audio at the
  // playhead is never re-sent — the pause→play silence bug.
  // Skip when called from seekTo: the seek handler already decoded audio from
  // the correct position; a resync_audio here would reset the decoder and
  // discard those chunks, wasting time and arriving stale.
  if (!opts?.fromSeek) {
    worker?.postMessage({ type: 'resync_audio', ms: mapTimelineToSourceMs(playheadMs) });
  }
  syncWorkerState();
  rafHandle = getPorts().rafScheduler.requestAnimationFrame(renderLoop);
}

function pausePlayback(): void {
  if (!isPlaying && rafHandle === null) return;
  log('play', `pausePlayback @ ${playheadMs.toFixed(0)}ms`);
  isPlaying = false;
  lastRafTs = null;
  if (rafHandle) {
    getPorts().rafScheduler.cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  stopAllAudioNodes();
  pendingAudio.clear();
  nextAudioStartTime = 0;
  lastScheduledChunkMs = -1;
  syncWorkerState();
  if (window.onPlaybackPaused) window.onPlaybackPaused();
}

export function togglePlayback(): boolean {
  if (isPlaying) pausePlayback();
  else startPlayback().catch((e) => emitLocal('UNHANDLED_REJECTION', e, { fatal: false }));
  return isPlaying;
}

export async function seekTo(ms: number): Promise<void> {
  const wasPlaying = isPlaying;
  log('seek', `seekTo ${ms.toFixed(0)}ms (wasPlaying: ${wasPlaying})`);
  if (isPlaying) {
    isPlaying = false;
    lastRafTs = null;
    if (rafHandle) {
      getPorts().rafScheduler.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    stopAllAudioNodes();
  }

  seekTargetMs = ms;
  if (seekPaintTimeout) clearTimeout(seekPaintTimeout);
  seekPaintTimeout = setTimeout(() => {
    if (seekTargetMs >= 0) {
      warn(
        'seek',
        `fallback timeout fired — no frame reached ${ms.toFixed(0)}ms within 300ms`,
      );
      seekTargetMs = -1;
      paintFrameAtTime(playheadMs);
    }
  }, 300);

  playheadMs = ms;
  audioPlayStartMs = ms;
  
  const activeNow = getActiveClipsAtTime(Math.round(playheadMs * 1_000));
  currentActiveClipId = activeNow[0]?.id ?? null;

  pendingFrames.clear();
  pendingAudio.clear();
  audioConfigVersion++;
  worker!.postMessage({ type: 'set_audio_version', version: audioConfigVersion });
  const sourceTargetMs = mapTimelineToSourceMs(ms);
  seekGeneration++;
  worker!.postMessage({ type: 'seek', ms: sourceTargetMs, seekId: seekGeneration });
  syncWorkerState();
  if (window.onPlayheadUpdate) window.onPlayheadUpdate(ms);
  nextAudioStartTime = 0;
  if (wasPlaying) startPlayback({ fromSeek: true });
}

function syncWorkerState(): void {
  const activeNow = getActiveClipsAtTime(Math.round(playheadMs * 1_000));
  const inGap = activeNow.length === 0;
  const sourcePlayheadMs = mapTimelineToSourceMs(playheadMs);
  if (worker) {
    const playingNow = isPlaying && !inGap;
    const framesAhead = inGap ? 100 : 0;
    // Discrete transitions always sync — and record the sig so renderLoop
    // doesn't immediately re-send a duplicate.
    lastSyncSig = `${Math.round(sourcePlayheadMs / 100)}|${playingNow ? 1 : 0}|${framesAhead >= 15 ? 1 : 0}`;
    worker.postMessage({
      type: 'sync',
      playheadMs: sourcePlayheadMs,
      isPlaying: playingNow,
      framesAhead
    });
  }
}

export function setColorGrade(params: Partial<GradeParams>): void {
  seekTargetMs = -1;
  if (seekPaintTimeout) clearTimeout(seekPaintTimeout);
  worker!.postMessage({
    type: 'set_grade',
    params,
    forceRenderMs: isPlaying ? undefined : playheadMs,
  });
}

// ── Export ───────────────────────────────────────────────────────────────
export async function exportVideo(
  onProgress?: (progress: number) => void,
): Promise<void> {
  if (isExporting) return;
  pausePlayback();
  isExporting = true;
  exportFrames = [];
  seekTargetMs = -1;
  if (seekPaintTimeout) clearTimeout(seekPaintTimeout);

  const frameMs = 1000 / 30;
  const totalFrames = Math.ceil(videoDurationMs / frameMs);
  logStatus('Export: collecting frames…');
  for (let i = 0; i < totalFrames; i++) {
    const ms = Math.round(i * frameMs);
    const sourceMs = mapTimelineToSourceMs(ms);
    worker!.postMessage({ type: 'seek', ms: sourceMs });
    while (!pendingFrames.has(sourceMs)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (onProgress) onProgress((i / totalFrames) * 0.5);
  }

  logStatus('Export: encoding…');
  const ports = getPorts();
  const encodedChunks: Array<{
    buf: ArrayBuffer;
    timestamp: number;
    type: string;
  }> = [];
  const encoder = ports.videoEncoderFactory.create(
    (chunk) => {
      const buf = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(buf);
      encodedChunks.push({ buf, timestamp: chunk.timestamp, type: chunk.type });
    },
    (e) => emitLocal('EXPORT_FAILED', e, { fatal: false }),
  );
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
    const { ms, imageData } = sortedFrames[i]!;
    const frame = new VideoFrame(imageData.data.buffer, {
      format: 'RGBA',
      codedWidth: sourceVideoWidth,
      codedHeight: sourceVideoHeight,
      timestamp: ms * 1000,
      duration: frameMs * 1000,
    });
    encoder.encode(frame, { keyFrame: i % 60 === 0 });
    frame.close();
    if (onProgress) onProgress(0.5 + (i / sortedFrames.length) * 0.4);
  }
  await encoder.flush();
  encoder.close();

  logStatus('Export: muxing…');
  if (!window.Mp4Muxer)
    await loadScript(
      'https://cdn.jsdelivr.net/npm/mp4-muxer@4.4.2/build/mp4-muxer.js',
    );

  const muxer = new window.Mp4Muxer.Muxer({
    target: new window.Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: sourceVideoWidth, height: sourceVideoHeight },
    fastStart: 'in-memory',
  });
  for (const { buf, timestamp, type } of encodedChunks) {
    muxer.addVideoChunkRaw(buf, type, timestamp, frameMs * 1000);
  }
  if (onProgress) onProgress(0.95);
  const { buffer } = muxer.finalize();
  const a = ports.canvasFactory.createElement('a') as HTMLAnchorElement;
  a.href = ports.urlFactory.createObjectURL(ports.blobFactory.create([buffer], { type: 'video/mp4' }));
  a.download = `iklippa-export-${Date.now()}.mp4`;
  a.click();
  isExporting = false;
  exportFrames = [];
  logStatus('Export complete ✓');
  if (onProgress) onProgress(1);
}

// ── Rust Project Sync ───────────────────────────────────────────────────
/** Push the current JS project state into the Rust engine. Call after any
 *  mutation that the compositor needs to know about (import, trim, split,
 *  move, remove, track toggle). */
export function syncTimelineToRust(): void {
  if (typeof window.IKState === 'undefined' || !window.IKState.isReady()) return;
  const json = window.IKState.toRustJson();
  setTimeline(json).then(({ ok, error }) => {
    if (!ok) {
      console.warn('[iKlippa:engine] set_timeline rejected:', error);
    }
  });
}

function setTimeline(json: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      if (e.data.type === 'timeline_set') {
        worker!.removeEventListener('message', handler);
        resolve({ ok: e.data.ok, error: e.data.error });
      }
    };
    worker!.addEventListener('message', handler);
    worker!.postMessage({ type: 'set_timeline', json });
  });
}

function getProjectJson(): Promise<string> {
  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      if (e.data.type === 'project_json') {
        worker!.removeEventListener('message', handler);
        resolve(e.data.json);
      }
    };
    worker!.addEventListener('message', handler);
    worker!.postMessage({ type: 'get_project_json' });
  });
}

function logStatus(msg: string): void {
  console.log(`[iKlippa] ${msg}`);
  if (window.onEngineStatus) window.onEngineStatus(msg);
}

// ── Rust Composite Path ─────────────────────────────────────────────────
export function requestComposite(ms: number): void {
  if (!worker) return;
  const ts_us = Math.round(ms * 1_000);
  worker.postMessage({ type: 'composite', ts_us });
}

/** Paint the cached Rust composite onto the canvas. Returns true on success. */
export function paintRustComposite(): boolean {
  if (!_rustCompositeBuffer || _rustCompositeW === 0 || !ctx) return false;
  const arr = new Uint8ClampedArray(_rustCompositeBuffer);
  const imageData = new ImageData(arr, _rustCompositeW, _rustCompositeH);
  ctx.putImageData(imageData, 0, 0);
  return true;
}

// Expose for devtools testing
if (typeof window !== 'undefined') {
  (window as any).iklippaComposite = {
    request: (ms: number) => requestComposite(ms),
    paint: () => paintRustComposite(),
    lastTs: () => _rustCompositeTsUs,
    lastSize: () => `${_rustCompositeW}x${_rustCompositeH}`,
  };
}
