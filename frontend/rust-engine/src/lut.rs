// .cube LUT parser + trilinear interpolation
//
// LUT_3D_SIZE is fixed at 33 (the dominant format). The table stores
// 33×33×33×3 = 107,811 f32 values (≈422 KB).

use std::collections::HashMap;

const LUT_SIZE: usize = 33;

#[derive(Clone)]
pub struct Lut3D {
    /// 33×33×33×3 floats, stored as [r0, g0, b0, r1, g1, b1, ...]
    data: Vec<f32>,
}

impl Lut3D {
    /// Parse a .cube file from raw bytes. Returns None on any parse error.
    pub fn from_cube(bytes: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(bytes).ok()?;
        let mut size: Option<usize> = None;
        let mut table_lines: Vec<&str> = Vec::new();

        for line in text.lines() {
            let line = line.trim();
            // Skip comments and empty lines
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            let lower = line.to_lowercase();
            if lower.starts_with("title") || lower.starts_with("domain_min") || lower.starts_with("domain_max") {
                continue;
            }

            if lower.starts_with("lut_3d_size") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                size = parts.get(1).and_then(|s| s.parse().ok());
                continue;
            }

            // Data line: three space-separated floats
            table_lines.push(line);
        }

        let expected_size = size.unwrap_or(LUT_SIZE);
        let expected_entries = expected_size * expected_size * expected_size;
        if table_lines.len() < expected_entries {
            return None;
        }

        let mut data = Vec::with_capacity(expected_entries * 3);
        for line in &table_lines[..expected_entries] {
            let vals: Vec<f32> = line
                .split_whitespace()
                .filter_map(|s| s.parse().ok())
                .collect();
            if vals.len() < 3 {
                return None;
            }
            data.push(vals[0]);
            data.push(vals[1]);
            data.push(vals[2]);
        }

        Some(Self { data })
    }

    /// Sample the 3D LUT at normalised coordinates (r, g, b) ∈ [0, 1].
    /// Uses trilinear interpolation. Values outside [0, 1] are clamped.
    #[inline]
    pub fn sample(&self, r: f32, g: f32, b: f32) -> [f32; 3] {
        let r = r.clamp(0.0, 1.0);
        let g = g.clamp(0.0, 1.0);
        let b = b.clamp(0.0, 1.0);

        let max_idx = (LUT_SIZE - 1) as f32;
        let r_idx = r * max_idx;
        let g_idx = g * max_idx;
        let b_idx = b * max_idx;

        let r0 = (r_idx.floor() as usize).min(LUT_SIZE - 1);
        let r1 = (r0 + 1).min(LUT_SIZE - 1);
        let g0 = (g_idx.floor() as usize).min(LUT_SIZE - 1);
        let g1 = (g0 + 1).min(LUT_SIZE - 1);
        let b0 = (b_idx.floor() as usize).min(LUT_SIZE - 1);
        let b1 = (b0 + 1).min(LUT_SIZE - 1);

        let dr = r_idx - r0 as f32;
        let dg = g_idx - g0 as f32;
        let db = b_idx - b0 as f32;

        let c000 = self.get(r0, g0, b0);
        let c001 = self.get(r0, g0, b1);
        let c010 = self.get(r0, g1, b0);
        let c011 = self.get(r0, g1, b1);
        let c100 = self.get(r1, g0, b0);
        let c101 = self.get(r1, g0, b1);
        let c110 = self.get(r1, g1, b0);
        let c111 = self.get(r1, g1, b1);

        // Trilinear interpolation
        let c00 = lerp3(&c000, &c100, dr);
        let c01 = lerp3(&c001, &c101, dr);
        let c10 = lerp3(&c010, &c110, dr);
        let c11 = lerp3(&c011, &c111, dr);

        let c0 = lerp3(&c00, &c10, dg);
        let c1 = lerp3(&c01, &c11, dg);

        lerp3(&c0, &c1, db)
    }

    #[inline]
    fn get(&self, r: usize, g: usize, b: usize) -> [f32; 3] {
        let idx = (r * LUT_SIZE * LUT_SIZE + g * LUT_SIZE + b) * 3;
        [self.data[idx], self.data[idx + 1], self.data[idx + 2]]
    }
}

#[inline]
fn lerp3(a: &[f32; 3], b: &[f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/// Storage for loaded 3D LUTs, keyed by user-assigned id.
pub struct LutCache {
    luts: HashMap<u32, Lut3D>,
}

impl LutCache {
    pub fn new() -> Self {
        Self { luts: HashMap::new() }
    }

    pub fn load(&mut self, id: u32, bytes: &[u8]) -> bool {
        match Lut3D::from_cube(bytes) {
            Some(lut) => {
                self.luts.insert(id, lut);
                true
            }
            None => false,
        }
    }

    pub fn get(&self, id: u32) -> Option<&Lut3D> {
        self.luts.get(&id)
    }

    pub fn count(&self) -> u32 {
        self.luts.len() as u32
    }
}
