"""wrap_mistral records chat.complete / chat.stream as generations. Mistral's v1 SDK is
OpenAI-chat-shaped for non-streaming responses, but streaming is a dedicated stream()
method whose events wrap the chunk one level deeper (event.data.choices[].delta)."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from conftest import Capture

from memoturn import Memoturn, wrap_mistral

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def _fake_mistral(complete, stream=None, **extra):
    chat = SimpleNamespace(complete=complete)
    if stream is not None:
        chat.stream = stream
    return SimpleNamespace(chat=chat, **extra)


def _completion():
    message = SimpleNamespace(model_dump=lambda: {"role": "assistant", "content": "4"})
    usage = SimpleNamespace(prompt_tokens=10, completion_tokens=1, total_tokens=11)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=usage)


def test_records_generation_with_usage(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    completion = _completion()
    client = _fake_mistral(lambda **kw: completion)
    wrap_mistral(client, mt)

    res = client.chat.complete(
        model="mistral-small-latest", messages=[{"role": "user", "content": "2+2?"}], temperature=0.2
    )
    assert res is completion
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["name"] == "mistral.chat"
    assert create["body"]["model"] == "mistral-small-latest"
    assert create["body"]["provider"] == "mistral"
    # exclusion-list modelParameters: only model/messages/stream are excluded.
    assert create["body"]["modelParameters"] == {"temperature": 0.2}
    assert create["body"]["input"] == [{"role": "user", "content": "2+2?"}]
    assert update["body"]["output"] == {"role": "assistant", "content": "4"}
    assert update["body"]["usage"] == {"promptTokens": 10, "completionTokens": 1, "totalTokens": 11}


def test_nests_under_provided_trace(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    trace = mt.trace(name="outer")
    client = _fake_mistral(lambda **kw: _completion())
    wrap_mistral(client, mt, trace=trace)

    client.chat.complete(model="mistral-small-latest", messages=[])
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["traceId"] == trace.id


def test_error_marks_generation_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw):
        raise RuntimeError("rate limited")

    client = _fake_mistral(boom)
    wrap_mistral(client, mt)

    with pytest.raises(RuntimeError, match="rate limited"):
        client.chat.complete(model="mistral-small-latest", messages=[])
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "rate limited" in update["body"]["statusMessage"]


def test_client_without_stream_method_still_wraps_complete(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_mistral(lambda **kw: _completion())
    assert not hasattr(client.chat, "stream")
    wrap_mistral(client, mt)  # must not crash on a chat namespace with no stream

    client.chat.complete(model="mistral-small-latest", messages=[])
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["name"] == "mistral.chat"


# ── streaming ────────────────────────────────────────────────────────────────────


def _event(choices: list | None = None, usage: object | None = None) -> SimpleNamespace:
    return SimpleNamespace(data=SimpleNamespace(choices=choices or [], usage=usage))


def _choice(index: int = 0, **kw: object) -> SimpleNamespace:
    return SimpleNamespace(index=index, delta=SimpleNamespace(**kw))


def _tool_call_delta(index: int, **kw: object) -> SimpleNamespace:
    func = SimpleNamespace(name=kw.pop("name", None), arguments=kw.pop("arguments", None))
    return SimpleNamespace(index=index, id=kw.pop("id_", None), type=kw.pop("type_", None), function=func)


def test_stream_forwards_events_unchanged_and_concatenates_content(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        _event([_choice(role="assistant", content="")]),
        _event([_choice(content="Hel")]),
        _event([_choice(content="lo")]),
    ]
    client = _fake_mistral(lambda **kw: None, stream=lambda **kw: iter(events))
    wrap_mistral(client, mt)

    stream = client.chat.stream(model="mistral-small-latest", messages=[{"role": "user", "content": "hi"}])
    assert list(stream) == events  # forwarded unchanged
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["model"] == "mistral-small-latest"
    assert create["body"]["modelParameters"] == {}
    assert update["body"]["output"] == {"role": "assistant", "content": "Hello"}


def test_stream_content_chunk_list_deltas_are_flattened(capture: Capture) -> None:
    """Mistral delta content may be a list of typed chunks rather than a plain string."""
    mt = Memoturn(**CREDS)
    events = [
        _event([_choice(role="assistant", content=[SimpleNamespace(type="text", text="Hel")])]),
        _event([_choice(content=[SimpleNamespace(type="text", text="lo")])]),
    ]
    client = _fake_mistral(lambda **kw: None, stream=lambda **kw: iter(events))
    wrap_mistral(client, mt)

    list(client.chat.stream(model="mistral-small-latest", messages=[]))
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["output"] == {"role": "assistant", "content": "Hello"}


def test_stream_final_event_usage_captured(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        _event([_choice(role="assistant", content="hi")]),
        _event(usage=SimpleNamespace(prompt_tokens=5, completion_tokens=2, total_tokens=7)),
    ]
    client = _fake_mistral(lambda **kw: None, stream=lambda **kw: iter(events))
    wrap_mistral(client, mt)

    list(client.chat.stream(model="mistral-small-latest", messages=[]))
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["usage"] == {"promptTokens": 5, "completionTokens": 2, "totalTokens": 7}


def test_stream_accumulates_tool_calls_by_index(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        _event([_choice(role="assistant",
                        tool_calls=[_tool_call_delta(0, id_="call_1", type_="function", name="get_weather", arguments="")])]),
        _event([_choice(tool_calls=[_tool_call_delta(0, arguments='{"c')])]),
        _event([_choice(tool_calls=[_tool_call_delta(0, arguments='ity":"SF"}')])]),
    ]
    client = _fake_mistral(lambda **kw: None, stream=lambda **kw: iter(events))
    wrap_mistral(client, mt)

    list(client.chat.stream(model="mistral-small-latest", messages=[]))
    mt.flush()

    output = _find(capture.batch(), "generation-update")["body"]["output"]
    assert output["tool_calls"] == [
        {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": '{"city":"SF"}'}}
    ]


def test_stream_dict_tool_arguments_replace_instead_of_concatenating(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        _event([_choice(role="assistant",
                        tool_calls=[_tool_call_delta(0, id_="call_1", type_="function", name="f", arguments={"city": "SF"})])]),
    ]
    client = _fake_mistral(lambda **kw: None, stream=lambda **kw: iter(events))
    wrap_mistral(client, mt)

    list(client.chat.stream(model="mistral-small-latest", messages=[]))
    mt.flush()

    output = _find(capture.batch(), "generation-update")["body"]["output"]
    assert output["tool_calls"][0]["function"]["arguments"] == {"city": "SF"}


def test_stream_mid_error_marks_generation_error_with_partial_output_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def stream(**kw: object) -> object:
        def gen():
            yield _event([_choice(role="assistant", content="partial")])
            raise RuntimeError("stream broke")

        return gen()

    client = _fake_mistral(lambda **kw: None, stream=stream)
    wrap_mistral(client, mt)

    with pytest.raises(RuntimeError, match="stream broke"):
        list(client.chat.stream(model="mistral-small-latest", messages=[]))
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "stream broke" in update["body"]["statusMessage"]
    assert update["body"]["output"] == {"role": "assistant", "content": "partial"}


def test_stream_early_close_marks_generation_warning(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        _event([_choice(role="assistant", content="partial")]),
        _event([_choice(content="more")]),
    ]
    client = _fake_mistral(lambda **kw: None, stream=lambda **kw: iter(events))
    wrap_mistral(client, mt)

    stream = client.chat.stream(model="mistral-small-latest", messages=[])
    next(stream)
    stream.close()
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "WARNING"
    assert update["body"]["output"] == {"role": "assistant", "content": "partial"}


def test_synchronous_stream_start_failure_marks_error_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw: object) -> object:
        raise RuntimeError("connection refused")

    client = _fake_mistral(lambda **kw: None, stream=boom)
    wrap_mistral(client, mt)

    with pytest.raises(RuntimeError, match="connection refused"):
        client.chat.stream(model="mistral-small-latest", messages=[])
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "connection refused" in update["body"]["statusMessage"]
