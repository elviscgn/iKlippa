// ── Engine-specific types ───────────────────────────────────────────────

/** Performance score returned by PerformanceMonitor.score() */
export interface PerfScore {
  composite: number;
  smoothness: number;
  gradePerf: number;
  decodePerf: number;
  dropScore: number;
  avgFrameMs: string;
  avgGradeMs: string;
  avgDecodeMs: string;
  dropRatePct: string;
  totalFrames: number;
  targetFps: number;
}

// ── Worker message types (discriminated unions) ─────────────────────────

export interface WorkerStatusMsg {
  type: 'status';
  msg: string;
}

export interface WorkerReadyMsg {
  type: 'ready';
  durationMs: number;
  width: number;
  height: number;
  fileName: string;
  sourceId: string;
}

export interface WorkerDecodeSubmitMsg {
  type: 'decode_submit';
  ms: number;
}

export interface WorkerFrameMsg {
  type: 'frame';
  ms: number;
  gradeMs: number;
  buffer: ArrayBuffer;
  sourceId: string;
  seekId?: number;
}

export interface WorkerAudioChunkMsg {
  type: 'audio_chunk';
  ms: number;
  channels: number;
  sampleRate: number;
  length: number;
  buffers: ArrayBuffer[];
  configVersion: number;
  sourceId: string;
  seekId?: number;
}

export interface WorkerTimelineSetMsg {
  type: 'timeline_set';
  ok: boolean;
  error?: string;
}

export interface WorkerProjectJsonMsg {
  type: 'project_json';
  json: string;
}

// ── Error protocol ──────────────────────────────────────────────────────
// Every failure in either thread is reported as an EngineError. The rule:
// an error must terminate in a recovery routine or a visible toast — never
// the console.

export type EngineErrorCode =
  | 'WASM_INIT_FAILED'
  | 'WASM_PANIC'
  | 'LOAD_FAILED'
  | 'DECODER_VIDEO_FATAL'
  | 'DECODER_AUDIO_FATAL'
  | 'DECODER_UNSUPPORTED'
  | 'DEMUX_FAILED'
  | 'DEMUX_STALLED'
  | 'LOAD_TIMEOUT'
  | 'SEEK_TIMEOUT'
  | 'PLAYBACK_STARVATION'
  | 'WORKER_UNCAUGHT'
  | 'WORKER_UNHANDLED_REJECTION'
  | 'WORKER_DIED'
  | 'WORKER_WEDGED'
  | 'UNHANDLED_REJECTION'
  | 'EXPORT_FAILED'
  | 'PROTOCOL_ERROR';

export interface EngineError {
  code: EngineErrorCode;
  /** Technical summary (typically err.message). */
  message: string;
  /** Stack trace + recent worker log lines, for diagnostics. */
  detail?: string;
  /** true → playback cannot continue without an engine reset/re-import. */
  fatal: boolean;
  /** Correlating request id, when the error belongs to a specific call. */
  opId?: number;
  /** performance.now() at report time. */
  at: number;
}

export interface WorkerCompositeResult {
  type: 'composite_result';
  buffer: ArrayBuffer;
  ts_us: number;
  width: number;
  height: number;
}

export interface WorkerErrorMsg {
  type: 'error';
  error: EngineError;
}

export type WorkerIncomingMessage =
  | WorkerStatusMsg
  | WorkerReadyMsg
  | WorkerDecodeSubmitMsg
  | WorkerFrameMsg
  | WorkerAudioChunkMsg
  | WorkerTimelineSetMsg
  | WorkerProjectJsonMsg
  | WorkerCompositeResult
  | WorkerErrorMsg;

// ── Messages sent TO the worker ─────────────────────────────────────────

interface WorkerInitCmd {
  type: 'init';
}

export interface WorkerLoadCmd {
  type: 'load';
  file: File;
  codecConfig: VideoDecoderConfig;
  width: number;
  height: number;
  durationMs: number;
  samples: MP4Sample[];
  audioConfig?: AudioDecoderConfig;
  audioSamples?: MP4Sample[];
  audioConfigVersion: number;
  fileName: string;
  sourceId: string;
}

export interface WorkerSeekCmd {
  type: 'seek';
  ms: number;
  sourceId?: string;
  seekId?: number;
}

/** Rewind the audio decode front to `ms` (source time) and re-prime.
 *  Sent when playback resumes after a pause: pause drops all scheduled/
 *  cached audio, so the chunks at the playhead must be re-sent. */
export interface WorkerResyncAudioCmd {
  type: 'resync_audio';
  ms: number;
  sourceId?: string;
}

export interface WorkerSyncCmd {
  type: 'sync';
  playheadMs: number;
  isPlaying: boolean;
  framesAhead: number;
  sourceId?: string;
}

export interface WorkerSetGradeCmd {
  type: 'set_grade';
  params: Partial<GradeParams>;
  forceRenderMs?: number;
}

export interface WorkerSetTimelineCmd {
  type: 'set_timeline';
  json: string;
}

interface WorkerGetProjectJsonCmd {
  type: 'get_project_json';
}

export interface WorkerSetAudioVersionCmd {
  type: 'set_audio_version';
  version: number;
}

export interface WorkerCompositeCmd {
  type: 'composite';
  ts_us: number;
}

type WorkerOutgoingMessage =
  | WorkerInitCmd
  | WorkerLoadCmd
  | WorkerSeekCmd
  | WorkerResyncAudioCmd
  | WorkerSyncCmd
  | WorkerSetGradeCmd
  | WorkerSetTimelineCmd
  | WorkerGetProjectJsonCmd
  | WorkerSetAudioVersionCmd
  | WorkerCompositeCmd;

// ── Grade parameters ────────────────────────────────────────────────────

export interface GradeParams {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  highlights: number;
  shadows: number;
  vignette: number;
  grain: number;
  lut: number;
}

// ── MP4Box sample shape (from mp4box.js) ────────────────────────────────

export interface MP4Sample {
  cts: number;
  duration: number;
  timescale: number;
  is_sync: boolean;
  offset: number;
  size: number;
}

// ── Clip imported callback data ─────────────────────────────────────────

interface ClipImportedData {
  width: number;
  height: number;
  durationMs: number;
  fileName: string;
}
