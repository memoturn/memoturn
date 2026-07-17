"""Runtime guardrails: scan text for PII, prompt injection, and blocked terms.

Stdlib-only (urllib). Mirrors the JS SDK's ``checkGuardrails``. Call before sending
user content to an LLM, or before returning a model's output.
"""
from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from typing import Any, Optional

from .client import _truncate


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
