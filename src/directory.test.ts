/**
 * Unit tests for {@link buildDirectorySnapshot}. Uses Node's built-in
 * test runner — no Jest, no Vitest, no mocking.
 *
 * Run with: `node --test --import tsx dist/directory.test.js`
 * (or `npx tsx --test src/directory.test.ts`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDirectorySnapshot,
  type DirectoryToolEntry,
  type DirectoryUpstreamEntry,
} from "./directory.js";

const THRESHOLDS = { tierOneMaxTools: 30, tierTwoMaxServers: 30 };

function tools(spec: Record<string, number | string[]>): DirectoryToolEntry[] {
  const out: DirectoryToolEntry[] = [];
  for (const [upstreamId, v] of Object.entries(spec)) {
    if (typeof v === "number") {
      for (let i = 0; i < v; i++) out.push({ name: `${upstreamId}_t${i}`, upstreamId });
    } else {
      for (const name of v) out.push({ name, upstreamId });
    }
  }
  return out;
}

function ups(...ids: string[]): DirectoryUpstreamEntry[] {
  return ids.map((id) => ({ id, connected: true }));
}

test("Tier 1: 29 tools across 3 upstreams → tier=full, all names present", () => {
  const t = tools({ a: 10, b: 10, c: 9 });
  const s = buildDirectorySnapshot(t, ups("a", "b", "c"), THRESHOLDS);
  assert.equal(s.tier, "full");
  assert.equal(s.truncated, false);
  for (const tool of t) assert.ok(s.content.includes(tool.name), `missing ${tool.name}`);
});

test("Tier 1 boundary: exactly 30 tools → tier=full", () => {
  const t = tools({ a: 30 });
  const s = buildDirectorySnapshot(t, ups("a"), THRESHOLDS);
  assert.equal(s.tier, "full");
});

test("Tier 2: 31 tools across 4 upstreams → tier=servers, sorted desc, no tool names", () => {
  const t = tools({ a: 5, b: 15, c: 8, d: 3 });
  const s = buildDirectorySnapshot(t, ups("a", "b", "c", "d"), THRESHOLDS);
  assert.equal(s.tier, "servers");
  assert.equal(s.truncated, false);
  // No tool names leak into the rendered content.
  for (const tool of t) assert.ok(!s.content.includes(tool.name), `leaked ${tool.name}`);
  // Order: b(15) > c(8) > a(5) > d(3). Use line-anchored matching.
  const serverLines = s.content
    .split("\n")
    .filter((l) => /^\s+[a-z]\s+-\s+\d+ tools$/.test(l))
    .map((l) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(serverLines, ["b", "c", "a", "d"]);
});

test("Tier 2: 150 tools, 30 upstreams → tier=servers, not truncated (at threshold)", () => {
  const spec: Record<string, number> = {};
  for (let i = 0; i < 30; i++) spec[`s${i}`] = 5;
  const t = tools(spec);
  const s = buildDirectorySnapshot(t, ups(...Object.keys(spec)), THRESHOLDS);
  assert.equal(s.tier, "servers");
  assert.equal(s.truncated, false);
});

test("Tier 3: 150 tools, 31 upstreams → tier=paginated, truncated, exactly 30 shown, hint", () => {
  const spec: Record<string, number> = {};
  for (let i = 0; i < 31; i++) spec[`srv${String(i).padStart(2, "0")}`] = 5;
  // Make srv00 the largest so we can assert ordering.
  spec.srv00 = 50;
  const t = tools(spec);
  const s = buildDirectorySnapshot(t, ups(...Object.keys(spec)), THRESHOLDS);
  assert.equal(s.tier, "paginated");
  assert.equal(s.truncated, true);
  assert.ok(s.hint && s.hint.length > 0);
  assert.match(s.content, /\(1 more server\)/);
  assert.ok(s.content.includes("srv00")); // largest must be listed
});

test("Disconnected upstream → WARNING line present", () => {
  const t = tools({ a: 2, b: 3 });
  const upstreams: DirectoryUpstreamEntry[] = [
    { id: "a", connected: true },
    { id: "b", connected: false },
  ];
  const s = buildDirectorySnapshot(t, upstreams, THRESHOLDS);
  assert.match(s.content, /WARNING: 1 server\(s\) unreachable/);
});

test("Empty upstreams: 0 tools → tier=full, graceful output", () => {
  const s = buildDirectorySnapshot([], [], THRESHOLDS);
  assert.equal(s.tier, "full");
  assert.equal(s.totalTools, 0);
  assert.equal(s.totalServers, 0);
  assert.match(s.content, /AVAILABLE TOOLS \(0 total/);
});

test("Tool name wrapping: long names wrap, no name truncated", () => {
  const longNames = Array.from({ length: 15 }, (_, i) => `very_long_tool_name_${i}`);
  const t: DirectoryToolEntry[] = longNames.map((name) => ({ name, upstreamId: "fs" }));
  const s = buildDirectorySnapshot(t, ups("fs"), THRESHOLDS);
  assert.equal(s.tier, "full");
  // Every name appears verbatim.
  for (const n of longNames) assert.ok(s.content.includes(n), `missing ${n}`);
  // The rendered block contains more than one line for the fs upstream.
  const fsBlock = s.content.split("\n").filter((l) => l.includes("very_long_tool_name_"));
  assert.ok(fsBlock.length >= 2, `expected wrapping, got ${fsBlock.length} line(s)`);
});
