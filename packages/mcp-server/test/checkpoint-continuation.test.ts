// Consecutive checkpoints use separate bounded continuations, including form-capable hosts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ElicitRequest } from "@modelcontextprotocol/client";
import { createWorkflowServer } from "../src/index.js";
import { connect, okRunner, structured, textOf, waitForRun } from "./_harness.js";

const TWO_CHECKPOINTS = `export const meta = { name: "two-checkpoints", description: "two consecutive gates" };
const first = await checkpoint("First?", { kind: "confirm" });
const second = await checkpoint("Second?", { kind: "confirm" });
return { first, second };`;
const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

async function connectEliciting() {
  const server = createWorkflowServer(okRunner());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "checkpoint-chain", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  const requests: ElicitRequest[] = [];
  client.setRequestHandler("elicitation/create", async (request) => {
    requests.push(request);
    return { action: "accept", content: { approve: true } };
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, requests, async dispose() { await client.close(); await server.close(); } };
}

async function waitForCheckpoint(client: Client, runId: string, callIndex: number) {
  return waitForRun(client, runId, status => status.status === "paused" &&
    field(field(status.outcome, "checkpointContext"), "callIndex") === callIndex);
}

async function start(client: Client) {
  const accepted = await client.callTool({ name: "workflow", arguments: {
    action: "run", requestId: randomUUID(), script: TWO_CHECKPOINTS,
  } });
  assert.equal(accepted.isError, false, textOf(accepted));
  assert.equal(structured(accepted)?.accepted, true);
  assert.equal(structured(accepted)?.result, undefined);
  const runId = String(structured(accepted)?.runId);
  await waitForCheckpoint(client, runId, 0);
  return runId;
}

test("form-capable hosts leave each checkpoint pending until a separate explicit continuation", async () => {
  const conn = await connectEliciting();
  try {
    const runId = await start(conn.client);
    assert.deepEqual(conn.requests, [], "MCP requests never collect checkpoint replies inline");
    const first = await conn.client.callTool({ name: "workflow", arguments: {
      action: "resume", requestId: randomUUID(), runId, checkpointReplies: { "0": false },
    } });
    assert.equal(first.isError, false, textOf(first));
    assert.equal(structured(first)?.accepted, true);
    assert.equal(structured(first)?.runId, runId);
    await waitForCheckpoint(conn.client, runId, 1);
    assert.deepEqual(conn.requests, []);
    const second = await conn.client.callTool({ name: "workflow", arguments: {
      action: "resume", requestId: randomUUID(), runId, checkpointReplies: { "1": true },
    } });
    assert.equal(structured(second)?.accepted, true);
    const finished = structured(await waitForRun(conn.client, runId, status => status.status === "completed"));
    assert.deepEqual(structuredClone(field(finished?.outcome, "result")), { first: false, second: true });
    assert.deepEqual(conn.requests, []);
  } finally { await conn.dispose(); }
});

test("a retry of the first continuation cannot answer or bypass the later checkpoint", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const runId = await start(client);
    const request = { action: "resume", requestId: randomUUID(), runId, checkpointReplies: { "0": false } };
    const first = await client.callTool({ name: "workflow", arguments: request });
    assert.equal(structured(first)?.duplicate, false);
    await waitForCheckpoint(client, runId, 1);
    const retry = await client.callTool({ name: "workflow", arguments: request });
    assert.equal(retry.isError, false, textOf(retry));
    assert.equal(structured(retry)?.accepted, true);
    assert.equal(structured(retry)?.duplicate, true);
    assert.deepEqual(structured(retry)?.continuation, structured(first)?.continuation);
    await waitForCheckpoint(client, runId, 1);
    const olderReply = await client.callTool({ name: "workflow", arguments: { ...request, requestId: randomUUID() } });
    assert.equal(olderReply.isError, false, textOf(olderReply));
    assert.notEqual(structured(olderReply)?.accepted, true);
    await waitForCheckpoint(client, runId, 1);
  } finally { await dispose(); }
});

for (const forms of [false, true]) {
  test(`resume without a checkpoint reply stays observable with forms=${forms}`, async () => {
    const conn = forms ? await connectEliciting() : await connect(okRunner(), { listTools: true });
    try {
      const runId = await start(conn.client);
      const resumed = await conn.client.callTool({ name: "workflow", arguments: {
        action: "resume", requestId: randomUUID(), runId,
      } });
      assert.equal(resumed.isError, false, textOf(resumed));
      assert.equal(structured(resumed)?.status, "paused");
      assert.equal(field(field(structured(resumed)?.outcome, "checkpointContext"), "callIndex"), 0);
      assert.match(textOf(resumed), /not continued: checkpoint-required/);
      if ("requests" in conn) assert.deepEqual(conn.requests, []);
    } finally { await conn.dispose(); }
  });
}

test("cold continuation replays the earlier explicit answer and resolves only the pending checkpoint", async () => {
  const first = await connect(okRunner(), { listTools: true });
  let runId = "";
  try {
    runId = await start(first.client);
    await first.client.callTool({ name: "workflow", arguments: {
      action: "resume", requestId: randomUUID(), runId, checkpointReplies: { "0": false },
    } });
    await waitForCheckpoint(first.client, runId, 1);
  } finally { await first.dispose(); }
  const second = await connect(okRunner(), { listTools: true });
  try {
    const accepted = await second.client.callTool({ name: "workflow", arguments: {
      action: "resume", requestId: randomUUID(), runId, checkpointReplies: { "1": true },
    } });
    assert.equal(accepted.isError, false, textOf(accepted));
    assert.equal(structured(accepted)?.accepted, true);
    const finished = structured(await waitForRun(second.client, runId, status => status.status === "completed"));
    assert.deepEqual(structuredClone(field(finished?.outcome, "result")), { first: false, second: true });
    const taken = field(finished?.outcome, "checkpointsTaken") as Array<Record<string, unknown>>;
    assert.deepEqual(taken.map(entry => [entry.callIndex, entry.decision, entry.source]), [
      [0, false, "journal-replay"], [1, true, "injected"],
    ]);
  } finally { await second.dispose(); }
});
