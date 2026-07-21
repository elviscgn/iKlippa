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

import { currentTier, getTierConfig } from './tier';

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
interface TimelineSource {
  sourceMs: number;
  sourceId: string;
}

function mapTimelineToSource(timelineMs: number): TimelineSource | null {
  if (typeof window.IKState === 'undefined' || !window.IKState.isReady()) return null;
  const clips = window.IKState.getAllVideoClips
    ? window.IKState.getAllVideoClips()
    : window.IKState.getVideoClips();
  for (const clip of clips) {
    const tStart = clip.timeline_start_us / 1000;
    const tEnd = clip.timeline_end_us / 1000;
    if (timelineMs >= tStart && timelineMs < tEnd) {
      return {
        sourceMs: (clip.source_start_us / 1000) + (timelineMs - tStart) * clip.speed,
        sourceId: clip.source_id,
      };
    }
  }
  return null;
}

function mapTimelineToSourceMs(timelineMs: number): number {
  const r = mapTimelineToSource(timelineMs);
  return r ? r.sourceMs : timelineMs;
}

function mapSourceToTimelineMs(sourceMs: number): number | null {
  if (typeof window.IKState === 'undefined' || !window.IKState.isReady()) return sourceMs;
  const clips = window.IKState.getAllVideoClips
    ? window.IKState.getAllVideoClips()
    : window.IKState.getVideoClips();

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
let pendingFramesBySource = new Map<string, Map<number, ImageData>>();
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

// ── Audio Mixer ──────────────────────────────────────────────────────────
let masterCompressor: DynamicsCompressorNode | null = null;
let trackAudioNodes = new Map<number, { gain: GainNode; pan: StereoPannerNode }>();

function getTrackGainPan(trackId: number): { gain: GainNode; pan: StereoPannerNode } {
  if (!audioCtx) throw new Error('AudioContext not ready');
  let nodes = trackAudioNodes.get(trackId);
  if (!nodes) {
    const gain = audioCtx.createGain();
    const pan = audioCtx.createStereoPanner();
    gain.connect(pan);
    pan.connect(masterCompressor || audioCtx.destination);
    nodes = { gain, pan };
    trackAudioNodes.set(trackId, nodes);
    syncTrackAudioSettings(trackId, nodes);
  }
  return nodes;
}

function syncTrackAudioSettings(trackId: number, nodes?: { gain: GainNode; pan: StereoPannerNode }): void {
  const n = nodes || trackAudioNodes.get(trackId);
  if (!n || !audioCtx) return;
  const IKState = (window as any).IKState;
  if (!IKState || !IKState.isReady()) return;
  const track = IKState.getTrackById ? IKState.getTrackById(trackId) : null;
  if (!track) return;
  const now = audioCtx.currentTime;
  n.gain.gain.setTargetAtTime(track.muted ? 0 : track.volume, now, 0.02);
  n.pan.pan.setTargetAtTime(track.pan, now, 0.02);
}

/** Update all track audio nodes from IKState. Call on re-render. */
export function syncAllTrackAudio(): void {
  trackAudioNodes.forEach((nodes, trackId) => syncTrackAudioSettings(trackId, nodes));
}

function findActiveAudioTrack(sourceMs: number): number | null {
  const IKState = (window as any).IKState;
  if (!IKState || !IKState.isReady()) return null;
  const tracks = IKState.getTracks ? IKState.getTracks() : [];
  for (const track of tracks) {
    if (track.track_type !== 'audio') continue;
    for (const clip of track.clips) {
      const sStart = clip.source_start_us / 1000;
      const sEnd = clip.source_end_us / 1000;
      if (sourceMs >= sStart && sourceMs < sEnd) return track.id;
    }
  }
  return null;
}

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
let _lastCompositeRequestMs = -1000;

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
    masterCompressor = audioCtx.createDynamicsCompressor();
    masterCompressor.threshold.setValueAtTime(-24, audioCtx.currentTime);
    masterCompressor.knee.setValueAtTime(30, audioCtx.currentTime);
    masterCompressor.ratio.setValueAtTime(12, audioCtx.currentTime);
    masterCompressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
    masterCompressor.release.setValueAtTime(0.25, audioCtx.currentTime);
    masterCompressor.connect(audioCtx.destination);
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
    `ready [${msg.sourceId}] — ${sourceVideoWidth}×${sourceVideoHeight} · ${(videoDurationMs / 1000).toFixed(2)}s`,
  );
  logStatus(
    `Ready: ${sourceVideoWidth}×${sourceVideoHeight} · ${(videoDurationMs / 1000).toFixed(2)}s`,
  );
  if (window.onClipImported) {
    window.onClipImported({
      width: sourceVideoWidth,
      height: sourceVideoHeight,
      durationMs: videoDurationMs,
      fileName: msg.fileName,
      sourceId: msg.sourceId,
    });
  }
}

function handleWorkerFrame(msg: Extract<WorkerIncomingMessage, { type: 'frame' }>): void {
  // During export, accept all frames — seekGeneration races ahead.
  if (!isExporting && msg.seekId !== undefined && msg.seekId !== seekGeneration) {
    log('paint', `dropping stale frame from seek ${msg.seekId} (current: ${seekGeneration})`);
    return;
  }
  perf.recordFrameArrival(msg.ms, msg.gradeMs);
  const arr = new Uint8ClampedArray(msg.buffer);
  const img = new ImageData(arr, sourceVideoWidth, sourceVideoHeight);

  // Store in both caches for backward compat during transition
  pendingFrames.set(msg.ms, img);
  let sourceFrames = pendingFramesBySource.get(msg.sourceId);
  if (!sourceFrames) {
    sourceFrames = new Map();
    pendingFramesBySource.set(msg.sourceId, sourceFrames);
  }
  sourceFrames.set(msg.ms, img);

  if (isExporting)
    exportFrames.push({ ms: msg.ms, imageData: img });

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
  if (!isExporting && msg.seekId !== undefined && msg.seekId !== seekGeneration) {
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
      // Force a re-paint to show the Rust composite immediately
      if (!isPlaying) paintFrameAtTime(_rustCompositeTsUs / 1_000);
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
  if (!audioCtx || !masterCompressor) return;
  const timelineMs = mapSourceToTimelineMs(chunkMs);
  if (timelineMs === null) return;

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

  // Route through the correct audio track's gain/pan nodes
  const trackId = findActiveAudioTrack(chunkMs);
  if (trackId !== null) {
    try {
      const { gain, pan } = getTrackGainPan(trackId);
      source.connect(gain);
    } catch {
      source.connect(masterCompressor);
    }
  } else {
    source.connect(masterCompressor);
  }

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
  // Don't clear ALL frames — only stale ones. Other sources keep their caches.
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

  const sourceId = 'imported_' + Date.now();
  worker!.postMessage({ type: 'load', file, fileName: file.name, sourceId, ...payload });
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
      const mapRes = mapTimelineToSource(playheadMs);
      if (mapRes) {
        worker!.postMessage({ type: 'seek', ms: mapRes.sourceMs, sourceId: mapRes.sourceId });
      }
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

  const mapRes = mapTimelineToSource(playheadMs);
  const sourcePlayheadMs = mapRes ? mapRes.sourceMs : playheadMs;
  let framesAhead = 0;
  const sourceFrames = mapRes ? pendingFramesBySource.get(mapRes.sourceId) : null;
  if (sourceFrames) {
    for (const frameMs of sourceFrames.keys()) {
      if (frameMs >= sourcePlayheadMs) framesAhead++;
    }
  }

  const inGap = activeNow.length === 0;
  if (inGap) framesAhead = 100;

  const playingNow = isPlaying && !inGap;
  const syncSig = `${Math.round(sourcePlayheadMs / 100)}|${playingNow ? 1 : 0}|${framesAhead >= 15 ? 1 : 0}|${mapRes?.sourceId ?? ''}`;
  if (syncSig !== lastSyncSig) {
    lastSyncSig = syncSig;
    worker!.postMessage({
      type: 'sync',
      playheadMs: sourcePlayheadMs,
      isPlaying: playingNow,
      framesAhead,
      sourceId: mapRes?.sourceId,
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
  const mapRes = mapTimelineToSource(ms);
  if (!mapRes) return;
  const pruneBeforeMs = mapRes.sourceMs - 1500;
  for (const [frameMs] of pendingFrames) {
    if (frameMs < pruneBeforeMs) pendingFrames.delete(frameMs);
  }
  const sourceFrames = pendingFramesBySource.get(mapRes.sourceId);
  if (sourceFrames) {
    for (const [frameMs] of sourceFrames) {
      if (frameMs < pruneBeforeMs) sourceFrames.delete(frameMs);
    }
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
    const clipStartMs = clip.timeline_start_us / 1000;
    const sourceStartMs = clip.source_start_us / 1000;
    const timelineOffsetMs = ms - clipStartMs;
    const sourceMs = sourceStartMs + timelineOffsetMs;

    const sourceFrames = pendingFramesBySource.get(clip.source_id);
    let bestMs = -1;
    if (sourceFrames) {
      for (const [frameMs] of sourceFrames) {
        if (frameMs <= sourceMs && frameMs > bestMs) bestMs = frameMs;
      }
    }
    // Fallback to legacy global cache
    if (bestMs < 0) {
      for (const [frameMs] of pendingFrames) {
        if (frameMs <= sourceMs && frameMs > bestMs) bestMs = frameMs;
      }
    }
    if (bestMs >= 0) {
      const img = (sourceFrames && sourceFrames.get(bestMs)) || pendingFrames.get(bestMs);
      if (img) resolved.push({ clip, imageData: img });
    } else {
      logOnce(
        `no-frame-for-clip-${clip.id}-${Math.round(ms / 1000)}`,
        'paint',
        `clip ${clip.id} active at ${ms.toFixed(0)}ms but no frame found [${clip.source_id}]`,
      );
    }
  }
  return resolved;
}

function colourFilter(clip: ClipWithMeta): string {
  const cs = clip.colour_settings;
  if (!cs) return 'none';
  const exp   = 1 + cs.exposure * 1.5;
  const con   = 1 + cs.contrast * 1.5;
  const sat   = 1 + cs.saturation;
  const temp  = cs.temperature;
  const tint  = cs.tint;
  const parts: string[] = [];
  if (Math.abs(exp - 1) > 0.01) parts.push(`brightness(${exp.toFixed(2)})`);
  if (Math.abs(con - 1) > 0.01) parts.push(`contrast(${con.toFixed(2)})`);
  if (Math.abs(sat - 1) > 0.01) parts.push(`saturate(${sat.toFixed(2)})`);
  if (Math.abs(temp) > 0.01) parts.push(`sepia(${Math.abs(temp).toFixed(2)}) hue-rotate(${temp > 0 ? '' : '-'}${(Math.abs(temp) * 15).toFixed(0)}deg)`);
  if (Math.abs(tint) > 0.01) parts.push(`hue-rotate(${(tint * 10).toFixed(0)}deg)`);
  return parts.length > 0 ? parts.join(' ') : 'none';
}

function drawResolvedFrames(resolved: Array<{ clip: ClipWithMeta; imageData: ImageData }>, width: number, height: number) {
  if (resolved.length === 1) {
    const clip = resolved[0]!.clip;
    const filter = colourFilter(clip);
    if (filter !== 'none') {
      const [fc, fctx] = _getFrameCanvas(width, height);
      fctx.filter = 'none';
      fctx.putImageData(resolved[0]!.imageData, 0, 0);
      fctx.filter = filter;
      // drawImage with filter; copy back to imageData
      fctx.drawImage(fc, 0, 0);
      const filtered = fctx.getImageData(0, 0, width, height);
      fctx.filter = 'none';
      ctx!.putImageData(filtered, 0, 0);
    } else {
      ctx!.putImageData(resolved[0]!.imageData, 0, 0);
    }
  } else {
    const [cc, cctx] = _getCompositeCanvas(width, height);
    const [fc, fctx] = _getFrameCanvas(width, height);

    cctx.globalCompositeOperation = 'source-over';
    cctx.globalAlpha = 1;
    cctx.clearRect(0, 0, width, height);

    for (let i = 0; i < resolved.length; i++) {
      const { clip, imageData } = resolved[i]!;
      const opacity = clip.transform ? clip.transform.opacity : 1;
      const filter = colourFilter(clip);
      fctx.filter = 'none';
      fctx.putImageData(imageData, 0, 0);
      if (filter !== 'none') {
        fctx.filter = filter;
        fctx.drawImage(fc, 0, 0);
        fctx.filter = 'none';
      }
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

  // Prefer the Rust composite when available (it respects per-clip grades).
  // Accept composites within 100ms of the target time.
  const tsUs = Math.round(ms * 1_000);
  if (_rustCompositeBuffer && Math.abs(_rustCompositeTsUs - tsUs) < 100_000) {
    const arr = new Uint8ClampedArray(_rustCompositeBuffer);
    const imageData = new ImageData(arr, _rustCompositeW, _rustCompositeH);
    ctx.putImageData(imageData, 0, 0);
    return;
  }

  // Request a Rust composite when paused/scrubbing (debounced 250ms).
  // During playback, JS compositing handles preview at 60fps — the
  // Rust composite would arrive too late for the current frame.
  if (!isPlaying && Math.abs(ms - _lastCompositeRequestMs) > 250) {
    _lastCompositeRequestMs = ms;
    requestComposite(ms);
  }

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
    const mapRes = mapTimelineToSource(playheadMs);
    worker?.postMessage({ type: 'resync_audio', ms: mapRes ? mapRes.sourceMs : playheadMs, sourceId: mapRes?.sourceId });
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
  const mapRes = mapTimelineToSource(ms);
  const sourceTargetMs = mapRes ? mapRes.sourceMs : ms;
  const sourceId = mapRes ? mapRes.sourceId : undefined;
  seekGeneration++;
  worker!.postMessage({ type: 'seek', ms: sourceTargetMs, sourceId, seekId: seekGeneration });
  requestComposite(ms);
  syncWorkerState();
  if (window.onPlayheadUpdate) window.onPlayheadUpdate(ms);
  nextAudioStartTime = 0;
  if (wasPlaying) startPlayback({ fromSeek: true });
}

function syncWorkerState(): void {
  const activeNow = getActiveClipsAtTime(Math.round(playheadMs * 1_000));
  const inGap = activeNow.length === 0;
  const mapRes = mapTimelineToSource(playheadMs);
  const sourcePlayheadMs = mapRes ? mapRes.sourceMs : playheadMs;
  if (worker) {
    const playingNow = isPlaying && !inGap;
    const framesAhead = inGap ? 100 : 0;
    lastSyncSig = `${Math.round(sourcePlayheadMs / 100)}|${playingNow ? 1 : 0}|${framesAhead >= 15 ? 1 : 0}|${mapRes?.sourceId ?? ''}`;
    worker.postMessage({
      type: 'sync',
      playheadMs: sourcePlayheadMs,
      isPlaying: playingNow,
      framesAhead,
      sourceId: mapRes?.sourceId,
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

export function setPerClipGrade(clipId: number, grade: Record<string, number>): void {
  seekTargetMs = -1;
  if (seekPaintTimeout) clearTimeout(seekPaintTimeout);
  worker!.postMessage({
    type: 'set_clip_grade',
    clipId,
    grade,
  });
  // Trigger a Rust composite at the current playhead so the preview
  // reflects the grade change immediately.
  requestComposite(playheadMs);
}

// ── Export ───────────────────────────────────────────────────────────────
export async function exportVideo(
  onProgress?: (progress: number) => void,
): Promise<void> {
  if (isExporting) return;
  pausePlayback();
  isExporting = true;
  exportFrames = [];
  pendingAudio.clear();
  seekTargetMs = -1;
  if (seekPaintTimeout) clearTimeout(seekPaintTimeout);

  const tier = getTierConfig();
  const durationSec = videoDurationMs / 1000;
  if (durationSec > tier.maxDurationSec) {
    alert(`Free tier limited to ${tier.maxDurationSec}s. Your video is ${durationSec.toFixed(0)}s. Upgrade to export longer videos.`);
    isExporting = false;
    return;
  }
  const exportW = Math.min(sourceVideoWidth, tier.maxWidth);
  const exportH = Math.min(sourceVideoHeight, tier.maxHeight);
  const needsResize = exportW !== sourceVideoWidth || exportH !== sourceVideoHeight;

  const frameMs = 1000 / 30;
  const totalFrames = Math.ceil(durationSec * 1000 / frameMs);
  console.log(`[export] starting: ${totalFrames} frames, ${exportW}×${exportH}, duration=${durationSec.toFixed(1)}s`);
  logStatus(`Export: collecting frames (${exportW}×${exportH})…`);
  if (onProgress) onProgress(0);

  // One message to decode ALL frames in a single pass
  const initMap = mapTimelineToSource(0);
  worker!.postMessage({ type: 'decode_all', sourceId: initMap?.sourceId });

  // Wait for all frames to arrive from the worker's continuous decode.
  // Stop when no new frames for 3s (actual frame count may differ from 30fps estimate).
  let waited = 0;
  let _lastLogLen = 0;
  let staleCount = 0;
  while (staleCount < 30 && waited < 120000) {
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
    if (exportFrames.length !== _lastLogLen) {
      console.log(`[export] ${exportFrames.length}/${totalFrames} frames after ${(waited/1000).toFixed(0)}s`);
      _lastLogLen = exportFrames.length;
      staleCount = 0;
    } else {
      staleCount++;
    }
    if (onProgress && waited % 500 === 0) {
      onProgress(Math.min(0.4, (exportFrames.length / Math.max(totalFrames, exportFrames.length + 1)) * 0.4));
    }
  }
  if (exportFrames.length === 0 && waited >= 120000) {
    console.warn('[export] no frames collected — aborting');
    isExporting = false;
    return;
  }

  logStatus('Export: encoding…');
  const ports = getPorts();
  const encodedVideo: Array<{ buf: ArrayBuffer; timestamp: number; type: string }> = [];
  const encoder = ports.videoEncoderFactory.create(
    (chunk) => {
      const buf = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(buf);
      encodedVideo.push({ buf, timestamp: chunk.timestamp, type: chunk.type });
    },
    (e) => emitLocal('EXPORT_FAILED', e, { fatal: false }),
  );
  encoder.configure({
    codec: 'avc1.42001f',
    width: exportW,
    height: exportH,
    bitrate: 8_000_000,
    framerate: 30,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
  });

  // Reusable canvas for watermark + resize
  const expCanvas = ports.canvasFactory.createCanvas() as unknown as HTMLCanvasElement;
  expCanvas.width = exportW;
  expCanvas.height = exportH;
  const expCtx = expCanvas.getContext('2d', { willReadFrequently: true })!;

  const sortedFrames = exportFrames.slice().sort((a, b) => a.ms - b.ms);
  for (let i = 0; i < sortedFrames.length; i++) {
    const { ms, imageData } = sortedFrames[i]!;
    expCtx.putImageData(imageData, 0, 0, 0, 0, sourceVideoWidth, sourceVideoHeight);

    // Resize if needed
    if (needsResize) {
      expCtx.drawImage(expCanvas, 0, 0, sourceVideoWidth, sourceVideoHeight, 0, 0, exportW, exportH);
    }

    // Watermark for free tier
    if (tier.watermark) {
      const wmW = exportW * 0.2;
      const wmH = wmW * 0.25;
      const wmX = exportW - wmW - exportW * 0.05;
      const wmY = exportH - wmH - exportH * 0.05;
      expCtx.fillStyle = 'rgba(255,255,255,0.35)';
      expCtx.fillRect(wmX, wmY, wmW, wmH);
      expCtx.fillStyle = 'rgba(0,0,0,0.5)';
      expCtx.font = `${Math.round(wmH * 0.5)}px sans-serif`;
      expCtx.textAlign = 'center';
      expCtx.fillText('iKlippa', wmX + wmW / 2, wmY + wmH * 0.65);
    }

    const frameImg = expCtx.getImageData(0, 0, exportW, exportH);
    const frame = new VideoFrame(frameImg.data.buffer, {
      format: 'RGBA',
      codedWidth: exportW,
      codedHeight: exportH,
      timestamp: ms * 1000,
      duration: frameMs * 1000,
    });
    encoder.encode(frame, { keyFrame: i % 60 === 0 });
    frame.close();
    if (onProgress) onProgress(0.4 + (i / sortedFrames.length) * 0.3);
  }
  await encoder.flush();
  encoder.close();

  // ── Audio render & encode ─────────────────────────────────────────
  let encodedAudio: Array<{ buf: ArrayBuffer; timestamp: number; type: string }> = [];
  if (pendingAudio.size > 0) {
    logStatus('Export: encoding audio…');
    const sortedAudio = [...pendingAudio.entries()].sort(([a], [b]) => a - b);
    let sampleRate = 48000;
    if (sortedAudio.length > 0) sampleRate = sortedAudio[0]![1].sampleRate;

    const offlineCtx = new OfflineAudioContext(
      Math.min(sortedAudio[0]![1].numberOfChannels, 2),
      Math.ceil((durationSec + 0.5) * sampleRate),
      sampleRate,
    );

    for (const [srcMs, buf] of sortedAudio) {
      const timelineMs = mapSourceToTimelineMs(srcMs);
      if (timelineMs === null) continue;
      const src = offlineCtx.createBufferSource();
      src.buffer = buf;
      src.connect(offlineCtx.destination);
      src.start(timelineMs / 1000);
    }

    const rendered = await offlineCtx.startRendering();

    // Encode to AAC
    const audioEncoder = getPorts().audioEncoderFactory.create(
      (chunk) => {
        const buf = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(buf);
        encodedAudio.push({ buf, timestamp: chunk.timestamp, type: chunk.type });
      },
      (e) => emitLocal('EXPORT_FAILED', e, { fatal: false }),
    );
    audioEncoder.configure({
      codec: 'mp4a.40.2',
      numberOfChannels: rendered.numberOfChannels,
      sampleRate: rendered.sampleRate,
      bitrate: 128_000,
    });
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: rendered.sampleRate,
      numberOfFrames: rendered.length,
      numberOfChannels: rendered.numberOfChannels,
      timestamp: 0,
      data: (() => {
        const bufs: Float32Array[] = [];
        for (let c = 0; c < rendered.numberOfChannels; c++) {
          bufs.push(rendered.getChannelData(c));
        }
        const total = bufs.reduce((s, b) => s + b.byteLength, 0);
        const packed = new ArrayBuffer(total);
        let off = 0;
        for (const b of bufs) {
          new Uint8Array(packed).set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off);
          off += b.byteLength;
        }
        return packed;
      })(),
    });
    audioEncoder.encode(audioData);
    await audioEncoder.flush();
    audioEncoder.close();
    audioData.close();
  }

  // ── Mux ──────────────────────────────────────────────────────────
  logStatus('Export: muxing…');
  if (!window.Mp4Muxer) {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/mp4-muxer@4.4.2/build/mp4-muxer.js');
    } catch {
      // Fallback CDN
      await loadScript('https://unpkg.com/mp4-muxer@4.4.2/build/mp4-muxer.js');
    }
  }
  if (!window.Mp4Muxer || !window.Mp4Muxer.Muxer) {
    logStatus('Export failed — mp4-muxer not available (check internet)');
    isExporting = false;
    return;
  }

  const muxerConfig: any = {
    target: new window.Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: exportW, height: exportH },
    fastStart: 'in-memory',
  };
  if (encodedAudio.length > 0) {
    muxerConfig.audio = { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 };
  }

  const muxer = new window.Mp4Muxer.Muxer(muxerConfig);
  for (const { buf, timestamp, type } of encodedVideo) {
    muxer.addVideoChunkRaw(buf, type, timestamp, frameMs * 1000);
  }
  for (const { buf, timestamp, type } of encodedAudio) {
    muxer.addAudioChunkRaw(buf, type, timestamp, 1024);
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
    // Re-seek to repopulate the Rust frame_cache now that the project
    // has clips. Frames decoded before set_timeline had no clips to
    // match against in stage_frame_broadcast.
    const mapRes = mapTimelineToSource(playheadMs);
    if (mapRes) {
      seekGeneration++;
      worker!.postMessage({ type: 'seek', ms: mapRes.sourceMs, sourceId: mapRes.sourceId, seekId: seekGeneration });
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
