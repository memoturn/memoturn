"""check_guardrails: request shape, verdict passthrough, and HTTP error handling."""
from __future__ import annotations

import io
import urllib.error

import pytest
from conftest import Capture

from memoturn import check_guardrails

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y")


def _http_error_with_body(code: int, body: bytes) -> urllib.error.HTTPError:
    # conftest.http_error passes fp=None, but check_guardrails reads e.read() —
    # build the error with a real file object so read() returns the body.
    return urllib.error.HTTPError("http://api.test", code, "err", {}, io.BytesIO(body))  # type: ignore[arg-type]


def test_request_url_auth_and_body(capture: Capture) -> None:
    capture.responder = lambda _req: {"verdict": "allow", "findings": []}
    check_guardrails("hello world", **CREDS)

    assert capture.last.get_method() == "POST"
    assert capture.last.full_url == "http://api.test/v1/guardrails/check"
    assert capture.basic_auth() == "pk-mt-x:sk-mt-y"
    assert capture.headers()["content-type"] == "application/json"
    assert capture.body() == {"text": "hello world"}


def test_verdict_passthrough(capture: Capture) -> None:
    result = {
        "verdict": "redact",
        "findings": [{"type": "PII", "match": "a@b.com"}],
        "redactedText": "email [REDACTED]",
    }
    capture.responder = lambda _req: result
    assert check_guardrails("email a@b.com", **CREDS) == result


def test_http_error_raises_runtime_error_with_truncated_body(capture: Capture) -> None:
    capture.error = _http_error_with_body(400, b"x" * 300)

    with pytest.raises(RuntimeError, match="guardrails check failed: 400") as exc:
        check_guardrails("hi", **CREDS)

    msg = str(exc.value)
    assert "x" * 200 + "…" in msg  # body truncated at 200 chars
    assert "x" * 201 not in msg
