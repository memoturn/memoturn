"""Shared test scaffolding: a fake ``urllib.request.urlopen`` that records every
request and returns a canned JSON body. Both the client (ingest) and prompt fetch
go through urllib, so patching it once covers the whole SDK without a live API."""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

import pytest


class _FakeResponse:
    def __init__(self, payload: Any) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return json.dumps(self._payload).encode()


class Capture:
    def __init__(self) -> None:
        self.requests: list[urllib.request.Request] = []
        self.responder: Callable[[urllib.request.Request], Any] = lambda _req: {}
        self.error: Optional[BaseException] = None

    @property
    def last(self) -> urllib.request.Request:
        return self.requests[-1]

    def body(self) -> Any:
        data = self.last.data
        return json.loads(data.decode()) if data else None

    def batch(self) -> list[dict[str, Any]]:
        return self.body()["batch"]

    def headers(self) -> dict[str, str]:
        # urllib capitalizes header keys (content-type -> Content-type); normalize.
        return {k.lower(): v for k, v in self.last.headers.items()}

    def basic_auth(self) -> str:
        raw = self.headers()["authorization"].removeprefix("Basic ")
        return base64.b64decode(raw).decode()


@pytest.fixture
def capture(monkeypatch: pytest.MonkeyPatch) -> Capture:
    cap = Capture()

    def fake_urlopen(req: urllib.request.Request, timeout: Optional[float] = None) -> _FakeResponse:
        cap.requests.append(req)
        if cap.error is not None:
            raise cap.error
        return _FakeResponse(cap.responder(req))

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return cap


def http_error(code: int, msg: str = "err") -> urllib.error.HTTPError:
    return urllib.error.HTTPError("http://api.test", code, msg, {}, None)  # type: ignore[arg-type]
