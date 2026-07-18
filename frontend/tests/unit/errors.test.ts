import { describe, it, expect, vi } from 'vitest';
import {
  errorBus,
  makeEngineError,
  emitLocal,
  wasReported,
  USER_ERROR_MESSAGES,
} from '../../src/engine/errors';
import type { EngineError, EngineErrorCode } from '../../src/engine/types';

describe('errorBus', () => {
  it('delivers emitted errors to all listeners', () => {
    const a: EngineError[] = [];
    const b: EngineError[] = [];
    const offA = errorBus.on((e) => a.push(e));
    const offB = errorBus.on((e) => b.push(e));

    const err = makeEngineError('WASM_PANIC', new Error('boom'));
    errorBus.emit(err);
    offA();
    offB();

    expect(a).toEqual([err]);
    expect(b).toEqual([err]);
  });

  it('unsubscribes via the returned function', () => {
    const received: EngineError[] = [];
    const off = errorBus.on((e) => received.push(e));
    off();
    errorBus.emit(makeEngineError('PROTOCOL_ERROR', new Error('x')));
    expect(received).toHaveLength(0);
  });

  it('isolates a throwing listener so others still receive the error', () => {
    const received: EngineError[] = [];
    const offBad = errorBus.on(() => {
      throw new Error('listener bug');
    });
    const offGood = errorBus.on((e) => received.push(e));
    const err = makeEngineError('WORKER_DIED', new Error('dead'));

    expect(() => errorBus.emit(err)).not.toThrow();
    offBad();
    offGood();
    expect(received).toEqual([err]);
  });
});

describe('makeEngineError', () => {
  it('wraps non-Error values', () => {
    const e = makeEngineError('DEMUX_FAILED', 'string failure');
    expect(e.message).toBe('string failure');
    expect(e.code).toBe('DEMUX_FAILED');
  });

  it('defaults fatal to true and stamps a time', () => {
    const e = makeEngineError('DECODER_VIDEO_FATAL', new Error('decode died'));
    expect(e.fatal).toBe(true);
    expect(typeof e.at).toBe('number');
    expect(e.detail).toContain('decode died');
  });

  it('honours explicit fatal:false and opId', () => {
    const e = makeEngineError('SEEK_TIMEOUT', new Error('slow'), { fatal: false, opId: 7 });
    expect(e.fatal).toBe(false);
    expect(e.opId).toBe(7);
  });
});

describe('reported-error dedupe', () => {
  it('marks errors funnelled via emitLocal', () => {
    const cause = new Error('already handled');
    emitLocal('DEMUX_FAILED', cause);
    expect(wasReported(cause)).toBe(true);
  });

  it('does not mark unrelated errors, primitives, or null', () => {
    expect(wasReported(new Error('other'))).toBe(false);
    expect(wasReported('string rejection')).toBe(false);
    expect(wasReported(null)).toBe(false);
    expect(wasReported(undefined)).toBe(false);
  });
});

describe('USER_ERROR_MESSAGES', () => {
  it('has a user-facing message for every error code', () => {
    const codes: EngineErrorCode[] = [
      'WASM_INIT_FAILED',
      'WASM_PANIC',
      'LOAD_FAILED',
      'DECODER_VIDEO_FATAL',
      'DECODER_AUDIO_FATAL',
      'DECODER_UNSUPPORTED',
      'DEMUX_FAILED',
      'DEMUX_STALLED',
      'LOAD_TIMEOUT',
      'SEEK_TIMEOUT',
      'PLAYBACK_STARVATION',
      'WORKER_UNCAUGHT',
      'WORKER_UNHANDLED_REJECTION',
      'WORKER_DIED',
      'WORKER_WEDGED',
      'UNHANDLED_REJECTION',
      'EXPORT_FAILED',
      'PROTOCOL_ERROR',
    ];
    for (const code of codes) {
      expect(USER_ERROR_MESSAGES[code], `missing message for ${code}`).toBeTruthy();
    }
  });
});
