//! Error envelope for every API response: `{ "error": <message>, "code": <code> }`.
//!
//! `error` stays a bare human-readable string (clients have always parsed it
//! that way); `code` is the machine-readable sibling clients branch on. Codes
//! are a small, stable set — add one only when a client can act differently
//! on it. Two responses bypass this envelope entirely (tower middleware
//! defaults): 408 from the request timeout and 413 from the body limit;
//! clients fall back to the status code for those.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use serde_json::json;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unauthorized,
    Forbidden,
    NotFound,
    DatabaseNotFound,
    BranchNotFound,
    AlreadyExists,
    Conflict,
    InvalidRequest,
    PayloadTooLarge,
    RequestTimeout,
    Overloaded,
    /// An AI opt-in (extraction / answer synthesis / embedding) is not
    /// configured on this node — fall back to the bring-your-own path.
    Unconfigured,
    Unavailable,
    Internal,
}

impl ErrorCode {
    /// The generic code for a status; call sites override with
    /// [`ApiError::with_code`] only where a more specific code exists.
    pub fn default_for(status: StatusCode) -> Self {
        match status {
            StatusCode::BAD_REQUEST => Self::InvalidRequest,
            StatusCode::UNAUTHORIZED => Self::Unauthorized,
            StatusCode::FORBIDDEN => Self::Forbidden,
            StatusCode::NOT_FOUND => Self::NotFound,
            StatusCode::REQUEST_TIMEOUT => Self::RequestTimeout,
            StatusCode::CONFLICT => Self::Conflict,
            StatusCode::PAYLOAD_TOO_LARGE => Self::PayloadTooLarge,
            StatusCode::TOO_MANY_REQUESTS => Self::Overloaded,
            StatusCode::SERVICE_UNAVAILABLE => Self::Unavailable,
            _ => Self::Internal,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::DatabaseNotFound => "database_not_found",
            Self::BranchNotFound => "branch_not_found",
            Self::AlreadyExists => "already_exists",
            Self::Conflict => "conflict",
            Self::InvalidRequest => "invalid_request",
            Self::PayloadTooLarge => "payload_too_large",
            Self::RequestTimeout => "request_timeout",
            Self::Overloaded => "overloaded",
            Self::Unconfigured => "unconfigured",
            Self::Unavailable => "unavailable",
            Self::Internal => "internal",
        }
    }
}

pub struct ApiError {
    status: StatusCode,
    code: ErrorCode,
    msg: String,
}

impl ApiError {
    pub fn new(status: StatusCode, msg: impl Into<String>) -> Self {
        Self {
            status,
            code: ErrorCode::default_for(status),
            msg: msg.into(),
        }
    }

    pub fn with_code(mut self, code: ErrorCode) -> Self {
        self.code = code;
        self
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = json!({ "error": self.msg, "code": self.code });
        let mut resp = (self.status, Json(body)).into_response();
        // Backpressure rejections (per-DB write-queue shed, control rate
        // limit) tell well-behaved clients when to come back.
        if self.status == StatusCode::TOO_MANY_REQUESTS {
            resp.headers_mut()
                .insert("Retry-After", axum::http::HeaderValue::from_static("1"));
        }
        resp
    }
}
