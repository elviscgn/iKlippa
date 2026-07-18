// @vitest-environment jsdom
/**
 * Tests for the main-thread error sink:
 *   - worker 'error' messages route to errorBus + window.onEngineError
 *   - the last-resort window unhandledrejection net fires once per error
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setPorts, resetPorts } from '../../src/adapters';
import { fakeEnginePorts, expectNoLeaks, resetLeakRegistry } from '../fakes';
import { handleWorkerMessage } from '../../src/engine/engine';
import { errorBus, emitLocal } from '../../src/engine/errors';
import type { EngineError } from '../../src/engine/types';

beforeEach(() => {
  resetLeakRegistry();
  setPorts(fakeEnginePorts);
});

afterEach(() => {
  expectNoLeaks();
  resetPorts();
});

function fireUnhandledRejection(reason: unknown): void {
  const ev = new Event('unhandledrejection');
  Object.defineProperty(ev, 'reason', { value: reason });
  Object.defineProperty(ev, 'preventDefault', { value: vi.fn() });
  window.dispatchEvent(ev);
}

describe('engine error sink', () => {
  it('routes worker error messages to errorBus and window.onEngineError', () => {
    const received: EngineError[] = [];
    const off = errorBus.on((e) => received.push(e));
    const onEngineError = vi.fn();
    (window as any).onEngineError = onEngineError;

    const sample: EngineError = {
      code: 'WASM_PANIC',
      message: 'rust panic: unreachable',
      fatal: true,
      at: 0,
    };
    handleWorkerMessage({ data: { type: 'error', error: sample } } as MessageEvent);

    off();
    delete (window as any).onEngineError;

    expect(received).toHaveLength(1);
    expect(received[0]!.code).toBe('WASM_PANIC');
    expect(onEngineError).toHaveBeenCalledTimes(1);
    expect(onEngineError.mock.calls[0]![0].code).toBe('WASM_PANIC');
  });

  it('last-resort window net reports unknown rejections as UNHANDLED_REJECTION', () => {
    const received: EngineError[] = [];
    const off = errorBus.on((e) => received.push(e));

    fireUnhandledRejection(new Error('mystery rejection'));
    off();

    expect(received).toHaveLength(1);
    expect(received[0]!.code).toBe('UNHANDLED_REJECTION');
    expect(received[0]!.fatal).toBe(false);
  });

  it('window net skips errors already funnelled with a specific code', () => {
    const received: EngineError[] = [];
    const off = errorBus.on((e) => received.push(e));

    const known = new Error('known demux failure');
    emitLocal('DEMUX_FAILED', known); // → received[0]
    fireUnhandledRejection(known); // must be deduped
    fireUnhandledRejection(new Error('different error')); // must still fire
    off();

    expect(received.map((e) => e.code)).toEqual(['DEMUX_FAILED', 'UNHANDLED_REJECTION']);
  });
});
