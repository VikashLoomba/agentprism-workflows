import test from "node:test";
import assert from "node:assert/strict";

// Same-package unit test: import internals relatively (../src/*.js), exactly like pi's
// tests/*.test.ts. tsx rewrites the .js specifier to the .ts source at run time.
import { META_KEYS } from "../src/index.js";

test("@automatalabs/shared-types public entry is reachable via ../src", () => {
  assert.equal(typeof META_KEYS, "object");
  // Keys are bare (un-namespaced), mirroring the target Codex param names.
  assert.equal(META_KEYS.outputSchema, "outputSchema");
  assert.equal(META_KEYS.runId, "runId");
});
