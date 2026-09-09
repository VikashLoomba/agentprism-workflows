import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentRunner, RunOptions } from "@automatalabs/shared-types";
import { structured, makeRunner, persistedRunFile, runAndObserve, waitForRun, textOf } from "./_harness.js";
import { connectHttp, makeProjectDir, startDaemon } from "./_http-harness.js";

const SCRIPT = `export const meta = {
  name: "agent-configuration-elicitation",
  description: "choose every unconfigured agent before execution",
  phases: [
    { title: "Research", detail: "Collect primary evidence." },
    { title: "Review", detail: "Check the evidence." }
  ]
};
phase("Research");
await agent("research", { label: "researcher" });
phase("Review");
return agent("review", {
  label: "reviewer"
});`;

interface ObservedCall {
  model?: string;
  mode?: string;
  configOptions?: Record<string, string | boolean>;
}

const ACCEPTED_CONFIGURATION = {
  action: "accept" as const,
  content: {
    agent_0_model: "codex/gpt-5",
    agent_0_provider_1_config_0: "high",
    agent_1_model: "claude/sonnet",
    agent_1_provider_0_mode: "code",
    agent_1_provider_0_config_0: true,
  },
};

function configurableRunner(seen: ObservedCall[]): AgentRunner {
  return {
    async run(_prompt: string, options: RunOptions) {
      seen.push({
        model: options.model,
        mode: options.mode,
        configOptions: options.configOptions,
      });
      return "ok" as never;
    },
    listBackends: () => ["claude", "codex"],
    async probeConfigOptions(spec?: string) {
      const backendId = spec?.startsWith("codex") ? "codex" : "claude";
      if (backendId === "codex") {
        return {
          backendId,
          modes: null,
          options: [
            {
              id: "model",
              name: "Model",
              type: "select" as const,
              currentValue: "gpt-5",
              options: [{ value: "gpt-5", name: "GPT-5" }],
            },
            {
              id: "reasoning",
              name: "Reasoning",
              type: "select" as const,
              currentValue: "medium",
              options: [
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
            },
          ],
        };
      }
      return {
        backendId,
        modes: {
          currentModeId: "plan",
          availableModes: [
            { id: "plan", name: "Plan" },
            { id: "code", name: "Code" },
          ],
        },
        options: [
          {
            id: "model",
            name: "Model",
            type: "select" as const,
            currentValue: "sonnet",
            options: [{ value: "sonnet", name: "Sonnet" }],
          },
          { id: "fast", name: "Fast", type: "boolean" as const, currentValue: false },
        ],
      };
    },
  } as AgentRunner;
}

const EXPECTED_DISPATCH: ObservedCall[] = [
  { model: "codex/gpt-5", mode: undefined, configOptions: { reasoning: "high" } },
  { model: "claude/sonnet", mode: "code", configOptions: { fast: true } },
];


interface SetupRequest {
  id: string;
  kind: string;
  message: string;
  requestedSchema: { required: string[]; properties: Record<string, { oneOf?: Array<{ const: string }> }> };
}

async function startSetup(client: Parameters<typeof waitForRun>[0], projectDir: string, script = SCRIPT) {
  const requestId = randomUUID();
  const accepted = await client.callTool({ name: "workflow", arguments: { action: "run", requestId, projectDir, script } });
  assert.equal(accepted.isError, false, textOf(accepted));
  assert.equal(structured(accepted)?.accepted, true);
  const runId = String(structured(accepted)?.runId);
  const waiting = await waitForRun(client, runId, (status) => (status.setup as { state?: string })?.state === "input-required");
  const request = (structured(waiting)?.setup as { request: SetupRequest }).request;
  assert.equal(request.kind, "agent-configuration");
  return { runId, request };
}

for (const protocolMode of ["legacy", "modern"] as const) {
  test(`${protocolMode}: durable setup configures exact provider, mode, and boolean choices before execution`, async () => {
    const seen: ObservedCall[] = [];
    const daemon = await startDaemon(configurableRunner(seen));
    const connected = await connectHttp(daemon.url, { protocolMode, elicit: () => ({ action: "decline" }) });
    const projectDir = makeProjectDir(`durable-agent-config-${protocolMode}`);
    try {
      const { runId, request } = await startSetup(connected.client, projectDir);
      assert.match(request.message, /Research — researcher/);
      assert.match(request.message, /Collect primary evidence/);
      assert.match(request.message, /Review — reviewer/);
      assert.deepEqual(request.requestedSchema.required, ["agent_0_model", "agent_1_model"]);
      assert.deepEqual(seen, []);
      const file = persistedRunFile(runId)!;
      const pending = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(pending.status, "pending");
      assert.equal(pending.admission, undefined);
      assert.equal(pending.script, SCRIPT);
      const response = { action: "setup-response", runId, setupId: request.id, response: ACCEPTED_CONFIGURATION };
      const acknowledged = await connected.client.callTool({ name: "workflow", arguments: response });
      assert.equal(acknowledged.isError, false, textOf(acknowledged));
      const completed = await waitForRun(connected.client, runId);
      assert.equal(structured(completed)?.status, "completed", textOf(completed));
      assert.deepEqual(seen, EXPECTED_DISPATCH);
      assert.equal(connected.elicitations.length, 0, "no transport owns a human input wait");
      const admitted = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(admitted.admission.format, 2);
      assert.deepEqual(admitted.admission.agentConfigurations, {
        0: { model: "codex/gpt-5", configOptions: { reasoning: "high" } },
        1: { model: "claude/sonnet", mode: "code", configOptions: { fast: true } },
      });
      assert.equal(admitted.preparation, undefined);
      assert.doesNotMatch(JSON.stringify(admitted.admission), /agent_0_model|agent_1_provider/);
      const retry = await connected.client.callTool({ name: "workflow", arguments: response });
      assert.equal(retry.isError, false, textOf(retry));
      assert.equal(seen.length, 2);
    } finally { await connected.dispose(); await daemon.close(); }
  });

  test(`${protocolMode}: authored and inherited configurations need no setup form`, async () => {
    const seen: ObservedCall[] = [];
    const daemon = await startDaemon(configurableRunner(seen));
    const connected = await connectHttp(daemon.url, { protocolMode, elicit: () => ({ action: "decline" }) });
    try {
      const completed = await runAndObserve(connected.client, { projectDir: makeProjectDir(`inherited-${protocolMode}`),
        args: { model: "codex/gpt-5" }, script: `export const meta = {
          name: "inherited", description: "resolve configured models", model: "codex/gpt-5",
          phases: [{ title: "Setup" }, { title: "Review", model: "claude/sonnet" }]
        }; await agent("meta"); phase("Review"); await agent("phase");
        await agent("backend", { model: "codex" }); return agent("dynamic", { model: args.model });` });
      assert.equal(structured(completed)?.status, "completed", textOf(completed));
      assert.deepEqual(seen.map(call => call.model), ["codex/gpt-5", "claude/sonnet", "codex", "codex/gpt-5"]);
      assert.equal(connected.elicitations.length, 0);
    } finally { await connected.dispose(); await daemon.close(); }
  });

  test(`${protocolMode}: invalid authored configuration fails the accepted run before live dispatch`, async () => {
    const seen: ObservedCall[] = [];
    const daemon = await startDaemon(configurableRunner(seen));
    const connected = await connectHttp(daemon.url, { protocolMode, elicit: () => ({ action: "decline" }) });
    try {
      const failed = await runAndObserve(connected.client, { projectDir: makeProjectDir(`invalid-authored-${protocolMode}`),
        script: 'export const meta = { name: "invalid", description: "invalid config" }; return agent("review", { model: "codex/gpt-5", configOptions: { reasoning: "invalid" } });' });
      assert.equal(structured(failed)?.status, "failed");
      assert.equal(typeof structured(failed)?.runId, "string");
      assert.deepEqual(seen, []);
      assert.equal(connected.elicitations.length, 0);
    } finally { await connected.dispose(); await daemon.close(); }
  });

  test(`${protocolMode}: declining configuration retains a cancelled run and the response receipt`, async () => {
    const seen: ObservedCall[] = [];
    const daemon = await startDaemon(configurableRunner(seen));
    const connected = await connectHttp(daemon.url, { protocolMode, elicit: () => ({ action: "decline" }) });
    try {
      const { runId, request } = await startSetup(connected.client, makeProjectDir(`decline-config-${protocolMode}`));
      const response = { action: "setup-response", runId, setupId: request.id, response: { action: "decline" } };
      const acknowledged = await connected.client.callTool({ name: "workflow", arguments: response });
      assert.equal(acknowledged.isError, false, textOf(acknowledged));
      assert.equal(structured(acknowledged)?.status, "aborted");
      assert.equal(structured(await waitForRun(connected.client, runId))?.status, "aborted");
      assert.equal((await connected.client.callTool({ name: "workflow", arguments: response })).isError, false);
      assert.deepEqual(seen, []);
    } finally { await connected.dispose(); await daemon.close(); }
  });

  for (const invalid of [
    { field: "agent_0_model", value: "claude/not-in-catalog", reason: /invalid provider\/model selection/ },
    { field: "agent_1_provider_0_mode", value: "yolo", reason: /invalid mode selection/ },
    { field: "agent_1_provider_0_config_0", value: "yes", reason: /invalid fast selection/ },
  ]) {
    test(`${protocolMode}: invalid ${invalid.field} leaves the exact setup request pending`, async () => {
      const seen: ObservedCall[] = [];
      const daemon = await startDaemon(configurableRunner(seen));
      const connected = await connectHttp(daemon.url, { protocolMode, elicit: () => ({ action: "decline" }) });
      try {
        const { runId, request } = await startSetup(connected.client, makeProjectDir(`invalid-selection-${protocolMode}`));
        const rejected = await connected.client.callTool({ name: "workflow", arguments: { action: "setup-response", runId, setupId: request.id,
          response: { action: "accept", content: { ...ACCEPTED_CONFIGURATION.content, [invalid.field]: invalid.value } } } });
        assert.equal(rejected.isError, true);
        assert.match(textOf(rejected), invalid.reason);
        assert.deepEqual(seen, []);
        const state = await waitForRun(connected.client, runId, (status) => (status.setup as { state?: string })?.state === "input-required");
        assert.equal((structured(state)?.setup as { request: SetupRequest }).request.id, request.id);
        const valid = await connected.client.callTool({ name: "workflow", arguments: { action: "setup-response", runId, setupId: request.id, response: ACCEPTED_CONFIGURATION } });
        assert.equal(valid.isError, false, textOf(valid));
        assert.equal(structured(await waitForRun(connected.client, runId))?.status, "completed");
      } finally { await connected.dispose(); await daemon.close(); }
    });
  }
}

test("a mixed configured run resumes with canonical selections and no new probes or forms", async () => {
  const seen: ObservedCall[] = [];
  let failLast = true;
  let probes = 0;
  const runner = makeRunner((_prompt, options) => {
    seen.push({ model: options.model, mode: options.mode, configOptions: options.configOptions });
    if (options.label === "last" && failLast) { failLast = false; throw new Error("retry last"); }
    return "ok";
  });
  const catalog = configurableRunner([]);
  runner.listBackends = catalog.listBackends;
  runner.probeConfigOptions = async (...args) => { probes++; return catalog.probeConfigOptions!(...args); };
  const daemon = await startDaemon(runner);
  const connected = await connectHttp(daemon.url, { protocolMode: "modern", elicit: () => ({ action: "decline" }) });
  try {
    const { runId, request } = await startSetup(connected.client, makeProjectDir("mixed-config"), `export const meta = { name: "mixed", description: "fill only missing models" };
      await agent("first", { label: "first", model: "claude/sonnet", mode: "code", configOptions: { fast: true } });
      await agent("missing", { label: "missing" });
      const last = await agent("last", { label: "last", model: "codex/gpt-5", configOptions: { reasoning: "medium" } });
      if (last === null) throw new Error("last must succeed"); return last;`);
    assert.deepEqual(request.requestedSchema.required, ["agent_1_model"]);
    await connected.client.callTool({ name: "workflow", arguments: { action: "setup-response", runId, setupId: request.id,
      response: { action: "accept", content: { agent_1_model: "codex/gpt-5", agent_1_provider_1_config_0: "high" } } } });
    const failed = await waitForRun(connected.client, runId);
    assert.equal(structured(failed)?.status, "failed");
    const beforeResume = probes;
    const resumed = await connected.client.callTool({ name: "workflow", arguments: { action: "resume", requestId: randomUUID(), runId } });
    assert.equal(structured(resumed)?.accepted, true, textOf(resumed));
    assert.equal(structured(await waitForRun(connected.client, runId))?.status, "completed");
    assert.equal(probes, beforeResume);
    assert.equal(seen.length, 4);
    assert.deepEqual(seen[3], seen[2]);
    assert.equal(connected.elicitations.length, 0);
  } finally { await connected.dispose(); await daemon.close(); }
});

test("a saved selection is checked against the current routed catalog before execution", async () => {
  let currentModel = "old-model";
  let calls = 0;
  const runner = makeRunner(() => { calls++; return "ok"; });
  runner.listBackends = () => ["claude"];
  runner.probeConfigOptions = async () => ({ backendId: "claude", modes: null, options: [{
    id: "model", name: "Model", type: "select", currentValue: currentModel, options: [{ value: currentModel, name: currentModel }],
  }] });
  const daemon = await startDaemon(runner);
  const connected = await connectHttp(daemon.url, { protocolMode: "modern", elicit: () => ({ action: "decline" }) });
  try {
    const { runId, request } = await startSetup(connected.client, makeProjectDir("changed-catalog"), 'export const meta = { name: "catalog", description: "catalog" }; return agent("work");');
    assert.deepEqual(request.requestedSchema.properties.agent_0_model.oneOf?.map(choice => choice.const), ["claude/old-model"]);
    currentModel = "new-model";
    const answer = await connected.client.callTool({ name: "workflow", arguments: { action: "setup-response", runId, setupId: request.id,
      response: { action: "accept", content: { agent_0_model: "claude/old-model" } } } });
    assert.equal(answer.isError, false, textOf(answer));
    const failed = await waitForRun(connected.client, runId);
    assert.equal(structured(failed)?.status, "failed", textOf(failed));
    assert.equal(calls, 0, "a stale provider selection must never dispatch");
  } finally { await connected.dispose(); await daemon.close(); }
});
