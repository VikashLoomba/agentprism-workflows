import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { PiAcpAgent } from "../src/agent.js";
import { MODEL_DISCOVERY_META_KEY, modelDiscoveryPreferences } from "../src/config.js";
import { context, fakeDeps } from "./helpers/fakes.js";

function model(provider: string, id: string): Model<Api> {
  return {
    provider, id, name: id, api: "openai-completions", baseUrl: "https://fixture.invalid",
    reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

const models = [
  model("anthropic", "claude-sonnet-4-5-20250929"),
  model("anthropic", "claude-sonnet-4-5"),
  model("openai", "gpt-a"),
  model("openai", "gpt-b"),
  model("openrouter", "vendor/model:exacto"),
  model("openrouter", "vendor/model"),
  model("custom", "literal[1m]"),
  model("custom", "dated-20250101"),
  model("custom", "dated-20260101"),
];

for (const { name, patterns, preferred, unmatched = [] } of [
  {
    name: "configured order and duplicates",
    patterns: ["openai/gpt-b", "anthropic/claude-sonnet-4-5", "openai/gpt-a", "openai/gpt-b"],
    preferred: ["openai/gpt-b", "anthropic/claude-sonnet-4-5", "openai/gpt-a"],
  },
  {
    name: "case-insensitive globs, character classes, suffixes, and overlapping matches",
    patterns: ["OPENAI/gpt-[ab]:high", "*sonnet*", "openai/gpt-?"],
    preferred: ["openai/gpt-a", "openai/gpt-b", "anthropic/claude-sonnet-4-5-20250929", "anthropic/claude-sonnet-4-5"],
  },
  {
    name: "glob slash boundaries and globstars",
    patterns: ["openrouter/*", "openrouter/**:high"],
    preferred: ["openrouter/vendor/model:exacto", "openrouter/vendor/model"],
    unmatched: ["openrouter/*"],
  },
  {
    name: "colon-bearing exact model IDs and thinking suffixes",
    patterns: ["openrouter/vendor/model:exacto:high", "openrouter/vendor/model:low"],
    preferred: ["openrouter/vendor/model:exacto", "openrouter/vendor/model"],
  },
  {
    name: "exact model IDs containing glob characters",
    patterns: ["custom/literal[1m]:high"],
    preferred: ["custom/literal[1m]"],
  },
  {
    name: "fuzzy alias and latest dated version selection",
    patterns: ["sonnet", "dated"],
    preferred: ["anthropic/claude-sonnet-4-5", "custom/dated-20260101"],
  },
  {
    name: "invalid thinking suffix fallback remains a match",
    patterns: ["openai/gpt-b:invalid-level"],
    preferred: ["openai/gpt-b"],
  },
  {
    name: "unavailable exact IDs and unmatched patterns retain authored order",
    patterns: ["unavailable/private", "openai/gpt-a", "missing*:high", "unavailable/private"],
    preferred: ["openai/gpt-a"],
    unmatched: ["unavailable/private", "missing*:high", "unavailable/private"],
  },
]) {
  test(`discovery uses Pi native ${name}`, async () => {
    assert.deepEqual(await modelDiscoveryPreferences(patterns, models), {
      source: "enabledModels", preferred, unmatched,
    });
  });
}

test("discovery distinguishes unconfigured preferences from an entirely unavailable shortlist", async () => {
  assert.equal(await modelDiscoveryPreferences(undefined, models), undefined);
  assert.equal(await modelDiscoveryPreferences([], models), undefined);
  assert.deepEqual(await modelDiscoveryPreferences(["openai/*", "custom/missing"], []), {
    source: "enabledModels", preferred: [], unmatched: ["openai/*", "custom/missing"],
  });
});

for (const projectPatterns of [undefined, ["openai/gpt-b", "missing/*"], []]) {
  test(`ACP discovery reads merged native settings (project ${JSON.stringify(projectPatterns)})`, async (t) => {
    const setup = fakeDeps();
    const globalPatterns = ["anthropic/claude-sonnet-4-5"];
    writeFileSync(join(setup.agentDir, "settings.json"), JSON.stringify({ enabledModels: globalPatterns }));
    mkdirSync(join(setup.cwd, ".pi"));
    writeFileSync(join(setup.cwd, ".pi", "settings.json"), JSON.stringify({
      enabledModels: projectPatterns, defaultThinkingLevel: "low",
    }));
    setup.deps.modelRuntime = {
      async getAvailable() { return models; },
      getModels() { throw new Error("Discovery must use the authenticated available catalog"); },
    } as never;
    const agent = new PiAcpAgent(setup.deps);
    t.after(async () => {
      await agent.dispose();
      for (const path of [setup.cwd, setup.agentDir, setup.sessionDir]) rmSync(path, { recursive: true, force: true });
    });
    const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
    const option = opened.configOptions.find(({ id }) => id === "model")!;
    assert.equal(option.type, "select");
    assert.deepEqual(option.type === "select" ? option.options : [], models.map((model) => ({
      value: `${model.provider}/${model.id}`, name: model.name,
    })));
    const expected = projectPatterns === undefined
      ? { source: "enabledModels", preferred: globalPatterns, unmatched: [] }
      : projectPatterns.length
        ? { source: "enabledModels", preferred: ["openai/gpt-b"], unmatched: ["missing/*"] }
        : undefined;
    assert.deepEqual(option._meta?.[MODEL_DISCOVERY_META_KEY], expected);
    assert.deepEqual(setup.createOptions[0]?.settingsManager?.getEnabledModels(), projectPatterns ?? globalPatterns);

    // A non-preferred model is still selectable; metadata must survive both echoes.
    for (const [configId, value] of [["model", "openrouter/vendor/model:exacto"], ["thinkingLevel", "off"]] as const) {
      const changed = await agent.setConfigOption(context({ sessionId: opened.sessionId, configId, value }));
      const echoed = changed.configOptions.find(({ id }) => id === "model")!;
      assert.equal(echoed.currentValue, "openrouter/vendor/model:exacto");
      assert.deepEqual(echoed._meta?.[MODEL_DISCOVERY_META_KEY], expected);
      assert.deepEqual(echoed.type === "select" ? echoed.options : [], option.type === "select" ? option.options : []);
    }
  });
}

test("preference metadata refreshes atomically with the available catalog after a model change", async (t) => {
  const setup = fakeDeps();
  writeFileSync(join(setup.agentDir, "settings.json"), JSON.stringify({ enabledModels: ["openai/gpt-a", "openai/gpt-b"] }));
  let reads = 0;
  setup.deps.modelRuntime = {
    async getAvailable() { return ++reads === 1 ? models : models.filter(({ id }) => id !== "gpt-a"); },
  } as never;
  const agent = new PiAcpAgent(setup.deps);
  t.after(async () => {
    await agent.dispose();
    for (const path of [setup.cwd, setup.agentDir, setup.sessionDir]) rmSync(path, { recursive: true, force: true });
  });
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  assert.equal(reads, 1, "resolving preferences must not trigger a second catalog read");
  assert.deepEqual(opened.configOptions[1]?._meta?.[MODEL_DISCOVERY_META_KEY], {
    source: "enabledModels", preferred: ["openai/gpt-a", "openai/gpt-b"], unmatched: [],
  });
  const changed = await agent.setConfigOption(context({ sessionId: opened.sessionId, configId: "model", value: "openai/gpt-b" }));
  assert.equal(reads, 2);
  assert.deepEqual(changed.configOptions[1]?._meta?.[MODEL_DISCOVERY_META_KEY], {
    source: "enabledModels", preferred: ["openai/gpt-b"], unmatched: ["openai/gpt-a"],
  });
});
