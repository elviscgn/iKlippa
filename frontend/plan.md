# iKlippa Frontend — Phase 1 Plan

**Scope:** Engine + editor core. Vanilla JS + HTML + Rust/WASM. Frontend folder only.
**Owner:** Elvis (frontend/WASM/WebCodecs).
**Stack:** keep vanilla JS + HTML + CSS for the editor UI. No React/TS/Vite migration this phase. The Rust/WASM engine is the real core and will be built out properly per the Technical Architecture Spec.

## 0. Boundaries & prerequisites

- **Hard boundary:** all work happens inside `frontend/`. `backend/`, `ml/`, root, and `docs/` are out of scope. opencode is locked to `frontend/**` via permission rules.
- **Stack:** keep vanilla JS + HTML + CSS for the editor UI. No React/TS/Vite migration this phase. The Rust/WASM engine is the real core and will be built out properly per the Tech Spec.
- **Backend dependency handling:** where Phase 1 features nominally need backend data (tier for export gating, auth for save), the frontend will read from a small mock config module so the editor is fully functional standalone. The real backend integration is Phase 2 / Mphele's domain.
- **No new deps unless approved.** `mp4box.js` and `mp4-muxer` already load via CDN; that stays.

## 1. Current state (already working — do not redo)

- WebCodecs video decode (H.264), `mp4box.js` demux, `VideoDecoder` in `worker.js`, hardware-accelerated, with audio decode (`AudioDecoder`) and A/V sync baseline.
- Canvas2D preview loop (`engine.js` `renderLoop`), `rAF` + `putImageData`, ~60fps target, with performance monitor (`PerformanceMonitor`).
- Basic timeline UI (`ui.js`): ruler, clip blocks, playhead, drag-scrub, media pool, import via drag-drop + file picker.
- Clip trim + split (`engine.js` `trimClip`/`splitClip`, `ui.js` `performSplit`), `onTrimApplied`/`onSplitResult` callbacks.
- Colour grading: global sliders (exposure/contrast/saturation/temperature/highlights/shadows/vignette/grain) + 4 analytic LUTs, applied in Rust `apply_color_grade`.
- Export pipeline (`engine.js` `exportVideo`): `VideoEncoder` (H.264, hardware-preferred) + `mp4-muxer` → Blob download. **Video only, no audio, no watermark, no gating.**
- Web Audio: decode + schedule `AudioBufferSourceNode`s against playhead. No per-track gain/pan/mute/master compressor UI.
- Mock Director (`ui.js` `submitCmd`/`applyAiAction`): keyword matching only. **Out of scope this phase** — real Director is Phase 2.

## 2. Phase 1 gaps (what's missing)

1. **Rust data model is too thin.** `Clip` has only `id/track/start_ms/end_ms/source_offset_ms`. No per-clip `ColourSettings`, `ClipTransform`, `Effect[]`, `CaptionStyle`. No `Project`/`Track` structs. No `serde_json` serialize/load. Timestamps are `u32` ms; spec uses `i64` microseconds.
2. **No multi-track compositing.** Engine composites track 0 only (per `lib.rs` comment). No premultiplied-alpha blend, no per-layer 2D affine transforms, no overlay tracks in the UI model.
3. **Colour grade is global, not per-clip.** Missing tint, lift/gamma/gain wheels, per-channel curves, `.cube` LUT import.
4. **No caption editor.** Only a mock "captions generated" action.
5. **No project persistence.** No JSON save/load, no localStorage, no `.iklippa` file.
6. **Export is video-only.** No audio mux, no free-tier watermark, no resolution gating.
7. **Audio mixer is missing.** No per-track volume/pan/mute, no master compressor, no mixer UI.
8. **Timeline UI is single-track-oriented.** `videoClips`/`audioClips` arrays, no general multi-track lane model with track headers.
9. **No undo/redo.**
10. **No Phase 1 QA pass on reference hardware.**

## 3. Architecture decisions

- **Rust engine:** extend `rust-engine/src/lib.rs` by splitting into the modules the Tech Spec specifies: `timeline_state.rs`, `compositing.rs`, `colour_grade.rs`, `effects.rs`, `export_prep.rs`, `pixel_format.rs`, `wasm_bridge.rs`. Keep the `IklippaEngine` struct + `wasm-bindgen` method style (it's working and idiomatic), add new methods as needed. Migrate timestamps to `i64` microseconds to match the Director JSON schema (avoids a painful boundary conversion in Phase 2).
- **Timeline storage:** replace the fixed `[[Clip; 128]; 8]` array with `Vec<Vec<Clip>>` (heap, flexible) since `Clip` becomes non-`Copy` (it'll hold `Vec<Effect>` and `Option<CaptionStyle>`). The compositing **hot loop** stays allocation-free — it reads clips by reference and writes into the pre-allocated `FramePool`.
- **Per-clip state in JS:** mirror the Rust `Project` JSON in a single `project` object held in a module-level `state.js` (vanilla equivalent of the Zustand store). High-frequency values (playhead during scrub, slider-drag values) stay in `Ref`-like module variables and only commit to `project` on pointer-up / change-end. UI reads via explicit render functions, not reactive subscription.
- **WASM bridge:** keep the `IklippaEngine` instance in `worker.js`. Add methods: `set_timeline(json)`, `get_composite_at(ts_us)` returning a ptr/len, `set_clip_colour(id, json)`, `set_clip_transform(id, json)`, `set_clip_effects(id, json)`, `set_export_settings(json)`, `reset_frame_cache`, `to_json()`/`from_json()`. The worker forwards compositing requests; `engine.js` reads the output buffer view over WASM memory (zero-copy, as today).
- **Tier/auth mock:** `frontend/tier.js` (or inline in a config object) exports `currentTier: 'free'|'klippa'|'pro'` so export gating + watermark work without a backend. Swap for real API in Phase 2.
- **No React/Zustand.** The "state outside the render loop" goal is already achieved via module variables + `rAF` + direct `putImageData`. We'll formalize it in `state.js`.

## 4. Implementation order (sequenced)

Each task lists dependencies. Order is a recommendation — some tasks can run in parallel.

| # | Task | Depends on |
|---|------|-----------|
| 1 | Rust data model refactor (`Project`/`Track`/`Clip` + per-clip fields + µs + serde_json) | — |
| 2 | Multi-track compositing in Rust (alpha blend, affine transforms, track order) | 1 |
| 3 | Per-clip colour grading (move global→per-clip, add tint + lift/gamma/gain, update panel) | 1, 2 |
| 4 | Caption editor (Rust `CaptionStyle` + caption track + Canvas2D render + UI) | 1, 2 |
| 5 | Project persistence (JSON save/load, localStorage, `.iklippa` file import/export) | 1 |
| 6 | Multi-track timeline UI rework (track lanes, headers w/ mute/lock/vis/vol, overlays, thumbnails) | 1, 2 |
| 7 | Web Audio mixer (per-track GainNode/StereoPannerNode/mute + master DynamicsCompressorNode + UI) | 6 |
| 8 | Export: audio mux + free-tier watermark + resolution gating | 7 |
| 9 | LUT `.cube` import (Rust parser → 3D LUT, file picker UI) | 3 |
| 10 | RGB curves editor (Rust per-channel bezier, SVG + draggable points + live histogram) | 3 |
| 11 | Undo/redo command stack (JS history over `project` mutations) | 1, 5 |
| 12 | Phase 1 QA pass + perf profiling on reference hardware | all |

**Stretch / defer to Phase 2-or-later:** full `EffectType` list (Blur/Sharpen/Vignette/FilmGrain/ChromaticAberration/Glitch/Mirror) beyond what's already in the colour grade; keyframes. These are in the spec's enum but not required for a compelling Phase 1 demo.

## 5. Per-task detail

### Task 1 — Rust data model refactor

- **Rust:** new `timeline_state.rs` with `Project`, `Track`, `Clip`, `ClipTransform`, `ColourSettings`, `Effect`, `EffectParams`, `CaptionStyle`, `Rational`, `ColourSpace`, `BlendMode` (types per Tech Spec §2.1). `Clip` gains `timeline_start_us/timeline_end_us/source_start_us/source_end_us`, `speed`, `transform`, `colour_settings`, `effects`, `caption_text`, `caption_style`. `serde` derive + `serde_json`. `load_project`/`serialize_project`/`clips_at`/`insert_clip`/`trim_clip`/`split_clip`/`move_clip`/`remove_clip`/`reorder_tracks`/`compute_duration`. Migrate `Timeline` to `Vec<Track>`.
- **JS:** `worker.js` `load` path switches to building a `Project` JSON and calling `set_timeline`. `engine.js`/`ui.js` clip model moves from `{start, end, sourceOffset}` (seconds) to the µs-based `Clip` shape. Add `state.js` holding the canonical `project` object.
- **Acceptance:** import a video → `project` JSON round-trips through Rust (serialize → deserialize → identical). Existing trim/split/scrub still work on the new model.

### Task 2 — Multi-track compositing in Rust

- **Rust:** new `compositing.rs`. `compose_at(ts_us, out_w, out_h, quality)`: allocate zeroed RGBA output; iterate visible video tracks sorted by `order` ascending; per active clip: pull cached frame, apply per-clip colour grade, apply effects, apply 2D affine transform (position/scale/rotation/opacity/anchor), alpha-composite onto output with the clip's `blend_mode` (Porter-Duff `over`, `multiply`, `screen`, `overlay` per spec §2.2). Expose `get_composite_at(ts_us)` returning ptr/len + `get_output_len/width/height`.
- **JS:** `worker.js` calls `get_composite_at` instead of the current single-frame path. `engine.js` `paintFrameAtTime` reads the composite output.
- **Acceptance:** two video tracks visible at the same timestamp blend correctly (overlay + opacity + blend modes). 1080p two-track `compose_at` < 10ms on dev machine.

### Task 3 — Per-clip colour grading

- **Rust:** new `colour_grade.rs` porting the current `apply_color_grade` to operate per-clip on `ColourSettings` (add `tint`, `lift/gamma/gain` RGB arrays, keep existing exposure/contrast/sat/temperature/highlights/shadows + vignette/grain migrated to `Effect`s). Linear-light pipeline per spec §2.3 (sRGB decode → exposure → WB → lift/gamma/gain → brightness → contrast → highlights/shadows → saturation → hue → sRGB encode). Fast-path when `is_default()`.
- **JS/UI:** `ColourPanel` binds to the **selected clip** (read from `state.selectedClipId`), not the engine. Slider change → `state.updateClipColour(clipId, key, val)` → `worker.set_clip_colour(id, json)` → re-composite at playhead. Show which clip is being graded. Reset-per-clip button.
- **Acceptance:** different clips on the timeline carry different grades; grades persist across seeks and save/load.

### Task 4 — Caption editor

- **Rust:** `CaptionStyle` struct (font, size, colour, bg opacity, position, start_us, end_us, text). `insert_caption`/`remove_caption` on a `TrackType::Caption` track. `compose_at` emits caption draw commands; JS executes them on a Canvas2D overlay after `putImageData`. Rust stays out of text shaping.
- **UI:** caption track in the timeline; "Add caption" opens an inline editor (text, font, size, colour, bg opacity, position presets: lower-third/center/top, start/end). Live preview on the canvas overlay.
- **Acceptance:** a caption shows at the configured time range, styles apply live, survives save/load.

### Task 5 — Project persistence

- **Rust:** `to_json()`/`from_json()` on the engine returning/accepting the full `Project` JSON.
- **JS:** `File → Save Project` writes `project.json` as `.iklippa` download. `File → Open Project` reads `.iklippa`, calls `from_json`, rehydrates media pool entries from blob URLs (media itself stays client-side — only metadata is in the JSON). Debounced (2s) auto-save to `localStorage` under `iklippa:project:{id}:draft`. On load, if localStorage draft is newer than opened file, offer to restore.
- **Acceptance:** save a project, reload the page, reopen the `.iklippa` — timeline, clips, grades, captions, track state all restored (media must be re-imported by the user since bytes aren't stored; UI prompts for the referenced files).

### Task 6 — Multi-track timeline UI rework

- **UI (`ui.js` + `index.html`):** replace the `videoClips`/`audioClips` flat arrays with a `tracks: Track[]` model rendered as lanes. Track headers: name, type icon, mute/lock/visible toggles, volume slider. Configurable track heights. Clip blocks show thumbnail (existing capture path), name, duration; draggable to move, edge-drag to trim. Overlays (track 1+) render above track 0. Playhead stays frame-accurate; 60fps scrubbing preserved (deferred store commit pattern stays).
- **Acceptance:** add a second video track, drop a clip on it, move/trim it independently of track 0; toggling mute/visible/lock works and reflects in compositing.

### Task 7 — Web Audio mixer

- **JS (`engine.js`):** insert a `GainNode` + `StereoPannerNode` per audio track between each `AudioBufferSourceNode` and the master; master → `DynamicsCompressorNode` → `AudioContext.destination`. Per-track volume/pan/mute wired to the track headers from Task 6. Mute = `GainNode.gain = 0`.
- **UI:** mixer panel (or inline in track headers) with volume + pan per audio track + master level.
- **Acceptance:** muting/soloing a track silences it; panning moves it L/R; master compressor prevents clipping on loud mixes.

### Task 8 — Export: audio + watermark + resolution gating

- **JS (`engine.js` `exportVideo`):** add an `OfflineAudioContext` render of the full mixed audio → encode to AAC (MP4) or Opus (WebM) → interleave into the muxer alongside video chunks. Add free-tier watermark: if `tier === 'free'`, composite a watermark RGBA (bottom-right, 20% width, 5% margin) into each exported frame (do it in Rust `export_prep::apply_watermark` or in JS via a second Canvas2D pass before `VideoFrame` construction — pick whichever is faster on target hardware). Resolution gating: clamp `outputWidth/Height` to tier max (Free 1280×720, Klippa 1920×1080, Pro/Agency 3840×2160) and max duration (Free 60s) in the export panel UI; reject with an upgrade prompt if the project exceeds the limit.
- **Acceptance:** exported MP4 has synced audio; free-tier exports are watermarked and capped at 720p/60s; higher tiers (via `tier.js` mock) export clean at 1080p+.

### Task 9 — LUT `.cube` import

- **Rust:** `.cube` parser → 33×33×33 float 3D LUT with trilinear interpolation, applied per-clip in `colour_grade.rs` (`EffectParams::LUT { lut_id, intensity }`). Cache loaded LUTs by id in `ENGINE`.
- **JS/UI:** "Import LUT" button → file picker (`.cube`) → read as `ArrayBuffer` → pass to Rust via `wasm_alloc`/`load_lut`/`wasm_free`. LUT appears in the LUT dropdown with intensity slider.
- **Acceptance:** loading a known `.cube` (e.g. a public Teal&Orange LUT) visibly changes the grade; intensity slider blends 0→1.

### Task 10 — RGB curves editor

- **Rust:** per-channel (R/G/B) + luma bezier curve evaluation in `colour_grade.rs` applied after the existing grade. Curve = ordered control points → bezier interpolation → per-pixel LUT of 256 entries (computed once per curve change, not per pixel).
- **UI:** SVG overlay on a live histogram of the active frame (histogram computed in JS from the composited frame or in Rust as a side output). Draggable bezier control points per channel; channel toggle (R/G/B/Luma). Curve change → re-composite.
- **Acceptance:** dragging a curve point visibly remaps the channel; histogram updates live; curve state saves with the project.

### Task 11 — Undo/redo command stack

- **JS (`state.js`):** every mutating action (add/remove/trim/split/move clip, set colour/transform/effects, add/remove caption, reorder tracks) pushes a command `{type, before, after}` onto a history stack. `Ctrl/Cmd+Z` pops and reverts; `Ctrl/Cmd+Shift+Z` redoes. Cap stack at 50 entries. Snapshots are shallow clip diffs (not full project clones) to stay cheap.
- **Acceptance:** perform a sequence of edits, undo/redo through them, timeline + canvas reflect each state correctly.

### Task 12 — Phase 1 QA pass

- **Test matrix on the slowest available machine (target: dual-core, 8 GB RAM if accessible, else dev machine with throttling):** import 1080p MP4, multi-track edit, per-clip grade, caption, save/load, export with audio at 720p + 1080p. Measure with `performance.mark/measure` (already partially instrumented via `PerformanceMonitor`): `compose_at`, `putImageData`, export frame loop, cold-start-to-first-frame.
- **Targets (per Tech Spec §10):** cold start to first editable frame < 5s; single-clip `compose_at` < 4ms; two-track < 10ms; `putImageData` < 2ms; 1080p/30fps export < 0.5× realtime (GPU) / < 1.5× (CPU).
- **Acceptance:** all targets met or documented with a mitigation (e.g. adaptive 540p preview fallback per spec §9.1 if `compose_at` exceeds 12ms).

## 6. Risks & mitigations (Phase 1 frontend only)

- **Rust data-model refactor breaks the working decode/preview path.** Mitigation: land Task 1 behind a feature flag, keep the old `Clip` path callable until Task 2 compositing is verified, then delete.
- **WASM memory pressure from per-clip `Vec<Effect>` + LUT cubes.** Mitigation: 3D LUT cached once per `lut_id` (33³ × 4 bytes ≈ 143 KB each), effects stored as small enums. Initial WASM heap 48 MB is enough; grow if needed.
- **`compose_at` over 16.7ms on reference hardware with 2 tracks + grade + caption.** Mitigation: implement the adaptive preview downgrade from spec §9.1 (540p preview, 1080p export) as a fallback if mean frame time > 12ms.
- **Audio export muxing is fiddly (AAC encoding in-browser).** Mitigation: `mp4-muxer` supports audio tracks; use `AudioEncoder` (WebCodecs) with `mp4a.40.2`. If `AudioEncoder` is unsupported on target browser, fall back to WebM/Opus.
- **Caption text rendering inside the 16ms budget.** Mitigation: render captions on a **separate Canvas2D overlay** layered above the video canvas (CSS `position: absolute`), not inside the compositing loop. Only redraw when the caption set or playhead segment changes.
- **Timeline UI rework (Task 6) is the riskiest UI change.** Mitigation: build it on a separate branch, keep `ui.js`'s current single-track render as fallback until the new model passes the QA matrix.

## 7. Out of scope for this plan

- Backend (Go gateway, watsonx.ai, auth, credits, projects endpoint) — Mphele.
- `ml/` Python project.
- Real Director / Granite integration, JSON command schema, command executor — Phase 2.
- React/TS/Vite/Zustand migration — deferred ("port later").
- Full effects list beyond vignette/grain (already in colour grade) — stretch.
- Keyframes — stretch.
- Demo video, README, SkillsBuild, submission artifacts — Phase 3 / Mphele.

## 8. Progress tracking

Update this section as tasks complete. Mark `[x]` when a task's acceptance criteria are met.

- [~] Task 1 — Rust data model refactor (1.1 Rust model ✓, 1.2 JS migration ✓, pending user QA)
- [x] Task 2 — Multi-track compositing in Rust
- [x] Task 3 — Per-clip colour grading
- [ ] Task 4 — Caption editor
- [x] Task 5 — Project persistence
- [x] Task 6 — Multi-track timeline UI rework
- [ ] Task 7 — Web Audio mixer
- [ ] Task 8 — Export: audio + watermark + resolution gating
- [ ] Task 9 — LUT `.cube` import
- [ ] Task 10 — RGB curves editor
- [ ] Task 11 — Undo/redo command stack
- [ ] Task 12 — Phase 1 QA pass
