import test from "node:test";
import assert from "node:assert/strict";

// Cross-package test: import the PUBLIC @agentprism/* entry (NOT a relative ../src path).
// The package "exports" map resolves this to ./dist/index.js, so `pnpm test` must build the
// workspace first. This proves the build-first path keeps cross-package tests green.
import { META_NS } from "@agentprism/shared-types";

test("cross-package import resolves the @agentprism/shared-types public entry", () => {
  assert.equal(META_NS, "agentprism");
});
