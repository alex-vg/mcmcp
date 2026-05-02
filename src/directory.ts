/**
 * Pure rendering of the live tool directory that is injected into the
 * `tool_tool` description on every `tools/list` request.
 *
 * This module performs **no I/O** and holds **no references** to the
 * proxy. It accepts plain data and returns a plain snapshot, which is
 * what makes it trivially unit-testable without mocking.
 */

/** Subset of {@link import("./proxy.js").ToolEntry} that the renderer needs. */
export interface DirectoryToolEntry {
  name: string;
  upstreamId: string;
}

/** Subset of upstream info used by the renderer (also covers connection state). */
export interface DirectoryUpstreamEntry {
  id: string;
  /** Whether this upstream is currently reachable. */
  connected: boolean;
}

/** Configurable thresholds that decide which tier the snapshot uses. */
export interface DirectoryThresholds {
  tierOneMaxTools: number;
  tierTwoMaxServers: number;
}

/** Output of {@link buildDirectorySnapshot}. */
export interface DirectorySnapshot {
  /** ISO timestamp the snapshot was generated. */
  generatedAt: string;
  /** ISO timestamp of the last upstream sync (init / reload / ping). */
  lastSyncAt: string;
  totalTools: number;
  totalServers: number;
  tier: "full" | "servers" | "paginated";
  /** Rendered string injected into the tool_tool description. */
  content: string;
  /** True when the listing was truncated (tier 3). */
  truncated: boolean;
  /** Optional guidance string appended when truncated. */
  hint?: string;
}

const MAX_LINE_WIDTH = 80;

interface RenderInput {
  tools: ReadonlyArray<DirectoryToolEntry>;
  upstreams: ReadonlyArray<DirectoryUpstreamEntry>;
  thresholds: DirectoryThresholds;
  generatedAt: string;
  lastSyncAt: string;
}

/**
 * Build a {@link DirectorySnapshot} from the live tool list and upstream
 * connection states. Pure and O(n) in tool count.
 *
 * Tier selection:
 *   - `full` when totalTools <= tierOneMaxTools
 *   - `servers` when totalTools > tierOneMaxTools and totalServers <= tierTwoMaxServers
 *   - `paginated` otherwise
 */
export function buildDirectorySnapshot(
  tools: ReadonlyArray<DirectoryToolEntry>,
  upstreams: ReadonlyArray<DirectoryUpstreamEntry>,
  thresholds: DirectoryThresholds,
  options?: { generatedAt?: string; lastSyncAt?: string },
): DirectorySnapshot {
  const generatedAt = options?.generatedAt ?? new Date().toISOString();
  const lastSyncAt = options?.lastSyncAt ?? generatedAt;
  const totalTools = tools.length;
  const totalServers = upstreams.length;

  const input: RenderInput = {
    tools,
    upstreams,
    thresholds,
    generatedAt,
    lastSyncAt,
  };

  let tier: DirectorySnapshot["tier"];
  let content: string;
  let truncated = false;
  let hint: string | undefined;

  if (totalTools <= thresholds.tierOneMaxTools) {
    tier = "full";
    content = renderTierFull(input);
  } else if (totalServers <= thresholds.tierTwoMaxServers) {
    tier = "servers";
    content = renderTierServers(input);
  } else {
    tier = "paginated";
    truncated = true;
    hint =
      "Use mode=status to see all servers. Use mode=list with upstream_filter or tool_filter to search.";
    content = renderTierPaginated(input);
  }

  const warning = renderDisconnectedWarning(upstreams);
  if (warning) content = `${content}\n${warning}`;

  return {
    generatedAt,
    lastSyncAt,
    totalTools,
    totalServers,
    tier,
    content,
    truncated,
    ...(hint !== undefined ? { hint } : {}),
  };
}

/** Group tools by upstream id, preserving insertion order of the upstream list. */
function groupByUpstream(
  tools: ReadonlyArray<DirectoryToolEntry>,
  upstreams: ReadonlyArray<DirectoryUpstreamEntry>,
): Array<{ id: string; toolNames: string[] }> {
  const buckets = new Map<string, string[]>();
  for (const u of upstreams) buckets.set(u.id, []);
  for (const t of tools) {
    let arr = buckets.get(t.upstreamId);
    if (!arr) {
      arr = [];
      buckets.set(t.upstreamId, arr);
    }
    arr.push(t.name);
  }
  return [...buckets.entries()].map(([id, toolNames]) => ({ id, toolNames }));
}

function renderTierFull(input: RenderInput): string {
  const { tools, upstreams, generatedAt, lastSyncAt } = input;
  const totalTools = tools.length;
  const groups = groupByUpstream(tools, upstreams);
  const labelWidth = groups.reduce((m, g) => Math.max(m, g.id.length), 0);
  const lines: string[] = [];
  lines.push(
    `AVAILABLE TOOLS (${totalTools} total across ${upstreams.length} server${
      upstreams.length === 1 ? "" : "s"
    }):`,
  );
  lines.push("");
  for (const g of groups) {
    if (g.toolNames.length === 0) {
      lines.push(`[${g.id.padEnd(labelWidth)}]  (no tools)`);
      continue;
    }
    const prefix = `[${g.id.padEnd(labelWidth)}]  `;
    const wrapped = wrapNames(g.toolNames, prefix.length, MAX_LINE_WIDTH);
    lines.push(prefix + wrapped[0]);
    for (let i = 1; i < wrapped.length; i++) {
      lines.push(" ".repeat(prefix.length) + wrapped[i]);
    }
  }
  lines.push("");
  lines.push("All tools available. Use mode=describe for full schema of any tool.");
  lines.push("Use mode=call to execute.");
  lines.push(`Last updated: ${lastSyncAt} (snapshot ${generatedAt})`);
  return lines.join("\n");
}

/**
 * Wrap a comma-separated list of names so that each rendered line stays
 * within `maxWidth` (the prefix length is reserved by the caller). Names
 * are never split mid-word.
 */
function wrapNames(names: string[], prefixLen: number, maxWidth: number): string[] {
  const budget = Math.max(20, maxWidth - prefixLen);
  const lines: string[] = [];
  let current = "";
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const piece = i === names.length - 1 ? name : `${name}, `;
    if (current.length === 0) {
      current = piece;
    } else if (current.length + piece.length <= budget) {
      current += piece;
    } else {
      lines.push(current.trimEnd());
      current = piece;
    }
  }
  if (current.length > 0) lines.push(current.trimEnd());
  return lines;
}

function renderTierServers(input: RenderInput): string {
  const { tools, upstreams, generatedAt, lastSyncAt } = input;
  const counts = countByUpstream(tools, upstreams);
  counts.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const idWidth = counts.reduce((m, c) => Math.max(m, c.id.length), 0);
  const numWidth = counts.reduce((m, c) => Math.max(m, String(c.count).length), 0);
  const lines: string[] = [];
  lines.push(
    `AVAILABLE SERVERS (${upstreams.length} servers, ${tools.length} tools total):`,
  );
  lines.push("");
  for (const c of counts) {
    lines.push(
      `  ${c.id.padEnd(idWidth)}  -  ${String(c.count).padStart(numWidth)} tools`,
    );
  }
  lines.push("");
  lines.push("Use mode=list with upstream_filter to explore tools on a server.");
  lines.push("Use mode=list with tool_filter for substring search across all servers.");
  lines.push(`Last updated: ${lastSyncAt} (snapshot ${generatedAt})`);
  return lines.join("\n");
}

function renderTierPaginated(input: RenderInput): string {
  const { tools, upstreams, thresholds, generatedAt, lastSyncAt } = input;
  const counts = countByUpstream(tools, upstreams);
  counts.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const shown = counts.slice(0, thresholds.tierTwoMaxServers);
  const hidden = counts.length - shown.length;
  const idWidth = shown.reduce((m, c) => Math.max(m, c.id.length), 0);
  const numWidth = shown.reduce((m, c) => Math.max(m, String(c.count).length), 0);
  const lines: string[] = [];
  lines.push(
    `AVAILABLE SERVERS (${upstreams.length} servers, ${tools.length} tools - showing first ${shown.length}):`,
  );
  lines.push("");
  for (const c of shown) {
    lines.push(
      `  ${c.id.padEnd(idWidth)}  -  ${String(c.count).padStart(numWidth)} tools`,
    );
  }
  lines.push(`  ... (${hidden} more server${hidden === 1 ? "" : "s"})`);
  lines.push("");
  lines.push("Use mode=status to see all servers.");
  lines.push("Use mode=list with upstream_filter or tool_filter to search.");
  lines.push(`Last updated: ${lastSyncAt} (snapshot ${generatedAt})`);
  return lines.join("\n");
}

function countByUpstream(
  tools: ReadonlyArray<DirectoryToolEntry>,
  upstreams: ReadonlyArray<DirectoryUpstreamEntry>,
): Array<{ id: string; count: number }> {
  const counts = new Map<string, number>();
  for (const u of upstreams) counts.set(u.id, 0);
  for (const t of tools) counts.set(t.upstreamId, (counts.get(t.upstreamId) ?? 0) + 1);
  return [...counts.entries()].map(([id, count]) => ({ id, count }));
}

function renderDisconnectedWarning(
  upstreams: ReadonlyArray<DirectoryUpstreamEntry>,
): string | null {
  const down = upstreams.filter((u) => !u.connected).length;
  if (down === 0) return null;
  return `WARNING: ${down} server(s) unreachable - directory may be incomplete.`;
}

/** Static description used when `directory.enabled === false`. */
export const STATIC_TOOL_TOOL_DESCRIPTION =
  "Discover, inspect, invoke, and monitor tools across upstream MCP servers via a single tool surface. " +
  "Modes: list, describe, call, call_batch, status, metrics. Always filter to minimize token usage.";

/** Static preamble — same on every dynamic description. */
export const TOOL_TOOL_PREAMBLE =
  "Discover and inspect tools from upstream MCP servers.\n" +
  "Modes: list, describe, call, call_batch, status, metrics.";

/** Static postamble — same on every dynamic description. */
export const TOOL_TOOL_POSTAMBLE =
  "Always use mode=describe before mode=call if you have not seen a tool's inputSchema in this session.";

/** Compose the full dynamic tool_tool description. */
export function composeToolToolDescription(snapshot: DirectorySnapshot): string {
  return `${TOOL_TOOL_PREAMBLE}\n\n${snapshot.content}\n\n${TOOL_TOOL_POSTAMBLE}`;
}
