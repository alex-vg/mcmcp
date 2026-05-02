/**
 * Unit tests for src/tool-tool.ts — handleToolTool and all mode helpers.
 *
 * Dependencies are stubbed with minimal duck-typed objects so the tests stay
 * fast and focused on logic rather than infrastructure.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type MCMCPConfig } from "./config.js";
import { Metrics } from "./metrics.js";
import type { UpstreamStatus } from "./proxy.js";
import { handleToolTool, type ToolToolDeps, type ToolToolResult } from "./tool-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the first text chunk of a ToolToolResult back to an object. */
function parse(r: ToolToolResult): unknown {
  return JSON.parse(r.content[0]!.text);
}

/** Assert result is an error with a message matching `needle`. */
function assertError(r: ToolToolResult, needle: string): void {
  assert.ok(r.isError, "Expected isError=true");
  const obj = parse(r) as { error: string };
  assert.ok(
    obj.error.toLowerCase().includes(needle.toLowerCase()),
    `Expected error to include "${needle}", got: ${obj.error}`,
  );
}

/** Build a minimal ToolEntry. */
function makeEntry(
  name: string,
  upstreamId = "up1",
  description = `desc for ${name}`,
) {
  return {
    name,
    originalName: name,
    description,
    inputSchema: { type: "object" as const, properties: {} },
    upstreamId,
    schemaFingerprint: "abc",
  };
}

type FakeProxy = ToolToolDeps["proxy"];

/** Stub proxy that returns the provided tools list. */
function makeProxy(tools = [makeEntry("echo")], overrides: Partial<FakeProxy> = {}): FakeProxy {
  const map = new Map(tools.map((t) => [t.name, t]));
  return {
    getTools: (upstreamFilter?: string, toolFilter?: string, query?: string) => {
      let list = [...map.values()];
      if (upstreamFilter) list = list.filter((t) => t.upstreamId === upstreamFilter);
      if (toolFilter) list = list.filter((t) => t.name.includes(toolFilter));
      if (query) {
        const q = query.toLowerCase();
        list = list.filter(
          (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
        );
      }
      return list;
    },
    getTool: (name: string) => map.get(name),
    listUpstreamIds: () => ["up1"],
    resolveTool: (name: string) => {
      const e = map.get(name);
      return e ? { entry: e } : { error: `No tool named '${name}'` };
    },
    callTool: async (_name: string, _args: unknown) => ({
      content: [{ type: "text" as const, text: "ok" }],
    }),
    status: async () => [] as UpstreamStatus[],
    getLastSyncAt: () => new Date(0),
    listResources: () => [],
    readResource: async () => ({
      contents: [{ type: "text" as const, uri: "res://x", text: "blob" }],
    }),
    listPrompts: () => [],
    getPrompt: async () => ({ description: undefined, messages: [] }),
    getRelatedTools: (_name: string, _n: number) => [],
    ...overrides,
  } as unknown as FakeProxy;
}

function makeLogger(): ToolToolDeps["logger"] {
  return { log: () => undefined } as unknown as ToolToolDeps["logger"];
}

function makeConfig(overrides: Partial<MCMCPConfig> = {}): MCMCPConfig {
  return {
    upstreams: [],
    ...overrides,
  } as MCMCPConfig;
}

function makeDeps(overrides: Partial<ToolToolDeps> = {}): ToolToolDeps {
  return {
    proxy: makeProxy(),
    metrics: new Metrics(),
    logger: makeLogger(),
    config: makeConfig(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleToolTool — top-level guards
// ---------------------------------------------------------------------------

describe("handleToolTool — top-level guards", () => {
  it("returns error when shutting down", async () => {
    const deps = makeDeps({ isShuttingDown: () => true });
    const r = await handleToolTool(deps, { mode: "list" });
    assertError(r, "shutting down");
  });

  it("returns error when rawArgs is not an object", async () => {
    const r = await handleToolTool(makeDeps(), "nope");
    assertError(r, "arguments object");
  });

  it("returns error for unknown mode", async () => {
    const r = await handleToolTool(makeDeps(), { mode: "bogus" });
    assertError(r, "Invalid 'mode'");
  });
});

// ---------------------------------------------------------------------------
// mode=list
// ---------------------------------------------------------------------------

describe("mode=list", () => {
  it("returns all tools with default fields", async () => {
    const tools = [makeEntry("echo"), makeEntry("add")];
    const r = await handleToolTool(makeDeps({ proxy: makeProxy(tools) }), { mode: "list" });
    assert.ok(!r.isError);
    const data = parse(r) as { tools: unknown[]; total: number };
    assert.equal(data.total, 2);
    assert.equal((data.tools as unknown[]).length, 2);
  });

  it("respects upstream_filter", async () => {
    const tools = [makeEntry("a", "up1"), makeEntry("b", "up2")];
    const r = await handleToolTool(makeDeps({ proxy: makeProxy(tools) }), {
      mode: "list",
      upstream_filter: "up2",
    });
    const data = parse(r) as { total: number; tools: Array<{ name: string }> };
    assert.equal(data.total, 1);
    assert.equal(data.tools[0]!.name, "b");
  });

  it("respects tool_filter substring", async () => {
    const tools = [makeEntry("echo_foo"), makeEntry("add_bar")];
    const r = await handleToolTool(makeDeps({ proxy: makeProxy(tools) }), {
      mode: "list",
      tool_filter: "echo",
    });
    const data = parse(r) as { total: number };
    assert.equal(data.total, 1);
  });

  it("respects query search in description", async () => {
    const tools = [
      makeEntry("tool_a", "up1", "calculate sums"),
      makeEntry("tool_b", "up1", "convert formats"),
    ];
    const r = await handleToolTool(makeDeps({ proxy: makeProxy(tools) }), {
      mode: "list",
      query: "sums",
    });
    const data = parse(r) as { total: number; tools: Array<{ name: string }> };
    assert.equal(data.total, 1);
    assert.equal(data.tools[0]!.name, "tool_a");
  });

  it("paginates correctly", async () => {
    const tools = Array.from({ length: 5 }, (_, i) => makeEntry(`t${i}`));
    const r = await handleToolTool(makeDeps({ proxy: makeProxy(tools) }), {
      mode: "list",
      page: 2,
      page_size: 2,
    });
    const data = parse(r) as { page: number; total: number; total_pages: number; tools: unknown[] };
    assert.equal(data.total, 5);
    assert.equal(data.total_pages, 3);
    assert.equal(data.page, 2);
    assert.equal(data.tools.length, 2);
  });

  it("clamps page to total_pages when page exceeds bounds", async () => {
    const tools = [makeEntry("echo")];
    const r = await handleToolTool(makeDeps({ proxy: makeProxy(tools) }), {
      mode: "list",
      page: 999,
      page_size: 10,
    });
    const data = parse(r) as { page: number };
    assert.equal(data.page, 1);
  });

  it("projects requested fields only", async () => {
    const r = await handleToolTool(makeDeps(), {
      mode: "list",
      fields: ["name"],
    });
    const data = parse(r) as { tools: Array<Record<string, unknown>> };
    const entry = data.tools[0]!;
    assert.ok("name" in entry);
    assert.ok(!("description" in entry));
    assert.ok(!("upstream" in entry));
  });

  it("returns error for invalid page_size", async () => {
    const r = await handleToolTool(makeDeps(), { mode: "list", page_size: 0 });
    assertError(r, "page_size");
  });

  it("returns error for non-integer page", async () => {
    const r = await handleToolTool(makeDeps(), { mode: "list", page: 0 });
    assertError(r, "page");
  });
});

// ---------------------------------------------------------------------------
// mode=describe
// ---------------------------------------------------------------------------

describe("mode=describe", () => {
  it("returns full entry for known tool", async () => {
    const r = await handleToolTool(makeDeps(), { mode: "describe", tool_name: "echo" });
    assert.ok(!r.isError);
    const data = parse(r) as { tool: { name: string } };
    assert.equal(data.tool.name, "echo");
  });

  it("returns error for missing tool_name", async () => {
    const r = await handleToolTool(makeDeps(), { mode: "describe" });
    assertError(r, "tool_name");
  });

  it("returns error for unknown tool", async () => {
    const r = await handleToolTool(makeDeps(), { mode: "describe", tool_name: "no_such" });
    assertError(r, "No tool named");
  });

  it("returns error when upstream_filter mismatches tool's upstream", async () => {
    const r = await handleToolTool(makeDeps(), {
      mode: "describe",
      tool_name: "echo",
      upstream_filter: "other_upstream",
    });
    assertError(r, "belongs to upstream");
  });
});

// ---------------------------------------------------------------------------
// mode=call
// ---------------------------------------------------------------------------

describe("mode=call", () => {
  it("forwards call to proxy and returns result", async () => {
    const r = await handleToolTool(makeDeps(), {
      mode: "call",
      tool_name: "echo",
      tool_args: { msg: "hello" },
    });
    assert.ok(!r.isError);
  });

  it("returns error when tool_name is missing", async () => {
    const r = await handleToolTool(makeDeps(), { mode: "call", tool_args: {} });
    assertError(r, "tool_name");
  });

  it("returns error when tool_args is missing", async () => {
    const r = await handleToolTool(makeDeps(), { mode: "call", tool_name: "echo" });
    assertError(r, "tool_args");
  });

  it("returns error when tool_args is an array", async () => {
    const r = await handleToolTool(makeDeps(), {
      mode: "call",
      tool_name: "echo",
      tool_args: [] as unknown as Record<string, unknown>,
    });
    assertError(r, "tool_args");
  });

  it("returns error when upstream_hint is not a string", async () => {
    const r = await handleToolTool(makeDeps(), {
      mode: "call",
      tool_name: "echo",
      tool_args: {},
      upstream_hint: 42 as unknown as string,
    });
    assertError(r, "upstream_hint");
  });
});

// ---------------------------------------------------------------------------
// mode=call_batch
// ---------------------------------------------------------------------------

describe("mode=call_batch — validation", () => {
  it("returns error when calls is missing", async () => {
    const r = await handleToolTool(makeDeps(), { mode: "call_batch" });
    assertError(r, "'calls' is required");
  });

  it("returns error when calls is empty", async () => {
    const r = await handleToolTool(makeDeps(), { mode: "call_batch", calls: [] });
    assertError(r, "non-empty");
  });

  it("returns error for duplicate call_id", async () => {
    const r = await handleToolTool(makeDeps(), {
      mode: "call_batch",
      calls: [
        { call_id: "x", tool_name: "echo", tool_args: {} },
        { call_id: "x", tool_name: "echo", tool_args: {} },
      ],
    });
    assertError(r, "Duplicate call_id");
  });

  it("returns error when tool_name is missing in a batch item", async () => {
    const r = await handleToolTool(makeDeps(), {
      mode: "call_batch",
      calls: [{ call_id: "a", tool_name: "", tool_args: {} }],
    });
    assertError(r, "tool_name");
  });

  it("returns error when tool_args is missing in a batch item", async () => {
    const r = await handleToolTool(makeDeps(), {
      mode: "call_batch",
      calls: [{ call_id: "a", tool_name: "echo", tool_args: null as unknown as Record<string, unknown> }],
    });
    assertError(r, "tool_args");
  });

  it("returns error when batch exceeds maxBatchSize", async () => {
    const calls = Array.from({ length: 6 }, (_, i) => ({
      call_id: `c${i}`,
      tool_name: "echo",
      tool_args: {},
    }));
    const r = await handleToolTool(
      makeDeps({ config: makeConfig({ maxBatchSize: 5 } as Partial<MCMCPConfig>) }),
      { mode: "call_batch", calls },
    );
    assertError(r, "maxBatchSize");
  });
});

describe("mode=call_batch — parallel execution", () => {
  it("returns an outcome per call", async () => {
    const r = await handleToolTool(makeDeps(), {
      mode: "call_batch",
      batch_mode: "parallel",
      calls: [
        { call_id: "a", tool_name: "echo", tool_args: {} },
        { call_id: "b", tool_name: "echo", tool_args: {} },
      ],
    });
    assert.ok(!r.isError);
    const data = parse(r) as { results: Array<{ call_id: string; ok: boolean }> };
    assert.equal(data.results.length, 2);
    assert.ok(data.results.every((o) => o.ok));
  });

  it("sets isError=true when all parallel calls fail", async () => {
    const proxy = makeProxy([], {
      resolveTool: () => ({ error: "not found" }),
      callTool: async () => ({
        isError: true,
        content: [{ type: "text" as const, text: "fail" }],
      }),
    });
    const r = await handleToolTool(makeDeps({ proxy }), {
      mode: "call_batch",
      batch_mode: "parallel",
      calls: [{ call_id: "x", tool_name: "nope", tool_args: {} }],
    });
    assert.ok(r.isError);
  });
});

describe("mode=call_batch — sequential execution", () => {
  it("stops on first failure and marks subsequent as skipped", async () => {
    let callCount = 0;
    const proxy = makeProxy([makeEntry("echo"), makeEntry("fail_tool")], {
      resolveTool: (name: string) => ({ entry: makeEntry(name) }),
      callTool: async (name: string) => {
        callCount++;
        if (name === "fail_tool") {
          return { isError: true, content: [{ type: "text" as const, text: "fail" }] };
        }
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    });
    const r = await handleToolTool(makeDeps({ proxy }), {
      mode: "call_batch",
      batch_mode: "sequential",
      calls: [
        { call_id: "a", tool_name: "fail_tool", tool_args: {} },
        { call_id: "b", tool_name: "echo", tool_args: {} },
      ],
    });
    // First call failed, second skipped → allFailed=true → isError=true
    assert.ok(r.isError);
    const data = parse(r) as { results: Array<{ ok: boolean; skipped?: boolean }> };
    assert.equal(data.results[0]!.ok, false);
    assert.equal(data.results[1]!.skipped, true);
    // callTool should only have been invoked once (the failing one; second is skipped)
    assert.equal(callCount, 1);
  });

  it("continues through all calls when none fail", async () => {
    const r = await handleToolTool(makeDeps(), {
      mode: "call_batch",
      batch_mode: "sequential",
      calls: [
        { call_id: "a", tool_name: "echo", tool_args: {} },
        { call_id: "b", tool_name: "echo", tool_args: {} },
      ],
    });
    assert.ok(!r.isError);
    const data = parse(r) as { results: Array<{ ok: boolean }> };
    assert.ok(data.results.every((o) => o.ok));
  });
});

// ---------------------------------------------------------------------------
// mode=status
// ---------------------------------------------------------------------------

describe("mode=status", () => {
  it("returns status array from proxy", async () => {
    const upstream: UpstreamStatus = {
      id: "up1",
      label: null,
      transport: "stdio",
      connected: true,
      tool_count: 1,
      last_ping_ms: 5,
      last_ping_at: new Date().toISOString(),
      error: null,
      cache: { enabled: false, entries: 0, hit_rate_pct: 0 },
      circuit_open_until: null,
      consecutive_failures: 0,
    };
    const proxy = makeProxy([], { status: async () => [upstream] });
    const r = await handleToolTool(makeDeps({ proxy }), { mode: "status" });
    assert.ok(!r.isError);
    const data = parse(r) as Array<{ id: string }>;
    assert.equal(data[0]!.id, "up1");
  });
});

// ---------------------------------------------------------------------------
// mode=metrics
// ---------------------------------------------------------------------------

describe("mode=metrics", () => {
  it("returns a metrics snapshot without error", async () => {
    const r = await handleToolTool(makeDeps(), { mode: "metrics" });
    assert.ok(!r.isError);
    const data = parse(r) as { uptime_seconds: number };
    assert.ok(typeof data.uptime_seconds === "number");
  });
});
