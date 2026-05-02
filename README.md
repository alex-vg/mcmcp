# mcmcp

[![npm version](https://img.shields.io/npm/v/mcmcp.svg)](https://www.npmjs.com/package/mcmcp)
[![npm downloads](https://img.shields.io/npm/dm/mcmcp.svg)](https://www.npmjs.com/package/mcmcp)
[![CI](https://github.com/alex-vg/mcmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alex-vg/mcmcp/actions/workflows/ci.yml)
[![Node ≥18](https://img.shields.io/node/v/mcmcp.svg)](https://nodejs.org)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

> **Minimized Context MCP.** Slash token usage by hiding all upstream tools behind a single `tool_tool` interface. The model discovers and calls tools on-demand instead of receiving hundreds of definitions upfront.

## Why

The Model Context Protocol is great, until your client connects to seven servers and your model is staring down 140 tool definitions before it has read a single byte of the user's prompt. Tool manifests are expensive: they burn context window, they confuse routing, and they make every request slower.

`mcmcp` solves this by exposing **exactly one tool** to the client — `tool_tool` — and routing every interaction through it:

| Mode          | Purpose                                                      |
| ------------- | ------------------------------------------------------------ |
| `list`        | Search/enumerate upstream tools (with filtering)             |
| `describe`    | Fetch the full schema for a specific tool on demand          |
| `call`        | Invoke a tool, with disambiguation and timeouts              |
| `call_batch`  | Fan out N calls in parallel, or run sequentially with short-circuit |
| `status`      | Health, ping latency, and cache stats per upstream           |
| `metrics`     | Counters, latencies, hit-rates, rate-limit rejections        |

The model only loads the schemas it actually needs, when it needs them. A 14-tool filesystem server + a 50-tool GitHub server + a 30-tool browser server now costs the client **one** tool slot.

## Features

- **Lazy schema loading** — clients see one tool, not hundreds.
- **Mixed transports** — `stdio` and `sse` upstreams in the same config.
- **Auth for SSE** — `bearer`, arbitrary `header`, or full OAuth 2.0/PKCE, with `${ENV_VAR}` substitution.
- **Hot reload** — edit the config file, upstreams diff and reconnect in place.
- **Retries with full-jitter exponential backoff** — only on transport / timeout, never on tool-reported errors.
- **Per-upstream rate limiting** — token bucket, with informative `retryAfterSeconds`.
- **Opt-in result caching** — TTL + LRU, SHA-256 keyed on `(upstream, tool, args)`. Never caches `isError` results.
- **JSON Schema validation** — config is validated by Ajv; all errors surfaced at once, not one at a time.
- **Structured JSON-lines logging** — with size-based rotation.
- **Graceful shutdown** — drains in-flight calls within `shutdownTimeoutMs` on SIGINT/SIGTERM.
- **Pure stdout** — only MCP JSON-RPC ever touches stdout. All diagnostics go to stderr / log file.
- **Minimal runtime deps** — only the MCP SDK and Ajv. OpenTelemetry packages are optional and only installed when you need them.

## Using mcmcp

This section is for end-users who want to wire mcmcp into their AI client. No development environment needed — Node.js ≥ 18 is the only requirement.

### Step 1 — Create your config file

mcmcp accepts **two config formats**:

**Native format** (`mcmcp.config.json`):

```json
{
  "upstreams": [
    {
      "id": "filesystem",
      "label": "Filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/projects"]
    },
    {
      "id": "github",
      "label": "GitHub",
      "transport": "sse",
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": { "type": "bearer", "token": "${GITHUB_TOKEN}" }
    }
  ]
}
```

**VS Code `mcp.json` format** (auto-detected — no conversion needed):

```json
{
  "filesystem": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/projects"]
  },
  "github": {
    "type": "sse",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
  }
}
```

mcmcp detects the format automatically. The `{ "servers": { ... } }` wrapper form (as written by VS Code itself) is also accepted.

Tokens and secrets are never written literally — use `${ENV_VAR}` placeholders and set them in your shell / client environment.

### Step 2 — Pick a run method

**Option A: npx (zero install, always latest)**

```bash
npx mcmcp /path/to/mcmcp.config.json
```

**Option B: global install**

```bash
npm install -g mcmcp
mcmcp /path/to/mcmcp.config.json
```

**Option C: local clone**

```bash
git clone https://github.com/alex-vg/mcmcp
cd mcmcp && npm install && npm run build
node dist/index.js /path/to/mcmcp.config.json
```

### Step 3 — Add to your MCP client

#### VS Code (GitHub Copilot)

mcmcp accepts VS Code's own `mcp.json` server format directly, so you can keep a single file for everything.

**Option 1 — point at your existing `.vscode/mcp.json`**

Add `mcmcp` to your `.vscode/mcp.json` alongside your other servers. mcmcp will auto-detect the VS Code format and use the rest of the entries as its upstreams:

```json
{
  "servers": {
    "mcmcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcmcp", "${workspaceFolder}/.vscode/mcp.json"]
    },
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"]
    },
    "github": {
      "type": "sse",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${env:GITHUB_TOKEN}" }
    }
  }
}
```

mcmcp will read the same file, detect the VS Code format, and proxy `filesystem` and `github` through `tool_tool`. The `mcmcp` entry itself is skipped (it can't connect to itself).

**Option 2 — use a separate `mcmcp.config.json` (native format)**

Add to your workspace `.vscode/mcp.json`:

```json
{
  "servers": {
    "mcmcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcmcp", "${workspaceFolder}/mcmcp.config.json"]
    }
  }
}
```

Or add to your **user** `settings.json` for a server available in every workspace:

```json
"mcp": {
  "servers": {
    "mcmcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcmcp", "/absolute/path/to/mcmcp.config.json"]
    }
  }
}
```

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "mcmcp": {
      "command": "npx",
      "args": ["-y", "mcmcp", "/absolute/path/to/mcmcp.config.json"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

#### Other clients (any stdio MCP client)

The server reads from stdin and writes to stdout — wire it in with:

```
command: npx
args:    ["-y", "mcmcp", "/path/to/mcmcp.config.json"]
```

### Environment variables

| Variable        | Purpose                                                  |
| --------------- | -------------------------------------------------------- |
| `MCMCP_CONFIG`  | Config file path (alternative to passing it as an arg). |
| `MCMCP_READONLY`| Set to `1` to disable all mutating internal tools.      |
| `MCMCP_OTEL`    | Set to `1` to enable OpenTelemetry tracing.             |

### Useful internal tools

Once connected, the model can also call these built-in tools through `tool_tool`:

| Tool                      | What it does                                           |
| ------------------------- | ------------------------------------------------------ |
| `mcmcp__list_upstreams`   | List all configured upstream servers.                  |
| `mcmcp__get_config`       | Return the active config (secrets redacted).           |
| `mcmcp__add_upstream`     | Register a new upstream at runtime (persisted to disk).|
| `mcmcp__remove_upstream`  | Remove an upstream at runtime (persisted to disk).     |
| `mcmcp__reload_config`    | Force a re-read of the config file from disk.          |

---

## Developer guide

### Install

```bash
npm install
npm run build
```

Requires Node ≥ 18.

## Quick start (developers)

1. Create `mcmcp.config.json`:

   ```json
   {
     "upstreams": [
       {
         "id": "filesystem",
         "label": "Filesystem Tools",
         "transport": "stdio",
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
       },
       {
         "id": "github",
         "transport": "sse",
         "url": "https://example.com/mcp/sse",
         "auth": { "type": "bearer", "token": "${GITHUB_MCP_TOKEN}" }
       }
     ]
   }
   ```

2. Wire it into your MCP client (Claude Desktop, etc.):

   ```json
   {
     "mcpServers": {
       "mcmcp": {
         "command": "node",
         "args": ["/absolute/path/to/mcmcp/dist/index.js", "/absolute/path/to/mcmcp.config.json"]
       }
     }
   }
   ```

3. From the model's perspective, only `tool_tool` exists. Typical interactions:

   ```jsonc
   // Discover
   { "mode": "list", "tool_filter": "read" }

   // Inspect
   { "mode": "describe", "tool_name": "read_file" }

   // Call
   { "mode": "call", "tool_name": "read_file", "tool_args": { "path": "/tmp/x" } }

   // Fan out
   {
     "mode": "call_batch",
     "batch_mode": "parallel",
     "calls": [
       { "call_id": "a", "tool_name": "read_file", "tool_args": { "path": "/tmp/a" } },
       { "call_id": "b", "tool_name": "read_file", "tool_args": { "path": "/tmp/b" } }
     ]
   }
   ```

## Configuration reference

Top-level keys (all optional except `upstreams`):

| Key                    | Default | Notes                                              |
| ---------------------- | ------- | -------------------------------------------------- |
| `upstreams`            | —       | Array of upstream definitions (required).          |
| `callTimeoutMs`        | `30000` | Per-invocation timeout, before retries.            |
| `maxBatchSize`         | `10`    | Max items in `mode=call_batch`.                    |
| `shutdownTimeoutMs`    | `10000` | Max time to drain in-flight calls on SIGTERM.      |
| `hotReload`            | `true`  | Watch the config file and apply diffs live.        |
| `logging`              | off     | `{ enabled, path, maxSizeMb }`.                    |

Per-upstream keys:

| Key             | Type        | Notes                                                            |
| --------------- | ----------- | ---------------------------------------------------------------- |
| `id`            | string      | Required, unique, no whitespace.                                 |
| `label`         | string      | Optional human-readable label for `mode=status`.                 |
| `transport`     | `stdio`/`sse` | Required.                                                      |
| `command`,`args`,`env` | —    | Required for `stdio`. `env` values support `${VAR}` substitution.|
| `url`           | string      | Required for `sse` (must be `http(s)://`).                       |
| `auth`          | object      | `sse` only. `{type:"bearer", token}` or `{type:"header", headers:{"X-My-Header":"value"}}`. |
| `oauth`         | object      | `sse` only. OAuth 2.0/PKCE: `{issuer, clientId, tokenStorePath}` + optional `clientSecret`, `scope`, `initialRefreshToken`. |
| `retry`         | object      | `{maxAttempts, initialDelayMs, backoffFactor, retryOn[]}`.       |
| `rateLimit`     | object      | `{requestsPerMinute}` token bucket.                              |
| `cache`         | object      | `{enabled, ttlMs, maxEntries}`.                                  |

`${VAR}` substitution applies recursively to every string value.

## Architecture

```
   ┌──────────────────┐         ┌──────────────────────────────────┐
   │  MCP client      │  stdio  │  mcmcp                           │
   │  (Claude, etc.)  │◀───────▶│  exposes ONLY tool_tool          │
   └──────────────────┘         │                                  │
                                │  ┌────────────────────────────┐  │
                                │  │ UpstreamProxy              │  │
                                │  │  ├─ rate limiter (per-id)  │  │
                                │  │  ├─ cache (per-id, opt-in) │  │
                                │  │  ├─ retry + jitter         │  │
                                │  │  └─ Promise.race timeout   │  │
                                │  └────┬───────────────────────┘  │
                                └───────┼──────────────────────────┘
                                        │ MCP Client connections
                ┌───────────────────────┼──────────────────────────┐
                ▼                       ▼                          ▼
        stdio upstream            SSE upstream                  ...
        (filesystem)              (github, with auth)
```

Cross-cutting concerns (logging, metrics) are **dependency-injected** rather than global. The only global is the file-system watcher + signal handlers in `src/index.ts`.

## Scripts

| Command                              | What it does                                       |
| ------------------------------------ | -------------------------------------------------- |
| `npm run build`                      | TypeScript strict-mode compile to `dist/`.         |
| `npm start`                          | Run the compiled server (expects config path arg). |
| `npm run smoke -- mcmcp.config.json`  | End-to-end assertion suite (requires a `filesystem` upstream in the config). |

## Layout

```
src/
  index.ts          MCP server bootstrap, hot-reload watcher, signal handlers
  proxy.ts          UpstreamProxy: connections, retry, rate-limit, cache, status
  tool-tool.ts      The single exposed tool; dispatches all six modes
  config.ts         Loader, env-var substitution, Ajv validation
  config-schema.ts  Draft-07 JSON Schema for the entire config surface
  metrics.ts        Counters + rolling latency window
  logger.ts         JSON-lines logger with size-based rotation
  rate-limiter.ts   Per-upstream token bucket
  cache.ts          Per-upstream TTL + LRU result cache
  security.ts       Request/response sanitisation and pattern blocking
  oauth.ts          Headless OAuth2/PKCE token management
  otel.ts           Optional OpenTelemetry tracing (lazy dynamic import)
  directory.ts      Tier-based tool-directory snapshot rendering
  middleware.ts     Before/after hook pipeline
  atomic-write.ts   Atomic file-write via temp-file + rename
  internal-tools.ts Built-in mcmcp__ management tools
scripts/
  smoke-test.ts     End-to-end assertion suite
```

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).
