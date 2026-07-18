Continue increasing test coverage in this iKlippa frontend project from the current ~54% toward 80%+. All 196 tests pass. The vitest config includes `tests/unit/**/*.test.ts`, `tests/adapters/**/*.test.ts`, `tests/browser/**/*.browser.test.ts`, and `tests/ui/**/*.test.ts`. Run `npx vitest run --coverage` to verify.

**Key testing patterns already established:**

1. **Engine tests** (`tests/adapters/engine.test.ts`) — use `__TEST_HOOKS__` from `src/engine/engine.ts` to inject mock state (worker, canvas, ctx, pendingFrames, pendingAudio, playheadMs, seekTargetMs, isPlaying, etc.), `setPorts(fakeEnginePorts)` from `tests/fakes`, and `vi.stubGlobal('window', {})` / `vi.stubGlobal('ImageData', class {...})` / `vi.stubGlobal('IKState', state)`. Need `(globalThis as any).window.IKState = state` since code accesses `window.IKState`, not bare `IKState`.

2. **Worker tests** (`tests/adapters/worker.test.ts`) — stub `self.onmessage`, `VideoDecoder`, `AudioDecoder`, `OffscreenCanvas`, `EncodedVideoChunk`, `EncodedAudioChunk`, `VideoFrame`, `AudioData` with `vi.stubGlobal`. Mock `../../src/engine/pkg/iklippa_engine`. Import the worker module after stubs are set.

3. **UI jsdom tests** — use `// @vitest-environment jsdom` pragma, mock module imports for `S` state object via `vi.mock('../../src/ui/state', ...)`.

4. **Browser adapter tests** (`tests/unit/browser-adapter.test.ts`) — use jsdom environment with `vi.stubGlobal` for browser APIs (`VideoEncoder`, `OffscreenCanvas`, `EncodedVideoChunk`, `URL.createObjectURL`).

**Remaining gaps (biggest impact first):**

- `src/engine/worker.ts` (52%): Test seekAndDecodeFrame path when no keyframe exists (all `is_sync: false`), when already seeking (queued seek), and audio decoder reset during seek. Stub the VideoDecoder's decode() to actually fire the output callback with a fake VideoFrame to cover the decoder callback (lines 267-309).

- `src/ui/utils.ts` (51%): Test `triggerSparkle` with jsdom.

- `src/ui/timeline.ts` (11%), `src/ui/dragDrop.ts` (17%), `src/ui/mediaPool.ts` (0%), `src/ui/playback.ts` (0%), `src/ui/toolbar.ts` (0%): All need jsdom `document.body.innerHTML` fixtures + `window.IKState` / `window.lucide` mocks. Functions are mostly DOM event wiring — test that given DOM structure, the functions don't throw and produce expected DOM mutations.

- `src/engine/engine.ts` uncovered: `initEngine` (line 172 — needs real Worker), `captureThumbnail` (line 117), `getThumbnails` (line 159), `getCurrentFileName` (line 163), `scheduleAudioNode` stale chunk path (line 308), `stopAllAudioNodes` catch (line 330), importFile success path with full MP4Box mock.

Don't cheese coverage — no config tricks, no `/* istanbul ignore */` comments.
