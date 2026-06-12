"""One request-spec builder per API operation — the single source of truth
for paths, bodies, and response parsing, shared by the sync and async
clients. Each builder returns an :class:`Op`; the transports only differ in
how they send it."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from urllib.parse import quote

import httpx


def _drop_none(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


def _txid(resp: httpx.Response) -> int:
    return int(resp.headers.get("Memoturn-Txid", 0))


def _json(resp: httpx.Response) -> Any:
    return resp.json()


def _json_with_txid(resp: httpx.Response) -> Any:
    return {**resp.json(), "txid": _txid(resp)}


def _nothing(resp: httpx.Response) -> None:
    return None


def _key(name: str) -> Callable[[httpx.Response], Any]:
    return lambda resp: resp.json()[name]


@dataclass
class Op:
    method: str
    path: str
    json: Any = None
    content: Optional[str] = None
    platform: bool = False
    #: Lookup-by-id ops resolve a 404 to None instead of raising.
    none_on_404: bool = False
    parse: Callable[[httpx.Response], Any] = field(default=_json)


def _branch_qs(branch: Optional[str]) -> str:
    return f"?branch={branch}" if branch else ""


# ---- transcript ----


def turn_append(db: str, session_id: str, role: str, content: Any, embedding) -> Op:
    return Op(
        "POST",
        f"/v1/db/{db}/memory/{session_id}/turns",
        json=_drop_none({"role": role, "content": content, "embedding": embedding}),
        parse=_json_with_txid,
    )


def turn_window(db: str, session_id: str, last: int) -> Op:
    return Op("GET", f"/v1/db/{db}/memory/{session_id}/turns?last={last}", parse=_key("turns"))


def turn_search(db: str, session_id: str, vector, k: int) -> Op:
    return Op(
        "POST",
        f"/v1/db/{db}/memory/{session_id}/search",
        json={"vector": vector, "k": k},
        parse=_key("turns"),
    )


# ---- agent memory ----


def memories_ingest(ns: str, profile: str, branch, memories: list) -> Op:
    return Op(
        "POST",
        f"/v1/memory/{ns}/{profile}/memories{_branch_qs(branch)}",
        json={"memories": memories},
        parse=_json_with_txid,
    )


def memories_recall(ns: str, profile: str, branch, body: dict) -> Op:
    return Op("POST", f"/v1/memory/{ns}/{profile}/recall{_branch_qs(branch)}", json=body)


def memories_ask(ns: str, profile: str, branch, body: dict) -> Op:
    return Op("POST", f"/v1/memory/{ns}/{profile}/ask{_branch_qs(branch)}", json=body)


def memories_extract(ns: str, profile: str, branch, body: dict) -> Op:
    return Op("POST", f"/v1/memory/{ns}/{profile}/extract{_branch_qs(branch)}", json=body)


def memory_get(ns: str, profile: str, branch, memory_id: str) -> Op:
    return Op(
        "GET",
        f"/v1/memory/{ns}/{profile}/memories/{memory_id}{_branch_qs(branch)}",
        none_on_404=True,
    )


def memory_forget(ns: str, profile: str, branch, memory_id: str) -> Op:
    # parse=True / 404→None lets the caller surface a found/not-found bool.
    return Op(
        "DELETE",
        f"/v1/memory/{ns}/{profile}/memories/{memory_id}{_branch_qs(branch)}",
        none_on_404=True,
        parse=lambda _resp: True,
    )


def erase(ns: str, profile: str, branch, body: dict) -> Op:
    return Op("POST", f"/v1/memory/{ns}/{profile}/erasures{_branch_qs(branch)}", json=body)


def erasures_list(ns: str, profile: str, branch) -> Op:
    return Op(
        "GET", f"/v1/memory/{ns}/{profile}/erasures{_branch_qs(branch)}", parse=_key("erasures")
    )


def erasure_get(ns: str, profile: str, branch, erasure_id: str) -> Op:
    return Op(
        "GET",
        f"/v1/memory/{ns}/{profile}/erasures/{erasure_id}{_branch_qs(branch)}",
        none_on_404=True,
    )


def sessions_list(ns: str, profile: str, branch) -> Op:
    return Op(
        "GET", f"/v1/memory/{ns}/{profile}/sessions{_branch_qs(branch)}", parse=_key("sessions")
    )


def session_end(ns: str, profile: str, branch, session_id: str, turns: bool) -> Op:
    qs = _branch_qs(branch)
    suffix = (("&" if qs else "?") + "turns=true") if turns else ""
    return Op(
        "DELETE",
        f"/v1/memory/{ns}/{profile}/sessions/{session_id}{qs}{suffix}",
        parse=_nothing,
    )


def profiles_list(ns: str) -> Op:
    return Op("GET", f"/v1/memory/{ns}", parse=_key("profiles"))


# ---- branching (shared by MemoryProfile and Db) ----


def branch_create(spec: str, name: str, from_branch, ttl) -> Op:
    return Op(
        "POST",
        f"/v1/db/{spec}/branches",
        json=_drop_none({"name": name, "from": from_branch, "ttl": ttl}),
    )


def branch_list(spec: str) -> Op:
    return Op("GET", f"/v1/db/{spec}/branches", parse=_key("branches"))


def branch_delete(spec: str, name: str) -> Op:
    return Op("DELETE", f"/v1/db/{spec}/branches/{name}", parse=_nothing)


def checkpoint(spec: str, branch: str, name: str) -> Op:
    return Op("POST", f"/v1/db/{spec}/branches/{branch}/checkpoint", json={"name": name})


def rewind(spec: str, branch: str, to: Any) -> Op:
    return Op(
        "POST",
        f"/v1/db/{spec}/branches/{branch}/rewind",
        json={"to": str(to)},
        parse=_nothing,
    )


# ---- substrate: kv / docs / vectors / sql ----


def kv_put(spec: str, ns: str, key: str, value: str, ttl) -> Op:
    qs = f"?ttl={ttl}" if ttl is not None else ""
    return Op("PUT", f"/v1/db/{spec}/kv/{ns}/{key}{qs}", content=value, parse=_txid)


def kv_get(spec: str, ns: str, key: str) -> Op:
    return Op(
        "GET", f"/v1/db/{spec}/kv/{ns}/{key}", none_on_404=True, parse=lambda resp: resp.text
    )


def kv_delete(spec: str, ns: str, key: str) -> Op:
    return Op("DELETE", f"/v1/db/{spec}/kv/{ns}/{key}", parse=_nothing)


def kv_list(spec: str, ns: str, prefix: str, limit: int) -> Op:
    return Op("GET", f"/v1/db/{spec}/kv/{ns}?prefix={prefix}&limit={limit}", parse=_key("keys"))


def docs_insert(spec: str, coll: str, docs: list) -> Op:
    return Op(
        "POST", f"/v1/db/{spec}/docs/{coll}/insert", json={"docs": docs}, parse=_json_with_txid
    )


def docs_find(spec: str, coll: str, filter, sort, limit, skip) -> Op:
    return Op(
        "POST",
        f"/v1/db/{spec}/docs/{coll}/find",
        json=_drop_none({"filter": filter or {}, "sort": sort, "limit": limit, "skip": skip}),
        parse=_key("docs"),
    )


def docs_update(spec: str, coll: str, filter: dict, update: dict, multi: bool) -> Op:
    return Op(
        "POST",
        f"/v1/db/{spec}/docs/{coll}/update",
        json={"filter": filter, "update": update, "multi": multi},
    )


def docs_delete(spec: str, coll: str, filter: dict, multi: bool) -> Op:
    return Op(
        "POST", f"/v1/db/{spec}/docs/{coll}/delete", json={"filter": filter, "multi": multi}
    )


def docs_create_index(spec: str, coll: str, path: str) -> Op:
    return Op("POST", f"/v1/db/{spec}/docs/{coll}/indexes", json={"path": path}, parse=_nothing)


def vectors_upsert(spec: str, collection: str, id: str, embedding) -> Op:
    return Op(
        "POST",
        f"/v1/db/{spec}/vectors/{collection}",
        json={"id": id, "embedding": embedding},
        parse=_txid,
    )


def vectors_search(spec: str, collection: str, vector, k: int) -> Op:
    return Op(
        "POST",
        f"/v1/db/{spec}/vectors/{collection}/search",
        json={"vector": vector, "k": k},
        parse=_key("hits"),
    )


def sql(spec: str, q: str, params) -> Op:
    return Op("POST", f"/v1/db/{spec}/sql", json={"stmts": [{"q": q, "params": params or []}]})


def sync_db(spec: str) -> Op:
    return Op("POST", f"/v1/db/{spec}/sync", parse=_txid)


# ---- control plane ----


def db_create(name: str) -> Op:
    return Op("POST", "/v1/databases", json={"name": name}, platform=True)


def db_list() -> Op:
    return Op("GET", "/v1/databases", platform=True, parse=_key("databases"))


def db_delete(name: str) -> Op:
    return Op("DELETE", f"/v1/databases/{name}", platform=True, parse=_nothing)


def token_create(db: str, scope: str, expires_in) -> Op:
    return Op(
        "POST",
        f"/v1/databases/{db}/tokens",
        json=_drop_none({"scope": scope, "expires_in": expires_in}),
        platform=True,
        parse=_key("token"),
    )


def ns_token_create(ns: str, scope: str, expires_in) -> Op:
    return Op(
        "POST",
        f"/v1/namespaces/{ns}/tokens",
        json=_drop_none({"scope": scope, "expires_in": expires_in}),
        platform=True,
        parse=_key("token"),
    )


# ---- governance ----


def ns_policy_get(ns: str) -> Op:
    return Op("GET", f"/v1/namespaces/{ns}/policy", platform=True, none_on_404=True)


def ns_policy_set(ns: str, policy) -> Op:
    return Op("PUT", f"/v1/namespaces/{ns}/policy", json={"policy": policy}, platform=True)


def profile_policy_get(ns: str, profile: str) -> Op:
    return Op("GET", f"/v1/memory/{ns}/{profile}/policy")


def profile_policy_set(ns: str, profile: str, policy) -> Op:
    return Op("PUT", f"/v1/memory/{ns}/{profile}/policy", json={"policy": policy})


def audit_page(ns: str, params: dict) -> Op:
    qs = "&".join(f"{k}={quote(str(v), safe='')}" for k, v in _drop_none(params).items())
    return Op("GET", f"/v1/namespaces/{ns}/audit" + (f"?{qs}" if qs else ""), platform=True)


# ---- shared request-body builders ----


def recall_body(
    query, embedding, topic_key, types, session_id, source, k, include_superseded, include_turns
) -> dict:
    return _drop_none(
        {
            "query": query,
            "embedding": embedding,
            "topic_key": topic_key,
            "types": types,
            "session_id": session_id,
            "source": source,
            "k": k,
            "include_superseded": include_superseded,
            "include_turns": include_turns,
        }
    )


def ask_body(question, types, session_id, source, k, include_superseded) -> dict:
    return _drop_none(
        {
            "question": question,
            "types": types,
            "session_id": session_id,
            "source": source,
            "k": k,
            "include_superseded": include_superseded,
        }
    )


def extract_body(turns, session_id, source, dry_run) -> dict:
    return _drop_none(
        {"turns": turns, "session_id": session_id, "source": source, "dry_run": dry_run}
    )


def erase_body(memory_id, topic_key, type, session_id, turns) -> dict:
    return _drop_none(
        {
            "memory_id": memory_id,
            "topic_key": topic_key,
            "type": type,
            "session_id": session_id,
            "turns": turns or None,
        }
    )


def with_default_source(memories: list, source: Optional[str]) -> list:
    if source is None:
        return memories
    return [m if m.get("source") is not None else {**m, "source": source} for m in memories]
