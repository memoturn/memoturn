import { createRequire } from "node:module";

/**
 * OpenTelemetry export helpers — point an existing OTel setup at memoturn.
 *
 * memoturn's OTLP/HTTP receiver (`POST /v1/otel/v1/traces`) ingests standard OTel spans and
 * maps GenAI semantic-convention attributes (`gen_ai.*`) into traces + generations. These
 * helpers just pre-wire the endpoint URL + Basic-auth header from your API keys, so an
 * OTel-standardized team keeps their instrumentation and gets first-party DX.
 *
 *   // Zero-dependency: hand the config to any OTLP trace exporter you already use.
 *   import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
 *   import { memoturnOtlpConfig } from "@memoturn/sdk/otel";
 *   new OTLPTraceExporter(memoturnOtlpConfig());
 *
 *   // Or the one-liner (needs @opentelemetry/exporter-trace-otlp-http installed):
 *   import { memoturnSpanProcessor } from "@memoturn/sdk/otel";
 *   new NodeSDK({ spanProcessors: [memoturnSpanProcessor()] });
 *
 * Credentials resolve from options or the MEMOTURN_BASE_URL / MEMOTURN_PUBLIC_KEY /
 * MEMOTURN_SECRET_KEY env vars, matching the rest of the SDK.
 */
export interface MemoturnOtelOptions {
  /** memoturn API base URL (the OTLP receiver lives under it). Default http://localhost:3001. */
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
  /** Extra headers merged onto the auth header (e.g. a proxy token). */
  headers?: Record<string, string>;
}

export interface MemoturnOtlpConfig {
  /** Full OTLP/HTTP traces URL (`<baseUrl>/v1/otel/v1/traces`). */
  url: string;
  headers: Record<string, string>;
}

/**
 * Build the `{ url, headers }` an OTLP/HTTP trace exporter needs to send to memoturn.
 * Dependency-free and portable — pass it straight into your own `OTLPTraceExporter`.
 */
export function memoturnOtlpConfig(options: MemoturnOtelOptions = {}): MemoturnOtlpConfig {
  const baseUrl = (options.baseUrl ?? process.env.MEMOTURN_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
  const publicKey = options.publicKey ?? process.env.MEMOTURN_PUBLIC_KEY ?? "";
  const secretKey = options.secretKey ?? process.env.MEMOTURN_SECRET_KEY ?? "";
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  return {
    url: `${baseUrl}/v1/otel/v1/traces`,
    headers: { Authorization: `Basic ${auth}`, ...options.headers },
  };
}

const require = createRequire(import.meta.url);

function optionalDep<T>(name: string, hint: string): T {
  try {
    return require(name) as T;
  } catch {
    throw new Error(`@memoturn/sdk OTel export requires the peer dependency '${name}' — ${hint}`);
  }
}

/**
 * A configured OTLP/HTTP trace exporter for memoturn. Requires the peer dependency
 * `@opentelemetry/exporter-trace-otlp-http`. Add it to your own OTel SpanProcessor, or use
 * `memoturnSpanProcessor` for a batched one.
 */
export function memoturnTraceExporter(options: MemoturnOtelOptions = {}): unknown {
  const { OTLPTraceExporter } = optionalDep<{ OTLPTraceExporter: new (o: MemoturnOtlpConfig) => unknown }>(
    "@opentelemetry/exporter-trace-otlp-http",
    "install it to use memoturnTraceExporter / memoturnSpanProcessor",
  );
  return new OTLPTraceExporter(memoturnOtlpConfig(options));
}

/**
 * A `BatchSpanProcessor` that exports to memoturn — drop into a NodeSDK / TracerProvider.
 * Requires `@opentelemetry/exporter-trace-otlp-http` and `@opentelemetry/sdk-trace-base`.
 */
export function memoturnSpanProcessor(options: MemoturnOtelOptions = {}): unknown {
  const { BatchSpanProcessor } = optionalDep<{ BatchSpanProcessor: new (e: unknown) => unknown }>(
    "@opentelemetry/sdk-trace-base",
    "install it (or use memoturnTraceExporter with your own SpanProcessor)",
  );
  return new BatchSpanProcessor(memoturnTraceExporter(options));
}
