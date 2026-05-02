/**
 * In-memory metrics collector for MCMCP. All counters reset on process
 * restart — no persistence. Latency is tracked as a rolling window of the
 * last {@link LATENCY_WINDOW} samples per upstream / per tool.
 */

const LATENCY_WINDOW = 100;

interface UpstreamCounters {
  ok: number;
  error: number;
  rate_limited: number;
  cache_hits: number;
  latencies: number[];
  /** Ring-buffer write pointer into {@link latencies}. */
  cursor: number;
}

interface ToolCounters {
  ok: number;
  error: number;
  latencies: number[];
  cursor: number;
}

/** Snapshot returned by {@link Metrics.snapshot}. */
export interface MetricsSnapshot {
  uptime_seconds: number;
  total_calls: number;
  calls_by_upstream: Record<
    string,
    {
      ok: number;
      error: number;
      rate_limited: number;
      cache_hits: number;
      avg_latency_ms: number;
    }
  >;
  calls_by_tool: Record<
    string,
    { ok: number; error: number; avg_latency_ms: number }
  >;
  batch_calls: { total: number; total_items: number };
  hot_reloads: number;
  last_reload_at: string | null;
  directory: {
    snapshots_generated: number;
    tier_distribution: { full: number; servers: number; paginated: number };
    avg_snapshot_build_ms: number;
  };
}

/** Collects per-upstream and per-tool runtime statistics. */
export class Metrics {
  private readonly startedAt = Date.now();
  private readonly upstreams = new Map<string, UpstreamCounters>();
  private readonly tools = new Map<string, ToolCounters>();
  private totalCalls = 0;
  private batchTotal = 0;
  private batchItems = 0;
  private reloads = 0;
  private lastReloadAt: number | null = null;
  private snapshotsGenerated = 0;
  private tierDistribution = { full: 0, servers: 0, paginated: 0 };
  private snapshotBuildMs: number[] = [];
  private snapshotBuildCursor = 0;

  private upstream(id: string): UpstreamCounters {
    let c = this.upstreams.get(id);
    if (!c) {
      c = { ok: 0, error: 0, rate_limited: 0, cache_hits: 0, latencies: [], cursor: 0 };
      this.upstreams.set(id, c);
    }
    return c;
  }

  private tool(name: string): ToolCounters {
    let c = this.tools.get(name);
    if (!c) {
      c = { ok: 0, error: 0, latencies: [], cursor: 0 };
      this.tools.set(name, c);
    }
    return c;
  }

  private push(target: { latencies: number[]; cursor: number }, ms: number): void {
    if (target.latencies.length < LATENCY_WINDOW) {
      target.latencies.push(ms);
    } else {
      target.latencies[target.cursor] = ms;
      target.cursor = (target.cursor + 1) % LATENCY_WINDOW;
    }
  }

  /** Record a completed upstream call (success or error). */
  recordCall(upstreamId: string, toolName: string, durationMs: number, ok: boolean): void {
    this.totalCalls++;
    const u = this.upstream(upstreamId);
    const t = this.tool(toolName);
    if (ok) {
      u.ok++;
      t.ok++;
    } else {
      u.error++;
      t.error++;
    }
    this.push(u, durationMs);
    this.push(t, durationMs);
  }

  /** Record a rate-limited rejection (no upstream call performed). */
  recordRateLimited(upstreamId: string): void {
    this.upstream(upstreamId).rate_limited++;
  }

  /** Record a cache hit (no upstream call performed). */
  recordCacheHit(upstreamId: string): void {
    this.upstream(upstreamId).cache_hits++;
  }

  /** Record one batch invocation (and the number of sub-calls in it). */
  recordBatch(itemCount: number): void {
    this.batchTotal++;
    this.batchItems += itemCount;
  }

  /** Record a successful hot reload. */
  recordReload(): void {
    this.reloads++;
    this.lastReloadAt = Date.now();
  }

  /** Record a directory snapshot build (Phase 4). */
  recordDirectorySnapshot(tier: "full" | "servers" | "paginated", durationMs: number): void {
    this.snapshotsGenerated++;
    this.tierDistribution[tier]++;
    if (this.snapshotBuildMs.length < LATENCY_WINDOW) {
      this.snapshotBuildMs.push(durationMs);
    } else {
      this.snapshotBuildMs[this.snapshotBuildCursor] = durationMs;
      this.snapshotBuildCursor = (this.snapshotBuildCursor + 1) % LATENCY_WINDOW;
    }
  }

  /** Drop a removed upstream from the counters map (kept simple — keep history). */
  // Intentionally not removing on upstream drop; counters are run-lifetime.

  /** Render the current counters. */
  snapshot(): MetricsSnapshot {
    const avg = (xs: number[]): number =>
      xs.length === 0 ? 0 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    const avgFloat = (xs: number[]): number =>
      xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
    const calls_by_upstream: MetricsSnapshot["calls_by_upstream"] = {};
    for (const [id, c] of this.upstreams) {
      calls_by_upstream[id] = {
        ok: c.ok,
        error: c.error,
        rate_limited: c.rate_limited,
        cache_hits: c.cache_hits,
        avg_latency_ms: avg(c.latencies),
      };
    }
    const calls_by_tool: MetricsSnapshot["calls_by_tool"] = {};
    for (const [name, c] of this.tools) {
      calls_by_tool[name] = {
        ok: c.ok,
        error: c.error,
        avg_latency_ms: avg(c.latencies),
      };
    }
    return {
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      total_calls: this.totalCalls,
      calls_by_upstream,
      calls_by_tool,
      batch_calls: { total: this.batchTotal, total_items: this.batchItems },
      hot_reloads: this.reloads,
      last_reload_at: this.lastReloadAt ? new Date(this.lastReloadAt).toISOString() : null,
      directory: {
        snapshots_generated: this.snapshotsGenerated,
        tier_distribution: { ...this.tierDistribution },
        avg_snapshot_build_ms: round1(avgFloat(this.snapshotBuildMs)),
      },
    };
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
