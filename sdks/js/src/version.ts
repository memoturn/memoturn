/**
 * Build identity sent with every ingest batch, so a project's telemetry can be attributed to
 * the SDK that produced it (`GET /v1/usage/sdks`). Kept in lockstep with package.json by the
 * doc-drift checker — bump both together.
 */
export const SDK_NAME = "memoturn-js";
export const SDK_VERSION = "0.5.0";
