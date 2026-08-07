"""Prompt fetch (GET + auth) and {{var}} compilation for TEXT and CHAT prompts."""
from __future__ import annotations

import urllib.error

import pytest
from conftest import Capture, http_error

from memoturn import compile_prompt, get_prompt

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y")


def test_get_prompt_url_and_auth(capture: Capture) -> None:
    payload = {"name": "greet", "version": 3, "type": "TEXT", "content": "hi", "config": {}}
    capture.responder = lambda _req: payload
    out = get_prompt("greet", **CREDS)

    assert capture.last.get_method() == "GET"
    assert capture.last.full_url == "http://api.test/v1/prompts/greet?channel=production"
    assert capture.basic_auth() == "pk-mt-x:sk-mt-y"
    assert out == payload


def test_get_prompt_custom_channel(capture: Capture) -> None:
    capture.responder = lambda _req: {"name": "p", "version": 1, "type": "TEXT", "content": "", "config": {}}
    get_prompt("p", channel="staging", **CREDS)
    assert capture.last.full_url == "http://api.test/v1/prompts/p?channel=staging"


def test_compile_text_leaves_unknown_vars() -> None:
    prompt = {"type": "TEXT", "content": "Hi {{name}}, {{missing}}"}
    assert compile_prompt(prompt, name="Ada") == "Hi Ada, {{missing}}"


def test_compile_chat_fills_each_message() -> None:
    prompt = {
        "type": "CHAT",
        "content": [
            {"role": "system", "content": "You are {{persona}}."},
            {"role": "user", "content": "Count to {{n}}."},
        ],
    }
    assert compile_prompt(prompt, persona="terse", n=3) == [
        {"role": "system", "content": "You are terse."},
        {"role": "user", "content": "Count to 3."},
    ]


def test_compile_coerces_and_trims_whitespace() -> None:
    assert compile_prompt({"type": "TEXT", "content": "n={{ count }}"}, count=42) == "n=42"


# ── Caching + outage behavior ─────────────────────────────────────────────────


def _prompt(**over: object) -> dict:
    return {"name": "greet", "version": 1, "type": "TEXT", "content": "hi", "config": {}, **over}


def test_fresh_hit_skips_the_network(capture: Capture) -> None:
    capture.responder = lambda _req: _prompt()
    get_prompt("greet", **CREDS)
    out = get_prompt("greet", **CREDS)
    assert len(capture.requests) == 1
    assert out == _prompt()


def test_cache_keyed_by_channel_and_bucket_key(capture: Capture) -> None:
    capture.responder = lambda req: _prompt(version=2 if "bucketKey=u2" in req.full_url else 1)
    a = get_prompt("greet", bucket_key="u1", **CREDS)
    b = get_prompt("greet", bucket_key="u2", **CREDS)
    get_prompt("greet", channel="staging", bucket_key="u1", **CREDS)
    assert (a["version"], b["version"]) == (1, 2)
    assert len(capture.requests) == 3  # three distinct keys, three fetches
    get_prompt("greet", bucket_key="u2", **CREDS)  # ...and each is independently cached
    assert len(capture.requests) == 3


def test_refetches_after_the_ttl_expires(capture: Capture, monkeypatch) -> None:
    import memoturn.prompt as prompt_mod

    now = [1000.0]
    monkeypatch.setattr(prompt_mod.time, "monotonic", lambda: now[0])
    versions = iter([1, 2])
    capture.responder = lambda _req: _prompt(version=next(versions))

    assert get_prompt("greet", cache_ttl=10, **CREDS)["version"] == 1
    now[0] += 20
    # Unlike the TS SDK, the refresh here is synchronous — no background thread — so the
    # caller sees the NEW version immediately rather than a stale one.
    assert get_prompt("greet", cache_ttl=10, **CREDS)["version"] == 2
    assert len(capture.requests) == 2


def test_cache_ttl_zero_disables_caching(capture: Capture) -> None:
    capture.responder = lambda _req: _prompt()
    get_prompt("greet", cache_ttl=0, **CREDS)
    get_prompt("greet", cache_ttl=0, **CREDS)
    assert len(capture.requests) == 2


def test_serves_stale_when_the_refresh_fails(capture: Capture, monkeypatch) -> None:
    import memoturn.prompt as prompt_mod

    now = [1000.0]
    monkeypatch.setattr(prompt_mod.time, "monotonic", lambda: now[0])
    capture.responder = lambda _req: _prompt(version=7)
    assert get_prompt("greet", cache_ttl=10, **CREDS)["version"] == 7

    capture.error = http_error(503, "down")
    now[0] += 20
    # A memoturn outage must not take down the app that depends on it.
    assert get_prompt("greet", cache_ttl=10, **CREDS)["version"] == 7
    assert get_prompt("greet", cache_ttl=10, **CREDS)["version"] == 7


def test_fallback_used_when_fetch_fails_with_nothing_cached(capture: Capture) -> None:
    capture.error = http_error(500, "boom")
    fallback = _prompt(content="local default")
    assert get_prompt("greet", fallback=fallback, **CREDS) == fallback


def test_raises_when_fetch_fails_with_no_cache_and_no_fallback(capture: Capture) -> None:
    capture.error = http_error(500, "boom")
    with pytest.raises(urllib.error.HTTPError):
        get_prompt("greet", **CREDS)


def test_cached_value_preferred_over_fallback(capture: Capture, monkeypatch) -> None:
    import memoturn.prompt as prompt_mod

    now = [1000.0]
    monkeypatch.setattr(prompt_mod.time, "monotonic", lambda: now[0])
    capture.responder = lambda _req: _prompt(content="from server")
    get_prompt("greet", cache_ttl=10, **CREDS)

    capture.error = http_error(503, "down")
    now[0] += 20
    out = get_prompt("greet", cache_ttl=10, fallback=_prompt(content="local default"), **CREDS)
    assert out["content"] == "from server"


def test_cache_is_bounded(capture: Capture) -> None:
    import memoturn.prompt as prompt_mod

    capture.responder = lambda _req: _prompt()
    for i in range(prompt_mod._MAX_CACHE_ENTRIES + 10):
        get_prompt("greet", bucket_key=f"u{i}", **CREDS)
    # A per-user A/B split must not grow the cache without limit.
    assert len(prompt_mod._cache) == prompt_mod._MAX_CACHE_ENTRIES
