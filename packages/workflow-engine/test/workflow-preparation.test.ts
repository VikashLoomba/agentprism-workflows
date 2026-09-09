import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner } from "@automatalabs/shared-types";
import { createRunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { WorkflowErrorCode } from "../src/errors.js";
import {
  MAX_WORKFLOW_CONTINUATION_OPERATIONS,
  MAX_WORKFLOW_PREPARATION_BYTES,
  type WorkflowOperationIdentity,
  type WorkflowPreparation,
} from "../src/workflow-preparation.js";

const script = (body: string) => `export const meta = { name: 'Prepared workflow', description: 'Durable setup' }\n${body}`;
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const operation = (value = randomUUID()): WorkflowOperationIdentity => ({ id: value, fingerprint: fingerprint(value) });
const preparing = (data: Record<string, unknown> = {}): WorkflowPreparation => ({ format: 1, state: "preparing", data });
const runner: AgentRunner = { async run() { return "unused"; } };

async function inStore(fn: (paths: { cwd: string; persistenceRoot: string }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "workflow-preparation-"));
  try {
    await fn({ cwd: root, persistenceRoot: join(root, "storage") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("acceptance persists frozen source, args, operation and empty events before any live execution", async () => {
  await inStore(async (paths) => {
    let liveCalls = 0;
    const manager = new WorkflowManager({ ...paths, agent: { async run(prompt) { liveCalls++; return prompt; } } });
    const request = operation();
    const args = { message: "accepted" };
    const metadata = { stage: "validation" };
    const source = script(`return await agent(args.message, { model: 'fixture' })`);
    const accepted = manager.prepareRun(source, args, { operation: request, preparation: preparing(metadata) });
    args.message = "changed after acceptance";
    metadata.stage = "changed after acceptance";
    assert.equal(accepted.created, true);
    assert.equal(liveCalls, 0);
    assert.equal(manager.activeExecutionCount(), 1);
    const stored = manager.getPersistence().load(accepted.runId)!;
    assert.equal(stored.status, "pending");
    assert.equal(stored.script, source);
    assert.deepEqual(stored.args, { message: "accepted" });
    assert.equal(stored.preparation?.data.stage, "validation");
    assert.equal(stored.preparationRevision, 0);
    assert.equal(stored.admission, undefined);
    assert.deepEqual(stored.acceptanceOperation, request);
    assert.deepEqual(manager.getPersistence().readEvents(accepted.runId).events, []);
    assert.equal(manager.inspectRun(accepted.runId)?.status, "pending");
    assert.equal(manager.inspectRun(accepted.runId)?.runId, accepted.runId, "public redaction must preserve the opaque run ID");

    const started = manager.admitPreparedRun(accepted.runId, {
      agentConfigurations: { 0: { model: "fixture" } }, requireAgentConfiguration: true,
    });
    const result = await started.promise;
    assert.equal(started.runId, accepted.runId);
    assert.equal(result.result, "accepted");
    assert.equal(liveCalls, 1);
    const completed = manager.getPersistence().load(accepted.runId)!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.admission?.format, 2);
    assert.equal(completed.preparation, undefined);
    assert.deepEqual(completed.acceptanceOperation, request);
    assert.equal(manager.activeExecutionCount(), 0);
  });
});

test("identical acceptance retries from another manager recover one run and conflicting input fails", async () => {
  await inStore(async (paths) => {
    const first = new WorkflowManager({ ...paths, agent: runner });
    const second = new WorkflowManager({ ...paths, agent: runner });
    const request = operation();
    const source = script("return 1");
    const accepted = first.prepareRun(source, undefined, { operation: request, preparation: preparing() });
    assert.equal(second.findAcceptedRun(request)?.runId, accepted.runId);
    // A host uses findAcceptedRun before rereading a scriptPath. prepareRun also treats source
    // parameters on a recovered operation as irrelevant: accepted bytes already own the identity.
    assert.deepEqual(second.prepareRun("changed file", undefined, {
      operation: request, preparation: preparing(),
    }), { runId: accepted.runId, created: false });
    assert.equal(second.claimPreparedRun(accepted.runId), undefined);
    assert.equal(first.getPersistence().list().length, 1);
    assert.throws(() => second.findAcceptedRun({ ...request, fingerprint: fingerprint("different") }), /operation conflict/);
    assert.equal(first.stop(accepted.runId), true);
  });
});

test("concurrent processes publish one acceptance identity, including recovery after both responses are lost", async () => {
  await inStore(async (paths) => {
    const request = operation();
    const code = `
      import { WorkflowManager } from ${JSON.stringify(new URL("../src/workflow-manager.ts", import.meta.url).href)};
      const manager = new WorkflowManager(${JSON.stringify(paths)});
      try {
        const result = manager.prepareRun(${JSON.stringify(script("return 1"))}, undefined, ${JSON.stringify({ operation: request, preparation: preparing() })});
        process.stdout.write(JSON.stringify(result));
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: error.message }));
      }
    `;
    const launch = () => new Promise<{ runId?: string; created?: boolean; error?: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { errors += chunk; });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        if (exitCode !== 0) reject(new Error(errors));
        else {
          try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
        }
      });
    });
    const responses = await Promise.all([launch(), launch()]);
    assert.equal(responses.filter((response) => response.created).length, 1);
    for (const response of responses) {
      if (response.error) assert.match(response.error, /owned elsewhere/);
    }
    const manager = new WorkflowManager({ ...paths, agent: runner });
    const recovered = manager.findAcceptedRun(request)!;
    assert.equal(recovered.status, "pending");
    assert.equal(manager.getPersistence().list().length, 1);
    assert.deepEqual(manager.prepareRun("must not replace accepted source", undefined, {
      operation: request, preparation: preparing(),
    }), { runId: recovered.runId, created: false });
    assert.equal(manager.claimPreparedRun(recovered.runId)?.status, "pending");
    manager.stop(recovered.runId);
  });
});

test("pending setup survives cold restore and old owner cannot overwrite the claimed revision", async () => {
  await inStore(async (paths) => {
    const first = new WorkflowManager({ ...paths, agent: runner });
    const accepted = first.prepareRun(script("return 7"), undefined, {
      operation: operation(), preparation: { format: 1, state: "input-required", data: { requestId: "setup-one", question: "Choose" } },
    });
    const oldLease = first.getRun(accepted.runId)!.lease!;
    first.getPersistence().releaseRunLease(oldLease);
    const cold = new WorkflowManager({ ...paths, agent: runner });
    assert.equal(cold.inspectRun(accepted.runId)?.status, "pending");
    const restored = cold.claimPreparedRun(accepted.runId)!;
    assert.equal(restored.preparation?.state, "input-required");
    assert.equal(restored.preparation?.data.question, "Choose");
    assert.equal(cold.activeExecutionCount(), 1);
    assert.throws(() => first.updatePreparation(accepted.runId, preparing({ corrupted: true })), /not owned pending/);
    cold.updatePreparation(accepted.runId, preparing({ approved: true }), 0);
    assert.throws(() => cold.updatePreparation(accepted.runId, preparing(), 0), /preparation changed/);
    const result = await cold.admitPreparedRun(accepted.runId, {
      requireAgentConfiguration: true, agentConfigurations: {},
    }).promise;
    assert.equal(result.result, 7);
  });
});

test("response receipts survive admission, settlement and cold reads; conflicts never replace answers", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    for (const terminal of ["completed", "aborted"] as const) {
      const accepted = manager.prepareRun(script("return 8"), undefined, { operation: operation(), preparation: preparing() });
      const receipt = fingerprint("approved");
      manager.updatePreparation(accepted.runId, { ...preparing(), responses: { "setup-one": receipt } }, 0);
      assert.throws(() => manager.updatePreparation(accepted.runId, {
        ...preparing(), responses: { "setup-one": fingerprint("declined") },
      }, 1), /response conflict/);
      manager.updatePreparation(accepted.runId, preparing({ next: true }), 1);
      if (terminal === "completed") {
        await manager.admitPreparedRun(accepted.runId, { requireAgentConfiguration: true, agentConfigurations: {} }).promise;
      } else {
        manager.settlePreparedRun(accepted.runId, "aborted", "User declined setup");
      }
      const cold = new WorkflowManager({ ...paths, agent: runner });
      assert.equal(cold.getPersistence().load(accepted.runId)?.setupResponses?.["setup-one"], receipt);
      assert.equal(cold.inspectRun(accepted.runId)?.status, terminal);
    }
  });
});

test("initial save and canonical-admission save failures cannot acknowledge or execute unpersisted work", async () => {
  await inStore(async (paths) => {
    const disk = createRunPersistence(paths.cwd, undefined, { persistenceRoot: paths.persistenceRoot });
    let reject: "initial" | "admission" | undefined = "initial";
    let calls = 0;
    const manager = new WorkflowManager({
      ...paths,
      agent: { async run() { calls++; return "done"; } },
      persistence: {
        ...disk,
        save(state) {
          if (reject === "initial" || (reject === "admission" && state.status === "running")) throw new Error("disk unavailable");
          disk.save(state);
        },
      },
    });
    const request = operation();
    const source = script("return await agent('work', { model: 'fixture' })");
    assert.throws(() => manager.prepareRun(source, undefined, { operation: request, preparation: preparing() }), /failed to persist/);
    assert.equal(manager.findAcceptedRun(request), undefined);
    assert.equal(manager.activeExecutionCount(), 0);
    reject = undefined;
    const accepted = manager.prepareRun(source, undefined, { operation: request, preparation: preparing() });
    reject = "admission";
    assert.throws(() => manager.admitPreparedRun(accepted.runId, {
      requireAgentConfiguration: true, agentConfigurations: { 0: { model: "fixture" } },
    }), /failed to persist/);
    assert.equal(manager.getRun(accepted.runId)?.status, "pending");
    assert.equal(disk.load(accepted.runId)?.status, "pending");
    assert.equal(disk.load(accepted.runId)?.admission, undefined);
    assert.equal(calls, 0);
    reject = undefined;
    assert.equal(manager.settlePreparedRun(accepted.runId, "failed", "Canonical admission could not be persisted"), true);
    assert.equal(disk.load(accepted.runId)?.status, "failed");
    assert.equal(disk.readEvents(accepted.runId).events.at(-1)?.event.type, "error");
  });
});

test("terminal setup responses and abort state commit atomically and failed saves remain retryable", async () => {
  await inStore(async (paths) => {
    const disk = createRunPersistence(paths.cwd, undefined, { persistenceRoot: paths.persistenceRoot });
    let rejectTerminal = true;
    const committed: Array<{ status: string; receipt?: string }> = [];
    const manager = new WorkflowManager({ ...paths, agent: runner, persistence: {
      ...disk,
      save(state) {
        if (rejectTerminal && state.status === "aborted") throw new Error("terminal disk unavailable");
        disk.save(state);
        committed.push({ status: state.status, receipt: state.setupResponses?.["setup-one"] });
      },
    } });
    const accepted = manager.prepareRun(script("return 1"), undefined, {
      operation: operation(), preparation: { format: 1, state: "input-required", data: { question: "Approve?" } },
    });
    const receipt = fingerprint("declined");
    const response = { responses: { "setup-one": receipt }, expectedRevision: 0 };
    assert.throws(() => manager.settlePreparedRun(accepted.runId, "aborted", "Declined", response), /failed to persist/);
    const pending = disk.load(accepted.runId)!;
    assert.equal(pending.status, "pending");
    assert.equal(pending.preparation?.state, "input-required");
    assert.equal(pending.setupResponses?.["setup-one"], undefined);
    assert.equal(manager.getRun(accepted.runId)?.setupResponses?.["setup-one"], undefined);
    assert.equal(manager.getRun(accepted.runId)?.controller.signal.aborted, false);
    assert.equal(disk.readEvents(accepted.runId).events.length, 0);

    assert.throws(() => manager.settlePreparedRun(accepted.runId, "aborted", "Stale", {
      ...response, expectedRevision: 1,
    }), /preparation changed/);
    rejectTerminal = false;
    assert.equal(manager.settlePreparedRun(accepted.runId, "aborted", "Declined", response), true);
    const cold = new WorkflowManager({ ...paths, agent: runner });
    const terminal = cold.getPersistence().load(accepted.runId)!;
    assert.equal(terminal.status, "aborted");
    assert.equal(terminal.setupResponses?.["setup-one"], receipt);
    assert.ok(committed.every(state => state.receipt === undefined || state.status === "aborted"));
    assert.equal(disk.readEvents(accepted.runId).events.filter(row => row.event.type === "stopped").length, 1);
    assert.equal(cold.claimPreparedRun(accepted.runId), undefined);
  });
});

test("invalid accepted source becomes inspectable failed setup; stop and delete cannot be resurrected", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    const request = operation();
    const invalid = manager.prepareRun("this is not workflow JavaScript", undefined, { operation: request, preparation: preparing() });
    assert.equal(manager.getPersistence().load(invalid.runId)?.status, "pending");
    assert.throws(() => manager.admitPreparedRun(invalid.runId, { requireAgentConfiguration: true, agentConfigurations: {} }));
    assert.equal(manager.settlePreparedRun(invalid.runId, "failed", "Workflow static validation failed"), true);
    assert.match(manager.inspectRun(invalid.runId)?.reason ?? "", /static validation failed/);
    assert.equal(manager.deleteRun(invalid.runId), true);
    assert.throws(() => manager.findAcceptedRun(request), /deleted run/);
    assert.throws(() => manager.prepareRun(script("return 9"), undefined, { operation: request, preparation: preparing() }), /deleted run/);

    const pending = manager.prepareRun(script("return 9"), undefined, { operation: operation(), preparation: preparing() });
    assert.equal(manager.stop(pending.runId), true);
    assert.equal(manager.getPersistence().load(pending.runId)?.status, "aborted");
    assert.equal(manager.getPersistence().readEvents(pending.runId).events.at(-1)?.event.type, "stopped");
    assert.throws(() => manager.updatePreparation(pending.runId, preparing()), /not owned pending/);
    assert.throws(() => manager.admitPreparedRun(pending.runId, { requireAgentConfiguration: true, agentConfigurations: {} }), /not owned pending/);
  });
});

test("corrupt acceptance records fail closed instead of recovering stale setup or recreating work", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    for (const withBackup of [false, true]) {
      const request = operation();
      const accepted = manager.prepareRun(script("return 1"), undefined, { operation: request, preparation: preparing() });
      if (withBackup) manager.updatePreparation(accepted.runId, preparing({ validated: true }), 0);
      writeFileSync(join(manager.getPersistence().getRunsDir(), `${accepted.runId}.json`), "{ corrupt");
      assert.throws(() => manager.findAcceptedRun(request), withBackup ? /older backup/ : /unreadable/);
      assert.throws(() => manager.prepareRun(script("return 'changed'"), undefined, { operation: request, preparation: preparing() }), /unreadable/);
    }
  });
});

test("continuation operation and explicit checkpoint reply commit together, and retries cannot start later generations", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    const accepted = manager.prepareRun(script("const a = await checkpoint('First'); const b = await checkpoint('Second'); return [a,b]"), undefined, {
      operation: operation(), preparation: preparing(),
    });
    await assert.rejects(manager.admitPreparedRun(accepted.runId, { requireAgentConfiguration: true, agentConfigurations: {} }).promise,
      (error: unknown) => (error as { code?: string }).code === WorkflowErrorCode.CHECKPOINT_REQUIRED);
    const firstOperation = operation();
    const first = await manager.continueRun(accepted.runId, { operation: firstOperation, checkpointReplies: { 0: true } });
    assert.equal(first.accepted, true);
    if (!first.accepted) assert.fail("first reply should be accepted");
    assert.equal(first.continuation.generation, 1);
    await assert.rejects(first.promise, /Second/);
    const paused = manager.getPersistence().load(accepted.runId)!;
    assert.equal(paused.status, "paused");
    assert.equal(paused.checkpointContext?.callIndex, 1);
    assert.equal(paused.journal?.find((entry) => entry.index === 0)?.checkpointDecision, "explicit-v1");
    assert.equal(paused.calls?.find((entry) => entry.index === 0)?.checkpointDecision, "explicit-v1");
    assert.deepEqual(paused.continuationOperations?.[0].id, firstOperation.id);

    const cold = new WorkflowManager({ ...paths, agent: runner });
    const duplicate = await cold.continueRun(accepted.runId, { operation: firstOperation, checkpointReplies: { 0: true } });
    assert.equal(duplicate.accepted, true);
    if (!duplicate.accepted) assert.fail("accepted operation should be recoverable");
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.continuation.generation, 1);
    assert.equal((await duplicate.promise).status, "paused");
    assert.equal(cold.getRun(accepted.runId), undefined);
    assert.equal(cold.getPersistence().load(accepted.runId)?.continuation?.generation, 1);
    await assert.rejects(cold.continueRun(accepted.runId, {
      operation: { ...firstOperation, fingerprint: fingerprint("changed") }, checkpointReplies: { 1: true },
    }), /operation conflict/);

    const second = await cold.continueRun(accepted.runId, { operation: operation(), checkpointReplies: { 1: false } });
    if (!second.accepted) assert.fail("new explicit answer should continue");
    assert.deepEqual(Array.from((await second.promise).result as boolean[]), [true, false]);
    assert.equal(cold.getPersistence().load(accepted.runId)?.continuation?.generation, 2);
    const late = await manager.continueRun(accepted.runId, { operation: firstOperation, checkpointReplies: { 0: true } });
    if (!late.accepted) assert.fail("historical operation should remain recoverable");
    assert.equal(late.duplicate, true);
    assert.equal(late.continuation.generation, 1);
    assert.deepEqual((await late.promise).result, [true, false]);
  });
});

test("failed continuation save preserves the unanswered checkpoint and leaves retry identity available", async () => {
  await inStore(async (paths) => {
    const disk = createRunPersistence(paths.cwd, undefined, { persistenceRoot: paths.persistenceRoot });
    let denyContinuation = false;
    const manager = new WorkflowManager({ ...paths, agent: runner, persistence: {
      ...disk,
      save(state) {
        if (denyContinuation && state.continuation) throw new Error("continuation save failed");
        disk.save(state);
      },
    } });
    const accepted = manager.prepareRun(script("return await checkpoint('Confirm')"), undefined, { operation: operation(), preparation: preparing() });
    await assert.rejects(manager.admitPreparedRun(accepted.runId, { requireAgentConfiguration: true, agentConfigurations: {} }).promise);
    const request = operation();
    denyContinuation = true;
    await assert.rejects(manager.continueRun(accepted.runId, { operation: request, checkpointReplies: { 0: true } }), /failed to persist/);
    assert.equal(disk.load(accepted.runId)?.status, "paused");
    assert.equal(disk.load(accepted.runId)?.continuationOperations, undefined);
    assert.equal(disk.load(accepted.runId)?.journal?.length, 0);
    denyContinuation = false;
    const retried = await manager.continueRun(accepted.runId, { operation: request, checkpointReplies: { 0: true } });
    if (!retried.accepted) assert.fail("failed save did not consume the operation identity");
    assert.equal(retried.duplicate, undefined);
    assert.equal((await retried.promise).result, true);
  });
});

test("setup data and continuation history have finite non-evicting limits", async () => {
  await inStore(async (paths) => {
    const manager = new WorkflowManager({ ...paths, agent: runner });
    assert.throws(() => manager.prepareRun(script("return 1"), undefined, {
      operation: operation(), preparation: preparing({ oversized: "x".repeat(MAX_WORKFLOW_PREPARATION_BYTES) }),
    }), /preparation exceeds/);
    const accepted = manager.prepareRun(script("return await checkpoint('Confirm')"), undefined, { operation: operation(), preparation: preparing() });
    await assert.rejects(manager.admitPreparedRun(accepted.runId, { requireAgentConfiguration: true, agentConfigurations: {} }).promise);
    const persisted = manager.getPersistence().load(accepted.runId)!;
    persisted.continuationOperations = Array.from({ length: MAX_WORKFLOW_CONTINUATION_OPERATIONS }, (_, index) => ({
      ...operation(`older-${index}`), acceptedAt: new Date().toISOString(), continuation: { generation: index + 1, replayedPrefix: 0 },
    }));
    manager.getPersistence().save(persisted);
    await assert.rejects(manager.continueRun(accepted.runId, { operation: operation(), checkpointReplies: { 0: true } }), /operation limit/);
    assert.equal(manager.getPersistence().load(accepted.runId)?.continuationOperations?.length, MAX_WORKFLOW_CONTINUATION_OPERATIONS);
    assert.equal(manager.getPersistence().load(accepted.runId)?.status, "paused");
  });
});
