// @agentprism/acp-agents — implements the AgentRunner seam from @agentprism/shared-types.
// It NEVER imports @agentprism/workflow-engine; the two siblings meet ONLY at AgentRunner,
// injected by mcp-server (the composition root).
//
// PHASE-1 STUB: a type-checked placeholder that pins the public export surface
// (AcpAgentRunner implements AgentRunner, createAcpRunner) so mcp-server can wire it and
// the workspace type-checks. The real backend selection (Claude / patched Codex over ACP),
// the structured-output ladder, permissions, usage mapping, and ACP->WorkflowError mapping
// all land in Phase 2.
import type { AgentRunner, RunOptions, AgentResult } from "@agentprism/shared-types";
import { WorkflowError, WorkflowErrorCode } from "@agentprism/shared-types";
import type { TSchema } from "typebox";

/** Phase-1 stub. The single frozen seam method; real backend run ladder arrives in Phase 2. */
export class AcpAgentRunner implements AgentRunner {
  run<S extends TSchema | undefined = undefined>(
    _prompt: string,
    _options?: RunOptions<S>,
  ): Promise<AgentResult<S>> {
    throw new WorkflowError(
      "AcpAgentRunner.run is not implemented yet (Phase 2).",
      WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    );
  }
}

/** Factory the mcp-server composition root calls to inject the runner into the engine. */
export function createAcpRunner(): AgentRunner {
  return new AcpAgentRunner();
}
