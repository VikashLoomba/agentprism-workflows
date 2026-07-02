// The custom-backend REGISTRY seam: config resolution (env + option, validation, reserved
// names), the CustomAcpBackend's generic dialect (schema via turn-level _meta.outputSchema,
// result via final-text JSON parse, static sessionMeta as DEFAULTS), and selectBackend's
// registry-first routing (a registered name beats the built-in heuristics; the default
// backend may itself be a registered name).
import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { META_KEYS } from "@automatalabs/shared-types";
import {
  BACKENDS_ENV,
  CustomAcpBackend,
  resolveBackendRegistry,
  selectBackend,
} from "../src/index.js";
import type { StructuredSource } from "../src/index.js";

const SCHEMA = Type.Object({ city: Type.String({ minLength: 1 }), hot: Type.Boolean() });

function envWith(value?: string): NodeJS.ProcessEnv {
  return value === undefined ? {} : { [BACKENDS_ENV]: value };
}

function source(text: string): StructuredSource {
  return { currentTurnText: () => text, rawStructuredOutput: () => undefined };
}

// ---- resolveBackendRegistry ----------------------------------------------------------

test("registry: resolves env JSON and lowercases names", () => {
  const registry = resolveBackendRegistry(
    undefined,
    envWith(JSON.stringify({ Browser: { command: "browser-acp", args: ["--headless"] } })),
  );
  const entry = registry.get("browser");
  assert.ok(entry, "env-declared backend registered under its lowercased name");
  assert.equal(entry.command, "browser-acp");
  assert.deepEqual(entry.args, ["--headless"]);
});

test("registry: programmatic option wins over the env entry of the same name", () => {
  const registry = resolveBackendRegistry(
    { browser: { command: "from-option" } },
    envWith(JSON.stringify({ browser: { command: "from-env" }, other: { command: "kept" } })),
  );
  assert.equal(registry.get("browser")?.command, "from-option");
  assert.equal(registry.get("other")?.command, "kept", "non-conflicting env entries survive");
});

test("registry: empty/unset env and no option => empty registry", () => {
  assert.equal(resolveBackendRegistry(undefined, envWith()).size, 0);
  assert.equal(resolveBackendRegistry(undefined, envWith("  ")).size, 0);
  assert.equal(resolveBackendRegistry({}, envWith()).size, 0);
});

test("registry: fails LOUDLY on malformed env JSON / non-object shapes", () => {
  assert.throws(() => resolveBackendRegistry(undefined, envWith("{nope")), /not valid JSON/);
  assert.throws(() => resolveBackendRegistry(undefined, envWith('["a"]')), /JSON object/);
  assert.throws(() => resolveBackendRegistry(undefined, envWith('{"b": "cmd"}')), /must be an object/);
});

test("registry: validates names, reserved names, and config field types", () => {
  assert.throws(() => resolveBackendRegistry({ "9bad": { command: "x" } }), /invalid backend name/);
  assert.throws(() => resolveBackendRegistry({ "has space": { command: "x" } }), /invalid backend name/);
  assert.throws(() => resolveBackendRegistry({ claude: { command: "x" } }), /reserved/);
  assert.throws(() => resolveBackendRegistry({ CODEX: { command: "x" } }), /reserved/);
  assert.throws(() => resolveBackendRegistry({ b: { command: "" } }), /non-empty string "command"/);
  assert.throws(
    () => resolveBackendRegistry({ b: { command: "x", args: [1] } as never }),
    /"args" must be an array of strings/,
  );
  assert.throws(
    () => resolveBackendRegistry({ b: { command: "x", env: { A: 1 } } as never }),
    /"env" must be an object of string values/,
  );
  assert.throws(
    () => resolveBackendRegistry({ b: { command: "x", sessionMeta: [] } as never }),
    /"sessionMeta" must be an object/,
  );
});

// ---- CustomAcpBackend ----------------------------------------------------------------

test("CustomAcpBackend: spawnConfig merges registry env OVER process.env; copies args", () => {
  const backend = new CustomAcpBackend({
    name: "browser",
    command: "browser-acp",
    args: ["--headless"],
    env: { CUSTOM_FLAG: "on" },
  });
  const spawn = backend.spawnConfig();
  assert.equal(backend.id, "browser");
  assert.equal(spawn.command, "browser-acp");
  assert.deepEqual(spawn.args, ["--headless"]);
  assert.equal(spawn.env.CUSTOM_FLAG, "on");
  assert.equal(spawn.env.PATH, process.env.PATH, "inherits the parent environment");
});

test("CustomAcpBackend: static sessionMeta is a DEFAULTS layer, not protocol-critical meta", () => {
  const backend = new CustomAcpBackend({
    name: "browser",
    command: "browser-acp",
    sessionMeta: { allowedDomains: ["preview.example.com"] },
  });
  assert.deepEqual(backend.sessionMetaDefaults(), { allowedDomains: ["preview.example.com"] });
  // Protocol-critical session meta is empty even with a schema (the schema rides the turn).
  assert.equal(backend.sessionMeta(SCHEMA), undefined);
  // And the defaults are a copy — mutating the result never leaks into the config.
  const defaults = backend.sessionMetaDefaults()!;
  defaults.allowedDomains = "mutated";
  assert.deepEqual(backend.sessionMetaDefaults(), { allowedDomains: ["preview.example.com"] });
});

test("CustomAcpBackend: schema rides the turn as plain (non-strict) _meta.outputSchema", () => {
  const backend = new CustomAcpBackend({ name: "browser", command: "browser-acp" });
  const meta = backend.promptMeta(SCHEMA) as Record<string, Record<string, unknown>>;
  const schema = meta[META_KEYS.outputSchema];
  assert.ok(schema, "outputSchema forwarded on the turn");
  // Non-strict: validation keywords survive and additionalProperties is NOT forced false
  // (strict normalization is a Codex/Responses-API constraint, not the generic dialect).
  assert.equal((schema.properties as Record<string, Record<string, unknown>>).city.minLength, 1);
  assert.equal("additionalProperties" in schema, false);
  assert.equal(backend.promptMeta(undefined), undefined);
});

test("CustomAcpBackend: reads the result off the final text like Codex (JSON, fenced, prose)", () => {
  const backend = new CustomAcpBackend({ name: "browser", command: "browser-acp" });
  assert.deepEqual(backend.nativeStructured(source('{"city":"Oslo","hot":false}')), {
    city: "Oslo",
    hot: false,
  });
  assert.deepEqual(backend.nativeStructured(source('Done!\n```json\n{"city":"Oslo","hot":false}\n```')), {
    city: "Oslo",
    hot: false,
  });
  assert.equal(backend.nativeStructured(source("no json here")), undefined);
  assert.equal(backend.nativeStructured(source("")), undefined);
});

// ---- selectBackend routing ------------------------------------------------------------

test("selectBackend: a registered name routes by exact spec or name/ prefix, case-insensitively", () => {
  const registry = resolveBackendRegistry({ browser: { command: "browser-acp" } });
  assert.equal(selectBackend({ model: "browser" }, registry).id, "browser");
  assert.equal(selectBackend({ model: "Browser/gpt-vision" }, registry).id, "browser");
  assert.equal(selectBackend({ tier: "browser" }, registry).id, "browser");
  // No slash-suffix confusion: "browserx" is NOT the "browser" backend.
  assert.notEqual(selectBackend({ model: "browserx" }, registry).id, "browser");
});

test("selectBackend: registered names win over the built-in heuristics", () => {
  // "gpt-runner" would match the /gpt/ codex heuristic — the registry entry must win.
  const registry = resolveBackendRegistry({ "gpt-runner": { command: "custom" } });
  assert.equal(selectBackend({ model: "gpt-runner" }, registry).id, "gpt-runner");
  // …while unregistered specs still route by heuristic.
  assert.equal(selectBackend({ model: "gpt-5-codex" }, registry).id, "codex");
  assert.equal(selectBackend({ model: "opus" }, registry).id, "claude");
});

test("selectBackend: AGENTPRISM_DEFAULT_BACKEND may name a registered custom backend", () => {
  const registry = resolveBackendRegistry({ browser: { command: "browser-acp" } });
  const prior = process.env.AGENTPRISM_DEFAULT_BACKEND;
  try {
    process.env.AGENTPRISM_DEFAULT_BACKEND = "browser";
    assert.equal(selectBackend({}, registry).id, "browser");
    // An unknown default still falls back to claude.
    process.env.AGENTPRISM_DEFAULT_BACKEND = "missing";
    assert.equal(selectBackend({}, registry).id, "claude");
  } finally {
    if (prior === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = prior;
  }
});
