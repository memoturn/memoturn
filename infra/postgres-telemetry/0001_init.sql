-- memoturn telemetry schema (Postgres tier — ADR-0002).
--
-- Design notes:
--  * Column-for-column mirror of infra/doris/*.sql. Primary keys reproduce the Doris
--    UNIQUE KEYs — they are the LWW identity and the ON CONFLICT target. The Doris
--    sequence-column semantics (event_ts, newer-or-equal wins) are reproduced by the
--    upsert's `WHERE excluded.event_ts >= t.event_ts` guard in
--    packages/telemetry/src/postgres/serialize.ts.
--  * Timestamps are `timestamp(3)` WITHOUT time zone: rows are UTC by convention
--    (identical to Doris DATETIME(3) with sessions pinned to +00:00), and naive
--    timestamps keep to_char output independent of the session TimeZone GUC.
--  * No declarative partitioning: PG requires unique constraints on partitioned tables
--    to include the partition key, which would widen the LWW identity and let the same
--    entity id land twice. At the PG tier's envelope (ADR-0002 sizing) plain btrees
--    suffice; past it, graduate to Doris (ADR-0004).
--  * `vector` is pgvector WITHOUT a typmod — one column holds multiple embedding
--    spaces; queries must scope by (model, dim) since `<=>` errors on dim mismatch.
--  * Applied by packages/telemetry/src/postgres/migrate.ts inside one transaction per
--    file, recorded in telemetry.schema_migrations — each file runs at most once.

CREATE SCHEMA IF NOT EXISTS telemetry;
-- pgvector >= 0.7 is a trusted extension: the database owner can install it without
-- superuser, provided the shared library exists in the image (pgvector/pgvector:pg16).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS telemetry.traces (
    project_id  text          NOT NULL,
    id          text          NOT NULL,
    "timestamp" timestamp(3)  NOT NULL,
    name        text          NOT NULL DEFAULT '',
    user_id     text          NOT NULL DEFAULT '',
    session_id  text          NOT NULL DEFAULT '',
    "release"   text          NOT NULL DEFAULT '',
    version     text          NOT NULL DEFAULT '',
    environment text          NOT NULL DEFAULT 'default',
    "public"    smallint      NOT NULL DEFAULT 0,
    tags        text[]        NULL,
    metadata    text          NULL,
    input       text          NULL,
    output      text          NULL,
    event_ts    timestamp(3)  NOT NULL,
    created_at  timestamp(3)  NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS traces_project_ts_idx
    ON telemetry.traces (project_id, "timestamp" DESC, id DESC);
CREATE INDEX IF NOT EXISTS traces_project_session_idx
    ON telemetry.traces (project_id, session_id) WHERE session_id <> '';
CREATE INDEX IF NOT EXISTS traces_project_user_idx
    ON telemetry.traces (project_id, user_id) WHERE user_id <> '';

CREATE TABLE IF NOT EXISTS telemetry.observations (
    project_id            text          NOT NULL,
    trace_id              text          NOT NULL,
    id                    text          NOT NULL,
    type                  text          NOT NULL DEFAULT 'SPAN',
    parent_observation_id text          NOT NULL DEFAULT '',
    name                  text          NOT NULL DEFAULT '',
    start_time            timestamp(3)  NOT NULL,
    end_time              timestamp(3)  NULL,
    environment           text          NOT NULL DEFAULT 'default',
    level                 text          NOT NULL DEFAULT 'DEFAULT',
    status_message        text          NULL,
    model                 text          NOT NULL DEFAULT '',
    provider              text          NOT NULL DEFAULT '',
    model_parameters      text          NULL,
    prompt_tokens         bigint        NOT NULL DEFAULT 0,
    completion_tokens     bigint        NOT NULL DEFAULT 0,
    total_tokens          bigint        NOT NULL DEFAULT 0,
    cache_read_tokens     bigint        NOT NULL DEFAULT 0,
    cache_creation_tokens bigint        NOT NULL DEFAULT 0,
    input_cost            double precision NOT NULL DEFAULT 0,
    output_cost           double precision NOT NULL DEFAULT 0,
    total_cost            double precision NOT NULL DEFAULT 0,
    prompt_id             text          NOT NULL DEFAULT '',
    prompt_version        text          NOT NULL DEFAULT '',
    input                 text          NULL,
    output                text          NULL,
    metadata              text          NULL,
    latency_ms            bigint        NOT NULL DEFAULT 0,
    event_ts              timestamp(3)  NOT NULL,
    created_at            timestamp(3)  NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    PRIMARY KEY (project_id, trace_id, id)
);

CREATE INDEX IF NOT EXISTS observations_project_id_idx
    ON telemetry.observations (project_id, id);
CREATE INDEX IF NOT EXISTS observations_project_type_start_idx
    ON telemetry.observations (project_id, type, start_time);
CREATE INDEX IF NOT EXISTS observations_project_prompt_idx
    ON telemetry.observations (project_id, prompt_id) WHERE prompt_id <> '';

CREATE TABLE IF NOT EXISTS telemetry.scores (
    project_id     text          NOT NULL,
    id             text          NOT NULL,
    trace_id       text          NOT NULL DEFAULT '',
    observation_id text          NOT NULL DEFAULT '',
    name           text          NOT NULL DEFAULT '',
    "timestamp"    timestamp(3)  NOT NULL,
    environment    text          NOT NULL DEFAULT 'default',
    source         text          NOT NULL DEFAULT 'API',
    data_type      text          NOT NULL DEFAULT 'NUMERIC',
    "value"        double precision NULL,
    string_value   text          NULL,
    "comment"      text          NULL,
    config_id      text          NOT NULL DEFAULT '',
    event_ts       timestamp(3)  NOT NULL,
    created_at     timestamp(3)  NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS scores_project_trace_idx
    ON telemetry.scores (project_id, trace_id);
CREATE INDEX IF NOT EXISTS scores_project_ts_idx
    ON telemetry.scores (project_id, "timestamp");

CREATE TABLE IF NOT EXISTS telemetry.retrieval_documents (
    project_id     text          NOT NULL,
    observation_id text          NOT NULL,
    rank           integer       NOT NULL,
    trace_id       text          NOT NULL DEFAULT '',
    doc_id         text          NOT NULL DEFAULT '',
    score          double precision NULL,
    content        text          NULL,
    metadata       text          NULL,
    event_ts       timestamp(3)  NOT NULL,
    created_at     timestamp(3)  NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    PRIMARY KEY (project_id, observation_id, rank)
);

CREATE INDEX IF NOT EXISTS retrieval_documents_project_trace_idx
    ON telemetry.retrieval_documents (project_id, trace_id);

CREATE TABLE IF NOT EXISTS telemetry.embeddings (
    project_id     text          NOT NULL,
    observation_id text          NOT NULL,
    trace_id       text          NOT NULL DEFAULT '',
    kind           text          NOT NULL DEFAULT 'OBSERVATION',
    model          text          NOT NULL DEFAULT '',
    dim            integer       NOT NULL DEFAULT 0,
    vector         vector        NULL,
    event_ts       timestamp(3)  NOT NULL,
    created_at     timestamp(3)  NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    PRIMARY KEY (project_id, observation_id)
);

CREATE INDEX IF NOT EXISTS embeddings_project_trace_idx
    ON telemetry.embeddings (project_id, trace_id);
CREATE INDEX IF NOT EXISTS embeddings_project_space_idx
    ON telemetry.embeddings (project_id, model, dim);
CREATE INDEX IF NOT EXISTS embeddings_project_event_ts_idx
    ON telemetry.embeddings (project_id, event_ts DESC);

CREATE TABLE IF NOT EXISTS telemetry.embedding_projections (
    project_id     text          NOT NULL,
    run_id         text          NOT NULL,
    observation_id text          NOT NULL,
    trace_id       text          NOT NULL DEFAULT '',
    x              double precision NOT NULL DEFAULT 0,
    y              double precision NOT NULL DEFAULT 0,
    z              double precision NULL,
    cluster_id     integer       NOT NULL DEFAULT -1,
    method         text          NOT NULL DEFAULT 'umap',
    event_ts       timestamp(3)  NOT NULL,
    created_at     timestamp(3)  NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    PRIMARY KEY (project_id, run_id, observation_id)
);

CREATE INDEX IF NOT EXISTS embedding_projections_project_trace_idx
    ON telemetry.embedding_projections (project_id, trace_id);
CREATE INDEX IF NOT EXISTS embedding_projections_project_event_ts_idx
    ON telemetry.embedding_projections (project_id, event_ts DESC);

-- Safe JSON accessors over text columns that may hold malformed JSON. Doris's
-- get_json_string returns NULL for bad JSON or a missing key; a bare ::jsonb cast in
-- PG would throw and fail the whole query. Pure SQL via pg_input_is_valid (PG16) so
-- the planner can inline them — no plpgsql subtransaction per row on scan paths.
-- `path` is a dotted key path ('a.b'), mirroring Doris's '$.a.b'.
CREATE OR REPLACE FUNCTION telemetry.json_text(doc text, path text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
    WHEN doc IS NOT NULL AND pg_input_is_valid(doc, 'jsonb')
      THEN doc::jsonb #>> string_to_array(path, '.')
  END
$fn$;

CREATE OR REPLACE FUNCTION telemetry.json_number(doc text, path text)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE WHEN v IS NOT NULL AND pg_input_is_valid(v, 'float8') THEN v::float8 END
  FROM (SELECT telemetry.json_text(doc, path) AS v) s
$fn$;
