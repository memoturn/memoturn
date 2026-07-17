"""check_guardrails: request shape, verdict passthrough, and HTTP error handling.
Also covers run_guarded's on_failure modes (raise/log/callable-fallback)."""
from __future__ import annotations

import io
import logging
import urllib.error

import pytest
from conftest import Capture

from memoturn import GuardrailBlockedError, check_guardrails, run_guarded

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y")

BLOCK_VERDICT = {"verdict": "block", "findings": [{"type": "PII"}, {"type": "PROMPT_INJECTION"}]}


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


# ── run_guarded ───────────────────────────────────────────────────────────────────


def test_run_guarded_raises_by_default_on_block(capture: Capture) -> None:
    capture.responder = lambda _req: BLOCK_VERDICT
    with pytest.raises(GuardrailBlockedError) as exc:
        run_guarded(lambda: "unsafe text", **CREDS)
    assert exc.value.verdict == BLOCK_VERDICT
    assert "PII" in str(exc.value)
    assert "PROMPT_INJECTION" in str(exc.value)


def test_run_guarded_log_mode_returns_original_result(capture: Capture, caplog: pytest.LogCaptureFixture) -> None:
    capture.responder = lambda _req: BLOCK_VERDICT
    with caplog.at_level(logging.WARNING, logger="memoturn"):
        result = run_guarded(lambda: "unsafe text", on_failure="log", **CREDS)
    assert result == "unsafe text"
    assert any("blocked" in r.getMessage().lower() for r in caplog.records)


def test_run_guarded_callable_fallback_receives_verdict(capture: Capture) -> None:
    capture.responder = lambda _req: BLOCK_VERDICT
    received = {}

    def fallback(verdict: dict) -> str:
        received["verdict"] = verdict
        return "safe fallback"

    result = run_guarded(lambda: "unsafe text", on_failure=fallback, **CREDS)
    assert result == "safe fallback"
    assert received["verdict"] == BLOCK_VERDICT


def test_run_guarded_allow_verdict_returns_original_unmodified(capture: Capture) -> None:
    capture.responder = lambda _req: {"verdict": "allow", "findings": []}
    assert run_guarded(lambda: "safe text", **CREDS) == "safe text"


def test_run_guarded_redact_verdict_returns_original_unmodified(capture: Capture) -> None:
    capture.responder = lambda _req: {"verdict": "redact", "findings": [], "redactedText": "e [REDACTED]"}
    assert run_guarded(lambda: "email a@b.com", **CREDS) == "email a@b.com"


def test_run_guarded_extract_text_scans_derived_text(capture: Capture) -> None:
    capture.responder = lambda _req: {"verdict": "allow", "findings": []}
    result = run_guarded(lambda: {"text": "hi"}, extract_text=lambda r: r["text"], **CREDS)
    assert result == {"text": "hi"}
    assert capture.body() == {"text": "hi"}


def test_run_guarded_composes_input_and_output_guards(capture: Capture) -> None:
    capture.responder = lambda _req: {"verdict": "allow", "findings": []}
    user_input = "hello"

    def call_model(x: str) -> str:
        return f"echo: {x}"

    safe_input = run_guarded(lambda: user_input, **CREDS)
    answer = run_guarded(lambda: call_model(safe_input), **CREDS)
    assert answer == "echo: hello"
    assert len(capture.requests) == 2
