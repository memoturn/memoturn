"""Internal streaming-response plumbing shared by the OpenAI and Anthropic wrappers.

Not part of the public API — no leading-underscore module is imported from
``__init__.py``.
"""
from __future__ import annotations

import threading
from typing import Any, Callable, Optional

_ABANDONED = object()  # sentinel passed to on_done() distinct from a real exception


def _get(obj: Any, name: str, default: Any = None) -> Any:
    """Attribute-or-dict-key access — event/chunk objects may be pydantic models
    (real SDK responses) or plain dicts/SimpleNamespace (tests)."""
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


class _RecordingStream:
    """Wraps a sync iterable SDK stream: forwards every item unchanged via __next__ while
    feeding it to on_chunk; calls on_done(err_or_None_or_ABANDONED) exactly once on
    exhaustion, error, explicit close(), context-manager exit, or __del__ (idempotent)."""

    __slots__ = ("_stream", "_iter", "_on_chunk", "_on_done", "_done", "_timer", "_idle_timeout")

    def __init__(
        self,
        stream: Any,
        on_chunk: Callable[[Any], None],
        on_done: Callable[[Any], None],
        idle_timeout: float = 120.0,
    ) -> None:
        self._stream = stream
        self._iter = iter(stream)
        self._on_chunk = on_chunk
        self._on_done = on_done
        self._done = False
        self._idle_timeout = idle_timeout
        self._timer: Optional[threading.Timer] = None
        self._reset_timer()

    def _reset_timer(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
        self._timer = threading.Timer(self._idle_timeout, lambda: self._finish(_ABANDONED))
        self._timer.daemon = True
        self._timer.start()

    def __iter__(self) -> "_RecordingStream":
        return self

    def __next__(self) -> Any:
        try:
            chunk = next(self._iter)
        except StopIteration:
            self._finish(None)
            raise
        except Exception as e:  # noqa: BLE001
            self._finish(e)
            raise
        self._reset_timer()
        try:
            self._on_chunk(chunk)
        except Exception:  # noqa: BLE001
            pass  # never let a bug in the accumulator break the caller's stream
        return chunk

    def _finish(self, err: Any) -> None:
        if self._done:
            return
        self._done = True
        if self._timer is not None:
            self._timer.cancel()
        try:
            self._on_done(err)
        except Exception:  # noqa: BLE001
            pass

    def close(self) -> None:
        self._finish(_ABANDONED)
        close = getattr(self._stream, "close", None)
        if callable(close):
            close()

    def __enter__(self) -> "_RecordingStream":
        enter = getattr(self._stream, "__enter__", None)
        if callable(enter):
            enter()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> Any:
        self._finish(exc if exc else None)
        exit_ = getattr(self._stream, "__exit__", None)
        if callable(exit_):
            return exit_(exc_type, exc, tb)
        return False

    def __del__(self) -> None:
        try:
            self._finish(_ABANDONED)
        except Exception:  # noqa: BLE001
            pass

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)
