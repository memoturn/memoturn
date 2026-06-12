"""API error with status and the envelope's stable machine-readable code."""

from __future__ import annotations

from typing import Optional

#: Status-derived fallback codes for the envelope-less 408/413 responses
#: (tower middleware defaults) and anything else without a ``code`` field.
_CODE_FOR_STATUS = {
    400: "invalid_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    408: "request_timeout",
    409: "conflict",
    413: "payload_too_large",
    429: "overloaded",
    503: "unavailable",
}


class MemoturnError(Exception):
    """API error with the HTTP status and a stable ``code`` to branch on.

    ``code`` is the envelope's machine-readable identifier
    (``branch_not_found``, ``unconfigured``, ``overloaded``, …) —
    e.g. ``unconfigured`` means the node has no assistant/extractor and the
    client should fall back to the bring-your-own path.
    """

    def __init__(self, status: int, message: str, code: Optional[str] = None):
        super().__init__(f"Memoturn {status}: {message}")
        self.status = status
        self.code = code or _CODE_FOR_STATUS.get(status, "internal")
