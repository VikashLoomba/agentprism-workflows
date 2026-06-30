// @agentprism/workflow-engine — the lifted Pi engine. It NEVER imports
// @agentprism/acp-agents; it references the agent backend ONLY through the injected
// AgentRunner seam from @agentprism/shared-types.
//
// PHASE-1 STUB: a type-checked placeholder that pins the public surface (runWorkflow +
// the REQUIRED `agent: AgentRunner` injection — the Pi `?? new WorkflowAgent` default is
// DROPPED) so mcp-server can wire it and the workspace type-checks. The full lifted engine
// (parseWorkflowScript, WorkflowManager, RunPersistence, etc.) lands in Phase 2.
import type { AgentRunner, WorkflowRunResult } from "@agentprism/shared-types";

/** Bare engine return: the host-facing result MINUS the manager's terminal status trio.
 *  The WorkflowManager stamps status/reason/resetHint on top (the engine seam is never
 *  widened). */
export type EngineRunResult<T = unknown> = Omit<WorkflowRunResult<T>, "status" | "reason" | "resetHint">;

/** Phase-1 stub of the engine entry options. The full WorkflowRunOptions lands in Phase 2;
 *  `agent` is the REQUIRED AgentRunner injection — the single line that de-couples the
 *  engine from any concrete agent backend. */
export interface WorkflowRunOptions {
  /** Raw JavaScript workflow script. */
  script: string;
  /** REQUIRED injected agent backend. The engine calls agent.run() exactly once per agent(). */
  agent: AgentRunner;
  /** Optional JSON value exposed to the script as the global `args`. */
  args?: unknown;
  /** Engine-owned cancellation, threaded to the runner via RunOptions.signal. */
  signal?: AbortSignal;
}

/** Phase-1 stub. The real lifted engine arrives in Phase 2. */
export async function runWorkflow<T = unknown>(_options: WorkflowRunOptions): Promise<EngineRunResult<T>> {
  throw new Error("runWorkflow is not implemented yet (Phase 2).");
}
