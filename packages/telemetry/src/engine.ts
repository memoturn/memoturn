/** Engine selection for the telemetry tier (ADR-0002). */
export type TelemetryEngine = "doris" | "postgres";

export function telemetryEngine(): TelemetryEngine {
  const raw = (process.env.TELEMETRY_ENGINE ?? "doris").toLowerCase();
  if (raw === "postgres" || raw === "pg") return "postgres";
  if (raw === "doris") return "doris";
  throw new Error(`invalid TELEMETRY_ENGINE: ${raw} (expected "doris" or "postgres")`);
}
