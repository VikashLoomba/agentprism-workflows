import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connect, makeRunner, NO_AGENT_SCRIPT, okRunner, persistedRunFile, structured, textOf, waitForRun } from "./_harness.js";
import { WorkflowNotificationClaims } from "../src/workflow-notifications.js";

test("run acknowledges the durable script before preparation; a lost acknowledgement never duplicates work", async () => {
  let calls = 0;
  const conn = await connect(makeRunner(() => { calls++; return "done"; }), { listTools: true });
  const input = { action: "run", requestId: randomUUID(), script: 'export const meta = { name: "retry", description: "retry identity", model: "claude" }; return await agent("work");' };
  try {
    const accepted = await conn.client.callTool({ name: "workflow", arguments: input });
    assert.equal(accepted.isError, false, textOf(accepted));
    const acknowledgement = structured(accepted)!;
    assert.equal(acknowledgement.accepted, true);
    assert.equal(acknowledgement.status, "pending");
    assert.equal(acknowledgement.result, undefined);
    assert.equal(calls, 0, "live agent cannot start before acknowledgement");
    const runId = String(acknowledgement.runId);
    const durable = JSON.parse(readFileSync(persistedRunFile(runId)!, "utf8"));
    assert.equal(durable.script, input.script);
    assert.equal(durable.acceptanceOperation.id, input.requestId);
    const retried = await conn.client.callTool({ name: "workflow", arguments: input });
    assert.equal(structured(retried)?.runId, runId);
    assert.equal(structured(retried)?.duplicate, true);
    const completed = await waitForRun(conn.client, runId);
    assert.equal(structured(completed)?.status, "completed", textOf(completed));
    assert.equal(calls, 1);
    const conflict = await conn.client.callTool({ name: "workflow", arguments: { ...input, script: NO_AGENT_SCRIPT } });
    assert.equal(conflict.isError, true);
    assert.equal(calls, 1);
  } finally { await conn.dispose(); }
});

test("scriptPath retries preserve the accepted snapshot after the file changes", async () => {
  const scriptPath = join(mkdtempSync(join(tmpdir(), "workflow-accepted-path-")), "workflow.js");
  writeFileSync(scriptPath, NO_AGENT_SCRIPT);
  const conn = await connect(okRunner());
  const input = { action: "run", requestId: randomUUID(), scriptPath };
  try {
    const accepted = await conn.client.callTool({ name: "workflow", arguments: input });
    const runId = String(structured(accepted)?.runId);
    writeFileSync(scriptPath, 'throw new Error("changed");');
    const retried = await conn.client.callTool({ name: "workflow", arguments: input });
    assert.equal(structured(retried)?.runId, runId);
    assert.equal(structured(retried)?.duplicate, true);
    const completed = await waitForRun(conn.client, runId);
    assert.equal((structured(completed)?.outcome as { result: unknown }).result, 42);
  } finally { await conn.dispose(); }
});

test("setup approval is durable and addressable without an App or a held elicitation", async () => {
  let calls = 0;
  const conn = await connect(makeRunner(() => { calls++; return "approved"; }), { listTools: true });
  const input = { action: "run", requestId: randomUUID(), script: 'export const meta = { name: "setup", description: "approval", backends: { custom: { command: "custom-acp" } } }; return 42;' };
  try {
    const accepted = await conn.client.callTool({ name: "workflow", arguments: input });
    const runId = String(structured(accepted)?.runId);
    const waiting = await waitForRun(conn.client, runId, (status) => (status.setup as { state?: string })?.state === "input-required");
    const setup = (structured(waiting)?.setup as { request: { id: string; kind: string } }).request;
    assert.equal(setup.kind, "backend-approval");
    assert.equal(calls, 0);
    const response = { action: "setup-response", runId, setupId: setup.id, response: { action: "accept", content: { approve: true } } };
    const acknowledged = await conn.client.callTool({ name: "workflow", arguments: response });
    assert.equal(acknowledged.isError, false, textOf(acknowledged));
    const completed = await waitForRun(conn.client, runId);
    assert.equal(structured(completed)?.status, "completed", textOf(completed));
    const repeated = await conn.client.callTool({ name: "workflow", arguments: response });
    assert.equal(repeated.isError, false, textOf(repeated));
    const conflict = await conn.client.callTool({ name: "workflow", arguments: { ...response, response: { action: "decline" } } });
    assert.equal(conflict.isError, true);
  } finally { await conn.dispose(); }
});

test("malformed source is rejected early and later validation failure remains durable", async () => {
  let calls = 0;
  const conn = await connect(makeRunner(() => { calls++; return "unexpected"; }));
  try {
    const malformed = await conn.client.callTool({ name: "workflow", arguments: { action: "run", requestId: randomUUID(), script: "not a workflow" } });
    assert.equal(malformed.isError, true);
    assert.equal(structured(malformed)?.runId, undefined);
    const accepted = await conn.client.callTool({ name: "workflow", arguments: { action: "run", requestId: randomUUID(),
      script: 'export const meta = { name: "invalid-call", description: "valid structure" }; return agent("work", { unknownOption: true });' } });
    assert.equal(accepted.isError, false, textOf(accepted));
    const failed = await waitForRun(conn.client, String(structured(accepted)?.runId));
    assert.equal(structured(failed)?.status, "failed");
    assert.match(textOf(failed), /accepted run remains available/);
    assert.doesNotMatch(textOf(failed), /No run was created/);
    assert.equal(calls, 0);
  } finally { await conn.dispose(); }
});

test("notification leases suppress simultaneous views, release failures, and retain sent receipts", () => {
  let now = 0;
  const claims = new WorkflowNotificationClaims(() => now);
  const base = { runId: "run-a", eventId: "terminal:stream:9", viewId: randomUUID() };
  const first = claims.handle("host-a", { ...base, action: "claim" });
  assert.equal("send" in first && first.send, true);
  const token = "token" in first ? first.token : undefined;
  assert.deepEqual(claims.handle("host-a", { ...base, viewId: randomUUID(), action: "claim" }), { send: false });
  claims.handle("host-a", { ...base, action: "release", token });
  const retry = claims.handle("host-a", { ...base, action: "claim" });
  const retryToken = "token" in retry ? retry.token : undefined;
  claims.handle("host-a", { ...base, action: "sent", token: retryToken });
  now = 60_000;
  assert.deepEqual(claims.handle("host-a", { ...base, action: "claim" }), { send: false });
  const otherHost = claims.handle("host-b", { ...base, action: "claim" });
  assert.equal("send" in otherHost && otherHost.send, true);
});

test("a held preparation probe does not hold acceptance or control and cannot admit after stop", async () => {
  let releaseProbe!: () => void;
  let probeEntered!: () => void;
  const entered = new Promise<void>((resolve) => { probeEntered = resolve; });
  const held = new Promise<void>((resolve) => { releaseProbe = resolve; });
  let liveCalls = 0;
  const runner = makeRunner(() => { liveCalls++; return "unexpected"; });
  runner.probeConfigOptions = async () => {
    probeEntered();
    await held;
    return { backendId: "codex", options: [] };
  };
  const conn = await connect(runner, { listTools: true });
  try {
    const accepted = await conn.client.callTool({ name: "workflow", arguments: {
      action: "run", requestId: randomUUID(),
      script: 'export const meta = { name: "held-probe", description: "bounded setup", model: "codex" }; return agent("work");',
    } });
    assert.equal(accepted.isError, false, textOf(accepted));
    assert.equal(structured(accepted)?.accepted, true);
    const runId = String(structured(accepted)?.runId);
    await entered;
    const pending = await conn.client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(structured(pending)?.status, "pending");
    assert.deepEqual(structured(pending)?.setup, { state: "preparing" });
    const stopped = await conn.client.callTool({ name: "workflow", arguments: { action: "stop", runId } });
    assert.equal(stopped.isError, false, textOf(stopped));
    assert.equal(structured(stopped)?.status, "aborted");
    releaseProbe();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const afterProbe = await conn.client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(structured(afterProbe)?.status, "aborted");
    assert.equal(liveCalls, 0);
    const durable = JSON.parse(readFileSync(persistedRunFile(runId)!, "utf8"));
    assert.equal(durable.admission, undefined, "late preparation cannot save live execution admission");
  } finally { releaseProbe(); await conn.dispose(); }
});
