// iKlippa Engine — timeline_state.rs (Phase 1, Task 1)
//
// The canonical project data model. All timestamps are i64 microseconds to
// match the Director JSON schema consumed in Phase 2 — no boundary conversion.
//
// This module is serialisable end-to-end (serde + serde_json) so the same
// struct layout powers: (a) the WASM bridge API in lib.rs, (b) the `.iklippa`
// save/load format (Task 5), and (c) the Phase 2 Director command payload.
//
// The legacy Clip/Timeline in lib.rs stays callable until Task 2 compositing
// is verified against this model, then it gets deleted.

use serde::{Deserialize, Serialize};

// ── Scalars & enums ───────────────────────────────────────────────────────────

/// Rational number for frame rates (e.g. 30000/1001 = 29.97 fps).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rational {
    pub num: i64,
    pub den: i64,
}

impl Rational {
    pub const fn new(num: i64, den: i64) -> Self {
        Rational { num, den }
    }

    pub const fn fps(fps: i64) -> Self {
        Rational { num: fps, den: 1 }
    }

    pub fn as_f32(&self) -> f32 {
        self.num as f32 / self.den as f32
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColourSpace {
    Srgb,
    Rec709,
    Rec2020,
    DisplayP3,
}

impl Default for ColourSpace {
    fn default() -> Self {
        ColourSpace::Rec709
    }
}

/// Porter-Duff / blend modes supported by the compositor (Task 2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlendMode {
    Normal,
    Multiply,
    Screen,
    Overlay,
}

impl Default for BlendMode {
    fn default() -> Self {
        BlendMode::Normal
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackType {
    Video,
    Audio,
    Caption,
}

impl Default for TrackType {
    fn default() -> Self {
        TrackType::Video
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MirrorAxis {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionPosition {
    LowerThird,
    Center,
    Top,
}

// ── Per-clip state ────────────────────────────────────────────────────────────

/// 2D affine transform for a clip on the compositor (Task 2).
/// `x`/`y` are normalised offsets from frame centre (-1..1).
/// `scale` is multiplicative (1.0 = source size). `rotation` is radians.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClipTransform {
    pub x: f32,
    pub y: f32,
    pub scale: f32,
    pub rotation: f32,
    pub opacity: f32,
    pub anchor_x: f32,
    pub anchor_y: f32,
    pub blend_mode: BlendMode,
}

impl Default for ClipTransform {
    fn default() -> Self {
        ClipTransform {
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            opacity: 1.0,
            anchor_x: 0.5,
            anchor_y: 0.5,
            blend_mode: BlendMode::Normal,
        }
    }
}

impl ClipTransform {
    fn is_default(&self) -> bool {
        *self == ClipTransform::default()
    }
}

/// Per-clip colour grade. The linear-light pipeline (Task 3) reads this struct.
/// Vignette and grain are NOT here — they live as `Effect`s (Task 3 migrates
/// them out of the legacy global `ColorGrade`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ColourSettings {
    pub exposure: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub temperature: f32,
    pub highlights: f32,
    pub shadows: f32,
    /// Green↔magenta, -1..1.
    pub tint: f32,
    /// Lift / gamma / gain RGB wheels, -1..1 per channel.
    pub lift: [f32; 3],
    pub gamma: [f32; 3],
    pub gain: [f32; 3],
}

impl Default for ColourSettings {
    fn default() -> Self {
        ColourSettings {
            exposure: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            temperature: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            tint: 0.0,
            lift: [0.0, 0.0, 0.0],
            gamma: [0.0, 0.0, 0.0],
            gain: [0.0, 0.0, 0.0],
        }
    }
}

impl ColourSettings {
    fn is_default(&self) -> bool {
        *self == ColourSettings::default()
    }
}

/// Effect type enum — matches the Tech Spec `EffectType`. Phase 1 only uses
/// Vignette/FilmGrain (migrated from the legacy grade) plus LUT (Task 9).
/// The rest are listed for forward-compat; the compositor no-ops them until
/// implemented.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EffectType {
    Vignette,
    FilmGrain,
    Blur,
    Sharpen,
    ChromaticAberration,
    Glitch,
    Mirror,
    LUT,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EffectParams {
    Vignette { strength: f32, radius: f32 },
    FilmGrain { strength: f32 },
    Blur { radius: f32 },
    Sharpen { amount: f32 },
    ChromaticAberration { amount: f32 },
    Glitch { amount: f32 },
    Mirror { axis: MirrorAxis },
    LUT { lut_id: u32, intensity: f32 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Effect {
    pub id: u32,
    pub effect_type: EffectType,
    pub params: EffectParams,
    /// 0..1 master mix. Effect may also carry its own strength in `params`.
    pub intensity: f32,
    pub enabled: bool,
}

impl Effect {
    pub fn new(id: u32, effect_type: EffectType, params: EffectParams) -> Self {
        Effect {
            id,
            effect_type,
            params,
            intensity: 1.0,
            enabled: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CaptionStyle {
    pub font_family: String,
    /// Render size in pixels at export resolution.
    pub size: f32,
    /// RGBA.
    pub colour: [u8; 4],
    /// 0..1 background opacity behind the text.
    pub bg_opacity: f32,
    pub position: CaptionPosition,
}

impl Default for CaptionStyle {
    fn default() -> Self {
        CaptionStyle {
            font_family: "Inter, sans-serif".to_string(),
            size: 48.0,
            colour: [255, 255, 255, 255],
            bg_opacity: 0.0,
            position: CaptionPosition::LowerThird,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Clip {
    pub id: u32,
    /// References a media pool entry by id (media bytes stay client-side).
    pub source_id: String,
    /// Timeline placement, microseconds.
    pub timeline_start_us: i64,
    pub timeline_end_us: i64,
    /// Source-file window, microseconds. For a normal-speed clip:
    /// `source_end_us = source_start_us + (timeline_end_us - timeline_start_us)`.
    pub source_start_us: i64,
    pub source_end_us: i64,
    /// 1.0 = normal. Affects how source window maps to timeline window.
    pub speed: f32,
    pub transform: ClipTransform,
    pub colour_settings: ColourSettings,
    pub effects: Vec<Effect>,
    /// Populated only on clips that live on a Caption track.
    pub caption_text: Option<String>,
    pub caption_style: Option<CaptionStyle>,
}

impl Clip {
    pub fn new(id: u32, source_id: String, timeline_start_us: i64, timeline_end_us: i64) -> Self {
        let duration_us = timeline_end_us - timeline_start_us;
        Clip {
            id,
            source_id,
            timeline_start_us,
            timeline_end_us,
            source_start_us: 0,
            source_end_us: duration_us,
            speed: 1.0,
            transform: ClipTransform::default(),
            colour_settings: ColourSettings::default(),
            effects: Vec::new(),
            caption_text: None,
            caption_style: None,
        }
    }

    pub fn timeline_duration_us(&self) -> i64 {
        self.timeline_end_us - self.timeline_start_us
    }

    pub fn source_duration_us(&self) -> i64 {
        self.source_end_us - self.source_start_us
    }

    /// True if no per-clip grade/transform/effects/caption have been applied.
    /// The compositor (Task 2) uses this as a fast-path to skip per-clip work.
    pub fn is_default(&self) -> bool {
        self.transform.is_default()
            && self.colour_settings.is_default()
            && self.effects.is_empty()
            && self.caption_text.is_none()
            && self.speed == 1.0
    }
}

// ── Track & Project ───────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: u32,
    /// z-order for video tracks (lower = bottom). Compositor iterates ascending.
    pub order: u32,
    pub track_type: TrackType,
    pub name: String,
    pub muted: bool,
    pub locked: bool,
    pub visible: bool,
    /// Audio tracks: 0..1. Video tracks ignore this (use clip opacity).
    pub volume: f32,
    /// Audio tracks: -1..1.
    pub pan: f32,
    pub clips: Vec<Clip>,
}

impl Track {
    pub fn new(id: u32, order: u32, track_type: TrackType, name: String) -> Self {
        Track {
            id,
            order,
            track_type,
            name,
            muted: false,
            locked: false,
            visible: true,
            volume: 1.0,
            pan: 0.0,
            clips: Vec::new(),
        }
    }

    pub fn new_video(id: u32, order: u32, name: impl Into<String>) -> Self {
        Track::new(id, order, TrackType::Video, name.into())
    }

    pub fn new_audio(id: u32, order: u32, name: impl Into<String>) -> Self {
        Track::new(id, order, TrackType::Audio, name.into())
    }

    pub fn new_caption(id: u32, order: u32, name: impl Into<String>) -> Self {
        Track::new(id, order, TrackType::Caption, name.into())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: Rational,
    pub colour_space: ColourSpace,
    pub tracks: Vec<Track>,
    /// Cached timeline duration in microseconds. Updated by `compute_duration`.
    pub duration_us: i64,
    pub next_clip_id: u32,
    pub next_track_id: u32,
    pub next_effect_id: u32,
}

impl Project {
    pub fn new(name: String, width: u32, height: u32, frame_rate: Rational) -> Self {
        // Seed a default video track (id 0) so a fresh project is immediately
        // editable. `next_track_id` starts at 1 so the next add_track call
        // allocates a non-colliding id.
        let seed = Track::new_video(0, 0, "Video 1");
        Project {
            id: new_project_id(),
            name,
            width,
            height,
            frame_rate,
            colour_space: ColourSpace::default(),
            tracks: vec![seed],
            duration_us: 0,
            next_clip_id: 1,
            next_track_id: 1,
            next_effect_id: 1,
        }
    }

    // ── Serialisation ──────────────────────────────────────────────────────

    pub fn load_project(json: &str) -> Result<Self, serde_json::Error> {
        let project: Project = serde_json::from_str(json)?;
        Ok(project)
    }

    pub fn serialize_project(&self) -> Result<String, serde_json::Error> {
        // `pretty` so `.iklippa` files are diff-friendly and hand-debuggable.
        serde_json::to_string_pretty(self)
    }

    // ── ID allocation ──────────────────────────────────────────────────────

    pub fn alloc_clip_id(&mut self) -> u32 {
        let id = self.next_clip_id;
        self.next_clip_id += 1;
        id
    }

    pub fn alloc_track_id(&mut self) -> u32 {
        let id = self.next_track_id;
        self.next_track_id += 1;
        id
    }

    pub fn alloc_effect_id(&mut self) -> u32 {
        let id = self.next_effect_id;
        self.next_effect_id += 1;
        id
    }

    // ── Track lookup ───────────────────────────────────────────────────────

    pub fn find_track(&self, track_id: u32) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == track_id)
    }

    pub fn find_track_mut(&mut self, track_id: u32) -> Option<&mut Track> {
        self.tracks.iter_mut().find(|t| t.id == track_id)
    }

    pub fn find_track_index(&self, track_id: u32) -> Option<usize> {
        self.tracks.iter().position(|t| t.id == track_id)
    }

    /// Add a track as-is (the track keeps its own `id`). Callers that need an
    /// auto-allocated id should call `alloc_track_id()` first. Returns the
    /// track's id for convenience.
    pub fn add_track(&mut self, track: Track) -> u32 {
        let id = track.id;
        self.tracks.push(track);
        id
    }

    // ── Clip lookup ────────────────────────────────────────────────────────

    pub fn find_clip(&self, clip_id: u32) -> Option<&Clip> {
        self.tracks
            .iter()
            .find_map(|t| t.clips.iter().find(|c| c.id == clip_id))
    }

    pub fn find_clip_mut(&mut self, clip_id: u32) -> Option<&mut Clip> {
        self.tracks
            .iter_mut()
            .find_map(|t| t.clips.iter_mut().find(|c| c.id == clip_id))
    }

    /// (track_index, clip_index) for a clip id — useful when the mutation must
    /// operate on the track (e.g. re-sort after a move).
    pub fn locate_clip(&self, clip_id: u32) -> Option<(usize, usize)> {
        for (ti, t) in self.tracks.iter().enumerate() {
            if let Some(ci) = t.clips.iter().position(|c| c.id == clip_id) {
                return Some((ti, ci));
            }
        }
        None
    }

    // ── Active-clip query (compositor hot path) ────────────────────────────

    /// All clips active at `ts_us` on visible, non-muted tracks, sorted by
    /// track `order` ascending. The compositor (Task 2) iterates this in order
    /// to alpha-composite layers bottom→top.
    pub fn clips_at(&self, ts_us: i64) -> Vec<&Clip> {
        // Iterate tracks in `order` so the output is already sorted bottom→top.
        // We avoid an O(n²) sort by collecting track indices in order first.
        let mut track_order: Vec<usize> = (0..self.tracks.len()).collect();
        track_order.sort_by_key(|&i| self.tracks[i].order);
        let mut out: Vec<&Clip> = Vec::new();
        for ti in track_order {
            let track = &self.tracks[ti];
            if !track.visible || track.muted {
                continue;
            }
            for clip in track.clips.iter() {
                if ts_us >= clip.timeline_start_us && ts_us < clip.timeline_end_us {
                    out.push(clip);
                }
            }
        }
        out
    }

    /// Active clip on a specific track at `ts_us`, if any.
    pub fn clip_at_on_track(&self, track_id: u32, ts_us: i64) -> Option<&Clip> {
        let track = self.find_track(track_id)?;
        track.clips.iter().find(|c| {
            ts_us >= c.timeline_start_us && ts_us < c.timeline_end_us
        })
    }

    // ── Mutations ──────────────────────────────────────────────────────────

    /// Insert `clip` into the track with `track_id`, keeping the track sorted
    /// by `timeline_start_us`. Reassigns the clip id from the project's
    /// allocator and returns it.
    pub fn insert_clip(&mut self, track_id: u32, mut clip: Clip) -> Option<u32> {
        // Check existence with an immutable borrow first so we can allocate
        // the id (which needs &mut self) before taking the track's mutable
        // borrow — the borrow checker won't allow both at once.
        if self.find_track(track_id).is_none() {
            return None;
        }
        let id = self.alloc_clip_id();
        clip.id = id;
        let track = self.find_track_mut(track_id).expect("existence checked above");
        let pos = track
            .clips
            .iter()
            .position(|c| c.timeline_start_us > clip.timeline_start_us)
            .unwrap_or(track.clips.len());
        track.clips.insert(pos, clip);
        // Track borrow ends here (NLL); compute_duration may take &mut self.
        self.compute_duration();
        Some(id)
    }

    /// Trim a clip in place. Adjusts `timeline_end_us` and `source_end_us`
    /// together so the source window follows the timeline window at the
    /// clip's `speed`.
    pub fn trim_clip(
        &mut self,
        track_id: u32,
        clip_id: u32,
        new_start_us: i64,
        new_end_us: i64,
        new_source_start_us: i64,
    ) -> Result<(), &'static str> {
        let track = self.find_track_mut(track_id).ok_or("track not found")?;
        let clip = track
            .clips
            .iter_mut()
            .find(|c| c.id == clip_id)
            .ok_or("clip not found")?;
        if new_end_us <= new_start_us {
            return Err("trim: end must be > start");
        }
        clip.timeline_start_us = new_start_us;
        clip.timeline_end_us = new_end_us;
        clip.source_start_us = new_source_start_us;
        let timeline_us = new_end_us - new_start_us;
        clip.source_end_us = new_source_start_us + ((timeline_us as f32) / clip.speed) as i64;
        // Re-sort the track in case the start moved past a neighbour.
        track.clips.sort_by_key(|c| c.timeline_start_us);
        self.compute_duration();
        Ok(())
    }

    /// Split a clip at `split_at_us` (timeline microseconds). The original
    /// clip becomes the left half, a new clip is inserted as the right half.
    /// Returns the new clip's id, or an error if the split point is outside
    /// the clip's window.
    pub fn split_clip(
        &mut self,
        track_id: u32,
        clip_id: u32,
        split_at_us: i64,
    ) -> Result<u32, &'static str> {
        let (track_idx, clip_idx) = self.locate_clip(clip_id).ok_or("clip not found")?;
        if self.tracks[track_idx].id != track_id {
            return Err("clip not on given track");
        }
        {
            let clip = &self.tracks[track_idx].clips[clip_idx];
            if split_at_us <= clip.timeline_start_us || split_at_us >= clip.timeline_end_us {
                return Err("split point outside clip window");
            }
        }

        let new_id = self.alloc_clip_id();
        // Capture the original end values BEFORE truncating the left half so
        // the cloned right half keeps them — clone-after-truncate would
        // otherwise copy the truncated ends onto the right clip.
        let (left_end_us, right_source_start_us, orig_timeline_end_us, orig_source_end_us) = {
            let clip = &mut self.tracks[track_idx].clips[clip_idx];
            let left_timeline_us = split_at_us - clip.timeline_start_us;
            let left_source_us = ((left_timeline_us as f32) / clip.speed) as i64;
            let right_source_start = clip.source_start_us + left_source_us;
            let orig_timeline_end = clip.timeline_end_us;
            let orig_source_end = clip.source_end_us;
            clip.timeline_end_us = split_at_us;
            clip.source_end_us = right_source_start;
            (split_at_us, right_source_start, orig_timeline_end, orig_source_end)
        };

        let mut right = self.tracks[track_idx].clips[clip_idx].clone();
        right.id = new_id;
        right.timeline_start_us = left_end_us;
        right.timeline_end_us = orig_timeline_end_us;
        right.source_start_us = right_source_start_us;
        right.source_end_us = orig_source_end_us;

        // Insert right after left; track stays sorted since left_end == right_start.
        self.tracks[track_idx].clips.insert(clip_idx + 1, right);
        self.compute_duration();
        Ok(new_id)
    }

    /// Move a clip to a new timeline start, preserving its duration and source
    /// window. Re-sorts the track.
    pub fn move_clip(
        &mut self,
        track_id: u32,
        clip_id: u32,
        new_start_us: i64,
    ) -> Result<(), &'static str> {
        let track = self.find_track_mut(track_id).ok_or("track not found")?;
        let clip = track
            .clips
            .iter_mut()
            .find(|c| c.id == clip_id)
            .ok_or("clip not found")?;
        let duration_us = clip.timeline_end_us - clip.timeline_start_us;
        clip.timeline_start_us = new_start_us;
        clip.timeline_end_us = new_start_us + duration_us;
        track.clips.sort_by_key(|c| c.timeline_start_us);
        self.compute_duration();
        Ok(())
    }

    /// Remove a clip by id. Returns true if a clip was removed.
    pub fn remove_clip(&mut self, track_id: u32, clip_id: u32) -> bool {
        let Some(track) = self.find_track_mut(track_id) else {
            return false;
        };
        let before = track.clips.len();
        track.clips.retain(|c| c.id != clip_id);
        let removed = track.clips.len() < before;
        if removed {
            self.compute_duration();
        }
        removed
    }

    /// Reorder tracks by passing the desired id sequence. The `order` field of
    /// each track is rewritten to match the position in `new_order`. Tracks
    /// not listed keep their relative order at the end. Returns an error if
    /// `new_order` contains a duplicate or unknown id.
    pub fn reorder_tracks(&mut self, new_order: &[u32]) -> Result<(), &'static str> {
        if new_order.iter().collect::<std::collections::HashSet<_>>().len() != new_order.len() {
            return Err("reorder: duplicate id in new_order");
        }
        let known: std::collections::HashSet<u32> =
            self.tracks.iter().map(|t| t.id).collect();
        for id in new_order {
            if !known.contains(id) {
                return Err("reorder: unknown track id");
            }
        }
        for (i, id) in new_order.iter().enumerate() {
            if let Some(t) = self.tracks.iter_mut().find(|t| &t.id == id) {
                t.order = i as u32;
            }
        }
        let mut remainder_order = new_order.len() as u32;
        for t in self.tracks.iter_mut() {
            if !new_order.contains(&t.id) {
                t.order = remainder_order;
                remainder_order += 1;
            }
        }
        self.tracks.sort_by_key(|t| t.order);
        Ok(())
    }

    /// Recompute `duration_us` as the max `timeline_end_us` across all clips.
    /// Returns the new duration.
    pub fn compute_duration(&mut self) -> i64 {
        let max_end = self
            .tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .map(|c| c.timeline_end_us)
            .max()
            .unwrap_or(0);
        self.duration_us = max_end.max(0);
        self.duration_us
    }
}

fn new_project_id() -> String {
    // Cheap, non-cryptographic, monotonic-ish id for the localStorage draft key.
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    format!("proj_{now:x}")
}

// ── Unit tests (run with `cargo test`, non-wasm target) ───────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_project() -> Project {
        let mut p = Project::new("Test".into(), 1920, 1080, Rational::fps(30));
        // Replace the seeded track with three explicit tracks (V0, V1, A0) so
        // the tests can address tracks by stable ids 0, 1, 2.
        p.tracks.clear();
        p.add_track(Track::new_video(0, 0, "V0"));
        p.add_track(Track::new_video(1, 1, "V1"));
        p.add_track(Track::new_audio(2, 2, "A0"));
        p.next_track_id = 3;
        p
    }

    #[test]
    fn project_round_trips_through_json() {
        let mut p = sample_project();
        let clip = Clip::new(0, "media_1".into(), 1_000_000, 5_000_000);
        p.insert_clip(0, clip);
        let json = p.serialize_project().unwrap();
        let back = Project::load_project(&json).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn insert_clip_keeps_track_sorted_and_assigns_id() {
        let mut p = sample_project();
        let a = Clip::new(0, "m".into(), 5_000_000, 8_000_000);
        let b = Clip::new(0, "m".into(), 0, 1_000_000);
        let c = Clip::new(0, "m".into(), 2_000_000, 3_000_000);
        let id_a = p.insert_clip(0, a).unwrap();
        let id_b = p.insert_clip(0, b).unwrap();
        let id_c = p.insert_clip(0, c).unwrap();
        let starts: Vec<i64> = p.find_track(0).unwrap().clips.iter().map(|c| c.timeline_start_us).collect();
        assert_eq!(starts, vec![0, 2_000_000, 5_000_000]);
        assert!(id_a != id_b && id_b != id_c);
    }

    #[test]
    fn split_clip_divides_window_and_preserves_source() {
        let mut p = sample_project();
        let mut clip = Clip::new(0, "m".into(), 1_000_000, 4_000_000);
        clip.source_start_us = 200_000;
        clip.source_end_us = 200_000 + 3_000_000;
        let id = p.insert_clip(0, clip).unwrap();
        let new_id = p.split_clip(0, id, 2_500_000).unwrap();

        let left = p.find_clip(id).unwrap();
        let right = p.find_clip(new_id).unwrap();
        assert_eq!(left.timeline_start_us, 1_000_000);
        assert_eq!(left.timeline_end_us, 2_500_000);
        assert_eq!(right.timeline_start_us, 2_500_000);
        assert_eq!(right.timeline_end_us, 4_000_000);
        assert_eq!(right.source_start_us, left.source_end_us);
    }

    #[test]
    fn split_rejects_out_of_window_point() {
        let mut p = sample_project();
        let clip = Clip::new(0, "m".into(), 1_000_000, 4_000_000);
        let id = p.insert_clip(0, clip).unwrap();
        assert!(p.split_clip(0, id, 500_000).is_err());
        assert!(p.split_clip(0, id, 4_000_000).is_err());
    }

    #[test]
    fn trim_adjusts_source_end_via_speed() {
        let mut p = sample_project();
        let mut clip = Clip::new(0, "m".into(), 0, 4_000_000);
        clip.source_start_us = 0;
        clip.source_end_us = 4_000_000;
        clip.speed = 2.0; // 2x: 4s timeline = 2s source
        let id = p.insert_clip(0, clip).unwrap();
        p.trim_clip(0, id, 0, 2_000_000, 0).unwrap();
        let c = p.find_clip(id).unwrap();
        assert_eq!(c.timeline_end_us, 2_000_000);
        // source_end = source_start + timeline_us / speed = 0 + 2_000_000/2 = 1_000_000
        assert_eq!(c.source_end_us, 1_000_000);
    }

    #[test]
    fn move_clip_preserves_duration_and_re_sorts() {
        let mut p = sample_project();
        let a = Clip::new(0, "m".into(), 0, 1_000_000);
        let b = Clip::new(0, "m".into(), 2_000_000, 3_000_000);
        let id_a = p.insert_clip(0, a).unwrap();
        let _id_b = p.insert_clip(0, b).unwrap();
        p.move_clip(0, id_a, 4_000_000).unwrap();
        let starts: Vec<i64> = p.find_track(0).unwrap().clips.iter().map(|c| c.timeline_start_us).collect();
        assert_eq!(starts, vec![2_000_000, 4_000_000]);
        let moved = p.find_clip(id_a).unwrap();
        assert_eq!(moved.timeline_end_us - moved.timeline_start_us, 1_000_000);
    }

    #[test]
    fn remove_clip_returns_true_only_when_found() {
        let mut p = sample_project();
        let clip = Clip::new(0, "m".into(), 0, 1_000_000);
        let id = p.insert_clip(0, clip).unwrap();
        assert!(p.remove_clip(0, id));
        assert!(!p.remove_clip(0, id));
        assert!(p.find_clip(id).is_none());
    }

    #[test]
    fn reorder_tracks_rewrites_order_and_sorts() {
        let mut p = sample_project();
        // ids 0,1,2 → reorder to [1,0]
        p.reorder_tracks(&[1, 0]).unwrap();
        let order: Vec<u32> = p.tracks.iter().map(|t| t.id).collect();
        assert_eq!(order, vec![1, 0, 2]);
        assert_eq!(p.tracks[0].order, 0);
        assert_eq!(p.tracks[1].order, 1);
        assert_eq!(p.tracks[2].order, 2);
    }

    #[test]
    fn reorder_rejects_duplicate_and_unknown() {
        let mut p = sample_project();
        assert!(p.reorder_tracks(&[0, 0]).is_err());
        assert!(p.reorder_tracks(&[99]).is_err());
    }

    #[test]
    fn clips_at_returns_active_visible_only_sorted_by_order() {
        let mut p = sample_project();
        // track id=0 (order 0): clip 1s..4s
        // track id=1 (order 1): clip 2s..6s (will be hidden)
        // track id=2 is audio (order 2): clip 0..10s
        p.insert_clip(0, Clip::new(0, "v".into(), 1_000_000, 4_000_000)).unwrap();
        p.insert_clip(1, Clip::new(0, "v".into(), 2_000_000, 6_000_000)).unwrap();
        p.insert_clip(2, Clip::new(0, "a".into(), 0, 10_000_000)).unwrap();
        p.find_track_mut(1).unwrap().visible = false;

        let active = p.clips_at(3_000_000);
        // track 0 (visible) and track 2 (audio, visible). track 1 hidden.
        let track_ids: Vec<u32> = active.iter().map(|c| {
            p.tracks.iter().find(|t| t.clips.iter().any(|x| x.id == c.id)).unwrap().id
        }).collect();
        assert_eq!(track_ids, vec![0, 2]);
    }

    #[test]
    fn compute_duration_tracks_max_end() {
        let mut p = sample_project();
        p.insert_clip(0, Clip::new(0, "m".into(), 0, 1_000_000)).unwrap();
        let long_id = p.insert_clip(1, Clip::new(0, "m".into(), 0, 7_500_000)).unwrap();
        assert_eq!(p.compute_duration(), 7_500_000);
        p.remove_clip(1, long_id);
        assert_eq!(p.compute_duration(), 1_000_000);
    }

    #[test]
    fn clip_is_default_true_for_fresh_clip() {
        let c = Clip::new(1, "m".into(), 0, 1_000_000);
        assert!(c.is_default());
    }
}
