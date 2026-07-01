// Test for the @automatalabs/workflows SDK facade.
//
// Drives a TINY workflow through the public barrel using a STUB AgentRunner (the
// engine's frozen seam — run() returns the RAW value: text when no schema), so the
// suite exercises the facade + the runDynamicWorkflow helper with NO live ACP backend.
// Modeled on the mcp-server test harness (packages/mcp-server/test/_harness.ts): the
// stub double + the disposable-HOME isolation so WorkflowManager run persistence
// (~/.agentprism/workflows/projects/<key>/runs) writes into a throwaway temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect run-state persistence into a disposable home BEFORE any WorkflowManager is
// constructed (runDynamicWorkflow builds one per call, deriving the runs dir from $HOME
// at construction time). Setting it at module load fully isolates the suite's on-disk runs.
const TEST_HOME = mkdtempSync(join(tmpdir(), "automatalabs-workflows-test-home-"));
process.env.HOME = TEST_HOME;
process.on("exit", () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of the throwaway home */
  }
});

// Import EXCLUSIVELY from the SDK barrel — this is the facade under test.
import {
  createAcpRunner,
  WorkflowManager,
  runWorkflow,
  runDynamicWorkflow,
  WorkflowError,
  toJsonSchema,
} from "../src/index.js";
import type { AgentRunner, RunOptions, AcpRunnerEventMap, AcpEventContext } from "../src/index.js";

/**
 * Build an AgentRunner test double from a plain implementation. The seam's run() is
 * generic over the optional typebox schema; this stub is schema-less and returns raw
 * text, bridged to the generic interface with a single `as AgentRunner` (never `as any`),
 * exactly as the mcp-server harness does.
 */
function makeRunner(impl: (prompt: string, options: RunOptions) => unknown | Promise<unknown>): AgentRunner {
  const run = async (prompt: string, options?: RunOptions): Promise<unknown> => impl(prompt, options ?? {});
  return { run } as AgentRunner;
}

/** A runner that echoes a deterministic, non-empty text reply for every agent() call. */
function okRunner(reply: (prompt: string) => string = (p) => `stub:${p}`): AgentRunner {
  return makeRunner((prompt) => reply(prompt));
}

/** Valid one-agent script: meta first, exactly one agent() call, returns its result. */
const ONE_AGENT_SCRIPT = [
  'export const meta = { name: "one-agent", description: "a single subagent" };',
  'const r = await agent("hello");',
  "return r;",
].join("\n");

test("facade re-exports the public surface", () => {
  assert.equal(typeof createAcpRunner, "function");
  assert.equal(typeof WorkflowManager, "function");
  assert.equal(typeof runWorkflow, "function");
  assert.equal(typeof runDynamicWorkflow, "function");
  assert.equal(typeof WorkflowError, "function");
  assert.equal(typeof toJsonSchema, "function");
});

test("createAcpRunner exposes a typed ACP event bus (on/once/off/listenerCount) via the barrel", async () => {
  const runner = createAcpRunner();
  try {
    const seen: string[] = [];
    // Typed listener: `e` is the agent_message_chunk variant + context — compile-gated through
    // the SDK barrel. The payload is assignable to AcpEventContext, proving the envelope is carried.
    const off = runner.on("agent_message_chunk", (e: AcpRunnerEventMap["agent_message_chunk"]) => {
      if (e.content.type === "text") seen.push(e.content.text);
      const ctx: AcpEventContext = e;
      void ctx;
    });
    assert.equal(typeof off, "function", "on() returns an unsubscribe thunk");
    assert.equal(runner.listenerCount("agent_message_chunk"), 1);

    const toolListener = (e: AcpRunnerEventMap["tool_call"]) => void e.title;
    runner.on("tool_call", toolListener);
    assert.equal(runner.listenerCount("tool_call"), 1);

    off();
    assert.equal(runner.listenerCount("agent_message_chunk"), 0, "disposer unsubscribed");
    runner.off("tool_call", toolListener);
    assert.equal(runner.listenerCount("tool_call"), 0);

    runner.once("session_update", () => {});
    assert.equal(runner.listenerCount("session_update"), 1);
    runner.removeAllListeners();
    assert.equal(runner.listenerCount("session_update"), 0);
  } finally {
    await runner.dispose();
  }
});

test("RunOptions exposes Codex baseInstructions/developerInstructions through the SDK barrel", () => {
  // Compile-gate: the two additive Codex-only seam fields are typed on RunOptions as re-exported
  // by @automatalabs/workflows, so SDK users get createAcpRunner().run(p, { baseInstructions }).
  const opts: RunOptions = {
    baseInstructions: "You only write Rust.",
    developerInstructions: "Prefer iterators.",
  };
  assert.equal(opts.baseInstructions, "You only write Rust.");
  assert.equal(opts.developerInstructions, "Prefer iterators.");
});

test("runDynamicWorkflow runs a 1-agent script through a stub runner", async () => {
  const result = await runDynamicWorkflow(ONE_AGENT_SCRIPT, { runner: okRunner() });

  assert.equal(result.status, "completed");
  assert.equal(result.meta.name, "one-agent");
  assert.equal(result.agentCount, 1);
  // The stub echoes `stub:<prompt>`; the script returns the single agent() result verbatim.
  assert.equal(result.result, "stub:hello");
});

test("WorkflowManager.runSync runs the same script with an injected stub runner", async () => {
  const manager = new WorkflowManager({ agent: okRunner((p) => `mgr:${p}`) });
  const result = await manager.runSync(ONE_AGENT_SCRIPT);

  assert.equal(result.status, "completed");
  assert.equal(result.result, "mgr:hello");
});
