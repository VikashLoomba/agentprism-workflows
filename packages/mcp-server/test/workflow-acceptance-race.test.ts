import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WorkflowProjectRegistry } from "../src/project-registry.js";
import { workflowLifecycle, workflowOperation } from "../src/workflow-lifecycle.js";
import { connectHttp, makeProjectDir, startDaemon, waitUntil } from "./_http-harness.js";
import { okRunner, structured, waitForRun } from "./_harness.js";

test("a concurrent acceptance winner cannot consume the retrying daemon's capacity", async () => {
  const runner = okRunner();
  const projectDir = makeProjectDir("acceptance-race");
  const winner = new WorkflowProjectRegistry(runner).getOrCreate(projectDir);
  const loser = new WorkflowProjectRegistry(runner).getOrCreate(projectDir);
  const winnerDriver = workflowLifecycle(winner, runner);
  const loserDriver = workflowLifecycle(loser, runner);
  const input = { action: "run" as const, requestId: randomUUID(), script:
    'export const meta = { name: "raced acceptance", description: "receipt ownership", backends: { custom: { command: "custom-acp" } } }; return 42;' };
  const originalFind = loser.manager.findAcceptedRun.bind(loser.manager);
  let interleaved = false;
  loser.manager.findAcceptedRun = (operation) => {
    const found = originalFind(operation);
    if (!interleaved) {
      interleaved = true;
      winnerDriver.accept(input);
    }
    return found;
  };
  const accepted = loserDriver.accept(input);
  try {
    assert.equal(accepted.duplicate, true);
    assert.equal(loser.activeRuns.activeCount(), 0, "a duplicate receipt does not create a local reservation or hold");
    assert.equal(loser.manager.getRun(accepted.runId), undefined);
    await waitUntil(() => winner.manager.getPersistence().load(accepted.runId)?.preparation?.state === "input-required", "winner setup");
    const setup = winner.manager.getPersistence().load(accepted.runId)!.preparation!.data.setup as { id: string };
    winnerDriver.respond({ action: "setup-response", runId: accepted.runId, setupId: setup.id,
      response: { action: "accept", content: { approve: true } } });
    await waitUntil(() => winner.manager.getPersistence().load(accepted.runId)?.status === "completed", "winner completion");
    assert.equal(loser.activeRuns.activeCount(), 0);
    assert.equal(winner.activeRuns.activeCount(), 0);
  } finally {
    winner.manager.stop(accepted.runId);
  }
});

test("status retries cold preparation after an occupied capacity slot becomes available", async () => {
  const runner = okRunner();
  const projectDir = makeProjectDir("cold-preparation-capacity");
  const old = new WorkflowProjectRegistry(runner).getOrCreate(projectDir);
  const input = { action: "run" as const, requestId: randomUUID(), script:
    'export const meta = { name: "cold preparation", description: "recover when capacity frees" }; return 42;' };
  const cold = old.manager.prepareRun(input.script, undefined, {
    operation: workflowOperation(input),
    preparation: { format: 1, state: "preparing", data: { approvedKeys: [], responses: {} }, responses: {} },
  });
  old.manager.getPersistence().releaseRunLease(old.manager.getRun(cold.runId)!.lease!);
  const daemon = await startDaemon(runner);
  const current = daemon.projects.getOrCreate(projectDir);
  const driver = workflowLifecycle(current, runner);
  const occupied = Array.from({ length: 4 }, () => driver.accept({ action: "run", requestId: randomUUID(), script:
    'export const meta = { name: "waiting setup", description: "occupy capacity", backends: { custom: { command: "custom-acp" } } }; return 1;' }).runId);
  const connection = await connectHttp(daemon.url, { listTools: true });
  try {
    await waitUntil(() => occupied.every((runId) => current.manager.getPersistence().load(runId)?.preparation?.state === "input-required"), "occupied setup slots");
    const pending = await connection.client.callTool({ name: "workflow", arguments: { action: "status", runId: cold.runId } });
    assert.deepEqual(structured(pending)?.setup, { state: "preparing" });
    assert.equal(current.manager.getRun(cold.runId), undefined);
    assert.equal(current.activeRuns.activeCount(), 4);
    await connection.client.callTool({ name: "workflow", arguments: { action: "stop", runId: occupied[0]! } });
    const completed = await waitForRun(connection.client, cold.runId);
    assert.equal(structured(completed)?.status, "completed");
    assert.equal((structured(completed)?.outcome as { result: unknown }).result, 42);
    assert.equal(current.activeRuns.activeCount(), 3);
  } finally {
    for (const runId of occupied) current.manager.stop(runId);
    current.manager.stop(cold.runId);
    await connection.dispose();
    await daemon.close();
  }
});
