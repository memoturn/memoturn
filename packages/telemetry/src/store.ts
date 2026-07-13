import type {
  DailyMetric,
  ModelMetric,
  ObservationDetail,
  ScoreRow as ScoreDetail,
  SessionSummary,
  TraceSummary,
  WidgetBreakdown,
  WidgetMetric,
  WidgetPoint,
} from "@memoturn/contracts";
import type {
  EvalScoreSummaryRow,
  EvalScoreTrendRow,
  ExportFilters,
  ExportTraceRow,
  FullScoreRow,
  ObservationRow,
  ProjectRowCounts,
  TelemetryRowMap,
  TelemetryTable,
  TraceFilters,
  TraceHeader,
  TraceIO,
  TraceRow,
  TraceScore,
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
  listSessions(projectId: string, limit?: number): Promise<SessionSummary[]>;
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
