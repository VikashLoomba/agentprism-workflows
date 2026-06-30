// @agentprism/mcp-server — the shell / composition root: the ONE place where
// @agentprism/acp-agents and @agentprism/workflow-engine meet. It injects the ACP-backed
// AgentRunner into the engine (runWorkflow({ agent: createAcpRunner() })).
//
// PHASE-1 STUB: imports all three workspace packages to prove the dependency wiring
// type-checks, and sketches the injection. The real stdio bootstrap (StdioServerTransport),
// the McpServer `workflow` tool registration (Zod input/output shapes, clamp, progress),
// and the synchronous run land in Phase 2.
import { createAcpRunner } from "@agentprism/acp-agents";
import { runWorkflow } from "@agentprism/workflow-engine";
import type { EngineRunResult } from "@agentprism/workflow-engine";

/** Phase-1 stub of the composition root: build the required AgentRunner and inject it into
 *  the engine. Phase 2 replaces this with the full MCP tool handler + clamp + progress. */
export async function runWorkflowWithAcp<T = unknown>(script: string): Promise<EngineRunResult<T>> {
  const agent = createAcpRunner();
  return runWorkflow<T>({ script, agent });
}
