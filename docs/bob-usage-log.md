# IBM Bob Usage Log

A chronological and architectural ledger of how the iKlippa engineering team collaborated with **IBM Bob (powered by watsonx Code Assistant)** to design, optimize, and secure our browser-native video editing engine.

---

## Team Division of Labor

To maximize our development speed during this sprint, we divided the engineering responsibilities into two distinct domains:

*   **Elvis Chege (Systems & Render Architecture):** Focused on frontend UI, Web Worker threading, WebCodecs integration, WASM linear memory allocations, and optimized Rust graphics loops.
*   **Mphele (Backend & AI Model Orchestration):** Focused on scaffolding the API gateways, integrating IBM watsonx / Granite LLM microservices, optimizing semantic metadata search, and managing asynchronous task queues.

**IBM Bob** acted as a force multiplier for both of us, serving as a systems architect for Elvis and a backend/ML orchestrator for Mphele.

---

##  Day 1: Architectural Scaffolding & The Memory Bridge

### Systems & Render Pipeline (Elvis with IBM Bob)
*   **The Bottleneck:** Video processing requires copying raw pixel arrays across the JavaScript/WASM boundary. At 1080p/30fps, copying 8.2MB of uncompressed RGBA pixel data per frame between threads creates nearly 500MB of garbage memory every second. This thrashes the browser's Garbage Collector (GC), dropping playback below 10 FPS.
*   **The Collaboration:**
    *   Elvis consulted Bob on WebAssembly memory layouts. Bob suggested bypass-allocation through a **stable pre-allocated memory pool** (`FramePool`) inside Rust's linear memory.
    *   Bob helped write the stable pointer references in `lib.rs`, which expose the memory location via `frame_ptr()`.
    *   In `engine.js`, we wrapped this pointer in a `Uint8ClampedArray` view. By calling WebCodecs' `copyTo()` directly onto this view, the hardware-decoded frame is written straight into WASM memory. 
*   **Result:** Reduced JavaScript-to-WASM memory copies to **exactly zero**, completely eliminating GC thrashing.

### 🔌 Backend & API Gateway (Mphele with IBM Bob)
*   **The Challenge:** The NLE needs to call IBM watsonx / Granite APIs for our "AI Director" features (smart subtitle generation, semantic cut suggestions). We had to securely scaffold the API gateway so that our private API keys were never exposed to the client browser.
*   **The Collaboration:**
    *   Mphele worked with Bob to scaffold a lightweight Node.js/Express gateway. 
    *   Bob pointed out that because we are running in **Cross-Origin Isolated** mode (which our high-performance WASM memory requires), our backend proxy server must strictly serve specific security headers (`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`).
    *   Bob helped draft the server code to inject these headers onto every resource request, preventing the browser from instantly blocking our asset loads.
*   **Result:** Scaffolding complete with 100% security compliance.

---

## Day 2: Multithreading & Hardware Resilience

### Systems & Render Pipeline (Elvis with IBM Bob)
*   **The Bottleneck:** Running colorspace conversions on the browser's Main Thread caused the UI to stutter. Furthermore, importing HEVC files on Apple Silicon (M1) threw crashes due to opaque `null` format frames blocking WebCodecs' `copyTo()` function.
*   **The Collaboration:**
    *   Bob directed Elvis to isolate the video decoding and WASM grading pipelines inside a dedicated **Web Worker** (`worker.js`).
    *   To solve the input lag, Bob designed a **Lookahead Backpressure Loop**. Instead of flooding the worker, the main thread now only requests top-up frames when the buffer drops below 15 frames.
    *   For the M1 HEVC crash, Bob guided us to build an **`OffscreenCanvas` fallback** in the worker, configuring the canvas with `{ willReadFrequently: true }` to keep memory on unified system RAM, enabling rapid colorspace readbacks.
*   **Result:** Playback achieved a locked **16.67ms (60 FPS)** rendering rate on the main thread, and HEVC crashes were fully resolved.

### Backend & AI Model Orchestration (Mphele with IBM Bob)
*   **The Challenge:** Aligning the AI transcription output (sentences and timestamps) to our video timeline required matching speech timestamps with our demuxed video presentation timestamps (CTS). A mismatch would cause captions to drift out of sync.
*   **The Collaboration:**
    *   Mphele used Bob to write a parsing utility that maps transcription sentences directly to the video's millisecond markers.
    *   Bob suggested an optimized search tree in our backend JSON parser to quickly query the current caption based on `playheadMs`, keeping timeline lookups lightning fast.
*   **Result:** Real-time subtitle rendering with zero drift, fully synchronized with the playhead.

---

## Day 3: State Synchronization & Rust Optimizations

### Systems & Render Pipeline (Elvis with IBM Bob)
*   **The Bottleneck:** Rapidly scrubbing the timeline caused the player to throw an unhandled exception: `Uncaught DataError: A key frame is required after configure()`. Additionally, the Rust pixel loop was taking 65ms per frame, which was too slow.
*   **The Collaboration:**
    *   Bob designed a **Generation Counter** (Concurrency Shield) to solve the seek crash. Every time a seek occurs, we increment a generation ID. When an async disk read completes, the task verifies its generation. If it does not match, the stale frame is silently discarded, preventing WebCodecs alignment crashes.
    *   Bob analyzed the flat 1D pixel loop in `lib.rs` and helped refactor it into a nested 2D loop. This removed costly integer modulo (`%`) and division (`/`) operations on every pixel.
*   **Result:** Eliminated WebCodecs state crashes during rapid scrubbing, and drastically optimized the Rust pixel processing to ~15ms per frame.

---

## Technical Performance Impact

Through the dual-developer workflow and targeted optimization loops with IBM Bob, we achieved the following metrics on an Apple M1 target:

| Performance Metric | Initial Naive Pipeline | Optimized Background Web Worker Pipeline (Current) |
| :--- | :--- | :--- |
| **Main Thread Smoothness** | 721.11 ms/frame (1 FPS) | **16.67 ms/frame (60 FPS - Perfect)** |
| **Grade Performance** | 290.27 ms/grade | **~15.00 ms/grade** (Off the main thread) |
| **Decode Latency** | 3296.18 ms | **~340.00 ms** (Off the main thread, fully buffered) |
| **Dropped Frames Rate** | 67.3% dropped | **0.0% dropped** |
| **Input & Play/Pause Lag** | ~4.5 seconds delay | **0 ms (Instantaneous response)** |

---

## Key Takeaways on AI-Assisted Development

Our experience using **IBM Bob (watsonx Code Assistant)** redefined our development speed and safety. Bob proved uniquely powerful at:
1.  **Low-Level API Standards:** Bob demonstrated a deep, accurate understanding of raw browser specifications, specifically the state-machine rules of WebCodecs.
2.  **Concurrency Planning:** Rather than just writing syntax, Bob excelled at analyzing asynchronous lifecycles, identifying race conditions across the JS/WASM thread boundary, and proposing standard multi-threading patterns like the Generation Counter.
3.  **Rust Memory Best Practices:** Bob steered us away from unnecessary allocations, helping us write cache-friendly, memory-safe code that maximizes the performance of compiled WebAssembly.
