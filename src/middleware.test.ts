import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { runAfter, runBefore, type Middleware, type MiddlewareCtx } from "./middleware.js";
import type { ToolEntry, CallToolResult } from "./proxy.js";

const tool: ToolEntry = {
  name: "t",
  originalName: "t",
  description: "",
  inputSchema: { type: "object" },
  upstreamId: "u1",
};
const ctx: MiddlewareCtx = { upstreamId: "u1", toolName: "t", originalName: "t", state: {} };

describe("middleware.runBefore", () => {
  it("rewrites args via chained middleware", async () => {
    const m1: Middleware = {
      name: "m1",
      before: async (a) => ({ args: { ...(a as object), x: 1 } }),
    };
    const m2: Middleware = {
      name: "m2",
      before: async (a) => ({ args: { ...(a as object), y: 2 } }),
    };
    const out = await runBefore([m1, m2], { z: 3 }, ctx, tool);
    assert.deepEqual(out.args, { z: 3, x: 1, y: 2 });
    assert.equal(out.shortCircuit, undefined);
  });

  it("short-circuits on first middleware return", async () => {
    const stop: CallToolResult = { content: [{ type: "text", text: "denied" }], isError: true };
    const m1: Middleware = { name: "m1", before: async () => ({ shortCircuit: stop }) };
    const m2: Middleware = { name: "m2", before: async () => { throw new Error("should not run"); } };
    const out = await runBefore([m1, m2], {}, ctx, tool);
    assert.equal(out.shortCircuit, stop);
  });
});

describe("middleware.runAfter", () => {
  it("rewrites result through the chain", async () => {
    const m1: Middleware = {
      name: "tag1",
      after: async (r) => ({ ...r, content: [{ type: "text", text: "[tag1] " + (r.content[0] as { text: string }).text }] }),
    };
    const m2: Middleware = {
      name: "tag2",
      after: async (r) => ({ ...r, content: [{ type: "text", text: "[tag2] " + (r.content[0] as { text: string }).text }] }),
    };
    const out = await runAfter([m1, m2], { content: [{ type: "text", text: "x" }] }, ctx, tool);
    assert.equal((out.content[0] as { text: string }).text, "[tag2] [tag1] x");
  });
});
