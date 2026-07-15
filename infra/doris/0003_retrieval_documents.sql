-- Retrieval / RAG analysis (Phase 1): one row per document a retriever span returned.
-- Keyed by (project_id, observation_id, rank) so the worker can explode a span's
-- retrievedDocuments[] into queryable rows. UNIQUE KEY merge-on-write with event_ts
-- keeps re-ingestion idempotent (create is authoritative; a span-update with a smaller
-- doc set leaves orphan high-rank rows — acceptable for v1).
CREATE TABLE IF NOT EXISTS retrieval_documents (
    project_id     VARCHAR(128) NOT NULL,
    observation_id VARCHAR(128) NOT NULL,
    rank           INT          NOT NULL,
    trace_id       VARCHAR(128) NOT NULL DEFAULT '',
    doc_id         VARCHAR(512) NOT NULL DEFAULT '',
    score          DOUBLE       NULL,
    content        STRING       NULL,
    metadata       STRING       NULL,
    event_ts       DATETIME(3)  NOT NULL,
    created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
)
UNIQUE KEY(project_id, observation_id, rank)
DISTRIBUTED BY HASH(observation_id) BUCKETS AUTO
PROPERTIES (
    "enable_unique_key_merge_on_write" = "true",
    "function_column.sequence_col"     = "event_ts",
    "replication_num"                  = "1"
);
