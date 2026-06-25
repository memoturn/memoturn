-- memoturn ClickHouse schema — telemetry store (traces / observations / scores).
-- Applied by `pnpm db:clickhouse` (see packages/db/src/migrate-clickhouse.ts).
--
-- Design notes:
--   * ReplacingMergeTree(event_ts) lets late / partial / out-of-order events merge
--     deterministically on the sorting key; the row with the highest event_ts wins.
--   * Sorting key always leads with project_id (multi-tenant isolation) then a date
--     bucket (partition-aligned) then id, so point lookups and range scans are cheap.
--   * Inputs/outputs are stored as String (JSON); large payloads live in blob storage
--     and only a reference is kept here when truncated.

CREATE TABLE IF NOT EXISTS traces
(
    id              String,
    project_id      String,
    `timestamp`     DateTime64(3),
    name            String,
    user_id         String DEFAULT '',
    session_id      String DEFAULT '',
    `release`       String DEFAULT '',
    version         String DEFAULT '',
    environment     LowCardinality(String) DEFAULT 'default',
    public          UInt8 DEFAULT 0,
    tags            Array(String) DEFAULT [],
    metadata        String DEFAULT '{}',
    input           String DEFAULT '',
    output          String DEFAULT '',
    event_ts        DateTime64(3),
    created_at      DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(event_ts)
PARTITION BY toYYYYMM(`timestamp`)
ORDER BY (project_id, toDate(`timestamp`), id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS observations
(
    id                    String,
    trace_id              String,
    project_id            String,
    `type`                Enum8('SPAN' = 1, 'GENERATION' = 2, 'EVENT' = 3),
    parent_observation_id String DEFAULT '',
    name                  String,
    start_time            DateTime64(3),
    end_time              Nullable(DateTime64(3)),
    environment           LowCardinality(String) DEFAULT 'default',
    level                 Enum8('DEBUG' = 1, 'DEFAULT' = 2, 'WARNING' = 3, 'ERROR' = 4) DEFAULT 'DEFAULT',
    status_message        String DEFAULT '',
    -- generation-specific
    model                 String DEFAULT '',
    provider              String DEFAULT '',
    model_parameters      String DEFAULT '{}',
    prompt_tokens         UInt32 DEFAULT 0,
    completion_tokens     UInt32 DEFAULT 0,
    total_tokens          UInt32 DEFAULT 0,
    input_cost            Float64 DEFAULT 0,
    output_cost           Float64 DEFAULT 0,
    total_cost            Float64 DEFAULT 0,
    prompt_id             String DEFAULT '',
    prompt_version        String DEFAULT '',
    -- payloads (JSON strings; truncated payloads reference blob storage)
    input                 String DEFAULT '',
    output                String DEFAULT '',
    metadata              String DEFAULT '{}',
    -- derived
    latency_ms            Int64 MATERIALIZED if(end_time IS NULL, 0, dateDiff('millisecond', start_time, end_time)),
    event_ts              DateTime64(3),
    created_at            DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(event_ts)
PARTITION BY toYYYYMM(start_time)
ORDER BY (project_id, toDate(start_time), trace_id, id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS scores
(
    id              String,
    project_id      String,
    trace_id        String,
    observation_id  String DEFAULT '',
    name            String,
    `timestamp`     DateTime64(3),
    environment     LowCardinality(String) DEFAULT 'default',
    `source`        Enum8('API' = 1, 'EVAL' = 2, 'ANNOTATION' = 3) DEFAULT 'API',
    data_type       Enum8('NUMERIC' = 1, 'CATEGORICAL' = 2, 'BOOLEAN' = 3) DEFAULT 'NUMERIC',
    value           Nullable(Float64),
    string_value    String DEFAULT '',
    comment         String DEFAULT '',
    config_id       String DEFAULT '',
    event_ts        DateTime64(3),
    created_at      DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(event_ts)
PARTITION BY toYYYYMM(`timestamp`)
ORDER BY (project_id, toDate(`timestamp`), trace_id, id)
SETTINGS index_granularity = 8192;

-- ── Metrics rollup (Phase 3 seed): daily per-model generation aggregates ──────
CREATE TABLE IF NOT EXISTS observations_daily
(
    project_id      String,
    `date`          Date,
    environment     LowCardinality(String),
    model           String,
    observations    AggregateFunction(count, UInt64),
    total_tokens    AggregateFunction(sum, UInt32),
    total_cost      AggregateFunction(sum, Float64),
    latency_ms      AggregateFunction(quantiles(0.5, 0.95, 0.99), Int64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(`date`)
ORDER BY (project_id, `date`, environment, model);

CREATE MATERIALIZED VIEW IF NOT EXISTS observations_daily_mv
TO observations_daily
AS
SELECT
    project_id,
    toDate(start_time) AS `date`,
    environment,
    model,
    countState(toUInt64(1))            AS observations,
    sumState(total_tokens)             AS total_tokens,
    sumState(total_cost)               AS total_cost,
    quantilesState(0.5, 0.95, 0.99)(latency_ms) AS latency_ms
FROM observations
WHERE `type` = 'GENERATION'
GROUP BY project_id, `date`, environment, model;
