#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CreateMessageRequest,
  type CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { atomicWriteFile } from "./atomic-write.js";
import {
  ConfigValidationError,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  loadConfig,
  type MCMCPConfig,
} from "./config.js";
import { createLogger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { UpstreamProxy } from "./proxy.js";
import { handleToolTool, TOOL_TOOL_INPUT_SCHEMA } from "./tool-tool.js";
import { composeToolToolDescription, STATIC_TOOL_TOOL_DESCRIPTION } from "./directory.js";
import { INTERNAL_TOOL_DEFS, filterInternalToolsForPolicy } from "./internal-tools.js";
import { initTracing, shutdownTracing } from "./otel.js";
import { MCMCP_VERSION } from "./version.js";

async function main(): Promise<void> {
  const rawConfig = process.env.MCMCP_CONFIG ?? process.argv[2] ?? "mcmcp.config.json";
  const isInlineJson = rawConfig.trimStart().startsWith("{");
  const configPath = isInlineJson ? rawConfig : resolve(rawConfig);
  process.stderr.write(
    isInlineJson ? "[mcmcp] loading inline JSON config\n" : `[mcmcp] loading config: ${configPath}\n`,
  );

  let config: MCMCPConfig;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      process.stderr.write(`[mcmcp] ${err.message}\n`);
    } else {
      process.stderr.write(`[mcmcp] config error: ${(err as Error).message}\n`);
    }
    process.exit(1);
  }

  const metrics = new Metrics();
  const logger = createLogger(config.logging);
  await initTracing(config.otel);
  // Forward-declare the Server reference so the sampling sink can call
  // back into it once the server is constructed below.
  let serverRef: Server | null = null;
  const samplingSink = async (
    params: CreateMessageRequest["params"],
  ): Promise<CreateMessageResult> => {
    if (!serverRef) {
      throw new Error("sampling/createMessage received before server was ready");
    }
    return await serverRef.createMessage(params);
  };
  const proxy = new UpstreamProxy({ logger, metrics, sampling: samplingSink });
  await proxy.init(config);

  // Register the in-process management tools. They mutate the live
  // config, persist it to disk, and re-apply via proxy.applyConfigDiff.
  // When `readonly` (config flag or MCMCP_READONLY=1 env), only the
  // observation-class tools (operator=false) are registered.
  const readonly =
    config.readonly === true || process.env.MCMCP_READONLY === "1";
  if (readonly) {
    process.stderr.write("[mcmcp] readonly mode: mutating internal tools are disabled\n");
  }
  proxy.registerInternalTools(filterInternalToolsForPolicy(INTERNAL_TOOL_DEFS, { readonly }), {
    configPath,
    getConfig: () => config,
    applyMutation: async (next, reason) => {
      const serialized = JSON.stringify(next, null, 2) + "\n";
      if (!isInlineJson) {
        // Suppress the file-watcher's own reload trigger for this write —
        // we apply the diff inline below so the result is identical.
        // Atomic write produces *one* rename event on the target path.
        suppressNextWatchTick++;
        await atomicWriteFile(configPath, serialized);
      }
      try {
        await proxy.applyConfigDiff(next);
      } catch (err) {
        if (!isInlineJson) {
          // Roll back the suppression so a subsequent external edit still triggers reload.
          suppressNextWatchTick = Math.max(0, suppressNextWatchTick - 1);
        }
        throw err;
      }
      config.callTimeoutMs = next.callTimeoutMs;
      config.maxBatchSize = next.maxBatchSize;
      config.shutdownTimeoutMs = next.shutdownTimeoutMs;
      config.directory = next.directory;
      config.security = next.security;
      config.upstreams = next.upstreams;
      metrics.recordReload();
      process.stderr.write(
        `[mcmcp] config mutated by internal tool (${reason}); ${next.upstreams.length} upstream(s)\n`,
      );
      logger.log({
        type: "upstream_event",
        mode: "internal_mutation",
        duration_ms: 0,
        ok: true,
        reason,
      });
    },
    reloadFromDisk: () => reload(),
  });

  let inFlight = 0;
  let shuttingDown = false;
  const isShuttingDown = (): boolean => shuttingDown;

  const server = new Server(
    { name: "mcmcp", version: MCMCP_VERSION },
    // Sampling is a *client* capability declared by the host LLM. mcmcp's
    // own Server only needs to advertise tools; createMessage requests
    // it relays to the host will be served only if the host announced
    // sampling support during initialize.
    { capabilities: { tools: {} } },
  );
  serverRef = server;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // The tool_tool description is regenerated on every tools/list so the
    // injected directory always reflects the live proxy state. The MCP
    // SDK has no per-request "override description" hook — we simply
    // build the full Tool object on every call here, which is the same
    // primitive the SDK uses internally to serialize the response.
    const directoryEnabled = proxy.getDirectoryConfig().enabled;
    let description: string;
    if (directoryEnabled) {
      const snapshot = proxy.buildSnapshot();
      description = composeToolToolDescription(snapshot);
    } else {
      description = STATIC_TOOL_TOOL_DESCRIPTION;
    }
    return {
      tools: [
        {
          name: "tool_tool",
          description,
          inputSchema: TOOL_TOOL_INPUT_SCHEMA,
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "tool_tool") {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Unknown tool '${req.params.name}'. Only 'tool_tool' is exposed by mcmcp.`,
            }),
          },
        ],
      };
    }
    inFlight++;
    try {
      const result = await handleToolTool(
        { proxy, metrics, logger, config, isShuttingDown },
        req.params.arguments,
      );
      return result as unknown as Awaited<
        ReturnType<Parameters<typeof server.setRequestHandler<typeof CallToolRequestSchema>>[1]>
      >;
    } finally {
      inFlight--;
    }
  });

  // ----- Hot reload -----
  let watcher: FSWatcher | null = null;
  /** Suppress watcher events caused by mcmcp writing to its own config. */
  let suppressNextWatchTick = 0;
  let reloadDebounceTimer: NodeJS.Timeout | null = null;
  if (config.hotReload !== false && !isInlineJson) {
    try {
      watcher = watch(configPath, () => {
        if (suppressNextWatchTick > 0) {
          suppressNextWatchTick--;
          return;
        }
        if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
        reloadDebounceTimer = setTimeout(() => void reload(), 500);
      });
    } catch (err) {
      process.stderr.write(
        `[mcmcp] warning: could not watch ${configPath}: ${(err as Error).message}\n`,
      );
    }
  }

  async function reload(): Promise<void> {
    if (shuttingDown) return;
    process.stderr.write(
      `[mcmcp] [${new Date().toISOString()}] config change detected, reloading...\n`,
    );
    let next: MCMCPConfig;
    try {
      next = await loadConfig(configPath);
    } catch (err) {
      const msg =
        err instanceof ConfigValidationError
          ? err.message
          : (err as Error).message;
      process.stderr.write(`[mcmcp] reload aborted (invalid config): ${msg}\n`);
      logger.log({
        type: "upstream_event",
        mode: "reload_failed",
        duration_ms: 0,
        ok: false,
        error: msg,
      });
      return;
    }
    try {
      await proxy.applyConfigDiff(next);
      // Replace mutable config slots in-place so handlers pick up new defaults.
      config.callTimeoutMs = next.callTimeoutMs;
      config.maxBatchSize = next.maxBatchSize;
      config.shutdownTimeoutMs = next.shutdownTimeoutMs;
      config.directory = next.directory;
      config.security = next.security;
      config.upstreams = next.upstreams;
      metrics.recordReload();
      process.stderr.write(
        `[mcmcp] [${new Date().toISOString()}] reload complete\n`,
      );
      logger.log({
        type: "upstream_event",
        mode: "reload",
        duration_ms: 0,
        ok: true,
      });
    } catch (err) {
      const msg = (err as Error).message;
      process.stderr.write(`[mcmcp] reload error: ${msg}\n`);
      logger.log({
        type: "upstream_event",
        mode: "reload_failed",
        duration_ms: 0,
        ok: false,
        error: msg,
      });
    }
  }

  // ----- Transport -----
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcmcp] server ready on stdio\n");

  // ----- Graceful shutdown -----
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[mcmcp] received ${signal}, shutting down\n`);
    logger.log({
      type: "upstream_event",
      mode: "shutdown",
      duration_ms: 0,
      ok: true,
      signal,
    });
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
    }
    if (reloadDebounceTimer) {
      clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = null;
    }
    const limitMs = config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const start = Date.now();
    while (inFlight > 0 && Date.now() - start < limitMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      await proxy.close();
      await server.close();
    } catch {
      /* ignore */
    }
    await logger.close();
    await shutdownTracing();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`[mcmcp] fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
