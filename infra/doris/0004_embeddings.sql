-- Embeddings analysis (Phase 2). Raw vectors are stored as ARRAY<FLOAT> in a UNIQUE KEY
-- merge-on-write table (idempotent ingest). NOTE: no ANN/HNSW index — Doris 4.x ANN
-- indexes are only supported on DUPLICATE KEY tables, which is incompatible with the
-- merge-on-write invariant ingest depends on. Similarity/dimensionality-reduction is done
-- in the TS worker instead; a future semantic-search feature would need a separate
-- DUPLICATE KEY mirror rebuilt off the ingest path.
CREATE TABLE IF NOT EXISTS embeddings (
    project_id     VARCHAR(128)  NOT NULL,
    observation_id VARCHAR(128)  NOT NULL,
    trace_id       VARCHAR(128)  NOT NULL DEFAULT '',
    kind           VARCHAR(16)   NOT NULL DEFAULT 'OBSERVATION',
    model          VARCHAR(256)  NOT NULL DEFAULT '',
    dim            INT           NOT NULL DEFAULT 0,
    vector         ARRAY<FLOAT>  NULL,
    event_ts       DATETIME(3)   NOT NULL,
    created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
)
UNIQUE KEY(project_id, observation_id)
DISTRIBUTED BY HASH(observation_id) BUCKETS AUTO
PROPERTIES (
    "enable_unique_key_merge_on_write" = "true",
    "function_column.sequence_col"     = "event_ts",
    "replication_num"                  = "1"
);

-- Reduced 2D/3D coordinates + cluster assignment produced by the worker reduction job.
-- Decoupled from `embeddings` so recompute doesn't rewrite raw vectors and multiple runs
-- coexist. Keyed by run_id so cross-run coordinates are never accidentally compared.
CREATE TABLE IF NOT EXISTS embedding_projections (
    project_id     VARCHAR(128) NOT NULL,
    run_id         VARCHAR(64)  NOT NULL,
    observation_id VARCHAR(128) NOT NULL,
    trace_id       VARCHAR(128) NOT NULL DEFAULT '',
    x              FLOAT        NOT NULL DEFAULT '0',
    y              FLOAT        NOT NULL DEFAULT '0',
    z              FLOAT        NULL,
    cluster_id     INT          NOT NULL DEFAULT '-1',
    method         VARCHAR(16)  NOT NULL DEFAULT 'umap',
    event_ts       DATETIME(3)  NOT NULL,
    created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
)
UNIQUE KEY(project_id, run_id, observation_id)
DISTRIBUTED BY HASH(observation_id) BUCKETS AUTO
PROPERTIES (
    "enable_unique_key_merge_on_write" = "true",
    "function_column.sequence_col"     = "event_ts",
    "replication_num"                  = "1"
);
