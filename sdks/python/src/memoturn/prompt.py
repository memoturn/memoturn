"""Prompt fetch + compile."""
from __future__ import annotations

import base64
import json
import os
import re
import urllib.request
from typing import Any, Optional

_VAR = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")


def get_prompt(name: str, channel: str = "production", *, base_url: Optional[str] = None,
               public_key: Optional[str] = None, secret_key: Optional[str] = None) -> dict[str, Any]:
    base = (base_url or os.environ.get("MEMOTURN_BASE_URL", "http://localhost:3001")).rstrip("/")
    pk = public_key or os.environ.get("MEMOTURN_PUBLIC_KEY", "")
    sk = secret_key or os.environ.get("MEMOTURN_SECRET_KEY", "")
    auth = base64.b64encode(f"{pk}:{sk}".encode()).decode()
    req = urllib.request.Request(
        f"{base}/v1/prompts/{name}?channel={channel}", headers={"authorization": f"Basic {auth}"}
    )
    return json.loads(urllib.request.urlopen(req, timeout=10).read())


def compile_prompt(prompt: dict[str, Any], **variables: Any) -> Any:
    """Substitute {{var}} placeholders. Works for TEXT (str) and CHAT (message list)."""
    def fill(text: str) -> str:
        return _VAR.sub(lambda m: str(variables[m.group(1)]) if m.group(1) in variables else m.group(0), text)

    content = prompt.get("content")
    if prompt.get("type") == "CHAT" and isinstance(content, list):
        return [{**m, "content": fill(str(m.get("content", "")))} for m in content]
    return fill(str(content or ""))
