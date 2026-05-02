/**
 * OpenTelemetry tracing setup. Lazily initialised so tests and stdio
 * smoke runs don't pay the cost of OTLP exporters unless `otel.enabled`
 * is set in config (or `MCMCP_OTEL=1` is exported in the environment).
 *
 * The OTEL packages are *optional* runtime dependencies — if they aren't
 * installed (or fail to load), tracing silently degrades to no-op.
 */
import type { OtelConfig } from "./config.js";

interface TracingHandle {
  shutdown(): Promise<void>;
}

let handle: TracingHandle | null = null;
let tracer: { startActiveSpan: Function } | null = null;

export async function initTracing(cfg: OtelConfig | undefined): Promise<void> {
  const enabled =
    process.env.MCMCP_OTEL === "1" || (cfg && cfg.enabled === true);
  if (!enabled) return;
  try {
    // Dynamic import keeps OTEL truly optional. Use string-typed dynamic
    // import via Function() to avoid TypeScript module resolution at
    // build time when the packages are not installed.
    const dynImport = new Function("m", "return import(m)") as (m: string) => Promise<Record<string, unknown>>;
    const sdkMod = await dynImport("@opentelemetry/sdk-node");
    const otlpMod = await dynImport("@opentelemetry/exporter-trace-otlp-http");
    const apiMod = await dynImport("@opentelemetry/api");

    const NodeSDK = sdkMod.NodeSDK as new (opts: unknown) => {
      start(): Promise<void> | void;
      shutdown(): Promise<void>;
    };
    const OTLPTraceExporter = otlpMod.OTLPTraceExporter as new (opts: unknown) => unknown;
    const trace = apiMod.trace as { getTracer(name: string): typeof tracer };

    const sdk = new NodeSDK({
      serviceName: cfg?.serviceName ?? "mcmcp",
      traceExporter: new OTLPTraceExporter({
        url:
          cfg?.otlpEndpoint ??
          process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
          "http://localhost:4318/v1/traces",
      }),
    });
    await sdk.start();
    handle = { shutdown: () => sdk.shutdown() };
    tracer = trace.getTracer("mcmcp");
    process.stderr.write(`[mcmcp] otel tracing enabled (service=${cfg?.serviceName ?? "mcmcp"})\n`);
  } catch (err) {
    process.stderr.write(
      `[mcmcp] otel disabled: ${(err as Error).message} (install @opentelemetry/{api,sdk-node,exporter-trace-otlp-http} to enable)\n`,
    );
  }
}

export async function shutdownTracing(): Promise<void> {
  if (!handle) return;
  try {
    await handle.shutdown();
  } catch {
    /* ignore */
  }
  handle = null;
  tracer = null;
}

/**
 * Run `fn` inside a span if tracing is initialised; otherwise pass-through.
 * Generic in the return type so it composes cleanly with async callers.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracer) return fn();
  return await new Promise<T>((res, rej) => {
    tracer!.startActiveSpan(name, { attributes }, async (span: { end(): void; recordException(e: unknown): void; setStatus(s: { code: number; message?: string }): void }) => {
      try {
        const out = await fn();
        span.end();
        res(out);
      } catch (err) {
        span.recordException(err);
        span.setStatus({ code: 2, message: (err as Error).message });
        span.end();
        rej(err);
      }
    });
  });
}
