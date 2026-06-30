import test from "node:test";
import assert from "node:assert/strict";

// Same-package unit test: relative ../src import (resolved by tsx; sibling @agentprism/*
// deps it pulls in resolve to their built dist, which `pnpm test` builds first).
import { createAcpRunner, selectBackend } from "../src/index.js";

test("@agentprism/acp-agents public entry is reachable via ../src", () => {
  assert.equal(typeof createAcpRunner, "function");
  assert.equal(typeof selectBackend, "function");
});
