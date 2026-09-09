import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunner } from "@automatalabs/shared-types";
import { WorkflowManager } from "../src/workflow-manager.js";
import { runWorkflow } from "../src/workflow.js";

test("parallel completion order and dynamic branches preserve their actual routes", async () => {
  const calls: Array<{ prompt: string; model?: string }> = [];
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const agent: AgentRunner = {
    async run(prompt, options) {
      calls.push({ prompt, model: options.model });
      if (prompt === "slow") await slow;
      if (prompt === "after-fast") releaseSlow();
      return prompt;
    },
  };
  await runWorkflow(`export const meta = { name: "dynamic-routes", description: "Concurrent routes" };
await parallel([
  async () => { await agent("slow", { model: "claude" }); return agent("after-slow", { model: "claude" }); },
  async () => { await agent("fast", { model: "codex" }); return agent("after-fast", { model: "codex" }); },
]);
const choice = await agent("choose", { model: "codex" });
if (choice === "choose") return agent("live-branch", { model: "pi/provider/model" });
return agent("mock-branch", { model: "opencode/provider/model" });`, {
    agent, requireAgentConfiguration: true, concurrency: 2, persistLogs: false,
  });
  assert.deepEqual(calls, [
    { prompt: "slow", model: "claude" }, { prompt: "fast", model: "codex" },
    { prompt: "after-fast", model: "codex" }, { prompt: "after-slow", model: "claude" },
    { prompt: "choose", model: "codex" }, { prompt: "live-branch", model: "pi/provider/model" },
  ]);
});

test("strict routing resolves definitions, tiers, phase defaults, and backend-only routes", async () => {
  const routes: Array<string | undefined> = [];
  await runWorkflow(`export const meta = { name: "route-sources", description: "Effective route sources", model: "codex", phases: [{ title: "General" }, { title: "Review", model: "claude" }] };
await agent("workflow default");
await agent("definition", { agentType: "reviewer" });
await agent("tier", { tier: "small" });
await agent("tier fallback", { tier: "big" });
phase("Review");
await agent("phase");
return agent("explicit", { model: "opencode" });`, {
    agent: { async run(_prompt, options) { routes.push(options.model); return "ok"; } },
    requireAgentConfiguration: true, persistLogs: false,
    routingSnapshot: {
      modelTiers: { tiers: { small: "pi/provider/small" } }, mainModel: "pi/provider/main",
      agentDefinitions: [{ name: "reviewer", prompt: "Review", source: "project", model: "claude/defined" }],
    },
  });
  assert.deepEqual(routes, ["codex", "claude/defined", "pi/provider/small", "pi/provider/main", "claude", "opencode"]);
});

test("an unseen missing route fails before dispatch and includes optional host discovery", async () => {
  const calls: string[] = [];
  const contexts: unknown[] = [];
  await assert.rejects(runWorkflow(`export const meta = { name: "missing-live", description: "Unseen missing route" };
const choice = await agent("choose", { model: "codex" });
if (choice === "live") return agent("missing", { label: "repair-me", phase: "Review" });
return "unused";`, {
    agent: { async run(prompt) { calls.push(prompt); return "live"; } },
    requireAgentConfiguration: true, persistLogs: false,
    onMissingAgentConfiguration: async (context) => { contexts.push(context); return "available backend: codex"; },
  }), /repair-me.*phase "Review"[\s\S]*available backend: codex/);
  assert.deepEqual(calls, ["choose"]);
  assert.deepEqual(contexts, [{ label: "repair-me", phase: "Review" }]);
});

test("diagnostic failures cannot mask missing routing or authorize dispatch", async () => {
  await assert.rejects(runWorkflow(`export const meta = { name: "diagnostic-failure", description: "Diagnostic failure" }; return agent("missing");`, {
    agent: { async run() { assert.fail("missing route must never dispatch"); } },
    requireAgentConfiguration: true, persistLogs: false,
    onMissingAgentConfiguration: async () => { throw new Error("offline"); },
  }), /has no configured model route/);
});

test("aggregator selectors fail before dispatch", async () => {
  await assert.rejects(runWorkflow(`export const meta = { name: "selector", description: "Discovery is explicit" }; return agent("work", { model: "opencode/openrouter/*" });`, {
    agent: { async run() { assert.fail("selectors must never dispatch"); } }, requireAgentConfiguration: true, persistLogs: false,
  }), /discovery selector/);
});

test("configuration is captured at call time before queued dispatch", async () => {
  const seen: unknown[] = [];
  const result = await runWorkflow(`export const meta = { name: "config-capture", description: "Captured call configuration", model: "codex" };
const configOptions = { reasoning_effort: "high" };
const pending = agent("work", { configOptions });
configOptions.reasoning_effort = "low";
return await pending;`, {
    agent: { async run(_prompt, options) { seen.push(options.configOptions); return "ok"; } },
    requireAgentConfiguration: true, persistLogs: false,
  });
  assert.deepEqual(seen, [{ reasoning_effort: "high" }]);
  assert.deepEqual(result.calls[0].configOptionsRequested, { reasoning_effort: "high" });
});

test("cold continuation uses admitted definitions despite configuration file changes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "explicit-routing-"));
  const agentsDir = join(cwd, "agents");
  const persistenceRoot = join(cwd, "store");
  mkdirSync(agentsDir);
  const definition = join(agentsDir, "reviewer.md");
  const models: Array<string | undefined> = [];
  let fail = true;
  const agent: AgentRunner = { async run(prompt, options) {
    models.push(options.model);
    if (prompt === "second" && fail) { fail = false; throw new Error("temporary failure"); }
    return "done";
  } };
  try {
    writeFileSync(definition, "---\nname: reviewer\nmodel: claude/original\n---\nOriginal instructions");
    const first = new WorkflowManager({ cwd, persistenceRoot, agentsDir, agent });
    const run = await first.runSync(`export const meta = { name: "definition-resume", description: "Durable definitions" };
await agent("first", { agentType: "reviewer" });
const result = await agent("second", { agentType: "reviewer" });
if (result === null) throw new Error("second call is required");
return result;`, undefined, { requireAgentConfiguration: true });
    assert.equal(run.status, "failed");
    writeFileSync(definition, "---\nname: reviewer\nmodel: codex/changed\n---\nChanged instructions");
    const cold = new WorkflowManager({ cwd, persistenceRoot, agentsDir, agent });
    const resumed = await cold.continueRun(run.runId);
    assert.ok(resumed.accepted);
    assert.equal((await resumed.promise).status, "completed");
    assert.deepEqual(models, ["claude/original", "claude/original", "claude/original"]);
    assert.equal(cold.getPersistence().load(run.runId)?.admission?.routingSnapshot.agentDefinitions[0].model, "claude/original");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
