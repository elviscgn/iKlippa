# iKlippa Frontend Architecture

This document outlines the core architectural decisions and data flow within the iKlippa video editor frontend to help future developers (and LLMs) understand how the systems interact.

## 1. Multi-Threaded Engine (WebCodecs + Canvas)
The editor separates the heavy lifting of video decoding from the UI rendering to maintain a strict 60 FPS target.

*   **Worker Thread (`worker.ts`)**: 
    *   Uses the WebCodecs API (`VideoDecoder`, `AudioDecoder`) to decode raw MP4 samples.
    *   It operates exclusively in **Source Time** (the actual timecode of the raw video file).
    *   When the playhead seeks, WebCodecs requires sequential decoding from the nearest keyframe. The worker decodes all intermediate frames but only flags the target frame for the main thread to paint.
*   **Main Thread (`engine.ts`)**: 
    *   Receives decoded frames (`ImageData`) and audio chunks from the worker via `postMessage`.
    *   Maintains a `pendingFrames` and `pendingAudio` cache.
    *   Runs the primary `requestAnimationFrame` loop (`renderLoop`) which composites the frames onto an HTML5 `<canvas>` using the timeline's Z-index and opacity metadata.

## 2. Time Mapping (Timeline vs. Source)
Because an editor allows users to cut, trim, and move clips, the time on the timeline does not 1-to-1 match the time in the source video file.

*   **Timeline Time**: The global time of the project playhead (e.g., 30.5 seconds).
*   **Source Time**: The time inside the raw video file (e.g., 10.2 seconds into `test.mp4`).

**The Bridge**: `engine.ts` provides `mapTimelineToSourceMs()` and `mapSourceToTimelineMs()`. 
*   When the user scrubs the timeline, the engine translates the Timeline Time to Source Time and sends a `seek` command to the worker.
*   When the worker sends decoded audio chunks tagged with Source Time, the engine translates them back to Timeline Time to schedule them accurately on the Web Audio API context.

## 3. Strict State Guards (The "Lazy" Pitfalls Avoided)
During development, several rendering bugs occurred due to "lazy" state management. These have been explicitly designed out of the system:

1.  **Audio Duplication (The "Burning Speaker" Bug)**: 
    When paused, audio chunks stay in the `pendingAudio` cache. If playback starts again without wiping the cache, those chunks get scheduled to play *alongside* new chunks streaming in from the worker. We enforce strict `pendingAudio.clear()` commands on pause and play-starts to guarantee audio chunks are scheduled exactly once.
2.  **Seek Fast-Forwarding**: 
    Because the worker must sequentially decode from a keyframe up to the seek target, it rapidly emits intermediate frames. The main thread implements a strict **target lock** (`msg.ms >= seekTargetMs - 33`) so it actively drops intermediate pre-roll frames when paused, preventing the canvas from flickering or playing in fast-forward.
3.  **Throttling & Stale Frames**: 
    The engine aggressively garbage collects old frames via `cleanupStaleFrames()` to prevent out-of-memory crashes when dealing with massive 4K raw frame buffers in the heap.
4.  **Audio Decode Ahead-Throttle & Resume Reseed**: 
    The worker never decodes audio further than `AUDIO_LOOKAHEAD_MS` (1s) past the playhead. Without this cap the audio front ran arbitrarily far ahead (decoding the whole file during playback), which exploded the main thread's scheduled-node list and meant a pause discarded audio the worker would never re-send. Additionally, `startPlayback` posts a `resync_audio` command so the worker rewinds its audio decode front to the playhead and re-primes; leftover pre-pause chunks in `pendingAudio` are dropped (never scheduled) so every chunk is scheduled exactly once. Finished audio nodes are removed from `scheduledAudioNodes` via `onended` to keep the list bounded.

## 4. Master Clock Strategy
Most standard video players use the audio track as the master clock to prevent drift. However, in an NLE (Non-Linear Editor), the playhead frequently traverses empty gaps where no audio exists, or overlaps multiple audio tracks. 
Because of this, **Absolute Wall-Clock Time** (`performance.now()`) is the master clock driving the `requestAnimationFrame` interpolation. Audio nodes are scheduled explicitly using `AudioContext.currentTime + offset` based on this absolute timeline.

## 5. Transferable Objects (Zero-Copy)
When 4K raw frames are decoded by the worker, they must be sent to the main thread for compositing. To prevent catastrophic memory clones, frames are passed using **Transferable Objects**.
*   In `worker.ts`, the frame buffer is detached and zero-copied across the boundary: `postMessage(msg, [frameBuffer])`.
*   If this is ever broken, deep-copying 4K `ImageData` on every frame will instantly blow the 60 FPS budget.

## 6. UI Layer (`playback.ts`, `timeline.ts`)
The UI is strictly separated from the engine. It communicates with `engine.ts` primarily through global hooks attached to the `window` object (e.g., `window.togglePlay`, `window.onPlayheadScrub`). 
*   **Technical Debt Note**: The `window.*` hooks are acknowledged technical debt from the initial prototyping phase. They lack type safety and teardown lifecycles. They should be migrated to a dedicated Pub/Sub `EventBus`.
*   The UI never touches the `AudioContext` or `CanvasRenderingContext2D`.
*   The UI manages its own internal playhead interpolation loop for 60 FPS smoothness, which is periodically synced by the `engine.ts` absolute state.

## 7. Error Boundary (No Silent Failures)
All engine errors — WASM panics, WebCodecs crashes, worker promise rejections — are funnelled into a single typed protocol and surfaced as UI toasts. The full design and rollout plan lives in `error-handling-blueprint.md`.

*   **Protocol (`types.ts`)**: `EngineError { code, message, detail, fatal, opId, at }`. The worker reports failures as `{ type: 'error', error }` messages.
*   **Worker funnel (`worker.ts`)**: `reportError()` is the ONLY way errors leave the worker. It captures: decoder error callbacks, the message-queue catch (previously a silent `wwarn`), WASM `process_frame()` panics (always fatal — with `panic=abort` the module is poisoned), and global `self.onerror` / `self.onunhandledrejection` nets. A ring buffer of the last 200 log lines is attached to every report so crashes are diagnosable without a repro.
*   **Main-thread sink (`errors.ts` + `engine.ts`)**: the `errorBus` pub/sub receives worker reports, `worker.onerror` / `worker.onmessageerror`, explicit local failures (`emitLocal`: demux, export, playback), and a last-resort `window.unhandledrejection` net. A `WeakSet` dedupes errors already reported with a specific code so nothing toasts twice.
*   **UI (`main.ts`)**: `window.onEngineError` renders a toast (`USER_ERROR_MESSAGES[code]`); fatal errors also update the status badge.
*   **The rule**: an error must terminate in a recovery routine or a visible toast — never the console.
