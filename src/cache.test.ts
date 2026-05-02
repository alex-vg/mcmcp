import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ResultCache } from "./cache.js";
import type { CallToolResult } from "./proxy.js";

const HIT: CallToolResult = { content: [{ type: "text", text: "ok" }] };
const ERR: CallToolResult = { content: [{ type: "text", text: "fail" }], isError: true };

describe("ResultCache", () => {
  let cache: ResultCache;

  beforeEach(() => {
    cache = new ResultCache();
    cache.configure("u1", { enabled: true, ttlMs: 5_000, maxEntries: 5 });
  });

  it("basic set/get", () => {
    cache.set("u1", "tool", { x: 1 }, HIT);
    const hit = cache.get("u1", "tool", { x: 1 });
    assert.ok(hit);
    assert.deepEqual(hit.value, HIT);
    assert.ok(hit.ageMs >= 0);
  });

  it("key canonicalization: different object key order → same hit", () => {
    cache.set("u1", "tool", { a: 1, b: 2 }, HIT);
    const hit = cache.get("u1", "tool", { b: 2, a: 1 });
    assert.ok(hit, "should be a cache hit regardless of key order");
  });

  it("key canonicalization: nested objects also sorted", () => {
    cache.set("u1", "tool", { outer: { z: 9, a: 1 } }, HIT);
    const hit = cache.get("u1", "tool", { outer: { a: 1, z: 9 } });
    assert.ok(hit);
  });

  it("key canonicalization: array order is preserved (order matters for arrays)", () => {
    cache.set("u1", "tool", { arr: [1, 2] }, HIT);
    const miss = cache.get("u1", "tool", { arr: [2, 1] });
    assert.equal(miss, undefined, "different array order should be a cache miss");
  });

  it("miss for unknown tool", () => {
    assert.equal(cache.get("u1", "nope", {}), undefined);
  });

  it("does not cache error results", () => {
    cache.set("u1", "tool", {}, ERR);
    assert.equal(cache.get("u1", "tool", {}), undefined);
  });

  it("returns undefined for unknown upstream", () => {
    cache.set("u1", "tool", {}, HIT);
    assert.equal(cache.get("u2", "tool", {}), undefined);
  });

  it("TTL expiry", async () => {
    cache.configure("u1", { enabled: true, ttlMs: 1, maxEntries: 10 });
    cache.set("u1", "tool", {}, HIT);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(cache.get("u1", "tool", {}), undefined);
  });

  it("LRU eviction on overflow", () => {
    for (let i = 0; i < 5; i++) {
      cache.set("u1", "tool", { i }, HIT);
    }
    // maxEntries is 5; adding one more evicts the oldest
    cache.set("u1", "tool", { i: 99 }, HIT);
    assert.equal(cache.get("u1", "tool", { i: 0 }), undefined, "oldest entry should be evicted");
    assert.ok(cache.get("u1", "tool", { i: 99 }), "newest entry should still be present");
  });

  it("stats hit rate", () => {
    cache.set("u1", "tool", { x: 1 }, HIT);
    cache.get("u1", "tool", { x: 1 }); // hit
    cache.get("u1", "tool", { x: 2 }); // miss
    const stats = cache.stats("u1");
    assert.equal(stats.enabled, true);
    assert.equal(stats.hit_rate_pct, 50);
  });

  it("remove drops cache", () => {
    cache.set("u1", "tool", {}, HIT);
    cache.remove("u1");
    assert.equal(cache.get("u1", "tool", {}), undefined);
    assert.equal(cache.isEnabled("u1"), false);
  });

  it("disabled upstream returns false from isEnabled", () => {
    cache.configure("u1", { enabled: false, ttlMs: 5_000, maxEntries: 10 });
    assert.equal(cache.isEnabled("u1"), false);
  });
});
