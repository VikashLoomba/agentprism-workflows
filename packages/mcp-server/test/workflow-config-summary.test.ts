import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { configSummary, configText } from "../src/workflow-preflight.js";
import type { HarnessConfigReport } from "@automatalabs/workflows";
import { connect, makeRunner, structured, textOf } from "./_harness.js";

const option = (values: string[], meta?: Record<string, unknown>) => ({
  id: "model", name: "Model", type: "select" as const, currentValue: values[0],
  options: values.map(value => ({value, name:value})), ...(meta === undefined ? {} : {_meta:meta}),
});

test("large discovery requests retain healthy results before the MCP deadline", async (t) => {
  const started: string[] = [];
  const stalledSignals: AbortSignal[] = [];
  const runner = Object.assign(makeRunner(() => assert.fail("config never dispatches")), {
    async probeConfigOptions(spec?: string, options?: { signal?: AbortSignal }) {
      started.push(spec!);
      if (spec === "codex/model-0") return { backendId: "codex", options: [option(["model-0"])] };
      stalledSignals.push(options!.signal!);
      return new Promise<never>(() => {});
    },
  });
  const { client, dispose } = await connect(runner);
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = client.callTool({ name: "workflow", arguments: {
      action: "config", modelSpecs: Array.from({ length: 16 }, (_, index) => `codex/model-${index}`),
    } });
    await setImmediate();
    t.mock.timers.tick(15_000);
    await setImmediate();
    t.mock.timers.tick(15_000);
    await setImmediate();
    t.mock.timers.tick(10_000);
    const result = await pending;
    assert.equal(result.isError, false, textOf(result));
    const payload = structured(result)!;
    assert.equal(payload.ok, false);
    const entries = payload.harnessOptions as Array<Record<string, unknown>>;
    assert.equal(entries[0].probed, true);
    assert.equal(entries[0].model, "codex/model-0");
    assert.equal(entries.length, 17, "failed exact models retain their fallback catalog failure");
    assert.match(String(entries.at(-1)!.error), /config discovery timed out after 40000ms/);
    assert.equal(started.length, 13);
    assert.ok(!started.includes("codex"), "fallback probes share the exhausted budget");
    assert.ok(stalledSignals.every(signal => signal.aborted));
    t.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(started.length, 13, "no late queued work survives the response");
  } finally {
    t.mock.timers.reset();
    await dispose();
  }
});

test("config exposes compact configured-provider discovery and model-specific option scope", async () => {
  const runner = Object.assign(makeRunner(() => assert.fail("config never dispatches")), {
    listBackends: () => ["opencode", "pi"],
    async probeConfigOptions(spec?: string) {
      const backendId = spec?.split("/")[0] ?? "opencode";
      return {backendId, modes:null, options:[backendId === "pi"
        ? option(["direct/first", "direct/preferred", "other/available"], {
          "@automatalabs/agentprism.modelDiscovery":{source:"enabledModels", preferred:["direct/preferred"], unmatched:["missing/*"]},
        })
        : option(["openrouter/vendor/a", "direct/exact", "opencode/b", "openrouter/vendor/c"])]};
    },
  });
  const {client, dispose} = await connect(runner, {listTools:true});
  try {
    const result = await client.callTool({name:"workflow", arguments:{action:"config"}});
    assert.equal(result.isError, false, textOf(result));
    const summary = structured(result)?.authoringSummary as {harnesses:Array<Record<string, unknown>>};
    const opencode = summary.harnesses.find(entry => entry.backendId === "opencode")!;
    assert.deepEqual(opencode.models, [{modelId:"direct/exact", route:"opencode/direct/exact"}]);
    assert.ok((opencode.groups as Array<{selector?:string}>).some(group => group.selector === "openrouter/*"));
    const pi = summary.harnesses.find(entry => entry.backendId === "pi")!;
    assert.equal(pi.preferenceSource, "enabledModels");
    assert.deepEqual(pi.models, [{modelId:"direct/preferred", route:"pi/direct/preferred"}]);
    assert.deepEqual(pi.unmatched, ["missing/*"]);
    assert.equal((structured(result)?.harnessOptions as Array<Record<string,unknown>>)[0].optionScope, "default-model");
    assert.match(textOf(result), /browse only \(not executable\)/);
    assert.match(textOf(result), /model-specific|Default-model options do not describe every model/);
    assert.match(textOf(result), /modelSpecs/);
    const exact = await client.callTool({name:"workflow", arguments:{action:"config", modelSpecs:["opencode/direct/exact"]}});
    assert.equal(exact.isError, false, textOf(exact));
    assert.equal((structured(exact)?.harnessOptions as Array<Record<string,unknown>>)[0].optionScope, "exact-model");
  } finally { await dispose(); }
});

test("compact discovery stays within MCP output limits with many large catalogs", () => {
  const report: HarnessConfigReport = {ok:true, exitCode:0, harnessOptions:Array.from({length:32}, (_, index) => ({
    backendId:`custom-${index}`, probed:true, modes:null,
    options:[option(Array.from({length:50}, (_, model) => `provider/${model}-${"x".repeat(180)}`))],
  }))};
  const summary = configSummary(report);
  assert.ok(Buffer.byteLength(JSON.stringify(summary), "utf8") <= 24_576);
  assert.ok(Buffer.byteLength(configText(report), "utf8") <= 8_192);
  assert.ok(summary.authoringSummary.omittedHarnesses > 0);
});

test("filtered routes precede large summaries and preserve a model's own provider prefix", () => {
  const report: HarnessConfigReport = { ok: true, exitCode: 0, harnessOptions: [{
    backendId: "opencode", probed: true, modes: null,
    options: [option(["opencode/big-pickle", ...Array.from({ length: 40 }, (_, index) => `provider/model-${index}-${"x".repeat(150)}`)])],
  }] };
  const text = configText(report, "/^opencode\\//");
  assert.ok(text.indexOf("opencode/opencode/big-pickle") < text.indexOf("authoring model summary:"));
  assert.equal(text.match(/authoring model summary:/g)?.length, 1);
  const suggestions = configText({ ...report, ok: false, exitCode: 1, harnessOptions: [
    { backendId: "opencode", model: "opencode/big-pickle", probed: false, error: "missing provider prefix" }, ...report.harnessOptions,
  ] });
  assert.match(suggestions, /suggested exact modelSpecs: "opencode\/opencode\/big-pickle"/);
});

test("exact-model requests show selected model options before unrelated catalog summaries", () => {
  const report: HarnessConfigReport = { ok: true, exitCode: 0, harnessOptions: [{
    backendId: "opencode", model: "opencode/provider/chosen", probed: true, modes: null,
    options: [option(Array.from({ length: 100 }, (_, index) => `provider/model-${index}`)), {
      id: "effort", name: "Effort", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }],
    }],
  }] };
  const text = configText(report);
  assert.match(text, /effort/);
  assert.doesNotMatch(text, /authoring model summary:/);
});
