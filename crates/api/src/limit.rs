//! Request-surface limits: a coarse global token-bucket rate limiter for the
//! credential-bearing control endpoints (`/v1/databases*`, `/v1/namespaces*`).
//!
//! This blunts platform-key brute-force and token-mint floods. It is a *global*
//! limiter (one budget shared across all control requests), not per-IP — keying
//! by source address belongs at the ingress/proxy, which also terminates TLS.
//! Body limits, request timeout, concurrency cap, and CORS are stock
//! `axum`/`tower-http` layers wired in [`crate::router`].

use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

#[derive(Debug)]
struct Bucket {
    tokens: f64,
    capacity: f64,
    refill_per_sec: f64,
    last: Instant,
}

impl Bucket {
    /// Try to spend one token, refilling for elapsed time first. Returns false
    /// when the bucket is empty (caller should reject with 429).
    fn try_take(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// A cloneable handle to a shared rate-limit budget. Cloning shares the budget,
/// so the same limiter can be layered onto several routes.
#[derive(Clone)]
pub struct RateLimit {
    bucket: Arc<Mutex<Bucket>>,
}

impl RateLimit {
    /// `refill_per_sec` sustained rate with a `capacity`-sized burst allowance.
    pub fn new(refill_per_sec: f64, capacity: f64) -> Self {
        Self {
            bucket: Arc::new(Mutex::new(Bucket {
                tokens: capacity,
                capacity,
                refill_per_sec,
                last: Instant::now(),
            })),
        }
    }

    /// Read the control-plane limit from the environment, defaulting to 10 req/s
    /// sustained with a burst of 20. `MEMOTURN_CONTROL_RATE` overrides the rate.
    pub fn control_from_env() -> Self {
        let rate = std::env::var("MEMOTURN_CONTROL_RATE")
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|r| *r > 0.0)
            .unwrap_or(10.0);
        Self::new(rate, (rate * 2.0).max(1.0))
    }

    fn allow(&self) -> bool {
        self.bucket
            .lock()
            .map(|mut b| b.try_take(Instant::now()))
            // A poisoned lock means a panic crossed the critical section; fail
            // open rather than wedge the control plane.
            .unwrap_or(true)
    }
}

/// Middleware: reject with 429 when the shared budget is exhausted.
pub async fn enforce(limiter: RateLimit, req: Request, next: Next) -> Response {
    if limiter.allow() {
        next.run(req).await
    } else {
        (
            StatusCode::TOO_MANY_REQUESTS,
            axum::Json(serde_json::json!({ "error": "rate limit exceeded" })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_drains_then_refills() {
        let mut b = Bucket {
            tokens: 2.0,
            capacity: 2.0,
            refill_per_sec: 1.0,
            last: Instant::now(),
        };
        let t0 = b.last;
        assert!(b.try_take(t0));
        assert!(b.try_take(t0));
        assert!(!b.try_take(t0), "empty after two takes");
        // One second later, one token has refilled.
        let t1 = t0 + std::time::Duration::from_secs(1);
        assert!(b.try_take(t1));
        assert!(!b.try_take(t1));
    }

    #[test]
    fn refill_caps_at_capacity() {
        let mut b = Bucket {
            tokens: 0.0,
            capacity: 3.0,
            refill_per_sec: 100.0,
            last: Instant::now(),
        };
        let far = b.last + std::time::Duration::from_secs(10);
        // Even after a long idle, only `capacity` tokens are available.
        assert!(b.try_take(far));
        assert!(b.try_take(far));
        assert!(b.try_take(far));
        assert!(!b.try_take(far));
    }
}
