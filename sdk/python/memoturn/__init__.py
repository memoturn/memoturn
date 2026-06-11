"""Memoturn Python SDK — memory for AI agents.

The headline surface is agent memory (docs/architecture/07): typed memories
with supersession and hybrid recall, organized ``namespace > profile > memory``
where a profile is one Memoturn database every agent serving that user shares.
The multi-model substrate (docs/KV/SQL/vectors/transcript, branching) is
exposed on ``db()``.

    from memoturn import Memoturn

    mt = Memoturn(url="http://127.0.0.1:8080", token=token)
    alice = mt.memory("acme", "alice")
    alice.ingest([{"type": "fact", "topic_key": "user.diet",
                   "summary": "vegetarian since 2024",
                   "content": {"diet": "vegetarian"}}])
    hits = alice.recall(query="what can this user eat?")
"""

from __future__ import annotations

from typing import Any, Optional

import httpx

__all__ = ["Memoturn", "MemoryProfile", "TranscriptSession", "Db", "MemoturnError"]


class MemoturnError(Exception):
    """API error with the HTTP status attached."""

    def __init__(self, status: int, message: str):
        super().__init__(f"Memoturn {status}: {message}")
        self.status = status


class _Wire:
    def __init__(
        self,
        url: str,
        token: Optional[str],
        platform_key: Optional[str],
        client: Optional[httpx.Client],
    ):
        self.base = url.rstrip("/")
        self.token = token
        self.platform_key = platform_key
        self.http = client or httpx.Client(timeout=30.0)

    def request(
        self,
        method: str,
        path: str,
        json: Any = None,
        content: Optional[str] = None,
        platform: bool = False,
    ) -> httpx.Response:
        cred = (self.platform_key or self.token) if platform else (self.token or self.platform_key)
        headers = {"authorization": f"Bearer {cred}"} if cred else {}
        resp = self.http.request(
            method, f"{self.base}{path}", json=json, content=content, headers=headers
        )
        if resp.is_error:
            try:
                message = resp.json().get("error", resp.text)
            except Exception:
                message = resp.text
            raise MemoturnError(resp.status_code, message)
        return resp

    @staticmethod
    def txid(resp: httpx.Response) -> int:
        return int(resp.headers.get("Memoturn-Txid", 0))


def _drop_none(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


class TranscriptSession:
    """Append-only verbatim transcript (``__memoturn_messages``) for one session."""

    def __init__(self, wire: _Wire, db: str, session_id: str):
        self._w = wire
        self._db = db
        self.session_id = session_id

    def append_turn(
        self, role: str, content: Any, embedding: Optional[list[float]] = None
    ) -> dict:
        r = self._w.request(
            "POST",
            f"/v1/db/{self._db}/memory/{self.session_id}/turns",
            json=_drop_none({"role": role, "content": content, "embedding": embedding}),
        )
        return {**r.json(), "txid": self._w.txid(r)}

    def get_window(self, last: int = 20) -> list:
        r = self._w.request(
            "GET", f"/v1/db/{self._db}/memory/{self.session_id}/turns?last={last}"
        )
        return r.json()["turns"]

    def search_semantic(self, vector: list[float], k: int = 5) -> list:
        r = self._w.request(
            "POST",
            f"/v1/db/{self._db}/memory/{self.session_id}/search",
            json={"vector": vector, "k": k},
        )
        return r.json()["turns"]


class MemoryProfile:
    """One memory profile: the isolated store every agent serving this
    user/team/persona shares. Backed by its own database (``{ns}--{profile}``),
    so ``checkpoint``/``rewind``/``fork`` operate on the whole memory atomically.
    """

    def __init__(self, wire: _Wire, namespace: str, profile: str, branch: Optional[str] = None):
        self._w = wire
        self.namespace = namespace
        self.profile = profile
        self._branch = branch

    @property
    def _db(self) -> str:
        return f"{self.namespace}--{self.profile}"

    def _qs(self) -> str:
        return f"?branch={self._branch}" if self._branch else ""

    def on_branch(self, branch: str) -> "MemoryProfile":
        """Address a branch of this profile's memory (burner experiments)."""
        return MemoryProfile(self._w, self.namespace, self.profile, branch)

    def ingest(self, memories: list[dict]) -> dict:
        """Idempotent batch ingest; the profile auto-creates on first call.

        Each memory: ``{type, topic_key?, summary, content, keywords?,
        embedding?, session_id?, ttl?}``.
        """
        r = self._w.request(
            "POST",
            f"/v1/memory/{self.namespace}/{self.profile}/memories{self._qs()}",
            json={"memories": memories},
        )
        return {**r.json(), "txid": self._w.txid(r)}

    def recall(
        self,
        query: Optional[str] = None,
        *,
        embedding: Optional[list[float]] = None,
        topic_key: Optional[str] = None,
        types: Optional[list[str]] = None,
        session_id: Optional[str] = None,
        k: int = 8,
        include_superseded: bool = False,
        include_turns: bool = False,
    ) -> dict:
        """Hybrid recall; empty ``memories`` means nothing relevant (never pads)."""
        r = self._w.request(
            "POST",
            f"/v1/memory/{self.namespace}/{self.profile}/recall{self._qs()}",
            json=_drop_none(
                {
                    "query": query,
                    "embedding": embedding,
                    "topic_key": topic_key,
                    "types": types,
                    "session_id": session_id,
                    "k": k,
                    "include_superseded": include_superseded,
                    "include_turns": include_turns,
                }
            ),
        )
        return r.json()

    def extract(
        self, turns: list[dict], *, session_id: Optional[str] = None, dry_run: bool = False
    ) -> dict:
        """Server-side extraction (opt-in node feature): distill raw turns into
        typed memories with a control-plane LLM, then ingest. ``dry_run``
        returns proposals without writing. 503 when the node has no extractor.
        """
        r = self._w.request(
            "POST",
            f"/v1/memory/{self.namespace}/{self.profile}/extract{self._qs()}",
            json=_drop_none({"turns": turns, "session_id": session_id, "dry_run": dry_run}),
        )
        return r.json()

    def get(self, memory_id: str) -> Optional[dict]:
        """One memory with its supersession chain, or None."""
        try:
            r = self._w.request(
                "GET",
                f"/v1/memory/{self.namespace}/{self.profile}/memories/{memory_id}{self._qs()}",
            )
            return r.json()
        except MemoturnError as e:
            if e.status == 404:
                return None
            raise

    def forget(self, memory_id: str) -> bool:
        """Hard delete (supersession already preserves history without this)."""
        try:
            self._w.request(
                "DELETE",
                f"/v1/memory/{self.namespace}/{self.profile}/memories/{memory_id}{self._qs()}",
            )
            return True
        except MemoturnError as e:
            if e.status == 404:
                return False
            raise

    def sessions(self) -> list:
        r = self._w.request(
            "GET", f"/v1/memory/{self.namespace}/{self.profile}/sessions{self._qs()}"
        )
        return r.json()["sessions"]

    def end_session(self, session_id: str, *, turns: bool = False) -> None:
        """End a session: its task memories go; ``turns=True`` drops the transcript."""
        sep = "&" if self._qs() else "?"
        suffix = f"{sep}turns=true" if turns else ""
        self._w.request(
            "DELETE",
            f"/v1/memory/{self.namespace}/{self.profile}/sessions/{session_id}{self._qs()}{suffix}",
        )

    def checkpoint(self, name: str) -> dict:
        """Checkpoint the whole memory (requires admin scope)."""
        branch = self._branch or "main"
        r = self._w.request(
            "POST", f"/v1/db/{self._db}/branches/{branch}/checkpoint", json={"name": name}
        )
        return r.json()

    def rewind(self, to: Any) -> None:
        """Rewind the whole memory to a checkpoint or txid (admin scope)."""
        branch = self._branch or "main"
        self._w.request(
            "POST", f"/v1/db/{self._db}/branches/{branch}/rewind", json={"to": str(to)}
        )

    def fork(
        self, branch: str, *, from_branch: Optional[str] = None, ttl: Optional[int] = None
    ) -> "MemoryProfile":
        """Fork the memory copy-on-write; ``ttl`` makes it a burner branch."""
        self._w.request(
            "POST",
            f"/v1/db/{self._db}/branches",
            json=_drop_none({"name": branch, "from": from_branch or self._branch, "ttl": ttl}),
        )
        return self.on_branch(branch)

    def session(self, session_id: str) -> TranscriptSession:
        """The raw conversation transcript layer for one session."""
        return TranscriptSession(self._w, self._db, session_id)


class _Kv:
    def __init__(self, wire: _Wire, spec: str):
        self._w = wire
        self._spec = spec

    def put(self, ns: str, key: str, value: str, *, ttl: Optional[int] = None) -> int:
        qs = f"?ttl={ttl}" if ttl is not None else ""
        r = self._w.request("PUT", f"/v1/db/{self._spec}/kv/{ns}/{key}{qs}", content=value)
        return self._w.txid(r)

    def get(self, ns: str, key: str) -> Optional[str]:
        try:
            return self._w.request("GET", f"/v1/db/{self._spec}/kv/{ns}/{key}").text
        except MemoturnError as e:
            if e.status == 404:
                return None
            raise

    def delete(self, ns: str, key: str) -> None:
        self._w.request("DELETE", f"/v1/db/{self._spec}/kv/{ns}/{key}")

    def list(self, ns: str, *, prefix: str = "", limit: int = 100) -> list[str]:
        r = self._w.request(
            "GET", f"/v1/db/{self._spec}/kv/{ns}?prefix={prefix}&limit={limit}"
        )
        return r.json()["keys"]


class Collection:
    def __init__(self, wire: _Wire, spec: str, name: str):
        self._w = wire
        self._spec = spec
        self.name = name

    def insert(self, docs: list[dict]) -> dict:
        r = self._w.request(
            "POST", f"/v1/db/{self._spec}/docs/{self.name}/insert", json={"docs": docs}
        )
        return {**r.json(), "txid": self._w.txid(r)}

    def find(
        self,
        filter: Optional[dict] = None,
        *,
        sort: Optional[dict] = None,
        limit: Optional[int] = None,
        skip: Optional[int] = None,
    ) -> list[dict]:
        r = self._w.request(
            "POST",
            f"/v1/db/{self._spec}/docs/{self.name}/find",
            json=_drop_none({"filter": filter or {}, "sort": sort, "limit": limit, "skip": skip}),
        )
        return r.json()["docs"]

    def update(self, filter: dict, update: dict, *, multi: bool = False) -> dict:
        r = self._w.request(
            "POST",
            f"/v1/db/{self._spec}/docs/{self.name}/update",
            json={"filter": filter, "update": update, "multi": multi},
        )
        return r.json()

    def delete(self, filter: dict, *, multi: bool = False) -> dict:
        r = self._w.request(
            "POST",
            f"/v1/db/{self._spec}/docs/{self.name}/delete",
            json={"filter": filter, "multi": multi},
        )
        return r.json()

    def create_index(self, path: str) -> None:
        self._w.request(
            "POST", f"/v1/db/{self._spec}/docs/{self.name}/indexes", json={"path": path}
        )


class _Vectors:
    def __init__(self, wire: _Wire, spec: str):
        self._w = wire
        self._spec = spec

    def upsert(self, collection: str, id: str, embedding: list[float]) -> int:
        r = self._w.request(
            "POST",
            f"/v1/db/{self._spec}/vectors/{collection}",
            json={"id": id, "embedding": embedding},
        )
        return self._w.txid(r)

    def search(self, collection: str, vector: list[float], *, k: int = 10) -> list[dict]:
        r = self._w.request(
            "POST",
            f"/v1/db/{self._spec}/vectors/{collection}/search",
            json={"vector": vector, "k": k},
        )
        return r.json()["hits"]


class _Branch:
    def __init__(self, wire: _Wire, spec: str):
        self._w = wire
        self._spec = spec

    def create(self, name: str, *, from_branch: Optional[str] = None, ttl: Optional[int] = None) -> dict:
        r = self._w.request(
            "POST",
            f"/v1/db/{self._spec}/branches",
            json=_drop_none({"name": name, "from": from_branch, "ttl": ttl}),
        )
        return r.json()

    def list(self) -> list:
        return self._w.request("GET", f"/v1/db/{self._spec}/branches").json()["branches"]

    def delete(self, name: str) -> None:
        self._w.request("DELETE", f"/v1/db/{self._spec}/branches/{name}")

    def checkpoint(self, branch: str, name: str) -> dict:
        return self._w.request(
            "POST", f"/v1/db/{self._spec}/branches/{branch}/checkpoint", json={"name": name}
        ).json()

    def rewind(self, branch: str, to: Any) -> None:
        self._w.request(
            "POST", f"/v1/db/{self._spec}/branches/{branch}/rewind", json={"to": str(to)}
        )


class Db:
    """One database (``name`` or ``name@branch``) — the multi-model substrate."""

    def __init__(self, wire: _Wire, spec: str):
        self._w = wire
        self.spec = spec
        self.kv = _Kv(wire, spec)
        self.vectors = _Vectors(wire, spec)
        self.branch = _Branch(wire, spec)

    def sql(self, q: str, params: Optional[list] = None) -> dict:
        """SQL escape hatch (atomic batch of one statement)."""
        r = self._w.request(
            "POST", f"/v1/db/{self.spec}/sql", json={"stmts": [{"q": q, "params": params or []}]}
        )
        return r.json()

    def collection(self, name: str) -> Collection:
        return Collection(self._w, self.spec, name)

    def sync(self) -> int:
        """Ship this branch's state to object storage now (durability point)."""
        return self._w.txid(self._w.request("POST", f"/v1/db/{self.spec}/sync"))


class Memoturn:
    def __init__(
        self,
        url: str = "http://127.0.0.1:8080",
        *,
        token: Optional[str] = None,
        platform_key: Optional[str] = None,
        http_client: Optional[httpx.Client] = None,
    ):
        self._w = _Wire(url, token, platform_key, http_client)

    def memory(self, namespace: str, profile: str) -> MemoryProfile:
        """The memory surface: one profile per user/team/agent persona."""
        return MemoryProfile(self._w, namespace, profile)

    def profiles(self, namespace: str) -> list[dict]:
        """Profiles under a namespace (requires a namespace token)."""
        return self._w.request("GET", f"/v1/memory/{namespace}").json()["profiles"]

    def db(self, spec: str) -> Db:
        """A database / branch on the multi-model substrate."""
        return Db(self._w, spec)

    # ---- control plane (platform key) ----

    def create_database(self, name: str) -> dict:
        return self._w.request("POST", "/v1/databases", json={"name": name}, platform=True).json()

    def list_databases(self) -> list:
        return self._w.request("GET", "/v1/databases", platform=True).json()["databases"]

    def delete_database(self, name: str) -> None:
        self._w.request("DELETE", f"/v1/databases/{name}", platform=True)

    def create_token(self, db: str, scope: str, *, expires_in: Optional[int] = None) -> str:
        """Mint a per-database token (platform key)."""
        r = self._w.request(
            "POST",
            f"/v1/databases/{db}/tokens",
            json=_drop_none({"scope": scope, "expires_in": expires_in}),
            platform=True,
        )
        return r.json()["token"]

    def create_namespace_token(
        self, namespace: str, scope: str, *, expires_in: Optional[int] = None
    ) -> str:
        """Mint a namespace token covering every profile under it (platform key)."""
        r = self._w.request(
            "POST",
            f"/v1/namespaces/{namespace}/tokens",
            json=_drop_none({"scope": scope, "expires_in": expires_in}),
            platform=True,
        )
        return r.json()["token"]
