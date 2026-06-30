import test from "node:test";
import assert from "node:assert/strict";

// Same-package unit test: relative ../src import (resolved by tsx; sibling @automatalabs/*
// deps it pulls in resolve to their built dist, which `pnpm test` builds first).
import { MAX_AGENTS_PER_RUN, runWorkflow } from "../src/index.js";

test("@automatalabs/workflow-engine public entry is reachable via ../src", () => {
  assert.equal(typeof MAX_AGENTS_PER_RUN, "number");
  assert.equal(typeof runWorkflow, "function");
});
