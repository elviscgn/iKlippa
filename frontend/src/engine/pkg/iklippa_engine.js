/* @ts-self-types="./iklippa_engine.d.ts" */

//#region exports

/**
 * The top-level engine instance. JS holds this as an opaque handle.
 *
 * Phase 1 Task 1: `project` is the new canonical data model (µs timestamps,
 * serde-serialisable, multi-track). The legacy `timeline` + `grade` fields
 * stay until Task 2 compositing is verified against `project`, then they get
 * deleted along with the legacy `Clip`/`Timeline`/`ColorGrade` above.
 */
export class IklippaEngine {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IklippaEngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_iklippaengine_free(ptr, 0);
    }
    /**
     * How many tracks currently have clips.
     * @returns {number}
     */
    active_track_count() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_active_track_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} track
     * @param {number} start_ms
     * @param {number} end_ms
     * @param {number} source_offset_ms
     * @returns {number}
     */
    add_clip(track, start_ms, end_ms, source_offset_ms) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(track);
        _assertNum(start_ms);
        _assertNum(end_ms);
        _assertNum(source_offset_ms);
        const ret = wasm.iklippaengine_add_clip(this.__wbg_ptr, track, start_ms, end_ms, source_offset_ms);
        return ret >>> 0;
    }
    /**
     * Allocate and return a fresh clip id without inserting anything. Useful
     * when the JS side wants to reserve an id before building the clip JSON.
     * @returns {number}
     */
    alloc_clip_id() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_alloc_clip_id(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Allocate and return a fresh effect id.
     * @returns {number}
     */
    alloc_effect_id() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_alloc_effect_id(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Allocate and return a fresh track id.
     * @returns {number}
     */
    alloc_track_id() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_alloc_track_id(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * JSON array of clips active at `ts_us` on visible, non-muted tracks,
     * sorted by track order (compositor bottom→top). The compositor (Task 2)
     * @param {bigint} ts_us
     * @returns {string}
     */
    clips_at_us(ts_us) {
        let deferred1_0;
        let deferred1_1;
        try {
            if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
            _assertNum(this.__wbg_ptr);
            _assertBigInt(ts_us);
            const ret = wasm.iklippaengine_clips_at_us(this.__wbg_ptr, ts_us);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Composite all active clips at `ts_us` into the composite pool.
     * Reads from the frame cache, applies per-clip colour grades, and
     * alpha-blends layers bottom → top by track order.
     * @param {bigint} ts_us
     */
    compose_at(ts_us) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertBigInt(ts_us);
        wasm.iklippaengine_compose_at(this.__wbg_ptr, ts_us);
    }
    /**
     * Byte length of the composite output buffer.
     * @returns {number}
     */
    composite_len() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_composite_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Pointer to the composite output buffer (RGBA, interleaved).
     * JS reads this after `compose_at()` to create an ImageData.
     * @returns {number}
     */
    composite_ptr() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_composite_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Recompute and return the project duration in microseconds.
     * @returns {bigint}
     */
    compute_duration_us() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_compute_duration_us(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    duration_ms() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_duration_ms(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    frame_len() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_frame_len(this.__wbg_ptr);
        return ret >>> 0;
    }
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
     * @returns {number}
     */
    frame_ptr() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_frame_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Alias for `set_timeline` — semantically "load from a saved file".
     * @param {string} json
     */
    from_json(json) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.iklippaengine_from_json(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Insert a clip (JSON, id ignored — allocator assigns) into `track_id`.
     * Returns the new clip id, or Err if the track doesn't exist.
     * @param {number} track_id
     * @param {string} clip_json
     * @returns {number}
     */
    insert_clip(track_id, clip_json) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(track_id);
        const ptr0 = passStringToWasm0(clip_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.iklippaengine_insert_clip(this.__wbg_ptr, track_id, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Parse a .cube LUT from raw bytes and store it under the given id.
     * Returns true on success, false if the file is not a valid .cube LUT.
     * @param {number} id
     * @param {Uint8Array} data
     * @returns {boolean}
     */
    load_lut(id, data) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(id);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.iklippaengine_load_lut(this.__wbg_ptr, id, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Return the number of currently cached 3D LUTs.
     * @returns {number}
     */
    lut_count() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_lut_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Move a clip to a new timeline start (duration preserved).
     * @param {number} track_id
     * @param {number} clip_id
     * @param {bigint} new_start_us
     */
    move_clip(track_id, clip_id, new_start_us) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(track_id);
        _assertNum(clip_id);
        _assertBigInt(new_start_us);
        const ret = wasm.iklippaengine_move_clip(this.__wbg_ptr, track_id, clip_id, new_start_us);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Create the engine and allocate the frame buffer for the given resolution.
     * Call this once after loading the WASM module, before any video is decoded.
     * @param {number} width
     * @param {number} height
     */
    constructor(width, height) {
        _assertNum(width);
        _assertNum(height);
        const ret = wasm.iklippaengine_new(width, height);
        this.__wbg_ptr = ret;
        IklippaEngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Apply the current colour grade to whatever pixel data is in the frame buffer.
     * Called after JS has written decoded pixels into the buffer via frame_ptr().
     */
    process_frame() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        wasm.iklippaengine_process_frame(this.__wbg_ptr);
    }
    /**
     * Cached project duration in microseconds (no recompute).
     * @returns {bigint}
     */
    project_duration_us() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_project_duration_us(this.__wbg_ptr);
        return ret;
    }
    /**
     * Project output height (export resolution).
     * @returns {number}
     */
    project_height() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_project_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Project output width (export resolution).
     * @returns {number}
     */
    project_width() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ret = wasm.iklippaengine_project_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Remove a clip. Returns true if a clip was actually removed.
     * @param {number} track_id
     * @param {number} clip_id
     * @returns {boolean}
     */
    remove_clip(track_id, clip_id) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(track_id);
        _assertNum(clip_id);
        const ret = wasm.iklippaengine_remove_clip(this.__wbg_ptr, track_id, clip_id);
        return ret !== 0;
    }
    /**
     * Reorder tracks. `track_ids_json` is a JSON array of track ids in the
     * desired order, e.g. `"[1,0,2]"`. Tracks not listed keep their relative
     * order at the end.
     * @param {string} track_ids_json
     */
    reorder_tracks(track_ids_json) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ptr0 = passStringToWasm0(track_ids_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.iklippaengine_reorder_tracks(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Clear the frame cache. Call on seek or when source media changes.
     */
    reset_frame_cache() {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        wasm.iklippaengine_reset_frame_cache(this.__wbg_ptr);
    }
    /**
     * Re-allocate the frame buffer for a new resolution.
     * Call if the user loads a video with different dimensions.
     * @param {number} width
     * @param {number} height
     */
    resize(width, height) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(width);
        _assertNum(height);
        wasm.iklippaengine_resize(this.__wbg_ptr, width, height);
    }
    /**
     * Update a clip's `ColourSettings` from JSON. Used by the per-clip colour
     * panel (Task 3). The JSON may contain a partial `ColourSettings` — only
     * the fields present are overridden; others keep their current value.
     * @param {number} clip_id
     * @param {string} json
     */
    set_clip_colour(clip_id, json) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(clip_id);
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.iklippaengine_set_clip_colour(this.__wbg_ptr, clip_id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Replace a clip's `effects` Vec from JSON (a JSON array of Effect).
     * Used by the effects panel + LUT import (Tasks 3, 9).
     * @param {number} clip_id
     * @param {string} json
     */
    set_clip_effects(clip_id, json) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(clip_id);
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.iklippaengine_set_clip_effects(this.__wbg_ptr, clip_id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Update a clip's `ClipTransform` (position/scale/rotation/opacity/blend)
     * from JSON. Used by the overlay/transform UI (Task 6).
     * @param {number} clip_id
     * @param {string} json
     */
    set_clip_transform(clip_id, json) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(clip_id);
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.iklippaengine_set_clip_transform(this.__wbg_ptr, clip_id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} v
     */
    set_contrast(v) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        wasm.iklippaengine_set_contrast(this.__wbg_ptr, v);
    }
    /**
     * @param {number} v
     */
    set_exposure(v) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        wasm.iklippaengine_set_exposure(this.__wbg_ptr, v);
    }
    /**
     * @param {number} v
     */
    set_grain(v) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        wasm.iklippaengine_set_grain(this.__wbg_ptr, v);
    }
    /**
     * @param {number} v
     */
    set_highlights(v) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        wasm.iklippaengine_set_highlights(this.__wbg_ptr, v);
    }
    /**
     * @param {number} id
     */
    set_lut(id) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(id);
        wasm.iklippaengine_set_lut(this.__wbg_ptr, id);
    }
    /**
     * @param {number} v
     */
    set_saturation(v) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        wasm.iklippaengine_set_saturation(this.__wbg_ptr, v);
    }
    /**
     * @param {number} v
     */
    set_shadows(v) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        wasm.iklippaengine_set_shadows(this.__wbg_ptr, v);
    }
    /**
     * @param {number} v
     */
    set_temperature(v) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        wasm.iklippaengine_set_temperature(this.__wbg_ptr, v);
    }
    /**
     * Replace the whole project from a JSON string (the `.iklippa` format or
     * a fresh project built on the JS side). Returns Err with a parse message
     * on bad JSON.
     * @param {string} json
     */
    set_timeline(json) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.iklippaengine_set_timeline(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} v
     */
    set_vignette(v) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        wasm.iklippaengine_set_vignette(this.__wbg_ptr, v);
    }
    /**
     * Returns the source-file timestamp (ms) to decode for a given playhead
     * position, or u32::MAX if no clip is active on track 0 at that time.
     * @param {number} playhead_ms
     * @returns {number}
     */
    source_ms_for_playhead(playhead_ms) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(playhead_ms);
        const ret = wasm.iklippaengine_source_ms_for_playhead(this.__wbg_ptr, playhead_ms);
        return ret >>> 0;
    }
    /**
     * Split a clip at `split_at_us` (timeline µs). Returns the new (right
     * half) clip id.
     * @param {number} track_id
     * @param {number} clip_id
     * @param {bigint} split_at_us
     * @returns {number}
     */
    split_clip(track_id, clip_id, split_at_us) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(track_id);
        _assertNum(clip_id);
        _assertBigInt(split_at_us);
        const ret = wasm.iklippaengine_split_clip(this.__wbg_ptr, track_id, clip_id, split_at_us);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Copy the current pool buffer into the frame cache for `clip_id`.
     * Call after JS writes a decoded frame into the pool via `frame_ptr()`.
     * The cache stores (width, height, rgba_bytes) so `compose_at` can
     * retrieve frames for any clip at compose time.
     * @param {number} clip_id
     * @param {number} width
     * @param {number} height
     */
    stage_frame(clip_id, width, height) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(clip_id);
        _assertNum(width);
        _assertNum(height);
        wasm.iklippaengine_stage_frame(this.__wbg_ptr, clip_id, width, height);
    }
    /**
     * Stage the current pool buffer for every video-track clip whose source
     * window covers `source_ts_us`. One copy → N clip_ids.
     * @param {bigint} source_ts_us
     * @param {number} width
     * @param {number} height
     * @returns {number}
     */
    stage_frame_broadcast(source_ts_us, width, height) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertBigInt(source_ts_us);
        _assertNum(width);
        _assertNum(height);
        const ret = wasm.iklippaengine_stage_frame_broadcast(this.__wbg_ptr, source_ts_us, width, height);
        return ret >>> 0;
    }
    /**
     * Serialise the whole project to a pretty JSON string (the `.iklippa`
     * format). Used by Save Project (Task 5) and undo/redo snapshots (Task 11).
     * @returns {string}
     */
    to_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
            _assertNum(this.__wbg_ptr);
            const ret = wasm.iklippaengine_to_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Trim a clip in place. `new_source_start_us` lets the caller keep the
     * source window in sync with the timeline window.
     * @param {number} track_id
     * @param {number} clip_id
     * @param {bigint} new_start_us
     * @param {bigint} new_end_us
     * @param {bigint} new_source_start_us
     */
    trim_clip(track_id, clip_id, new_start_us, new_end_us, new_source_start_us) {
        if (this.__wbg_ptr == 0) throw new Error('Attempt to use a moved value');
        _assertNum(this.__wbg_ptr);
        _assertNum(track_id);
        _assertNum(clip_id);
        _assertBigInt(new_start_us);
        _assertBigInt(new_end_us);
        _assertBigInt(new_source_start_us);
        const ret = wasm.iklippaengine_trim_clip(this.__wbg_ptr, track_id, clip_id, new_start_us, new_end_us, new_source_start_us);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) IklippaEngine.prototype[Symbol.dispose] = IklippaEngine.prototype.free;

//#endregion

//#region wasm imports
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_ea4887a5f8f9a9db: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_933f449d72fef598: function() { return logError(function (arg0) {
            console.error(arg0);
        }, arguments); },
        __wbg_error_a6fa202b58aa1cd3: function() { return logError(function (arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        }, arguments); },
        __wbg_new_227d7c05414eb861: function() { return logError(function () {
            const ret = new Error();
            return ret;
        }, arguments); },
        __wbg_stack_3b0d974bbf31e44f: function() { return logError(function (arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbindgen_cast_0000000000000001: function() { return logError(function (arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        }, arguments); },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./iklippa_engine_bg.js": import0,
    };
}


//#endregion
const IklippaEngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_iklippaengine_free(ptr, 1));


//#region intrinsics
function _assertBigInt(n) {
    if (typeof(n) !== 'bigint') throw new Error(`expected a bigint argument, found ${typeof(n)}`);
}

function _assertNum(n) {
    if (typeof(n) !== 'number') throw new Error(`expected a number argument, found ${typeof(n)}`);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function logError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        let error = (function () {
            try {
                return e instanceof Error ? `${e.message}\n\nStack:\n${e.stack}` : e.toString();
            } catch(_) {
                return "<failed to stringify thrown value>";
            }
        }());
        console.error("wasm-bindgen: imported JS function that was not marked as `catch` threw an error:", error);
        throw e;
    }
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (typeof(arg) !== 'string') throw new Error(`expected a string argument, found ${typeof(arg)}`);
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);
        if (ret.read !== arg.length) throw new Error('failed to pass whole string');
        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


//#endregion

//#region wasm loading
let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('iklippa_engine_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
//#endregion
export { wasm as __wasm }
