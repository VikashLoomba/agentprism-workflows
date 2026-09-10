import assert from "node:assert/strict";
import test from "node:test";
import type { RunEventLogRecord } from "@automatalabs/shared-types";
import { createModelMessageState, discussionMessage, modelMessageText, selectionContext, sendAutomaticMessage, sendModelMessagesForFold, sendRequiredInputMessages } from "../ui/src/model-messages.js";
import { createRunModel } from "../ui/src/state.js";
import { MockHost, MockRunStore } from "../ui/src/mock-host.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function host() { const store = new MockRunStore(); store.create("run-a"); return new MockHost(store); }
function record(seq: number, type: "complete" | "phase" | "log" = "complete"): RunEventLogRecord {
  return { version: 1, streamId: "stream-a", runId: "run-a", seq, timestamp: "2026-09-08T00:00:00Z", event: { runId: "run-a", scope: "run-a", type, title: "Research", message: "Routine update", summary: {} } } as RunEventLogRecord;
}

test("multi-page historical bootstrap never replays terminal messages; future terminal events notify", async () => {
  const app = host(), state = createModelMessageState();
  sendModelMessagesForFold(app, "run-a", 0, [record(1, "phase")], state, 3);
  sendModelMessagesForFold(app, "run-a", 1, [record(2), record(3, "log")], state, 3);
  await settle(); assert.equal(app.messages.length, 0);
  sendModelMessagesForFold(app, "run-a", 3, [record(4, "phase"), record(5, "log"), record(6)], state, 6);
  await settle(); assert.equal(app.messages.length, 1);
  assert.match(JSON.stringify(app.messages), /Run completed/);
  sendModelMessagesForFold(app, "run-a", 0, [record(6)], state, 6);
  await settle(); assert.equal(app.messages.length, 1);
});

test("independent and reopened panels coordinate automatic delivery through server claims", async () => {
  const first = host(), second = new MockHost(first.store);
  await Promise.all([sendAutomaticMessage(first, "run-a", "terminal:stream-a:10", "Completed", createModelMessageState()), sendAutomaticMessage(second, "run-a", "terminal:stream-a:10", "Completed", createModelMessageState())]);
  assert.equal(first.messages.length + second.messages.length, 1);
  await sendAutomaticMessage(new MockHost(first.store), "run-a", "terminal:stream-a:10", "Completed", createModelMessageState());
  assert.equal(first.store.notifications.size, 1);
  assert.equal([...first.store.notifications.values()][0]?.sent, true);
});

test("required setup, permissions, checkpoints notify even on opening, without raw request content", async () => {
  for (const scenario of ["setup", "permission", "checkpoint"] as const) {
    const app = host(), state = createModelMessageState(); app.store.scenario("run-a", scenario);
    const snapshot = app.store.runs.get("run-a")!.snapshot;
    sendRequiredInputMessages(app, snapshot, state); sendRequiredInputMessages(app, snapshot, state);
    await settle(); assert.equal(app.messages.length, 1, scenario);
    assert.match(JSON.stringify(app.messages), /run-a/);
    assert.doesNotMatch(JSON.stringify(app.messages), /Publish findings|Read the transport specification/);
  }
});

test("routine activity and phases are quiet; context is run-scoped, carries the agent's error as reported, and does not copy transcripts", () => {
  assert.equal(modelMessageText("run-a", record(1, "phase").event), undefined);
  const model = createRunModel("run-a"); model.name = "Flow"; model.phases = ["Research"];
  model.nodes.set(0, { callIndex: 0, label: "Research transport", status: "error", startSeq: 1, errorText: "token=secret-value " + "failure ".repeat(1000), transcript: new Map([["entry", { revision: 1, row: { order: 1, kind: "text", text: "PRIVATE TRANSCRIPT" } }]]), progress: [] });
  const selection = { kind: "agent", callIndex: 0 } as const;
  const context = selectionContext(model, selection);
  assert.match(context, /"runId":"run-a"/); assert.match(context, /"callIndex":0/);
  assert.match(context, /token=secret-value failure failure/); assert.doesNotMatch(context, /PRIVATE TRANSCRIPT/);
  assert.match(discussionMessage(model, selection), /Please discuss/);
});

test("unavailable/rejected messages never disable browsing or repeatedly emit for a pending request", async () => {
  const app = host(); app.capabilities = { serverTools: {} };
  await sendAutomaticMessage(app, "run-a", "permission:one", "Needs input", createModelMessageState());
  assert.equal(app.calls.length, 0); assert.equal(app.messages.length, 0);
  app.capabilities.message = { text: {} }; app.rejectMessage = true;
  const state = createModelMessageState();
  await sendAutomaticMessage(app, "run-a", "permission:one", "Needs input", state);
  await sendAutomaticMessage(app, "run-a", "permission:one", "Needs input", state);
  assert.equal(app.messages.length, 1); assert.equal(app.store.notifications.size, 0, "failed host delivery releases the shared lease");
  assert.equal((await app.callServerTool({ name: "workflow", arguments: { action: "status", runId: "run-a" } })).isError, undefined);
});

test("teardown between claim and delivery releases the lease without messaging", async () => {
  const app = host(), state = createModelMessageState();
  const pending = sendAutomaticMessage(app, "run-a", "permission:one", "Needs input", state); state.active = false;
  await pending; assert.equal(app.messages.length, 0); assert.equal(app.store.notifications.size, 0);
});
