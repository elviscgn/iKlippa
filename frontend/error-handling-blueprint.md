# iKlippa Error-Handling Blueprint

Goal: **no bug is ever silent again.** Every failure in either thread terminates in exactly one of two places: a recovery routine that restores a known-good state, or a visible UI toast. Never the console.

This document captures the audit findings, the four-part architecture, and the rollout status. Section 7 of `architecture.md` summarises what is implemented.

---

## 1. Audit findings

### The five reported bugs
1. **WASM init race** — `load` ran before WASM finished compiling → `TypeError` crashed the worker silently. (Fixed via sequential queue, but the *failure mode* stayed silent.)
2. **"Screeching" audio cache** — stale `pendingAudio` chunks scheduled on top of new ones. Root cause pattern: cleanup was the caller's responsibility at N call sites (`importFile`, `seekTo`, `pausePlayback`, clip-transition, `startPlayback`).
3. **Overlapping seek queue freeze** — dozens of queued seeks decoded one by one. (Fixed via `latestSeekId` skip, but `sync` messages are *not* coalesced — see below.)
4. **Silent promise rejections** — the worker queue ended in `.catch((err) => wwarn(...))`.
5. **Swallowed decoder failures** — both WebCodecs error callbacks were `console.error` and nothing else.

### Still-live issues found during the audit (post-fix code)
- ✅→fixed: the queue catch swallowed *all* handler errors (`worker.ts` old line 198) — bug #4 was still in the code.
- ✅→fixed: decoder error callbacks were `console.error('[Worker Decoder]', e)` / `('[AudioDecoder]', e)` — bug #5 was still in the code.
- ✅→fixed: a failed `load` (e.g. unreadable file) posted **no message at all** — the main thread waited forever with zero feedback (verified empirically: only a `status` message was posted).
- **Open (step 4):** `exportVideo` busy-waits `while (!pendingFrames.has(sourceMs))` with no timeout — one dropped frame hangs it forever, and a mid-export throw leaves `isExporting = true` permanently.
- **Open (step 4):** `setTimeline`/`getProjectJson` resolve via `addEventListener('message')` filtered on type only — concurrent calls cross-resolve, failed calls hang forever.
- **Open (step 3):** `seekAndDecodeFrame`'s abort path `break`s out of the decode loop but then *falls through* to the audio reseed and sets `decoderSeeded = true` on a half-fed decoder.
- **Open (step 3):** the decoder output callback reads `currentSeekId` at post time, so a frame from seek N−1 still awaiting `copyTo` when seek N starts gets tagged as seek N and passes the `seekGeneration` filter (one-frame wrong-position flicker).
- **Open (step 4):** `sync` messages (60/s, each awaiting file I/O) are never coalesced — a large share of the scrub-freeze queue debt that the `seekId` fix didn't remove.
- **Open (step 2):** no heartbeat/watchdog — a truly wedged worker is indistinguishable from a busy one.
- ✅→fixed (pause→play silence): the audio decoder ran unthrottled ahead of the playhead; pause discarded all scheduled/cached audio and resume never rewound the worker's decode front, so audio at the playhead was never re-sent. Fixed via `AUDIO_LOOKAHEAD_MS` throttle + `resync_audio` on playback start + `onended` node cleanup. **Lesson:** this bug threw *no exception*, so the step-1 funnel could not see it — logic bugs need the step-2 watchdogs (e.g. a scheduled-audio-vs-playhead mismatch detector) to become visible automatically.

### Root pattern
All of the above are three failures in costume:
1. Errors terminated in the console instead of a sink.
2. Cleanup was the caller's responsibility at N call sites instead of a state-entry action at 1 site.
3. Staleness was handled by filtering tokens instead of cancellation.

---

## 2. Part 1 — Error boundary (✅ IMPLEMENTED)

**Protocol** (`types.ts`): `EngineError { code, message, detail, fatal, opId, at }` with a closed set of `EngineErrorCode`s. Worker reports via `{ type: 'error', error }`.

**Worker funnel** (`worker.ts`): `reportError(code, err, { fatal, opId })` is the only exit. It feeds from:
- `self.onerror` / `self.onunhandledrejection` (last-resort nets),
- the message-queue terminal catch, mapped per message type (`init→WASM_INIT_FAILED`, `load→LOAD_FAILED`, `seek|sync→DECODER_VIDEO_FATAL`, else `PROTOCOL_ERROR`),
- both decoder error callbacks (`DECODER_VIDEO_FATAL` / `DECODER_AUDIO_FATAL`),
- a try/catch around `wasmModule.process_frame()` → `WASM_PANIC`, fatal + decoder close, because a Rust panic with `panic=abort` **poisons the module** — every later call throws.

A ring buffer of the last 200 worker log lines rides along in `error.detail` so crashes are diagnosable without a repro.

**Main-thread sink** (`errors.ts` + `engine.ts`): `errorBus` pub/sub. Sources: worker `error` messages, `worker.onerror` (`WORKER_DIED`), `worker.onmessageerror` (structured-clone failures — previously 100% invisible), `emitLocal()` for local failures (demux, export encoder, playback start), and a `window.unhandledrejection` last-resort net. A `WeakSet` marks explicitly-reported errors so the net never toasts twice.

**UI bridge** (`main.ts`): `window.onEngineError` → toast via `USER_ERROR_MESSAGES[code]`; fatal errors also set the status badge and append "please re-import the file".

**Tests**: `tests/unit/errors.test.ts` (bus, dedupe, messages), `tests/adapters/worker.test.ts` (7 error-path tests incl. WASM panic and unhandled rejection), `tests/adapters/engine-errors.test.ts` (routing + window-net dedupe).

---

## 3. Part 2 — State machine vs. ad-hoc guards (step 4, not started)

Today's ~10 booleans/counters (`isSeeking`, `isDecodingNext`, `decoderSeeded`, `decodeSessionId`, `currentSeekId`, `latestSeekId`, `seekGeneration`, `seekTargetMs`, `audioConfigVersion`…) encode what is really a 5-state machine; the combinatorics are where bugs breed (e.g. `if (isSeeking) return;` is a silently dropped seek).

**Key design point:** `Decoding` is not a state — it is an *activity* inside `Seeking` and `Playing`.

```
Booting ─init ok→ Idle ─load→ Loading ─ready→ Ready
Ready   ─seek→ Seeking(resume=pause) ─target painted→ Ready
Ready   ─play→ Playing ─pause/end/gap→ Ready
Playing ─seek→ Seeking(resume=play)  ─target painted→ Playing
Loading ─load→ Loading        (new file: legal self-transition, full teardown)
any     ─fatal→ Failed ─reset→ Booting   (only the main thread triggers reset)
```

Rules that do the work:
1. **Illegal transitions are loud**, via a `transition()` table check → `PROTOCOL_ERROR`. No more silent no-op guards.
2. **Entry/exit actions own cleanup** (`onEnter('seeking')` bumps the session epoch and invalidates caches) — the screech-bug class dies because cache-clearing stops being something 5 call sites must remember.
3. **Re-seek while seeking is a payload update, not a transition**: `pendingSeek = { ms, seekId }`; the seek loop throws `SeekCancelled` at checkpoints (replacing the fall-through `break` that leaves a half-fed decoder) and restarts from the new keyframe. Latest-wins becomes structural.
4. **Keep generation tokens** — they govern *data* staleness across the thread boundary; the machine governs *control flow*. Epochs get bumped only by state entries.
5. Main thread keeps a mirror machine (`Empty→Loading→Ready⇄Seeking⇄Playing→Failed`) driven by user events + worker acks.

XState is optional; the discipline is what matters. A ~60-line hand-rolled machine keeps the worker dependency-free and testable with the existing fakes.

---

## 4. Part 3 — Defensive WebCodecs + mp4box.js (step 5, not started)

Policy: **a decoder that fired its error callback is dead — never `reset()`-and-continue the same instance.** Close, recreate, reconfigure, reseed from the nearest keyframe ≤ playhead (recovery = an internal seek; ~100ms stutter instead of a silent halt). Second failure within 10s → fatal.

- Probe `VideoDecoder.isConfigSupported()` / `AudioDecoder.isConfigSupported()` at import time → immediate human-readable toast instead of a decoder that dies on the first chunk. On mid-playback failure, retry once with `hardwareAcceleration: 'no-preference'` (HW decoder exhaustion under memory pressure is real at 4K).
- Epoch-tag decoder outputs: capture `decodeSessionId` at callback *entry*, re-check after every `await` — fixes the stale-frame-tagged-as-new-seek flicker.
- `finally`-close every `VideoFrame`/`AudioData` on every path (leaked frames = GPU memory pressure = later "unrelated" decode failures).
- Catch `flush()` rejections — often the only surface for queued decode errors; `AbortError` during reset is benign, everything else is fatal.
- Gate `decode()` on `decoder.state === 'configured'`; configure errors arrive via the error callback, not synchronously.
- Backpressure via the `dequeue` event instead of polling `decodeQueueSize`; keep `MAX_DECODE_QUEUE = 8` and apply it inside the seek loop too.
- mp4box: `onReady` is not success — add a first-sample watchdog (`DEMUX_STALLED`); validate `timescale > 0` and finite `cts`; `Math.round` chunk timestamps to avoid µs truncation collisions.

---

## 5. Part 4 — Worker message queueing (step 3, not started)

One serialized chain for everything is wrong: message types need different policies.

- **Serial lane**: `init`, `load` — strict FIFO (this preserves the init-race fix).
- **Replaceable lane**: `seek`, `sync`, `set_grade`, `set_audio_version` — latest-wins coalescing *in the queue* (a newer message replaces the pending one of the same kind). The state machine's `pendingSeek` covers the in-flight case; both layers are needed.
- **Request/response lane**: `set_timeline`, `get_project_json`, export seeks — correlation IDs (`reqId`) + timeouts via a `callWorker(msg, timeoutMs)` helper. Kills the `addEventListener`-filtered-on-type pattern, cross-resolution, and the export busy-wait hang (seek gets a `seek_done` ack with a 5s timeout; export resets `isExporting` in `finally`).
- Error isolation per message: each handler runs in its own try/catch → `reportError`, so one bad message never corrupts or blocks the next.
- Cut the sync flood at the source: only post `sync` when playhead moved >40ms, play state flipped, or the frames-ahead threshold crossed (~10× less traffic).
- Wrap outgoing `postMessage(msg, transfer)` in try/catch — a detached ArrayBuffer in the transfer list throws `DataCloneError` synchronously.

**Watchdogs** (with step 2): worker heartbeat every 1s (`{ type:'heartbeat', state, queueDepth }`); missing 3s while playing → `WORKER_WEDGED` → respawn. Seek paint timeout escalates from `warn` to a reported `SEEK_TIMEOUT`. Playback starvation detector: no frame for 500ms with <2 frames ahead → `PLAYBACK_STARVATION`. Load handshake timeout: no `ready` in 15s → `LOAD_TIMEOUT`.

**Recovery snapshot + respawn**: main thread keeps `{ file, playheadMs, grade, timelineJson }`; `resetEngine()` = `worker.terminate()` → fresh worker → re-import → re-seek. ~100ms, always works, zero lost work — the universal recovery for any fatal worker state.

---

## 6. Rollout status

| Step | Scope | Status |
|---|---|---|
| 1 | Error protocol + funnels + toast bridge | ✅ **Done** (types.ts, errors.ts, worker.ts, engine.ts, main.ts + 19 tests) |
| 2 | Watchdogs, heartbeat, recovery snapshot/respawn | ⬜ Not started |
| 3 | Scheduler lanes + `callWorker` + sync coalescing | ⬜ Not started |
| 4 | Worker state machine (absorb guards, entry/exit cleanup) | ⬜ Not started |
| 5 | Decoder hardening + chaos/fault-injection tests | ⬜ Not started |

Verification habit per step: `npx tsc --noEmit && npx vitest run` must stay green; add a fault-injection test for every new path (fake decoder error callback, throwing `process_frame`, slow `sampleReader`, missing heartbeat).
