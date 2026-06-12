//! The vector channel, phase 1: flat scan with cosine distance — at profile
//! scale (10³–10⁵ vectors) this is the correct engine, not a stopgap
//! (09 § vectors, crossover arithmetic). Ground truth is always the VEC keys;
//! the phase-2 derived HNSW is crossover-gated and not built.

/// Cosine *distance* (1 - similarity), matching `vector_distance_cos` order.
pub fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    // Chunked so the autovectorizer has straight-line FMA work.
    let mut i = 0;
    while i + 8 <= a.len() {
        for j in 0..8 {
            let x = a[i + j];
            let y = b[i + j];
            dot += x * y;
            na += x * x;
            nb += y * y;
        }
        i += 8;
    }
    while i < a.len() {
        let x = a[i];
        let y = b[i];
        dot += x * y;
        na += x * x;
        nb += y * y;
        i += 1;
    }
    let denom = (na.sqrt() * nb.sqrt()).max(f32::EPSILON);
    1.0 - dot / denom
}

/// Cosine distance against a VEC value in its stored form (packed f32 LE) —
/// the flat scan reads segment bytes directly, no per-vector allocation.
pub fn cosine_distance_le_bytes(query: &[f32], stored: &[u8]) -> f32 {
    debug_assert_eq!(stored.len(), query.len() * 4);
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for (x, c) in query.iter().zip(stored.chunks_exact(4)) {
        let y = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = (na.sqrt() * nb.sqrt()).max(f32::EPSILON);
    1.0 - dot / denom
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_form_matches_decoded_form() {
        let q: Vec<f32> = (0..256).map(|i| (i as f32).cos()).collect();
        let s: Vec<f32> = (0..256).map(|i| (i as f32 * 0.7).sin()).collect();
        let bytes: Vec<u8> = s.iter().flat_map(|v| v.to_le_bytes()).collect();
        let a = cosine_distance(&q, &s);
        let b = cosine_distance_le_bytes(&q, &bytes);
        assert!((a - b).abs() < 1e-6, "{a} vs {b}");
    }

    #[test]
    fn distance_orders_by_similarity() {
        let q = [1.0f32, 0.0, 0.0];
        let same = [2.0f32, 0.0, 0.0];
        let near = [1.0f32, 0.2, 0.0];
        let orth = [0.0f32, 1.0, 0.0];
        let d_same = cosine_distance(&q, &same);
        let d_near = cosine_distance(&q, &near);
        let d_orth = cosine_distance(&q, &orth);
        assert!(d_same < 1e-6);
        assert!(d_same < d_near && d_near < d_orth);
        assert!((d_orth - 1.0).abs() < 1e-6);
    }

    #[test]
    fn long_vectors_hit_the_chunked_path() {
        let a: Vec<f32> = (0..256).map(|i| (i as f32).sin()).collect();
        let d = cosine_distance(&a, &a);
        assert!(d.abs() < 1e-5);
    }
}
