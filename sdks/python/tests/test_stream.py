"""_RecordingStream: chunk forwarding, on_done firing exactly once, idempotent
close/__del__, attribute forwarding, context-manager support, and idle timeout."""
from __future__ import annotations

import time
from typing import Any

import pytest

from memoturn._stream import _ABANDONED, _RecordingStream


def _collector() -> tuple[list[Any], Any]:
    calls: list[Any] = []
    return calls, calls.append


def test_normal_exhaustion_calls_on_done_once_with_none() -> None:
    calls, on_done = _collector()
    rs = _RecordingStream(iter([1, 2, 3]), lambda c: None, on_done)
    assert list(rs) == [1, 2, 3]
    assert calls == [None]


def test_forwards_every_chunk_to_on_chunk_unchanged() -> None:
    seen: list[Any] = []
    rs = _RecordingStream(iter(["a", "b"]), seen.append, lambda err: None)
    assert list(rs) == ["a", "b"]
    assert seen == ["a", "b"]


def test_mid_iteration_exception_calls_on_done_with_the_exception() -> None:
    calls, on_done = _collector()

    def gen():
        yield 1
        raise ValueError("boom")

    rs = _RecordingStream(gen(), lambda c: None, on_done)
    out = []
    with pytest.raises(ValueError, match="boom"):
        for chunk in rs:
            out.append(chunk)
    assert out == [1]
    assert len(calls) == 1
    assert isinstance(calls[0], ValueError)


def test_explicit_close_calls_on_done_with_abandoned_sentinel() -> None:
    calls, on_done = _collector()
    rs = _RecordingStream(iter([1, 2, 3]), lambda c: None, on_done)
    next(rs)
    rs.close()
    assert calls == [_ABANDONED]


def test_close_is_idempotent() -> None:
    calls, on_done = _collector()
    rs = _RecordingStream(iter([1, 2, 3]), lambda c: None, on_done)
    rs.close()
    rs.close()
    assert calls == [_ABANDONED]


def test_del_after_close_does_not_double_call_on_done() -> None:
    calls, on_done = _collector()
    rs = _RecordingStream(iter([1, 2, 3]), lambda c: None, on_done)
    rs.close()
    del rs
    assert calls == [_ABANDONED]


def test_getattr_forwards_to_wrapped_stream_only_attribute() -> None:
    class _FakeSdkStream:
        def __init__(self, items: list[Any]) -> None:
            self._items = items
            self.response = "http-response-object"

        def __iter__(self):
            return iter(self._items)

    fake = _FakeSdkStream([1, 2])
    rs = _RecordingStream(fake, lambda c: None, lambda err: None)
    assert rs.response == "http-response-object"


def test_context_manager_forwards_to_wrapped_enter_exit() -> None:
    class _FakeCtxStream:
        def __init__(self, items: list[Any]) -> None:
            self._items = items
            self.entered = False
            self.exited_with: Any = "not-called"

        def __iter__(self):
            return iter(self._items)

        def __enter__(self):
            self.entered = True
            return self

        def __exit__(self, exc_type, exc, tb):
            self.exited_with = (exc_type, exc, tb)
            return False

    fake = _FakeCtxStream([1, 2])
    calls, on_done = _collector()
    with _RecordingStream(fake, lambda c: None, on_done) as rs:
        assert fake.entered
        assert list(rs) == [1, 2]

    assert fake.exited_with == (None, None, None)
    # exhaustion during the with-body already finished it; __exit__ must not double-fire.
    assert calls == [None]


def test_context_manager_without_enter_exit_on_wrapped_stream_still_works() -> None:
    calls, on_done = _collector()
    with _RecordingStream(iter([1, 2]), lambda c: None, on_done) as rs:
        assert list(rs) == [1, 2]
    assert calls == [None]


def test_buggy_on_chunk_does_not_break_the_caller() -> None:
    def boom(_chunk: Any) -> None:
        raise RuntimeError("accumulator bug")

    calls, on_done = _collector()
    rs = _RecordingStream(iter([1, 2]), boom, on_done)
    assert list(rs) == [1, 2]  # no exception propagates
    assert calls == [None]


def test_idle_timeout_finishes_as_abandoned() -> None:
    calls, on_done = _collector()
    rs = _RecordingStream(iter([1, 2, 3]), lambda c: None, on_done, idle_timeout=0.05)
    next(rs)  # consume one item, resets the idle timer

    deadline = time.time() + 0.2
    while time.time() < deadline and not calls:
        time.sleep(0.01)

    assert calls == [_ABANDONED]
