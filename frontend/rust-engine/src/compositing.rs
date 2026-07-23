use crate::lut::LutCache;
use crate::timeline_state;
use crate::timeline_state::{EffectParams, EffectType};
use crate::FramePool;
use std::collections::HashMap;

/// Composite all active clips at `ts_us` into `composite_pool`.
///
/// Iterates visible, non-muted video tracks sorted by `order` ascending
/// (bottom → top). For each active clip:
///   1. Clone the cached raw frame into `temp_pool`
///   2. Apply per-clip colour grade in-place on `temp_pool`
///   3. Alpha-composite onto `composite_pool` (first layer is a direct copy)
pub fn compose_at(
    project: &timeline_state::Project,
    ts_us: i64,
    frame_cache: &HashMap<u32, (u32, u32, Vec<u8>)>,
    temp_pool: &mut FramePool,
    composite_pool: &mut FramePool,
    luts: &LutCache,
) {
    let active = project.clips_at(ts_us);

    composite_pool.clear();

    let mut is_first = true;

    for clip in active {
        let track = match project.find_track_by_clip(clip.id) {
            Some(t) => t,
            None => continue,
        };
        if track.track_type != timeline_state::TrackType::Video {
            continue;
        }

        let (_fw, _fh, raw_data) = match frame_cache.get(&clip.id) {
            Some(f) => f,
            None => continue,
        };

        // Clone raw frame into temp pool for in-place grading
        let frame_bytes = raw_data.len().min(temp_pool.len());
        temp_pool.buf_mut()[..frame_bytes].copy_from_slice(&raw_data[..frame_bytes]);

        // Per-clip colour grade
        apply_clip_colour_grade(temp_pool, &clip.colour_settings);

        // Apply LUT effects (after grade, before blend)
        for effect in &clip.effects {
            if !effect.enabled {
                continue;
            }
            if effect.effect_type == EffectType::LUT {
                if let EffectParams::LUT { lut_id, intensity } = &effect.params {
                    apply_lut_effect(temp_pool, luts, *lut_id, *intensity);
                }
            }
        }

        if is_first {
            // First layer: copy directly to composite
            let bytes = composite_pool.len().min(temp_pool.len());
            composite_pool.buf_mut()[..bytes].copy_from_slice(&temp_pool.buf()[..bytes]);
            is_first = false;
        } else {
            // Subsequent layers: alpha-blend on top
            alpha_blend_overlay(
                composite_pool.width as usize,
                composite_pool.height as usize,
                composite_pool.buf_mut(),
                &temp_pool.buf(),
                temp_pool.width as usize,
                temp_pool.height as usize,
                &clip.transform,
            );
        }
    }
}

/// Alpha-blend `src` onto `dst` using Porter-Duff "over" with opacity.
///
/// Simple centre-fit: source is centred on destination, scaled uniformly
/// to fit maintaining aspect ratio. Nearest-neighbour sampling.
///
/// Formula (straight alpha):
///   out.rgb = src.rgb * α  +  dst.rgb * (1 - α)
///   out.a   = src.a   +  dst.a  * (1 - src.a)
/// where α = src.a * clip.opacity (WebCodecs frames have α = 1.0).
fn alpha_blend_overlay(
    dst_w: usize,
    dst_h: usize,
    dst_buf: &mut [u8],
    src_buf: &[u8],
    src_w: usize,
    src_h: usize,
    transform: &timeline_state::ClipTransform,
) {
    let opacity = transform.opacity.clamp(0.0, 1.0);
    if opacity <= 0.001 {
        return;
    }

    let inv_255 = 1.0 / 255.0;

    // Centre-fit scaling (full 2D affine transforms deferred to Task 6)
    let scale_w = src_w as f32 / dst_w as f32;
    let scale_h = src_h as f32 / dst_h as f32;
    let scale = scale_w.max(scale_h); // cover (dst is base layer sized to project)

    // For "fit" behaviour: use w/h dimensions that maintain aspect ratio
    let draw_w = (src_w as f32 / scale) as usize;
    let draw_h = (src_h as f32 / scale) as usize;
    let ox = (dst_w.saturating_sub(draw_w)) / 2;
    let oy = (dst_h.saturating_sub(draw_h)) / 2;

    // Apply position offset from ClipTransform (normalised -1..1)
    let pos_x = (((transform.x + 1.0) * 0.5) * dst_w as f32) as isize;
    let pos_y = (((1.0 - transform.y) * 0.5) * dst_h as f32) as isize;
    let ox = (ox as isize + pos_x - (dst_w / 2) as isize) as isize;
    let oy = (oy as isize + pos_y - (dst_h / 2) as isize) as isize;

    for dy in 0..draw_h {
        let dst_y = oy + dy as isize;
        if dst_y < 0 || dst_y as usize >= dst_h {
            continue;
        }

        let sy = ((dy as f32) * scale) as usize;
        if sy >= src_h {
            continue;
        }

        let src_row = sy * src_w * 4;
        let dst_row = (dst_y as usize) * dst_w * 4;

        for dx in 0..draw_w {
            let dst_x = ox + dx as isize;
            if dst_x < 0 || dst_x as usize >= dst_w {
                continue;
            }

            let sx = ((dx as f32) * scale) as usize;
            if sx >= src_w {
                continue;
            }

            let si = src_row + sx * 4;
            let di = dst_row + (dst_x as usize) * 4;

            let a = opacity; // source alpha assumed 1.0

            for c in 0..3 {
                let src_px = src_buf[si + c] as f32 * inv_255;
                let dst_px = dst_buf[di + c] as f32 * inv_255;
                let out = src_px * a + dst_px * (1.0 - a);
                dst_buf[di + c] = (out * 255.0).clamp(0.0, 255.0) as u8;
            }
            let src_a = a;
            let dst_a = dst_buf[di + 3] as f32 * inv_255;
            let out_a = src_a + dst_a * (1.0 - src_a);
            dst_buf[di + 3] = (out_a * 255.0).clamp(0.0, 255.0) as u8;
        }
    }
}

/// Apply per-clip colour grade using the canonical `ColourSettings`.
///
/// Pipeline: exposure → temperature → tint → lift → gamma → gain →
/// highlights/shadows → contrast → saturation → clamp.
/// Vignette/grain live in Effect now (deferred to effect pipeline).
pub fn apply_clip_colour_grade(pool: &mut FramePool, settings: &timeline_state::ColourSettings) {
    let w = pool.width;
    let h = pool.height;

    let exposure_mul = (2.0_f32).powf(settings.exposure);
    let contrast_pivot = 0.5_f32;
    let contrast_scale = 1.0 + settings.contrast * 1.5;
    let temp_r = 1.0 + settings.temperature * 0.15;
    let temp_b = 1.0 - settings.temperature * 0.15;
    let hi = settings.highlights;
    let sh = settings.shadows;
    let sat = 1.0 + settings.saturation;
    let inv_255 = 1.0 / 255.0;

    let tint_r = 1.0 + settings.tint * 0.1;
    let tint_g = 1.0 - settings.tint * 0.1;
    let tint_b = 1.0 - settings.tint * 0.1;

    let gamma_r = 1.0 / (1.0 + settings.gamma[0] * 0.5).max(0.01);
    let gamma_g = 1.0 / (1.0 + settings.gamma[1] * 0.5).max(0.01);
    let gamma_b = 1.0 / (1.0 + settings.gamma[2] * 0.5).max(0.01);

    for y in 0..h {
        let row_base = (y * w * 4) as usize;
        for x in 0..w {
            let base = row_base + (x * 4) as usize;

            let mut r = pool.buf[base] as f32 * inv_255;
            let mut g = pool.buf[base + 1] as f32 * inv_255;
            let mut b = pool.buf[base + 2] as f32 * inv_255;

            r *= exposure_mul;
            g *= exposure_mul;
            b *= exposure_mul;

            r *= temp_r;
            b *= temp_b;

            r *= tint_r;
            g *= tint_g;
            b *= tint_b;

            r += settings.lift[0] * 0.3;
            g += settings.lift[1] * 0.3;
            b += settings.lift[2] * 0.3;

            r = r.powf(gamma_r);
            g = g.powf(gamma_g);
            b = b.powf(gamma_b);

            r *= 1.0 + settings.gain[0] * 0.5;
            g *= 1.0 + settings.gain[1] * 0.5;
            b *= 1.0 + settings.gain[2] * 0.5;

            let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

            let hi_mask = smooth_step_01(0.5, 1.0, luma);
            let sh_mask = smooth_step_01(0.5, 0.0, luma);
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

            pool.buf[base] = clamp_u8(r);
            pool.buf[base + 1] = clamp_u8(g);
            pool.buf[base + 2] = clamp_u8(b);
        }
    }
}

/// Apply a cached 3D LUT with intensity blending (0 = passthrough, 1 = full LUT).
pub fn apply_lut_effect(pool: &mut FramePool, luts: &LutCache, lut_id: u32, intensity: f32) {
    let lut = match luts.get(lut_id) {
        Some(l) => l,
        None => return,
    };
    if intensity <= 0.001 {
        return;
    }
    let inv_255 = 1.0 / 255.0;
    let intensity = intensity.clamp(0.0, 1.0);
    let w = pool.width;
    let h = pool.height;
    for y in 0..h {
        let row_base = (y * w * 4) as usize;
        for x in 0..w {
            let base = row_base + (x * 4) as usize;
            let r = pool.buf[base] as f32 * inv_255;
            let g = pool.buf[base + 1] as f32 * inv_255;
            let b = pool.buf[base + 2] as f32 * inv_255;
            let [lr, lg, lb] = lut.sample(r, g, b);
            pool.buf[base] = clamp_u8(r + (lr - r) * intensity);
            pool.buf[base + 1] = clamp_u8(g + (lg - g) * intensity);
            pool.buf[base + 2] = clamp_u8(b + (lb - b) * intensity);
        }
    }
}

#[inline(always)]
fn smooth_step_01(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline(always)]
fn clamp_u8(v: f32) -> u8 {
    (v * 255.0).clamp(0.0, 255.0) as u8
}
