/**
 * Middleware pipeline. Runs around every {@link UpstreamProxy.callTool}
 * invocation. Hooks may inspect or rewrite arguments (`before`) and
 * inspect or rewrite results (`after`). They may also short-circuit by
 * returning a {@link CallToolResult} directly from `before`.
 *
 * Hooks are kept lean and synchronous-or-async; they should not perform
 * unbounded I/O. PII scrubbing, audit logging, cost accounting, and
 * argument validation are the canonical use cases.
 */
import type { CallToolResult, ToolEntry } from "./proxy.js";

/** Context passed to every middleware hook. */
export interface MiddlewareCtx {
  upstreamId: string;
  toolName: string;
  /** Original (unaliased) name on the upstream. */
  originalName: string;
  /** Mutable correlation bag — middleware may store state for the after-hook here. */
  state: Record<string, unknown>;
}

/** A single middleware. Either or both hooks may be present. */
export interface Middleware {
  name: string;
  /**
   * Runs before dispatch. May return a {@link CallToolResult} to short-circuit
   * (skip the upstream call entirely) or new args to forward.
   */
  before?(
    args: unknown,
    ctx: MiddlewareCtx,
    tool: ToolEntry,
  ): Promise<{ args?: unknown; shortCircuit?: CallToolResult } | void>;
  /** Runs after dispatch. May return a replacement result. */
  after?(
    result: CallToolResult,
    ctx: MiddlewareCtx,
    tool: ToolEntry,
  ): Promise<CallToolResult | void>;
}

/**
 * Run the `before` chain. Stops at the first short-circuit. Returns the
 * (possibly rewritten) args or a short-circuit result.
 */
export async function runBefore(
  middlewares: ReadonlyArray<Middleware>,
  args: unknown,
  ctx: MiddlewareCtx,
  tool: ToolEntry,
): Promise<{ args: unknown; shortCircuit?: CallToolResult }> {
  let current = args;
  for (const m of middlewares) {
    if (!m.before) continue;
    const out = await m.before(current, ctx, tool);
    if (!out) continue;
    if (out.shortCircuit) return { args: current, shortCircuit: out.shortCircuit };
    if (out.args !== undefined) current = out.args;
  }
  return { args: current };
}

/** Run the `after` chain in registration order. */
export async function runAfter(
  middlewares: ReadonlyArray<Middleware>,
  result: CallToolResult,
  ctx: MiddlewareCtx,
  tool: ToolEntry,
): Promise<CallToolResult> {
  let current = result;
  for (const m of middlewares) {
    if (!m.after) continue;
    const replaced = await m.after(current, ctx, tool);
    if (replaced) current = replaced;
  }
  return current;
}
