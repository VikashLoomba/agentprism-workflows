import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JournalEntry } from "@automatalabs/shared-types";
import { assertExplicitCheckpointProvenance } from "../src/checkpoint-provenance.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { createReplayRunner } from "../src/isolation.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { runWorkflow } from "../src/workflow.js";

const script = `export const meta = { name: "explicit-checkpoint", description: "checkpoint provenance" }
const answer = await checkpoint("Approve?")
return answer`;
const noopAgent = { async run() { throw new Error("no agent work is expected"); } };

const incompatible = (error: unknown): boolean => error instanceof WorkflowError &&
  error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
  /checkpoint-provenance-incompatible.*fresh run/.test(error.message);

test("manual journal replay refuses an unmarked historical decision before any live work", async () => {
  const journal = new Map<number, JournalEntry>();
  await runWorkflow(script, {
    agent: noopAgent, persistLogs: false, confirm: async () => false,
    onAgentJournal: entry => journal.set(entry.index, structuredClone(entry)),
  });
  delete journal.get(0)!.checkpointDecision;
  let asked = false;
  await assert.rejects(runWorkflow(script, {
    agent: noopAgent, persistLogs: false, resumeJournal: journal,
    confirm: async () => { asked = true; return true; },
  }), incompatible);
  assert.equal(asked, false, "an incompatible source must not silently fall back to a fresh approval");
});

for (const source of [
  { journal: [{ kind: "checkpoint", result: true }] },
  { journal: [{ call: { kind: "checkpoint" }, result: false }] },
  { calls: [{ kind: "checkpoint", outcome: "result", origin: "confirm" }] },
  { calls: [{ kind: "checkpoint", outcome: "result", origin: "headless", checkpointDecision: "explicit-v1" }] },
  { calls: [{ kind: "checkpoint", outcome: "error", origin: "engine", checkpointDecision: "explicit-v1" }] },
  { resumeSeed: { candidates: [{ entry: { kind: "checkpoint", result: true } }] } },
  { resumeSeed: { candidates: [{ call: { kind: "checkpoint", outcome: "result", origin: "confirm" } }] } },
  { resumeSeed: { checkpointInjections: [{ decision: true }] } },
  { resumeSeed: { callBlockers: [{ call: { kind: "checkpoint", outcome: "error", origin: "headless" } }] } },
  { checkpointsTaken: [{ callIndex: 0, decision: true, source: "headless-default" }] },
  { checkpointsTaken: [{ callIndex: 0, decision: true }] },
  { checkpointContext: { default: false } },
  { checkpointContext: { headless: "pause" } },
]) {
  test(`execution provenance rejects ${JSON.stringify(source)}`, () => {
    assert.throws(() => assertExplicitCheckpointProvenance(source), incompatible);
  });
}

test("cold inspection remains available while same-run continuation and isolation refuse old approvals", async () => {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-provenance-"));
  try {
    const manager = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: noopAgent });
    const completed = await manager.runSync(script, undefined, { confirm: async () => true });
    assert.equal(completed.status, "completed");
    const original = manager.getPersistence().load(completed.runId)!;
    const recorded = structuredClone(original);
    delete recorded.journal![0].checkpointDecision;
    delete recorded.calls![0].checkpointDecision;
    // Historical data is retained, never repaired into a claimed explicit approval.
    recorded.status = "paused";
    recorded.pauseReason = "interrupted";
    manager.getPersistence().save(recorded);
    const cold = new WorkflowManager({ cwd: root, persistenceRoot: root, agent: noopAgent });
    assert.equal(cold.getPersistence().load(completed.runId)?.journal?.[0].result, true);
    await assert.rejects(cold.resumeInBackground(completed.runId), incompatible);
    assert.throws(() => createReplayRunner({
      recording: { ...recorded, status: "completed" }, inner: noopAgent, live: [], rootRunId: "isolation-target",
    }), incompatible);
    assert.equal(cold.getPersistence().load(completed.runId)?.journal?.[0].checkpointDecision, undefined);
    assert.doesNotThrow(() => assertExplicitCheckpointProvenance(original));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a callback resolving after its timeout cannot create a durable answer", async () => {
  let answer!: (value: unknown) => void;
  const journal: JournalEntry[] = [];
  const running = runWorkflow(script.replace('checkpoint("Approve?")', 'checkpoint("Approve?", { timeoutMs: 5 })'), {
    agent: noopAgent, persistLogs: false,
    confirm: () => new Promise(resolve => { answer = resolve; }),
    onAgentJournal: entry => journal.push(entry),
  });
  await assert.rejects(running, (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_REQUIRED);
  answer(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(journal, []);
});
