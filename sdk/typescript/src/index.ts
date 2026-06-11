/**
 * Memoturn TypeScript SDK — memory for AI agents.
 *
 * The headline surface is agent memory (docs/architecture/07): typed memories
 * with supersession and hybrid recall, organized `namespace > profile > memory`
 * where a profile is one Memoturn database every agent serving that user shares.
 * The multi-model substrate (docs/KV/SQL/vectors/transcript, branching) is
 * exposed on `db()` (docs/architecture/04).
 *
 * Zero dependencies; uses global `fetch` (Node 18+, browsers, workers).
 *
 * ```ts
 * const mt = memoturn({ url, token });
 * const alice = mt.memory("acme", "alice");
 * await alice.ingest([{ type: "fact", topicKey: "user.diet",
 *                       summary: "vegetarian since 2024", content: { diet: "vegetarian" } }]);
 * const { memories } = await alice.recall({ query: "what can this user eat?" });
 * ```
 */

export interface MemoturnOptions {
  /** Base URL of a memoturnd node / gateway (default http://127.0.0.1:8080). */
  url?: string;
  /** Per-database or namespace JWT for data-plane calls. */
  token?: string;
  /** Platform key for control-plane calls (databases, token minting). */
  platformKey?: string;
  /** Default provenance for ingested memories (e.g. "claude-code") —
   * applied when a memory doesn't carry its own `source`. */
  source?: string;
  /** Custom fetch (tests, polyfills). */
  fetch?: typeof globalThis.fetch;
}

export type Scope = "read" | "write" | "admin";
export type MemoryType = "fact" | "event" | "instruction" | "task";

export interface MemoryInput {
  type: MemoryType;
  /** Supersession key for fact/instruction (e.g. "user.diet"). */
  topicKey?: string;
  /** One-line gist; keyword-searchable. */
  summary: string;
  /** Full memory payload (JSON). */
  content: unknown;
  /** Extra space-separated search terms. */
  keywords?: string;
  /** Bring-your-own embedding (skipped for tasks). */
  embedding?: number[];
  sessionId?: string;
  /** Originating agent ("claude-code", "cursor", …). Provenance, not
   * identity: the same memory from two agents dedupes; first writer wins. */
  source?: string;
  /** Task lifetime in seconds (default 86400). */
  ttl?: number;
}

export interface IngestResult {
  id: string;
  status: "created" | "duplicate";
  superseded: string[];
}

export interface RecallQuery {
  /** Free text for the keyword channel. */
  query?: string;
  /** Vector for the ANN channel. */
  embedding?: number[];
  /** Exact-match channel (weighted highest). */
  topicKey?: string;
  types?: MemoryType[];
  sessionId?: string;
  /** Only recall memories ingested by this agent (e.g. "claude-code"). */
  source?: string;
  /** Max results (default 8). */
  k?: number;
  includeSuperseded?: boolean;
  /** Also search the verbatim transcript (requires `embedding`); results
   * arrive in a separate `turns` array. */
  includeTurns?: boolean;
}

export interface AskResult {
  /** Grounded prose answer, or null when nothing relevant was recalled. */
  answer: string | null;
  /** Ids of the recalled memories the answer rests on. */
  sources: string[];
  /** The recalled memories themselves, for attribution/display. */
  memories: Memory[];
}

export interface Turn {
  session_id: string;
  seq: number;
  role: string;
  content: unknown;
  distance: number;
}

export interface Memory {
  id: string;
  type: MemoryType;
  topic_key: string | null;
  summary: string;
  content: unknown;
  keywords: string | null;
  session_id: string | null;
  source: string | null;
  created_at: number;
  superseded_by: string | null;
  /** Recall only: fused relevance score and contributing channels. */
  score?: number;
  channels?: string[];
  /** get() only: ids this memory superseded. */
  supersedes?: string[];
}

export interface Txid {
  txid: number;
}

export class MemoturnError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(`Memoturn ${status}: ${message}`);
    this.name = "MemoturnError";
  }
}

interface Wire {
  request(
    method: string,
    path: string,
    opts?: { body?: unknown; raw?: string; platform?: boolean; headers?: Record<string, string> },
  ): Promise<{ status: number; txid: number; json: any; text: string }>;
}

function wire(o: MemoturnOptions): Wire {
  const base = (o.url ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
  const f = o.fetch ?? globalThis.fetch;
  return {
    async request(method, path, opts = {}) {
      const cred = opts.platform ? (o.platformKey ?? o.token) : (o.token ?? o.platformKey);
      const headers: Record<string, string> = { ...opts.headers };
      if (cred) headers.authorization = `Bearer ${cred}`;
      let body: string | undefined;
      if (opts.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(opts.body);
      } else if (opts.raw !== undefined) {
        body = opts.raw;
      }
      const res = await f(`${base}${path}`, { method, headers, body });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      if (!res.ok) throw new MemoturnError(res.status, json?.error ?? text);
      const txid = Number(res.headers.get("Memoturn-Txid") ?? json?.txid ?? 0);
      return { status: res.status, txid, json, text };
    },
  };
}

/** Camel-case inputs → wire shape. */
function toWireMemory(m: MemoryInput, defaultSource?: string) {
  return {
    type: m.type,
    topic_key: m.topicKey,
    summary: m.summary,
    content: m.content,
    keywords: m.keywords,
    embedding: m.embedding,
    session_id: m.sessionId,
    source: m.source ?? defaultSource,
    ttl: m.ttl,
  };
}

/**
 * One memory profile: the isolated store every agent serving this
 * user/team/persona shares. Backed by its own database (`{ns}--{profile}`),
 * so `checkpoint`/`rewind`/`fork` operate on the whole memory atomically.
 */
export class MemoryProfile {
  constructor(
    private w: Wire,
    readonly namespace: string,
    readonly profile: string,
    private branch?: string,
    private defaultSource?: string,
  ) {}

  private get db(): string {
    return `${this.namespace}--${this.profile}`;
  }

  private qs(): string {
    return this.branch ? `?branch=${encodeURIComponent(this.branch)}` : "";
  }

  /** Address a branch of this profile's memory (burner experiments). */
  onBranch(branch: string): MemoryProfile {
    return new MemoryProfile(this.w, this.namespace, this.profile, branch, this.defaultSource);
  }

  /** Idempotent batch ingest; the profile auto-creates on first call. */
  async ingest(memories: MemoryInput[]): Promise<{ results: IngestResult[] } & Txid> {
    const r = await this.w.request(
      "POST",
      `/v1/memory/${this.namespace}/${this.profile}/memories${this.qs()}`,
      { body: { memories: memories.map((m) => toWireMemory(m, this.defaultSource)) } },
    );
    return { results: r.json.results, txid: r.txid };
  }

  /** Hybrid recall; empty result means nothing relevant (never pads). */
  async recall(q: RecallQuery): Promise<{ memories: Memory[]; turns?: Turn[] } & Txid> {
    const r = await this.w.request(
      "POST",
      `/v1/memory/${this.namespace}/${this.profile}/recall${this.qs()}`,
      {
        body: {
          query: q.query,
          embedding: q.embedding,
          topic_key: q.topicKey,
          types: q.types,
          session_id: q.sessionId,
          source: q.source,
          k: q.k,
          include_superseded: q.includeSuperseded,
          include_turns: q.includeTurns,
        },
      },
    );
    return { memories: r.json.memories, turns: r.json.turns, txid: r.txid };
  }

  /** Ask a natural-language question over this profile's memories: hybrid
   * recall, then the node's assistant synthesizes a prose answer citing the
   * supporting memory ids (opt-in node feature). `answer` is null when
   * nothing relevant was recalled. Throws MemoturnError 503 when the node
   * has no assistant — fall back to `recall()` and synthesize yourself. */
  async ask(
    question: string,
    opts?: {
      types?: MemoryType[];
      sessionId?: string;
      /** Only consider memories ingested by this agent. */
      source?: string;
      k?: number;
      includeSuperseded?: boolean;
    },
  ): Promise<AskResult & Txid> {
    const r = await this.w.request(
      "POST",
      `/v1/memory/${this.namespace}/${this.profile}/ask${this.qs()}`,
      {
        body: {
          question,
          types: opts?.types,
          session_id: opts?.sessionId,
          source: opts?.source,
          k: opts?.k,
          include_superseded: opts?.includeSuperseded,
        },
      },
    );
    return { answer: r.json.answer, sources: r.json.sources, memories: r.json.memories, txid: r.txid };
  }

  /** One memory with its supersession chain, or null. */
  async get(id: string): Promise<Memory | null> {
    try {
      const r = await this.w.request(
        "GET",
        `/v1/memory/${this.namespace}/${this.profile}/memories/${id}${this.qs()}`,
      );
      return r.json;
    } catch (e) {
      if (e instanceof MemoturnError && e.status === 404) return null;
      throw e;
    }
  }

  /** Server-side extraction (opt-in node feature): distill raw turns into
   * typed memories with a control-plane LLM, then ingest. `dryRun` returns
   * the proposals without writing. 503 when the node has no extractor. */
  async extract(
    turns: { role: string; content: unknown }[],
    opts?: { sessionId?: string; source?: string; dryRun?: boolean },
  ): Promise<{ results?: IngestResult[]; proposed?: unknown[]; txid?: number }> {
    const r = await this.w.request(
      "POST",
      `/v1/memory/${this.namespace}/${this.profile}/extract${this.qs()}`,
      {
        body: {
          turns,
          session_id: opts?.sessionId,
          source: opts?.source ?? this.defaultSource,
          dry_run: opts?.dryRun,
        },
      },
    );
    return { results: r.json.results, proposed: r.json.proposed, txid: r.txid };
  }

  /** Hard delete (supersession already preserves history without this). */
  async forget(id: string): Promise<boolean> {
    try {
      await this.w.request(
        "DELETE",
        `/v1/memory/${this.namespace}/${this.profile}/memories/${id}${this.qs()}`,
      );
      return true;
    } catch (e) {
      if (e instanceof MemoturnError && e.status === 404) return false;
      throw e;
    }
  }

  async sessions(): Promise<{ id: string; created_at: number; last_active_at: number }[]> {
    const r = await this.w.request(
      "GET",
      `/v1/memory/${this.namespace}/${this.profile}/sessions${this.qs()}`,
    );
    return r.json.sessions;
  }

  /** End a session: its task memories go; pass `turns` to drop the transcript. */
  async endSession(sessionId: string, opts?: { turns?: boolean }): Promise<void> {
    const sep = this.qs() ? "&" : "?";
    const turns = opts?.turns ? `${sep}turns=true` : "";
    await this.w.request(
      "DELETE",
      `/v1/memory/${this.namespace}/${this.profile}/sessions/${sessionId}${this.qs()}${turns}`,
    );
  }

  /** Checkpoint the whole memory (requires admin scope). */
  async checkpoint(name: string): Promise<Txid> {
    const r = await this.w.request(
      "POST",
      `/v1/db/${this.db}/branches/${this.branch ?? "main"}/checkpoint`,
      { body: { name } },
    );
    return { txid: r.json.txid };
  }

  /** Rewind the whole memory to a checkpoint or txid (admin scope). */
  async rewind(to: string | number): Promise<void> {
    await this.w.request("POST", `/v1/db/${this.db}/branches/${this.branch ?? "main"}/rewind`, {
      body: { to: String(to) },
    });
  }

  /** Fork the memory copy-on-write; `ttl` makes it a burner branch. */
  async fork(branch: string, opts?: { from?: string; ttl?: number }): Promise<MemoryProfile> {
    await this.w.request("POST", `/v1/db/${this.db}/branches`, {
      body: { name: branch, from: opts?.from ?? this.branch, ttl: opts?.ttl },
    });
    return this.onBranch(branch);
  }

  /** The raw conversation transcript layer for one session. */
  session(sessionId: string): TranscriptSession {
    return new TranscriptSession(this.w, this.db, sessionId);
  }
}

/** Append-only verbatim transcript (`__memoturn_messages`) for one session. */
export class TranscriptSession {
  constructor(
    private w: Wire,
    private db: string,
    readonly sessionId: string,
  ) {}

  async appendTurn(turn: {
    role: string;
    content: unknown;
    embedding?: number[];
  }): Promise<{ seq: number } & Txid> {
    const r = await this.w.request("POST", `/v1/db/${this.db}/memory/${this.sessionId}/turns`, {
      body: turn,
    });
    return { seq: r.json.seq, txid: r.txid };
  }

  async getWindow(opts?: { last?: number }): Promise<unknown[]> {
    const r = await this.w.request(
      "GET",
      `/v1/db/${this.db}/memory/${this.sessionId}/turns?last=${opts?.last ?? 20}`,
    );
    return r.json.turns;
  }

  async searchSemantic(vector: number[], opts?: { k?: number }): Promise<unknown[]> {
    const r = await this.w.request("POST", `/v1/db/${this.db}/memory/${this.sessionId}/search`, {
      body: { vector, k: opts?.k },
    });
    return r.json.turns;
  }
}

export class Collection {
  constructor(
    private w: Wire,
    private db: string,
    readonly name: string,
  ) {}

  async insert(docs: Record<string, unknown>[]): Promise<{ ids: string[] } & Txid> {
    const r = await this.w.request("POST", `/v1/db/${this.db}/docs/${this.name}/insert`, {
      body: { docs },
    });
    return { ids: r.json.ids, txid: r.txid };
  }

  async find(
    filter: Record<string, unknown> = {},
    opts?: { sort?: Record<string, number>; limit?: number; skip?: number },
  ): Promise<Record<string, unknown>[]> {
    const r = await this.w.request("POST", `/v1/db/${this.db}/docs/${this.name}/find`, {
      body: { filter, ...opts },
    });
    return r.json.docs;
  }

  async update(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    opts?: { multi?: boolean },
  ): Promise<{ modified: number } & Txid> {
    const r = await this.w.request("POST", `/v1/db/${this.db}/docs/${this.name}/update`, {
      body: { filter, update, multi: opts?.multi },
    });
    return { modified: r.json.modified, txid: r.txid };
  }

  async delete(
    filter: Record<string, unknown>,
    opts?: { multi?: boolean },
  ): Promise<{ deleted: number } & Txid> {
    const r = await this.w.request("POST", `/v1/db/${this.db}/docs/${this.name}/delete`, {
      body: { filter, multi: opts?.multi },
    });
    return { deleted: r.json.deleted, txid: r.txid };
  }

  async createIndex(path: string): Promise<void> {
    await this.w.request("POST", `/v1/db/${this.db}/docs/${this.name}/indexes`, {
      body: { path },
    });
  }
}

/** One database (`name` or `name@branch`) — the multi-model substrate. */
export class Db {
  readonly kv: {
    put(ns: string, key: string, value: string, opts?: { ttl?: number }): Promise<Txid>;
    get(ns: string, key: string): Promise<string | null>;
    delete(ns: string, key: string): Promise<void>;
    list(ns: string, opts?: { prefix?: string; limit?: number }): Promise<string[]>;
  };
  readonly vectors: {
    upsert(collection: string, id: string, embedding: number[]): Promise<Txid>;
    search(
      collection: string,
      vector: number[],
      opts?: { k?: number },
    ): Promise<{ id: string; distance: number }[]>;
  };
  readonly branch: {
    create(name: string, opts?: { from?: string; ttl?: number }): Promise<unknown>;
    list(): Promise<unknown[]>;
    delete(name: string): Promise<void>;
    checkpoint(branch: string, name: string): Promise<Txid>;
    rewind(branch: string, to: string | number): Promise<void>;
  };

  constructor(
    private w: Wire,
    readonly spec: string,
  ) {
    const enc = encodeURIComponent;
    this.kv = {
      put: async (ns, key, value, opts) => {
        const qs = opts?.ttl !== undefined ? `?ttl=${opts.ttl}` : "";
        const r = await w.request("PUT", `/v1/db/${spec}/kv/${ns}/${enc(key)}${qs}`, {
          raw: value,
        });
        return { txid: r.txid };
      },
      get: async (ns, key) => {
        try {
          const r = await w.request("GET", `/v1/db/${spec}/kv/${ns}/${enc(key)}`);
          return r.text;
        } catch (e) {
          if (e instanceof MemoturnError && e.status === 404) return null;
          throw e;
        }
      },
      delete: async (ns, key) => {
        await w.request("DELETE", `/v1/db/${spec}/kv/${ns}/${enc(key)}`);
      },
      list: async (ns, opts) => {
        const qs = `?prefix=${enc(opts?.prefix ?? "")}&limit=${opts?.limit ?? 100}`;
        const r = await w.request("GET", `/v1/db/${spec}/kv/${ns}${qs}`);
        return r.json.keys;
      },
    };
    this.vectors = {
      upsert: async (collection, id, embedding) => {
        const r = await w.request("POST", `/v1/db/${spec}/vectors/${collection}`, {
          body: { id, embedding },
        });
        return { txid: r.txid };
      },
      search: async (collection, vector, opts) => {
        const r = await w.request("POST", `/v1/db/${spec}/vectors/${collection}/search`, {
          body: { vector, k: opts?.k },
        });
        return r.json.hits;
      },
    };
    this.branch = {
      create: async (name, opts) => {
        const r = await w.request("POST", `/v1/db/${spec}/branches`, {
          body: { name, from: opts?.from, ttl: opts?.ttl },
        });
        return r.json;
      },
      list: async () => {
        const r = await w.request("GET", `/v1/db/${spec}/branches`);
        return r.json.branches;
      },
      delete: async (name) => {
        await w.request("DELETE", `/v1/db/${spec}/branches/${name}`);
      },
      checkpoint: async (branch, name) => {
        const r = await w.request("POST", `/v1/db/${spec}/branches/${branch}/checkpoint`, {
          body: { name },
        });
        return { txid: r.json.txid };
      },
      rewind: async (branch, to) => {
        await w.request("POST", `/v1/db/${spec}/branches/${branch}/rewind`, {
          body: { to: String(to) },
        });
      },
    };
  }

  /** SQL escape hatch (atomic batch). */
  async sql(q: string, params?: unknown[]): Promise<{ results: unknown[] } & Txid> {
    const r = await this.w.request("POST", `/v1/db/${this.spec}/sql`, {
      body: { stmts: [{ q, params: params ?? [] }] },
    });
    return { results: r.json.results, txid: r.txid };
  }

  collection(name: string): Collection {
    return new Collection(this.w, this.spec, name);
  }

  /** Ship this branch's state to object storage now (durability point). */
  async sync(): Promise<Txid> {
    const r = await this.w.request("POST", `/v1/db/${this.spec}/sync`);
    return { txid: r.json.txid };
  }
}

export class Memoturn {
  private w: Wire;
  private source?: string;

  constructor(opts: MemoturnOptions = {}) {
    this.w = wire(opts);
    this.source = opts.source;
  }

  /** The memory surface: one profile per user/team/agent persona. */
  memory(namespace: string, profile: string): MemoryProfile {
    return new MemoryProfile(this.w, namespace, profile, undefined, this.source);
  }

  /** Profiles under a namespace (requires a namespace token). */
  async profiles(namespace: string): Promise<{ profile: string; created_at: number }[]> {
    const r = await this.w.request("GET", `/v1/memory/${namespace}`);
    return r.json.profiles;
  }

  /** A database / branch on the multi-model substrate. */
  db(spec: string): Db {
    return new Db(this.w, spec);
  }

  /** Control plane (platform key). */
  readonly databases = {
    create: async (name: string): Promise<unknown> => {
      const r = await this.w.request("POST", "/v1/databases", {
        body: { name },
        platform: true,
      });
      return r.json;
    },
    list: async (): Promise<unknown[]> => {
      const r = await this.w.request("GET", "/v1/databases", { platform: true });
      return r.json.databases;
    },
    delete: async (name: string): Promise<void> => {
      await this.w.request("DELETE", `/v1/databases/${name}`, { platform: true });
    },
  };

  /** Mint a per-database token (platform key). */
  async createToken(db: string, scope: Scope, opts?: { expiresIn?: number }): Promise<string> {
    const r = await this.w.request("POST", `/v1/databases/${db}/tokens`, {
      body: { scope, expires_in: opts?.expiresIn },
      platform: true,
    });
    return r.json.token;
  }

  /** Mint a namespace token covering every profile under it (platform key). */
  async createNamespaceToken(
    namespace: string,
    scope: Scope,
    opts?: { expiresIn?: number },
  ): Promise<string> {
    const r = await this.w.request("POST", `/v1/namespaces/${namespace}/tokens`, {
      body: { scope, expires_in: opts?.expiresIn },
      platform: true,
    });
    return r.json.token;
  }
}

export function memoturn(opts: MemoturnOptions = {}): Memoturn {
  return new Memoturn(opts);
}
