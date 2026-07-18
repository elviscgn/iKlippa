import type { EnginePorts, RafScheduler, BlobFactory, UrlFactory } from '../../src/adapters/types';
import { fakeVideoEncoderFactory } from './fakeVideoEncoder';
import { fakeAudioContextFactory, type FakeAudioContextType } from './fakeAudioContext';
import { fakeCanvasFactory, type FakeCanvasType } from './fakeCanvas';
import { expectNoLeaks, resetLeakRegistry } from './leakRegistry';

const fakeRafScheduler: RafScheduler = {
  requestAnimationFrame(_cb: (ts: number) => void): number {
    return 1;
  },
  cancelAnimationFrame(_handle: number): void {},
};

const fakeBlobFactory: BlobFactory = {
  create(parts?: BlobPart[], _options?: BlobPropertyBag): Blob {
    return new Blob(parts);
  },
};

const fakeUrlFactory: UrlFactory = {
  createObjectURL(_obj: Blob | MediaSource): string {
    return 'blob:fake';
  },
  revokeObjectURL(_url: string): void {},
};

export const fakeEnginePorts: EnginePorts = {
  videoEncoderFactory: fakeVideoEncoderFactory,
  videoDecoderFactory: fakeVideoEncoderFactory as any,
  audioDecoderFactory: fakeVideoEncoderFactory as any,
  audioContextFactory: fakeAudioContextFactory,
  canvasFactory: fakeCanvasFactory,
  offscreenCanvasFactory: fakeCanvasFactory as any,
  rafScheduler: fakeRafScheduler,
  sampleReader: {
    readSampleData: async () => new ArrayBuffer(0),
  },
  blobFactory: fakeBlobFactory,
  urlFactory: fakeUrlFactory,
};

export { expectNoLeaks, resetLeakRegistry };
export { fakeVideoEncoderFactory } from './fakeVideoEncoder';
export { fakeAudioContextFactory, type FakeAudioContextType } from './fakeAudioContext';
export { fakeCanvasFactory, type FakeCanvasType } from './fakeCanvas';
