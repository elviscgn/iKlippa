// ── Window augmentation for globals used by ui.js and legacy scripts ────
// This file declares types for everything hung on `window` so TypeScript
// doesn't complain when main.ts or state.ts sets/reads these properties.

import type { ClipWithMeta, ThumbnailEntry, Track } from '../state/types';
import type { ClipImportedData, EngineError } from '../engine/types';
/** The IKState module shape exposed on window */
interface IKStateAPI {
  init(width: number, height: number): void;
  isReady(): boolean;
  usToSec(us: number): number;
  secToUs(s: number): number;
  getTracks(): Track[];
  getTrackById(trackId: number): Track | null;
  getVideoTrack(): Track | null;
  getAudioTrack(): Track | null;
  addTrack(trackType: 'video' | 'audio'): Track | null;
  removeTrack(trackId: number): boolean;
  getVideoClips(): ClipWithMeta[];
  getAudioClips(): ClipWithMeta[];
  getAllVideoClips(): ClipWithMeta[];
  addClip(
    trackId: number,
    sourceId: string,
    startUs: number,
    endUs: number,
    meta?: Record<string, unknown>,
    groupId?: string,
  ): ClipWithMeta | null;
  addVideoClip(
    sourceId: string,
    startUs: number,
    endUs: number,
    meta?: Record<string, unknown>,
    groupId?: string,
  ): ClipWithMeta | null;
  addAudioClip(
    sourceId: string,
    startUs: number,
    endUs: number,
    meta?: Record<string, unknown>,
    groupId?: string,
  ): ClipWithMeta | null;
  findClip(clipId: number): ClipWithMeta | null;
  findClipTrack(clipId: number): { id: number; clips: ClipWithMeta[] } | null;
  removeClip(clipId: number): boolean;
  splitClip(clipId: number, splitAtUs: number): number | null;
  moveClip(clipId: number, newStartUs: number): boolean;
  trimClip(
    clipId: number,
    newStartUs: number,
    newEndUs: number,
    newSourceStartUs: number,
  ): boolean;
  setClipMeta(clipId: number, metaPatch: Record<string, unknown>): void;
  getClipMeta(clipId: number): Record<string, unknown> | null;
  computeDuration(): number;
  getDurationSec(): number;
  toRustJson(): string;
  loadFromRustJson(json: string): void;
  verifyRoundTrip(rustJson: string, receivedJson: string): boolean;
  getProject(): import('../state/types').Project | null;
  getLinkedClipIds(clipId: number): number[];
  saveState(): import('../state/types').SavedState;
  loadState(state: import('../state/types').SavedState): void;
}

/** Shape of the S (UI state) object from ui.js */
interface UIState {
  time: number;
  dur: number;
  playing: boolean;
  rafId: number | null;
  lastTs: number | null;
  zoom: number;
  tool: string;
  selectedAR: string;
  timelineHeight: number;
}

interface MediaPoolItem {
  id: string;
  name: string;
  isReal?: boolean;
  dur?: string;
  thumbDataUrl?: string | null;
  width?: number;
  height?: number;
  picId?: number;
}

interface MediaPool {
  footage: MediaPoolItem[];
  audio: MediaPoolItem[];
  stock: {
    video: MediaPoolItem[];
    image: MediaPoolItem[];
    music: MediaPoolItem[];
  };
}

interface AINode {
  time: number;
  label: string;
  icon: string;
}

// Extend the Window interface
declare global {
  interface Window {
    // State
    IKState: IKStateAPI;
    S: UIState;
    videoClips: ClipWithMeta[];
    audioClips: ClipWithMeta[];

    // Media
    mediaPool: MediaPool;
    aiNodes: AINode[];

    // Engine callbacks
    onEngineStatus?: (msg: string) => void;
    onEngineError?: (e: EngineError) => void;
    onPlayheadUpdate?: (ms: number) => void;
    onThumbnailsUpdated?: (thumbnails: ThumbnailEntry[]) => void;
    onClipImported?: (data: ClipImportedData) => void;
    onTrimApplied?: (data: { durationMs: number }) => void;
    onSplitResult?: (data: {
      newClipId: number;
      originalClipId: number;
      splitAtMs: number;
      durationMs: number;
    }) => void;
    onPlaybackPaused?: () => void;
    onPlayheadScrub?: (timeSec: number, force?: boolean) => void;
    onTimelineSynced?: (ok: boolean, error?: string) => void;
    onProjectJsonReceived?: (json: string) => void;

    // UI functions (defined in ui.js)
    togglePlay: () => void;
    showToast: (msg: string, icon: string) => void;
    triggerSparkle: (el: HTMLElement) => void;
    renderMedia: (type: string, subType?: string | null) => void;
    renderClips: () => void;
    renderRuler: () => void;
    updatePlayhead: () => void;
    calculateTimelineDuration: () => number;
    autoFitZoom: () => void;
    resizeCanvas: () => void;
    handleExport: () => Promise<void>;
    resetGrade: () => void;
    reflectClipGrade: (clipId: number) => void;
    saveProject: () => void;
    openProject: () => void;
    skipTime: (delta: number) => void;
    submitCmd: () => void;
    applyAiAction: (type: string) => void;
    resetAiActions: () => void;
    insertAC: (text: string) => void;
    toggleFcb: () => void;
    saveSnapshot: () => void;
    undo: () => void;
    redo: () => void;

    // External libs
    MP4Box: {
      createFile: () => MP4BoxFile;
    };
    Mp4Muxer: {
      Muxer: new (config: Record<string, unknown>) => MP4Muxer;
      ArrayBufferTarget: new () => { buffer: ArrayBuffer };
    };
    lucide: {
      createIcons: (opts?: { nodes?: (Element | null)[] }) => void;
    };
    iklippaScore: () => number;
    DataStream: new (
      buffer?: ArrayBuffer,
      offset?: number,
      endian?: number,
    ) => { buffer: ArrayBuffer; BIG_ENDIAN: number };
  }

  // MP4Box types (minimal)
  interface MP4BoxFile {
    onReady: ((info: MP4BoxInfo) => void) | null;
    onSamples:
      | ((
          id: number,
          user: unknown,
          samples: import('../engine/types').MP4Sample[],
        ) => void)
      | null;
    onError: ((err: string) => void) | null;
    appendBuffer(buf: ArrayBuffer & { fileStart?: number }): void;
    flush(): void;
    start(): void;
    setExtractionOptions(
      id: number,
      user: unknown,
      opts: { nbSamples: number },
    ): void;
    getTrackById(id: number): MP4BoxTrack;
  }

  interface MP4BoxInfo {
    videoTracks: MP4BoxVideoTrack[];
    audioTracks: MP4BoxAudioTrack[];
  }

  interface MP4BoxVideoTrack {
    id: number;
    codec: string;
    track_width: number;
    track_height: number;
  }

  interface MP4BoxAudioTrack {
    id: number;
    codec: string;
    audio: {
      sample_rate: number;
      channel_count: number;
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface MP4BoxTrack {
    mdia: { minf: { stbl: { stsd: { entries: any[] } } } };
  }

  interface MP4Muxer {
    addVideoChunkRaw(
      buf: ArrayBuffer,
      type: string,
      timestamp: number,
      duration: number,
    ): void;
    finalize(): { buffer: ArrayBuffer };
  }

  // Make IKState available as a global (used by ui.js)
  // eslint-disable-next-line no-var
  var IKState: Window['IKState'];
}

export {};
