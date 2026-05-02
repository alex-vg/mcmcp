import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, parseConfigObject } from "./config.js";

// ---------------------------------------------------------------------------
// parseConfigObject — unit tests (no I/O)
// ---------------------------------------------------------------------------

describe("parseConfigObject – native format", () => {
  it("accepts minimal valid config", () => {
    const cfg = parseConfigObject(
      { upstreams: [{ id: "s1", transport: "stdio", command: "cat" }] },
      "<test>",
    );
    assert.equal(cfg.upstreams.length, 1);
    assert.equal(cfg.upstreams[0]!.id, "s1");
  });

  it("rejects duplicate upstream ids", () => {
    assert.throws(
      () =>
        parseConfigObject(
          {
            upstreams: [
              { id: "dup", transport: "stdio", command: "cat" },
              { id: "dup", transport: "stdio", command: "echo" },
            ],
          },
          "<test>",
        ),
      /duplicate upstream id/i,
    );
  });

  it("rejects missing upstreams array", () => {
    assert.throws(() => parseConfigObject({}, "<test>"), /upstreams/i);
  });

  it("resolves ${VAR} placeholders from process.env", () => {
    process.env["_MCMCP_TEST_CMD"] = "my-server";
    try {
      const cfg = parseConfigObject(
        { upstreams: [{ id: "s1", transport: "stdio", command: "${_MCMCP_TEST_CMD}" }] },
        "<test>",
      );
      assert.equal((cfg.upstreams[0] as { command: string }).command, "my-server");
    } finally {
      delete process.env["_MCMCP_TEST_CMD"];
    }
  });

  it("throws on unset ${VAR} reference", () => {
    delete process.env["_MCMCP_NO_SUCH_VAR"];
    assert.throws(
      () =>
        parseConfigObject(
          { upstreams: [{ id: "s1", transport: "stdio", command: "${_MCMCP_NO_SUCH_VAR}" }] },
          "<test>",
        ),
      /_MCMCP_NO_SUCH_VAR/,
    );
  });
});

describe("parseConfigObject – VS Code mcp.json format", () => {
  it("converts flat VS Code format (no 'upstreams' key)", () => {
    const cfg = parseConfigObject(
      {
        myserver: { type: "stdio", command: "node", args: ["server.js"] },
      },
      "<test>",
    );
    assert.equal(cfg.upstreams.length, 1);
    assert.equal(cfg.upstreams[0]!.id, "myserver");
    assert.equal(cfg.upstreams[0]!.transport, "stdio");
  });

  it("converts VS Code wrapped format ({ servers: {...} })", () => {
    const cfg = parseConfigObject(
      {
        servers: {
          gh: { type: "sse", url: "https://api.example.com/sse" },
        },
        inputs: [],
      },
      "<test>",
    );
    assert.equal(cfg.upstreams.length, 1);
    assert.equal(cfg.upstreams[0]!.id, "gh");
    assert.equal(cfg.upstreams[0]!.transport, "sse");
  });

  it("maps VS Code 'http' type to 'sse'", () => {
    const cfg = parseConfigObject(
      { remote: { type: "http", url: "https://example.com/mcp" } },
      "<test>",
    );
    assert.equal(cfg.upstreams[0]!.transport, "sse");
  });
});

// ---------------------------------------------------------------------------
// loadConfig — integration test (disk I/O with a tmp file)
// ---------------------------------------------------------------------------

describe("loadConfig – from file", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), `mcmcp-config-test-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads and validates a config file", async () => {
    const p = join(tmpDir, "cfg.json");
    writeFileSync(
      p,
      JSON.stringify({ upstreams: [{ id: "fs", transport: "stdio", command: "cat" }] }),
    );
    const cfg = await loadConfig(p);
    assert.equal(cfg.upstreams[0]!.id, "fs");
  });

  it("loads inline JSON (path starts with {)", async () => {
    const cfg = await loadConfig(
      JSON.stringify({ upstreams: [{ id: "inline", transport: "stdio", command: "cat" }] }),
    );
    assert.equal(cfg.upstreams[0]!.id, "inline");
  });

  it("throws on invalid JSON file", async () => {
    const p = join(tmpDir, "bad.json");
    writeFileSync(p, "not-json{{{");
    await assert.rejects(() => loadConfig(p), /failed to parse/i);
  });

  it("throws on missing file", async () => {
    await assert.rejects(() => loadConfig(join(tmpDir, "nonexistent.json")));
  });
});
