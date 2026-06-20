// iKlippa Engine — lib.rs  (rev 3)
//
// Changes vs rev 2:
//   • add_clip now inserts in start_ms order so active_clip can break early
//   • active_clip breaks out of the loop once past the playhead (O(log n) in practice)
//   • console_error_panic_hook wired via feature flag (add to Cargo.toml)
//   • NEW: trim_clip() — updates clip boundaries and source offset in place
//   • NEW: split_clip() — splits one clip into two at a given timestamp
//   • NEW: recalc_duration() — recomputes timeline duration after mutations

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
    pub fn active_clip(&self, track: usize, playhead_ms: u32) -> Option<&Clip> {
        let count = self.clip_count[track];
        for i in 0..count {
            let c = &self.clips[track][i];
            if c.start_ms > playhead_ms {
                break;
            }
            if playhead_ms < c.end_ms {
                return Some(c);
            }
        }
        None
    }

    /// Recompute duration_ms as the maximum end_ms across all tracks.
    pub fn recalc_duration(&mut self) {
        let mut max_end = 0u32;
        for track_idx in 0..MAX_TRACKS {
            for i in 0..self.clip_count[track_idx] {
                if self.clips[track_idx][i].end_ms > max_end {
                    max_end = self.clips[track_idx][i].end_ms;
                }
            }
        }
        self.duration_ms = max_end;
    }

    /// Find a clip by ID on a given track and return its mutable index.
    fn find_clip_index(&self, track: usize, clip_id: u32) -> Option<usize> {
        for i in 0..self.clip_count[track] {
            if self.clips[track][i].id == clip_id {
                return Some(i);
            }
        }
        None
    }
}

// ── Colour Grade Parameters ───────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub struct ColorGrade {
    pub exposure:    f32,
    pub contrast:    f32,
    pub saturation:  f32,
    pub temperature: f32,
    pub highlights:  f32,
    pub shadows:     f32,
    pub vignette:    f32,
    pub grain:       f32,
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

pub struct FramePool {
    buf:    Vec<u8>,
    width:  u32,
    height: u32,
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

fn apply_color_grade(pool: &mut FramePool, grade: &ColorGrade) {
    let w  = pool.width  as f32;
    let h  = pool.height as f32;
    let cx = w * 0.5;
    let cy = h * 0.5;

    let max_dist_sq = cx * cx + cy * cy;
    let inv_max_dist_sq = 1.0 / max_dist_sq;
    let inv_255 = 1.0 / 255.0;

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

    for y in 0..pool.height {
        let py = y as f32 - cy;
        let py_sq = py * py;
        let row_base = (y * pool.width * 4) as usize;

        for x in 0..pool.width {
            let base = row_base + (x * 4) as usize;

            let r = pool.buf[base]     as f32 * inv_255;
            let g = pool.buf[base + 1] as f32 * inv_255;
            let b = pool.buf[base + 2] as f32 * inv_255;

            let mut r = r * exposure_mul;
            let mut g = g * exposure_mul;
            let mut b = b * exposure_mul;

            r *= temp_r;
            b *= temp_b;

            let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

            let hi_mask = smooth_step(0.5, 1.0, luma);
            let sh_mask = smooth_step(0.5, 0.0, luma);
            r += hi * hi_mask * 0.3 + sh * sh_mask * 0.3;
            g += hi * hi_mask * 0.3 + sh * sh_mask * 0.3;
            b += hi * hi_mask * 0.3 + sh * sh_mask * 0.3;

            r = contrast_pivot + (r - contrast_pivot) * contrast_scale;
            g = contrast_pivot + (g - contrast_pivot) * contrast_scale;
            b = contrast_pivot + (b - contrast_pivot) * contrast_scale;

            let luma2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            r = luma2 + (r - luma2) * sat;
            g = luma2 + (g - luma2) * sat;
            b = luma2 + (b - luma2) * sat;

            let (mut r, mut g, mut b) = apply_lut(grade.lut_id, r, g, b);

            if vignette_str > 0.001 {
                let px = x as f32 - cx;
                let dist_sq = px * px + py_sq;
                let vig = 1.0 - vignette_str * (dist_sq * inv_max_dist_sq);
                r *= vig;
                g *= vig;
                b *= vig;
            }

            let noise = (pool.next_rand() as f32 * inv_255 - 0.5) * grain_str * 0.12;
            let r = r + noise;
            let g = g + noise * 0.8;
            let b = b + noise * 0.9;

            pool.buf[base]     = clamp_u8(r);
            pool.buf[base + 1] = clamp_u8(g);
            pool.buf[base + 2] = clamp_u8(b);
        }
    }
}

#[inline(always)]
fn apply_lut(lut_id: u8, r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    match lut_id {
        0 => (r, g, b),
        1 => {
            let r = r * 1.05 + 0.02;
            let g = g * 0.98 + 0.01;
            let b = b * 0.92 + 0.04;
            (r, g, b)
        }
        2 => {
            let luma   = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let sh_mask = smooth_step(0.4, 0.0, luma);
            let r = r * 1.03 + sh_mask * 0.02;
            let g = g * 0.99;
            let b = b * 1.04 + sh_mask * 0.06;
            (r, g, b)
        }
        3 => {
            let luma    = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let hi_mask = smooth_step(0.5, 1.0, luma);
            let sh_mask = smooth_step(0.5, 0.0, luma);
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

// ── WASM Public API ──────────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct IklippaEngine {
    timeline: Timeline,
    pool:     FramePool,
    grade:    ColorGrade,
}

#[wasm_bindgen]
impl IklippaEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> IklippaEngine {
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();

        IklippaEngine {
            timeline: Timeline::new(),
            pool:     FramePool::new(width, height),
            grade:    ColorGrade::default(),
        }
    }

    // ── Memory Bridge ────────────────────────────────────────────────────────

    #[wasm_bindgen]
    pub fn frame_ptr(&self) -> u32 {
        self.pool.ptr() as u32
    }

    #[wasm_bindgen]
    pub fn frame_len(&self) -> u32 {
        self.pool.len() as u32
    }

    #[wasm_bindgen]
    pub fn resize(&mut self, width: u32, height: u32) {
        self.pool = FramePool::new(width, height);
    }

    // ── Frame Processing ─────────────────────────────────────────────────────

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

    /// Trim a clip: update its timeline boundaries and source offset.
    /// Returns true if the clip was found and updated.
    #[wasm_bindgen]
    pub fn trim_clip(
        &mut self,
        track: u32,
        clip_id: u32,
        new_start_ms: u32,
        new_end_ms: u32,
        new_source_offset_ms: u32,
    ) -> bool {
        let track_idx = track as usize;
        if track_idx >= MAX_TRACKS { return false; }

        if let Some(i) = self.timeline.find_clip_index(track_idx, clip_id) {
            let clip = &mut self.timeline.clips[track_idx][i];
            clip.start_ms = new_start_ms;
            clip.end_ms = new_end_ms;
            clip.source_offset_ms = new_source_offset_ms;
            self.timeline.recalc_duration();
            return true;
        }
        false
    }

    /// Split a clip at `at_ms` on the given track.
    /// Returns the new clip ID (second half), or 0 on failure.
    #[wasm_bindgen]
    pub fn split_clip(&mut self, track: u32, clip_id: u32, at_ms: u32) -> u32 {
        let track_idx = track as usize;
        if track_idx >= MAX_TRACKS { return 0; }
        let count = self.timeline.clip_count[track_idx];
        if count >= MAX_CLIPS_PER_TRACK { return 0; }

        // Find the clip
        let mut found_idx: Option<usize> = None;
        let mut original_clip = Clip::EMPTY;
        for i in 0..count {
            let c = &self.timeline.clips[track_idx][i];
            if c.id == clip_id {
                // Validate split point is within the clip
                if at_ms <= c.start_ms || at_ms >= c.end_ms { return 0; }
                original_clip = *c;
                found_idx = Some(i);
                break;
            }
        }

        let i = match found_idx {
            Some(idx) => idx,
            None => return 0,
        };

        let source_at_split = original_clip.source_offset_ms + (at_ms - original_clip.start_ms);

        // Shrink existing clip to first half
        self.timeline.clips[track_idx][i].end_ms = at_ms;

        // Create second half
        let new_id = self.timeline.next_id;
        self.timeline.next_id += 1;

        let insert_at = i + 1;
        // Shift clips right to make room
        for j in (insert_at..count).rev() {
            self.timeline.clips[track_idx][j + 1] = self.timeline.clips[track_idx][j];
        }
        self.timeline.clips[track_idx][insert_at] = Clip {
            id: new_id,
            track: track_idx as u8,
            start_ms: at_ms,
            end_ms: original_clip.end_ms,
            source_offset_ms: source_at_split,
        };
        self.timeline.clip_count[track_idx] += 1;
        self.timeline.recalc_duration();

        new_id
    }

    #[wasm_bindgen]
    pub fn active_track_count(&self) -> u32 {
        self.timeline.clip_count.iter().filter(|&&c| c > 0).count() as u32
    }
}