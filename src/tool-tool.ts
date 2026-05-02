import { DEFAULT_MAX_BATCH_SIZE, type MCMCPConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import type { CallToolResult, ToolEntry, UpstreamProxy } from "./proxy.js";

/** Input arguments for the `tool_tool` meta-tool. */
export interface ToolToolArgs {
  mode:
    | "list"
    | "describe"
    | "call"
    | "call_batch"
    | "status"
    | "metrics"
    | "list_resources"
    | "read_resource"
    | "list_prompts"
    | "get_prompt";
  upstream_filter?: string;
  tool_filter?: string;
  /** Free-text search across tool name and description (case-insensitive). */
  query?: string;
  tool_name?: string;
  tool_args?: Record<string, unknown>;
  upstream_hint?: string;
  fields?: Array<"name" | "description" | "inputSchema" | "upstream" | "hint_call">;
  page?: number;
  page_size?: number;
  calls?: Array<{
    call_id: string;
    tool_name: string;
    tool_args: Record<string, unknown>;
    upstream_hint?: string;
  }>;
  batch_mode?: "parallel" | "sequential";
  /** mode=read_resource */
  uri?: string;
  /** mode=get_prompt */
  prompt_name?: string;
  prompt_args?: Record<string, string>;
}

/** JSON Schema advertised to MCP clients for the `tool_tool` meta-tool. */
export const TOOL_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: [
        "list",
        "describe",
        "call",
        "call_batch",
        "status",
        "metrics",
        "list_resources",
        "read_resource",
        "list_prompts",
        "get_prompt",
      ],
      description:
        "list/describe/call/call_batch operate on tools. status, metrics report runtime health. list_resources/read_resource and list_prompts/get_prompt expose upstream MCP Resources and Prompts.",
    },
    upstream_filter: {
      type: "string",
      description:
        "Optional. Filter by upstream server id. Used by mode=list, describe, and status.",
    },
    tool_filter: { type: "string", description: "Optional. Substring match on tool name." },
    query: {
      type: "string",
      description:
        "Optional. Case-insensitive keyword search across tool name and description. More powerful than tool_filter.",
    },
    tool_name: {
      type: "string",
      description: "Required when mode=describe or mode=call. Exact tool name.",
    },
    tool_args: {
      type: "object",
      description:
        "Required when mode=call. The arguments to forward to the upstream tool. Must match that tool's inputSchema exactly.",
    },
    upstream_hint: {
      type: "string",
      description:
        "Optional when mode=call. Disambiguates between upstreams that expose the same tool name.",
    },
    fields: {
      type: "array",
      items: {
        type: "string",
        enum: ["name", "description", "inputSchema", "upstream", "hint_call"],
      },
      description:
        "Optional. In mode=list, restrict which fields are returned per tool. Defaults to [name, description, upstream, hint_call] to save tokens.",
    },
    page: {
      type: "integer",
      minimum: 1,
      description: "1-indexed page number for mode=list. Default: 1.",
    },
    page_size: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Results per page for mode=list. Default: 20. Max: 50.",
    },
    calls: {
      type: "array",
      description: "Required when mode=call_batch. Each item is a call descriptor.",
      items: {
        type: "object",
        properties: {
          call_id: {
            type: "string",
            description: "Caller-assigned id for correlating results.",
          },
          tool_name: { type: "string" },
          tool_args: { type: "object" },
          upstream_hint: { type: "string" },
        },
        required: ["call_id", "tool_name", "tool_args"],
      },
    },
    batch_mode: {
      type: "string",
      enum: ["parallel", "sequential"],
      description:
        "parallel (default) dispatches all calls concurrently. sequential runs them in order and short-circuits on first isError.",
    },
    uri: {
      type: "string",
      description: "Required when mode=read_resource. The resource URI to read.",
    },
    prompt_name: {
      type: "string",
      description: "Required when mode=get_prompt. The prompt template name.",
    },
    prompt_args: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Optional. String-valued arguments forwarded to the prompt template.",
    },
  },
  required: ["mode"],
  additionalProperties: false,
} as const;

export const TOOL_TOOL_DEFINITION = {
  name: "tool_tool",
  description:
    "Discover, inspect, invoke, and monitor tools across upstream MCP servers via a single tool surface. Modes: list, describe, call, call_batch, status, metrics. Always filter to minimize token usage.",
  inputSchema: TOOL_TOOL_INPUT_SCHEMA,
} as const;

const DEFAULT_LIST_FIELDS: Array<
  "name" | "description" | "upstream" | "hint_call"
> = ["name", "description", "upstream", "hint_call"];
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const DESCRIPTION_TRUNCATE = 80;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

function projectListEntry(
  t: ToolEntry,
  fields: ReadonlyArray<"name" | "description" | "inputSchema" | "upstream" | "hint_call">,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    switch (f) {
      case "name":
        out.name = t.name;
        break;
      case "description":
        out.description = truncate(t.description ?? "", DESCRIPTION_TRUNCATE);
        break;
      case "inputSchema":
        out.inputSchema = t.inputSchema;
        break;
      case "upstream":
        out.upstream = t.upstreamId;
        break;
      case "hint_call":
        out.hint_call = `tool_tool(mode=describe, tool_name="${t.name}")`;
        break;
    }
  }
  return out;
}

/** Result envelope returned by the handler — matches MCP CallTool output. */
export interface ToolToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function ok(data: unknown): ToolToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  };
}

/** Dependencies required by {@link handleToolTool}. */
export interface ToolToolDeps {
  proxy: UpstreamProxy;
  metrics: Metrics;
  logger: Logger;
  config: MCMCPConfig;
  /** Optional sentinel set during shutdown so further calls are rejected. */
  isShuttingDown?: () => boolean;
}

/**
 * Handles a single `tool_tool` invocation. All modes are dispatched here.
 * Returns an MCP-shaped result; never throws for in-band errors.
 */
export async function handleToolTool(
  deps: ToolToolDeps,
  rawArgs: unknown,
): Promise<ToolToolResult> {
  if (deps.isShuttingDown?.()) {
    return err("MCMCP is shutting down and is no longer accepting tool calls.");
  }
  if (!rawArgs || typeof rawArgs !== "object") {
    return err("tool_tool requires an arguments object with at least 'mode'.");
  }
  const args = rawArgs as Partial<ToolToolArgs>;
  const { proxy, metrics, logger, config } = deps;

  switch (args.mode) {
    case "list":
      return modeList(proxy, args, logger);
    case "describe":
      return modeDescribe(proxy, args, logger);
    case "call":
      return modeCall(proxy, args);
    case "call_batch":
      return modeCallBatch(proxy, metrics, config, args);
    case "status":
      return modeStatus(proxy, args);
    case "metrics":
      return modeMetrics(metrics, logger);
    case "list_resources":
      return modeListResources(proxy, args);
    case "read_resource":
      return modeReadResource(proxy, args);
    case "list_prompts":
      return modeListPrompts(proxy, args);
    case "get_prompt":
      return modeGetPrompt(proxy, args);
    default:
      return err(
        "Invalid 'mode'. Expected one of: list, describe, call, call_batch, status, metrics, list_resources, read_resource, list_prompts, get_prompt.",
      );
  }
}

function modeList(
  proxy: UpstreamProxy,
  args: Partial<ToolToolArgs>,
  logger: Logger,
): ToolToolResult {
  if (args.upstream_filter !== undefined && typeof args.upstream_filter !== "string") {
    return err("'upstream_filter' must be a string.");
  }
  if (args.tool_filter !== undefined && typeof args.tool_filter !== "string") {
    return err("'tool_filter' must be a string.");
  }
  if (args.query !== undefined && typeof args.query !== "string") {
    return err("'query' must be a string.");
  }
  if (args.page !== undefined && (!Number.isInteger(args.page) || args.page < 1)) {
    return err("'page' must be a positive integer.");
  }
  if (
    args.page_size !== undefined &&
    (!Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > MAX_PAGE_SIZE)
  ) {
    return err(`'page_size' must be an integer in [1, ${MAX_PAGE_SIZE}].`);
  }
  const fields = args.fields && args.fields.length > 0 ? args.fields : DEFAULT_LIST_FIELDS;
  const all = proxy.getTools(args.upstream_filter, args.tool_filter, args.query);
  const total = all.length;
  const pageSize = args.page_size ?? DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(args.page ?? 1, totalPages);
  const startIdx = (page - 1) * pageSize;
  const slice = all.slice(startIdx, startIdx + pageSize);
  const projected = slice.map((t) => projectListEntry(t, fields));
  logger.log({ type: "list", mode: "list", duration_ms: 0, ok: true });
  return ok({
    mode: "list",
    page,
    page_size: pageSize,
    total,
    total_pages: totalPages,
    upstreams: proxy.listUpstreamIds(),
    tools: projected,
  });
}

function modeDescribe(
  proxy: UpstreamProxy,
  args: Partial<ToolToolArgs>,
  logger: Logger,
): ToolToolResult {
  if (typeof args.tool_name !== "string" || !args.tool_name) {
    return err("'tool_name' is required when mode=describe.");
  }
  const entry = proxy.getTool(args.tool_name);
  if (!entry) {
    return err(
      `No tool named '${args.tool_name}'. Call tool_tool with mode=list (optionally with tool_filter) to discover available tools.`,
    );
  }
  if (args.upstream_filter && entry.upstreamId !== args.upstream_filter) {
    return err(
      `Tool '${args.tool_name}' exists but belongs to upstream '${entry.upstreamId}', not '${args.upstream_filter}'.`,
    );
  }
  logger.log({
    type: "describe",
    mode: "describe",
    tool_name: entry.name,
    duration_ms: 0,
    ok: true,
  });
  return ok({
    mode: "describe",
    tool: {
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      upstream: entry.upstreamId,
      related: proxy.getRelatedTools(entry.name, 5),
    },
  });
}

async function modeCall(
  proxy: UpstreamProxy,
  args: Partial<ToolToolArgs>,
): Promise<ToolToolResult> {
  if (typeof args.tool_name !== "string" || !args.tool_name) {
    return err("'tool_name' is required when mode=call.");
  }
  if (
    args.tool_args === undefined ||
    args.tool_args === null ||
    typeof args.tool_args !== "object" ||
    Array.isArray(args.tool_args)
  ) {
    return err(
      "'tool_args' is required when mode=call and must be an object matching the upstream tool's inputSchema.",
    );
  }
  if (args.upstream_hint !== undefined && typeof args.upstream_hint !== "string") {
    return err("'upstream_hint' must be a string when provided.");
  }
  const result = await proxy.callTool(args.tool_name, args.tool_args, args.upstream_hint);
  return result as ToolToolResult;
}

interface BatchOutcome {
  call_id: string;
  tool_name: string;
  upstream: string | null;
  ok: boolean;
  result?: CallToolResult;
  error?: string;
  skipped?: boolean;
}

async function modeCallBatch(
  proxy: UpstreamProxy,
  metrics: Metrics,
  config: MCMCPConfig,
  args: Partial<ToolToolArgs>,
): Promise<ToolToolResult> {
  const calls = args.calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    return err("'calls' is required when mode=call_batch and must be a non-empty array.");
  }
  const max = config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  if (calls.length > max) {
    return err(`call_batch exceeds maxBatchSize=${max}. Got ${calls.length} items.`);
  }
  const seen = new Set<string>();
  for (const c of calls) {
    if (!c || typeof c !== "object") return err("Each batch item must be an object.");
    if (typeof c.call_id !== "string" || !c.call_id) {
      return err("Each batch item requires a 'call_id' string.");
    }
    if (seen.has(c.call_id)) {
      return err(`Duplicate call_id '${c.call_id}' in batch.`);
    }
    seen.add(c.call_id);
    if (typeof c.tool_name !== "string" || !c.tool_name) {
      return err(`Batch item '${c.call_id}' requires a 'tool_name' string.`);
    }
    if (
      c.tool_args === undefined ||
      typeof c.tool_args !== "object" ||
      c.tool_args === null ||
      Array.isArray(c.tool_args)
    ) {
      return err(`Batch item '${c.call_id}' requires a 'tool_args' object.`);
    }
  }
  const batchMode = args.batch_mode ?? "parallel";
  metrics.recordBatch(calls.length);

  const dispatch = async (
    c: NonNullable<ToolToolArgs["calls"]>[number],
  ): Promise<BatchOutcome> => {
    const resolved = proxy.resolveTool(c.tool_name, c.upstream_hint);
    const upstream = "entry" in resolved ? resolved.entry.upstreamId : null;
    const result = await proxy.callTool(c.tool_name, c.tool_args, c.upstream_hint);
    const isErr = Boolean(result.isError);
    return {
      call_id: c.call_id,
      tool_name: c.tool_name,
      upstream,
      ok: !isErr,
      ...(isErr
        ? { error: extractText(result) }
        : { result }),
    };
  };

  const outcomes: BatchOutcome[] = [];
  if (batchMode === "parallel") {
    // Cap concurrency to avoid saturating the rate-limiter with all requests
    // at once (e.g. maxBatchSize=50 → 50 simultaneous calls).
    const PARALLEL_CONCURRENCY = 5;
    let active = 0;
    let nextIndex = 0;
    const settled = new Array<PromiseSettledResult<BatchOutcome>>(calls.length);

    await new Promise<void>((resolve, reject) => {
      const trySchedule = (): void => {
        while (active < PARALLEL_CONCURRENCY && nextIndex < calls.length) {
          const idx = nextIndex++;
          active++;
          dispatch(calls[idx]!)
            .then(
              (v) => { settled[idx] = { status: "fulfilled", value: v }; },
              (e) => { settled[idx] = { status: "rejected", reason: e }; },
            )
            .finally(() => {
              active--;
              trySchedule();
              if (active === 0 && nextIndex >= calls.length) resolve();
            });
        }
      };
      trySchedule();
    });

    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]!;
      const c = calls[i]!;
      if (s.status === "fulfilled") {
        outcomes.push(s.value);
      } else {
        outcomes.push({
          call_id: c.call_id,
          tool_name: c.tool_name,
          upstream: null,
          ok: false,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        });
      }
    }
  } else {
    let stopped = false;
    for (const c of calls) {
      if (stopped) {
        outcomes.push({
          call_id: c.call_id,
          tool_name: c.tool_name,
          upstream: null,
          ok: false,
          error: "Skipped: previous sequential batch item failed.",
          skipped: true,
        });
        continue;
      }
      const o = await dispatch(c);
      outcomes.push(o);
      if (!o.ok) stopped = true;
    }
  }

  const allFailed = outcomes.every((o) => !o.ok);
  return {
    isError: allFailed,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { batch_mode: batchMode, results: outcomes },
          null,
          2,
        ),
      },
    ],
  };
}

async function modeStatus(
  proxy: UpstreamProxy,
  args: Partial<ToolToolArgs>,
): Promise<ToolToolResult> {
  if (args.upstream_filter !== undefined && typeof args.upstream_filter !== "string") {
    return err("'upstream_filter' must be a string.");
  }
  const statuses = await proxy.status(args.upstream_filter);
  return ok(statuses);
}

function modeMetrics(metrics: Metrics, logger: Logger): ToolToolResult {
  logger.log({ type: "metrics", mode: "metrics", duration_ms: 0, ok: true });
  return ok(metrics.snapshot());
}

function extractText(r: CallToolResult): string {
  for (const c of r.content ?? []) {
    if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
      return (c as { text: string }).text;
    }
  }
  return "(no text)";
}

function modeListResources(
  proxy: UpstreamProxy,
  args: Partial<ToolToolArgs>,
): ToolToolResult {
  if (args.upstream_filter !== undefined && typeof args.upstream_filter !== "string") {
    return err("'upstream_filter' must be a string.");
  }
  const items = proxy.listResources(args.upstream_filter);
  return ok({ mode: "list_resources", count: items.length, resources: items });
}

async function modeReadResource(
  proxy: UpstreamProxy,
  args: Partial<ToolToolArgs>,
): Promise<ToolToolResult> {
  if (typeof args.uri !== "string" || !args.uri) {
    return err("'uri' is required when mode=read_resource.");
  }
  const out = await proxy.readResource(args.uri, args.upstream_hint);
  return out.ok ? ok({ mode: "read_resource", contents: out.contents }) : err(out.error);
}

function modeListPrompts(
  proxy: UpstreamProxy,
  args: Partial<ToolToolArgs>,
): ToolToolResult {
  if (args.upstream_filter !== undefined && typeof args.upstream_filter !== "string") {
    return err("'upstream_filter' must be a string.");
  }
  const items = proxy.listPrompts(args.upstream_filter);
  return ok({ mode: "list_prompts", count: items.length, prompts: items });
}

async function modeGetPrompt(
  proxy: UpstreamProxy,
  args: Partial<ToolToolArgs>,
): Promise<ToolToolResult> {
  if (typeof args.prompt_name !== "string" || !args.prompt_name) {
    return err("'prompt_name' is required when mode=get_prompt.");
  }
  const out = await proxy.getPrompt(
    args.prompt_name,
    args.prompt_args,
    args.upstream_hint,
  );
  return out.ok ? ok({ mode: "get_prompt", result: out.result }) : err(out.error);
}
