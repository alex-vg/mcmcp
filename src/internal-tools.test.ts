import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  INTERNAL_TOOL_DEFS,
  filterInternalToolsForPolicy,
} from "./internal-tools.js";

describe("filterInternalToolsForPolicy", () => {
  it("returns full set when readonly is false/undefined", () => {
    const all = filterInternalToolsForPolicy(INTERNAL_TOOL_DEFS, {});
    assert.equal(all.length, INTERNAL_TOOL_DEFS.length);
  });

  it("drops operator tools in readonly mode", () => {
    const ro = filterInternalToolsForPolicy(INTERNAL_TOOL_DEFS, { readonly: true });
    for (const t of ro) {
      assert.equal(t.category, "observer", `tool '${t.name}' should be observer`);
    }
    const operators = INTERNAL_TOOL_DEFS.filter((d) => d.category === "operator");
    assert.equal(ro.length, INTERNAL_TOOL_DEFS.length - operators.length);
  });
});
