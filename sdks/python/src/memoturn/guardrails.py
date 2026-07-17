"""Runtime guardrails: scan text for PII, prompt injection, and blocked terms.

Stdlib-only (urllib). Call before sending user content to an LLM, or before
returning a model's output, and act on the returned verdict.
"""
from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable, Optional, TypeVar, Union

from .client import _truncate, logger

T = TypeVar("T")


def _creds(base_url: Optional[str], public_key: Optional[str], secret_key: Optional[str]) -> tuple[str, str]:
    base = (base_url or os.environ.get("MEMOTURN_BASE_URL", "http://localhost:3001")).rstrip("/")
    pk = public_key or os.environ.get("MEMOTURN_PUBLIC_KEY", "")
    sk = secret_key or os.environ.get("MEMOTURN_SECRET_KEY", "")
    auth = base64.b64encode(f"{pk}:{sk}".encode()).decode()
    return base, auth


def check_guardrails(
    text: str,
    *,
    base_url: Optional[str] = None,
    public_key: Optional[str] = None,
    secret_key: Optional[str] = None,
    timeout: float = 10.0,
) -> dict[str, Any]:
    """Scan ``text`` against the project's runtime guardrails.

    Returns a dict ``{"verdict": "allow"|"redact"|"block", "findings": [...],
    "redactedText"?: str}``.
    """
    base, auth = _creds(base_url, public_key, secret_key)
    body = json.dumps({"text": text}).encode()
    headers = {"authorization": f"Basic {auth}", "content-type": "application/json"}
    req = urllib.request.Request(f"{base}/v1/guardrails/check", data=body, headers=headers, method="POST")
    try:
        return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"guardrails check failed: {e.code} {_truncate(e.read().decode(errors='replace'))}") from e


class GuardrailBlockedError(RuntimeError):
    """Raised by :func:`run_guarded` when a guardrail verdict is ``"block"`` and
    ``on_failure="raise"`` (the default)."""

    def __init__(self, verdict: dict[str, Any]) -> None:
        self.verdict = verdict
        types = ", ".join(f.get("type", "") for f in verdict.get("findings", []))
        super().__init__(f"memoturn: content blocked by guardrails ({types})")


def run_guarded(
    fn: Callable[[], T],
    *,
    extract_text: Callable[[T], str] = str,
    on_failure: Union[str, Callable[[dict[str, Any]], T]] = "raise",
    **creds: Any,
) -> T:
    """Run ``fn``, scan its result with :func:`check_guardrails`, and apply
    ``on_failure`` semantics on a ``"block"`` verdict.

    ``on_failure``:
      - ``"raise"`` (default) — raise :class:`GuardrailBlockedError`.
      - ``"log"`` — log a warning and return the original result unmodified.
      - a callable — called with the verdict dict; its return value is returned instead
        (a fallback response).

    ``"allow"``/``"redact"`` verdicts always return the original result unmodified — call
    :func:`check_guardrails` directly if you need the redacted text.

    Compose two calls to guard input and output separately::

        safe_input = run_guarded(lambda: user_input)
        answer = run_guarded(lambda: call_model(safe_input))
    """
    result = fn()
    text = extract_text(result)
    verdict = check_guardrails(text, **creds)
    if verdict.get("verdict") != "block":
        return result

    # `on_failure` defaults to "raise" deliberately — unlike this SDK's `mask` hook
    # (which swallows errors by default to protect ingestion, a side-channel, from
    # breaking), guardrails exist specifically to block unsafe content, so a silent
    # default here would defeat the feature.
    if on_failure == "raise":
        raise GuardrailBlockedError(verdict)
    if on_failure == "log":
        types = ", ".join(f.get("type", "") for f in verdict.get("findings", []))
        logger.warning("memoturn: guardrails blocked content (%s) — on_failure='log', returning original", types)
        return result
    return on_failure(verdict)
