import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CheckpointContext } from "@automatalabs/shared-types";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunPersistence } from "../src/run-persistence.js";
import { projectRunEventForPersistence } from "../src/run-observability.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

const DURABLE_PROMPT = "Choose release action";
const DURABLE_CHOICES = ["ship", "hold"];
const DURABLE_SCRIPT = `export const meta = { name: 'durable-checkpoint', description: 'durable checkpoint' }
const prefix = await agent('before', { label: 'before' })
const decision = await checkpoint('${DURABLE_PROMPT}', {
  kind: 'select',
  choices: ['ship', 'hold'],
})
const after = await agent('after:' + decision, { label: 'after' })
return { prefix, decision, after }`;

function memoryPersistence(): { persistence: RunPersistence; saves: PersistedRunState[] } {
  const states = new Map<string, PersistedRunState>();
  const saves: PersistedRunState[] = [];
  const clone = (state: PersistedRunState): PersistedRunState => structuredClone(state);
  return {
    saves,
    persistence: {
      save(state) {
        const copy = clone(state);
        saves.push(copy);
        states.set(copy.runId, copy);
      },
      load(runId) {
        const state = states.get(runId);
        return state ? clone(state) : null;
      },
      list() {
        return [...states.values()].map(clone);
      },
      delete(runId) {
        return states.delete(runId);
      },
      acquireRunLease(runId) {
        return { runId, token: `${runId}-lease` };
      },
      releaseRunLease() {},
      getRunsDir() {
        return "/memory/runs";
      },
    },
  };
}

function recordingAgent() {
  const prompts: string[] = [];
  return {
    prompts,
    runner: {
      async run(prompt: string) {
        prompts.push(prompt);
        return `agent:${prompt}`;
      },
    },
  };
}

function withTempPersistenceRoot(fn: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "agentprism-durable-checkpoint-"));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function withTempPersistenceDirs(fn: (root: string, cwd: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "agentprism-durable-checkpoint-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "agentprism-durable-checkpoint-cwd-"));
    try {
      await fn(root, cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

for (const retired of [{ headless: "default" }, { headless: "abort" }, { headless: "pause" }, { default: true }, { default: false }]) {
  test(`checkpoint(): rejects retired options ${JSON.stringify(retired)} before asking`, async () => {
    let asks = 0;
    await assert.rejects(runWorkflow(`export const meta = { name: 'c', description: 'checkpoint' }
return await checkpoint('Approve?', ${JSON.stringify(retired)})`, {
      agent: noopAgent, persistLogs: false, confirm: async () => { asks++; return true; },
    }), (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
    assert.equal(asks, 0);
  });
}

for (const answer of [false, null, "", 0, { approved: true }]) {
  test(`checkpoint(): preserves the explicit answer ${JSON.stringify(answer)}`, async () => {
    const journal: JournalEntry[] = [];
    const result = await runWorkflow(`export const meta = { name: 'c', description: 'checkpoint' }
return await checkpoint('Proceed?')`, {
      agent: noopAgent, persistLogs: false, confirm: async () => answer,
      onAgentJournal: entry => journal.push(entry),
    });
    assert.deepEqual(result.result, answer);
    assert.equal(journal[0].checkpointDecision, "explicit-v1");
    assert.equal(result.calls?.[0].checkpointDecision, "explicit-v1");
    assert.equal(result.checkpointsTaken?.[0].source, "live");
  });
}

for (const channel of ["absent", "undefined", "rejected", "timeout"] as const) {
  test(`checkpoint(): ${channel} answer channel pauses even when the script catches`, async () => {
    let dispatched = 0;
    const journal: JournalEntry[] = [];
    const confirm = channel === "absent" ? undefined : channel === "undefined" ? async () => undefined
      : channel === "rejected" ? async () => { throw new Error("panel dismissed"); }
      : () => new Promise<unknown>(() => {});
    await assert.rejects(runWorkflow(`export const meta = { name: 'c', description: 'checkpoint' }
try { await checkpoint('Proceed?', { timeoutMs: 10 }) } catch {}
try { await agent('must not run') } catch {}
return 'must not complete'`, {
      agent: { async run() { dispatched++; return "unsafe"; } }, persistLogs: false, confirm,
      onAgentJournal: entry => journal.push(entry),
    }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.CHECKPOINT_REQUIRED);
      assert.equal(error.checkpointContext?.prompt, "Proceed?");
      assert.equal(error.checkpointContext?.timeoutMs, 10);
      assert.equal(Object.hasOwn(error.checkpointContext!, "default"), false);
      return true;
    });
    assert.equal(dispatched, 0);
    assert.deepEqual(journal, []);
  });
}

test("checkpoint-only completion reports zero agents while retaining its separate call count", async () => {
  const result = await runWorkflow(`export const meta = { name: "checkpoint-count", description: "no agent work" };
return await checkpoint("Continue?");`, { agent: noopAgent, persistLogs: false, confirm: async () => true });
  assert.equal(result.agentCount, 0);
  assert.equal(result.calls?.length, 1);
  const persisted = projectRunEventForPersistence({
    type: "complete", runId: result.runId, scope: result.runId, result: { ...result, status: "completed" },
  });
  assert.equal(persisted.event.type, "complete");
  if (persisted.event.type !== "complete") assert.fail("expected completion summary");
  assert.equal(persisted.event.summary.agentCount, 0);
  assert.equal(persisted.event.summary.callCount, 1);
});

test("checkpoint(): explicit cancellation interrupts an unanswered SDK callback", async () => {
  const controller = new AbortController();
  let opened!: () => void;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  const running = runWorkflow(`export const meta = { name: 'c', description: 'checkpoint' }
return await checkpoint('Proceed?')`, {
    agent: noopAgent, persistLogs: false, signal: controller.signal,
    confirm: () => { opened(); return new Promise(() => {}); },
  });
  await ready;
  controller.abort();
  await assert.rejects(running, (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED);
});

for (const [label, invalidReply] of [
  ["function", () => () => true],
  ["non-finite number", () => Number.NaN],
  ["undefined property", () => ({ approved: undefined })],
  ["cyclic object", () => { const value: { self?: unknown } = {}; value.self = value; return value; }],
] as const) {
  test(`checkpoint(): invalid ${label} reply cannot be caught to bypass and can resume cold`, withTempPersistenceDirs(async (persistenceRoot, cwd) => {
    let dispatched = 0;
    const runner = { async run() { dispatched++; return "done"; } };
    const script = `export const meta = { name: "invalid-checkpoint-answer", description: "must wait for valid JSON" };
let answer;
try { answer = await checkpoint("Approve?"); } catch {}
try { await agent("after explicit answer"); } catch {}
return answer;`;
    const first = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
    const paused = await first.runSync(script, undefined, { confirm: async () => invalidReply() });
    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "checkpoint_required");
    assert.equal(paused.checkpointContext?.callIndex, 0);
    assert.equal(dispatched, 0, "invalid confirmation cannot authorize later live work");
    const persisted = first.getPersistence().load(paused.runId)!;
    assert.deepEqual(persisted.journal, []);
    assert.equal(persisted.calls?.[0].checkpointDecision, undefined);

    const cold = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
    const resumed = await cold.resumeInBackground(paused.runId, { checkpointReplies: { "0": false } });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("a later explicit valid reply should continue");
    const completed = await resumed.promise;
    assert.equal(completed.status, "completed");
    assert.equal(completed.result, false);
    assert.equal(dispatched, 1);
    assert.equal(cold.getPersistence().load(paused.runId)?.journal?.[0].checkpointDecision, "explicit-v1");
  }));
}

test("checkpoint(): replays the journaled reply on resume (no re-prompt)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const r = await checkpoint('Approve?', {})
return { r }`;
  const journal = new Map<number, JournalEntry>();
  const first = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async () => "approved",
    onAgentJournal: (e) => journal.set(e.index, e),
  });
  assert.equal(first.result.r, "approved");

  let calledAgain = false;
  const second = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    resumeJournal: journal,
    confirm: async () => {
      calledAgain = true;
      return "DIFFERENT";
    },
  });
  assert.equal(second.result.r, "approved", "reply replays from the journal");
  assert.equal(calledAgain, false, "confirm is not called again on resume");
  assert.deepEqual(second.checkpointsTaken, [
    { callIndex: 0, kind: "confirm", decision: "approved", source: "journal-replay" },
  ]);
});

test("checkpoints do not shift strict host configuration ordinals across cold continuation", withTempPersistenceDirs(async (persistenceRoot, cwd) => {
  const models: Array<string | undefined> = [];
  const runner = { async run(_prompt: string, options?: { model?: string }) { models.push(options?.model); return "done"; } };
  const script = `export const meta = { name: "checkpoint-routing", description: "host selections after a gate" }
await agent("before")
await checkpoint("Continue?")
return await agent("after")`;
  const first = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
  const paused = await first.runSync(script, undefined, {
    requireAgentConfiguration: true,
    agentConfigurations: { 0: { model: "claude/first" }, 1: { model: "codex/second" } },
  });
  assert.equal(paused.status, "paused");
  assert.deepEqual(models, ["claude/first"]);
  const cold = new WorkflowManager({ cwd, persistenceRoot, agent: runner });
  const resumed = await cold.resumeInBackground(paused.runId, { checkpointReplies: { "1": true } });
  assert.equal(resumed.accepted, true);
  if (!resumed.accepted) assert.fail("explicit answer should continue");
  const completed = await resumed.promise;
  assert.equal(completed.status, "completed");
  assert.equal(completed.agentCount, 2);
  assert.deepEqual(models, ["claude/first", "codex/second"]);
}));

test("checkpoint(): counts against maxAgents (no tokens, but bounded)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
await checkpoint('a')
await checkpoint('b')
await checkpoint('c')
return 1`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false, maxAgents: 2, confirm: async () => 1 }), /limit/i);
});

test(
  "durable checkpoint: pause context and prefix persist; cold reply resume journals the answer permanently",
  withTempPersistenceRoot(async (persistenceRoot) => {
    const store = memoryPersistence();
    const firstAgent = recordingAgent();
    const manager1 = new WorkflowManager({
      agent: firstAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    let pausedEvent:
      | { reason?: string; checkpointContext?: CheckpointContext; authContext?: unknown; resetHint?: unknown }
      | undefined;
    manager1.on("paused", (event: typeof pausedEvent) => {
      pausedEvent = event;
    });

    const paused = await manager1.runSync(DURABLE_SCRIPT);
    const context = paused.checkpointContext;
    const expectedHash = createHash("sha256")
      .update(JSON.stringify({ promptText: DURABLE_PROMPT, kind: "select", choices: DURABLE_CHOICES }))
      .digest("hex");

    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "checkpoint_required");
    assert.ok(context, "the terminal result carries checkpointContext");
    assert.equal(context.callIndex, 1);
    assert.equal(context.hash, expectedHash);
    assert.equal(context.prompt, DURABLE_PROMPT);
    assert.equal(context.kind, "select");
    assert.deepEqual(Array.from(context.choices ?? []), DURABLE_CHOICES);
    assert.equal(Object.hasOwn(context, "default"), false);
    assert.equal(paused.authContext, undefined);
    assert.equal(paused.resetHint, undefined);
    assert.equal(paused.checkpointsTaken, undefined, "a checkpoint that pauses has not resolved");
    assert.equal(pausedEvent?.reason, "checkpoint_required");
    assert.deepEqual(pausedEvent?.checkpointContext, context);
    assert.equal(pausedEvent?.authContext, undefined);
    assert.equal(pausedEvent?.resetHint, undefined);
    assert.deepEqual(firstAgent.prompts, ["before"]);

    const persistedPause = store.persistence.load(paused.runId);
    assert.equal(persistedPause?.status, "paused");
    assert.equal(persistedPause?.pauseReason, "checkpoint_required");
    assert.deepEqual(persistedPause?.checkpointContext, structuredClone(context));
    assert.equal(persistedPause?.journal?.length, 1, "the completed agent prefix remains journaled");
    assert.equal(persistedPause?.journal?.[0]?.index, 0);
    assert.equal(persistedPause?.journal?.[0]?.result, "agent:before");

    // Fresh manager instance: the reply is supplied out-of-band and no live confirm is asked.
    const resumedAgent = recordingAgent();
    const manager2 = new WorkflowManager({
      agent: resumedAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    let liveAsks = 0;
    const resumed = await manager2.resumeInBackground(paused.runId, {
      checkpointReplies: { [context.callIndex]: "ship" },
      confirm: async () => {
        liveAsks++;
        return "wrong-live-answer";
      },
    });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the cold resume should be accepted");
    const completed = await resumed.promise;

    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.checkpointsTaken, [
      { callIndex: context.callIndex, kind: "select", decision: "ship", source: "injected" },
    ]);
    assert.equal(field(completed.result, "prefix"), "agent:before");
    assert.equal(field(completed.result, "decision"), "ship");
    assert.equal(field(completed.result, "after"), "agent:after:ship");
    assert.equal(liveAsks, 0, "the injected journal reply prevents a live re-ask");
    assert.deepEqual(resumedAgent.prompts, ["after:ship"], "the prefix replayed and only new work ran live");

    const finalState = store.persistence.load(paused.runId);
    assert.equal(finalState?.status, "completed");
    const replyEntry = finalState?.journal?.find((entry) => entry.index === context.callIndex);
    assert.deepEqual(
      { index: replyEntry?.index, hash: replyEntry?.hash, result: replyEntry?.result, kind: replyEntry?.kind, scope: replyEntry?.scope },
      { index: context.callIndex, hash: context.hash, result: "ship", kind: "checkpoint", scope: paused.runId },
      "the synthetic decision is in the final persisted journal",
    );
    assert.deepEqual(replyEntry?.call, { kind: "checkpoint", label: "checkpoint", phase: undefined });
    assert.deepEqual(finalState?.checkpointsTaken, completed.checkpointsTaken);

    // A third, cold manager can hydrate that final journal and complete with no reply or
    // confirm channel at all. Every call replays, proving the synthetic answer is durable.
    const replayAgent = recordingAgent();
    const manager3 = new WorkflowManager({
      agent: replayAgent.runner,
      persistence: memoryPersistence().persistence,
      persistenceRoot,
    });
    const replayJournal = new Map((finalState?.journal ?? []).map((entry) => [entry.index, entry] as const));
    const replayed = await manager3.runSync(DURABLE_SCRIPT, undefined, { resumeJournal: replayJournal });
    assert.equal(replayed.status, "completed");
    assert.equal(field(replayed.result, "decision"), "ship");
    assert.deepEqual(replayAgent.prompts, [], "the third cold replay asks nothing and executes no agent");
    assert.deepEqual(replayed.checkpointsTaken, [
      { callIndex: context.callIndex, kind: "select", decision: "ship", source: "journal-replay" },
    ]);
  }),
);

test(
  "durable checkpoint: real filesystem persistence survives a fresh-manager reply resume",
  withTempPersistenceDirs(async (persistenceRoot, cwd) => {
    const firstAgent = recordingAgent();
    const manager1 = new WorkflowManager({
      agent: firstAgent.runner,
      cwd,
      persistenceRoot,
    });

    const paused = await manager1.runSync(DURABLE_SCRIPT);
    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "checkpoint_required");
    const context = paused.checkpointContext;
    assert.ok(context, "the filesystem-persisted pause exposes its checkpoint context");
    assert.deepEqual(firstAgent.prompts, ["before"]);
    assert.equal(manager1.getPersistence().load(paused.runId)?.status, "paused");

    const resumedAgent = recordingAgent();
    const manager2 = new WorkflowManager({
      agent: resumedAgent.runner,
      cwd,
      persistenceRoot,
    });
    const resumed = await manager2.resumeInBackground(paused.runId, {
      checkpointReplies: { [context.callIndex]: "ship" },
    });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the fresh manager should load and resume the on-disk pause");
    const completed = await resumed.promise;

    assert.equal(completed.status, "completed");
    assert.equal(field(completed.result, "decision"), "ship");
    assert.equal(field(completed.result, "after"), "agent:after:ship");
    assert.deepEqual(resumedAgent.prompts, ["after:ship"]);

    const listed = manager2.listRuns().find((run) => run.runId === paused.runId);
    const loaded = manager2.getPersistence().load(paused.runId);
    assert.equal(listed?.status, "completed", "the filesystem listing exposes the terminal state");
    assert.equal(loaded?.status, "completed", "a direct filesystem load exposes the terminal state");
    const replyEntry = loaded?.journal?.find((entry) => entry.index === context.callIndex);
    assert.deepEqual(
      { index: replyEntry?.index, hash: replyEntry?.hash, result: replyEntry?.result, kind: replyEntry?.kind, scope: replyEntry?.scope },
      { index: context.callIndex, hash: context.hash, result: "ship", kind: "checkpoint", scope: paused.runId },
      "the synthetic checkpoint reply is durably journaled on disk",
    );
    assert.deepEqual(replyEntry?.call, { kind: "checkpoint", label: "checkpoint" });
  }),
);

test(
  "durable checkpoint: cold resume without a reply or live confirm re-pauses without executing",
  withTempPersistenceRoot(async (persistenceRoot) => {
    const store = memoryPersistence();
    const firstAgent = recordingAgent();
    const manager1 = new WorkflowManager({
      agent: firstAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    const first = await manager1.runSync(DURABLE_SCRIPT);
    assert.equal(first.status, "paused");
    assert.ok(first.checkpointContext);
    const before = store.persistence.load(first.runId);
    const saveCount = store.saves.length;

    const coldAgent = recordingAgent();
    const manager2 = new WorkflowManager({
      agent: coldAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    let resumedEvent = false;
    manager2.on("resumed", () => {
      resumedEvent = true;
    });
    let rePaused: { reason?: string; checkpointContext?: CheckpointContext; error?: WorkflowError } | undefined;
    manager2.on("paused", (event: typeof rePaused) => {
      rePaused = event;
    });

    const resumed = await manager2.resumeInBackground(first.runId);
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the re-pause should use the accepted settlement shape");
    await assert.rejects(
      resumed.promise,
      (error: unknown) =>
        error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_REQUIRED,
    );

    assert.equal(resumedEvent, false, "an immediate re-pause does not emit resumed");
    assert.deepEqual(coldAgent.prompts, [], "no agent calls are made");
    assert.equal(store.saves.length, saveCount + 1, "same-ID resume durably marks the positional artifact");
    assert.equal(rePaused?.reason, "checkpoint_required");
    assert.equal(rePaused?.error?.code, WorkflowErrorCode.CHECKPOINT_REQUIRED);
    assert.deepEqual(rePaused?.checkpointContext, structuredClone(first.checkpointContext));
    assert.deepEqual(
      store.persistence.load(first.runId),
      { ...before, legacyResume: true },
      "the paused state and context are preserved with the permanent legacy marker",
    );
  }),
);

test(
  "durable checkpoint: cold resume can answer through a live confirm channel",
  withTempPersistenceRoot(async (persistenceRoot) => {
    const store = memoryPersistence();
    const manager1 = new WorkflowManager({
      agent: recordingAgent().runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    const first = await manager1.runSync(DURABLE_SCRIPT);
    assert.equal(first.status, "paused");

    const liveAgent = recordingAgent();
    const manager2 = new WorkflowManager({
      agent: liveAgent.runner,
      persistence: store.persistence,
      persistenceRoot,
    });
    let asks = 0;
    const resumed = await manager2.resumeInBackground(first.runId, {
      confirm: async (prompt) => {
        asks++;
        assert.equal(prompt, DURABLE_PROMPT);
        return "hold";
      },
    });
    assert.equal(resumed.accepted, true);
    if (!resumed.accepted) assert.fail("the live-confirm resume should be accepted");
    const completed = await resumed.promise;

    assert.equal(completed.status, "completed");
    assert.equal(field(completed.result, "decision"), "hold");
    assert.equal(asks, 1);
    assert.deepEqual(completed.checkpointsTaken, [
      { callIndex: first.checkpointContext?.callIndex, kind: "select", decision: "hold", source: "live" },
    ]);
    assert.deepEqual(liveAgent.prompts, ["after:hold"]);
    const context = first.checkpointContext;
    assert.ok(context);
    assert.equal(
      store.persistence.load(first.runId)?.journal?.find((entry) => entry.index === context.callIndex)?.result,
      "hold",
    );
  }),
);
