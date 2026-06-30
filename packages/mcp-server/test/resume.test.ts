import test from "node:test";
import assert from "node:assert/strict";

import { connect, countingRunner, structured, TWO_AGENT_SCRIPT } from "./_harness.js";

/** Read a nested field off an unknown (JSON-deserialized, possibly null-prototype) object. */
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** Assert a deserialized `{ a, b }` result regardless of its prototype. */
function assertAlphaBeta(result: unknown): void {
  assert.equal(field(result, "a"), "r:alpha:1", "agent[0] result carries the run-1 invocation counter");
  assert.equal(field(result, "b"), "r:beta:2", "agent[1] result carries the run-1 invocation counter");
}

test("resumeFromRunId loads the persisted journal and REPLAYS it (runner is not re-invoked)", async () => {
  // The same server == one WorkflowManager == one shared persistence, so a journal
  // written by the first call is loadable by the second. The counting runner is the
  // proof: on resume the engine replays cached results without calling run() again.
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    // ---- First run: two live agents, journaled under runId R1. ----
    const r1 = await client.callTool({ name: "workflow", arguments: { script: TWO_AGENT_SCRIPT } });
    const sc1 = structured(r1);
    assert.equal(r1.isError, false);
    assert.equal(sc1?.status, "completed");
    assert.equal(calls(), 2, "first run invokes the runner once per agent()");
    assertAlphaBeta(sc1?.result);
    const runId1 = String(sc1?.runId);
    assert.ok(runId1.length > 0);

    // ---- Resume from R1's journal: same script, so the whole prefix is cache-valid. ----
    const r2 = await client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_SCRIPT, resumeFromRunId: runId1 },
    });
    const sc2 = structured(r2);
    assert.equal(r2.isError, false);
    assert.equal(sc2?.status, "completed");
    assert.equal(calls(), 2, "resume REPLAYS the journal — the runner is NOT invoked again");
    // The replayed values are the journaled run-1 results (counter :1/:2), proving the
    // engine served the cache rather than re-executing (which would yield :3/:4).
    assertAlphaBeta(sc2?.result);
    assert.notEqual(String(sc2?.runId), runId1, "resume runs under a fresh engine run id");
  } finally {
    await dispose();
  }
});

test("resumeFromRunId for an unknown run finds no journal and runs fresh (no replay)", async () => {
  // Confirms the replay above came from the loaded journal: with no persisted journal to
  // load, the engine runs every agent() live, so the runner IS invoked.
  const { runner, calls } = countingRunner();
  const { client, dispose } = await connect(runner);
  try {
    const res = await client.callTool({
      name: "workflow",
      arguments: { script: TWO_AGENT_SCRIPT, resumeFromRunId: "no-such-run-id" },
    });
    const sc = structured(res);
    assert.equal(res.isError, false);
    assert.equal(sc?.status, "completed");
    assert.equal(calls(), 2, "an unknown resume id loads nothing — both agents run live");
    assertAlphaBeta(sc?.result);
  } finally {
    await dispose();
  }
});
