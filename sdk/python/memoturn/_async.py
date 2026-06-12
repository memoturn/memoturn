"""Asynchronous client — the exact twin of `_sync.py` over
``httpx.AsyncClient``. Paths, bodies, and parsing all come from `_ops`;
only the transport differs."""

from __future__ import annotations

from typing import Any, AsyncIterator, List, Optional

import httpx

from . import _ops
from ._errors import MemoturnError
from ._ops import Op
from ._types import (
    AskResult,
    ErasureCoupon,
    IngestResult,
    Memory,
    RecallResult,
    Turn,
    TurnAppendResult,
)


class _AsyncWire:
    def __init__(
        self,
        url: str,
        token: Optional[str],
        platform_key: Optional[str],
        client: Optional[httpx.AsyncClient],
    ):
        self.base = url.rstrip("/")
        self.token = token
        self.platform_key = platform_key
        self._owns_client = client is None
        self.http = client or httpx.AsyncClient(timeout=30.0)

    async def send(self, op: Op) -> Any:
        cred = (
            (self.platform_key or self.token) if op.platform else (self.token or self.platform_key)
        )
        headers = {"authorization": f"Bearer {cred}"} if cred else {}
        resp = await self.http.request(
            op.method, f"{self.base}{op.path}", json=op.json, content=op.content, headers=headers
        )
        if resp.is_error:
            if resp.status_code == 404 and op.none_on_404:
                return None
            try:
                body = resp.json()
                message, code = body.get("error", resp.text), body.get("code")
            except Exception:
                message, code = resp.text, None
            raise MemoturnError(resp.status_code, message, code)
        return op.parse(resp)

    async def aclose(self) -> None:
        if self._owns_client:
            await self.http.aclose()


class AsyncTranscriptSession:
    """Append-only verbatim transcript (``__memoturn_messages``) for one session."""

    def __init__(self, wire: _AsyncWire, db: str, session_id: str):
        self._w = wire
        self._db = db
        self.session_id = session_id

    async def append_turn(
        self, role: str, content: Any, embedding: Optional[List[float]] = None
    ) -> TurnAppendResult:
        return await self._w.send(
            _ops.turn_append(self._db, self.session_id, role, content, embedding)
        )

    async def get_window(self, last: int = 20) -> List[Turn]:
        return await self._w.send(_ops.turn_window(self._db, self.session_id, last))

    async def search_semantic(self, vector: List[float], k: int = 5) -> List[Turn]:
        return await self._w.send(_ops.turn_search(self._db, self.session_id, vector, k))


class AsyncMemoryProfile:
    """Async twin of :class:`memoturn.MemoryProfile` — see its docs."""

    def __init__(
        self,
        wire: _AsyncWire,
        namespace: str,
        profile: str,
        branch: Optional[str] = None,
        source: Optional[str] = None,
    ):
        self._w = wire
        self.namespace = namespace
        self.profile = profile
        self._branch = branch
        self._source = source

    @property
    def _db(self) -> str:
        return f"{self.namespace}--{self.profile}"

    def on_branch(self, branch: str) -> "AsyncMemoryProfile":
        """Address a branch of this profile's memory (burner experiments)."""
        return AsyncMemoryProfile(self._w, self.namespace, self.profile, branch, self._source)

    async def ingest(self, memories: List[dict]) -> IngestResult:
        memories = _ops.with_default_source(memories, self._source)
        return await self._w.send(
            _ops.memories_ingest(self.namespace, self.profile, self._branch, memories)
        )

    async def recall(
        self,
        query: Optional[str] = None,
        *,
        embedding: Optional[List[float]] = None,
        topic_key: Optional[str] = None,
        types: Optional[List[str]] = None,
        session_id: Optional[str] = None,
        source: Optional[str] = None,
        k: int = 8,
        include_superseded: bool = False,
        include_turns: bool = False,
    ) -> RecallResult:
        body = _ops.recall_body(
            query, embedding, topic_key, types, session_id, source, k,
            include_superseded, include_turns,
        )
        return await self._w.send(
            _ops.memories_recall(self.namespace, self.profile, self._branch, body)
        )

    async def ask(
        self,
        question: str,
        *,
        types: Optional[List[str]] = None,
        session_id: Optional[str] = None,
        source: Optional[str] = None,
        k: int = 8,
        include_superseded: bool = False,
    ) -> AskResult:
        body = _ops.ask_body(question, types, session_id, source, k, include_superseded)
        return await self._w.send(
            _ops.memories_ask(self.namespace, self.profile, self._branch, body)
        )

    async def extract(
        self,
        turns: List[dict],
        *,
        session_id: Optional[str] = None,
        source: Optional[str] = None,
        dry_run: bool = False,
    ) -> dict:
        body = _ops.extract_body(
            turns, session_id, source if source is not None else self._source, dry_run
        )
        return await self._w.send(
            _ops.memories_extract(self.namespace, self.profile, self._branch, body)
        )

    async def get(self, memory_id: str) -> Optional[Memory]:
        """One memory with its supersession chain, or None."""
        return await self._w.send(
            _ops.memory_get(self.namespace, self.profile, self._branch, memory_id)
        )

    async def forget(self, memory_id: str) -> bool:
        """Hard delete (supersession already preserves history without this)."""
        found = await self._w.send(
            _ops.memory_forget(self.namespace, self.profile, self._branch, memory_id)
        )
        return bool(found)

    async def erase(
        self,
        *,
        memory_id: Optional[str] = None,
        topic_key: Optional[str] = None,
        type: Optional[str] = None,
        session_id: Optional[str] = None,
        turns: bool = False,
    ) -> ErasureCoupon:
        body = _ops.erase_body(memory_id, topic_key, type, session_id, turns)
        return await self._w.send(_ops.erase(self.namespace, self.profile, self._branch, body))

    async def erasures(self) -> List[ErasureCoupon]:
        return await self._w.send(_ops.erasures_list(self.namespace, self.profile, self._branch))

    async def erasure(self, erasure_id: str) -> Optional[ErasureCoupon]:
        return await self._w.send(
            _ops.erasure_get(self.namespace, self.profile, self._branch, erasure_id)
        )

    async def sessions(self) -> List[dict]:
        return await self._w.send(_ops.sessions_list(self.namespace, self.profile, self._branch))

    async def end_session(self, session_id: str, *, turns: bool = False) -> None:
        await self._w.send(
            _ops.session_end(self.namespace, self.profile, self._branch, session_id, turns)
        )

    async def checkpoint(self, name: str) -> dict:
        return await self._w.send(_ops.checkpoint(self._db, self._branch or "main", name))

    async def rewind(self, to: Any) -> None:
        await self._w.send(_ops.rewind(self._db, self._branch or "main", to))

    async def fork(
        self, branch: str, *, from_branch: Optional[str] = None, ttl: Optional[int] = None
    ) -> "AsyncMemoryProfile":
        await self._w.send(_ops.branch_create(self._db, branch, from_branch or self._branch, ttl))
        return self.on_branch(branch)

    def session(self, session_id: str) -> AsyncTranscriptSession:
        """The raw conversation transcript layer for one session."""
        return AsyncTranscriptSession(self._w, self._db, session_id)


class _AsyncKv:
    def __init__(self, wire: _AsyncWire, spec: str):
        self._w = wire
        self._spec = spec

    async def put(self, ns: str, key: str, value: str, *, ttl: Optional[int] = None) -> int:
        return await self._w.send(_ops.kv_put(self._spec, ns, key, value, ttl))

    async def get(self, ns: str, key: str) -> Optional[str]:
        return await self._w.send(_ops.kv_get(self._spec, ns, key))

    async def delete(self, ns: str, key: str) -> None:
        await self._w.send(_ops.kv_delete(self._spec, ns, key))

    async def list(self, ns: str, *, prefix: str = "", limit: int = 100) -> List[str]:
        return await self._w.send(_ops.kv_list(self._spec, ns, prefix, limit))


class AsyncCollection:
    def __init__(self, wire: _AsyncWire, spec: str, name: str):
        self._w = wire
        self._spec = spec
        self.name = name

    async def insert(self, docs: List[dict]) -> dict:
        return await self._w.send(_ops.docs_insert(self._spec, self.name, docs))

    async def find(
        self,
        filter: Optional[dict] = None,
        *,
        sort: Optional[dict] = None,
        limit: Optional[int] = None,
        skip: Optional[int] = None,
    ) -> List[dict]:
        return await self._w.send(_ops.docs_find(self._spec, self.name, filter, sort, limit, skip))

    async def update(self, filter: dict, update: dict, *, multi: bool = False) -> dict:
        return await self._w.send(_ops.docs_update(self._spec, self.name, filter, update, multi))

    async def delete(self, filter: dict, *, multi: bool = False) -> dict:
        return await self._w.send(_ops.docs_delete(self._spec, self.name, filter, multi))

    async def create_index(self, path: str) -> None:
        await self._w.send(_ops.docs_create_index(self._spec, self.name, path))


class _AsyncVectors:
    def __init__(self, wire: _AsyncWire, spec: str):
        self._w = wire
        self._spec = spec

    async def upsert(self, collection: str, id: str, embedding: List[float]) -> int:
        return await self._w.send(_ops.vectors_upsert(self._spec, collection, id, embedding))

    async def search(self, collection: str, vector: List[float], *, k: int = 10) -> List[dict]:
        return await self._w.send(_ops.vectors_search(self._spec, collection, vector, k))


class _AsyncBranch:
    def __init__(self, wire: _AsyncWire, spec: str):
        self._w = wire
        self._spec = spec

    async def create(
        self, name: str, *, from_branch: Optional[str] = None, ttl: Optional[int] = None
    ) -> dict:
        return await self._w.send(_ops.branch_create(self._spec, name, from_branch, ttl))

    async def list(self) -> List[dict]:
        return await self._w.send(_ops.branch_list(self._spec))

    async def delete(self, name: str) -> None:
        await self._w.send(_ops.branch_delete(self._spec, name))

    async def checkpoint(self, branch: str, name: str) -> dict:
        return await self._w.send(_ops.checkpoint(self._spec, branch, name))

    async def rewind(self, branch: str, to: Any) -> None:
        await self._w.send(_ops.rewind(self._spec, branch, to))


class AsyncDb:
    """One database (``name`` or ``name@branch``) — the multi-model substrate."""

    def __init__(self, wire: _AsyncWire, spec: str):
        self._w = wire
        self.spec = spec
        self.kv = _AsyncKv(wire, spec)
        self.vectors = _AsyncVectors(wire, spec)
        self.branch = _AsyncBranch(wire, spec)

    async def sql(self, q: str, params: Optional[list] = None) -> dict:
        """SQL escape hatch (atomic batch of one statement)."""
        return await self._w.send(_ops.sql(self.spec, q, params))

    def collection(self, name: str) -> AsyncCollection:
        return AsyncCollection(self._w, self.spec, name)

    async def sync(self) -> int:
        """Ship this branch's state to object storage now (durability point)."""
        return await self._w.send(_ops.sync_db(self.spec))


class AsyncMemoturn:
    """Async client for agents that live on an event loop::

        async with AsyncMemoturn(url, token=token) as mt:
            await mt.memory("acme", "alice").recall(query="…")
    """

    def __init__(
        self,
        url: str = "http://127.0.0.1:8080",
        *,
        token: Optional[str] = None,
        platform_key: Optional[str] = None,
        source: Optional[str] = None,
        http_client: Optional[httpx.AsyncClient] = None,
    ):
        self._w = _AsyncWire(url, token, platform_key, http_client)
        self._source = source

    async def __aenter__(self) -> "AsyncMemoturn":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the underlying HTTP client (only if this client owns it)."""
        await self._w.aclose()

    def memory(self, namespace: str, profile: str) -> AsyncMemoryProfile:
        """The memory surface: one profile per user/team/agent persona."""
        return AsyncMemoryProfile(self._w, namespace, profile, source=self._source)

    async def profiles(self, namespace: str) -> List[dict]:
        """Profiles under a namespace (requires a namespace token)."""
        return await self._w.send(_ops.profiles_list(namespace))

    def db(self, spec: str) -> AsyncDb:
        """A database / branch on the multi-model substrate."""
        return AsyncDb(self._w, spec)

    # ---- control plane (platform key) ----

    async def create_database(self, name: str) -> dict:
        return await self._w.send(_ops.db_create(name))

    async def list_databases(self) -> List[dict]:
        return await self._w.send(_ops.db_list())

    async def delete_database(self, name: str) -> None:
        await self._w.send(_ops.db_delete(name))

    async def create_token(self, db: str, scope: str, *, expires_in: Optional[int] = None) -> str:
        """Mint a per-database token (platform key)."""
        return await self._w.send(_ops.token_create(db, scope, expires_in))

    async def create_namespace_token(
        self, namespace: str, scope: str, *, expires_in: Optional[int] = None
    ) -> str:
        """Mint a namespace token covering every profile under it (platform key)."""
        return await self._w.send(_ops.ns_token_create(namespace, scope, expires_in))

    # ---- data governance (ADR-0010) ----

    async def get_policy(self, namespace: str, *, profile: Optional[str] = None) -> Optional[dict]:
        if profile is not None:
            return await self._w.send(_ops.profile_policy_get(namespace, profile))
        return await self._w.send(_ops.ns_policy_get(namespace))

    async def set_policy(
        self, namespace: str, policy: Optional[dict], *, profile: Optional[str] = None
    ) -> dict:
        if profile is not None:
            return await self._w.send(_ops.profile_policy_set(namespace, profile, policy))
        return await self._w.send(_ops.ns_policy_set(namespace, policy))

    async def audit_events(
        self,
        namespace: str,
        *,
        from_ms: Optional[int] = None,
        to_ms: Optional[int] = None,
        action: Optional[str] = None,
        profile: Optional[str] = None,
        outcome: Optional[str] = None,
        limit: int = 100,
    ) -> AsyncIterator[dict]:
        """Iterate a namespace's audit stream, oldest first, paginating
        transparently — ``async for event in mt.audit_events("acme"): …``"""
        cursor: Optional[str] = None
        while True:
            body = await self._w.send(
                _ops.audit_page(
                    namespace,
                    {
                        "from": from_ms,
                        "to": to_ms,
                        "action": action,
                        "profile": profile,
                        "outcome": outcome,
                        "limit": limit,
                        "cursor": cursor,
                    },
                )
            )
            for event in body["events"]:
                yield event
            cursor = body.get("next_cursor")
            if body.get("complete") or not cursor:
                return
