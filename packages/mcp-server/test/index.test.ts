import test from "node:test";
import assert from "node:assert/strict";

// Same-package unit test: relative ../src import. The composition-root entry is import-safe
// (it only starts the stdio server when run as the process entry point).
import { createWorkflowServer } from "../src/index.js";

test("@automatalabs/mcp-server public entry is reachable via ../src", () => {
  assert.equal(typeof createWorkflowServer, "function");
});
