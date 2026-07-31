/* tslint:disable */
/* eslint-disable */

/**
 * The top-level engine instance. JS holds this as an opaque handle.
 *
 * Phase 1 Task 1: `project` is the new canonical data model (µs timestamps,
 * serde-serialisable, multi-track). The legacy `timeline` + `grade` fields
 * stay until Task 2 compositing is verified against `project`, then they get
 * deleted along with the legacy `Clip`/`Timeline`/`ColorGrade` above.
 */
export class IklippaEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * How many tracks currently have clips.
     */
    active_track_count(): number;
    add_clip(track: number, start_ms: number, end_ms: number, source_offset_ms: number): number;
    /**
     * Allocate and return a fresh clip id without inserting anything. Useful
     * when the JS side wants to reserve an id before building the clip JSON.
     */
    alloc_clip_id(): number;
    /**
     * Allocate and return a fresh effect id.
     */
    alloc_effect_id(): number;
    /**
     * Allocate and return a fresh track id.
     */
    alloc_track_id(): number;
    /**
     * JSON array of clips active at `ts_us` on visible, non-muted tracks,
     * sorted by track order (compositor bottom→top). The compositor (Task 2)
     */
    clips_at_us(ts_us: bigint): string;
    /**
     * Composite all active clips at `ts_us` into the composite pool.
     * Reads from the frame cache, applies per-clip colour grades, and
     * alpha-blends layers bottom → top by track order.
     */
    compose_at(ts_us: bigint): void;
    /**
     * Byte length of the composite output buffer.
     */
    composite_len(): number;
    /**
     * Pointer to the composite output buffer (RGBA, interleaved).
     * JS reads this after `compose_at()` to create an ImageData.
     */
    composite_ptr(): number;
    /**
     * Recompute and return the project duration in microseconds.
     */
    compute_duration_us(): bigint;
    duration_ms(): number;
    frame_len(): number;
    /**
     * Returns a pointer to the internal RGBA frame buffer.
     *
     * JS usage:
     *   const ptr  = engine.frame_ptr();
     *   const len  = engine.frame_len();
     *   const view = new Uint8ClampedArray(wasm.memory.buffer, ptr, len);
     *   // WebCodecs writes decoded pixels directly into WASM heap:
     *   await videoFrame.copyTo(view);
     *   // Rust processes in place:
     *   engine.process_frame();
     *   // Copy out into an owned ImageData (see engine.js for why this copy
     *   // is necessary when caching multiple frames):
     *   const owned = new Uint8ClampedArray(len);
     *   owned.set(new Uint8ClampedArray(wasm.memory.buffer, ptr, len));
     *   const imageData = new ImageData(owned, width, height);
     */
    frame_ptr(): number;
    /**
     * Alias for `set_timeline` — semantically "load from a saved file".
     */
    from_json(json: string): void;
    /**
     * Insert a clip (JSON, id ignored — allocator assigns) into `track_id`.
     * Returns the new clip id, or Err if the track doesn't exist.
     */
    insert_clip(track_id: number, clip_json: string): number;
    /**
     * Parse a .cube LUT from raw bytes and store it under the given id.
     * Returns true on success, false if the file is not a valid .cube LUT.
     */
    load_lut(id: number, data: Uint8Array): boolean;
    /**
     * Return the number of currently cached 3D LUTs.
     */
    lut_count(): number;
    /**
     * Move a clip to a new timeline start (duration preserved).
     */
    move_clip(track_id: number, clip_id: number, new_start_us: bigint): void;
    /**
     * Create the engine and allocate the frame buffer for the given resolution.
     * Call this once after loading the WASM module, before any video is decoded.
     */
    constructor(width: number, height: number);
    /**
     * Apply the current colour grade to whatever pixel data is in the frame buffer.
     * Called after JS has written decoded pixels into the buffer via frame_ptr().
     */
    process_frame(): void;
    /**
     * Cached project duration in microseconds (no recompute).
     */
    project_duration_us(): bigint;
    /**
     * Project output height (export resolution).
     */
    project_height(): number;
    /**
     * Project output width (export resolution).
     */
    project_width(): number;
    /**
     * Remove a clip. Returns true if a clip was actually removed.
     */
    remove_clip(track_id: number, clip_id: number): boolean;
    /**
     * Reorder tracks. `track_ids_json` is a JSON array of track ids in the
     * desired order, e.g. `"[1,0,2]"`. Tracks not listed keep their relative
     * order at the end.
     */
    reorder_tracks(track_ids_json: string): void;
    /**
     * Clear the frame cache. Call on seek or when source media changes.
     */
    reset_frame_cache(): void;
    /**
     * Re-allocate the frame buffer for a new resolution.
     * Call if the user loads a video with different dimensions.
     */
    resize(width: number, height: number): void;
    /**
     * Update a clip's `ColourSettings` from JSON. Used by the per-clip colour
     * panel (Task 3). The JSON may contain a partial `ColourSettings` — only
     * the fields present are overridden; others keep their current value.
     */
    set_clip_colour(clip_id: number, json: string): void;
    /**
     * Replace a clip's `effects` Vec from JSON (a JSON array of Effect).
     * Used by the effects panel + LUT import (Tasks 3, 9).
     */
    set_clip_effects(clip_id: number, json: string): void;
    /**
     * Update a clip's `ClipTransform` (position/scale/rotation/opacity/blend)
     * from JSON. Used by the overlay/transform UI (Task 6).
     */
    set_clip_transform(clip_id: number, json: string): void;
    set_contrast(v: number): void;
    set_exposure(v: number): void;
    set_grain(v: number): void;
    set_highlights(v: number): void;
    set_lut(id: number): void;
    set_saturation(v: number): void;
    set_shadows(v: number): void;
    set_temperature(v: number): void;
    /**
     * Replace the whole project from a JSON string (the `.iklippa` format or
     * a fresh project built on the JS side). Returns Err with a parse message
     * on bad JSON.
     */
    set_timeline(json: string): void;
    set_vignette(v: number): void;
    /**
     * Returns the source-file timestamp (ms) to decode for a given playhead
     * position, or u32::MAX if no clip is active on track 0 at that time.
     */
    source_ms_for_playhead(playhead_ms: number): number;
    /**
     * Split a clip at `split_at_us` (timeline µs). Returns the new (right
     * half) clip id.
     */
    split_clip(track_id: number, clip_id: number, split_at_us: bigint): number;
    /**
     * Copy the current pool buffer into the frame cache for `clip_id`.
     * Call after JS writes a decoded frame into the pool via `frame_ptr()`.
     * The cache stores (width, height, rgba_bytes) so `compose_at` can
     * retrieve frames for any clip at compose time.
     */
    stage_frame(clip_id: number, width: number, height: number): void;
    /**
     * Stage the current pool buffer for every video-track clip whose source
     * window covers `source_ts_us`. One copy → N clip_ids.
     */
    stage_frame_broadcast(source_ts_us: bigint, width: number, height: number): number;
    /**
     * Serialise the whole project to a pretty JSON string (the `.iklippa`
     * format). Used by Save Project (Task 5) and undo/redo snapshots (Task 11).
     */
    to_json(): string;
    /**
     * Trim a clip in place. `new_source_start_us` lets the caller keep the
     * source window in sync with the timeline window.
     */
    trim_clip(track_id: number, clip_id: number, new_start_us: bigint, new_end_us: bigint, new_source_start_us: bigint): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_iklippaengine_free: (a: number, b: number) => void;
    readonly iklippaengine_active_track_count: (a: number) => number;
    readonly iklippaengine_add_clip: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly iklippaengine_alloc_clip_id: (a: number) => number;
    readonly iklippaengine_alloc_effect_id: (a: number) => number;
    readonly iklippaengine_alloc_track_id: (a: number) => number;
    readonly iklippaengine_clips_at_us: (a: number, b: bigint) => [number, number];
    readonly iklippaengine_compose_at: (a: number, b: bigint) => void;
    readonly iklippaengine_composite_len: (a: number) => number;
    readonly iklippaengine_composite_ptr: (a: number) => number;
    readonly iklippaengine_compute_duration_us: (a: number) => bigint;
    readonly iklippaengine_duration_ms: (a: number) => number;
    readonly iklippaengine_frame_len: (a: number) => number;
    readonly iklippaengine_frame_ptr: (a: number) => number;
    readonly iklippaengine_from_json: (a: number, b: number, c: number) => [number, number];
    readonly iklippaengine_insert_clip: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly iklippaengine_load_lut: (a: number, b: number, c: number, d: number) => number;
    readonly iklippaengine_lut_count: (a: number) => number;
    readonly iklippaengine_move_clip: (a: number, b: number, c: number, d: bigint) => [number, number];
    readonly iklippaengine_new: (a: number, b: number) => number;
    readonly iklippaengine_process_frame: (a: number) => void;
    readonly iklippaengine_project_duration_us: (a: number) => bigint;
    readonly iklippaengine_project_height: (a: number) => number;
    readonly iklippaengine_project_width: (a: number) => number;
    readonly iklippaengine_remove_clip: (a: number, b: number, c: number) => number;
    readonly iklippaengine_reorder_tracks: (a: number, b: number, c: number) => [number, number];
    readonly iklippaengine_reset_frame_cache: (a: number) => void;
    readonly iklippaengine_resize: (a: number, b: number, c: number) => void;
    readonly iklippaengine_set_clip_colour: (a: number, b: number, c: number, d: number) => [number, number];
    readonly iklippaengine_set_clip_effects: (a: number, b: number, c: number, d: number) => [number, number];
    readonly iklippaengine_set_clip_transform: (a: number, b: number, c: number, d: number) => [number, number];
    readonly iklippaengine_set_contrast: (a: number, b: number) => void;
    readonly iklippaengine_set_exposure: (a: number, b: number) => void;
    readonly iklippaengine_set_grain: (a: number, b: number) => void;
    readonly iklippaengine_set_highlights: (a: number, b: number) => void;
    readonly iklippaengine_set_lut: (a: number, b: number) => void;
    readonly iklippaengine_set_saturation: (a: number, b: number) => void;
    readonly iklippaengine_set_shadows: (a: number, b: number) => void;
    readonly iklippaengine_set_temperature: (a: number, b: number) => void;
    readonly iklippaengine_set_timeline: (a: number, b: number, c: number) => [number, number];
    readonly iklippaengine_set_vignette: (a: number, b: number) => void;
    readonly iklippaengine_source_ms_for_playhead: (a: number, b: number) => number;
    readonly iklippaengine_split_clip: (a: number, b: number, c: number, d: bigint) => [number, number, number];
    readonly iklippaengine_stage_frame: (a: number, b: number, c: number, d: number) => void;
    readonly iklippaengine_stage_frame_broadcast: (a: number, b: bigint, c: number, d: number) => number;
    readonly iklippaengine_to_json: (a: number) => [number, number];
    readonly iklippaengine_trim_clip: (a: number, b: number, c: number, d: bigint, e: bigint, f: bigint) => [number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
