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

## 4. UI Layer (`playback.ts`, `timeline.ts`)
The UI is strictly separated from the engine. It communicates with `engine.ts` primarily through global hooks attached to the `window` object (e.g., `window.togglePlay`, `window.onPlayheadScrub`). 
*   The UI never touches the `AudioContext` or `CanvasRenderingContext2D`.
*   The UI manages its own internal playhead interpolation loop for 60 FPS smoothness, which is periodically synced by the `engine.ts` absolute state.
