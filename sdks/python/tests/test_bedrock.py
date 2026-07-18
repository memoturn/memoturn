"""wrap_bedrock records each converse/converse_stream call as a generation with mapped
usage. Only the standardized Converse API is covered (not invoke_model)."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from conftest import Capture

from memoturn import Memoturn, wrap_bedrock

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def _fake_bedrock_client(converse=None, converse_stream=None) -> SimpleNamespace:
    kwargs = {}
    if converse is not None:
        kwargs["converse"] = converse
    if converse_stream is not None:
        kwargs["converse_stream"] = converse_stream
    return SimpleNamespace(**kwargs)


def _response(**usage_overrides):
    usage = {"inputTokens": 10, "outputTokens": 3, "cacheReadInputTokens": 7, "cacheWriteInputTokens": 2}
    usage.update(usage_overrides)
    return {
        "output": {"message": {"role": "assistant", "content": [{"text": "4"}]}},
        "usage": {**usage, "totalTokens": usage["inputTokens"] + usage["outputTokens"]},
        "stopReason": "end_turn",
    }


def test_records_generation_with_usage_and_cache_tokens(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = _response()
    client = _fake_bedrock_client(converse=lambda **kw: resp)
    wrap_bedrock(client, mt)

    res = client.converse(
        modelId="anthropic.claude-3-5-sonnet-20241022-v2:0",
        system=[{"text": "be terse"}],
        messages=[{"role": "user", "content": [{"text": "2+2?"}]}],
        inferenceConfig={"maxTokens": 64, "temperature": 0.2, "topP": 0.9, "stopSequences": ["END"]},
        additionalModelRequestFields={"foo": "bar"},  # not in the allowlist — must be dropped
    )
    assert res is resp
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "generation-create")
    update = _find(batch, "generation-update")
    assert create["body"]["name"] == "bedrock.converse"
    assert create["body"]["model"] == "anthropic.claude-3-5-sonnet-20241022-v2:0"
    assert create["body"]["provider"] == "bedrock"
    assert create["body"]["input"] == {
        "system": [{"text": "be terse"}],
        "messages": [{"role": "user", "content": [{"text": "2+2?"}]}],
    }
    assert create["body"]["modelParameters"] == {
        "maxTokens": 64,
        "temperature": 0.2,
        "topP": 0.9,
        "stopSequences": ["END"],
    }
    assert update["body"]["output"] == {"role": "assistant", "content": [{"text": "4"}]}
    assert update["body"]["usage"] == {
        "promptTokens": 10,
        "completionTokens": 3,
        "totalTokens": 13,
        "cacheReadTokens": 7,
        "cacheCreationTokens": 2,
    }


def test_input_without_system_is_messages(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_bedrock_client(converse=lambda **kw: _response())
    wrap_bedrock(client, mt)

    client.converse(modelId="amazon.titan-text-express-v1", messages=[{"role": "user", "content": [{"text": "hi"}]}])
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["input"] == [
        {"role": "user", "content": [{"text": "hi"}]}
    ]


def test_inference_config_allowlist_extraction(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_bedrock_client(converse=lambda **kw: _response())
    wrap_bedrock(client, mt)

    client.converse(
        modelId="amazon.titan-text-express-v1",
        messages=[],
        inferenceConfig={"maxTokens": 8, "unknownField": "nope"},
    )
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["modelParameters"] == {"maxTokens": 8}


def test_missing_usage_fields_default(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = {
        "output": {"message": {"role": "assistant", "content": [{"text": "x"}]}},
        "usage": {"inputTokens": 5, "outputTokens": 1, "totalTokens": 6},  # no cache token fields
    }
    client = _fake_bedrock_client(converse=lambda **kw: resp)
    wrap_bedrock(client, mt)

    client.converse(modelId="amazon.titan-text-express-v1", messages=[])
    mt.flush()
    assert _find(capture.batch(), "generation-update")["body"]["usage"] == {
        "promptTokens": 5,
        "completionTokens": 1,
        "totalTokens": 6,
    }


def test_nests_under_provided_trace(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    trace = mt.trace(name="outer")
    client = _fake_bedrock_client(converse=lambda **kw: _response())
    wrap_bedrock(client, mt, trace=trace)

    client.converse(modelId="amazon.titan-text-express-v1", messages=[])
    mt.flush()
    assert _find(capture.batch(), "generation-create")["body"]["traceId"] == trace.id


def test_error_marks_generation_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw):
        raise RuntimeError("throttled")

    client = _fake_bedrock_client(converse=boom)
    wrap_bedrock(client, mt)

    with pytest.raises(RuntimeError, match="throttled"):
        client.converse(modelId="amazon.titan-text-express-v1", messages=[])
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "throttled" in update["body"]["statusMessage"]


def test_converse_stream_missing_is_noop() -> None:
    mt = Memoturn(**CREDS)
    client = _fake_bedrock_client(converse=lambda **kw: _response())  # no converse_stream attribute
    wrap_bedrock(client, mt)  # must not raise
    assert not hasattr(client, "converse_stream")


# ── streaming ─────────────────────────────────────────────────────────────────────


def _fake_stream_bedrock_client(events: list) -> SimpleNamespace:
    return _fake_bedrock_client(
        converse=lambda **kw: _response(),
        converse_stream=lambda **kw: {"stream": iter(events), "ResponseMetadata": {}},
    )


def test_stream_forwards_events_and_accumulates_text_deltas(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Hel"}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "lo"}}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"messageStop": {"stopReason": "end_turn"}},
        {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 3, "totalTokens": 13}}},
    ]
    client = _fake_stream_bedrock_client(events)
    wrap_bedrock(client, mt)

    resp = client.converse_stream(
        modelId="anthropic.claude-3-5-sonnet-20241022-v2:0", messages=[{"role": "user", "content": [{"text": "2+2?"}]}]
    )
    assert list(resp["stream"]) == events  # forwarded unchanged
    assert resp["ResponseMetadata"] == {}  # other keys pass through untouched
    mt.flush()

    batch = capture.batch()
    update = _find(batch, "generation-update")
    assert update["body"]["output"] == [{"text": "Hello"}]
    assert update["body"]["usage"] == {"promptTokens": 10, "completionTokens": 3, "totalTokens": 13}


def test_stream_non_text_delta_merges_generically(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        {"contentBlockStart": {"contentBlockIndex": 0, "start": {"toolUse": {"toolUseId": "t1", "name": "get_weather"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": '{"city":"SF"}'}}}},
    ]
    client = _fake_stream_bedrock_client(events)
    wrap_bedrock(client, mt)

    list(client.converse_stream(modelId="anthropic.claude-3-5-sonnet-20241022-v2:0", messages=[])["stream"])
    mt.flush()

    output = _find(capture.batch(), "generation-update")["body"]["output"]
    # Non-text deltas merge generically (a shallow dict.update per top-level key) — the
    # delta's "toolUse" value replaces the block's "toolUse" key wholesale, it isn't
    # deep-merged with what contentBlockStart initialized.
    assert output == [{"toolUse": {"input": '{"city":"SF"}'}}]


def test_stream_mid_error_marks_generation_error_with_partial_output_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def converse_stream(**kw: object) -> object:
        def gen():
            yield {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}}
            yield {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "partial"}}}
            raise RuntimeError("throttled mid-stream")

        return {"stream": gen()}

    client = _fake_bedrock_client(converse=lambda **kw: _response(), converse_stream=converse_stream)
    wrap_bedrock(client, mt)

    resp = client.converse_stream(modelId="anthropic.claude-3-5-sonnet-20241022-v2:0", messages=[])
    with pytest.raises(RuntimeError, match="throttled mid-stream"):
        list(resp["stream"])
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "throttled mid-stream" in update["body"]["statusMessage"]
    assert update["body"]["output"] == [{"text": "partial"}]


def test_stream_early_close_marks_generation_warning_with_partial_output(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    events = [
        {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "partial"}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "-more"}}},
    ]
    client = _fake_stream_bedrock_client(events)
    wrap_bedrock(client, mt)

    resp = client.converse_stream(modelId="anthropic.claude-3-5-sonnet-20241022-v2:0", messages=[])
    stream = resp["stream"]
    next(stream)
    next(stream)
    stream.close()
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "WARNING"
    assert update["body"]["statusMessage"] == "stream ended before completion"
    assert update["body"]["output"] == [{"text": "partial"}]


def test_synchronous_stream_start_failure_marks_error_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw: object) -> object:
        raise RuntimeError("throttled")

    client = _fake_bedrock_client(converse=lambda **kw: _response(), converse_stream=boom)
    wrap_bedrock(client, mt)

    with pytest.raises(RuntimeError, match="throttled"):
        client.converse_stream(modelId="anthropic.claude-3-5-sonnet-20241022-v2:0", messages=[])
    mt.flush()

    update = _find(capture.batch(), "generation-update")
    assert update["body"]["level"] == "ERROR"
    assert "throttled" in update["body"]["statusMessage"]
