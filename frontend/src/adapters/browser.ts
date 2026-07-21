import type {
  VideoEncoderFactory,
  AudioEncoderFactory,
  AudioContextFactory,
  CanvasFactory,
  OffscreenCanvasFactory,
  VideoDecoderFactory,
  AudioDecoderFactory,
  SampleReader,
  RafScheduler,
  BlobFactory,
  UrlFactory,
  EncodedChunkFactory,
  EnginePorts,
} from './types';
import type { MP4Sample } from '../engine/types';

export const browserVideoEncoderFactory: VideoEncoderFactory = {
  create(output, error) {
    return new VideoEncoder({ output, error });
  },
};

export const browserVideoDecoderFactory: VideoDecoderFactory = {
  create(output, error) {
    return new VideoDecoder({ output, error });
  },
};

export const browserAudioDecoderFactory: AudioDecoderFactory = {
  create(output, error) {
    return new AudioDecoder({ output, error });
  },
};

export const browserAudioContextFactory: AudioContextFactory = {
  create() {
    const Ctor = (typeof window !== 'undefined' ? window.AudioContext : null)
      || ((typeof window !== 'undefined' ? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext : null));
    return new Ctor!();
  },
};

export const browserCanvasFactory: CanvasFactory = {
  createElement(name: string): HTMLElement {
    return document.createElement(name) as HTMLElement;
  },
  createCanvas() {
    return document.createElement('canvas');
  },
};

export const browserOffscreenCanvasFactory: OffscreenCanvasFactory = {
  create(width: number, height: number) {
    return new OffscreenCanvas(width, height);
  },
};

export const browserSampleReader: SampleReader = {
  readSampleData(file: File, sample: MP4Sample): Promise<ArrayBuffer> {
    return file.slice(sample.offset, sample.offset + sample.size).arrayBuffer();
  },
};

export const browserRafScheduler: RafScheduler = {
  requestAnimationFrame(cb) {
    return requestAnimationFrame(cb);
  },
  cancelAnimationFrame(handle) {
    cancelAnimationFrame(handle);
  },
};

export const browserEncodedChunkFactory: EncodedChunkFactory = {
  createVideoChunk(init) {
    return new EncodedVideoChunk(init);
  },
  createAudioChunk(init) {
    return new EncodedAudioChunk(init);
  },
};

export const browserBlobFactory: BlobFactory = {
  create(parts, options) {
    return new Blob(parts, options);
  },
};

export const browserUrlFactory: UrlFactory = {
  createObjectURL(obj) {
    return URL.createObjectURL(obj);
  },
  revokeObjectURL(url) {
    URL.revokeObjectURL(url);
  },
};

export const browserAudioEncoderFactory: AudioEncoderFactory = {
  create(output, error) {
    return new AudioEncoder({ output, error });
  },
};

export const browserEnginePorts: EnginePorts = {
  videoEncoderFactory: browserVideoEncoderFactory,
  videoDecoderFactory: browserVideoDecoderFactory,
  audioEncoderFactory: browserAudioEncoderFactory,
  audioDecoderFactory: browserAudioDecoderFactory,
  audioContextFactory: browserAudioContextFactory,
  canvasFactory: browserCanvasFactory,
  offscreenCanvasFactory: browserOffscreenCanvasFactory,
  rafScheduler: browserRafScheduler,
  sampleReader: browserSampleReader,
  blobFactory: browserBlobFactory,
  urlFactory: browserUrlFactory,
};
