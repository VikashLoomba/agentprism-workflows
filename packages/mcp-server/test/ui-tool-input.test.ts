import assert from "node:assert/strict";
import test from "node:test";
import { observedRunIdFromArgs } from "../ui/src/tool-input.js";

test("only explicit workflow_monitor input binds the existing run", () => {
  assert.equal(observedRunIdFromArgs({ runId: "run-a" }), "run-a");
  for (const args of [null, {}, { runId: "" }, { runId: "  " }, { runId: 42 }, { runId: " run-a" }, { action: "status", runId: "run-a" }, { action: "resume", runId: "run-a" }, { action: "run", script: "return 1" }, { action: "config" }]) {
    assert.equal(observedRunIdFromArgs(args), undefined, JSON.stringify(args));
  }
});
