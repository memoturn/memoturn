"""Prompt fetch + compile."""
from __future__ import annotations

import base64
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from typing import Any, Optional

_VAR = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")

#: Default freshness window for a fetched prompt, in seconds.
DEFAULT_CACHE_TTL = 60.0

#: Bounded so an A/B split keyed by user id can't grow the cache without limit — entries are
#: per (public key, base url, name, channel, bucket_key). Evicts oldest-inserted first; dicts
#: preserve insertion order, and re-inserting on refresh moves an entry to the newest position.
_MAX_CACHE_ENTRIES = 500

# key -> (prompt, expires_at). Guarded by a lock: the SDK is used from threaded servers.
_cache: dict[str, tuple[dict[str, Any], float]] = {}
_cache_lock = threading.Lock()


def clear_prompt_cache() -> None:
    """Drop all cached prompts. For tests, and for forcing a redeploy to take effect now."""
    with _cache_lock:
        _cache.clear()


def _cache_get(key: str) -> Optional[tuple[dict[str, Any], float]]:
    with _cache_lock:
        return _cache.get(key)


def _cache_set(key: str, prompt: dict[str, Any], expires_at: float) -> None:
    with _cache_lock:
        _cache.pop(key, None)  # re-insert so this entry becomes the newest for eviction ordering
        _cache[key] = (prompt, expires_at)
        while len(_cache) > _MAX_CACHE_ENTRIES:
            _cache.pop(next(iter(_cache)))


def get_prompt(name: str, channel: str = "production", *, bucket_key: Optional[str] = None,
               base_url: Optional[str] = None, public_key: Optional[str] = None,
               secret_key: Optional[str] = None, timeout: float = 10.0,
               cache_ttl: float = DEFAULT_CACHE_TTL,
               fallback: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Fetch a deployed prompt. If the channel runs an A/B split, pass ``bucket_key`` (a stable
    session/user id) to stick this caller to one arm; the returned ``version`` is what you stamp
    on the resulting generation.

    Prompt resolution sits on the calling app's request path, so this is cached and degrades
    rather than failing:

    * **Fresh hit** (within ``cache_ttl`` seconds, default 60; ``0`` disables caching): returned
      from memory with no network call.
    * **Fetch failure with something cached**: the stale value is returned. A memoturn outage
      must not take down the app that depends on it.
    * **Fetch failure with nothing cached**: ``fallback`` if given, otherwise the error is raised.

    Note a deliberate difference from the TypeScript SDK, which refreshes a stale prompt in the
    background and serves the stale value immediately (stale-while-revalidate). This SDK holds no
    background threads by design, so an expired entry is refreshed synchronously — one blocking
    fetch per TTL window per prompt — rather than spawning a thread from library code.

    The cache is per-process and in-memory, so it is per-invocation-safe on serverless: a cold
    start simply begins empty and fetches.
    """
    base = (base_url or os.environ.get("MEMOTURN_BASE_URL", "http://localhost:3001")).rstrip("/")
    pk = public_key or os.environ.get("MEMOTURN_PUBLIC_KEY", "")
    sk = secret_key or os.environ.get("MEMOTURN_SECRET_KEY", "")
    auth = base64.b64encode(f"{pk}:{sk}".encode()).decode()
    params = {"channel": channel}
    if bucket_key:
        params["bucketKey"] = bucket_key
    query = urllib.parse.urlencode(params)
    url = f"{base}/v1/prompts/{urllib.parse.quote(name)}?{query}"
    # The public key is part of the key so two clients pointed at different projects — or the
    # same project with rotated creds — never read each other's entries.
    key = f"{pk} {url}"

    cached = _cache_get(key) if cache_ttl > 0 else None
    if cached is not None and cached[1] > time.monotonic():
        return cached[0]

    req = urllib.request.Request(url, headers={"authorization": f"Basic {auth}"})
    try:
        prompt = json.loads(urllib.request.urlopen(req, timeout=timeout).read())
    except Exception:
        # Stale beats broken: keep serving what we have, and only then consider the fallback.
        if cached is not None:
            return cached[0]
        if fallback is not None:
            return fallback
        raise
    if cache_ttl > 0:
        _cache_set(key, prompt, time.monotonic() + cache_ttl)
    return prompt


def compile_prompt(prompt: dict[str, Any], **variables: Any) -> Any:
    """Substitute {{var}} placeholders. Works for TEXT (str) and CHAT (message list)."""
    def fill(text: str) -> str:
        return _VAR.sub(lambda m: str(variables[m.group(1)]) if m.group(1) in variables else m.group(0), text)

    content = prompt.get("content")
    if prompt.get("type") == "CHAT" and isinstance(content, list):
        return [{**m, "content": fill(str(m.get("content", "")))} for m in content]
    return fill(str(content or ""))
