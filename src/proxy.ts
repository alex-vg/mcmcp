import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  CreateMessageRequestSchema,
  type CreateMessageRequest,
  type CreateMessageResult,
  type Resource,
  type Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import {
  DEFAULT_CALL_TIMEOUT_MS,
  resolveDirectoryConfig,
  upstreamsEqual,
  type DirectoryConfig,
  type MCMCPConfig,
  type RetryConfig,
  type SecurityConfig,
  type SseUpstream,
  type StdioUpstream,
  type UpstreamConfig,
} from "./config.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import { RateLimiter } from "./rate-limiter.js";
import { ResultCache } from "./cache.js";
import {
  buildDirectorySnapshot,
  type DirectorySnapshot,
  type DirectoryToolEntry,
  type DirectoryUpstreamEntry,
} from "./directory.js";
import {
  INTERNAL_UPSTREAM_ID,
  internalToolEntry,
  type InternalCtx,
  type InternalToolDef,
} from "./internal-tools.js";
import {
  runAfter,
  runBefore,
  type Middleware,
  type MiddlewareCtx,
} from "./middleware.js";
import { applySecurityPolicy } from "./security.js";
import { buildOAuthProvider } from "./oauth.js";
import { withSpan } from "./otel.js";
import { MCMCP_VERSION } from "./version.js";

/** Consecutive upstream failures before the circuit breaker opens. */
const CIRCUIT_BREAKER_THRESHOLD = 5;
/** How long (ms) the circuit stays open before allowing a retry. */
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
/** Minimum ms between auto-reconnect attempts to the same upstream. */
const RECONNECT_COOLDOWN_MS = 10_000;
/** How long (ms) to wait for the initial MCP handshake + listTools during connectOne. */
const CONNECT_TIMEOUT_MS = 30_000;

/** A single tool entry cached from an upstream MCP server. */
export interface ToolEntry {
  name: string;
  originalName: string;
  description: string;
  inputSchema: object;
  upstreamId: string;
  /** SHA-256 over `originalName + JSON.stringify(inputSchema)`. Used for drift detection. */
  schemaFingerprint?: string;
}

/** A single resource indexed from an upstream MCP server. */
export interface ResourceEntry {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  upstreamId: string;
}

/** A single prompt template indexed from an upstream MCP server. */
export interface PromptEntry {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  upstreamId: string;
}

/** Schema-drift event recorded across reconnects / replaces. */
export interface DriftEvent {
  upstreamId: string;
  toolName: string;
  kind: "added" | "removed" | "changed";
  at: string;
}

/** MCP CallToolResult shape (subset MCMCP relies on). */
export interface CallToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: unknown }
    | Record<string, unknown>
  >;
  isError?: boolean;
  [k: string]: unknown;
}

/** Per-upstream live status entry surfaced via mode=status. */
export interface UpstreamStatus {
  id: string;
  label: string | null;
  transport: "stdio" | "sse";
  connected: boolean;
  tool_count: number;
  resource_count?: number;
  prompt_count?: number;
  last_ping_ms: number | null;
  last_ping_at: string | null;
  error: string | null;
  cache: { enabled: boolean; entries: number; hit_rate_pct: number };
  recent_drift?: DriftEvent[];
  /** ISO timestamp when the circuit breaker opens, or null if the circuit is closed. */
  circuit_open_until: string | null;
  /** Number of consecutive call failures since last success. */
  consecutive_failures: number;
}

interface UpstreamConnection {
  config: UpstreamConfig;
  client: Client;
  connected: boolean;
  lastError: string | null;
  toolCount: number;
  /** Bounded ring of recent drift events for this upstream (max 10). */
  driftEvents: DriftEvent[];
  /** SHA-256 fingerprints for each tool from the last successful connect. */
  schemaFingerprints: Map<string, string>;
  /** Consecutive call failures since last success. Reset to 0 on success. */
  consecutiveFailures: number;
  /** If set, circuit is open until this timestamp (ms); calls fail fast. */
  circuitOpenUntil: number | null;
  /** Timestamp (ms) of the last auto-reconnect attempt; throttles retries. */
  lastReconnectAttempt: number | null;
}

interface ProxyDeps {
  logger: Logger;
  metrics: Metrics;
  /**
   * Optional sampling sink. When provided, upstream `sampling/createMessage`
   * requests received from a Client are forwarded to this sink (which is
   * normally backed by mcmcp's own Server.createMessage).
   */
  sampling?: (req: CreateMessageRequest["params"]) => Promise<CreateMessageResult>;
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * UpstreamProxy connects to a set of upstream MCP servers, caches their
 * tool manifests, applies rate-limiting / caching / retry policies, and
 * forwards `callTool` requests. The set of upstreams may be mutated at
 * runtime via {@link applyConfigDiff} (used by hot-reload).
 */
export class UpstreamProxy {
  private readonly tools = new Map<string, ToolEntry>();
  private readonly connections = new Map<string, UpstreamConnection>();
  private readonly originalNameIndex = new Map<string, Set<string>>();
  private readonly rateLimiter = new RateLimiter();
  private readonly cache = new ResultCache();
  private callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  /** Wall-clock of the most recent successful sync (init / reload / ping). */
  private lastSyncAt = new Date();
  /** Active directory thresholds. May be re-read on hot-reload. */
  private directoryConfig: DirectoryConfig | undefined;
  /** In-process handlers for internal `mcmcp__*` tools. */
  private readonly internalHandlers = new Map<
    string,
    (args: unknown, ctx: InternalCtx) => Promise<CallToolResult>
  >();
  /** Context object handed to every internal-tool invocation. Lazily set. */
  private internalCtx: InternalCtx | null = null;
  /** Resources cached per upstream-original (raw uri); flat map for lookup by uri. */
  private readonly resources = new Map<string, ResourceEntry>();
  /** Prompts cached per upstream-original. */
  private readonly prompts = new Map<string, PromptEntry>();
  /** Registered middleware in dispatch order. */
  private readonly middlewares: Middleware[] = [];
  /** Active security config snapshot (mirrors MCMCPConfig.security). */
  private security: SecurityConfig | undefined;
  /** Monotonically increasing counter; bumped whenever the tool map changes. */
  private _dirtyBit = 0;
  /** Monotonically increasing counter; bumped whenever any connection state changes. */
  private _connectedVersion = 0;
  /** Cached snapshot from the last buildSnapshot() call. */
  private _snapshotCache: DirectorySnapshot | null = null;
  /** _dirtyBit value when _snapshotCache was last built. */
  private _snapshotDirtyBit = -1;
  /** _connectedVersion value when _snapshotCache was last built. */
  private _snapshotConnectedVersion = -1;
  /** Optional sampling sink (see {@link ProxyDeps.sampling}). */
  private readonly samplingSink:
    | ((req: CreateMessageRequest["params"]) => Promise<CreateMessageResult>)
    | undefined;

  constructor(deps: ProxyDeps) {
    this.logger = deps.logger;
    this.metrics = deps.metrics;
    this.samplingSink = deps.sampling;
  }

  /** Register a {@link Middleware}. Hooks run in registration order. */
  use(mw: Middleware): void {
    this.middlewares.push(mw);
  }

  /** Read-only view of registered middleware. */
  getMiddlewares(): ReadonlyArray<Middleware> {
    return this.middlewares;
  }

  /** Connect to every configured upstream and cache its tool manifest. */
  async init(config: MCMCPConfig): Promise<void> {
    if (typeof config.callTimeoutMs === "number" && config.callTimeoutMs > 0) {
      this.callTimeoutMs = config.callTimeoutMs;
    }
    this.directoryConfig = config.directory;
    this.security = config.security;
    await Promise.all(
      config.upstreams.map((u) =>
        this.connectOne(u).catch((err) => this.recordConnectFailure(u, err)),
      ),
    );
    this.lastSyncAt = new Date();
  }

  /** Apply a hot-reload config diff: add/remove/replace upstreams in place. */
  async applyConfigDiff(next: MCMCPConfig): Promise<void> {
    if (typeof next.callTimeoutMs === "number" && next.callTimeoutMs > 0) {
      this.callTimeoutMs = next.callTimeoutMs;
    }
    this.directoryConfig = next.directory;
    this.security = next.security;
    const desired = new Map(next.upstreams.map((u) => [u.id, u]));
    const current = new Map(
      [...this.connections.entries()].map(([id, c]) => [id, c.config]),
    );

    // Remove disappeared upstreams.
    for (const id of current.keys()) {
      if (!desired.has(id)) {
        await this.disconnectOne(id, "removed by hot-reload");
      }
    }
    // Add new + replace changed.
    for (const [id, cfg] of desired) {
      const existing = current.get(id);
      if (!existing) {
        try {
          await this.connectOne(cfg);
          this.emitUpstreamEvent(id, "added", true);
        } catch (err) {
          this.recordConnectFailure(cfg, err);
        }
      } else if (!upstreamsEqual(existing, cfg)) {
        await this.disconnectOne(id, "replaced by hot-reload");
        try {
          await this.connectOne(cfg);
          this.emitUpstreamEvent(id, "replaced", true);
        } catch (err) {
          this.recordConnectFailure(cfg, err);
        }
      }
    }
    this.lastSyncAt = new Date();
  }

  private recordConnectFailure(cfg: UpstreamConfig, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[mcmcp] upstream '${cfg.id}' failed to connect: ${msg}\n`);
    // Track a placeholder connection entry so status mode can report the failure.
    const existing = this.connections.get(cfg.id);
    if (existing) {
      existing.connected = false;
      existing.lastError = msg;
    } else {
      // Stub entry without a usable client; will be retried on next call.
      this.connections.set(cfg.id, {
        config: cfg,
        client: undefined as unknown as Client,
        connected: false,
        lastError: msg,
        toolCount: 0,
        driftEvents: [],
        schemaFingerprints: new Map(),
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        lastReconnectAttempt: null,
      });
    }
    this._connectedVersion++;
    this.emitUpstreamEvent(cfg.id, "connect_failed", false, msg);
  }

  private async connectOne(cfg: UpstreamConfig): Promise<void> {
    /** Create a fresh Client with sampling handler wired up. */
    const makeClient = (): Client => {
      const c = new Client(
        { name: `mcmcp-proxy-${cfg.id}`, version: MCMCP_VERSION },
        // Declare sampling capability so upstreams know they may issue
        // sampling/createMessage. We forward those to {@link samplingSink}.
        { capabilities: this.samplingSink ? { sampling: {} } : {} },
      );
      if (this.samplingSink) {
        const sink = this.samplingSink;
        c.setRequestHandler(CreateMessageRequestSchema, async (req) => {
          // Forward upstream's sampling request to mcmcp's downstream Server,
          // which in turn surfaces it to the host LLM client.
          return await sink(req.params);
        });
      }
      return c;
    };
    let client = makeClient();

    /** Race a promise against the connect timeout; clears the timer on resolution. */
    const withConnectTimeout = <T>(p: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutP = new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(`connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
          CONNECT_TIMEOUT_MS,
        );
      });
      return Promise.race([p, timeoutP]).finally(() => clearTimeout(timer));
    };

    if (cfg.transport === "stdio") {
      const stdio = cfg as StdioUpstream;
      const transport = new StdioClientTransport({
        command: stdio.command,
        args: stdio.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(stdio.env ?? {}) },
        cwd: stdio.cwd,
      });
      await withConnectTimeout(client.connect(transport));
    } else {
      const sse = cfg as SseUpstream;
      const headers: Record<string, string> = { ...(sse.headers ?? {}) };
      if (sse.auth?.type === "bearer") {
        headers["Authorization"] = `Bearer ${sse.auth.token}`;
      } else if (sse.auth?.type === "header") {
        Object.assign(headers, sse.auth.headers);
      }
      // OAuth 2.0 / PKCE provider takes precedence; the SDK manages the
      // bearer header itself when an authProvider is supplied.
      const authProvider = sse.oauth
        ? await buildOAuthProvider(sse.oauth, sse.url)
        : undefined;
      const requestInit =
        Object.keys(headers).length > 0 ? { headers } : undefined;
      const httpTransport = new StreamableHTTPClientTransport(new URL(sse.url), {
        ...(authProvider ? { authProvider } : {}),
        requestInit,
      });
      try {
        await withConnectTimeout(client.connect(httpTransport));
      } catch (err) {
        // 404/405 indicates the server only speaks legacy SSE (pre-2025-03-26
        // spec). Create a fresh client and retry with SSEClientTransport.
        if (err instanceof StreamableHTTPError && (err.code === 404 || err.code === 405)) {
          process.stderr.write(
            `[mcmcp] upstream '${cfg.id}' rejected Streamable HTTP (${err.code}), retrying with legacy SSE\n`,
          );
          client = makeClient();
          const sseTransport = new SSEClientTransport(new URL(sse.url), {
            ...(authProvider ? { authProvider } : {}),
            requestInit,
          });
          await withConnectTimeout(client.connect(sseTransport));
        } else {
          throw err;
        }
      }
    }

    const list = await withConnectTimeout(client.listTools());
    let count = 0;
    const aliases = cfg.aliases ?? {};
    const newFingerprints = new Map<string, string>();
    for (const t of list.tools) {
      const baseName = t.name;
      // Aliases win over collision-prefixing, but still defer to existing
      // entries to keep names unique across upstreams.
      let exposedName = aliases[baseName] ?? baseName;
      if (this.tools.has(exposedName)) {
        const existing = this.tools.get(exposedName)!;
        if (existing.upstreamId !== cfg.id) {
          exposedName = `${cfg.id}__${baseName}`;
          process.stderr.write(
            `[mcmcp] tool name collision: '${baseName}' from '${cfg.id}' renamed to '${exposedName}'\n`,
          );
        }
      }
      const inputSchema = (t.inputSchema ?? { type: "object" }) as object;
      const fingerprint = createHash("sha256")
        .update(baseName)
        .update("\0")
        .update(JSON.stringify(inputSchema))
        .digest("hex");
      newFingerprints.set(baseName, fingerprint);
      this.tools.set(exposedName, {
        name: exposedName,
        originalName: baseName,
        description: t.description ?? "",
        inputSchema,
        upstreamId: cfg.id,
        schemaFingerprint: fingerprint,
      });
      let bucket = this.originalNameIndex.get(baseName);
      if (!bucket) {
        bucket = new Set();
        this.originalNameIndex.set(baseName, bucket);
      }
      bucket.add(cfg.id);
      count++;
    }

    // Evict tools that belonged to this upstream but are absent from the new
    // listTools response (e.g. upstream dropped a tool between reconnects).
    for (const [exposedName, t] of [...this.tools]) {
      if (t.upstreamId === cfg.id && !newFingerprints.has(t.originalName)) {
        this.tools.delete(exposedName);
        const bucket = this.originalNameIndex.get(t.originalName);
        if (bucket) {
          bucket.delete(cfg.id);
          if (bucket.size === 0) this.originalNameIndex.delete(t.originalName);
        }
      }
    }

    // Schema-drift detection. Compare new fingerprints against the prior
    // connection's stored set; record up to 10 most recent events per
    // upstream. Events are surfaced via mode=status as `recent_drift`.
    const previous = this.connections.get(cfg.id);
    const drift: DriftEvent[] = previous?.driftEvents ?? [];
    if (previous?.client && previous.schemaFingerprints.size > 0) {
      const prev = previous.schemaFingerprints;
      const now = new Date().toISOString();
      const newEvents: DriftEvent[] = [];
      for (const [name, fp] of newFingerprints) {
        const before = prev.get(name);
        if (before === undefined) {
          newEvents.push({ upstreamId: cfg.id, toolName: name, kind: "added", at: now });
        } else if (before !== fp) {
          newEvents.push({ upstreamId: cfg.id, toolName: name, kind: "changed", at: now });
        }
      }
      for (const name of prev.keys()) {
        if (!newFingerprints.has(name)) {
          newEvents.push({ upstreamId: cfg.id, toolName: name, kind: "removed", at: now });
        }
      }
      for (const ev of newEvents) {
        drift.push(ev);
        this.logger.log({
          type: "upstream_event",
          mode: `schema_drift_${ev.kind}`,
          upstream_id: cfg.id,
          tool_name: ev.toolName,
          duration_ms: 0,
          ok: true,
        });
      }
      while (drift.length > 10) drift.shift();
    }

    // Best-effort fetch of resources + prompts. Many upstreams don't
    // implement these; "method not found" is silently ignored.
    let resourceCount = 0;
    try {
      const r = await client.listResources();
      // Drop prior entries for this upstream
      for (const [k, v] of [...this.resources]) {
        if (v.upstreamId === cfg.id) this.resources.delete(k);
      }
      for (const res of r.resources as Resource[]) {
        this.resources.set(`${cfg.id}::${res.uri}`, {
          uri: res.uri,
          name: res.name,
          description: res.description,
          mimeType: res.mimeType,
          upstreamId: cfg.id,
        });
        resourceCount++;
      }
    } catch {
      /* upstream does not support resources */
    }
    let promptCount = 0;
    try {
      const p = await client.listPrompts();
      for (const [k, v] of [...this.prompts]) {
        if (v.upstreamId === cfg.id) this.prompts.delete(k);
      }
      for (const pr of p.prompts as Prompt[]) {
        this.prompts.set(`${cfg.id}::${pr.name}`, {
          name: pr.name,
          description: pr.description,
          arguments: pr.arguments,
          upstreamId: cfg.id,
        });
        promptCount++;
      }
    } catch {
      /* upstream does not support prompts */
    }

    const conn: UpstreamConnection = {
      config: cfg,
      client,
      connected: true,
      lastError: null,
      toolCount: count,
      driftEvents: drift,
      schemaFingerprints: newFingerprints,
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      lastReconnectAttempt: null,
    };
    this.connections.set(cfg.id, conn);
    this.rateLimiter.configure(cfg.id, cfg.rateLimit?.requestsPerMinute);
    this.cache.configure(
      cfg.id,
      cfg.cache
        ? {
            enabled: cfg.cache.enabled,
            ttlMs: cfg.cache.ttlMs ?? 5_000,
            maxEntries: cfg.cache.maxEntries ?? 200,
          }
        : undefined,
    );
    process.stderr.write(
      `[mcmcp] upstream '${cfg.id}' connected (${count} tool${count === 1 ? "" : "s"}` +
        (resourceCount ? `, ${resourceCount} resource${resourceCount === 1 ? "" : "s"}` : "") +
        (promptCount ? `, ${promptCount} prompt${promptCount === 1 ? "" : "s"}` : "") +
        `)\n`,
    );
    this.emitUpstreamEvent(cfg.id, "connected", true);
    this._dirtyBit++;
    this._connectedVersion++;
  }

  private async disconnectOne(id: string, reason: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    if (conn.client && typeof conn.client.close === "function") {
      try {
        await conn.client.close();
      } catch {
        /* ignore */
      }
    }
    // Evict cached tool entries owned by this upstream.
    for (const [name, t] of [...this.tools]) {
      if (t.upstreamId === id) {
        this.tools.delete(name);
        const bucket = this.originalNameIndex.get(t.originalName);
        if (bucket) {
          bucket.delete(id);
          if (bucket.size === 0) this.originalNameIndex.delete(t.originalName);
        }
      }
    }
    for (const [k, v] of [...this.resources]) {
      if (v.upstreamId === id) this.resources.delete(k);
    }
    for (const [k, v] of [...this.prompts]) {
      if (v.upstreamId === id) this.prompts.delete(k);
    }
    this.rateLimiter.remove(id);
    this.cache.remove(id);
    this.connections.delete(id);
    process.stderr.write(`[mcmcp] upstream '${id}' disconnected (${reason})\n`);
    this.emitUpstreamEvent(id, "disconnected", true, reason);
    this._dirtyBit++;
    this._connectedVersion++;
  }

  private emitUpstreamEvent(
    upstreamId: string,
    event: string,
    ok: boolean,
    error?: string,
  ): void {
    this.logger.log({
      type: "upstream_event",
      mode: event,
      upstream_id: upstreamId,
      duration_ms: 0,
      ok,
      error,
    });
  }

  /** Returns cached tool entries, optionally filtered by upstream, name substring, and/or free-text query. */
  getTools(upstreamFilter?: string, toolFilter?: string, query?: string): ToolEntry[] {
    const needle = toolFilter?.toLowerCase();
    const queryNeedle = query?.toLowerCase();
    const out: ToolEntry[] = [];
    for (const t of this.tools.values()) {
      if (upstreamFilter && t.upstreamId !== upstreamFilter) continue;
      if (needle && !t.name.toLowerCase().includes(needle)) continue;
      if (
        queryNeedle &&
        !t.name.toLowerCase().includes(queryNeedle) &&
        !t.description.toLowerCase().includes(queryNeedle)
      ) continue;
      out.push(t);
    }
    return out;
  }

  /** Returns the entry for an exact (exposed) tool name. */
  getTool(toolName: string): ToolEntry | undefined {
    return this.tools.get(toolName);
  }

  /** Lists known upstream ids (regardless of connection state). */
  listUpstreamIds(): string[] {
    const ids = [...this.connections.keys()];
    if (this.internalHandlers.size > 0 && !ids.includes(INTERNAL_UPSTREAM_ID)) {
      ids.push(INTERNAL_UPSTREAM_ID);
    }
    return ids;
  }

  /** Returns the configured per-call timeout in ms. */
  getCallTimeoutMs(): number {
    return this.callTimeoutMs;
  }

  /** Resolve a name (exposed or original) plus optional hint to a single entry. */
  resolveTool(
    toolName: string,
    upstreamHint?: string,
  ): { entry: ToolEntry } | { error: string } {
    const candidates = new Map<string, ToolEntry>();
    const direct = this.tools.get(toolName);
    if (direct) candidates.set(direct.name, direct);
    const fromIndex = this.originalNameIndex.get(toolName);
    if (fromIndex) {
      for (const t of this.tools.values()) {
        if (t.originalName === toolName && fromIndex.has(t.upstreamId)) {
          candidates.set(t.name, t);
        }
      }
    }
    if (candidates.size === 0) {
      return {
        error:
          `No tool named '${toolName}'. Call tool_tool with mode=list ` +
          `(optionally with tool_filter) to discover available tools.`,
      };
    }
    let pool = [...candidates.values()];
    if (upstreamHint) {
      const filtered = pool.filter((t) => t.upstreamId === upstreamHint);
      if (filtered.length === 0) {
        const valid = pool.map((t) => t.upstreamId);
        return {
          error:
            `upstream_hint '${upstreamHint}' does not own tool '${toolName}'. ` +
            `Valid upstream id(s): ${valid.join(", ")}.`,
        };
      }
      pool = filtered;
    }
    if (pool.length > 1) {
      const ups = pool.map((t) => t.upstreamId).join(", ");
      return {
        error:
          `Tool name '${toolName}' is ambiguous across upstreams [${ups}]. ` +
          `Pass 'upstream_hint' to disambiguate.`,
      };
    }
    return { entry: pool[0]! };
  }

  /** Send a tools/list ping to one upstream and measure RTT. */
  async ping(upstreamId: string): Promise<{ ok: boolean; ms: number; error?: string }> {
    const conn = this.connections.get(upstreamId);
    if (!conn || !conn.client) {
      return { ok: false, ms: 0, error: conn?.lastError ?? "not connected" };
    }
    const start = Date.now();
    try {
      await conn.client.listTools();
      conn.connected = true;
      conn.lastError = null;
      this.lastSyncAt = new Date();
      return { ok: true, ms: Date.now() - start };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      conn.connected = false;
      conn.lastError = msg;
      this._connectedVersion++;
      return { ok: false, ms: Date.now() - start, error: msg };
    }
  }

  /** Build a status report by pinging every upstream in parallel. */
  async status(upstreamFilter?: string): Promise<UpstreamStatus[]> {
    const externalIds = upstreamFilter
      ? [upstreamFilter].filter((id) => this.connections.has(id))
      : [...this.connections.keys()];
    const results = await Promise.all(
      externalIds.map(async (id) => {
        const conn = this.connections.get(id)!;
        const ping = conn.client ? await this.ping(id) : { ok: false, ms: 0, error: conn.lastError ?? "not connected" };
        const status: UpstreamStatus = {
          id,
          label: conn.config.label ?? null,
          transport: conn.config.transport,
          connected: ping.ok,
          tool_count: conn.toolCount,
          resource_count: this.countResourcesFor(id),
          prompt_count: this.countPromptsFor(id),
          last_ping_ms: ping.ok ? ping.ms : null,
          last_ping_at: new Date().toISOString(),
          error: ping.ok ? null : ping.error ?? null,
          cache: this.cache.stats(id),
          recent_drift: conn.driftEvents.slice(-10),
          circuit_open_until:
            conn.circuitOpenUntil !== null
              ? new Date(conn.circuitOpenUntil).toISOString()
              : null,
          consecutive_failures: conn.consecutiveFailures,
        };
        return status;
      }),
    );
    // Append the synthetic internal upstream if it has any handlers and
    // either no filter is set or the filter matches.
    const wantInternal =
      this.internalHandlers.size > 0 &&
      (!upstreamFilter || upstreamFilter === INTERNAL_UPSTREAM_ID);
    if (wantInternal) {
      results.push({
        id: INTERNAL_UPSTREAM_ID,
        label: "mcmcp (internal)",
        transport: "stdio",
        connected: true,
        tool_count: this.internalHandlers.size,
        last_ping_ms: 0,
        last_ping_at: new Date().toISOString(),
        error: null,
        cache: { enabled: false, entries: 0, hit_rate_pct: 0 },
        circuit_open_until: null,
        consecutive_failures: 0,
      });
    }
    this.logger.log({
      type: "status",
      mode: "status",
      duration_ms: 0,
      ok: true,
    });
    return results;
  }

  /**
   * Attempt to reconnect a failed upstream. Throttled to at most once per
   * {@link RECONNECT_COOLDOWN_MS}.
   *
   * Race-safety: we close the old transport without evicting tool entries so
   * concurrent `resolveTool` calls continue to see the tool names (and return
   * a "not connected" error) rather than a confusing "tool not found".  The
   * tool map is refreshed atomically at the end of `connectOne`.
   */
  private async tryReconnect(upstreamId: string): Promise<void> {
    const conn = this.connections.get(upstreamId);
    if (!conn) return;
    const now = Date.now();
    if (
      conn.lastReconnectAttempt !== null &&
      now - conn.lastReconnectAttempt < RECONNECT_COOLDOWN_MS
    ) {
      return; // cooling down
    }
    conn.lastReconnectAttempt = now;
    const savedConfig = conn.config;
    process.stderr.write(`[mcmcp] attempting reconnect to upstream '${upstreamId}'\n`);
    try {
      if (conn.client) {
        // Close the old transport without evicting tools (avoids the race
        // window where resolveTool would return "not found").
        try { await conn.client.close(); } catch { /* ignore */ }
        // Mark as disconnected so subsequent calls know not to use this client.
        conn.connected = false;
        conn.client = undefined as unknown as Client;
        this._connectedVersion++;
      } else {
        // Stub entry from an initial connect failure — remove it so connectOne
        // can insert a fresh entry.
        this.connections.delete(upstreamId);
      }
      await this.connectOne(savedConfig);
      this.lastSyncAt = new Date();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mcmcp] upstream '${upstreamId}' reconnect failed: ${msg}\n`);
      this.recordConnectFailure(savedConfig, err);
      // Ensure the attempt timestamp survives so the cooldown is respected.
      const stub = this.connections.get(upstreamId);
      if (stub) stub.lastReconnectAttempt = now;
    }
  }

  /**
   * Forward a tool invocation to the owning upstream MCP server, applying
   * rate limiting, caching, retry, and timeout policies.
   */
  async callTool(
    toolName: string,
    args: unknown,
    upstreamHint?: string,
  ): Promise<CallToolResult> {
    return await withSpan(
      "mcmcp.tool_call",
      { "mcmcp.tool": toolName, "mcmcp.upstream_hint": upstreamHint ?? "" },
      () => this.callToolInner(toolName, args, upstreamHint),
    );
  }

  private async callToolInner(
    toolName: string,
    args: unknown,
    upstreamHint?: string,
  ): Promise<CallToolResult> {
    const callStart = Date.now();
    const resolved = this.resolveTool(toolName, upstreamHint);
    if ("error" in resolved) {
      return errorResult(resolved.error);
    }
    const entry = resolved.entry;

    // Internal tools short-circuit before any connection / rate-limit /
    // cache logic. They run in-process and bypass all upstream policies.
    if (entry.upstreamId === INTERNAL_UPSTREAM_ID) {
      const handler = this.internalHandlers.get(entry.name);
      if (!handler || !this.internalCtx) {
        return errorResult(`Internal tool '${entry.name}' has no registered handler.`);
      }
      let result: CallToolResult;
      try {
        result = await handler(args, this.internalCtx);
      } catch (err) {
        result = errorResult(
          `Internal tool '${entry.name}' threw: ${(err as Error).message}`,
        );
      }
      const ok = !result.isError;
      this.metrics.recordCall(INTERNAL_UPSTREAM_ID, entry.name, Date.now() - callStart, ok);
      this.logger.log({
        type: "call",
        mode: "call",
        tool_name: entry.name,
        upstream_id: INTERNAL_UPSTREAM_ID,
        duration_ms: Date.now() - callStart,
        ok,
      });
      return result;
    }

    // ---- Circuit breaker check -----------------------------------
    {
      const c = this.connections.get(entry.upstreamId);
      if (c?.circuitOpenUntil && Date.now() < c.circuitOpenUntil) {
        const retryAfterSec = Math.ceil((c.circuitOpenUntil - Date.now()) / 1000);
        return errorResult(
          `Upstream '${entry.upstreamId}' circuit breaker is open after repeated failures. ` +
            `Retry after ~${retryAfterSec}s.`,
        );
      }
    }

    // ---- Auto-reconnect if needed --------------------------------
    {
      const c = this.connections.get(entry.upstreamId);
      if (c && (!c.client || !c.connected)) {
        await this.tryReconnect(entry.upstreamId);
      }
    }

    const conn = this.connections.get(entry.upstreamId);
    if (!conn || !conn.client) {
      return errorResult(
        `Upstream '${entry.upstreamId}' is not connected (tool '${toolName}' is cached but its connection is gone).`,
      );
    }

    // ---- Middleware: before-hooks -----------------------------------
    const mwCtx: MiddlewareCtx = {
      upstreamId: entry.upstreamId,
      toolName: entry.name,
      originalName: entry.originalName,
      state: {},
    };
    let effectiveArgs = args;
    if (this.middlewares.length > 0) {
      try {
        const before = await runBefore(this.middlewares, args, mwCtx, entry);
        if (before.shortCircuit) {
          this.metrics.recordCall(entry.upstreamId, entry.name, Date.now() - callStart, !before.shortCircuit.isError);
          return before.shortCircuit;
        }
        effectiveArgs = before.args;
      } catch (err) {
        return errorResult(`Middleware before-hook failed: ${(err as Error).message}`);
      }
    }

    // Rate limit gate.
    const rate = this.rateLimiter.tryConsume(entry.upstreamId);
    if (!rate.allowed) {
      this.metrics.recordRateLimited(entry.upstreamId);
      const result = errorResult(
        `Rate limit exceeded for upstream '${entry.upstreamId}' (${rate.requestsPerMinute} req/min). Retry after ~${rate.retryAfterSeconds}s.`,
      );
      this.logger.log({
        type: "call",
        mode: "call",
        tool_name: entry.name,
        upstream_id: entry.upstreamId,
        duration_ms: Date.now() - callStart,
        ok: false,
        error: "rate_limited",
      });
      return result;
    }

    // Cache hit.
    const cached = this.cache.get(entry.upstreamId, entry.originalName, effectiveArgs);
    if (cached) {
      this.metrics.recordCacheHit(entry.upstreamId);
      const tagged: CallToolResult = {
        ...cached.value,
        content: [
          { type: "text", text: `[MCMCP cache hit, age: ${cached.ageMs}ms]` },
          ...(cached.value.content ?? []),
        ],
      };
      this.logger.log({
        type: "call",
        mode: "call",
        tool_name: entry.name,
        upstream_id: entry.upstreamId,
        duration_ms: Date.now() - callStart,
        ok: true,
        cache_hit: true,
      });
      return tagged;
    }

    // Retry loop.
    const retry = conn.config.retry;
    const maxAttempts = Math.max(1, retry?.maxAttempts ?? 1);
    const initialDelay = Math.max(0, retry?.initialDelayMs ?? 200);
    const backoff = Math.max(1, retry?.backoffFactor ?? 2);
    const retryOn = new Set(retry?.retryOn ?? ["timeout", "transport_error"]);

    let lastError: { kind: "timeout" | "transport_error"; message: string } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const cap = initialDelay * Math.pow(backoff, attempt);
        const delay = Math.floor(Math.random() * cap);
        this.logger.log({
          type: "upstream_event",
          mode: "retry",
          upstream_id: entry.upstreamId,
          tool_name: entry.name,
          duration_ms: delay,
          ok: false,
          error: lastError?.message,
          attempt,
        });
        await sleep(delay);
      }

      // Re-fetch conn each attempt to pick up any reconnect.
      const currentConn = this.connections.get(entry.upstreamId);
      if (!currentConn?.client) {
        return errorResult(`Upstream '${entry.upstreamId}' disconnected during retry.`);
      }

      const attemptStart = Date.now();
      const outcome = await this.invokeOnce(currentConn.client, entry, effectiveArgs);
      const duration = Date.now() - attemptStart;
      if (outcome.kind === "result") {
        // Run middleware `after` hooks first so they can modify the
        // payload (PII scrub, redaction, etc.). The security scan is
        // applied last so a malicious middleware cannot bypass it, and
        // is what we cache: we never want to cache content that the
        // policy would otherwise rewrite.
        let processed = outcome.value;
        if (this.middlewares.length > 0) {
          try {
            processed = await runAfter(this.middlewares, processed, mwCtx, entry);
          } catch (err) {
            return errorResult(`Middleware after-hook failed: ${(err as Error).message}`);
          }
        }
        const secured = applySecurityPolicy(processed, this.security);
        const final = secured.result;
        const isErr = Boolean(final.isError);
        if (!isErr) {
          this.cache.set(entry.upstreamId, entry.originalName, effectiveArgs, final);
        }
        this.metrics.recordCall(entry.upstreamId, entry.name, duration, !isErr);
        this.logger.log({
          type: "call",
          mode: "call",
          tool_name: entry.name,
          upstream_id: entry.upstreamId,
          duration_ms: duration,
          ok: !isErr,
          ...(secured.report.matched.length > 0
            ? { security_flags: secured.report.matched }
            : {}),
        });
        // Reset circuit breaker on success.
        currentConn.consecutiveFailures = 0;
        currentConn.circuitOpenUntil = null;
        return isErr ? prependUpstreamId(final, entry.upstreamId) : final;
      }

      // outcome.kind is "timeout" or "transport_error"
      lastError = { kind: outcome.kind, message: outcome.message };

      // Track consecutive failures and open circuit breaker if threshold reached.
      currentConn.consecutiveFailures++;
      if (currentConn.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        currentConn.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
        currentConn.consecutiveFailures = 0;
        process.stderr.write(
          `[mcmcp] upstream '${entry.upstreamId}' circuit breaker opened after ` +
            `${CIRCUIT_BREAKER_THRESHOLD} consecutive failures\n`,
        );
      }

      // On transport error, attempt reconnect before the next retry.
      if (
        outcome.kind === "transport_error" &&
        retryOn.has("transport_error") &&
        attempt + 1 < maxAttempts
      ) {
        await this.tryReconnect(entry.upstreamId);
      }

      if (!retryOn.has(outcome.kind) || attempt + 1 >= maxAttempts) {
        this.metrics.recordCall(entry.upstreamId, entry.name, duration, false);
        const msg =
          outcome.kind === "timeout"
            ? `Upstream '${entry.upstreamId}' timed out after ${this.callTimeoutMs}ms calling '${entry.originalName}'.`
            : `Upstream '${entry.upstreamId}' error calling '${entry.originalName}': ${outcome.message}`;
        this.logger.log({
          type: "call",
          mode: "call",
          tool_name: entry.name,
          upstream_id: entry.upstreamId,
          duration_ms: duration,
          ok: false,
          error: outcome.kind,
        });
        return errorResult(msg);
      }
    }
    // Defensive: unreachable.
    return errorResult(`Upstream '${entry.upstreamId}' failed: ${lastError?.message ?? "unknown error"}`);
  }

  private async invokeOnce(
    client: Client,
    entry: ToolEntry,
    args: unknown,
  ): Promise<
    | { kind: "result"; value: CallToolResult }
    | { kind: "timeout"; message: string }
    | { kind: "transport_error"; message: string }
  > {
    const timeoutMs = this.callTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutError(`timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      const callArgs =
        args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
      const raw = (await Promise.race([
        client.callTool({ name: entry.originalName, arguments: callArgs }),
        timeoutP,
      ])) as CallToolResult;
      return { kind: "result", value: raw };
    } catch (err) {
      if (err instanceof TimeoutError) {
        return { kind: "timeout", message: err.message };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: "transport_error", message: msg };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Close all upstream connections. */
  async close(): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map((c) =>
        c.client && typeof c.client.close === "function"
          ? c.client.close().catch(() => undefined)
          : Promise.resolve(),
      ),
    );
    this.connections.clear();
    this.tools.clear();
    this.originalNameIndex.clear();
  }

  /** Timestamp of the most recent successful upstream sync. */
  getLastSyncAt(): Date {
    return this.lastSyncAt;
  }

  /**
   * Register the in-process internal tools (e.g. `mcmcp__add_upstream`).
   * Safe to call once after {@link init}; subsequent calls overwrite.
   */
  registerInternalTools(defs: ReadonlyArray<InternalToolDef>, ctx: InternalCtx): void {
    // Drop any prior internal entries (idempotent).
    for (const [name, t] of [...this.tools]) {
      if (t.upstreamId === INTERNAL_UPSTREAM_ID) this.tools.delete(name);
    }
    this.internalHandlers.clear();
    this.internalCtx = ctx;
    for (const def of defs) {
      if (this.tools.has(def.name)) {
        process.stderr.write(
          `[mcmcp] internal tool '${def.name}' collides with an upstream tool — skipping.\n`,
        );
        continue;
      }
      this.tools.set(def.name, internalToolEntry(def));
      this.internalHandlers.set(def.name, def.handler);
    }
    this._dirtyBit++;
  }

  /** Effective directory thresholds (with defaults applied). */
  getDirectoryConfig(): ReturnType<typeof resolveDirectoryConfig> {
    return resolveDirectoryConfig(this.directoryConfig);
  }

  /**
   * Build a {@link DirectorySnapshot} for the live tool list. Times the
   * call and records it via {@link Metrics.recordDirectorySnapshot} (if
   * available) so the metrics endpoint can report build cost. Pure data
   * is delegated to {@link buildDirectorySnapshot}.
   */
  buildSnapshot(): DirectorySnapshot {
    // Invalidate on any tool-map change (_dirtyBit) OR any connection state
    // change (_connectedVersion) so disconnected-upstream warnings stay fresh.
    if (
      this._snapshotCache &&
      this._snapshotDirtyBit === this._dirtyBit &&
      this._snapshotConnectedVersion === this._connectedVersion
    ) {
      return this._snapshotCache;
    }
    const start = Date.now();
    const tools: DirectoryToolEntry[] = [];
    for (const t of this.tools.values()) {
      tools.push({ name: t.name, upstreamId: t.upstreamId });
    }
    const upstreams: DirectoryUpstreamEntry[] = [];
    for (const c of this.connections.values()) {
      upstreams.push({ id: c.config.id, connected: c.connected });
    }
    const thresholds = this.getDirectoryConfig();
    const snap = buildDirectorySnapshot(
      tools,
      upstreams,
      {
        tierOneMaxTools: thresholds.tierOneMaxTools,
        tierTwoMaxServers: thresholds.tierTwoMaxServers,
      },
      { lastSyncAt: this.lastSyncAt.toISOString() },
    );
    const elapsed = Date.now() - start;
    if (typeof this.metrics.recordDirectorySnapshot === "function") {
      this.metrics.recordDirectorySnapshot(snap.tier, elapsed);
    }
    this._snapshotCache = snap;
    this._snapshotDirtyBit = this._dirtyBit;
    this._snapshotConnectedVersion = this._connectedVersion;
    return snap;
  }

  /** Other tool names from the same upstream as `toolName`. */
  getRelatedTools(toolName: string, limit = 5): string[] {
    const entry = this.tools.get(toolName);
    if (!entry) return [];
    const related: string[] = [];
    for (const t of this.tools.values()) {
      if (t.upstreamId === entry.upstreamId && t.name !== entry.name) {
        related.push(t.name);
      }
    }
    related.sort();
    return related.slice(0, limit);
  }

  // ---- Resources -----------------------------------------------------

  /** All resources, optionally filtered by upstream id. */
  listResources(upstreamFilter?: string): ResourceEntry[] {
    const out: ResourceEntry[] = [];
    for (const r of this.resources.values()) {
      if (upstreamFilter && r.upstreamId !== upstreamFilter) continue;
      out.push(r);
    }
    return out;
  }

  /** Read one resource by uri (`upstreamHint` disambiguates duplicates). */
  async readResource(
    uri: string,
    upstreamHint?: string,
  ): Promise<{ ok: true; contents: unknown } | { ok: false; error: string }> {
    const candidates: ResourceEntry[] = [];
    for (const r of this.resources.values()) {
      if (r.uri !== uri) continue;
      if (upstreamHint && r.upstreamId !== upstreamHint) continue;
      candidates.push(r);
    }
    if (candidates.length === 0) {
      return { ok: false, error: `No resource with uri '${uri}'.` };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        error: `uri '${uri}' is ambiguous across upstreams [${candidates.map((c) => c.upstreamId).join(", ")}]. Pass upstream_hint.`,
      };
    }
    const entry = candidates[0]!;
    const conn = this.connections.get(entry.upstreamId);
    if (!conn?.client) return { ok: false, error: `Upstream '${entry.upstreamId}' not connected.` };
    try {
      const res = await conn.client.readResource({ uri });
      return { ok: true, contents: res };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // ---- Prompts -------------------------------------------------------

  /** All prompts, optionally filtered by upstream id. */
  listPrompts(upstreamFilter?: string): PromptEntry[] {
    const out: PromptEntry[] = [];
    for (const p of this.prompts.values()) {
      if (upstreamFilter && p.upstreamId !== upstreamFilter) continue;
      out.push(p);
    }
    return out;
  }

  /** Render one prompt template with arguments. */
  async getPrompt(
    name: string,
    promptArgs?: Record<string, string>,
    upstreamHint?: string,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const candidates: PromptEntry[] = [];
    for (const p of this.prompts.values()) {
      if (p.name !== name) continue;
      if (upstreamHint && p.upstreamId !== upstreamHint) continue;
      candidates.push(p);
    }
    if (candidates.length === 0) {
      return { ok: false, error: `No prompt named '${name}'.` };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        error: `prompt '${name}' is ambiguous across upstreams [${candidates.map((c) => c.upstreamId).join(", ")}]. Pass upstream_hint.`,
      };
    }
    const entry = candidates[0]!;
    const conn = this.connections.get(entry.upstreamId);
    if (!conn?.client) return { ok: false, error: `Upstream '${entry.upstreamId}' not connected.` };
    try {
      const res = await conn.client.getPrompt({ name, arguments: promptArgs });
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private countResourcesFor(id: string): number {
    let n = 0;
    for (const r of this.resources.values()) if (r.upstreamId === id) n++;
    return n;
  }

  private countPromptsFor(id: string): number {
    let n = 0;
    for (const p of this.prompts.values()) if (p.upstreamId === id) n++;
    return n;
  }
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

function prependUpstreamId(
  result: CallToolResult,
  upstreamId: string,
): CallToolResult {
  const tag = `[upstream:${upstreamId}] `;
  const content = (result.content ?? []).map((c) => {
    if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
      const textPart = c as { type: "text"; text: string };
      return { ...textPart, text: tag + textPart.text };
    }
    return c;
  });
  return { ...result, content };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Re-export retry config type for callers that wire policies in tests.
export type { RetryConfig };
