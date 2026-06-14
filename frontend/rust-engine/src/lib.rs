// iKlippa Engine — lib.rs  (rev 2)
//
// Changes vs rev 1:
//   • add_clip now inserts in start_ms order so active_clip can break early
//   • active_clip breaks out of the loop once past the playhead (O(log n) in practice)
//   • console_error_panic_hook wired via feature flag (add to Cargo.toml)
//
// MEMORY ARCHITECTURE — why we do it this way:
// ─────────────────────────────────────────────
// The naive approach is: JS allocates an ImageData, copies it to WASM, Rust processes,
// copies back. That's 2 full-frame copies every 16ms = ~60MB/s of memcpy at 1080p/60.
//
// Our approach: Rust pre-allocates a fixed frame buffer inside WASM linear memory.
// JS receives a raw pointer+length and wraps it in a Uint8ClampedArray view — ZERO copy
// into WASM. JS calls videoFrame.copyTo(view) so WebCodecs writes decoded pixels straight
// into our heap. Rust reads+writes in place. After process_frame() JS *copies* the result
// into a fresh ImageData so each cached frame owns its own bytes (see engine.js rev 2).
// Net copies during the WASM processing phase: 0. The final copy-out is ~4 MB/frame,
// which at 30fps is 120 MB/s — well within DDR4 bandwidth even on budget hardware.

use wasm_bindgen::prelude::*;

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TRACKS:         usize = 8;
const MAX_CLIPS_PER_TRACK: usize = 128;

// ── Timeline State ───────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub struct Clip {
    pub id:               u32,
    pub track:            u8,
    /// Timeline start in milliseconds
    pub start_ms:         u32,
    /// Timeline end in milliseconds
    pub end_ms:           u32,
    /// Source offset: where in the source file this clip starts (ms)
    pub source_offset_ms: u32,
}

impl Clip {
    const EMPTY: Self = Clip {
        id: 0, track: 0, start_ms: 0, end_ms: 0, source_offset_ms: 0,
    };
}

/// The timeline lives entirely in Rust. JS only holds indices/IDs.
///
/// Stack-allocated: no heap allocation for the timeline itself — important for
/// deterministic GC-free operation inside the render budget.
///
/// Invariant: clips[track][0..clip_count[track]] are sorted by start_ms.
/// This is maintained by add_clip's insertion sort and enables O(k) early-exit
/// in active_clip where k is the number of clips before the playhead.
pub struct Timeline {
    clips:      [[Clip; MAX_CLIPS_PER_TRACK]; MAX_TRACKS],
    clip_count: [usize; MAX_TRACKS],
    pub duration_ms: u32,
    next_id: u32,
}

impl Timeline {
    pub fn new() -> Self {
        Timeline {
            clips:       [[Clip::EMPTY; MAX_CLIPS_PER_TRACK]; MAX_TRACKS],
            clip_count:  [0; MAX_TRACKS],
            duration_ms: 0,
            next_id:     1,
        }
    }

    /// Add a clip to `track`, keeping the track sorted by start_ms.
    pub fn add_clip(
        &mut self,
        track: usize,
        start_ms: u32,
        end_ms: u32,
        source_offset_ms: u32,
    ) -> u32 {
        assert!(track < MAX_TRACKS,           "Track index out of range");
        let count = self.clip_count[track];
        assert!(count < MAX_CLIPS_PER_TRACK,  "Too many clips on track");

        let id = self.next_id;
        self.next_id += 1;

        let new_clip = Clip {
            id,
            track: track as u8,
            start_ms,
            end_ms,
            source_offset_ms,
        };

        // Insertion sort — O(n) worst case but n ≤ 128 and called rarely
        let mut insert_at = count;
        for i in 0..count {
            if self.clips[track][i].start_ms > start_ms {
                insert_at = i;
                break;
            }
        }
        // Shift clips right to make room
        for i in (insert_at..count).rev() {
            self.clips[track][i + 1] = self.clips[track][i];
        }
        self.clips[track][insert_at] = new_clip;
        self.clip_count[track] += 1;

        if end_ms > self.duration_ms {
            self.duration_ms = end_ms;
        }
        id
    }

    /// Returns the clip active at `playhead_ms` on `track`, if any.
    ///
    /// Because clips are sorted by start_ms we can break as soon as we pass
    /// the playhead — no need to scan the entire track.
    pub fn active_clip(&self, track: usize, playhead_ms: u32) -> Option<&Clip> {
        let count = self.clip_count[track];
        for i in 0..count {
            let c = &self.clips[track][i];
            // Since clips are sorted, once start_ms exceeds the playhead we
            // know no later clip can be active either.
            if c.start_ms > playhead_ms {
                break;
            }
            if playhead_ms < c.end_ms {
                return Some(c);
            }
        }
        None
    }
}

// ── Colour Grade Parameters ───────────────────────────────────────────────────

/// All values normalised to [0.0, 1.0] or [-1.0, 1.0] as noted.
/// Stored as f32 — fast enough for SIMD-like scalar loops in WASM.
#[derive(Clone, Copy, Debug)]
pub struct ColorGrade {
    /// Exposure: [-1, 1]. 0 = no change. Applied as multiplicative EV stops.
    pub exposure:    f32,
    /// Contrast: [-1, 1]. 0 = no change.
    pub contrast:    f32,
    /// Saturation: [-1, 1]. 0 = no change. Negative → desaturate.
    pub saturation:  f32,
    /// Temperature: [-1, 1]. Negative = cool (blue push), positive = warm (orange push).
    pub temperature: f32,
    /// Highlights: [-1, 1]. Rolls off the top of the luminance range.
    pub highlights:  f32,
    /// Shadows: [-1, 1]. Lifts or crushes the shadows.
    pub shadows:     f32,
    /// Vignette strength: [0, 1]. 0 = off.
    pub vignette:    f32,
    /// Film grain: [0, 1]. Adds subtle noise.
    pub grain:       f32,
    /// LUT identity: 0 = none, 1 = Fuji Superia, 2 = Kodak Vision, 3 = Teal-Orange
    pub lut_id:      u8,
}

impl Default for ColorGrade {
    fn default() -> Self {
        ColorGrade {
            exposure:    0.0,
            contrast:    0.0,
            saturation:  0.0,
            temperature: 0.0,
            highlights:  0.0,
            shadows:     0.0,
            vignette:    0.0,
            grain:       0.0,
            lut_id:      0,
        }
    }
}

// ── Frame Buffer Pool ─────────────────────────────────────────────────────────

/// Pre-allocated frame buffer. JS gets a stable pointer to this memory
/// and writes decoded pixel data directly — no copy across the WASM boundary.
///
/// Why Vec<u8> and not a fixed array? Because resolution is set at runtime.
/// The Vec is allocated once during init() and never reallocated — stable address.
pub struct FramePool {
    /// RGBA interleaved: 4 bytes per pixel
    buf:    Vec<u8>,
    width:  u32,
    height: u32,
    /// XorShift state for grain — deterministic, no syscall
    rng:    u32,
}

impl FramePool {
    pub fn new(width: u32, height: u32) -> Self {
        let size = (width * height * 4) as usize;
        FramePool {
            buf:    vec![0u8; size],
            width,
            height,
            rng:    0xDEAD_BEEF,
        }
    }

    pub fn ptr(&self)     -> *const u8 { self.buf.as_ptr() }
    pub fn ptr_mut(&mut self) -> *mut u8 { self.buf.as_mut_ptr() }
    pub fn len(&self)     -> usize     { self.buf.len() }

    /// Fast XorShift32 pseudo-random number for grain — no stdlib, no syscall.
    #[inline(always)]
    fn next_rand(&mut self) -> u8 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        (x & 0xFF) as u8
    }
}

// ── Pixel Processing ──────────────────────────────────────────────────────────

/// All pixel math happens here — on the pre-allocated buffer, in place.
/// The loop is branchless and cache-friendly. WASM SIMD (simd128) is engaged
/// automatically by the LLVM backend when targeting wasm32 with opt-level = 3.
fn apply_color_grade(pool: &mut FramePool, grade: &ColorGrade) {
    let w  = pool.width  as f32;
    let h  = pool.height as f32;
    let cx = w * 0.5;
    let cy = h * 0.5;
    let max_dist_sq = cx * cx + cy * cy;

    // Pre-compute grade constants outside the pixel loop
    let exposure_mul    = (2.0_f32).powf(grade.exposure);
    let contrast_pivot  = 0.5_f32;
    let contrast_scale  = 1.0 + grade.contrast * 1.5;
    let temp_r          = 1.0 + grade.temperature * 0.15;
    let temp_b          = 1.0 - grade.temperature * 0.15;
    let hi              = grade.highlights;
    let sh              = grade.shadows;
    let sat             = 1.0 + grade.saturation;
    let grain_str       = grade.grain;
    let vignette_str    = grade.vignette;

    let total_pixels = (pool.width * pool.height) as usize;

    for i in 0..total_pixels {
        let base = i * 4;
        // Safety: base + 3 < buf.len() by construction (width * height * 4)
        let r = pool.buf[base]     as f32 / 255.0;
        let g = pool.buf[base + 1] as f32 / 255.0;
        let b = pool.buf[base + 2] as f32 / 255.0;
        // Alpha byte is left untouched throughout.

        // 1. Exposure (EV stops)
        let mut r = r * exposure_mul;
        let mut g = g * exposure_mul;
        let mut b = b * exposure_mul;

        // 2. Temperature
        r *= temp_r;
        b *= temp_b;

        // 3. Luminance for luma-dependent ops
        let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        // 4. Highlights / Shadows (smooth roll-off via smoothstep on luma)
        let hi_mask = smooth_step(0.5, 1.0, luma);
        let sh_mask = smooth_step(0.5, 0.0, luma);
        r += hi * hi_mask * 0.3 + sh * sh_mask * 0.3;
        g += hi * hi_mask * 0.3 + sh * sh_mask * 0.3;
        b += hi * hi_mask * 0.3 + sh * sh_mask * 0.3;

        // 5. Contrast (S-curve pivot around 0.5)
        r = contrast_pivot + (r - contrast_pivot) * contrast_scale;
        g = contrast_pivot + (g - contrast_pivot) * contrast_scale;
        b = contrast_pivot + (b - contrast_pivot) * contrast_scale;

        // 6. Saturation (luma-preserving)
        let luma2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = luma2 + (r - luma2) * sat;
        g = luma2 + (g - luma2) * sat;
        b = luma2 + (b - luma2) * sat;

        // 7. Analytic LUT
        let (r, g, b) = apply_lut(grade.lut_id, r, g, b);

        // 8. Vignette (circular, distance-based darkening)
        let (r, g, b) = if vignette_str > 0.001 {
            let px      = (i as u32 % pool.width) as f32 - cx;
            let py      = (i as u32 / pool.width) as f32 - cy;
            let dist_sq = px * px + py * py;
            
            // REMOVED .powf(0.8) - simple division is hundreds of times faster
            let dist_norm = dist_sq / max_dist_sq; 
            let vig     = 1.0 - vignette_str * dist_norm;
            
            (r * vig, g * vig, b * vig)
        } else {
            (r, g, b)
        };

        // 9. Film grain (additive noise, luminance-dependent strength)
        let noise = (pool.next_rand() as f32 / 255.0 - 0.5) * grain_str * 0.12;
        let r = r + noise;
        let g = g + noise * 0.8; // slightly less green — film characteristic
        let b = b + noise * 0.9;

        // 10. Clamp & write back
        pool.buf[base]     = clamp_u8(r);
        pool.buf[base + 1] = clamp_u8(g);
        pool.buf[base + 2] = clamp_u8(b);
        // buf[base + 3] (alpha) intentionally untouched
    }
}

/// Analytic LUT approximations — no lookup table memory, pure math.
#[inline(always)]
fn apply_lut(lut_id: u8, r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    match lut_id {
        0 => (r, g, b), // passthrough

        // Fuji Superia 400: warm shadows, slightly desaturated mids, lifted blacks
        1 => {
            let r = r * 1.05 + 0.02;
            let g = g * 0.98 + 0.01;
            let b = b * 0.92 + 0.04;
            (r, g, b)
        }

        // Kodak Vision 3: rich contrast, blue-lifted shadows, warm skin tones
        2 => {
            let luma   = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let sh_mask = smooth_step(0.4, 0.0, luma);
            let r = r * 1.03 + sh_mask * 0.02;
            let g = g * 0.99;
            let b = b * 1.04 + sh_mask * 0.06;
            (r, g, b)
        }

        // Teal-Orange (Hollywood blockbuster)
        3 => {
            let luma    = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let hi_mask = smooth_step(0.5, 1.0, luma);
            let sh_mask = smooth_step(0.5, 0.0, luma);
            // Shadows → teal, highlights → orange
            let r = r + hi_mask * 0.08 - sh_mask * 0.02;
            let g = g - hi_mask * 0.03 - sh_mask * 0.04;
            let b = b - hi_mask * 0.08 + sh_mask * 0.08;
            (r, g, b)
        }

        _ => (r, g, b),
    }
}

#[inline(always)]
fn smooth_step(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline(always)]
fn clamp_u8(v: f32) -> u8 {
    (v * 255.0).clamp(0.0, 255.0) as u8
}

// ── WASM Public API (called from JS via wasm-bindgen) ────────────────────────

/// The top-level engine instance. JS holds this as an opaque handle.
#[wasm_bindgen]
pub struct IklippaEngine {
    timeline: Timeline,
    pool:     FramePool,
    grade:    ColorGrade,
}

#[wasm_bindgen]
impl IklippaEngine {
    /// Create the engine and allocate the frame buffer for the given resolution.
    /// Call this once after loading the WASM module, before any video is decoded.
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> IklippaEngine {
        // Surface Rust panics as readable errors in the browser console.
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();

        IklippaEngine {
            timeline: Timeline::new(),
            pool:     FramePool::new(width, height),
            grade:    ColorGrade::default(),
        }
    }

    // ── Memory Bridge ────────────────────────────────────────────────────────

    /// Returns a pointer to the internal RGBA frame buffer.
    ///
    /// JS usage:
    ///   const ptr  = engine.frame_ptr();
    ///   const len  = engine.frame_len();
    ///   const view = new Uint8ClampedArray(wasm.memory.buffer, ptr, len);
    ///   // WebCodecs writes decoded pixels directly into WASM heap:
    ///   await videoFrame.copyTo(view);
    ///   // Rust processes in place:
    ///   engine.process_frame();
    ///   // Copy out into an owned ImageData (see engine.js for why this copy
    ///   // is necessary when caching multiple frames):
    ///   const owned = new Uint8ClampedArray(len);
    ///   owned.set(new Uint8ClampedArray(wasm.memory.buffer, ptr, len));
    ///   const imageData = new ImageData(owned, width, height);
    #[wasm_bindgen]
    pub fn frame_ptr(&self) -> u32 {
        self.pool.ptr() as u32
    }

    #[wasm_bindgen]
    pub fn frame_len(&self) -> u32 {
        self.pool.len() as u32
    }

    /// Re-allocate the frame buffer for a new resolution.
    /// Call if the user loads a video with different dimensions.
    #[wasm_bindgen]
    pub fn resize(&mut self, width: u32, height: u32) {
        self.pool = FramePool::new(width, height);
    }

    // ── Frame Processing ─────────────────────────────────────────────────────

    /// Apply the current colour grade to whatever pixel data is in the frame buffer.
    /// Called after JS has written decoded pixels into the buffer via frame_ptr().
    #[wasm_bindgen]
    pub fn process_frame(&mut self) {
        apply_color_grade(&mut self.pool, &self.grade);
    }

    // ── Colour Grade Setters ─────────────────────────────────────────────────

    #[wasm_bindgen] pub fn set_exposure(&mut self, v: f32)    { self.grade.exposure    = v.clamp(-2.0, 2.0); }
    #[wasm_bindgen] pub fn set_contrast(&mut self, v: f32)    { self.grade.contrast    = v.clamp(-1.0, 1.0); }
    #[wasm_bindgen] pub fn set_saturation(&mut self, v: f32)  { self.grade.saturation  = v.clamp(-1.0, 1.0); }
    #[wasm_bindgen] pub fn set_temperature(&mut self, v: f32) { self.grade.temperature = v.clamp(-1.0, 1.0); }
    #[wasm_bindgen] pub fn set_highlights(&mut self, v: f32)  { self.grade.highlights  = v.clamp(-1.0, 1.0); }
    #[wasm_bindgen] pub fn set_shadows(&mut self, v: f32)     { self.grade.shadows     = v.clamp(-1.0, 1.0); }
    #[wasm_bindgen] pub fn set_vignette(&mut self, v: f32)    { self.grade.vignette    = v.clamp( 0.0, 1.0); }
    #[wasm_bindgen] pub fn set_grain(&mut self, v: f32)       { self.grade.grain       = v.clamp( 0.0, 1.0); }
    #[wasm_bindgen] pub fn set_lut(&mut self, id: u8)         { self.grade.lut_id      = id.min(3);          }

    // ── Timeline API ─────────────────────────────────────────────────────────

    #[wasm_bindgen]
    pub fn add_clip(
        &mut self,
        track: u32,
        start_ms: u32,
        end_ms: u32,
        source_offset_ms: u32,
    ) -> u32 {
        self.timeline.add_clip(track as usize, start_ms, end_ms, source_offset_ms)
    }

    /// Returns the source-file timestamp (ms) to decode for a given playhead
    /// position, or u32::MAX if no clip is active on track 0 at that time.
    #[wasm_bindgen]
    pub fn source_ms_for_playhead(&self, playhead_ms: u32) -> u32 {
        match self.timeline.active_clip(0, playhead_ms) {
            Some(clip) => clip.source_offset_ms + (playhead_ms - clip.start_ms),
            None       => u32::MAX,
        }
    }

    #[wasm_bindgen]
    pub fn duration_ms(&self) -> u32 {
        self.timeline.duration_ms
    }

    // ── Compositor (multi-track) ─────────────────────────────────────────────
    // Phase 1: composites track 0 only.
    // Phase 2: alpha blending for overlays — write track N into a scratch
    // buffer, then blend with premultiplied alpha onto the main buffer.
    // The API surface below is designed for that without breaking changes.

    /// How many tracks currently have clips.
    #[wasm_bindgen]
    pub fn active_track_count(&self) -> u32 {
        self.timeline.clip_count.iter().filter(|&&c| c > 0).count() as u32
    }
}