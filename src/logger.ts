import { createWriteStream, statSync, renameSync, existsSync, type WriteStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";

/** Single structured log entry written as one JSON line. */
export interface LogEntry {
  ts: string;
  type:
    | "call"
    | "batch_call"
    | "list"
    | "describe"
    | "status"
    | "metrics"
    | "error"
    | "upstream_event";
  mode: string;
  tool_name?: string;
  upstream_id?: string;
  duration_ms: number;
  ok: boolean;
  error?: string;
  call_id?: string;
  [k: string]: unknown;
}

/** Logger configuration block (mirrors `logging` in mcmcp.config.json). */
export interface LoggerConfig {
  enabled?: boolean;
  path?: string;
  maxSizeMb?: number;
}

/**
 * Append-only JSON-lines logger with a single rotated backup file
 * (`<path>.1`). Created via {@link createLogger}; never use a global —
 * pass the instance to consumers explicitly.
 */
export class Logger {
  private stream: WriteStream | null = null;
  private bytes = 0;
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly enabled: boolean;
  private closed = false;

  constructor(cfg: LoggerConfig | undefined) {
    this.enabled = cfg?.enabled !== false && Boolean(cfg?.path ?? cfg?.enabled);
    this.path = resolve(cfg?.path ?? "./mcmcp.log");
    this.maxBytes = Math.max(1, cfg?.maxSizeMb ?? 10) * 1024 * 1024;
    if (this.enabled) {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        if (existsSync(this.path)) {
          this.bytes = statSync(this.path).size;
        }
        this.stream = createWriteStream(this.path, { flags: "a" });
      } catch (err) {
        process.stderr.write(
          `[mcmcp] logger init failed: ${(err as Error).message}\n`,
        );
        this.stream = null;
      }
    }
  }

  /** Write a single log entry. Silent no-op if logging is disabled. */
  log(entry: Omit<LogEntry, "ts"> & { ts?: string }): void {
    if (!this.enabled || !this.stream || this.closed) return;
    const line = JSON.stringify({ ts: entry.ts ?? new Date().toISOString(), ...entry }) + "\n";
    const buf = Buffer.from(line, "utf8");
    this.stream.write(buf);
    this.bytes += buf.length;
    if (this.bytes >= this.maxBytes) this.rotate();
  }

  private rotate(): void {
    if (!this.stream) return;
    try {
      this.stream.end();
      const rotated = `${this.path}.1`;
      try {
        renameSync(this.path, rotated);
      } catch (err) {
        process.stderr.write(
          `[mcmcp] logger rotate failed: ${(err as Error).message}\n`,
        );
      }
      this.stream = createWriteStream(this.path, { flags: "a" });
      this.bytes = 0;
    } catch (err) {
      process.stderr.write(
        `[mcmcp] logger rotate error: ${(err as Error).message}\n`,
      );
    }
  }

  /** Flush + close the underlying stream. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const s = this.stream;
    this.stream = null;
    if (!s) return;
    await new Promise<void>((res) => {
      s.end(() => res());
    });
  }
}

/** Convenience factory matching the JSDoc contract. */
export function createLogger(cfg: LoggerConfig | undefined): Logger {
  return new Logger(cfg);
}
