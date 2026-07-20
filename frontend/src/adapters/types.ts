import type { MP4Sample } from '../engine/types';

export interface EncodedVideoChunkOutput {
  byteLength: number;
  copyTo(destination: ArrayBuffer): void;
  timestamp: number;
  type: EncodedVideoChunkType;
  duration: number | null;
}

export interface VideoEncoderPort {
  configure(config: VideoEncoderConfig): void;
  encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void;
  flush(): Promise<void>;
  close(): void;
}

export interface VideoDecoderPort {
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
  readonly state: CodecState;
  readonly decodeQueueSize: number;
}

export interface AudioDecoderPort {
  configure(config: AudioDecoderConfig): void;
  decode(chunk: EncodedAudioChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
  readonly state: CodecState;
  readonly decodeQueueSize: number;
}

export interface EncodedAudioChunk {
  byteLength: number;
  copyTo(destination: ArrayBuffer): void;
  timestamp: number;
  type: EncodedAudioChunkType;
  duration: number | null;
}

export interface AudioEncoderPort {
  configure(config: AudioEncoderConfig): void;
  encode(data: AudioData): void;
  flush(): Promise<void>;
  close(): void;
}

export interface AudioContextPort {
  resume(): Promise<void>;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: string;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
  createStereoPanner(): StereoPannerNode;
  createDynamicsCompressor(): DynamicsCompressorNode;
  readonly destination: AudioDestinationNode;
  close(): Promise<void>;
}

export interface CanvasPort {
  width: number;
  height: number;
  getContext(contextId: '2d', options?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D | null;
  toDataURL(type?: string, quality?: number): string;
}

export interface OffscreenCanvasPort {
  width: number;
  height: number;
  getContext(contextId: '2d', options?: Record<string, unknown>): OffscreenCanvasRenderingContext2D | null;
}

export interface EncodedChunkFactory {
  createVideoChunk(init: EncodedVideoChunkInit): EncodedVideoChunk;
  createAudioChunk(init: EncodedAudioChunkInit): EncodedAudioChunk;
}

export interface VideoEncoderFactory {
  create(output: (chunk: EncodedVideoChunkOutput) => void, error: (err: Error) => void): VideoEncoderPort;
}

export interface AudioEncoderFactory {
  create(output: (chunk: EncodedAudioChunk) => void, error: (err: Error) => void): AudioEncoderPort;
}

export interface AudioContextFactory {
  create(): AudioContextPort;
}

export interface CanvasFactory {
  createElement(name: string): HTMLElement;
  createCanvas(): CanvasPort;
}

export interface OffscreenCanvasFactory {
  create(width: number, height: number): OffscreenCanvasPort;
}

export interface VideoDecoderFactory {
  create(output: (frame: VideoFrame) => void, error: (err: Error) => void): VideoDecoderPort;
}

export interface AudioDecoderFactory {
  create(output: (data: AudioData) => void, error: (err: Error) => void): AudioDecoderPort;
}

export interface SampleReader {
  readSampleData(file: File, sample: MP4Sample): Promise<ArrayBuffer>;
}

export interface RafScheduler {
  requestAnimationFrame(cb: (ts: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

export interface EnginePorts {
  videoEncoderFactory: VideoEncoderFactory;
  videoDecoderFactory: VideoDecoderFactory;
  audioEncoderFactory: AudioEncoderFactory;
  audioDecoderFactory: AudioDecoderFactory;
  audioContextFactory: AudioContextFactory;
  canvasFactory: CanvasFactory;
  offscreenCanvasFactory: OffscreenCanvasFactory;
  rafScheduler: RafScheduler;
  sampleReader: SampleReader;
  blobFactory: BlobFactory;
  urlFactory: UrlFactory;
}

export interface BlobFactory {
  create(parts: BlobPart[], options?: BlobPropertyBag): Blob;
}

export interface UrlFactory {
  createObjectURL(obj: Blob | MediaSource): string;
  revokeObjectURL(url: string): void;
}
