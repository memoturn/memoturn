-- memoturn telemetry schema (Apache Doris).
--
-- Design notes:
--  * traces/observations/scores are UNIQUE KEY tables with merge-on-write and a
--    sequence column (event_ts): re-inserting an entity id with a newer event_ts
--    overwrites it (last-writer-wins), which makes ingest retries and score
--    corrections idempotent — no FINAL-style read modifier needed.
--  * Every key leads with project_id: multi-tenant isolation is enforced by the
--    sort/dedup key itself.
--  * Large input/output payloads live in blob storage; rows only keep a small
--    reference marker (see apps/worker offloadLargePayload).
--  * replication_num=1 suits the single-BE default deployment; raise it for
--    multi-BE clusters (see docs/analytics-engine.md).
--  * Applied by packages/telemetry/src/migrate.ts, which records each file in
--    schema_migrations — statements here run at most once per deployment.

CREATE TABLE IF NOT EXISTS traces (
    project_id  VARCHAR(128)  NOT NULL,
    id          VARCHAR(128)  NOT NULL,
    `timestamp` DATETIME(3)   NOT NULL,
    name        VARCHAR(1024) NOT NULL DEFAULT '',
    user_id     VARCHAR(512)  NOT NULL DEFAULT '',
    session_id  VARCHAR(512)  NOT NULL DEFAULT '',
    `release`   VARCHAR(256)  NOT NULL DEFAULT '',
    version     VARCHAR(256)  NOT NULL DEFAULT '',
    environment VARCHAR(128)  NOT NULL DEFAULT 'default',
    `public`    TINYINT       NOT NULL DEFAULT '0',
    tags        ARRAY<STRING> NULL,
    metadata    STRING        NULL,
    input       STRING        NULL,
    output      STRING        NULL,
    event_ts    DATETIME(3)   NOT NULL,
    created_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
)
UNIQUE KEY(project_id, id)
DISTRIBUTED BY HASH(id) BUCKETS AUTO
PROPERTIES (
    "enable_unique_key_merge_on_write" = "true",
    "function_column.sequence_col"     = "event_ts",
    "replication_num"                  = "1"
);

CREATE TABLE IF NOT EXISTS observations (
    project_id            VARCHAR(128)  NOT NULL,
    trace_id              VARCHAR(128)  NOT NULL,
    id                    VARCHAR(128)  NOT NULL,
    type                  VARCHAR(16)   NOT NULL DEFAULT 'SPAN',
    parent_observation_id VARCHAR(128)  NOT NULL DEFAULT '',
    name                  VARCHAR(1024) NOT NULL DEFAULT '',
    start_time            DATETIME(3)   NOT NULL,
    end_time              DATETIME(3)   NULL,
    environment           VARCHAR(128)  NOT NULL DEFAULT 'default',
    level                 VARCHAR(16)   NOT NULL DEFAULT 'DEFAULT',
    status_message        STRING        NULL,
    model                 VARCHAR(256)  NOT NULL DEFAULT '',
    provider              VARCHAR(128)  NOT NULL DEFAULT '',
    model_parameters      STRING        NULL,
    prompt_tokens         BIGINT        NOT NULL DEFAULT '0',
    completion_tokens     BIGINT        NOT NULL DEFAULT '0',
    total_tokens          BIGINT        NOT NULL DEFAULT '0',
    input_cost            DOUBLE        NOT NULL DEFAULT '0',
    output_cost           DOUBLE        NOT NULL DEFAULT '0',
    total_cost            DOUBLE        NOT NULL DEFAULT '0',
    prompt_id             VARCHAR(128)  NOT NULL DEFAULT '',
    prompt_version        VARCHAR(64)   NOT NULL DEFAULT '',
    input                 STRING        NULL,
    output                STRING        NULL,
    metadata              STRING        NULL,
    latency_ms            BIGINT        NOT NULL DEFAULT '0',
    event_ts              DATETIME(3)   NOT NULL,
    created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
)
UNIQUE KEY(project_id, trace_id, id)
DISTRIBUTED BY HASH(trace_id) BUCKETS AUTO
PROPERTIES (
    "enable_unique_key_merge_on_write" = "true",
    "function_column.sequence_col"     = "event_ts",
    "replication_num"                  = "1"
);

CREATE TABLE IF NOT EXISTS scores (
    project_id     VARCHAR(128) NOT NULL,
    id             VARCHAR(128) NOT NULL,
    trace_id       VARCHAR(128) NOT NULL DEFAULT '',
    observation_id VARCHAR(128) NOT NULL DEFAULT '',
    name           VARCHAR(512) NOT NULL DEFAULT '',
    `timestamp`    DATETIME(3)  NOT NULL,
    environment    VARCHAR(128) NOT NULL DEFAULT 'default',
    source         VARCHAR(16)  NOT NULL DEFAULT 'API',
    data_type      VARCHAR(16)  NOT NULL DEFAULT 'NUMERIC',
    `value`        DOUBLE       NULL,
    string_value   STRING       NULL,
    `comment`      STRING       NULL,
    config_id      VARCHAR(128) NOT NULL DEFAULT '',
    event_ts       DATETIME(3)  NOT NULL,
    created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
)
UNIQUE KEY(project_id, id)
DISTRIBUTED BY HASH(id) BUCKETS AUTO
PROPERTIES (
    "enable_unique_key_merge_on_write" = "true",
    "function_column.sequence_col"     = "event_ts",
    "replication_num"                  = "1"
);
