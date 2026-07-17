"""wrap_gemini records client.models.generate_content and .generate_content_stream
calls as generations. Unlike OpenAI/Anthropic, Gemini has no stream=True flag —
streaming is a separate always-streaming method returning full GenerateContentResponse
chunks (not deltas), so it is tested independently."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from conftest import Capture

from memoturn import Memoturn, wrap_gemini

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def _fake_gemini(generate_content=None, generate_content_stream=None) -> SimpleNamespace:
    kwargs: dict = {}
    if generate_content is not None:
        kwargs["generate_content"] = generate_content
    if generate_content_stream is not None:
        kwargs["generate_content_stream"] = generate_content_stream
    return SimpleNamespace(models=SimpleNamespace(**kwargs))


def _usage(**kw: object) -> SimpleNamespace:
    return SimpleNamespace(
        prompt_token_count=kw.get("prompt_token_count"),
        candidates_token_count=kw.get("candidates_token_count"),
        cached_content_token_count=kw.get("cached_content_token_count"),
    )


def _response(text: str = "4", usage: object | None = None) -> SimpleNamespace:
    return SimpleNamespace(text=text, usage_metadata=usage)


def test_records_generation_with_system_instruction_and_usage(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = _response(usage=_usage(prompt_token_count=10, candidates_token_count=3, cached_content_token_count=2))
    client = _fake_gemini(generate_content=lambda **kw: resp)
    wrap_gemini(client, mt)

    contents = [{"role": "user", "parts": [{"text": "2+2?"}]}]
    config = {"system_instruction": "be terse", "temperature": 0.2, "max_output_tokens": 100}
    res = client.models.generate_content(model="gemini-2.0-flash", contents=contents, config=config)
    assert res is resp
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["name"] == "gemini.generateContent"
    assert create["body"]["model"] == "gemini-2.0-flash"
    assert create["body"]["provider"] == "gemini"
    assert create["body"]["input"] == {"systemInstruction": "be terse", "contents": contents}
    assert create["body"]["modelParameters"] == {"temperature": 0.2, "max_output_tokens": 100}
    assert update["body"]["output"] == "4"
    assert update["body"]["usage"] == {
        "promptTokens": 10,
        "completionTokens": 3,
        "totalTokens": 13,
        "cacheReadTokens": 2,
    }


def test_input_without_system_instruction_is_bare_contents(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_gemini(generate_content=lambda **kw: _response())
    wrap_gemini(client, mt)

    contents = [{"role": "user", "parts": [{"text": "hi"}]}]
    client.models.generate_content(model="gemini-2.0-flash", contents=contents, config={"temperature": 0.5})
    mt.flush()

    create = _find(capture.batch(), "generation-create")
    assert create["body"]["input"] == contents
    assert create["body"]["modelParameters"] == {"temperature": 0.5}


def test_config_as_pydantic_like_object_with_model_dump(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_gemini(generate_content=lambda **kw: _response())
    wrap_gemini(client, mt)

    config = SimpleNamespace(model_dump=lambda **kw: {"system_instruction": "sys", "top_p": 0.9})
    client.models.generate_content(model="gemini-2.0-flash", contents="hi", config=config)
    mt.flush()

    create = _find(capture.batch(), "generation-create")
    assert create["body"]["input"] == {"systemInstruction": "sys", "contents": "hi"}
    assert create["body"]["modelParameters"] == {"top_p": 0.9}


def test_usage_omits_total_and_cache_tokens_when_absent(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = _response(usage=_usage(prompt_token_count=8))
    client = _fake_gemini(generate_content=lambda **kw: resp)
    wrap_gemini(client, mt)

    client.models.generate_content(model="gemini-2.0-flash", contents="hi")
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["usage"] == {"promptTokens": 8, "completionTokens": None}


def test_nests_under_provided_trace(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    trace = mt.trace(name="outer")
    client = _fake_gemini(generate_content=lambda **kw: _response())
    wrap_gemini(client, mt, trace=trace)

    client.models.generate_content(model="gemini-2.0-flash", contents="hi")
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["traceId"] == trace.id


def test_error_marks_generation_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw):
        raise RuntimeError("rate limited")

    client = _fake_gemini(generate_content=boom)
    wrap_gemini(client, mt)

    with pytest.raises(RuntimeError, match="rate limited"):
        client.models.generate_content(model="gemini-2.0-flash", contents="hi")
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "rate limited" in update["body"]["statusMessage"]


# ── streaming ─────────────────────────────────────────────────────────────────────


def test_stream_accumulates_text_and_takes_latest_usage(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    chunks = [
        _response(text="Hel"),
        _response(text="lo", usage=_usage(prompt_token_count=5, candidates_token_count=1)),
        _response(text="", usage=_usage(prompt_token_count=5, candidates_token_count=2)),
    ]
    client = _fake_gemini(generate_content=lambda **kw: _response(), generate_content_stream=lambda **kw: iter(chunks))
    wrap_gemini(client, mt)

    stream = client.models.generate_content_stream(model="gemini-2.0-flash", contents="hi")
    assert list(stream) == chunks  # forwarded unchanged
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["name"] == "gemini.generateContentStream"
    assert update["body"]["output"] == "Hello"
    assert update["body"]["usage"] == {"promptTokens": 5, "completionTokens": 2, "totalTokens": 7}


def test_stream_mid_error_marks_generation_error_with_partial_output_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def create(**kw: object) -> object:
        def gen():
            yield _response(text="partial")
            raise RuntimeError("stream broke")

        return gen()

    client = _fake_gemini(generate_content=lambda **kw: _response(), generate_content_stream=create)
    wrap_gemini(client, mt)

    stream = client.models.generate_content_stream(model="gemini-2.0-flash", contents="hi")
    with pytest.raises(RuntimeError, match="stream broke"):
        list(stream)
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "stream broke" in update["body"]["statusMessage"]
    assert update["body"]["output"] == "partial"


def test_stream_early_close_marks_generation_warning_with_partial_output(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    chunks = [_response(text="partial"), _response(text="more")]
    client = _fake_gemini(generate_content=lambda **kw: _response(), generate_content_stream=lambda **kw: iter(chunks))
    wrap_gemini(client, mt)

    stream = client.models.generate_content_stream(model="gemini-2.0-flash", contents="hi")
    next(stream)
    stream.close()
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "WARNING"
    assert update["body"]["statusMessage"] == "stream ended before completion"
    assert update["body"]["output"] == "partial"


def test_synchronous_stream_start_failure_marks_error_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw: object) -> object:
        raise RuntimeError("connection refused")

    client = _fake_gemini(generate_content=lambda **kw: _response(), generate_content_stream=boom)
    wrap_gemini(client, mt)

    with pytest.raises(RuntimeError, match="connection refused"):
        client.models.generate_content_stream(model="gemini-2.0-flash", contents="hi")
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "connection refused" in update["body"]["statusMessage"]


# ── wrap_gemini scope ────────────────────────────────────────────────────────────


def test_wrap_gemini_leaves_other_client_attributes_untouched(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    count_tokens = lambda **kw: "unrelated"  # noqa: E731
    client = _fake_gemini(generate_content=lambda **kw: _response(), generate_content_stream=lambda **kw: iter([]))
    client.models.count_tokens = count_tokens
    client.some_other_attr = "untouched"
    wrap_gemini(client, mt)

    assert client.models.count_tokens is count_tokens
    assert client.some_other_attr == "untouched"


def test_generate_content_stream_missing_is_noop(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_gemini(generate_content=lambda **kw: _response())  # no generate_content_stream attr
    wrap_gemini(client, mt)  # must not raise

    client.models.generate_content(model="gemini-2.0-flash", contents="hi")
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["name"] == "gemini.generateContent"
