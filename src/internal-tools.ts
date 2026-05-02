/**
 * Internal "virtual" MCP server exposed by mcmcp itself. These tools are
 * implemented directly in-process — no real MCP upstream sits behind
 * them — and surface mcmcp's own configuration / lifecycle so an LLM can
 * inspect and mutate the running set of upstream servers.
 *
 * All tools are namespaced under the upstream id {@link INTERNAL_UPSTREAM_ID}
 * (`mcmcp`). Tool names use the `mcmcp__` prefix so they remain obviously
 * distinct from user upstream tools when listed.
 */
import type { CallToolResult, ToolEntry } from "./proxy.js";
import type { MCMCPConfig, UpstreamConfig } from "./config.js";
import { parseConfigObject } from "./config.js";

/** The synthetic upstream id used for in-process tools. */
export const INTERNAL_UPSTREAM_ID = "mcmcp";

/** Context object passed to every internal tool handler. */
export interface InternalCtx {
  /** Absolute path of the active config file on disk. */
  configPath: string;
  /** Live, mutable reference to the runtime config. */
  getConfig: () => MCMCPConfig;
  /**
   * Validate `next`, persist it to {@link configPath}, and apply the
   * diff to the running proxy. Throws on validation failure.
   */
  applyMutation: (next: MCMCPConfig, reason: string) => Promise<void>;
  /** Force a re-read of the config file from disk. */
  reloadFromDisk: () => Promise<void>;
}

/** A single internal tool's surface + implementation. */
export interface InternalToolDef {
  name: string;
  description: string;
  inputSchema: object;
  /**
   * `observer` = read-only inspection (always available).
   * `operator` = mutates config / lifecycle (hidden in readonly mode).
   */
  category: "observer" | "operator";
  handler: (args: unknown, ctx: InternalCtx) => Promise<CallToolResult>;
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Strip secrets from an upstream definition before returning it to the caller. */
function redactUpstream(u: UpstreamConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(u)) as Record<string, unknown>;
  if (clone.auth && typeof clone.auth === "object") {
    const auth = clone.auth as Record<string, unknown>;
    if (auth.type === "bearer" && typeof auth.token === "string") {
      auth.token = "***redacted***";
    } else if (auth.type === "header" && isObject(auth.headers)) {
      const redactedHeaders: Record<string, string> = {};
      for (const k of Object.keys(auth.headers)) redactedHeaders[k] = "***redacted***";
      auth.headers = redactedHeaders;
    }
  }
  if (clone.oauth && typeof clone.oauth === "object") {
    const oauth = clone.oauth as Record<string, unknown>;
    if (typeof oauth.clientSecret === "string") oauth.clientSecret = "***redacted***";
    if (typeof oauth.initialRefreshToken === "string") oauth.initialRefreshToken = "***redacted***";
  }
  return clone;
}

/** Strip secrets from the full config. */
function redactConfig(c: MCMCPConfig): Record<string, unknown> {
  return {
    ...c,
    upstreams: c.upstreams.map(redactUpstream),
  };
}

const LIST_UPSTREAMS: InternalToolDef = {
  name: "mcmcp__list_upstreams",
  description:
    "List all upstream MCP servers currently registered with mcmcp (configuration-level summary; use tool_tool mode=status for live health).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  category: "observer",
  handler: async (_args, ctx) => {
    const cfg = ctx.getConfig();
    return ok({
      count: cfg.upstreams.length,
      upstreams: cfg.upstreams.map((u) => ({
        id: u.id,
        label: u.label ?? null,
        transport: u.transport,
        target: u.transport === "stdio" ? `${u.command} ${(u.args ?? []).join(" ")}`.trim() : u.url,
      })),
    });
  },
};

const GET_CONFIG: InternalToolDef = {
  name: "mcmcp__get_config",
  description:
    "Return the full active mcmcp configuration. Auth tokens and header values are redacted.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  category: "observer",
  handler: async (_args, ctx) => ok(redactConfig(ctx.getConfig())),
};

const ADD_UPSTREAM: InternalToolDef = {
  name: "mcmcp__add_upstream",
  description:
    "Register a new upstream MCP server. Body is a full upstream definition (id, transport, command/args for stdio or url for sse, optional auth/retry/cache/rateLimit). The change is validated, persisted to the config file on disk, and the new upstream is connected immediately.",
  inputSchema: {
    type: "object",
    required: ["upstream"],
    additionalProperties: false,
    properties: {
      upstream: {
        type: "object",
        description: "A full upstream definition (same shape as one entry of `upstreams[]`).",
      },
    },
  },
  category: "operator",
  handler: async (args, ctx) => {
    if (!isObject(args) || !isObject(args.upstream)) {
      return fail("'upstream' object is required.");
    }
    const incoming = args.upstream as Partial<UpstreamConfig> & { id?: string };
    if (typeof incoming.id !== "string" || !incoming.id) {
      return fail("upstream.id is required.");
    }
    const cfg = ctx.getConfig();
    if (cfg.upstreams.some((u) => u.id === incoming.id)) {
      return fail(`Upstream id '${incoming.id}' already exists. Use mcmcp__remove_upstream first.`);
    }
    const next: MCMCPConfig = {
      ...cfg,
      upstreams: [...cfg.upstreams, incoming as UpstreamConfig],
    };
    // Round-trip through parseConfigObject for full schema validation AND
    // env-var substitution. Use the returned config (not `next`) so that
    // ${VAR} placeholders in the new upstream are resolved before connecting.
    let validated: MCMCPConfig;
    try {
      validated = parseConfigObject(JSON.parse(JSON.stringify(next)), "<mcmcp__add_upstream>");
    } catch (err) {
      return fail(`Validation failed: ${(err as Error).message}`);
    }
    try {
      await ctx.applyMutation(validated, `add_upstream:${incoming.id}`);
    } catch (err) {
      return fail(`Apply failed: ${(err as Error).message}`);
    }
    return ok({ added: incoming.id, total_upstreams: validated.upstreams.length });
  },
};

const REMOVE_UPSTREAM: InternalToolDef = {
  name: "mcmcp__remove_upstream",
  description:
    "Remove an upstream MCP server by id. The upstream is disconnected, its tools are evicted, and the change is persisted to the config file on disk. Cannot remove the internal 'mcmcp' upstream.",
  inputSchema: {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: {
      id: { type: "string", description: "Upstream id to remove." },
    },
  },
  category: "operator",
  handler: async (args, ctx) => {
    if (!isObject(args) || typeof args.id !== "string") {
      return fail("'id' string is required.");
    }
    const id = args.id;
    if (id === INTERNAL_UPSTREAM_ID) {
      return fail(`Cannot remove the internal '${INTERNAL_UPSTREAM_ID}' upstream.`);
    }
    const cfg = ctx.getConfig();
    if (!cfg.upstreams.some((u) => u.id === id)) {
      return fail(`No upstream with id '${id}'.`);
    }
    const next: MCMCPConfig = {
      ...cfg,
      upstreams: cfg.upstreams.filter((u) => u.id !== id),
    };
    try {
      await ctx.applyMutation(next, `remove_upstream:${id}`);
    } catch (err) {
      return fail(`Apply failed: ${(err as Error).message}`);
    }
    return ok({ removed: id, remaining_upstreams: next.upstreams.length });
  },
};

const RELOAD_CONFIG: InternalToolDef = {
  name: "mcmcp__reload_config",
  description:
    "Force mcmcp to re-read its config file from disk and apply any changes. Useful after editing the file out-of-band when hotReload is disabled.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  category: "operator",
  handler: async (_args, ctx) => {
    try {
      await ctx.reloadFromDisk();
    } catch (err) {
      return fail(`Reload failed: ${(err as Error).message}`);
    }
    return ok({ reloaded: true, configPath: ctx.configPath });
  },
};

/** All internal tool definitions, ordered as they should appear in mode=list. */
export const INTERNAL_TOOL_DEFS: ReadonlyArray<InternalToolDef> = [
  LIST_UPSTREAMS,
  GET_CONFIG,
  ADD_UPSTREAM,
  REMOVE_UPSTREAM,
  RELOAD_CONFIG,
];

/** Build a {@link ToolEntry} for the proxy's tool index. */
export function internalToolEntry(def: InternalToolDef): ToolEntry {
  return {
    name: def.name,
    originalName: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    upstreamId: INTERNAL_UPSTREAM_ID,
  };
}

/**
 * Filter the master internal-tool list according to runtime policy.
 * Today: in `readonly` mode, mutating tools (category=`operator`) are dropped.
 */
export function filterInternalToolsForPolicy(
  defs: ReadonlyArray<InternalToolDef>,
  policy: { readonly?: boolean },
): ReadonlyArray<InternalToolDef> {
  if (policy.readonly) return defs.filter((d) => d.category !== "operator");
  return defs;
}
