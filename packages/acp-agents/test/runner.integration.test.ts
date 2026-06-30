// Areas (2b)/(3b)/(4)/(5b)/(6)/(7): end-to-end run() against a MOCK ACP agent.
//
// No network and no real Claude/Codex: the runner spawns a fake ACP server (test/fixtures/
// fake-acp-agent.mjs) via the AGENTPRISM_*_ACP_CMD/ARGS spawn override. That fake speaks REAL
// ACP over stdio, so the runner's real ClientSideConnection, draining, permission/usage/
// structured-output plumbing, and stopReason/throw mapping are all exercised; only the agent
// on the far end is faked. The fake appends every observed ACP request to a JSONL log so we
// can assert exactly what crossed the wire (clientInfo, _meta, permission outcomes).
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { isWorkflowError, WorkflowErrorCode, type AgentUsage } from "@agentprism/shared-types";
import { AcpAgentRunner } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const SCHEMA = Type.Object({ city: Type.String(), hot: Type.Boolean() });

const TEST_ENV_VARS = [
  "AGENTPRISM_CLAUDE_ACP_CMD",
  "AGENTPRISM_CLAUDE_ACP_ARGS",
  "AGENTPRISM_CODEX_ACP_CMD",
  "AGENTPRISM_CODEX_ACP_ARGS",
  "AGENTPRISM_FAKE_LOG",
  "AGENTPRISM_FAKE_SCENARIO",
  "AGENTPRISM_DEFAULT_BACKEND",
];

interface LogEntry {
  method: string;
  params?: { clientInfo?: unknown; _meta?: Record<string, unknown> | null };
  outcome?: { outcome: string; optionId?: string };
}

/** Point BOTH backends' spawn override at the fake agent and script its behavior. Backend
 *  selection is driven by the run()'s `model`, not these env vars. Returns a log reader. */
function configure(scenario: unknown): { cwd: string; readLog: () => LogEntry[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-it-"));
  const log = path.join(dir, "log.jsonl");
  process.env.AGENTPRISM_CLAUDE_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_CLAUDE_ACP_ARGS = FIXTURE;
  process.env.AGENTPRISM_CODEX_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_CODEX_ACP_ARGS = FIXTURE;
  process.env.AGENTPRISM_FAKE_LOG = log;
  process.env.AGENTPRISM_FAKE_SCENARIO = JSON.stringify(scenario);
  return {
    cwd: dir,
    readLog: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as LogEntry)
        : [],
  };
}

afterEach(() => {
  for (const key of TEST_ENV_VARS) delete process.env[key];
});

// ---- (7) benign clientInfo at initialize --------------------------------------------

test("(7) sends benign clientInfo at initialize — NOT JetBrains/IntelliJ 2026.1", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await new AcpAgentRunner().run("hi", { model: "anthropic/claude-opus-4-1", cwd });

  const init = readLog().find((e) => e.method === "initialize");
  assert.ok(init, "initialize was observed by the agent");
  assert.deepEqual(init.params?.clientInfo, {
    name: "agentprism-workflows",
    title: "AgentPrism Workflows",
    version: "0.1.0",
  });
  // The exact identity codex-acp disables its session config options for:
  const info = init.params?.clientInfo as { name: string; title: string; version: string };
  assert.doesNotMatch(info.name, /jetbrains|intellij/i);
  assert.doesNotMatch(info.title, /jetbrains|intellij/i);
  assert.notEqual(info.version, "2026.1");
});

// ---- (4) stopReason -> result/throw mapping -----------------------------------------

test("(4) no-schema completion returns the final assistant text; onHistory fires", async () => {
  const { cwd } = configure({ turns: [{ text: ["Hello, ", "world!"] }] });
  const history: unknown[][] = [];
  const out = await new AcpAgentRunner().run("hi", {
    model: "claude",
    cwd,
    onHistory: (h) => history.push(h),
  });
  assert.equal(out, "Hello, world!"); // chunks concatenated, then trimmed
  assert.equal(history.length, 1);
  assert.ok(history[0].length >= 1, "history captured assistant chunks");
});

test("(4) empty no-schema output => AGENT_EMPTY_OUTPUT (recoverable)", async () => {
  const { cwd } = configure({ turns: [{ text: "   " }] }); // whitespace only -> trims to empty
  await assert.rejects(
    () => new AcpAgentRunner().run("hi", { model: "claude", cwd, label: "empty-agent" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
      assert.equal(err.recoverable, true);
      assert.equal(err.agentLabel, "empty-agent");
      return true;
    },
  );
});

test("(4) provider wall (thrown) => PROVIDER_USAGE_LIMIT (non-recoverable, resetHint)", async () => {
  const { cwd } = configure({ turns: [{ throw: "Subscription usage limit reached. Resets in 2 hours." }] });
  await assert.rejects(
    () => new AcpAgentRunner().run("hi", { model: "claude", cwd, label: "wall-agent" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
      assert.equal(err.recoverable, false);
      assert.equal(err.resetHint, "Resets in 2 hours");
      assert.equal(err.agentLabel, "wall-agent");
      return true;
    },
  );
});

test("(4) a generic backend fault => recoverable AGENT_EXECUTION_ERROR", async () => {
  const { cwd } = configure({ turns: [{ throw: "ECONNRESET: the agent process died" }] });
  await assert.rejects(
    () => new AcpAgentRunner().run("hi", { model: "claude", cwd }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(err.recoverable, true);
      return true;
    },
  );
});

test("(4) schema never satisfied after the ladder => SCHEMA_NONCOMPLIANCE (non-recoverable)", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "I am unable to produce JSON." }] });
  await assert.rejects(
    () =>
      new AcpAgentRunner().run("give me json", {
        model: "openai/gpt-5-codex",
        schema: SCHEMA,
        cwd,
        maxSchemaRetries: 0, // no repair turns -> fail fast after the first turn
        label: "schema-agent",
      }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
      assert.equal(err.recoverable, false);
      assert.equal(err.agentLabel, "schema-agent");
      return true;
    },
  );
  // with maxSchemaRetries:0 exactly one prompt turn is sent
  assert.equal(readLog().filter((e) => e.method === "prompt").length, 1);
});

// ---- (2b) Codex schema forwarding via _meta -----------------------------------------

test("(2b) Codex forwards the strict schema via _meta[agentprism/outputSchema] into the turn", async () => {
  const { cwd, readLog } = configure({
    turns: [{ text: JSON.stringify({ city: "NYC", hot: true }) }],
  });
  const out = await new AcpAgentRunner().run("weather?", {
    model: "openai/gpt-5-codex",
    schema: SCHEMA,
    cwd,
  });
  assert.deepEqual(out, { city: "NYC", hot: true }); // codex native = JSON.parse(final message)

  const entries = readLog();
  const prompt = entries.find((e) => e.method === "prompt");
  const forwarded = prompt?.params?._meta?.["agentprism/outputSchema"];
  // strict-normalized: every prop required + additionalProperties:false
  assert.deepEqual(forwarded, {
    type: "object",
    required: ["city", "hot"],
    properties: { city: { type: "string" }, hot: { type: "boolean" } },
    additionalProperties: false,
  });
  // Codex carries NOTHING at session/new (schema rides the turn)
  assert.equal(entries.find((e) => e.method === "newSession")?.params?._meta ?? undefined, undefined);
});

// ---- (3b) Claude schema channel + structured_output read ----------------------------

test("(3b) Claude sets outputFormat+emitRawSDKMessages at session/new and reads structured_output", async () => {
  const { cwd, readLog } = configure({
    turns: [{ text: "Here is the result.", structuredOutput: { city: "LA", hot: false } }],
  });
  const resolved: string[] = [];
  const out = await new AcpAgentRunner().run("weather?", {
    model: "anthropic/claude-opus-4-1",
    schema: SCHEMA,
    cwd,
    onModelResolved: (m) => resolved.push(m),
  });
  // The value came from the raw _claude/sdkMessage structured_output, NOT the prose.
  assert.deepEqual(out, { city: "LA", hot: false });
  assert.deepEqual(resolved, ["claude-opus-4-1"]); // model selection round-tripped

  const newSession = readLog().find((e) => e.method === "newSession");
  const claudeCode = newSession?.params?._meta?.claudeCode as {
    options: { outputFormat: { type: string; schema: Record<string, unknown> } };
    emitRawSDKMessages: boolean;
  };
  assert.equal(claudeCode.options.outputFormat.type, "json_schema");
  assert.equal(claudeCode.emitRawSDKMessages, true);
  assert.deepEqual(claudeCode.options.outputFormat.schema.required, ["city", "hot"]);
  // Claude carries NOTHING on the turn (schema is session-scoped)
  assert.equal(readLog().find((e) => e.method === "prompt")?.params?._meta ?? undefined, undefined);
});

// ---- (5) permission allow/deny auto-response at request_permission -------------------

test("(5) deny-list denies the tool at request_permission; the run still completes", async () => {
  const { cwd, readLog } = configure({
    turns: [{ toolCall: { title: "Run Bash", kind: "execute" }, text: "done anyway" }],
  });
  const out = await new AcpAgentRunner().run("do it", {
    model: "claude",
    cwd,
    disallowedToolNames: ["bash"],
  });
  assert.equal(out, "done anyway"); // a denied tool does not fail the run
  const outcome = readLog().find((e) => e.method === "permissionOutcome")?.outcome;
  assert.equal(outcome?.outcome, "selected");
  assert.equal(outcome?.optionId, "reject-1");
});

test("(5) default policy allows the tool at request_permission", async () => {
  const { cwd, readLog } = configure({
    turns: [{ toolCall: { title: "Read file", kind: "read" }, text: "read it" }],
  });
  const out = await new AcpAgentRunner().run("do it", { model: "claude", cwd });
  assert.equal(out, "read it");
  const outcome = readLog().find((e) => e.method === "permissionOutcome")?.outcome;
  assert.equal(outcome?.optionId, "allow-1");
});

// ---- (6) usage_update -> onUsage on success AND error -------------------------------

test("(6) onUsage fires on SUCCESS with PromptResponse tokens + usage_update cost", async () => {
  const { cwd } = configure({
    turns: [
      {
        text: "ok",
        usageUpdate: { used: 42, size: 200000, cost: { amount: 0.07, currency: "USD" } },
        usage: {
          totalTokens: 42,
          inputTokens: 30,
          outputTokens: 12,
          cachedReadTokens: 3,
          cachedWriteTokens: 1,
        },
      },
    ],
  });
  const seen: AgentUsage[] = [];
  await new AcpAgentRunner().run("hi", { model: "claude", cwd, onUsage: (u) => seen.push(u) });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    input: 30,
    output: 12,
    cacheRead: 3,
    cacheWrite: 1,
    total: 42,
    cost: 0.07,
  });
});

test("(6) onUsage fires on the ERROR path too, carrying the usage_update cost seen before the wall", async () => {
  const { cwd } = configure({
    turns: [
      {
        usageUpdate: { used: 10, size: 200000, cost: { amount: 0.03, currency: "USD" } },
        throw: "Usage limit reached. Resets in 1 hour.",
      },
    ],
  });
  const seen: AgentUsage[] = [];
  await assert.rejects(() => new AcpAgentRunner().run("hi", { model: "claude", cwd, onUsage: (u) => seen.push(u) }));
  assert.equal(seen.length, 1);
  // The prompt rejected (no PromptResponse.usage), so tokens are the zero sentinel, but the
  // cost streamed before the wall is preserved.
  assert.deepEqual(seen[0], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0.03 });
});

test("(6) onUsage tolerates usage === undefined: all-zero sentinel when nothing was reported", async () => {
  const { cwd } = configure({ turns: [{ throw: "ECONNRESET" }] }); // no usage_update, no PromptResponse
  const seen: AgentUsage[] = [];
  await assert.rejects(() => new AcpAgentRunner().run("hi", { model: "claude", cwd, onUsage: (u) => seen.push(u) }));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
});
