/**
 * Canonical Doris DDL for every telemetry table, as it should look on a FRESH install.
 *
 * Why this lives in TS and not only in infra/doris/*.sql: the historic migration files
 * create UNPARTITIONED tables (0001) and then ALTER columns onto them (0002/0005/0006).
 * Partitioning cannot be added to an existing Doris table, so the migrator now creates
 * tables from here first (step 0, `CREATE TABLE IF NOT EXISTS`) and the SQL files become
 * no-ops on a fresh install; existing installs are converted by the repartition CLI
 * (`bun run telemetry:repartition`), which also builds its `<table>__v2` from here.
 *
 * Partitioning (traces / observations / scores):
 *  - AUTO PARTITION BY RANGE(date_trunc(<time>, 'day')): partitions are created on demand,
 *    including for backdated rows (blob replay, demo seed, engine moves) — dynamic
 *    partitioning would reject those.
 *  - The partition column must be a KEY column on a UNIQUE KEY table, so `timestamp` /
 *    `start_time` join the key AFTER the id columns. The LOGICAL identity stays
 *    (project_id, [trace_id,] id) — `TELEMETRY_PRIMARY_KEYS` is unchanged — which is only
 *    correct because the worker never rewrites a row's time column once it exists
 *    (see apps/worker/src/mappers.ts, `stableTime`). `event_ts` cannot partition: it changes
 *    on every LWW rewrite.
 *  - `partition.retention_count` (native TTL, set by the migrator from
 *    TELEMETRY_MAX_RETENTION_DAYS) drops whole partitions for free; per-project retention
 *    stays the key-predicate DELETE, now partition-pruned.
 *  - retrieval_documents / embeddings / embedding_projections have no immutable time key
 *    and stay unpartitioned.
 */
import { REPLICATION_NUM } from "./client.js";

export type DorisTable =
  | "traces"
  | "observations"
  | "scores"
  | "retrieval_documents"
  | "embeddings"
  | "embedding_projections";

export const PARTITIONED_TABLES = ["traces", "observations", "scores"] as const;
export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];
export const ALL_TABLES: readonly DorisTable[] = [
  "traces",
  "observations",
  "scores",
  "retrieval_documents",
  "embeddings",
  "embedding_projections",
];

/** The partition (time) column per partitioned table. */
export const PARTITION_COLUMN: Record<PartitionedTable, string> = {
  traces: "`timestamp`",
  observations: "start_time",
  scores: "`timestamp`",
};

export interface DdlOptions {
  /** Physical table name (defaults to the logical name; the repartition CLI uses `<t>__v2`). */
  name?: string;
  replicationNum?: number;
  /** partition.retention_count (0/undefined = unset — keep everything). */
  retentionCount?: number;
}

function props(opts: DdlOptions, sequence = true): string {
  const lines = [
    ...(sequence
      ? ['"enable_unique_key_merge_on_write" = "true"', '"function_column.sequence_col"     = "event_ts"']
      : []),
    `"replication_num"                  = "${opts.replicationNum ?? REPLICATION_NUM}"`,
  ];
  if (opts.retentionCount && opts.retentionCount > 0) {
    lines.push(`"partition.retention_count"        = "${Math.trunc(opts.retentionCount)}"`);
  }
  return `PROPERTIES (\n    ${lines.join(",\n    ")}\n)`;
}

const tracesColumns = `
    project_id   VARCHAR(128)  NOT NULL,
    id           VARCHAR(128)  NOT NULL,
    \`timestamp\`  DATETIME(3)   NOT NULL,
    name         VARCHAR(1024) NOT NULL DEFAULT '',
    user_id      VARCHAR(512)  NOT NULL DEFAULT '',
    session_id   VARCHAR(512)  NOT NULL DEFAULT '',
    session_path VARCHAR(1024) NOT NULL DEFAULT '',
    \`release\`    VARCHAR(256)  NOT NULL DEFAULT '',
    version      VARCHAR(256)  NOT NULL DEFAULT '',
    environment  VARCHAR(128)  NOT NULL DEFAULT 'default',
    \`public\`     TINYINT       NOT NULL DEFAULT '0',
    tags         ARRAY<STRING> NULL,
    metadata     STRING        NULL,
    input        STRING        NULL,
    output       STRING        NULL,
    event_ts     DATETIME(3)   NOT NULL,
    created_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`;

const observationsColumns = `
    project_id            VARCHAR(128)  NOT NULL,
    trace_id              VARCHAR(128)  NOT NULL,
    id                    VARCHAR(128)  NOT NULL,
    start_time            DATETIME(3)   NOT NULL,
    type                  VARCHAR(16)   NOT NULL DEFAULT 'SPAN',
    parent_observation_id VARCHAR(128)  NOT NULL DEFAULT '',
    name                  VARCHAR(1024) NOT NULL DEFAULT '',
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
    cache_read_tokens     BIGINT        NOT NULL DEFAULT '0',
    cache_creation_tokens BIGINT        NOT NULL DEFAULT '0',
    reasoning_tokens      BIGINT        NOT NULL DEFAULT '0',
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
    created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`;

const scoresColumns = `
    project_id     VARCHAR(128) NOT NULL,
    id             VARCHAR(128) NOT NULL,
    \`timestamp\`    DATETIME(3)  NOT NULL,
    trace_id       VARCHAR(128) NOT NULL DEFAULT '',
    observation_id VARCHAR(128) NOT NULL DEFAULT '',
    name           VARCHAR(512) NOT NULL DEFAULT '',
    environment    VARCHAR(128) NOT NULL DEFAULT 'default',
    source         VARCHAR(16)  NOT NULL DEFAULT 'API',
    data_type      VARCHAR(16)  NOT NULL DEFAULT 'NUMERIC',
    \`value\`        DOUBLE       NULL,
    string_value   STRING       NULL,
    \`comment\`      STRING       NULL,
    config_id      VARCHAR(128) NOT NULL DEFAULT '',
    event_ts       DATETIME(3)  NOT NULL,
    created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`;

const retrievalDocumentsColumns = `
    project_id     VARCHAR(128) NOT NULL,
    observation_id VARCHAR(128) NOT NULL,
    rank           INT          NOT NULL,
    trace_id       VARCHAR(128) NOT NULL DEFAULT '',
    doc_id         VARCHAR(512) NOT NULL DEFAULT '',
    score          DOUBLE       NULL,
    content        STRING       NULL,
    metadata       STRING       NULL,
    event_ts       DATETIME(3)  NOT NULL,
    created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`;

const embeddingsColumns = `
    project_id     VARCHAR(128)  NOT NULL,
    observation_id VARCHAR(128)  NOT NULL,
    trace_id       VARCHAR(128)  NOT NULL DEFAULT '',
    kind           VARCHAR(16)   NOT NULL DEFAULT 'OBSERVATION',
    model          VARCHAR(256)  NOT NULL DEFAULT '',
    dim            INT           NOT NULL DEFAULT 0,
    vector         ARRAY<FLOAT>  NULL,
    event_ts       DATETIME(3)   NOT NULL,
    created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`;

const embeddingProjectionsColumns = `
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
    created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`;

/** CREATE TABLE IF NOT EXISTS statement for a table (its canonical, partitioned shape). */
export function createTableDdl(table: DorisTable, opts: DdlOptions = {}): string {
  const name = opts.name ?? table;
  switch (table) {
    case "traces":
      return `CREATE TABLE IF NOT EXISTS ${name} (${tracesColumns}
)
UNIQUE KEY(project_id, id, \`timestamp\`)
AUTO PARTITION BY RANGE (date_trunc(\`timestamp\`, 'day')) ()
DISTRIBUTED BY HASH(id) BUCKETS AUTO
${props(opts)}`;
    case "observations":
      return `CREATE TABLE IF NOT EXISTS ${name} (${observationsColumns}
)
UNIQUE KEY(project_id, trace_id, id, start_time)
AUTO PARTITION BY RANGE (date_trunc(start_time, 'day')) ()
DISTRIBUTED BY HASH(trace_id) BUCKETS AUTO
${props(opts)}`;
    case "scores":
      return `CREATE TABLE IF NOT EXISTS ${name} (${scoresColumns}
)
UNIQUE KEY(project_id, id, \`timestamp\`)
AUTO PARTITION BY RANGE (date_trunc(\`timestamp\`, 'day')) ()
DISTRIBUTED BY HASH(id) BUCKETS AUTO
${props(opts)}`;
    case "retrieval_documents":
      return `CREATE TABLE IF NOT EXISTS ${name} (${retrievalDocumentsColumns}
)
UNIQUE KEY(project_id, observation_id, rank)
DISTRIBUTED BY HASH(observation_id) BUCKETS AUTO
${props({ ...opts, retentionCount: 0 })}`;
    case "embeddings":
      return `CREATE TABLE IF NOT EXISTS ${name} (${embeddingsColumns}
)
UNIQUE KEY(project_id, observation_id)
DISTRIBUTED BY HASH(observation_id) BUCKETS AUTO
${props({ ...opts, retentionCount: 0 })}`;
    case "embedding_projections":
      return `CREATE TABLE IF NOT EXISTS ${name} (${embeddingProjectionsColumns}
)
UNIQUE KEY(project_id, run_id, observation_id)
DISTRIBUTED BY HASH(observation_id) BUCKETS AUTO
${props({ ...opts, retentionCount: 0 })}`;
  }
}

/** The column list (physical order) for a table, for `INSERT … SELECT` backfills. */
export function columnList(table: DorisTable): string[] {
  const src = {
    traces: tracesColumns,
    observations: observationsColumns,
    scores: scoresColumns,
    retrieval_documents: retrievalDocumentsColumns,
    embeddings: embeddingsColumns,
    embedding_projections: embeddingProjectionsColumns,
  }[table];
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(/\s+/)[0] as string)
    .filter((c) => c !== "created_at"); // defaulted; never copied
}
