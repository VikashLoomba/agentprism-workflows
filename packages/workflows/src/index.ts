/// <reference path="./dsl.d.ts" />
// @automatalabs/workflows — the importable SDK for the AgentPrism dynamic-workflow
// orchestrator. A THIN FACADE re-export barrel: it owns NO logic of its own, it
// re-exports the clean public surface of the three engine packages and adds ONE
// convenience helper (`runDynamicWorkflow`) that defaults the AgentRunner seam to the
// ACP backend. It is SEPARATE from @automatalabs/mcp-server (the stdio MCP server) and
// stays a PURE library — it pulls in neither @modelcontextprotocol/sdk nor zod.
//
// The DSL globals available INSIDE a workflow script (agent, parallel, pipeline, …) are
// vm-realm globals, NOT importable symbols; they are documented for author IntelliSense
// in ./dsl.d.ts (referenced above), not exported here.

import { createAcpRunner } from "@automatalabs/acp-agents";
import { WorkflowManager } from "@automatalabs/workflow-engine";
import type { ExecOptions } from "@automatalabs/workflow-engine";
import type { AgentRunner, WorkflowRunResult } from "@automatalabs/shared-types";

// ── Engine: run entry, script parsing, the managed-run lifecycle, and the
//    option/result + error types the host composes against. ──
export { runWorkflow, parseWorkflowScript, WorkflowManager } from "@automatalabs/workflow-engine";
export type {
  WorkflowRunOptions,
  AgentOptions,
  ExecOptions,
  WorkflowManagerOptions,
  CheckpointOptions,
  WorkflowRunResult,
} from "@automatalabs/workflow-engine";
export {
  WorkflowError,
  WorkflowErrorCode,
  isWorkflowError,
  isProviderUsageLimit,
} from "@automatalabs/workflow-engine";

// ── ACP backend: the default AgentRunner implementation, backend selection, the
//    concrete backends, the pool options, and the JSON-Schema helpers. ──
export {
  createAcpRunner,
  AcpAgentRunner,
  selectBackend,
  ClaudeBackend,
  CodexBackend,
  toJsonSchema,
  toStrictJsonSchema,
} from "@automatalabs/acp-agents";
export type { AcpPoolOptions } from "@automatalabs/acp-agents";

// ── Shared seam types: the AgentRunner contract and its opts/result/usage shapes,
//    so callers can implement or type a custom runner without reaching past the SDK. ──
export type { AgentRunner, RunOptions, AgentResult, AgentUsage } from "@automatalabs/shared-types";

/** Options for {@link runDynamicWorkflow}. */
export interface RunDynamicWorkflowOptions {
  /**
   * The agent backend (the frozen AgentRunner seam) to drive this run. The seam is
   * injectable: pass a custom runner to swap the backend (or to stub it in tests).
   * Omitted => defaults to the ACP backend via `createAcpRunner()`.
   */
  runner?: AgentRunner;
  /** The `args` value handed to the workflow script's vm-realm `args` global. */
  args?: unknown;
  /** Per-execution options forwarded to `WorkflowManager.runSync` (timeouts, signal, budget, …). */
  exec?: ExecOptions;
}

/**
 * Run a dynamic workflow script to a TERMINAL result, with the AgentRunner seam
 * defaulted to the ACP backend.
 *
 * Thin convenience over the engine: it constructs a one-off `WorkflowManager` whose
 * injected `agent` is `opts.runner ?? createAcpRunner()` and delegates to its
 * `runSync(script, args, exec)`, which always resolves to a terminal
 * `WorkflowRunResult` (status `completed | paused | failed | aborted`) — never throwing
 * for an ordinary pause/fail — so the caller can read `result.status` directly.
 */
export function runDynamicWorkflow(
  script: string,
  opts: RunDynamicWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  return new WorkflowManager({ agent: opts.runner ?? createAcpRunner() }).runSync(script, opts.args, opts.exec);
}
