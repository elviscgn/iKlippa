/**
 * iKlippa — errors.ts
 * The main-thread error sink. Every engine failure — worker-reported or
 * locally detected — is emitted on the errorBus exactly once, and is
 * bridged to the UI toast layer. Nothing terminates in the console.
 */

import type { EngineError, EngineErrorCode } from './types';

type Listener = (e: EngineError) => void;
const listeners = new Set<Listener>();

export const errorBus = {
  emit(e: EngineError): void {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch (err) {
        // A broken toast listener must never take down the error path itself.
        console.error('[iKlippa:error] error listener threw', err);
      }
    }
  },
  on(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** Human-readable toast text per error code. */
export const USER_ERROR_MESSAGES: Record<EngineErrorCode, string> = {
  WASM_INIT_FAILED: 'The video engine failed to start',
  WASM_PANIC: 'The video engine crashed',
  LOAD_FAILED: 'The video failed to load in the decoder',
  DECODER_VIDEO_FATAL: 'The video decoder crashed',
  DECODER_AUDIO_FATAL: 'The audio decoder crashed',
  DECODER_UNSUPPORTED: 'This codec is not supported by your browser',
  DEMUX_FAILED: 'The video file could not be read',
  DEMUX_STALLED: 'Reading the video file stalled',
  LOAD_TIMEOUT: 'Loading the video timed out',
  SEEK_TIMEOUT: 'Seeking is taking longer than expected',
  PLAYBACK_STARVATION: 'Playback is starving for decoded frames',
  WORKER_UNCAUGHT: 'The background worker crashed',
  WORKER_UNHANDLED_REJECTION: 'A background task failed',
  WORKER_DIED: 'The background worker crashed',
  WORKER_WEDGED: 'The background worker stopped responding',
  UNHANDLED_REJECTION: 'An unexpected error occurred',
  EXPORT_FAILED: 'Export failed',
  PROTOCOL_ERROR: 'An internal engine error occurred',
};

export function makeEngineError(
  code: EngineErrorCode,
  err: unknown,
  opts: { fatal?: boolean; opId?: number } = {},
): EngineError {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : String(err));
  return {
    code,
    message: e.message || USER_ERROR_MESSAGES[code],
    detail: e.stack,
    fatal: opts.fatal ?? true,
    opId: opts.opId,
    at: performance.now(),
  };
}

// ── Reported-error dedupe ───────────────────────────────────────────────
// Errors funnelled explicitly (with a specific code) are marked, so the
// last-resort window 'unhandledrejection' net doesn't toast them twice.
const reported = new WeakSet<object>();

function isMarkable(err: unknown): err is object {
  return err !== null && (typeof err === 'object' || typeof err === 'function');
}

export function wasReported(err: unknown): boolean {
  return isMarkable(err) && reported.has(err);
}

/** Create an EngineError, mark the cause as reported, and emit it. */
export function emitLocal(
  code: EngineErrorCode,
  err: unknown,
  opts: { fatal?: boolean; opId?: number } = {},
): EngineError {
  if (isMarkable(err)) reported.add(err);
  const e = makeEngineError(code, err, opts);
  errorBus.emit(e);
  return e;
}
