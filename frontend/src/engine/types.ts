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

export type WorkerIncomingMessage =
  | WorkerStatusMsg
  | WorkerReadyMsg
  | WorkerDecodeSubmitMsg
  | WorkerFrameMsg
  | WorkerAudioChunkMsg
  | WorkerTimelineSetMsg
  | WorkerProjectJsonMsg;

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
}

export interface WorkerSeekCmd {
  type: 'seek';
  ms: number;
  seekId?: number;
}

export interface WorkerSyncCmd {
  type: 'sync';
  playheadMs: number;
  isPlaying: boolean;
  framesAhead: number;
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

type WorkerOutgoingMessage =
  | WorkerInitCmd
  | WorkerLoadCmd
  | WorkerSeekCmd
  | WorkerSyncCmd
  | WorkerSetGradeCmd
  | WorkerSetTimelineCmd
  | WorkerGetProjectJsonCmd
  | WorkerSetAudioVersionCmd;

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
