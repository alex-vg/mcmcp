import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "./rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it("allows calls when no limit configured", () => {
    const r = limiter.tryConsume("u1");
    assert.equal(r.allowed, true);
    assert.equal(r.requestsPerMinute, 0);
  });

  it("allows up to rpm requests immediately", () => {
    limiter.configure("u1", 3);
    for (let i = 0; i < 3; i++) {
      const r = limiter.tryConsume("u1");
      assert.equal(r.allowed, true, `call ${i} should be allowed`);
    }
  });

  it("rejects after bucket exhausted", () => {
    limiter.configure("u1", 2);
    limiter.tryConsume("u1"); // 1
    limiter.tryConsume("u1"); // 2
    const r = limiter.tryConsume("u1"); // over limit
    assert.equal(r.allowed, false);
    assert.equal(r.requestsPerMinute, 2);
    assert.ok(r.retryAfterSeconds > 0);
  });

  it("remove drops limit entirely", () => {
    limiter.configure("u1", 1);
    limiter.tryConsume("u1"); // exhaust
    limiter.remove("u1");
    const r = limiter.tryConsume("u1");
    assert.equal(r.allowed, true);
  });

  it("reconfigure resets bucket size but preserves tokens up to new rpm", () => {
    limiter.configure("u1", 10);
    // Reduce limit; tokens should be capped at new rpm
    limiter.configure("u1", 3);
    let allowed = 0;
    for (let i = 0; i < 3; i++) {
      if (limiter.tryConsume("u1").allowed) allowed++;
    }
    assert.equal(allowed, 3);
    assert.equal(limiter.tryConsume("u1").allowed, false);
  });

  it("independent limits per upstream", () => {
    limiter.configure("u1", 1);
    limiter.configure("u2", 5);
    limiter.tryConsume("u1"); // exhaust u1
    assert.equal(limiter.tryConsume("u1").allowed, false);
    assert.equal(limiter.tryConsume("u2").allowed, true); // u2 unaffected
  });
});
