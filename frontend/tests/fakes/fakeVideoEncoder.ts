import type {
  VideoEncoderPort,
  VideoEncoderFactory,
  EncodedVideoChunkOutput,
} from '../../src/adapters/types';
import {
  registerTracked,
  unregisterTracked,
  assertNotClosed,
  isClosed,
} from './leakRegistry';

class FakeVideoEncoder implements VideoEncoderPort {
  private _state: CodecState = 'unconfigured';
  private _output: ((chunk: EncodedVideoChunkOutput) => void) | null;
  private _error: ((err: Error) => void) | null;
  private _config: VideoEncoderConfig | null = null;

  constructor(
    output: (chunk: EncodedVideoChunkOutput) => void,
    error: (err: Error) => void,
  ) {
    this._output = output;
    this._error = error;
    registerTracked(this);
  }

  configure(config: VideoEncoderConfig): void {
    assertNotClosed(this);
    this._config = config;
    this._state = 'configured';
  }

  encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void {
    assertNotClosed(this);
    if (this._state !== 'configured') {
      this._error?.(new Error('InvalidStateError: Encoder not configured'));
      return;
    }

    const ts =
      frame.timestamp ??
      (frame as unknown as { _timestamp?: number })._timestamp ??
      0;
    const dur =
      frame.duration ??
      (frame as unknown as { _duration?: number })._duration ??
      null;
    const isKey = options?.keyFrame ?? false;

    const fakeChunk: EncodedVideoChunkOutput = {
      byteLength: (frame as unknown as { _byteLength?: number })._byteLength ?? 1024,
      copyTo(destination: ArrayBuffer) {
        new Uint8Array(destination).fill(0);
      },
      timestamp: ts,
      type: isKey ? 'key' : 'delta',
      duration: dur,
    };

    this._output?.(fakeChunk);
  }

  async flush(): Promise<void> {
    assertNotClosed(this);
    this._state = 'configured';
  }

  close(): void {
    if (isClosed(this)) return;
    this._state = 'closed';
    this._output = null;
    this._error = null;
    this._config = null;
    unregisterTracked(this);
  }

  get state(): CodecState {
    return this._state;
  }
}

export const fakeVideoEncoderFactory: VideoEncoderFactory = {
  create(output, error) {
    return new FakeVideoEncoder(output, error);
  },
};
