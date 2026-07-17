import type { AudioContextFactory, AudioContextPort } from '../../src/adapters/types';
import {
  registerTracked,
  unregisterTracked,
  assertNotClosed,
  isClosed,
} from './leakRegistry';

class FakeAudioBuffer {
  private _channels: number;
  private _length: number;
  private _sampleRate: number;
  private _data: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    this._channels = channels;
    this._length = length;
    this._sampleRate = sampleRate;
    this._data = Array.from({ length: channels }, () => new Float32Array(length));
    registerTracked(this);
  }

  get sampleRate(): number { return this._sampleRate; }
  get length(): number { return this._length; }
  get duration(): number { return this._length / this._sampleRate; }
  get numberOfChannels(): number { return this._channels; }

  getChannelData(channel: number): Float32Array {
    assertNotClosed(this);
    return this._data[channel] ?? new Float32Array(0);
  }

  copyFromChannel(destination: Float32Array, channelNumber: number, bufferOffset?: number): void {
    assertNotClosed(this);
    const src = this._data[channelNumber];
    if (!src) return;
    const offset = bufferOffset ?? 0;
    const len = Math.min(destination.length, src.length - offset);
    destination.set(src.subarray(offset, offset + len));
  }

  copyToChannel(source: Float32Array, channelNumber: number, bufferOffset?: number): void {
    assertNotClosed(this);
    const dst = this._data[channelNumber];
    if (!dst) return;
    const offset = bufferOffset ?? 0;
    const len = Math.min(source.length, dst.length - offset);
    dst.set(source.subarray(0, len), offset);
  }

  close(): void {
    if (isClosed(this)) return;
    this._data = [];
    unregisterTracked(this);
  }
}

export type FakeAudioBufferType = FakeAudioBuffer;

class FakeAudioBufferSourceNode {
  _buffer: AudioBuffer | null = null;
  _connected = false;
  _scheduled = false;
  _stopped = false;
  _scheduleTime?: number;
  _stopTime?: number;

  constructor() {
    registerTracked(this);
  }

  get buffer(): AudioBuffer | null { return this._buffer; }
  set buffer(val: AudioBuffer | null) { this._buffer = val; }

  connect(_destination: AudioNode, _output?: number, _input?: number): AudioNode {
    assertNotClosed(this);
    this._connected = true;
    return this as unknown as AudioNode;
  }

  disconnect(): void {}
  start(when?: number, _offset?: number, _duration?: number): void {
    assertNotClosed(this);
    this._scheduled = true;
    this._scheduleTime = when;
  }
  stop(when?: number): void {
    this._stopped = true;
    this._stopTime = when;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(_event: Event): boolean { return true; }

  channelCount: number = 2;
  channelCountMode: ChannelCountMode = 'explicit';
  channelInterpretation: ChannelInterpretation = 'speakers';
  get context(): BaseAudioContext { return undefined as unknown as BaseAudioContext; }
  get numberOfInputs(): number { return 0; }
  get numberOfOutputs(): number { return 1; }
  onended: ((this: AudioScheduledSourceNode, ev: Event) => any) | null = null;
  playbackRate: AudioParam = undefined as unknown as AudioParam;
  detune: AudioParam = undefined as unknown as AudioParam;
  loop: boolean = false;
  loopStart: number = 0;
  loopEnd: number = 0;

  close(): void {
    if (isClosed(this)) return;
    unregisterTracked(this);
  }
}

class FakeAudioDestinationNode {
  get maxChannelCount(): number { return 2; }
  channelCount: number = 2;
  channelCountMode: ChannelCountMode = 'explicit';
  channelInterpretation: ChannelInterpretation = 'speakers';
  get context(): BaseAudioContext { return undefined as unknown as BaseAudioContext; }
  get numberOfInputs(): number { return 1; }
  get numberOfOutputs(): number { return 0; }
  connect(): AudioNode { return this as unknown as AudioNode; }
  disconnect(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(_event: Event): boolean { return true; }
}

class FakeAudioContext {
  private _state: AudioContextState = 'suspended';
  private _currentTime = 0;
  private _sampleRate = 48000;

  get currentTime(): number { return this._currentTime; }
  addTime(delta: number): void { this._currentTime += delta; }

  get sampleRate(): number { return this._sampleRate; }
  get state(): string { return this._state; }

  _destination = new FakeAudioDestinationNode();

  get destination(): AudioDestinationNode {
    return this._destination as unknown as AudioDestinationNode;
  }

  async resume(): Promise<void> {
    this._state = 'running';
  }

  async suspend(): Promise<void> {
    this._state = 'suspended';
  }

  async close(): Promise<void> {
    this._state = 'closed';
  }

  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate) as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    return new FakeAudioBufferSourceNode() as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    return {
      connect: () => {},
      gain: { value: 1 },
    } as unknown as GainNode;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(_event: Event): boolean { return true; }

  get baseLatency(): number { return 0; }
  get outputLatency(): number { return 0; }
  get onstatechange(): ((this: BaseAudioContext, ev: Event) => any) | null {
    return null;
  }
  set onstatechange(_v) {}
}

export type FakeAudioContextType = FakeAudioContext;

export const fakeAudioContextFactory: AudioContextFactory = {
  create() {
    return new FakeAudioContext() as unknown as AudioContextPort;
  },
};
