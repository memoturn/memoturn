import type {
  AnalyticsQuery,
  CostRollupRow,
  DailyMetric,
  EmbeddingPoint,
  ModelMetric,
  ObservationDetail,
  PromptArmScore,
  PromptVersionCost,
  QueryResult,
  ScoreRow as ScoreDetail,
  SessionSummary,
  SingleFilter,
  ToolAnalyticsRow,
  TraceFacets,
  TraceHistogramBucket,
  TraceSummary,
  UserSummary,
  WidgetBreakdown,
  WidgetFilters,
  WidgetMetric,
  WidgetPoint,
} from "@memoturn/contracts";
import { toDorisDateTime } from "../serialize-shared.js";
import type { TelemetryStore } from "../store.js";
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
  TraceEmbeddingRow,
  TraceFilters,
  TraceHeader,
  TraceIO,
  TraceRow,
  TraceScore,
  WindowMetric,
} from "../types.js";
import { closePgPool, pgQuery } from "./client.js";
import { buildUpserts } from "./serialize.js";

/**
 * Postgres implementation of the TelemetryStore seam (ADR-0002 — the small-install
 * telemetry tier). Tables live in the `telemetry` schema (bare names resolve via the
 * pool's search_path); LWW merge semantics are reproduced by the upsert guard in
 * serialize.ts, so retries and score corrections stay idempotent exactly like the
 * Doris merge-on-write path. Cutoffs are computed in JS and bound as literals, and
 * numerics are Number()-normalized at the boundary (node-pg surfaces int8/numeric as
 * strings), both mirroring the Doris implementation's conventions.
 */

/** ISO timestamp for "now minus N days" as a timestamp literal. */
function cutoffDaysAgo(days: number): string {
  return toDorisDateTime(new Date(Date.now() - Math.floor(days) * 86_400_000).toISOString());
}

const notImplemented = (method: string): never => {
  // Read-path methods land in the PR-B port (plan: docs/adr/0002 phases). The postgres
  // engine is opt-in via TELEMETRY_ENGINE, so nothing reaches these in a doris deployment.
  throw new Error(`postgres telemetry store: ${method} not implemented yet`);
};

export class PostgresTelemetryStore implements TelemetryStore {
  private query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return pgQuery<T>(sql, params);
  }

  private async exec(sql: string, params: unknown[] = []): Promise<void> {
    await pgQuery(sql, params);
  }

  // ── Reads (ported in PR B) ─────────────────────────────────────────────────────

  async listTraces(_projectId: string, _filters?: TraceFilters): Promise<TraceSummary[]> {
    return notImplemented("listTraces");
  }

  async countTraces(_projectId: string, _filters?: TraceFilters): Promise<number> {
    return notImplemented("countTraces");
  }

  async traceHistogram(
    _projectId: string,
    _filters: TraceFilters,
    _interval: "hour" | "day",
  ): Promise<TraceHistogramBucket[]> {
    return notImplemented("traceHistogram");
  }

  async traceFacets(
    _projectId: string,
    _opts?: {
      days?: number;
      limit?: number;
      environment?: string;
      search?: string;
      userId?: string;
      tag?: string;
      scoreName?: string;
      level?: string;
      type?: string;
      filters?: SingleFilter[];
    },
  ): Promise<TraceFacets> {
    return notImplemented("traceFacets");
  }

  async listSessions(
    _projectId: string,
    _opts?: { limit?: number; offset?: number; days?: number; search?: string },
  ): Promise<SessionSummary[]> {
    return notImplemented("listSessions");
  }

  async countSessions(_projectId: string, _days?: number, _search?: string): Promise<number> {
    return notImplemented("countSessions");
  }

  async listUsers(
    _projectId: string,
    _opts?: { limit?: number; offset?: number; days?: number; search?: string },
  ): Promise<UserSummary[]> {
    return notImplemented("listUsers");
  }

  async countUsers(_projectId: string, _days?: number, _search?: string): Promise<number> {
    return notImplemented("countUsers");
  }

  async getTraceHeader(_projectId: string, _traceId: string): Promise<TraceHeader | null> {
    return notImplemented("getTraceHeader");
  }

  async listObservationsByTrace(_projectId: string, _traceId: string): Promise<ObservationDetail[]> {
    return notImplemented("listObservationsByTrace");
  }

  async listScoresByTrace(_projectId: string, _traceId: string): Promise<ScoreDetail[]> {
    return notImplemented("listScoresByTrace");
  }

  async getTraceIO(_projectId: string, _traceIds: string[]): Promise<TraceIO[]> {
    return notImplemented("getTraceIO");
  }

  async getScoresByTraceIds(_projectId: string, _traceIds: string[]): Promise<TraceScore[]> {
    return notImplemented("getScoresByTraceIds");
  }

  async getScoreById(_projectId: string, _scoreId: string): Promise<FullScoreRow | null> {
    return notImplemented("getScoreById");
  }

  async evaluatorScoreSummary(_projectId: string, _days: number): Promise<EvalScoreSummaryRow[]> {
    return notImplemented("evaluatorScoreSummary");
  }

  async evaluatorScoreTrend(_projectId: string, _days: number): Promise<EvalScoreTrendRow[]> {
    return notImplemented("evaluatorScoreTrend");
  }

  async metricsByDay(_projectId: string, _days: number): Promise<DailyMetric[]> {
    return notImplemented("metricsByDay");
  }

  async metricsByModel(_projectId: string, _days: number): Promise<ModelMetric[]> {
    return notImplemented("metricsByModel");
  }

  async costByUser(_projectId: string, _opts?: { days?: number; limit?: number }): Promise<CostRollupRow[]> {
    return notImplemented("costByUser");
  }

  async costBySession(_projectId: string, _opts?: { days?: number; limit?: number }): Promise<CostRollupRow[]> {
    return notImplemented("costBySession");
  }

  async costByPromptVersion(
    _projectId: string,
    _promptName: string,
    _opts?: { days?: number },
  ): Promise<PromptVersionCost[]> {
    return notImplemented("costByPromptVersion");
  }

  async scoresByPromptVersion(
    _projectId: string,
    _promptName: string,
    _opts?: { days?: number },
  ): Promise<PromptArmScore[]> {
    return notImplemented("scoresByPromptVersion");
  }

  async toolAnalytics(_projectId: string, _days: number): Promise<ToolAnalyticsRow[]> {
    return notImplemented("toolAnalytics");
  }

  async metricsWindow(_projectId: string, _sinceMinutes: number): Promise<WindowMetric> {
    return notImplemented("metricsWindow");
  }

  async metricsWindowByProjects(_projectIds: string[], _sinceMinutes: number): Promise<Map<string, WindowMetric>> {
    return notImplemented("metricsWindowByProjects");
  }

  async metricWindowSeries(_projectId: string, _windowMinutes: number, _buckets: number): Promise<WindowMetric[]> {
    return notImplemented("metricWindowSeries");
  }

  async countTracesSince(_projectId: string, _days: number): Promise<number> {
    return notImplemented("countTracesSince");
  }

  async widgetSeries(
    _projectId: string,
    _metric: WidgetMetric,
    _breakdown: WidgetBreakdown,
    _days: number,
    _filters?: WidgetFilters,
  ): Promise<WidgetPoint[]> {
    return notImplemented("widgetSeries");
  }

  async runAnalyticsQuery(_projectId: string, _query: AnalyticsQuery): Promise<QueryResult> {
    return notImplemented("runAnalyticsQuery");
  }

  async exportTraces(_projectId: string, _filters?: ExportFilters): Promise<ExportTraceRow[]> {
    return notImplemented("exportTraces");
  }

  async countTracesOlderThan(_projectId: string, _days: number): Promise<number> {
    return notImplemented("countTracesOlderThan");
  }

  async countProjectRows(_projectId: string): Promise<ProjectRowCounts> {
    return notImplemented("countProjectRows");
  }

  async getTraceRowsByIds(_projectId: string, _traceIds: string[]): Promise<TraceRow[]> {
    return notImplemented("getTraceRowsByIds");
  }

  async getObservationRowsByIds(_projectId: string, _observationIds: string[]): Promise<ObservationRow[]> {
    return notImplemented("getObservationRowsByIds");
  }

  async listRetrievalDocumentsByObservationIds(
    _projectId: string,
    _observationIds: string[],
  ): Promise<RetrievalDocumentDetail[]> {
    return notImplemented("listRetrievalDocumentsByObservationIds");
  }

  async listEmbeddingsForProjection(
    _projectId: string,
    _opts?: { days?: number; limit?: number },
  ): Promise<EmbeddingVectorRow[]> {
    return notImplemented("listEmbeddingsForProjection");
  }

  async listEmbeddingProjection(
    _projectId: string,
    _opts?: { runId?: string; limit?: number },
  ): Promise<EmbeddingPoint[]> {
    return notImplemented("listEmbeddingProjection");
  }

  async latestProjectionRunId(_projectId: string): Promise<string | null> {
    return notImplemented("latestProjectionRunId");
  }

  async getTraceEmbeddings(_projectId: string, _traceId: string): Promise<TraceEmbeddingRow[]> {
    return notImplemented("getTraceEmbeddings");
  }

  async rankSimilarTraceIds(
    _projectId: string,
    _opts: {
      seedVectors: number[][];
      model: string;
      dim: number;
      excludeTraceId: string;
      limit: number;
      days?: number;
    },
  ): Promise<{ trace_id: string; similarity: number }[]> {
    return notImplemented("rankSimilarTraceIds");
  }

  // ── Writes ─────────────────────────────────────────────────────────────────────

  async insertRows<T extends TelemetryTable>(table: T, rows: TelemetryRowMap[T][]): Promise<void> {
    if (rows.length === 0) return;
    for (const stmt of buildUpserts(table, rows)) {
      await this.exec(stmt.sql, stmt.params);
    }
  }

  async deleteScore(projectId: string, scoreId: string): Promise<void> {
    await this.exec("DELETE FROM scores WHERE project_id = ? AND id = ?", [projectId, scoreId]);
  }

  async deleteTraces(projectId: string, traceIds: string[]): Promise<void> {
    if (traceIds.length === 0) return;
    await this.exec("DELETE FROM traces WHERE project_id = ? AND id IN (?)", [projectId, traceIds]);
    await this.exec("DELETE FROM observations WHERE project_id = ? AND trace_id IN (?)", [projectId, traceIds]);
    await this.exec("DELETE FROM scores WHERE project_id = ? AND trace_id IN (?)", [projectId, traceIds]);
    await this.exec("DELETE FROM retrieval_documents WHERE project_id = ? AND trace_id IN (?)", [projectId, traceIds]);
    await this.exec("DELETE FROM embeddings WHERE project_id = ? AND trace_id IN (?)", [projectId, traceIds]);
    await this.exec("DELETE FROM embedding_projections WHERE project_id = ? AND trace_id IN (?)", [
      projectId,
      traceIds,
    ]);
  }

  async deleteOlderThan(projectId: string, days: number): Promise<void> {
    const cutoff = cutoffDaysAgo(days);
    await this.exec('DELETE FROM traces WHERE project_id = ? AND "timestamp" < ?', [projectId, cutoff]);
    await this.exec("DELETE FROM observations WHERE project_id = ? AND start_time < ?", [projectId, cutoff]);
    await this.exec('DELETE FROM scores WHERE project_id = ? AND "timestamp" < ?', [projectId, cutoff]);
    await this.exec("DELETE FROM retrieval_documents WHERE project_id = ? AND event_ts < ?", [projectId, cutoff]);
    await this.exec("DELETE FROM embeddings WHERE project_id = ? AND event_ts < ?", [projectId, cutoff]);
    await this.exec("DELETE FROM embedding_projections WHERE project_id = ? AND event_ts < ?", [projectId, cutoff]);
  }

  async deleteProjectData(projectId: string): Promise<void> {
    await this.exec("DELETE FROM traces WHERE project_id = ?", [projectId]);
    await this.exec("DELETE FROM observations WHERE project_id = ?", [projectId]);
    await this.exec("DELETE FROM scores WHERE project_id = ?", [projectId]);
    await this.exec("DELETE FROM retrieval_documents WHERE project_id = ?", [projectId]);
    await this.exec("DELETE FROM embeddings WHERE project_id = ?", [projectId]);
    await this.exec("DELETE FROM embedding_projections WHERE project_id = ?", [projectId]);
  }

  // ── Ops ────────────────────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await closePgPool();
  }
}
