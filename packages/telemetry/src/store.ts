import type {
  CostRollupRow,
  DailyMetric,
  EmbeddingPoint,
  ModelMetric,
  ObservationDetail,
  ScoreRow as ScoreDetail,
  SessionSummary,
  ToolAnalyticsRow,
  TraceFacets,
  TraceHistogramBucket,
  TraceSummary,
  UserSummary,
  WidgetBreakdown,
  WidgetMetric,
  WidgetPoint,
} from "@memoturn/contracts";
import type {
  EmbeddingVectorRow,
  EvalScoreSummaryRow,
  EvalScoreTrendRow,
  ExportFilters,
  ExportTraceRow,
  FullScoreRow,
  ObservationRow,
  ProjectRowCounts,
  RetrievalDocumentDetail,
  TelemetryRowMap,
  TelemetryTable,
  TraceFilters,
  TraceHeader,
  TraceIO,
  TraceRow,
  TraceScore,
  WindowMetric,
} from "./types.js";

/**
 * The telemetry store — the single seam between memoturn and its analytical database.
 * All telemetry SQL lives behind this interface; packages/server and apps/worker call
 * domain methods and never hand-write engine SQL. Methods return contract-shaped values
 * (numerics already coerced to JS numbers), so the API's contract type-check remains the
 * drift guard.
 *
 * Every method is scoped by project_id — the multi-tenant invariant.
 */
export interface TelemetryStore {
  // ── Reads ──────────────────────────────────────────────────────────────────────
  listTraces(projectId: string, filters?: TraceFilters): Promise<TraceSummary[]>;
  /** Total traces matching the filters (ignores limit/offset) — for paginated page counts. */
  countTraces(projectId: string, filters?: TraceFilters): Promise<number>;
  /**
   * Trace counts bucketed by hour or day over the filtered range, for the volume histogram
   * above the list. Honors the same filters as listTraces (so the bars track the on-screen set).
   */
  traceHistogram(projectId: string, filters: TraceFilters, interval: "hour" | "day"): Promise<TraceHistogramBucket[]>;
  /**
   * Distinct facet values + counts (environment / name / tags) over the time range, for the filter
   * panel. Counts are facet-excluding: each dimension honors the *other* active filters but not its
   * own, so a selected facet still shows the alternatives you could switch to.
   */
  traceFacets(
    projectId: string,
    opts?: {
      days?: number;
      limit?: number;
      environment?: string;
      search?: string;
      userId?: string;
      tag?: string;
      scoreName?: string;
      level?: string;
    },
  ): Promise<TraceFacets>;
  listSessions(
    projectId: string,
    opts?: { limit?: number; offset?: number; days?: number; search?: string },
  ): Promise<SessionSummary[]>;
  /** Distinct session count (non-empty session_id) within the range — for paginated page counts. */
  countSessions(projectId: string, days?: number, search?: string): Promise<number>;
  /** Per-end-user rollups (traces grouped by non-empty user_id), for the Users view. */
  listUsers(
    projectId: string,
    opts?: { limit?: number; offset?: number; days?: number; search?: string },
  ): Promise<UserSummary[]>;
  countUsers(projectId: string, days?: number, search?: string): Promise<number>;
  getTraceHeader(projectId: string, traceId: string): Promise<TraceHeader | null>;
  listObservationsByTrace(projectId: string, traceId: string): Promise<ObservationDetail[]>;
  listScoresByTrace(projectId: string, traceId: string): Promise<ScoreDetail[]>;
  getTraceIO(projectId: string, traceIds: string[]): Promise<TraceIO[]>;
  getScoresByTraceIds(projectId: string, traceIds: string[]): Promise<TraceScore[]>;
  getScoreById(projectId: string, scoreId: string): Promise<FullScoreRow | null>;
  evaluatorScoreSummary(projectId: string, days: number): Promise<EvalScoreSummaryRow[]>;
  evaluatorScoreTrend(projectId: string, days: number): Promise<EvalScoreTrendRow[]>;
  metricsByDay(projectId: string, days: number): Promise<DailyMetric[]>;
  metricsByModel(projectId: string, days: number): Promise<ModelMetric[]>;
  /** Spend ranked by user_id (top spenders). Joins observation cost onto traces. */
  costByUser(projectId: string, opts?: { days?: number; limit?: number }): Promise<CostRollupRow[]>;
  /** Spend ranked by session_id (top spenders). Joins observation cost onto traces. */
  costBySession(projectId: string, opts?: { days?: number; limit?: number }): Promise<CostRollupRow[]>;
  /** Per-tool-name analytics over SPAN observations: calls, error rate, latency. */
  toolAnalytics(projectId: string, days: number): Promise<ToolAnalyticsRow[]>;
  /** Aggregate GENERATION metrics over a short trailing window (minutes) — for alert evaluation. */
  metricsWindow(projectId: string, sinceMinutes: number): Promise<WindowMetric>;
  /**
   * Batched `metricsWindow` for many projects in a single grouped query per table — the
   * alert cron uses this so one tick issues O(distinct windows) queries, not O(rules).
   * Projects with no rows in the window are present with zeroed metrics.
   */
  metricsWindowByProjects(projectIds: string[], sinceMinutes: number): Promise<Map<string, WindowMetric>>;
  countTracesSince(projectId: string, days: number): Promise<number>;
  widgetSeries(
    projectId: string,
    metric: WidgetMetric,
    breakdown: WidgetBreakdown,
    days: number,
  ): Promise<WidgetPoint[]>;
  exportTraces(projectId: string, filters?: ExportFilters): Promise<ExportTraceRow[]>;
  countTracesOlderThan(projectId: string, days: number): Promise<number>;
  countProjectRows(projectId: string): Promise<ProjectRowCounts>;
  /**
   * Full write-shaped rows for a set of entity ids — the read-merge bases for
   * cross-batch partial updates (ingest events are patches: fields a new event
   * leaves unset must keep their previously stored value).
   */
  getTraceRowsByIds(projectId: string, traceIds: string[]): Promise<TraceRow[]>;
  getObservationRowsByIds(projectId: string, observationIds: string[]): Promise<ObservationRow[]>;

  // ── RAG: retrieval documents + embeddings ────────────────────────────────────────
  /** Retrieved documents for a set of observation ids (getTrace enrichment). */
  listRetrievalDocumentsByObservationIds(
    projectId: string,
    observationIds: string[],
  ): Promise<RetrievalDocumentDetail[]>;
  /** Raw vectors for the dimensionality-reduction job (most-recent window, capped). */
  listEmbeddingsForProjection(
    projectId: string,
    opts?: { days?: number; limit?: number },
  ): Promise<EmbeddingVectorRow[]>;
  /** Reduced projection points for a run (latest run if `runId` omitted). color_value is null. */
  listEmbeddingProjection(projectId: string, opts?: { runId?: string; limit?: number }): Promise<EmbeddingPoint[]>;
  /** The most recent projection run id for a project, or null if none computed yet. */
  latestProjectionRunId(projectId: string): Promise<string | null>;

  // ── Writes ─────────────────────────────────────────────────────────────────────
  /**
   * Insert rows for one table. Idempotent: re-inserting a row with the same entity id
   * and a newer `event_ts` overwrites (last-writer-wins merge); an identical re-insert
   * is a no-op after merge. Callers rely on this for safe job retries and corrections.
   */
  insertRows<T extends TelemetryTable>(table: T, rows: TelemetryRowMap[T][]): Promise<void>;
  deleteScore(projectId: string, scoreId: string): Promise<void>;
  /** Delete the given traces plus their observations and scores. */
  deleteTraces(projectId: string, traceIds: string[]): Promise<void>;
  /** Retention: delete traces/observations/scores older than `days`. */
  deleteOlderThan(projectId: string, days: number): Promise<void>;
  /** Delete ALL telemetry for a project (project deletion, seed wipe, test cleanup). */
  deleteProjectData(projectId: string): Promise<void>;

  // ── Ops ────────────────────────────────────────────────────────────────────────
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
