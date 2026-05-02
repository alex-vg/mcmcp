import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";

describe("atomicWriteFile", () => {
  it("writes contents and leaves no temp file behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcmcp-atomic-"));
    const target = join(dir, "config.json");
    await atomicWriteFile(target, '{"hello":"world"}');
    assert.equal(readFileSync(target, "utf8"), '{"hello":"world"}');
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp."));
    assert.equal(leftovers.length, 0);
    assert.ok(existsSync(target));
  });

  it("overwrites existing file atomically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcmcp-atomic-"));
    const target = join(dir, "x.txt");
    await atomicWriteFile(target, "first");
    await atomicWriteFile(target, "second");
    assert.equal(readFileSync(target, "utf8"), "second");
  });
});
