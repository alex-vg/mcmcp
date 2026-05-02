import { createHash } from "node:crypto";
import type { CallToolResult } from "./proxy.js";

/** Per-upstream cache configuration block. */
export interface CacheConfig {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
}

interface Entry {
  value: CallToolResult;
  expiresAt: number;
  storedAt: number;
}

interface UpstreamCache {
  cfg: CacheConfig;
  /** Map preserves insertion order — used for naive LRU. */
  entries: Map<string, Entry>;
  hits: number;
  misses: number;
}

/** A retrieved cache hit including the original storage timestamp. */
export interface CacheHit {
  value: CallToolResult;
  ageMs: number;
}

/**
 * Per-upstream LRU + TTL cache for upstream tool results. Cache key is
 * SHA-256 of `upstreamId + toolName + JSON.stringify(args)`. The cache
 * never stores `isError: true` results.
 */
export class ResultCache {
  private readonly caches = new Map<string, UpstreamCache>();

  /** Install or replace a cache for an upstream. */
  configure(upstreamId: string, cfg: CacheConfig | undefined): void {
    if (!cfg || !cfg.enabled) {
      this.caches.delete(upstreamId);
      return;
    }
    const existing = this.caches.get(upstreamId);
    if (existing) {
      existing.cfg = cfg;
      this.evictExcess(existing);
    } else {
      this.caches.set(upstreamId, {
        cfg,
        entries: new Map(),
        hits: 0,
        misses: 0,
      });
    }
  }

  /** Drop a cache (e.g. on upstream removal). */
  remove(upstreamId: string): void {
    this.caches.delete(upstreamId);
  }

  /** True iff caching is enabled for `upstreamId`. */
  isEnabled(upstreamId: string): boolean {
    return this.caches.has(upstreamId);
  }

  /**
   * Recursively sort object keys so that `{a:1,b:2}` and `{b:2,a:1}` hash
   * identically. Arrays preserve their order (element order is significant).
   */
  private static canonicalize(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(ResultCache.canonicalize);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = ResultCache.canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }

  private static key(upstreamId: string, toolName: string, args: unknown): string {
    const h = createHash("sha256");
    h.update(upstreamId);
    h.update("\u0000");
    h.update(toolName);
    h.update("\u0000");
    h.update(JSON.stringify(ResultCache.canonicalize(args ?? {})));
    return h.digest("hex");
  }

  /** Look up a cached result; returns undefined on miss or expiry. */
  get(upstreamId: string, toolName: string, args: unknown): CacheHit | undefined {
    const c = this.caches.get(upstreamId);
    if (!c) return undefined;
    const k = ResultCache.key(upstreamId, toolName, args);
    const e = c.entries.get(k);
    const now = Date.now();
    if (!e || e.expiresAt <= now) {
      if (e) c.entries.delete(k);
      c.misses++;
      return undefined;
    }
    // LRU bump: re-insert to move to end.
    c.entries.delete(k);
    c.entries.set(k, e);
    c.hits++;
    return { value: e.value, ageMs: now - e.storedAt };
  }

  /** Store a result. Skips error results and no-op when caching disabled. */
  set(
    upstreamId: string,
    toolName: string,
    args: unknown,
    value: CallToolResult,
  ): void {
    const c = this.caches.get(upstreamId);
    if (!c) return;
    if (value && value.isError) return;
    const k = ResultCache.key(upstreamId, toolName, args);
    const now = Date.now();
    c.entries.delete(k);
    c.entries.set(k, { value, expiresAt: now + c.cfg.ttlMs, storedAt: now });
    this.evictExcess(c);
  }

  private evictExcess(c: UpstreamCache): void {
    while (c.entries.size > c.cfg.maxEntries) {
      const oldest = c.entries.keys().next();
      if (oldest.done) break;
      c.entries.delete(oldest.value);
    }
  }

  /** Per-upstream stats for surfacing in mode=status. */
  stats(upstreamId: string): { enabled: boolean; entries: number; hit_rate_pct: number } {
    const c = this.caches.get(upstreamId);
    if (!c) return { enabled: false, entries: 0, hit_rate_pct: 0 };
    const total = c.hits + c.misses;
    const hit_rate_pct = total === 0 ? 0 : Math.round((c.hits / total) * 1000) / 10;
    return { enabled: true, entries: c.entries.size, hit_rate_pct };
  }
}
