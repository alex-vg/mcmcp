import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import AjvModule, { type ErrorObject, type Ajv as AjvType } from "ajv";
import { MCMCP_CONFIG_SCHEMA } from "./config-schema.js";
import type { LoggerConfig } from "./logger.js";

// Ajv ships as CJS — under Node16 ESM the constructor lives on `.default`.
const AjvCtor: { new (opts?: object): AjvType } =
  ((AjvModule as unknown as { default?: { new (opts?: object): AjvType } }).default ??
    (AjvModule as unknown as { new (opts?: object): AjvType }));

/** Bearer-token auth for SSE upstreams. */
export interface BearerAuth {
  type: "bearer";
  token: string;
}

/** Arbitrary header auth for SSE upstreams. */
export interface HeaderAuth {
  type: "header";
  headers: Record<string, string>;
}

export type UpstreamAuth = BearerAuth | HeaderAuth;

/** Per-upstream retry policy for `callTool`. */
export interface RetryConfig {
  maxAttempts?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  retryOn?: Array<"timeout" | "transport_error">;
}

/** OAuth 2.0 / PKCE configuration for SSE upstreams. */
export interface OAuthConfig {
  /** Authorization server / issuer URL. */
  issuer: string;
  /** OAuth client id (registered or via DCR). */
  clientId: string;
  /** Optional client secret for confidential clients. */
  clientSecret?: string;
  /** Scopes to request. */
  scope?: string;
  /** Path on disk where refresh tokens / client info are persisted. */
  tokenStorePath: string;
  /** Pre-acquired refresh token to seed the store on first run. */
  initialRefreshToken?: string;
}

/** Per-upstream rate limit configuration. */
export interface RateLimitConfig {
  requestsPerMinute: number;
}

/** Per-upstream result-cache configuration (raw, as written by the user). */
export interface CacheConfigRaw {
  enabled: boolean;
  ttlMs?: number;
  maxEntries?: number;
}

/** Stdio-transport upstream definition. */
export interface StdioUpstream {
  id: string;
  label?: string;
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  retry?: RetryConfig;
  rateLimit?: RateLimitConfig;
  cache?: CacheConfigRaw;
  /** Map upstream tool names to mcmcp-exposed names. Wins over collision prefixing. */
  aliases?: Record<string, string>;
  /** Not valid on stdio; warned about and ignored if present. */
  auth?: UpstreamAuth;
}

/** SSE-transport upstream definition. */
export interface SseUpstream {
  id: string;
  label?: string;
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
  auth?: UpstreamAuth;
  /** OAuth 2.0 / PKCE provider config (mutually exclusive with `auth`). */
  oauth?: OAuthConfig;
  retry?: RetryConfig;
  rateLimit?: RateLimitConfig;
  cache?: CacheConfigRaw;
  aliases?: Record<string, string>;
}

export type UpstreamConfig = StdioUpstream | SseUpstream;

/** Tunables for the dynamic tool directory injected into tool_tool. */
export interface DirectoryConfig {
  enabled?: boolean;
  tierOneMaxTools?: number;
  tierTwoMaxServers?: number;
}

/** Resolved (non-optional) directory thresholds. */
export interface DirectoryThresholdsResolved {
  enabled: boolean;
  tierOneMaxTools: number;
  tierTwoMaxServers: number;
}

/** Security policy applied to upstream tool results before they reach the LLM. */
export interface SecurityConfig {
  /** Scan upstream text content for prompt-injection markers. Default true. */
  scanForInjection?: boolean;
  /** Block (return isError) instead of just flagging. Default false. */
  blockOnInjection?: boolean;
  /** Additional regex patterns (case-insensitive) to flag. */
  customPatterns?: string[];
}

/** OpenTelemetry tracing config. */
export interface OtelConfig {
  enabled?: boolean;
  /** Service name reported in spans. Default `mcmcp`. */
  serviceName?: string;
  /** OTLP HTTP endpoint (e.g. http://localhost:4318/v1/traces). */
  otlpEndpoint?: string;
}

/** Top-level MCMCP configuration. */
export interface MCMCPConfig {
  /** Per-call timeout in ms for upstream tool invocations. Default 30_000. */
  callTimeoutMs?: number;
  /** Maximum items in a single call_batch. Default 10. */
  maxBatchSize?: number;
  /** Shutdown grace period in ms. Default 10_000. */
  shutdownTimeoutMs?: number;
  /** Toggle the config file watcher. Default true. */
  hotReload?: boolean;
  /** When true, internal mutating tools (add/remove upstream) are disabled. */
  readonly?: boolean;
  /** Structured logging settings. */
  logging?: LoggerConfig;
  /** Dynamic directory thresholds (Phase 4). */
  directory?: DirectoryConfig;
  /** Result-content sanitization. */
  security?: SecurityConfig;
  /** OpenTelemetry tracing. */
  otel?: OtelConfig;
  upstreams: UpstreamConfig[];
}

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BATCH_SIZE = 10;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_DIRECTORY_TIER_ONE_MAX_TOOLS = 30;
export const DEFAULT_DIRECTORY_TIER_TWO_MAX_SERVERS = 30;

/** Resolve directory thresholds with documented defaults. */
export function resolveDirectoryConfig(
  cfg: DirectoryConfig | undefined,
): DirectoryThresholdsResolved {
  return {
    enabled: cfg?.enabled ?? true,
    tierOneMaxTools: cfg?.tierOneMaxTools ?? DEFAULT_DIRECTORY_TIER_ONE_MAX_TOOLS,
    tierTwoMaxServers: cfg?.tierTwoMaxServers ?? DEFAULT_DIRECTORY_TIER_TWO_MAX_SERVERS,
  };
}

const ENV_VAR_RE = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Replace `${VAR}` placeholders in a string with `process.env` values.
 * Throws when any referenced variable is unset, naming the variable and
 * the location (upstream id / field) it was referenced from.
 */
export function resolveEnvVars(value: string, where: string): string {
  return value.replace(ENV_VAR_RE, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(
        `Environment variable '\${${name}}' referenced in ${where} is not set.`,
      );
    }
    return v;
  });
}

function substituteRecursively(value: unknown, where: string): unknown {
  if (typeof value === "string") return resolveEnvVars(value, where);
  if (Array.isArray(value)) {
    return value.map((v, i) => substituteRecursively(v, `${where}[${i}]`));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteRecursively(v, `${where}.${k}`);
    }
    return out;
  }
  return value;
}

const ajv = new AjvCtor({ allErrors: true, strict: false });

// ---------------------------------------------------------------------------
// VS Code mcp.json format auto-detection + conversion
// ---------------------------------------------------------------------------

/** Shape of one entry in a VS Code `mcp.json` servers block. */
interface VSCodeServerDef {
  type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  /** Free-form request headers (VS Code SSE / HTTP servers). */
  headers?: Record<string, string>;
}

function isVSCodeServerDef(v: unknown): v is VSCodeServerDef {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const t = (v as Record<string, unknown>).type;
  return t === "stdio" || t === "sse" || t === "http";
}

/**
 * Return true if `obj` looks like a VS Code `mcp.json` servers block.
 * Accepts both the bare `{ id: def, ... }` form and the
 * `{ servers: { id: def, ... }, inputs: [...] }` wrapper form.
 * Rejects anything that already has an `upstreams` key (native format).
 */
function looksLikeVSCodeFormat(obj: Record<string, unknown>): boolean {
  if ("upstreams" in obj) return false;
  // { "servers": { ... } } wrapper (top-level VS Code mcp.json)
  if (
    obj.servers !== null &&
    obj.servers !== undefined &&
    typeof obj.servers === "object" &&
    !Array.isArray(obj.servers)
  ) {
    return Object.values(obj.servers as Record<string, unknown>).some(isVSCodeServerDef);
  }
  // Flat map where every value looks like a server definition
  const entries = Object.entries(obj);
  return entries.length > 0 && entries.every(([, v]) => isVSCodeServerDef(v));
}

/**
 * Convert a VS Code `mcp.json` servers block into an mcmcp config object.
 * `type` becomes `transport` (`"http"` is mapped to `"sse"`).
 * The entry key becomes the upstream `id`.
 */
function convertVSCodeFormat(obj: Record<string, unknown>): Record<string, unknown> {
  const serversMap: Record<string, unknown> =
    obj.servers !== null &&
    obj.servers !== undefined &&
    typeof obj.servers === "object" &&
    !Array.isArray(obj.servers)
      ? (obj.servers as Record<string, unknown>)
      : obj;

  const upstreams: Record<string, unknown>[] = [];
  for (const [id, def] of Object.entries(serversMap)) {
    if (!isVSCodeServerDef(def)) continue; // skip non-server entries (e.g. inputs)
    const transport = def.type === "http" ? "sse" : def.type;
    const upstream: Record<string, unknown> = { id, transport };
    if (def.command !== undefined) upstream.command = def.command;
    if (def.args !== undefined) upstream.args = def.args;
    if (def.env !== undefined) upstream.env = def.env;
    if (def.cwd !== undefined) upstream.cwd = def.cwd;
    if (def.url !== undefined) upstream.url = def.url;
    if (def.headers !== undefined) upstream.headers = def.headers;
    upstreams.push(upstream);
  }
  return { upstreams };
}

const validateConfig = ajv.compile(MCMCP_CONFIG_SCHEMA);

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "(no details)";
  return errors
    .map(
      (e) =>
        `  - ${e.instancePath || "<root>"} ${e.message ?? ""}${
          e.params ? " " + JSON.stringify(e.params) : ""
        }`,
    )
    .join("\n");
}

/** Thrown when an Ajv validation pass fails; carries the raw error list. */
export class ConfigValidationError extends Error {
  constructor(public readonly errors: ErrorObject[]) {
    super(`Config validation failed:\n${formatErrors(errors)}`);
    this.name = "ConfigValidationError";
  }
}

/** Validate, env-substitute, and post-process a parsed config object. */
export function parseConfigObject(raw: unknown, source: string): MCMCPConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Config ${source} is not an object`);
  }
  let obj = raw as Record<string, unknown>;
  if (looksLikeVSCodeFormat(obj)) {
    process.stderr.write(`[mcmcp] detected VS Code mcp.json format in ${source} — converting\n`);
    obj = convertVSCodeFormat(obj);
  }
  const substituted = substituteRecursively(obj, "config") as Record<string, unknown>;
  if (!validateConfig(substituted)) {
    throw new ConfigValidationError(validateConfig.errors ?? []);
  }
  const cfg = substituted as unknown as MCMCPConfig;
  const ids = new Set<string>();
  for (const u of cfg.upstreams) {
    if (ids.has(u.id)) {
      throw new Error(`Duplicate upstream id '${u.id}' in ${source}`);
    }
    ids.add(u.id);
    if (u.transport === "stdio" && (u as StdioUpstream).auth) {
      process.stderr.write(
        `[mcmcp] warning: 'auth' is not supported on stdio upstream '${u.id}' — ignoring.\n`,
      );
      delete (u as StdioUpstream).auth;
    }
  }
  return cfg;
}

/** Loads, env-substitutes, and validates the MCMCP config from disk or inline JSON. */
export async function loadConfig(pathOrJson: string): Promise<MCMCPConfig> {
  // Inline JSON: passed directly instead of as a file path.
  if (pathOrJson.trimStart().startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(pathOrJson);
    } catch (e) {
      throw new Error(`Inline JSON config is invalid: ${(e as Error).message}`);
    }
    return parseConfigObject(parsed, "<inline>");
  }
  const abs = resolve(pathOrJson);
  const raw = await readFile(abs, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse config ${abs}: ${(e as Error).message}`);
  }
  return parseConfigObject(parsed, abs);
}

/** Recursively sort object keys so key-insertion-order differences are ignored. */
function stableSort(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stableSort);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).sort()) {
    out[k] = stableSort((v as Record<string, unknown>)[k]);
  }
  return out;
}

/** True iff two upstream configs are functionally identical. */
export function upstreamsEqual(a: UpstreamConfig, b: UpstreamConfig): boolean {
  return JSON.stringify(stableSort(a)) === JSON.stringify(stableSort(b));
}
